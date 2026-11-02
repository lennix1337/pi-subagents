import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROGRESS_POLICY, classifyProgress, type ProgressObservation, type ProgressToolCall } from "../../src/watchdog/progress/progress-signals.ts";

const MINUTE = 60_000;
const NOW = 1_000_000_000;

function call(tool: string, args: string, failed?: boolean): ProgressToolCall {
	return failed ? { tool, args, failed } : { tool, args };
}

function observe(overrides: Partial<ProgressObservation> = {}): ProgressObservation {
	return {
		nowMs: NOW,
		startedAtMs: NOW - 2 * MINUTE,
		lastActivityAtMs: NOW - 10_000,
		recentTools: [call("read", "a.ts"), call("edit", "a.ts")],
		runnerAlive: true,
		...overrides,
	};
}

describe("progress signals", () => {
	it("reports a child with fresh activity and varied calls as healthy", () => {
		const verdict = classifyProgress(observe(), DEFAULT_PROGRESS_POLICY);
		assert.deepEqual(verdict, { verdict: "healthy", signal: "active", reason: "recent activity" });
	});

	it("marks a child dead when its runner process is gone, even with fresh activity", () => {
		const verdict = classifyProgress(observe({ runnerAlive: false }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "dead");
		assert.equal(verdict.signal, "runner-gone");
	});

	it("keeps an unknown runner liveness as not dead", () => {
		const verdict = classifyProgress(observe({ runnerAlive: undefined }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "healthy");
	});

	it("flags the same tool call repeated the configured number of times in a row", () => {
		const repeated = Array.from({ length: 6 }, () => call("bash", "npm test"));
		const verdict = classifyProgress(observe({ recentTools: repeated }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "looping");
		assert.equal(verdict.signal, "identical-calls");
		assert.match(verdict.reason, /bash.*6 times in a row/);
	});

	it("does not flag identical calls below the repeat threshold or broken by a different call", () => {
		const below = Array.from({ length: 5 }, () => call("bash", "npm test"));
		assert.equal(classifyProgress(observe({ recentTools: below }), DEFAULT_PROGRESS_POLICY).verdict, "healthy");
		const broken = [...Array.from({ length: 5 }, () => call("bash", "npm test")), call("read", "x.ts")];
		assert.equal(classifyProgress(observe({ recentTools: [...broken, call("bash", "npm test")] }), DEFAULT_PROGRESS_POLICY).verdict, "healthy");
	});

	it("flags consecutive failed tool calls and resets when one succeeds", () => {
		const failing = Array.from({ length: 4 }, (_, index) => call("bash", `make target-${index}`, true));
		const verdict = classifyProgress(observe({ recentTools: failing }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "looping");
		assert.equal(verdict.signal, "failed-calls");
		assert.match(verdict.reason, /4 failed tool calls in a row/);
		const recovered = [...failing.slice(0, 3), call("bash", "fixed")];
		assert.equal(classifyProgress(observe({ recentTools: recovered }), DEFAULT_PROGRESS_POLICY).verdict, "healthy");
	});

	it("flags re-running the same CI run even when the rerun flags differ", () => {
		const reruns = [
			call("bash", "gh run rerun 41506709546 --failed"),
			call("read", "log.txt"),
			call("bash", "gh run rerun 41506709546"),
			call("bash", "gh run rerun 41506709546 --failed --repo x/y"),
		];
		const verdict = classifyProgress(observe({ recentTools: reruns }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "looping");
		assert.equal(verdict.signal, "rerun-loop");
		assert.match(verdict.reason, /CI run 41506709546 3 times/);
	});

	it("does not flag reruns of distinct CI runs", () => {
		const reruns = ["1", "2", "3", "4"].map((id) => call("bash", `gh run rerun ${id}`));
		assert.equal(classifyProgress(observe({ recentTools: reruns }), DEFAULT_PROGRESS_POLICY).verdict, "healthy");
	});

	it("marks a child stalled after the stall window without activity or commits", () => {
		const verdict = classifyProgress(observe({ lastActivityAtMs: NOW - 11 * MINUTE, startedAtMs: NOW - 30 * MINUTE }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "stalled");
		assert.equal(verdict.signal, "no-progress");
		assert.match(verdict.reason, /no new activity or commits for 11 min/);
	});

	it("does not stall a child whose commits are recent even if its activity is old", () => {
		const verdict = classifyProgress(observe({ lastActivityAtMs: NOW - 11 * MINUTE, lastCommitAtMs: NOW - 2 * MINUTE, startedAtMs: NOW - 30 * MINUTE }), DEFAULT_PROGRESS_POLICY);
		assert.equal(verdict.verdict, "healthy");
	});

	it("falls back to the start time when the runner has never reported activity", () => {
		const fresh = classifyProgress(observe({ lastActivityAtMs: undefined, startedAtMs: NOW - 3 * MINUTE }), DEFAULT_PROGRESS_POLICY);
		assert.equal(fresh.verdict, "healthy");
		const old = classifyProgress(observe({ lastActivityAtMs: undefined, startedAtMs: NOW - 12 * MINUTE }), DEFAULT_PROGRESS_POLICY);
		assert.equal(old.verdict, "stalled");
	});

	it("treats a long tool call inside its grace window as healthy and an overrun as stalled", () => {
		const inside = classifyProgress(observe({ lastActivityAtMs: NOW - 20 * MINUTE, inFlight: { tool: "bash", startedAtMs: NOW - 5 * MINUTE } }), DEFAULT_PROGRESS_POLICY);
		assert.equal(inside.verdict, "healthy");
		assert.equal(inside.signal, "tool-in-flight");
		const overrun = classifyProgress(observe({ lastActivityAtMs: NOW - 40 * MINUTE, inFlight: { tool: "bash", startedAtMs: NOW - 35 * MINUTE } }), DEFAULT_PROGRESS_POLICY);
		assert.equal(overrun.verdict, "stalled");
		assert.equal(overrun.signal, "tool-overrun");
		assert.match(overrun.reason, /bash.*in flight for 35 min/);
	});

	it("ranks a dead runner above a loop, and a loop above a stall", () => {
		const repeated = Array.from({ length: 6 }, () => call("bash", "npm test"));
		assert.equal(classifyProgress(observe({ recentTools: repeated, runnerAlive: false }), DEFAULT_PROGRESS_POLICY).verdict, "dead");
		assert.equal(classifyProgress(observe({ recentTools: repeated, lastActivityAtMs: NOW - 30 * MINUTE }), DEFAULT_PROGRESS_POLICY).verdict, "looping");
	});
});
