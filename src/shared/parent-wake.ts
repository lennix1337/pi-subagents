import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Ends a waking notice that reports results. */
export const COMPLETION_ACTION = "Read the saved results above and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
/** Ends a waking notice that reports a problem or a run state rather than results. */
export const STATUS_ACTION = "Check the run status and details above, then resume the already-authorized parent task or report the problem. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";

// external: Pi persists waking notices only when their run reaches message_end.
const WAKE_PENDING_MS = 10_000;

// external: pi-intercom keeps an idle wake in preflight until agent_start.
type WakeReservation = { sessionId: string; sentAt?: number };
const reservationsSymbol = Symbol.for("pi.idle-wake.v1");
const wakeGlobal = globalThis as typeof globalThis & { [reservationsSymbol]?: WeakMap<object, WakeReservation> };
const reservations = wakeGlobal[reservationsSymbol] ?? (wakeGlobal[reservationsSymbol] = new WeakMap<object, WakeReservation>());

export interface ParentWake {
	/**
	 * pi.sendMessage that shares the idle-wake reservation. A turn-triggering message to an idle
	 * parent starts the run itself: Pi runs before_agent_start for it and emits its message_start.
	 * Returns true when the message was only appended (held, or another wake is already starting
	 * the run): Pi emits no extension message_start for it.
	 * After userAborted() and until the next run starts, a turn-triggering message is only appended.
	 */
	sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): boolean;
	/** True from an idle wake until its run starts or the session shuts down. Past the deadline it holds only while the parent is busy, which may still be the wake's preflight (for example compacting). */
	isPending(): boolean;
	bindSession(ctx: Pick<ExtensionContext, "isIdle" | "sessionManager">): void;
	agentStarted(): void;
	/** The user stopped the parent run: hold wakes until the next run starts. */
	userAborted(): void;
	/** A deliberate resume (manual compaction) drops the hold without touching the shared wake reservation. */
	releaseHold(): void;
	isHeld(): boolean;
	sessionShutdown(reason: string | undefined): void;
}

export function createParentWake(pi: Pick<ExtensionAPI, "sendMessage">, now: () => number = Date.now): ParentWake {
	// external: Pi context access throws when the context is stale.
	let ctx!: Pick<ExtensionContext, "isIdle">;
	let session: { manager: object; id: string } | undefined;
	let held = false;
	const reservation = (): WakeReservation => {
		if (!session) return { sessionId: "" };
		const current = reservations.get(session.manager);
		if (current?.sessionId === session.id) return current;
		const next = { sessionId: session.id };
		reservations.set(session.manager, next);
		return next;
	};
	const reserved = () => {
		const { sentAt } = reservation();
		return sentAt !== undefined && now() - sentAt < WAKE_PENDING_MS;
	};
	return {
		sendMessage(message, options) {
			if (options?.triggerTurn !== true) {
				pi.sendMessage(message, options);
				return false;
			}
			if (held || (ctx.isIdle() && reserved())) {
				// external: Pi emits no extension message_start for an appended notice.
				pi.sendMessage(message, { triggerTurn: false });
				return true;
			}
			if (ctx.isIdle()) reservation().sentAt = now();
			pi.sendMessage(message, options);
			return false;
		},
		isPending: () => reservation().sentAt !== undefined && (reserved() || !ctx.isIdle()),
		bindSession(context) {
			ctx = context;
			session = { manager: context.sessionManager, id: context.sessionManager.getSessionId() };
			held = false;
		},
		agentStarted() {
			reservation().sentAt = undefined;
			held = false;
		},
		userAborted: () => { held = true; },
		releaseHold: () => { held = false; },
		isHeld: () => held,
		sessionShutdown(reason) {
			if (reason !== "reload") reservation().sentAt = undefined;
		},
	};
}
