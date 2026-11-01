import type { AsyncStatus } from "../../shared/types.ts";

/**
 * The two questions readers ask about an async run's `state`, answered once.
 *
 * Run lifecycle (written to status.json by the runner and, for dead runners, by stale-run
 * reconciliation):
 *
 *   queued -> running -> complete | failed | partial | stopped | rejected   (final)
 *                     -> paused                                            (settled, resumable)
 *
 * `paused` is an interrupted run waiting for an explicit next action: its runner has stopped, but the
 * run can continue. Every other non-active state is final.
 */
type AsyncRunState = AsyncStatus["state"];
export type SettledAsyncRunState = Exclude<AsyncRunState, "queued" | "running">;
export type FinalAsyncRunState = Exclude<SettledAsyncRunState, "paused">;

const FINAL_STATES: ReadonlySet<string> = new Set<FinalAsyncRunState>(["complete", "failed", "partial", "stopped", "rejected"]);

/** The runner is no longer executing this run. A persisted value that is not a run state is not settled. */
export function isSettledAsyncRunState(state: string | undefined): state is SettledAsyncRunState {
	return state === "paused" || (state !== undefined && FINAL_STATES.has(state));
}

/** The run ended and cannot continue (settled, and not the resumable `paused`). */
export function isFinalAsyncRunState(state: string | undefined): state is FinalAsyncRunState {
	return state !== undefined && FINAL_STATES.has(state);
}
