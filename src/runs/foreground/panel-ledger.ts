import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { DIRS } from "../../shared/types.ts";

/** Shape version of the live foreground record other panels read. */
export const PANEL_LEDGER_VERSION = 1;
/** Directory under the results root that holds one record per running foreground child. */
export const PANEL_LEDGER_DIR_NAME = "live-foreground";
/** How often a running child's record is refreshed, so a panel can tell live work from a crashed one. */
export const PANEL_LEDGER_HEARTBEAT_MS = 15_000;
/** Records left behind by a crashed run are pruned once they are this old. */
export const PANEL_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Child ends prune the directory at most this often, so a burst of short children does not rescan it each time. */
export const PANEL_LEDGER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * One running foreground child, published so another extension (OptChat's agents
 * panel) can show it while the child works. Only the single-agent foreground
 * call writes one; parallel and chain steps run as async runs and are listed
 * through their own status.json. The record is observability only: it never
 * changes what the child does, and a panel that ignores it loses nothing but
 * the live view. It stays on disk for as long as the child runs (up to a day if
 * the run dies), so it carries no task prompt: the panel labels the row by agent.
 */
export interface LiveForegroundRecord {
	version: number;
	/** The foreground run this child belongs to. */
	runId: string;
	/** The child's index inside that run. */
	index: number;
	agent: string;
	/** The child's own Pi session file, when it has one. */
	sessionFile?: string;
	cwd: string;
	/** The Pi session that started the run. */
	sessionId?: string;
	/** Effective launch model, with the thinking level as its suffix when one was applied. */
	model?: string;
	startedAt: number;
	/** Last heartbeat; a record older than the panel's tolerance belongs to a run that died. */
	updatedAt: number;
	/** A record exists only while its child runs; it is removed when the child ends. */
	state: "running";
}

export function liveForegroundLedgerDir(): string {
	return path.join(DIRS.results, PANEL_LEDGER_DIR_NAME);
}

function recordFileName(runId: string, index: number): string {
	const safe = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
	return `${safe}-${index}.json`;
}

export function liveForegroundRecordPath(runId: string, index: number): string {
	return path.join(liveForegroundLedgerDir(), recordFileName(runId, index));
}

/** Publishes (or refreshes) the record of a running foreground child. Fields are copied one by one so nothing else, such as a task prompt, reaches the disk. */
export function writeLiveForegroundRun(record: Omit<LiveForegroundRecord, "version" | "updatedAt"> & { updatedAt?: number }): void {
	const persisted: LiveForegroundRecord = {
		version: PANEL_LEDGER_VERSION,
		runId: record.runId,
		index: record.index,
		agent: record.agent,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		cwd: record.cwd,
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		...(record.model ? { model: record.model } : {}),
		startedAt: record.startedAt,
		updatedAt: record.updatedAt ?? Date.now(),
		state: record.state,
	};
	writePrivateAtomicJson(liveForegroundRecordPath(record.runId, record.index), persisted);
}

/** Refreshes the heartbeat of a running child; a record that is gone stays gone. */
export function touchLiveForegroundRun(runId: string, index: number, now = Date.now()): void {
	const file = liveForegroundRecordPath(runId, index);
	if (!fs.existsSync(file)) return;
	const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	writePrivateAtomicJson(file, { ...(parsed as LiveForegroundRecord), updatedAt: now });
}

let lastPruneAt = 0;

/** Removes the record of a child that ended, and now and then prunes records a crashed run left behind. */
export function removeLiveForegroundRun(runId: string, index: number, now = Date.now()): void {
	fs.rmSync(liveForegroundRecordPath(runId, index), { force: true });
	if (now - lastPruneAt < PANEL_LEDGER_PRUNE_INTERVAL_MS) return;
	lastPruneAt = now;
	pruneLiveForegroundRuns(now);
}

/** Drops records whose heartbeat stopped long ago, so a crashed run cannot haunt a panel forever. */
export function pruneLiveForegroundRuns(now = Date.now()): void {
	const dir = liveForegroundLedgerDir();
	let entries: string[];
	try { entries = fs.readdirSync(dir); }
	catch { return; }
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		try {
			if (now - fs.statSync(file).mtimeMs > PANEL_LEDGER_RETENTION_MS) fs.rmSync(file, { force: true });
		} catch {
			// A record that cannot be inspected stays; the next prune tries again.
		}
	}
}
