/**
 * Consumer side of PR thread subscriptions.
 *
 * A child that owns a PR or branch subscribes to its events, so CI and conflict
 * notices reach that child instead of the parent. The watcher (pi-gitwatch) is
 * not required: without an event bus or a publisher, nothing is routed and the
 * parent keeps today's behaviour. Events are validated at this boundary; a
 * malformed payload is reported, never routed.
 */
import { requestAsyncSteer } from "../runs/background/control-channel.ts";

/** Pi event-bus channel the watcher publishes PR events on. */
export const PR_WATCH_EVENT_CHANNEL = "gitwatch.pr-event";

export const PR_WATCH_EVENT_KINDS = ["ci-passed", "ci-failed", "conflict", "ready", "review", "merged", "closed"] as const;
export type PrWatchEventKind = typeof PR_WATCH_EVENT_KINDS[number];

/** A finished PR ends its subscriptions; the parent hears about it once more. */
const TERMINAL_KINDS: ReadonlySet<PrWatchEventKind> = new Set<PrWatchEventKind>(["merged", "closed"]);

export interface PrWatchEvent {
	kind: PrWatchEventKind;
	/** `owner/name`, as the watcher names the repository. */
	repo: string;
	pr?: number;
	branch?: string;
	ts: number;
	detail?: string;
}

export interface PrThreadSubscription {
	ownerRunId: string;
	asyncDir: string;
	stepIndex: number;
	repo: string;
	pr?: number;
	branch?: string;
}

export interface PrThreadRoute {
	/** Subscriptions that received the event. */
	children: PrThreadSubscription[];
	/** True when the parent should hear about it: no child owns it, or the PR finished. */
	parent: boolean;
}

export interface PrThreadDispatch {
	deliverToChild(subscription: PrThreadSubscription, event: PrWatchEvent): void;
	deliverToParent(event: PrWatchEvent): void;
	onError(error: unknown, subscription?: PrThreadSubscription): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Boundary check for a bus payload. Returns undefined for anything that is not a complete, known event. */
export function parsePrWatchEvent(raw: unknown): PrWatchEvent | undefined {
	if (!isRecord(raw)) return undefined;
	const kind = raw.kind;
	if (typeof kind !== "string" || !(PR_WATCH_EVENT_KINDS as readonly string[]).includes(kind)) return undefined;
	if (typeof raw.repo !== "string" || !raw.repo.trim()) return undefined;
	if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return undefined;
	if (raw.pr !== undefined && (!Number.isInteger(raw.pr) || (raw.pr as number) < 1)) return undefined;
	if (raw.branch !== undefined && (typeof raw.branch !== "string" || !raw.branch.trim())) return undefined;
	if (raw.detail !== undefined && typeof raw.detail !== "string") return undefined;
	return {
		kind: kind as PrWatchEventKind,
		repo: raw.repo.trim(),
		ts: raw.ts,
		...(raw.pr !== undefined ? { pr: raw.pr as number } : {}),
		...(raw.branch !== undefined ? { branch: (raw.branch as string).trim() } : {}),
		...(raw.detail !== undefined ? { detail: raw.detail as string } : {}),
	};
}

/** One line for the child's inbox. */
export function formatPrWatchEvent(event: PrWatchEvent): string {
	const target = event.pr !== undefined ? `${event.repo}#${event.pr}` : `${event.repo} ${event.branch ?? ""}`.trim();
	return `PR ${target} ${event.kind}${event.detail ? `: ${event.detail}` : ""}`;
}

function sameRepo(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function matches(subscription: PrThreadSubscription, event: PrWatchEvent): boolean {
	if (!sameRepo(subscription.repo, event.repo)) return false;
	if (subscription.pr !== undefined && event.pr === subscription.pr) return true;
	return subscription.branch !== undefined && event.branch === subscription.branch;
}

function keyOf(subscription: PrThreadSubscription): string {
	return [subscription.ownerRunId, subscription.stepIndex, subscription.repo.toLowerCase(), subscription.pr ?? "", subscription.branch ?? ""].join("#");
}

export class PrThreadRegistry {
	private readonly subscriptions = new Map<string, PrThreadSubscription>();

	subscribe(subscription: PrThreadSubscription): void {
		if (!subscription.repo.trim()) throw new Error("A PR thread subscription needs a repo.");
		if (subscription.pr === undefined && subscription.branch === undefined) throw new Error("A PR thread subscription needs a pr or branch.");
		this.subscriptions.set(keyOf(subscription), { ...subscription });
	}

	/** Drops every subscription of an owner that has finished; returns how many were removed. */
	unsubscribeRun(ownerRunId: string): number {
		let removed = 0;
		for (const [key, subscription] of this.subscriptions) {
			if (subscription.ownerRunId !== ownerRunId) continue;
			this.subscriptions.delete(key);
			removed++;
		}
		return removed;
	}

	snapshot(): PrThreadSubscription[] {
		return [...this.subscriptions.values()];
	}

	/** Delivers to each matching child; a child that cannot take the event falls back to the parent. */
	route(event: PrWatchEvent, dispatch: PrThreadDispatch): PrThreadRoute {
		const children = this.snapshot().filter((subscription) => matches(subscription, event));
		let deliveredToChild = false;
		for (const subscription of children) {
			try {
				dispatch.deliverToChild(subscription, event);
				deliveredToChild = true;
			} catch (error) {
				dispatch.onError(error, subscription);
			}
		}
		const terminal = TERMINAL_KINDS.has(event.kind);
		if (terminal) for (const subscription of children) this.subscriptions.delete(keyOf(subscription));
		const parent = !deliveredToChild || terminal;
		if (parent) dispatch.deliverToParent(event);
		return { children, parent };
	}
}

export interface PrWatchEventBus {
	on(channel: string, handler: (payload: unknown) => void): unknown;
}

export interface PrWatchBinding {
	dispose(): void;
}

/**
 * Listens for watcher events on the bus. Without a bus (or without `on`), it
 * returns an inert binding and routes nothing.
 */
export function bindPrWatchEvents(bus: PrWatchEventBus | undefined, registry: PrThreadRegistry, dispatch: PrThreadDispatch): PrWatchBinding {
	if (!bus || typeof bus.on !== "function") return { dispose: () => {} };
	const unsubscribe = bus.on(PR_WATCH_EVENT_CHANNEL, (payload) => {
		const event = parsePrWatchEvent(payload);
		if (!event) {
			dispatch.onError(new Error(`Malformed ${PR_WATCH_EVENT_CHANNEL} payload was not routed.`));
			return;
		}
		registry.route(event, dispatch);
	});
	return {
		dispose: () => {
			if (typeof unsubscribe === "function") (unsubscribe as () => void)();
		},
	};
}

/** Production delivery: a steer request into the owning child's inbox, followed up after its current turn. */
export function steerChildWithPrEvent(subscription: PrThreadSubscription, event: PrWatchEvent): void {
	requestAsyncSteer(subscription.asyncDir, {
		message: formatPrWatchEvent(event),
		mode: "follow_up",
		targetIndex: subscription.stepIndex,
		source: "pr-thread",
	});
}
