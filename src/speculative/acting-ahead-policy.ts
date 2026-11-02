/**
 * Acting ahead: admission and configuration. Off by default. A CI failure may
 * start a speculative attempt only when the operator enabled it, the repo's owner
 * is allowlisted, the repo has a test command, and the caps and cooldowns allow it.
 * The rules are one declarative table, so each refusal reads as one line.
 */
import type { PrWatchEvent } from "../integrations/pr-thread-subscriptions.ts";

export interface ActingAheadConfig {
	enabled: boolean;
	/** GitHub owners whose repositories may be speculated on (the operator's own). */
	owners: string[];
	/** Speculative runs at once; hard-capped at 3. */
	maxConcurrent: number;
	/** A run still going after this long is stopped and its result discarded. */
	maxRuntimeMs: number;
	/** After an attempt on a PR, no new attempt on that PR for this long. */
	cooldownMs: number;
	/** Test argv per `owner/name`, run without a shell. The harness runs it; the child cannot change it. */
	testCommands: Record<string, string[]>;
}

export const DEFAULT_ACTING_AHEAD_CONFIG: ActingAheadConfig = {
	enabled: false,
	owners: [],
	maxConcurrent: 1,
	maxRuntimeMs: 20 * 60_000,
	cooldownMs: 6 * 60 * 60_000,
	testCommands: {},
};

export interface ActingAheadState {
	active: ReadonlyArray<{ repo: string; pr: number }>;
	/** Last attempt start per `speculationKey`, in epoch milliseconds. */
	lastAttemptAt: ReadonlyMap<string, number>;
}

export type ActingAheadDecision = { admit: true; testCommand: string[] } | { admit: false; reason: string };

export function speculationKey(repo: string, pr: number): string {
	return `${repo.toLowerCase()}#${pr}`;
}

function ownerOf(repo: string): string {
	return repo.split("/")[0]!.toLowerCase();
}

interface AdmissionContext {
	event: PrWatchEvent;
	config: ActingAheadConfig;
	state: ActingAheadState;
	now: number;
	key: string;
	testCommand: string[] | undefined;
}

const ADMISSION_RULES: ReadonlyArray<{ refuse(context: AdmissionContext): string | undefined }> = [
	{ refuse: (c) => (c.config.enabled ? undefined : "acting ahead is disabled") },
	{ refuse: (c) => (c.event.kind === "ci-failed" ? undefined : "not a CI failure") },
	{ refuse: (c) => (c.config.owners.some((owner) => owner.toLowerCase() === ownerOf(c.event.repo)) ? undefined : "repo owner is not allowlisted") },
	{ refuse: (c) => (c.testCommand ? undefined : `no test command configured for ${c.event.repo}`) },
	{ refuse: (c) => (c.state.active.length >= c.config.maxConcurrent ? `concurrency cap reached (${c.state.active.length} running)` : undefined) },
	{ refuse: (c) => (c.state.active.some((run) => speculationKey(run.repo, run.pr) === c.key) ? "already speculating on this PR" : undefined) },
	{
		refuse: (c) => {
			const last = c.state.lastAttemptAt.get(c.key);
			return last !== undefined && c.now - last < c.config.cooldownMs ? "cooldown after the last attempt on this PR" : undefined;
		},
	},
];

/** Pure: admits a CI failure or names the first rule that refuses it. */
export function admitSpeculation(input: { event: PrWatchEvent; config: ActingAheadConfig; state: ActingAheadState; now: number }): ActingAheadDecision {
	const { event, config } = input;
	const key = event.pr !== undefined ? speculationKey(event.repo, event.pr) : `${event.repo.toLowerCase()}@${event.branch ?? ""}`;
	const context: AdmissionContext = { ...input, key, testCommand: config.testCommands[event.repo] ?? config.testCommands[event.repo.toLowerCase()] };
	for (const rule of ADMISSION_RULES) {
		const reason = rule.refuse(context);
		if (reason) return { admit: false, reason };
	}
	return { admit: true, testCommand: [...context.testCommand!] };
}

const MAX_CONCURRENT_LIMIT = 3;
const MIN_RUNTIME_MS = 60_000;
const MAX_RUNTIME_MS = 2 * 60 * 60_000;
const CONFIG_FIELDS = new Set(["enabled", "owners", "maxConcurrent", "maxRuntimeMs", "cooldownMs", "testCommands"]);

function fail(field: string, expected: string): never {
	throw new Error(`Invalid acting-ahead config: ${field} must be ${expected}.`);
}

function integerIn(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(field, `an integer from ${min} to ${max}`);
	return value;
}

function nonEmptyStrings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) fail(field, "an array of non-empty strings");
	return value.map((entry) => (entry as string).trim());
}

/** Strict parse of the `actingAhead` settings section; unknown fields and out-of-range caps are refused. */
export function parseActingAheadConfig(raw: unknown): ActingAheadConfig {
	const config: ActingAheadConfig = { ...DEFAULT_ACTING_AHEAD_CONFIG, owners: [], testCommands: {} };
	if (raw === undefined) return config;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid acting-ahead config: expected an object.");
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!CONFIG_FIELDS.has(key)) throw new Error(`Invalid acting-ahead config: unknown field ${key}.`);
	}
	if ("enabled" in input) {
		if (typeof input.enabled !== "boolean") fail("enabled", "a boolean");
		config.enabled = input.enabled;
	}
	if ("owners" in input) config.owners = nonEmptyStrings(input.owners, "owners");
	if ("maxConcurrent" in input) config.maxConcurrent = integerIn(input.maxConcurrent, "maxConcurrent", 1, MAX_CONCURRENT_LIMIT);
	if ("maxRuntimeMs" in input) config.maxRuntimeMs = integerIn(input.maxRuntimeMs, "maxRuntimeMs", MIN_RUNTIME_MS, MAX_RUNTIME_MS);
	if ("cooldownMs" in input) config.cooldownMs = integerIn(input.cooldownMs, "cooldownMs", 0, Number.MAX_SAFE_INTEGER);
	if ("testCommands" in input) {
		const commands = input.testCommands;
		if (typeof commands !== "object" || commands === null || Array.isArray(commands)) fail("testCommands", "an object keyed by owner/name");
		for (const [repo, argv] of Object.entries(commands as Record<string, unknown>)) {
			const parsed = nonEmptyStrings(argv, `testCommands.${repo}`);
			if (parsed.length === 0) fail(`testCommands.${repo}`, "a non-empty argv");
			config.testCommands[repo] = parsed;
		}
	}
	return config;
}
