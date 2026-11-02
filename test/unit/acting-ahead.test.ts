import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActingAhead, type ActingAheadDeps, type SpeculativeOutcome, type SpeculativeRun, type SpeculativeTask } from "../../src/speculative/acting-ahead.ts";
import { DEFAULT_ACTING_AHEAD_CONFIG, type ActingAheadConfig } from "../../src/speculative/acting-ahead-policy.ts";
import type { SpeculativeEvidence, SpeculativeVerdict } from "../../src/speculative/acting-ahead-verify.ts";
import type { PrWatchEvent } from "../../src/integrations/pr-thread-subscriptions.ts";

const MINUTE = 60_000;
const config: ActingAheadConfig = {
	...DEFAULT_ACTING_AHEAD_CONFIG,
	enabled: true,
	owners: ["lennix1337"],
	maxConcurrent: 1,
	maxRuntimeMs: 20 * MINUTE,
	cooldownMs: 6 * 60 * MINUTE,
	testCommands: { "lennix1337/pi-subagents": ["node", "--test", "test/unit/x.test.ts"] },
};

function ciFailed(pr: number, overrides: Partial<PrWatchEvent> = {}): PrWatchEvent {
	return { kind: "ci-failed", repo: "lennix1337/pi-subagents", pr, branch: `feat/${pr}`, ts: 1, ...overrides };
}

const goodEvidence = { worktreePath: "C:/wt/spec-9", baseRef: "abc1234", fixFiles: ["src/a.ts"], testFiles: ["test/unit/a.test.ts"] };

interface Harness {
	clock: { now: number };
	launches: SpeculativeTask[];
	stops: Array<{ runId: string; reason: string }>;
	reports: string[];
	verifications: SpeculativeEvidence[];
	subscriptions: Array<{ runId: string; pr: number }>;
	unsubscribed: string[];
	errors: unknown[];
	timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
	finish: Map<string, (outcome: SpeculativeOutcome) => void>;
	acting: ActingAhead;
}

