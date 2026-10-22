import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	PANEL_LEDGER_HEARTBEAT_MS,
	PANEL_LEDGER_VERSION,
	liveForegroundLedgerDir,
	liveForegroundRecordPath,
	pruneLiveForegroundRuns,
	removeLiveForegroundRun,
	touchLiveForegroundRun,
	writeLiveForegroundRun,
} from "../../src/runs/foreground/panel-ledger.ts";

const record = (over: Record<string, unknown> = {}) => ({
	runId: "run-1",
	index: 0,
	agent: "delegate",
	task: "do the thing",
	cwd: "/tmp/work",
	sessionId: "session-1",
	model: "anthropic/claude-haiku-5-5:low",
	startedAt: 1000,
	state: "running" as const,
	...over,
});

describe("live foreground ledger", () => {
	it("publishes, refreshes and removes the record of a running child", () => {
		writeLiveForegroundRun(record());
		const file = liveForegroundRecordPath("run-1", 0);
		assert.ok(existsSync(file));
		const written = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(written.version, PANEL_LEDGER_VERSION);
		assert.equal(written.runId, "run-1");
		assert.equal(written.index, 0);
		assert.equal(written.agent, "delegate");
		assert.equal(written.model, "anthropic/claude-haiku-5-5:low");
		assert.equal(written.state, "running");
		assert.equal(typeof written.updatedAt, "number");

		touchLiveForegroundRun("run-1", 0, 5000);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).updatedAt, 5000);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).agent, "delegate", "a heartbeat keeps the rest of the record");

		removeLiveForegroundRun("run-1", 0);
		assert.equal(existsSync(file), false);
	});

	it("keeps a record that is gone gone", () => {
		touchLiveForegroundRun("run-1", 7, 10);
		assert.equal(existsSync(liveForegroundRecordPath("run-1", 7)), false);
	});

	it("prunes records a crashed run left behind", () => {
		writeLiveForegroundRun(record({ runId: "old", index: 1 }));
		const file = liveForegroundRecordPath("old", 1);
		// A record whose heartbeat is older than the retention window belongs to a run that died.
		writeFileSync(file, JSON.stringify({ ...record({ runId: "old", index: 1 }), updatedAt: 0 }));
		pruneLiveForegroundRuns(Date.now() + 25 * 60 * 60 * 1000);
		assert.equal(existsSync(file), false);
	});

	it("keeps records inside the live ledger directory", () => {
		assert.equal(liveForegroundLedgerDir().endsWith("live-foreground"), true);
		assert.ok(PANEL_LEDGER_HEARTBEAT_MS > 0);
	});
});
