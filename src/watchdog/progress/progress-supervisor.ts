/**
 * Scheduled progress supervisor for running async children.
 *
 * Each sweep lists the running children, classifies them with the deterministic
 * rules, and acts only as configured: report (default), nudge with a steer
 * message, or stop the child. It never retries or relaunches work, and it does
 * not call a model. Git is probed only for children that have been silent past
 * the stall window, so a healthy sweep costs no process spawn.
 */
import { classifyProgress, type ProgressAssessment, type ProgressPolicy, type ProgressSignal, type ProgressToolCall, type ProgressVerdict } from "./progress-signals.ts";

export type ProgressActionMode = "report" | "nudge" | "stop";
export type ProgressAction = "none" | "nudged" | "stopped";
export type ProgressProblemVerdict = Exclude<ProgressVerdict, "healthy">;

export interface ProgressRunSnapshot {
	runId: string;
	agent: string;
	asyncDir: string;
	stepIndex: number;
	worktreePath?: string;
	startedAtMs: number;
	lastActivityAtMs?: number;
	recentTools: readonly ProgressToolCall[];
	inFlight?: { tool: string; startedAtMs: number };
	runnerAlive: boolean | undefined;
}

export interface ProgressNotice {
	runId: string;
	agent: string;
	verdict: ProgressProblemVerdict;
	signal: ProgressSignal;
	reason: string;
	action: ProgressAction;
}

export interface ProgressSupervisorDeps {
	now(): number;
	listRuns(): readonly ProgressRunSnapshot[];
	readHead(worktreePath: string): Promise<string | undefined>;
	steer(run: ProgressRunSnapshot, message: string): void;
	stop(run: ProgressRunSnapshot, reason: string): void;
	notify(notice: ProgressNotice): void;
	onError(error: unknown, runId?: string): void;
}

export interface ProgressSupervisorOptions {
	policy: ProgressPolicy;
	/** Action per problem verdict. `dead` is never acted on: the stale-run reconciler owns repair. */
	actions: Record<"stalled" | "looping", ProgressActionMode>;
	maxNudges: number;
	nudgeCooldownMs: number;
	renotifyAfterMs: number;
}

export interface ProgressTimers {
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
}

interface RunMemory {
	head?: string;
	lastCommitAtMs?: number;
	nudges: number;
	lastNudgeAtMs?: number;
	stopped: boolean;
	noticeKey?: string;
	noticeAtMs?: number;
}

function nudgeMessage(assessment: ProgressAssessment): string {
	return `Progress watchdog: ${assessment.reason}. Reply with the blocker in one short line, or change approach; do not repeat the same call.`;
}

export class ProgressSupervisor {
	private readonly deps: ProgressSupervisorDeps;
	private readonly options: ProgressSupervisorOptions;
	private readonly memory = new Map<string, RunMemory>();
	private sweeping = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private timers: ProgressTimers | undefined;

	constructor(deps: ProgressSupervisorDeps, options: ProgressSupervisorOptions) {
		this.deps = deps;
		this.options = options;
	}

	/** Starts the schedule once; an unref'd timer never keeps the process alive. */
	start(intervalMs: number, timers: ProgressTimers = { setInterval, clearInterval }): boolean {
		if (this.timer !== undefined) return false;
		this.timers = timers;
		const handle = timers.setInterval(() => { void this.sweep(); }, intervalMs);
		(handle as { unref?: () => unknown }).unref?.();
		this.timer = handle;
		return true;
	}

	dispose(): void {
		if (this.timer === undefined) return;
		this.timers?.clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One sweep. Overlapping calls return at once; a sweep never rejects. */
	async sweep(): Promise<void> {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			await this.runSweep();
		} finally {
			this.sweeping = false;
		}
	}

	private async runSweep(): Promise<void> {
		let runs: readonly ProgressRunSnapshot[];
		try {
			runs = this.deps.listRuns();
		} catch (error) {
			this.deps.onError(error);
			return;
		}
		const now = this.deps.now();
		await this.probeCommits(runs, now);
		const seen = new Set<string>();
		for (const run of runs) {
			seen.add(run.runId);
			try {
				this.superviseRun(run, now);
			} catch (error) {
				this.deps.onError(error, run.runId);
			}
		}
		for (const runId of this.memory.keys()) if (!seen.has(runId)) this.memory.delete(runId);
	}

