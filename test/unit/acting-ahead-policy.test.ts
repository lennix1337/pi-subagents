import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ACTING_AHEAD_CONFIG, admitSpeculation, parseActingAheadConfig, speculationKey, type ActingAheadConfig, type ActingAheadState } from "../../src/speculative/acting-ahead-policy.ts";
import type { PrWatchEvent } from "../../src/integrations/pr-thread-subscriptions.ts";

const NOW = 10_000_000;
const HOUR = 60 * 60_000;

const enabled: ActingAheadConfig = {
	...DEFAULT_ACTING_AHEAD_CONFIG,
	enabled: true,
	owners: ["lennix1337"],
	testCommands: { "lennix1337/pi-subagents": ["node", "--test", "test/unit/x.test.ts"] },
};

const idle: ActingAheadState = { active: [], lastAttemptAt: new Map() };

function ciFailed(overrides: Partial<PrWatchEvent> = {}): PrWatchEvent {
	return { kind: "ci-failed", repo: "lennix1337/pi-subagents", pr: 9, branch: "feat/x", ts: NOW, ...overrides };
}

describe("acting ahead admission", () => {
	it("is off by default and refuses every trigger while disabled", () => {
		assert.equal(DEFAULT_ACTING_AHEAD_CONFIG.enabled, false);
		const decision = admitSpeculation({ event: ciFailed(), config: DEFAULT_ACTING_AHEAD_CONFIG, state: idle, now: NOW });
		assert.deepEqual(decision, { admit: false, reason: "acting ahead is disabled" });
	});

	it("admits a CI failure on an allowlisted repo that has a test command, and hands back that command", () => {
		const decision = admitSpeculation({ event: ciFailed(), config: enabled, state: idle, now: NOW });
		assert.deepEqual(decision, { admit: true, testCommand: ["node", "--test", "test/unit/x.test.ts"] });
	});

	it("refuses every trigger that is not a CI failure on a repo the operator owns, with the reason named", () => {
		const cases: Array<[string, Partial<PrWatchEvent>, string]> = [
			["another kind", { kind: "conflict" }, "not a CI failure"],
			["a repo of another owner", { repo: "someone/else" }, "repo owner is not allowlisted"],
			["a repo without a test command", { repo: "lennix1337/other" }, "no test command configured for lennix1337/other"],
		];
		for (const [label, overrides, reason] of cases) {
			const decision = admitSpeculation({ event: ciFailed(overrides), config: enabled, state: idle, now: NOW });
			assert.deepEqual(decision, { admit: false, reason }, label);
		}
	});

	it("enforces the concurrency cap before the same-PR and cooldown checks", () => {
		const busy: ActingAheadState = { active: [{ repo: "lennix1337/pi-subagents", pr: 4 }], lastAttemptAt: new Map() };
		assert.deepEqual(admitSpeculation({ event: ciFailed(), config: enabled, state: busy, now: NOW }), { admit: false, reason: "concurrency cap reached (1 running)" });
		const twoAllowed = { ...enabled, maxConcurrent: 2 };
		assert.equal(admitSpeculation({ event: ciFailed(), config: twoAllowed, state: busy, now: NOW }).admit, true);
	});

	it("refuses a second speculation on the same PR while one runs, and during its cooldown", () => {
		const sameAsRunning: ActingAheadState = { active: [{ repo: "LENNIX1337/pi-subagents", pr: 9 }], lastAttemptAt: new Map() };
		const twoAllowed = { ...enabled, maxConcurrent: 2 };
		assert.deepEqual(admitSpeculation({ event: ciFailed(), config: twoAllowed, state: sameAsRunning, now: NOW }), { admit: false, reason: "already speculating on this PR" });

		const cooling: ActingAheadState = { active: [], lastAttemptAt: new Map([[speculationKey("lennix1337/pi-subagents", 9), NOW - HOUR]]) };
		assert.deepEqual(admitSpeculation({ event: ciFailed(), config: enabled, state: cooling, now: NOW }), { admit: false, reason: "cooldown after the last attempt on this PR" });
		const expired: ActingAheadState = { active: [], lastAttemptAt: new Map([[speculationKey("lennix1337/pi-subagents", 9), NOW - 7 * HOUR]]) };
		assert.equal(admitSpeculation({ event: ciFailed(), config: enabled, state: expired, now: NOW }).admit, true);
	});

	it("keys a speculation by repo case-insensitively and PR number", () => {
		assert.equal(speculationKey("Lennix1337/PI-Subagents", 9), "lennix1337/pi-subagents#9");
	});
});

describe("acting ahead config", () => {
	it("fills omitted fields with the safe defaults", () => {
		const config = parseActingAheadConfig({ enabled: true, owners: ["lennix1337"], testCommands: { "lennix1337/a": ["node", "--test"] } });
		assert.equal(config.enabled, true);
		assert.equal(config.maxConcurrent, 1);
		assert.equal(config.maxRuntimeMs, 20 * 60_000);
		assert.equal(config.cooldownMs, 6 * HOUR);
	});

	it("rejects unknown fields, out-of-range caps and malformed commands", () => {
		assert.throws(() => parseActingAheadConfig({ retry: true }), /retry/);
		assert.throws(() => parseActingAheadConfig({ maxConcurrent: 0 }), /maxConcurrent/);
		assert.throws(() => parseActingAheadConfig({ maxConcurrent: 4 }), /maxConcurrent/);
		assert.throws(() => parseActingAheadConfig({ maxRuntimeMs: 30_000 }), /maxRuntimeMs/);
		assert.throws(() => parseActingAheadConfig({ maxRuntimeMs: 3 * HOUR }), /maxRuntimeMs/);
		assert.throws(() => parseActingAheadConfig({ testCommands: { "a/b": [] } }), /testCommands/);
		assert.throws(() => parseActingAheadConfig({ testCommands: { "a/b": ["node", ""] } }), /testCommands/);
		assert.throws(() => parseActingAheadConfig({ owners: [""] }), /owners/);
	});

	it("never enables speculation by omission", () => {
		assert.equal(parseActingAheadConfig({}).enabled, false);
		assert.equal(parseActingAheadConfig(undefined).enabled, false);
	});
});
