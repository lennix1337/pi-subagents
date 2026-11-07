import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROGRESS_POLICY, classifyProgress, type ProgressObservation, type ProgressToolCall } from "../../src/watchdog/progress/progress-signals.ts";
import { PROPERTY_CASES, intBetween, pick, seededRandom, type Rng } from "../support/seeded-random.ts";

// Property tests for the loop rules of the progress classifier. The model is a plain restatement of the
// rules over the call history: two calls are the same call when their tool and full-argument digest match
// (display previews only when a call has no digest), a loop is a run of at least the policy's length, and
// the rules fire in precedence order: runner gone, identical calls, failed calls, CI re-runs, then healthy.

const POLICY = DEFAULT_PROGRESS_POLICY;
const NOW = 1_000_000_000;
const TOOLS = ["read", "edit", "bash"] as const;
const KEYS = ["k1", "k2", "k3"] as const;
const PLAIN_PREVIEWS = ["a.ts", "b.ts"] as const;
const RERUN_PREVIEWS = ["a.ts", "gh run rerun 7", "gh run rerun 8"] as const;
const RERUN = /\bgh\s+(?:run|workflow)\s+rerun\s+(\d+)/;

type Mode = "keyed" | "legacy";
type Expectation = { verdict: string; signal: string; reason?: string; count?: number };

// A keyed history: every call has a digest and its preview is noise. A legacy history: no digest.
function randomHistory(next: Rng, mode: Mode, withRerun: boolean): ProgressToolCall[] {
	const previews = withRerun ? RERUN_PREVIEWS : PLAIN_PREVIEWS;
	const length = intBetween(next, 0, 12);
	const runLength = next() < 0.7 ? intBetween(next, 3, 9) : 0;
	const runKind = pick(next, ["identical", "same-tool", "failed"] as const);
	const template = { tool: pick(next, TOOLS), key: pick(next, KEYS), preview: pick(next, previews) };
	return Array.from({ length }, (_, index) => {
		const inRun = index >= length - runLength;
		const tool = inRun ? template.tool : pick(next, TOOLS);
		const sameIdentity = inRun && runKind === "identical";
		const call: ProgressToolCall = mode === "keyed"
			? { tool, args: pick(next, previews), argsKey: sameIdentity ? template.key : pick(next, KEYS) }
			: { tool, args: sameIdentity ? template.preview : pick(next, previews) };
		if (inRun && runKind === "failed") call.failed = true;
		else if (next() < 0.2) call.failed = true;
		return call;
	});
}

function sameCall(a: ProgressToolCall, b: ProgressToolCall, mode: Mode): boolean {
	return a.tool === b.tool && (mode === "keyed" ? a.argsKey === b.argsKey : a.args === b.args);
}

function identicalSuffix(calls: readonly ProgressToolCall[], mode: Mode): number {
	const last = calls.at(-1);
	if (!last) return 0;
	let count = 0;
	for (let index = calls.length - 1; index >= 0 && sameCall(calls[index]!, last, mode); index--) count++;
	return count;
}

function failedSuffix(calls: readonly ProgressToolCall[]): number {
	let count = 0;
	for (let index = calls.length - 1; index >= 0 && calls[index]!.failed === true; index--) count++;
	return count;
}