function harness(options: { verdict?: SpeculativeVerdict; launchError?: Error; cfg?: ActingAheadConfig } = {}): Harness {
	const clock = { now: 1_000_000 };
	const launches: SpeculativeTask[] = [];
	const stops: Harness["stops"] = [];
	const reports: string[] = [];
	const verifications: SpeculativeEvidence[] = [];
	const subscriptions: Harness["subscriptions"] = [];
	const unsubscribed: string[] = [];
	const errors: unknown[] = [];
	const timers: Harness["timers"] = [];
	const finish = new Map<string, (outcome: SpeculativeOutcome) => void>();
	let counter = 0;
	const deps: ActingAheadDeps = {
		now: () => clock.now,
		launch: async (task) => {
			if (options.launchError) throw options.launchError;
			launches.push(task);
			counter++;
			const runId = `run-${counter}`;
			const finished = new Promise<SpeculativeOutcome>((resolve) => { finish.set(runId, resolve); });
			const run: SpeculativeRun = { runId, asyncDir: `C:/async/${runId}`, stepIndex: 0, finished };
			return run;
		},
		stop: (run, reason) => { stops.push({ runId: run.runId, reason }); },
		subscribe: (run, pr) => { subscriptions.push({ runId: run.runId, pr: pr.pr }); },
		unsubscribe: (run) => { unsubscribed.push(run.runId); },
		verify: async (evidence) => {
			verifications.push(evidence);
			return options.verdict ?? { confirmed: true };
		},
		report: (message) => { reports.push(message); },
		setTimer: (fn, ms) => {
			const timer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
		onError: (error) => { errors.push(error); },
	};
	const acting = new ActingAhead(deps, options.cfg ?? config);
	return { clock, launches, stops, reports, verifications, subscriptions, unsubscribed, errors, timers, finish, acting };
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

describe("acting ahead lifecycle", () => {
	it("launches one background child for an admitted CI failure, with the PR, the repo's test command and a no-report default", async () => {
		const h = harness();
		const decision = await h.acting.handleEvent(ciFailed(9));
		assert.equal(decision.admit, true);
		assert.equal(h.launches.length, 1);
		const task = h.launches[0]!;
		assert.equal(task.repo, "lennix1337/pi-subagents");
		assert.equal(task.pr, 9);
		assert.deepEqual(task.testCommand, ["node", "--test", "test/unit/x.test.ts"]);
		assert.match(task.prompt, /failing regression test/);
		assert.deepEqual(h.subscriptions, [{ runId: "run-1", pr: 9 }], "the child owns the PR's events while it works");
		assert.equal(h.acting.snapshot().active, 1);
	});

	it("reserves the slot before the launch completes, so a burst cannot exceed the cap", async () => {
		const h = harness();
		const first = h.acting.handleEvent(ciFailed(9));
		const second = await h.acting.handleEvent(ciFailed(10));
		assert.deepEqual(second, { admit: false, reason: "concurrency cap reached (1 running)" });
		assert.equal((await first).admit, true);
		assert.equal(h.launches.length, 1);
	});

	it("reports a confirmed fix once, in one line, and releases the slot and subscription", async () => {
		const h = harness({ verdict: { confirmed: true } });
		await h.acting.handleEvent(ciFailed(9));
		h.finish.get("run-1")!({ ok: true, evidence: goodEvidence });
		await flush();
		assert.equal(h.verifications.length, 1);
		assert.equal(h.verifications[0]!.testCommand.join(" "), "node --test test/unit/x.test.ts", "the harness owns the test command, not the child");
		assert.equal(h.reports.length, 1);
		assert.match(h.reports[0]!, /lennix1337\/pi-subagents#9.*confirmed.*red without.*green with/);
		assert.equal(h.acting.snapshot().active, 0);
		assert.deepEqual(h.unsubscribed, ["run-1"]);
		assert.deepEqual(h.stops, []);
	});

	it("discards silently when the fix is not confirmed: no report, cooldown applies, the reason is kept", async () => {
		const h = harness({ verdict: { confirmed: false, reason: "tests pass without the fix" } });
		await h.acting.handleEvent(ciFailed(9));
		h.finish.get("run-1")!({ ok: true, evidence: goodEvidence });
		await flush();
		assert.deepEqual(h.reports, []);
		const snapshot = h.acting.snapshot();
		assert.equal(snapshot.confirmed, 0);
		assert.deepEqual(snapshot.discarded.map((entry) => entry.reason), ["tests pass without the fix"]);
		const again = await h.acting.handleEvent(ciFailed(9));
		assert.deepEqual(again, { admit: false, reason: "cooldown after the last attempt on this PR" });
	});

	it("does not verify a child that produced no evidence, and discards it", async () => {
		const h = harness();
		await h.acting.handleEvent(ciFailed(9));
		h.finish.get("run-1")!({ ok: false });
		await flush();
		assert.equal(h.verifications.length, 0);
		assert.deepEqual(h.reports, []);
		assert.deepEqual(h.acting.snapshot().discarded.map((entry) => entry.reason), ["child finished without evidence"]);
	});

	it("enforces the runtime cap: stops the child, frees the slot, and ignores a late finish", async () => {
		const h = harness();
		await h.acting.handleEvent(ciFailed(9));
		assert.equal(h.timers.length, 1);
		assert.equal(h.timers[0]!.ms, 20 * MINUTE);
		h.timers[0]!.fn();
		assert.deepEqual(h.stops, [{ runId: "run-1", reason: "acting-ahead runtime cap reached" }]);
		assert.equal(h.acting.snapshot().active, 0, "the slot is free even if the child has not exited yet");
		assert.deepEqual(h.acting.snapshot().discarded.map((entry) => entry.reason), ["runtime cap reached"]);
		h.finish.get("run-1")!({ ok: true, evidence: goodEvidence });
		await flush();
		assert.equal(h.verifications.length, 0, "a late result of a capped run is not verified or reported");
		assert.deepEqual(h.reports, []);
	});

	it("clears the runtime timer when the child finishes in time", async () => {
		const h = harness();
		await h.acting.handleEvent(ciFailed(9));
		h.finish.get("run-1")!({ ok: false });
		await flush();
		assert.equal(h.timers[0]!.cleared, true);
	});

	it("reports a launch failure, frees the slot and does not count it as a running speculation", async () => {
		const failure = new Error("runner refused to start");
		const h = harness({ launchError: failure });
		const decision = await h.acting.handleEvent(ciFailed(9));
		assert.equal(decision.admit, false);
		assert.equal(h.errors[0], failure);
		assert.equal(h.acting.snapshot().active, 0);
		assert.deepEqual(h.acting.snapshot().discarded.map((entry) => entry.reason), ["launch failed"]);
	});

	it("is inert when disabled, whatever the event", async () => {
		const h = harness({ cfg: { ...config, enabled: false } });
		assert.deepEqual(await h.acting.handleEvent(ciFailed(9)), { admit: false, reason: "acting ahead is disabled" });
		assert.equal(h.launches.length, 0);
	});
});
