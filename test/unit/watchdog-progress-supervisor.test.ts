import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROGRESS_POLICY, type ProgressToolCall } from "../../src/watchdog/progress/progress-signals.ts";
import { ProgressSupervisor, type ProgressNotice, type ProgressRunSnapshot, type ProgressSupervisorDeps, type ProgressSupervisorOptions } from "../../src/watchdog/progress/progress-supervisor.ts";

const MINUTE = 60_000;
const START = 5_000_000;

interface Harness {
	clock: { now: number };
	runs: ProgressRunSnapshot[];
	heads: Map<string, string | undefined>;
	probes: string[];
	steers: Array<{ runId: string; message: string }>;
	stops: Array<{ runId: string; reason: string }>;
	notices: ProgressNotice[];
	errors: Array<{ error: unknown; runId?: string }>;
	supervisor: ProgressSupervisor;
}

function run(overrides: Partial<ProgressRunSnapshot> = {}): ProgressRunSnapshot {
	return {
		runId: "run-1",
		agent: "worker",
		asyncDir: "C:/tmp/async/run-1",
		stepIndex: 0,
		worktreePath: "C:/tmp/wt/run-1",
		startedAtMs: START,
		lastActivityAtMs: START,
		recentTools: [] as ProgressToolCall[],
		runnerAlive: true,
		...overrides,
	};
}

function harness(options: Partial<ProgressSupervisorOptions> = {}, depsOverrides: Partial<ProgressSupervisorDeps> = {}): Harness {
	const clock = { now: START };
	const runs: ProgressRunSnapshot[] = [];
	const heads = new Map<string, string | undefined>();
	const probes: string[] = [];
	const steers: Harness["steers"] = [];
	const stops: Harness["stops"] = [];
	const notices: ProgressNotice[] = [];
	const errors: Harness["errors"] = [];
	const deps: ProgressSupervisorDeps = {
		now: () => clock.now,
		listRuns: () => runs,
		readHead: async (worktreePath) => {
			probes.push(worktreePath);
			return heads.get(worktreePath);
		},
		steer: (target, message) => { steers.push({ runId: target.runId, message }); },
		stop: (target, reason) => { stops.push({ runId: target.runId, reason }); },
		notify: (notice) => { notices.push(notice); },
		onError: (error, runId) => { errors.push({ error, ...(runId ? { runId } : {}) }); },
		...depsOverrides,
	};
	const supervisor = new ProgressSupervisor(deps, {
		policy: DEFAULT_PROGRESS_POLICY,
		actions: { stalled: "report", looping: "report" },
		maxNudges: 2,
		nudgeCooldownMs: 10 * MINUTE,
		renotifyAfterMs: 30 * MINUTE,
		...options,
	});
	return { clock, runs, heads, probes, steers, stops, notices, errors, supervisor };
}