function mostRerunCount(calls: readonly ProgressToolCall[]): number {
	const counts = new Map<string, number>();
	for (const call of calls) {
		const id = RERUN.exec(call.args)?.[1];
		if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return Math.max(0, ...counts.values());
}

function model(calls: readonly ProgressToolCall[], alive: boolean | undefined, mode: Mode): Expectation {
	if (alive === false) return { verdict: "dead", signal: "runner-gone" };
	const identical = identicalSuffix(calls, mode);
	if (identical >= POLICY.identicalCallRepeats) {
		return { verdict: "looping", signal: "identical-calls", reason: `repeated ${calls.at(-1)!.tool} with the same arguments ${identical} times in a row` };
	}
	const failed = failedSuffix(calls);
	if (failed >= POLICY.failedCallRepeats) return { verdict: "looping", signal: "failed-calls", reason: `${failed} failed tool calls in a row` };
	const rerun = mostRerunCount(calls);
	if (rerun >= POLICY.rerunRepeats) return { verdict: "looping", signal: "rerun-loop", count: rerun };
	return { verdict: "healthy", signal: "active", reason: "recent activity" };
}

function classify(calls: readonly ProgressToolCall[], alive: boolean | undefined) {
	const observation: ProgressObservation = {
		nowMs: NOW,
		startedAtMs: NOW - 2 * 60_000,
		lastActivityAtMs: NOW - 10_000,
		recentTools: calls,
		runnerAlive: alive,
	};
	return classifyProgress(observation, POLICY);
}

function assertMatchesModel(actual: { verdict: string; signal: string; reason: string }, expected: Expectation, label: string): void {
	assert.equal(actual.signal, expected.signal, `${label}: signal`);
	assert.equal(actual.verdict, expected.verdict, `${label}: verdict`);
	if (expected.reason !== undefined) assert.equal(actual.reason, expected.reason, `${label}: reason`);
	if (expected.count !== undefined) {
		assert.match(actual.reason, /^re-ran CI run \d+ \d+ times$/, `${label}: reason`);
		assert.equal(Number(/ (\d+) times$/.exec(actual.reason)?.[1]), expected.count, `${label}: re-run count`);
	}
}

describe("progress loop rules (property tests)", () => {
	it("property: the verdict matches the rule model over keyed and legacy call histories", () => {
		const seen = new Map<string, number>();
		for (const mode of ["keyed", "legacy"] as const) {
			for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
				const next = seededRandom(seed * 2 + (mode === "keyed" ? 0 : 1));
				const calls = randomHistory(next, mode, true);
				const alive = next() < 0.1 ? false : true;
				const verdict = classify(calls, alive);
				const expected = model(calls, alive, mode);
				assertMatchesModel(verdict, expected, `${mode} seed ${seed} history ${JSON.stringify(calls)}`);
				seen.set(expected.signal, (seen.get(expected.signal) ?? 0) + 1);
			}
		}
		for (const signal of ["runner-gone", "identical-calls", "failed-calls", "rerun-loop", "active"]) {
			assert.ok((seen.get(signal) ?? 0) >= 10, `generator coverage: only ${seen.get(signal) ?? 0} histories reach ${signal}`);
		}
	});

	it("property: with digests, the display preview never changes the verdict", () => {
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const calls = randomHistory(next, "keyed", false);
			const collapsed = calls.map((call) => ({ ...call, args: "same preview" }));
			const reworded = calls.map((call) => ({ ...call, args: pick(next, ["x", "y", "z"]) }));
			const original = classify(calls, true);
			assert.deepEqual(classify(collapsed, true), original, `seed ${seed}: one shared preview changed the verdict`);
			assert.deepEqual(classify(reworded, true), original, `seed ${seed}: other previews changed the verdict`);
		}
	});

	it("property: a run of calls with the same preview but different digests is not a loop", () => {
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const tool = pick(next, TOOLS);
			const run = Array.from({ length: POLICY.identicalCallRepeats + intBetween(next, 0, 3) }, (_, index) => ({ tool, args: "ls -la", argsKey: `d${index}` }));
			assert.equal(classify(run, true).signal, "active", `seed ${seed}: distinct digests read as identical`);
		}
	});

	it("property: without digests, the display preview decides identity", () => {
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const tool = pick(next, TOOLS);
			const repeats = POLICY.identicalCallRepeats + intBetween(next, -1, 1);
			const run: ProgressToolCall[] = Array.from({ length: repeats }, () => ({ tool, args: pick(next, PLAIN_PREVIEWS) }));
			const signal = classify(run, true).signal;
			assert.equal(signal, model(run, true, "legacy").signal, `seed ${seed}: legacy history ${JSON.stringify(run)}`);
		}
	});

	it("property: exactly identicalCallRepeats identical calls in a row loop; one fewer does not", () => {
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const tool = pick(next, TOOLS);
			const key = pick(next, KEYS);
			const prefix: ProgressToolCall[] = [{ tool: tool === "read" ? "edit" : "read", args: "a.ts", argsKey: key }];
			const run = (count: number): ProgressToolCall[] => [...prefix, ...Array.from({ length: count }, () => ({ tool, args: pick(next, PLAIN_PREVIEWS), argsKey: key }))];
			assert.equal(classify(run(POLICY.identicalCallRepeats), true).signal, "identical-calls", `seed ${seed}: boundary loop`);
			assert.notEqual(classify(run(POLICY.identicalCallRepeats - 1), true).signal, "identical-calls", `seed ${seed}: below boundary`);
		}
	});
});
