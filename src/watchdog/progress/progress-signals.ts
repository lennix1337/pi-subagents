/**
 * Deterministic progress signals for a running child.
 *
 * The classifier reads only what the runner already records (tool calls, the
 * last activity time, the in-flight tool, runner liveness) plus the commit
 * time the supervisor probes. It never calls a model: a verdict is a rule
 * firing, and each rule names the evidence it used.
 */

export const PROGRESS_VERDICTS = ["healthy", "stalled", "looping", "dead"] as const;
export type ProgressVerdict = typeof PROGRESS_VERDICTS[number];

export const PROGRESS_SIGNALS = [
	"runner-gone",
	"identical-calls",
	"failed-calls",
	"rerun-loop",
	"tool-overrun",
	"tool-in-flight",
	"no-progress",
	"active",
] as const;
export type ProgressSignal = typeof PROGRESS_SIGNALS[number];

export interface ProgressToolCall {
	tool: string;
	/** Display preview; it can be the same for calls whose full arguments differ. */
	args: string;
	/** Digest of the full arguments; when present it decides whether two calls are identical. */
	argsKey?: string;
	failed?: boolean;
}

export interface ProgressObservation {
	nowMs: number;
	startedAtMs: number;
	lastActivityAtMs?: number;
	lastCommitAtMs?: number;
	recentTools: readonly ProgressToolCall[];
	inFlight?: { tool: string; startedAtMs: number };
	/** `undefined` means the liveness probe could not tell; it never counts as dead. */
	runnerAlive: boolean | undefined;
}

export interface ProgressPolicy {
	/** Silence (no activity and no commit) after which a child counts as stalled. */
	stallAfterMs: number;
	/** Identical consecutive tool calls that count as a loop. */
	identicalCallRepeats: number;
	/** Consecutive failed tool calls that count as a loop. */
	failedCallRepeats: number;
	/** Re-runs of the same CI run that count as a loop. */
	rerunRepeats: number;
	/** How long one tool call may stay in flight before it is an overrun. */
	toolGraceMs: number;
}

export interface ProgressAssessment {
	verdict: ProgressVerdict;
	signal: ProgressSignal;
	reason: string;
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
	stallAfterMs: 10 * 60_000,
	identicalCallRepeats: 6,
	failedCallRepeats: 4,
	rerunRepeats: 3,
	toolGraceMs: 30 * 60_000,
};

const CI_RERUN_PATTERN = /\bgh\s+(?:run|workflow)\s+rerun\s+(\d+)/;

function minutes(ms: number): number {
	return Math.round(ms / 60_000);
}

function identicalTailLength(calls: readonly ProgressToolCall[]): number {
	const last = calls[calls.length - 1];
	if (!last) return 0;
	let count = 0;
	for (let index = calls.length - 1; index >= 0; index--) {
		const call = calls[index]!;
		if (call.tool !== last.tool || (call.argsKey ?? call.args) !== (last.argsKey ?? last.args)) break;
		count++;
	}
	return count;
}

function failedTailLength(calls: readonly ProgressToolCall[]): number {
	let count = 0;
	for (let index = calls.length - 1; index >= 0 && calls[index]!.failed === true; index--) count++;
	return count;
}

function mostRerunnedCi(calls: readonly ProgressToolCall[]): { id: string; count: number } | undefined {
	const counts = new Map<string, number>();
	for (const call of calls) {
		const id = CI_RERUN_PATTERN.exec(call.args)?.[1];
		if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	let best: { id: string; count: number } | undefined;
	for (const [id, count] of counts) if (!best || count > best.count) best = { id, count };
	return best;
}

/**
 * Classifies one running child. Rules fire in precedence order: a dead runner
 * outranks a loop, a loop outranks a stall, and a tool call inside its grace
 * window keeps a silent child healthy (a long test run is not a stall).
 */
export function classifyProgress(observation: ProgressObservation, policy: ProgressPolicy): ProgressAssessment {
	if (observation.runnerAlive === false) {
		return { verdict: "dead", signal: "runner-gone", reason: "the runner process is gone" };
	}

	const identical = identicalTailLength(observation.recentTools);
	if (identical >= policy.identicalCallRepeats) {
		const last = observation.recentTools[observation.recentTools.length - 1]!;
		return { verdict: "looping", signal: "identical-calls", reason: `repeated ${last.tool} with the same arguments ${identical} times in a row` };
	}

	const failed = failedTailLength(observation.recentTools);
	if (failed >= policy.failedCallRepeats) {
		return { verdict: "looping", signal: "failed-calls", reason: `${failed} failed tool calls in a row` };
	}

	const rerun = mostRerunnedCi(observation.recentTools);
	if (rerun && rerun.count >= policy.rerunRepeats) {
		return { verdict: "looping", signal: "rerun-loop", reason: `re-ran CI run ${rerun.id} ${rerun.count} times` };
	}

	if (observation.inFlight) {
		const inFlightMs = observation.nowMs - observation.inFlight.startedAtMs;
		if (inFlightMs <= policy.toolGraceMs) {
			return { verdict: "healthy", signal: "tool-in-flight", reason: `${observation.inFlight.tool} running for ${minutes(inFlightMs)} min` };
		}
		return { verdict: "stalled", signal: "tool-overrun", reason: `${observation.inFlight.tool} in flight for ${minutes(inFlightMs)} min` };
	}

	const lastActivity = observation.lastActivityAtMs ?? observation.startedAtMs;
	const lastProgress = Math.max(lastActivity, observation.lastCommitAtMs ?? Number.NEGATIVE_INFINITY);
	const silentMs = observation.nowMs - lastProgress;
	if (silentMs > policy.stallAfterMs) {
		return { verdict: "stalled", signal: "no-progress", reason: `no new activity or commits for ${minutes(silentMs)} min` };
	}

	return { verdict: "healthy", signal: "active", reason: "recent activity" };
}