describe("progress supervisor sweeps", () => {
	it("stays silent for healthy children and performs no actions or probes", async () => {
		const h = harness({ actions: { stalled: "stop", looping: "nudge" } });
		h.runs.push(run());
		await h.supervisor.sweep();
		assert.deepEqual(h.notices, []);
		assert.deepEqual(h.steers, []);
		assert.deepEqual(h.stops, []);
		assert.deepEqual(h.probes, [], "a fresh child is not probed for commits");
	});

	it("reports a dead runner once and never acts on it", async () => {
		const h = harness({ actions: { stalled: "stop", looping: "stop" } });
		h.runs.push(run({ runnerAlive: false }));
		await h.supervisor.sweep();
		await h.supervisor.sweep();
		assert.equal(h.notices.length, 1);
		assert.equal(h.notices[0]!.verdict, "dead");
		assert.equal(h.notices[0]!.action, "none");
		assert.deepEqual(h.stops, []);
	});

	it("reports a stall only once per episode and renotifies after the window", async () => {
		const h = harness();
		h.runs.push(run({ lastActivityAtMs: START }));
		h.clock.now = START + 12 * MINUTE;
		await h.supervisor.sweep();
		await h.supervisor.sweep();
		assert.equal(h.notices.length, 1, "same verdict and signal is not repeated inside the window");
		assert.equal(h.notices[0]!.verdict, "stalled");
		assert.match(h.notices[0]!.reason, /no new activity or commits for 12 min/);
		h.clock.now += 31 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.notices.length, 2, "still stalled after the renotify window");
	});

	it("nudges a stalled child with a steer message, capped by cooldown and the nudge limit", async () => {
		const h = harness({ actions: { stalled: "nudge", looping: "report" }, maxNudges: 2, nudgeCooldownMs: 10 * MINUTE });
		h.runs.push(run({ lastActivityAtMs: START }));
		h.clock.now = START + 12 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.steers.length, 1);
		assert.equal(h.notices[0]!.action, "nudged");
		assert.match(h.steers[0]!.message, /no new activity or commits for 12 min/);
		h.clock.now += 5 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.steers.length, 1, "no second nudge inside the cooldown");
		h.clock.now += 6 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.steers.length, 2, "second nudge after the cooldown");
		h.clock.now += 11 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.steers.length, 2, "the nudge limit is hard");
	});

	it("stops a looping child once when configured to stop, and records why", async () => {
		const h = harness({ actions: { stalled: "report", looping: "stop" } });
		const repeated: ProgressToolCall[] = Array.from({ length: 6 }, () => ({ tool: "bash", args: "npm test" }));
		h.runs.push(run({ recentTools: repeated }));
		await h.supervisor.sweep();
		await h.supervisor.sweep();
		assert.equal(h.stops.length, 1);
		assert.equal(h.stops[0]!.runId, "run-1");
		assert.match(h.stops[0]!.reason, /repeated bash with the same arguments 6 times/);
		assert.equal(h.notices[0]!.action, "stopped");
	});

	it("treats a new commit between probes as progress, so a silent but committing child is not stalled", async () => {
		const h = harness();
		h.runs.push(run({ lastActivityAtMs: START }));
		h.heads.set("C:/tmp/wt/run-1", "aaa111");
		h.clock.now = START + 12 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.notices.length, 1, "first stale probe only sets the baseline commit");
		h.clock.now += 2 * MINUTE;
		h.heads.set("C:/tmp/wt/run-1", "bbb222");
		await h.supervisor.sweep();
		assert.equal(h.probes.length, 2, "stale children are probed for commits");
		assert.equal(h.notices.length, 1, "the new commit clears the stall, so no new notice");
	});

	it("keeps classifying when the commit probe fails, and reports the probe failure", async () => {
		const failure = new Error("git timed out");
		const h = harness({}, { readHead: async () => { throw failure; } });
		h.runs.push(run({ lastActivityAtMs: START }));
		h.clock.now = START + 12 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.errors.length, 1);
		assert.equal(h.errors[0]!.error, failure);
		assert.equal(h.errors[0]!.runId, "run-1");
		assert.equal(h.notices[0]!.verdict, "stalled", "a failed probe does not hide the stall");
	});

	it("reports a failed steer or stop without marking the action as taken", async () => {
		const h = harness({ actions: { stalled: "nudge", looping: "report" } }, { steer: () => { throw new Error("inbox closed"); } });
		h.runs.push(run({ lastActivityAtMs: START }));
		h.clock.now = START + 12 * MINUTE;
		await h.supervisor.sweep();
		assert.equal(h.errors.length, 1);
		assert.match(String((h.errors[0]!.error as Error).message), /inbox closed/);
		assert.equal(h.notices[0]!.action, "none");
	});

	it("surfaces a listing failure and still completes the sweep", async () => {
		const failure = new Error("EPERM scanning async dir");
		const h = harness({}, { listRuns: () => { throw failure; } });
		await h.supervisor.sweep();
		assert.equal(h.errors[0]!.error, failure);
		assert.deepEqual(h.notices, []);
	});

	it("does not overlap sweeps: a second call while one runs is a no-op", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let probeCalls = 0;
		const h = harness({}, { readHead: async () => { probeCalls++; await gate; return "aaa"; } });
		h.runs.push(run({ lastActivityAtMs: START }));
		h.clock.now = START + 12 * MINUTE;
		const first = h.supervisor.sweep();
		await h.supervisor.sweep();
		assert.equal(probeCalls, 1, "the overlapping call did not start a second probe pass");
		release();
		await first;
		assert.equal(h.notices.length, 1);
	});

	it("forgets a run's memory once it disappears from the listing", async () => {
		const h = harness({ actions: { stalled: "nudge", looping: "report" }, maxNudges: 1 });
		h.runs.push(run({ lastActivityAtMs: START }));
		h.clock.now = START + 12 * MINUTE;
		await h.supervisor.sweep();
		h.runs.length = 0;
		await h.supervisor.sweep();
		h.runs.push(run({ lastActivityAtMs: h.clock.now - 12 * MINUTE }));
		await h.supervisor.sweep();
		assert.equal(h.steers.length, 2, "a reappearing run gets a fresh nudge budget");
	});

	it("start and dispose manage the schedule and never leave an interval behind", () => {
		const timers: Array<{ handle: object; cleared: boolean; intervalMs: number }> = [];
		const h = harness({});
		const started = h.supervisor.start(60_000, {
			setInterval: ((_fn: () => void, intervalMs: number) => {
				const handle = { unref() { return this; } };
				timers.push({ handle, cleared: false, intervalMs });
				return handle;
			}) as unknown as typeof setInterval,
			clearInterval: ((handle: object) => {
				const timer = timers.find((entry) => entry.handle === handle);
				if (timer) timer.cleared = true;
			}) as unknown as typeof clearInterval,
		});
		assert.equal(started, true);
		assert.equal(timers.length, 1);
		assert.equal(timers[0]!.intervalMs, 60_000);
		assert.equal(h.supervisor.start(60_000), false, "a second start does not add a timer");
		h.supervisor.dispose();
		assert.equal(timers[0]!.cleared, true);
	});
});
