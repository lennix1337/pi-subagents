import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatProgressNotice, snapshotsFromRuns, type ProgressRunLike } from "../../src/watchdog/progress/progress-runtime.ts";

const RUN_ID = "0123456789abcdef";

function runWith(steps: ProgressRunLike["steps"], overrides: Partial<ProgressRunLike> = {}): ProgressRunLike {
	return { id: RUN_ID, asyncDir: "C:/tmp/async/run", startedAt: 1_000, lastUpdate: 9_000, steps, ...overrides };
}

describe("progress runtime snapshots", () => {
	it("snapshots only running steps and keeps the flat step index that control requests target", () => {
		const run = runWith([
			{ index: 0, agent: "scout", status: "complete", recentTools: [{ tool: "read", args: "a", endMs: 2_000 }] },
			{ index: 1, agent: "worker", status: "running", worktreePath: "C:/wt/worker", lastActivityAt: 8_000, recentTools: [{ tool: "bash", args: "npm test", endMs: 8_500, failed: true }] },
		]);
		const snapshots = snapshotsFromRuns([run], () => true);
		assert.equal(snapshots.length, 1);
		assert.deepEqual(snapshots[0], {
			runId: RUN_ID,
			agent: "worker",
			asyncDir: "C:/tmp/async/run",
			stepIndex: 1,
			worktreePath: "C:/wt/worker",
			startedAtMs: 1_000,
			lastActivityAtMs: 8_000,
			recentTools: [{ tool: "bash", args: "npm test", failed: true }],
			runnerAlive: true,
		});
	});

	it("falls back to the run's last update when a step has no activity time, and reports an in-flight tool", () => {
		const run = runWith([
			{ index: 0, agent: "worker", status: "running", currentTool: "bash", currentToolStartedAt: 7_000 },
		]);
		const [snapshot] = snapshotsFromRuns([run], () => undefined);
		assert.equal(snapshot!.lastActivityAtMs, 9_000);
		assert.deepEqual(snapshot!.inFlight, { tool: "bash", startedAtMs: 7_000 });
		assert.equal(snapshot!.runnerAlive, undefined, "an unknown liveness probe stays unknown");
		assert.equal("worktreePath" in snapshot!, false);
	});

	it("passes the run's liveness through for each of its steps", () => {
		const run = runWith([{ index: 0, agent: "a", status: "running" }, { index: 1, agent: "b", status: "running" }]);
		const snapshots = snapshotsFromRuns([run], () => false);
		assert.deepEqual(snapshots.map((snapshot) => snapshot.runnerAlive), [false, false]);
	});
});

describe("progress notices", () => {
	it("names the child, the verdict and the action in plain words", () => {
		assert.equal(
			formatProgressNotice({ runId: RUN_ID, agent: "worker", verdict: "stalled", signal: "no-progress", reason: "no new activity or commits for 12 min", action: "nudged" }),
			"[subagent] worker (01234567) stalled: no new activity or commits for 12 min. Sent a nudge.",
		);
		assert.equal(
			formatProgressNotice({ runId: RUN_ID, agent: "worker", verdict: "looping", signal: "identical-calls", reason: "repeated bash with the same arguments 6 times in a row", action: "stopped" }),
			"[subagent] worker (01234567) looping: repeated bash with the same arguments 6 times in a row. Stopped it (progress watchdog).",
		);
		assert.match(
			formatProgressNotice({ runId: RUN_ID, agent: "worker", verdict: "dead", signal: "runner-gone", reason: "the runner process is gone", action: "none" }),
			/dead: the runner process is gone\. Report only; no action taken\.$/,
		);
	});
});
