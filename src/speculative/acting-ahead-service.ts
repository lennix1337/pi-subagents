/**
 * Composition of acting ahead with PR thread subscriptions. A CI failure on an
 * admitted PR starts one speculative child; that child subscribes to the PR's
 * events, so later CI results reach it instead of the parent. The launcher is
 * injected: the caller decides how a background child starts in its own worktree.
 */
import { execFile } from "node:child_process";
import { requestAsyncStop } from "../runs/background/control-channel.ts";
import { PR_WATCH_EVENT_CHANNEL, PrThreadRegistry, bindPrWatchEvents, parsePrWatchEvent, steerChildWithPrEvent, type PrThreadSubscription, type PrWatchEventBus, type PrWatchBinding, type PrWatchEvent } from "../integrations/pr-thread-subscriptions.ts";
import { ActingAhead, type ActingAheadDeps, type SpeculativeRun, type SpeculativeTask } from "./acting-ahead.ts";
import type { ActingAheadConfig, ActingAheadDecision } from "./acting-ahead-policy.ts";
import { confirmRedGreen, type SpeculativeEvidence, type SpeculativeGit, type SpeculativeTests, type SpeculativeVerdict } from "./acting-ahead-verify.ts";

export interface ActingAheadServiceInput {
	config: ActingAheadConfig;
	bus?: PrWatchEventBus;
	launch(task: SpeculativeTask): Promise<SpeculativeRun>;
	report(message: string): void;
	onError(error: unknown, context: string): void;
	now?: () => number;
	/** Defaults to the git and test executors below; tests inject their own. */
	verify?: (evidence: SpeculativeEvidence) => Promise<SpeculativeVerdict>;
	/** Defaults to a steer into the owning child's inbox. */
	steerChild?: (subscription: PrThreadSubscription, event: PrWatchEvent) => void;
}

export interface ActingAheadService {
	acting: ActingAhead;
	registry: PrThreadRegistry;
	/** Routes one watcher event; used directly by callers that do not bind the bus. */
	handle(event: PrWatchEvent): Promise<ActingAheadDecision>;
	dispose(): void;
}

function runArgv(cwd: string, argv: string[], timeoutMs: number): Promise<{ exitCode: number }> {
	return new Promise((resolve, reject) => {
		execFile(argv[0]!, argv.slice(1), { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error) => {
			if (!error) resolve({ exitCode: 0 });
			else if (typeof (error as NodeJS.ErrnoException).code === "number") resolve({ exitCode: (error as NodeJS.ErrnoException).code as unknown as number });
			else reject(error);
		});
	});
}

/** Real executors: argv without a shell, so the operator's configured command cannot be re-quoted by a child. */
const TEST_TIMEOUT_MS = 15 * 60_000;
export const defaultSpeculativeGit: SpeculativeGit = {
	run: (cwd, args) => new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
			if (!error) resolve({ exitCode: 0, stdout });
			else if (typeof (error as NodeJS.ErrnoException).code === "number") resolve({ exitCode: (error as NodeJS.ErrnoException).code as unknown as number, stdout: "" });
			else reject(error);
		});
	}),
};
export const defaultSpeculativeTests: SpeculativeTests = {
	run: (cwd, argv) => runArgv(cwd, argv, TEST_TIMEOUT_MS),
};

/** Starts acting ahead: admission on CI failures, a steer to the owning child on later events for its PR. */
export function startActingAhead(input: ActingAheadServiceInput): ActingAheadService {
	const registry = new PrThreadRegistry();
	const steerChild = input.steerChild ?? steerChildWithPrEvent;
	const verify = input.verify ?? ((evidence) => confirmRedGreen(evidence, { git: defaultSpeculativeGit, tests: defaultSpeculativeTests }));
	const deps: ActingAheadDeps = {
		now: input.now ?? Date.now,
		launch: input.launch,
		stop: (run, reason) => {
			requestAsyncStop(run.asyncDir, { source: "acting-ahead", targetIndex: run.stepIndex, reason });
		},
		subscribe: (run, target) => {
			registry.subscribe({ ownerRunId: run.runId, asyncDir: run.asyncDir, stepIndex: run.stepIndex, repo: target.repo, pr: target.pr, ...(target.branch ? { branch: target.branch } : {}) });
		},
		unsubscribe: (run) => {
			registry.unsubscribeRun(run.runId);
		},
		verify,
		report: input.report,
		// unref: a pending cap must not keep the parent process alive.
		setTimer: (fire, ms) => {
			const handle = setTimeout(fire, ms);
			handle.unref();
			return handle;
		},
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		onError: input.onError,
	};
	const acting = new ActingAhead(deps, input.config);
	const routing: PrWatchBinding = bindPrWatchEvents(input.bus, registry, {
		deliverToChild: (subscription, event) => steerChild(subscription, event),
		deliverToParent: () => {},
		onError: (error) => input.onError(error, "PR thread routing"),
	});
	const admission = input.bus && typeof input.bus.on === "function"
		? input.bus.on(PR_WATCH_EVENT_CHANNEL, (payload) => {
			const event = parsePrWatchEvent(payload);
			if (event?.kind === "ci-failed") void acting.handleEvent(event).catch((error: unknown) => input.onError(error, "acting ahead admission"));
		})
		: undefined;
	return {
		acting,
		registry,
		handle: (event) => acting.handleEvent(event),
		dispose: () => {
			routing.dispose();
			if (typeof admission === "function") (admission as () => void)();
		},
	};
}
