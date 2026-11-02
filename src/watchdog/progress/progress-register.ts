import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { resolveWatchdogConfig } from "../settings.ts";
import { createProgressSupervisor } from "./progress-runtime.ts";
import type { ProgressSupervisor } from "./progress-supervisor.ts";

export const PROGRESS_NOTICE_TYPE = "subagent_progress_notice";

export interface RegisterProgressWatchdogOptions {
	/** Read at each session start, because the run directory can be replaced by `ensureAccessibleDir`. */
	getAsyncDirRoot: () => string;
}

/**
 * Starts the progress sweep at session start when `subagents.watchdog.progress.enabled`
 * is true. The sweep is scoped to this session's runs; without a session id it does not
 * start, because an unscoped listing would reach other sessions' children.
 */
export function registerProgressWatchdog(pi: ExtensionAPI, options: RegisterProgressWatchdogOptions): { dispose(): void } {
	let supervisor: ProgressSupervisor | undefined;
	const stop = (): void => {
		supervisor?.dispose();
		supervisor = undefined;
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		stop();
		const resolved = resolveWatchdogConfig(ctx.cwd, { projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined });
		for (const error of resolved.errors) console.error(`Watchdog settings error (${error.scope}): ${error.message}`);
		const progress = resolved.config.progress;
		if (!progress.enabled) return;
		let sessionId: string;
		try {
			sessionId = resolveCurrentSessionId(ctx.sessionManager);
		} catch (error) {
			console.error("Progress watchdog not started: the session id is unavailable.", error);
			return;
		}
		supervisor = createProgressSupervisor({
			config: progress,
			asyncDirRoot: options.getAsyncDirRoot(),
			sessionId,
			sendNotice: (content) => pi.sendMessage({ customType: PROGRESS_NOTICE_TYPE, content, display: true }),
		});
		supervisor.start(progress.intervalMs);
	});

	pi.on("session_shutdown", () => stop());
	return { dispose: stop };
}
