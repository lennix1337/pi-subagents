import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PR_WATCH_EVENT_CHANNEL, PrThreadRegistry, bindPrWatchEvents, formatPrWatchEvent, parsePrWatchEvent, type PrThreadDispatch, type PrWatchEvent } from "../../src/integrations/pr-thread-subscriptions.ts";

const OWNER = "run-owner-1";

function event(overrides: Partial<PrWatchEvent> = {}): PrWatchEvent {
	return { kind: "ci-failed", repo: "lennix1337/pi-subagents", pr: 5, branch: "feat/x", ts: 1, detail: "calendar-timezones", ...overrides };
}

function subscription(overrides: Partial<Parameters<PrThreadRegistry["subscribe"]>[0]> = {}) {
	return { ownerRunId: OWNER, asyncDir: "C:/tmp/async/owner", stepIndex: 0, repo: "lennix1337/pi-subagents", pr: 5, ...overrides };
}

function dispatchRecorder(options: { failChild?: boolean } = {}) {
	const toChild: Array<{ runId: string; text: string }> = [];
	const toParent: PrWatchEvent[] = [];
	const errors: unknown[] = [];
	const dispatch: PrThreadDispatch = {
		deliverToChild: (sub, pr) => {
			if (options.failChild) throw new Error("child inbox closed");
			toChild.push({ runId: sub.ownerRunId, text: formatPrWatchEvent(pr) });
		},
		deliverToParent: (pr) => { toParent.push(pr); },
		onError: (error) => { errors.push(error); },
	};
	return { dispatch, toChild, toParent, errors };
}

describe("PR thread subscriptions", () => {
	it("routes a PR's CI failure to the child that owns it, not to the parent", () => {
		const registry = new PrThreadRegistry();
		registry.subscribe(subscription());
		const { dispatch, toChild, toParent } = dispatchRecorder();
		const route = registry.route(event(), dispatch);
		assert.equal(route.parent, false);
		assert.equal(route.children.length, 1);
		assert.deepEqual(toChild.map((entry) => entry.runId), [OWNER]);
		assert.equal(toChild[0]!.text, "PR lennix1337/pi-subagents#5 ci-failed: calendar-timezones");
		assert.deepEqual(toParent, []);
	});

	it("sends events for other PRs to the parent, as before", () => {
		const registry = new PrThreadRegistry();
		registry.subscribe(subscription({ pr: 5 }));
		const { dispatch, toChild, toParent } = dispatchRecorder();
		const route = registry.route(event({ pr: 6 }), dispatch);
		assert.equal(route.parent, true);
		assert.equal(route.children.length, 0);
		assert.equal(toChild.length, 0);
		assert.equal(toParent.length, 1);
	});

	it("matches a branch subscription and compares repositories case-insensitively", () => {
		const registry = new PrThreadRegistry();
		registry.subscribe(subscription({ pr: undefined, branch: "feat/x", repo: "Lennix1337/PI-Subagents" }));
		const { dispatch, toChild } = dispatchRecorder();
		assert.equal(registry.route(event({ pr: undefined, branch: "feat/x" }), dispatch).children.length, 1);
		assert.equal(registry.route(event({ pr: undefined, branch: "feat/other" }), dispatch).parent, true);
		assert.equal(toChild.length, 1);
	});

	it("releases the subscription on merge or close, after notifying both the child and the parent", () => {
		const registry = new PrThreadRegistry();
		registry.subscribe(subscription());
		const { dispatch, toChild, toParent } = dispatchRecorder();
		const route = registry.route(event({ kind: "merged" }), dispatch);
		assert.equal(route.children.length, 1);
		assert.equal(route.parent, true, "a finished PR is also reported to the parent");
		assert.equal(toChild.length, 1);
		assert.equal(toParent.length, 1);
		assert.equal(registry.snapshot().length, 0);
		assert.equal(registry.route(event(), dispatch).parent, true, "no subscription after the terminal event");
	});

	it("drops every subscription of a finished owner at once", () => {
		const registry = new PrThreadRegistry();
		registry.subscribe(subscription({ pr: 5 }));
		registry.subscribe(subscription({ pr: 7 }));
		registry.subscribe(subscription({ ownerRunId: "other", pr: 5 }));
		assert.equal(registry.unsubscribeRun(OWNER), 2);
		assert.deepEqual(registry.snapshot().map((sub) => sub.ownerRunId), ["other"]);
	});

	it("refuses a subscription that names neither a PR nor a branch, or a missing repository", () => {
		const registry = new PrThreadRegistry();
		assert.throws(() => registry.subscribe(subscription({ pr: undefined, branch: undefined })), /pr or branch/);
		assert.throws(() => registry.subscribe(subscription({ repo: "  " })), /repo/);
		assert.equal(registry.snapshot().length, 0);
	});

	it("falls back to the parent and reports when the child cannot be reached", () => {
		const registry = new PrThreadRegistry();
		registry.subscribe(subscription());
		const { dispatch, toParent, errors } = dispatchRecorder({ failChild: true });
		const route = registry.route(event(), dispatch);
		assert.equal(route.parent, true, "an undeliverable child must not swallow the notice");
		assert.equal(toParent.length, 1);
		assert.match(String((errors[0] as Error).message), /child inbox closed/);
	});

	it("accepts only well-formed events from the bus and reports the rest", () => {
		assert.deepEqual(parsePrWatchEvent({ kind: "conflict", repo: "a/b", pr: 2, ts: 3 }), { kind: "conflict", repo: "a/b", pr: 2, ts: 3 });
		assert.equal(parsePrWatchEvent({ kind: "ci-exploded", repo: "a/b", ts: 1 }), undefined);
		assert.equal(parsePrWatchEvent({ kind: "ci-failed", repo: "a/b", pr: "5", ts: 1 }), undefined);
		assert.equal(parsePrWatchEvent({ kind: "ci-failed", repo: "", ts: 1 }), undefined);
		assert.equal(parsePrWatchEvent(null), undefined);
	});

	it("is inert when no event bus is present, and binds the gitwatch channel when one is", () => {
		const registry = new PrThreadRegistry();
		const { dispatch, errors } = dispatchRecorder();
		const absent = bindPrWatchEvents(undefined, registry, dispatch);
		assert.doesNotThrow(() => absent.dispose());

		const handlers = new Map<string, (payload: unknown) => void>();
		const bus = { on: (channel: string, handler: (payload: unknown) => void) => { handlers.set(channel, handler); return () => handlers.delete(channel); } };
		registry.subscribe(subscription());
		const binding = bindPrWatchEvents(bus, registry, dispatch);
		assert.deepEqual([...handlers.keys()], [PR_WATCH_EVENT_CHANNEL]);
		handlers.get(PR_WATCH_EVENT_CHANNEL)!({ kind: "ci-passed", repo: "lennix1337/pi-subagents", pr: 5, ts: 9 });
		handlers.get(PR_WATCH_EVENT_CHANNEL)!({ kind: "nope" });
		assert.equal(errors.length, 1, "a malformed payload is reported, not silently dropped");
		binding.dispose();
		assert.equal(handlers.size, 0);
	});
});
