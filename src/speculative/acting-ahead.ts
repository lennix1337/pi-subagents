/**
 * Acting ahead lifecycle: admits a CI failure, reserves a slot synchronously,
 * launches one background child in its own worktree, and caps its runtime. When
 * the child finishes, the harness confirms the fix itself. Only a confirmed fix
 * is reported; everything else is discarded silently and kept as a counter for the
 * caller, so a speculative attempt never shows up as an operator notice.
 *
 * Launching, stopping and subscribing are injected, so the lifecycle is testable
 * without a live runner. The slot is held through verification, and the runtime cap
 * covers it too.
 */
import type { PrWatchEvent } from "../integrations/pr-thread-subscriptions.ts";
import { admitSpeculation, speculationKey, type ActingAheadConfig, type ActingAheadDecision, type ActingAheadState } from "./acting-ahead-policy.ts";
import type { SpeculativeEvidence, SpeculativeVerdict } from "./acting-ahead-verify.ts";

export interface SpeculativeTask {
	repo: string;
	pr: number;
	branch?: string;
	testCommand: string[];
	prompt: string;
}

export interface SpeculativeOutcome {
	ok: boolean;
	evidence?: { worktreePath: string; baseRef: string; fixFiles: string[]; testFiles: string[] };
}

export interface SpeculativeRun {
	runId: string;
	asyncDir: string;
	stepIndex: number;
	finished: Promise<SpeculativeOutcome>;
}

export interface SpeculativeDiscard {
	repo: string;
	pr: number;
	reason: string;
	atMs: number;
}

export interface ActingAheadDeps {
	now(): number;
	launch(task: SpeculativeTask): Promise<SpeculativeRun>;
	stop(run: SpeculativeRun, reason: string): void;
	subscribe(run: SpeculativeRun, target: { repo: string; pr: number; branch?: string }): void;
	unsubscribe(run: SpeculativeRun): void;
	verify(evidence: SpeculativeEvidence): Promise<SpeculativeVerdict>;
	report(message: string): void;
	setTimer(fire: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	onError(error: unknown, context: string): void;
}

interface ActiveSpeculation {
	repo: string;
	pr: number;
	branch?: string;
	run?: SpeculativeRun;
	timer?: unknown;
}

const DISCARD_HISTORY_LIMIT = 50;

export function buildSpeculativePrompt(task: { repo: string; pr: number; branch?: string; testCommand: string[] }): string {
	return [
		`Speculative attempt on ${task.repo}#${task.pr}${task.branch ? ` (branch ${task.branch})` : ""}: its CI failed.`,
		`1. Reproduce the failure with: ${task.testCommand.join(" ")}`,
		"2. Add a failing regression test that reproduces it, then the smallest fix. Commit both in your worktree; do not push.",
		"3. Stop when the tests pass with the fix. Report the base commit, the fix files and the test files.",
		"The harness reruns the tests itself and reverts the fix to confirm it; a fix it cannot confirm is discarded silently.",
	].join("\n");
}

export class ActingAhead {
	private readonly deps: ActingAheadDeps;
	private readonly config: ActingAheadConfig;
	private readonly active = new Map<string, ActiveSpeculation>();
	private readonly lastAttemptAt = new Map<string, number>();
	private readonly discarded: SpeculativeDiscard[] = [];
	private confirmed = 0;

	constructor(deps: ActingAheadDeps, config: ActingAheadConfig) {
		this.deps = deps;
		this.config = config;
	}