	private memoFor(runId: string): RunMemory {
		let memo = this.memory.get(runId);
		if (!memo) {
			memo = { nudges: 0, stopped: false };
			this.memory.set(runId, memo);
		}
		return memo;
	}

	private isSilent(run: ProgressRunSnapshot, now: number): boolean {
		return now - (run.lastActivityAtMs ?? run.startedAtMs) > this.options.policy.stallAfterMs;
	}

	/** Probes HEAD only for silent children, in parallel; a moved HEAD is commit progress. */
	private async probeCommits(runs: readonly ProgressRunSnapshot[], now: number): Promise<void> {
		const silent = runs.filter((run) => run.worktreePath !== undefined && run.runnerAlive !== false && this.isSilent(run, now));
		await Promise.all(silent.map(async (run) => {
			let head: string | undefined;
			try {
				head = await this.deps.readHead(run.worktreePath!);
			} catch (error) {
				this.deps.onError(error, run.runId);
				return;
			}
			if (head === undefined) return;
			const memo = this.memoFor(run.runId);
			if (memo.head !== undefined && head !== memo.head) memo.lastCommitAtMs = now;
			memo.head = head;
		}));
	}

	private superviseRun(run: ProgressRunSnapshot, now: number): void {
		const memo = this.memoFor(run.runId);
		const assessment = classifyProgress({
			nowMs: now,
			startedAtMs: run.startedAtMs,
			...(run.lastActivityAtMs !== undefined ? { lastActivityAtMs: run.lastActivityAtMs } : {}),
			...(memo.lastCommitAtMs !== undefined ? { lastCommitAtMs: memo.lastCommitAtMs } : {}),
			recentTools: run.recentTools,
			...(run.inFlight ? { inFlight: run.inFlight } : {}),
			runnerAlive: run.runnerAlive,
		}, this.options.policy);
		const action = assessment.verdict === "stalled" || assessment.verdict === "looping"
			? this.takeAction(run, memo, assessment, now)
			: "none";
		this.noticeIfNew(run, memo, assessment, action, now);
	}

	private takeAction(run: ProgressRunSnapshot, memo: RunMemory, assessment: ProgressAssessment, now: number): ProgressAction {
		const mode = this.options.actions[assessment.verdict as "stalled" | "looping"];
		try {
			if (mode === "stop") {
				if (memo.stopped) return "none";
				this.deps.stop(run, assessment.reason);
				memo.stopped = true;
				return "stopped";
			}
			const cooledDown = memo.lastNudgeAtMs === undefined || now - memo.lastNudgeAtMs >= this.options.nudgeCooldownMs;
			if (mode === "nudge" && memo.nudges < this.options.maxNudges && cooledDown) {
				this.deps.steer(run, nudgeMessage(assessment));
				memo.nudges++;
				memo.lastNudgeAtMs = now;
				return "nudged";
			}
		} catch (error) {
			this.deps.onError(error, run.runId);
		}
		return "none";
	}

	/** One notice per verdict and signal; a healthy sweep clears it so the next episode is reported. */
	private noticeIfNew(run: ProgressRunSnapshot, memo: RunMemory, assessment: ProgressAssessment, action: ProgressAction, now: number): void {
		if (assessment.verdict === "healthy") {
			memo.noticeKey = undefined;
			return;
		}
		const key = `${assessment.verdict}:${assessment.signal}`;
		const sameEpisode = memo.noticeKey === key && memo.noticeAtMs !== undefined && now - memo.noticeAtMs < this.options.renotifyAfterMs;
		if (sameEpisode) return;
		memo.noticeKey = key;
		memo.noticeAtMs = now;
		try {
			this.deps.notify({
				runId: run.runId,
				agent: run.agent,
				verdict: assessment.verdict as ProgressProblemVerdict,
				signal: assessment.signal,
				reason: assessment.reason,
				action,
			});
		} catch (error) {
			this.deps.onError(error, run.runId);
		}
	}
}
