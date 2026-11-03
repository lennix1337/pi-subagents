/**
 * Glue between the progress supervisor and the async run store. Snapshot and
 * notice formatting are pure; listing, liveness, HEAD probes and control
 * requests are the only I/O, and each reuses an existing channel: the run
 * listing is read-only (`reconcile: false`), steer and stop go through the
 * control inbox the runner already watches.
 */
import { execFile } from "node:child_process";
import { listAsyncRuns } from "../../runs/background/async-status.ts";
import { requestAsyncStop, requestAsyncSteer } from "../../runs/background/control-channel.ts";
import { checkPidLiveness } from "../../runs/background/stale-run-reconciler.ts";
import { readStatus } from "../../shared/utils.ts";
import type { WatchdogProgressConfig } from "../types.ts";
import type { ProgressToolCall } from "./progress-signals.ts";
import { DEFAULT_PROGRESS_POLICY } from "./progress-signals.ts";
import { ProgressSupervisor, type ProgressAction, type ProgressNotice, type ProgressRunSnapshot } from "./progress-supervisor.ts";

/** The subset of an async run summary the progress sweep reads. */
export interface ProgressRunLike {
	id: string;
	asyncDir: string;
	startedAt: number;
	lastUpdate?: number;
	lastActivityAt?: number;
	steps: ReadonlyArray<{
		index: number;
		agent: string;
		status: string;
		worktreePath?: string;
		lastActivityAt?: number;
		recentTools?: ReadonlyArray<{ tool: string; args: string; argsKey?: string; endMs?: number; failed?: boolean }>;
		currentTool?: string;
		currentToolStartedAt?: number;
	}>;
}

/** Pure: one snapshot per running step, carrying the flat index that control requests target. */
export function snapshotsFromRuns(runs: readonly ProgressRunLike[], runnerAlive: (run: ProgressRunLike) => boolean | undefined): ProgressRunSnapshot[] {
	const snapshots: ProgressRunSnapshot[] = [];
	for (const run of runs) {
		const alive = runnerAlive(run);
		for (const step of run.steps) {
			if (step.status !== "running") continue;
			const lastActivityAt = step.lastActivityAt ?? run.lastActivityAt ?? run.lastUpdate;
			const recentTools: ProgressToolCall[] = (step.recentTools ?? []).map((tool) => ({
				tool: tool.tool,
				args: tool.args,
				...(tool.argsKey ? { argsKey: tool.argsKey } : {}),
				...(tool.failed ? { failed: true } : {}),
			}));
			snapshots.push({
				runId: run.id,
				agent: step.agent,
				asyncDir: run.asyncDir,
				stepIndex: step.index,
				...(step.worktreePath ? { worktreePath: step.worktreePath } : {}),
				startedAtMs: run.startedAt,
				...(lastActivityAt !== undefined ? { lastActivityAtMs: lastActivityAt } : {}),
				recentTools,
				...(step.currentTool && step.currentToolStartedAt !== undefined ? { inFlight: { tool: step.currentTool, startedAtMs: step.currentToolStartedAt } } : {}),
				runnerAlive: alive,
			});
		}
	}
	return snapshots;
}

const ACTION_TEXT: Record<ProgressAction, string> = {
	nudged: "Sent a nudge.",
	stopped: "Stopped it (progress watchdog).",
	none: "Report only; no action taken.",
};

/** Pure: the one line the parent sees for a non-healthy child. */
export function formatProgressNotice(notice: ProgressNotice): string {
	return `[subagent] ${notice.agent} (${notice.runId.slice(0, 8)}) ${notice.verdict}: ${notice.reason}. ${ACTION_TEXT[notice.action]}`;
}

function livenessToBoolean(liveness: ReturnType<typeof checkPidLiveness>): boolean | undefined {
	if (liveness === "alive") return true;
	if (liveness === "dead") return false;
	return undefined;
}

export interface ProgressListInput {
	asyncDirRoot: string;
	sessionId?: string;
	now: number;
}

/** Read-only: lists the running async runs of this session and their running steps. */
export function listProgressRuns(input: ProgressListInput): ProgressRunSnapshot[] {
	const runs = listAsyncRuns(input.asyncDirRoot, { states: ["running"], sessionId: input.sessionId, reconcile: false, now: () => input.now });
	return snapshotsFromRuns(runs, (run) => {
		const pid = readStatus(run.asyncDir)?.pid;
		return typeof pid === "number" ? livenessToBoolean(checkPidLiveness(pid)) : undefined;
	});
}

/** Reads the worktree HEAD with a short timeout; a failure rejects and the supervisor reports it. */
export function readWorktreeHead(worktreePath: string): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD"], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout.trim() || undefined);
		});
	});
}

export interface ProgressSupervisorInput {
	config: WatchdogProgressConfig;
	asyncDirRoot: string;
	sessionId?: string;
	sendNotice(content: string): void;
	now?: () => number;
}

/** Builds the supervisor with the loop thresholds fixed in code and the configured stall and action settings. */
export function createProgressSupervisor(input: ProgressSupervisorInput): ProgressSupervisor {
	const now = input.now ?? Date.now;
	const { config } = input;
	return new ProgressSupervisor({
		now,
		listRuns: () => listProgressRuns({ asyncDirRoot: input.asyncDirRoot, ...(input.sessionId ? { sessionId: input.sessionId } : {}), now: now() }),
		readHead: readWorktreeHead,
		steer: (run, message) => {
			requestAsyncSteer(run.asyncDir, { message, mode: "follow_up", targetIndex: run.stepIndex, source: "progress-watchdog" });
		},
		stop: (run, reason) => {
			requestAsyncStop(run.asyncDir, { source: "progress-watchdog", targetIndex: run.stepIndex, reason });
		},
		notify: (notice) => input.sendNotice(formatProgressNotice(notice)),
		onError: (error, runId) => {
			const subject = runId ? ` for run ${runId.slice(0, 8)}` : "";
			console.error(`Progress watchdog${subject} failed:`, error);
		},
	}, {
		policy: { ...DEFAULT_PROGRESS_POLICY, stallAfterMs: config.stallAfterMs },
		actions: { ...config.actions },
		maxNudges: config.maxNudges,
		nudgeCooldownMs: config.nudgeCooldownMs,
		renotifyAfterMs: config.renotifyAfterMs,
	});
}