	/** Admits or refuses a watcher event. A refusal is returned to the caller and never reported. */
	async handleEvent(event: PrWatchEvent): Promise<ActingAheadDecision> {
		if (event.pr === undefined) return { admit: false, reason: "a speculation needs a PR number" };
		const now = this.deps.now();
		const state: ActingAheadState = {
			active: [...this.active.values()].map((entry) => ({ repo: entry.repo, pr: entry.pr })),
			lastAttemptAt: this.lastAttemptAt,
		};
		const decision = admitSpeculation({ event, config: this.config, state, now });
		if (!decision.admit) return decision;

		const key = speculationKey(event.repo, event.pr);
		const entry: ActiveSpeculation = { repo: event.repo, pr: event.pr, ...(event.branch ? { branch: event.branch } : {}) };
		this.active.set(key, entry);
		this.lastAttemptAt.set(key, now);
		const task: SpeculativeTask = {
			repo: event.repo,
			pr: event.pr,
			...(event.branch ? { branch: event.branch } : {}),
			testCommand: decision.testCommand,
			prompt: buildSpeculativePrompt({ repo: event.repo, pr: event.pr, ...(event.branch ? { branch: event.branch } : {}), testCommand: decision.testCommand }),
		};
		try {
			const run = await this.deps.launch(task);
			entry.run = run;
			this.deps.subscribe(run, { repo: event.repo, pr: event.pr, ...(event.branch ? { branch: event.branch } : {}) });
			entry.timer = this.deps.setTimer(() => this.capRuntime(key, entry), this.config.maxRuntimeMs);
			run.finished
				.then(
					(outcome) => this.settle(key, entry, outcome, decision.testCommand),
					(error: unknown) => {
						this.deps.onError(error, "speculative run");
						if (this.active.get(key) === entry) this.finish(key, entry, "child finished without evidence");
					},
				)
				.catch((error: unknown) => this.deps.onError(error, "speculative settle"));
		} catch (error) {
			this.deps.onError(error, "speculative launch");
			this.finish(key, entry, "launch failed");
			return { admit: false, reason: "launch failed" };
		}
		return decision;
	}

	snapshot(): { active: number; confirmed: number; discarded: SpeculativeDiscard[] } {
		return { active: this.active.size, confirmed: this.confirmed, discarded: [...this.discarded] };
	}

	private capRuntime(key: string, entry: ActiveSpeculation): void {
		if (this.active.get(key) !== entry) return;
		if (entry.run) this.deps.stop(entry.run, "acting-ahead runtime cap reached");
		this.finish(key, entry, "runtime cap reached");
	}

	private async settle(key: string, entry: ActiveSpeculation, outcome: SpeculativeOutcome, testCommand: string[]): Promise<void> {
		if (this.active.get(key) !== entry) return;
		if (!outcome.ok || !outcome.evidence) {
			this.finish(key, entry, "child finished without evidence");
			return;
		}
		let verdict: SpeculativeVerdict;
		try {
			verdict = await this.deps.verify({ ...outcome.evidence, testCommand });
		} catch (error) {
			this.deps.onError(error, "speculative verification");
			if (this.active.get(key) === entry) this.finish(key, entry, "verification failed");
			return;
		}
		if (this.active.get(key) !== entry) return;
		if (!verdict.confirmed) {
			this.finish(key, entry, verdict.reason);
			return;
		}
		this.confirmed++;
		const branch = entry.branch ? ` on branch ${entry.branch}` : "";
		this.deps.report(`Acting ahead: fix for ${entry.repo}#${entry.pr} confirmed (red without it, green with it)${branch}. Worktree: ${outcome.evidence.worktreePath}`);
		this.finish(key, entry);
	}

	/** Releases the slot, the timer and the PR subscription; a discard reason is kept, never announced. */
	private finish(key: string, entry: ActiveSpeculation, discardReason?: string): void {
		if (entry.timer !== undefined) this.deps.clearTimer(entry.timer);
		if (entry.run) this.deps.unsubscribe(entry.run);
		this.active.delete(key);
		if (discardReason) {
			this.discarded.push({ repo: entry.repo, pr: entry.pr, reason: discardReason, atMs: this.deps.now() });
			if (this.discarded.length > DISCARD_HISTORY_LIMIT) this.discarded.shift();
		}
	}
}
