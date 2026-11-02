import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PR_WATCH_EVENT_CHANNEL, type PrThreadSubscription, type PrWatchEvent } from "../../src/integrations/pr-thread-subscriptions.ts";
import type { SpeculativeOutcome, SpeculativeRun, SpeculativeTask } from "../../src/speculative/acting-ahead.ts";
import { DEFAULT_ACTING_AHEAD_CONFIG, type ActingAheadConfig } from "../../src/speculative/acting-ahead-policy.ts";
import { startActingAhead } from "../../src/speculative/acting-ahead-service.ts";

const config: ActingAheadConfig = {
	...DEFAULT_ACTING_AHEAD_CONFIG,
	enabled: true,
	owners: ["lennix1337"],
	testCommands: { "lennix1337/pi-subagents": ["node", "--test", "test/unit/x.test.ts"] },
};

function fakeBus() {
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	let disposed = 0;
	return {
		bus: {
			on: (channel: string, handler: (payload: unknown) => void) => {
				handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
				return () => { disposed++; handlers.set(channel, (handlers.get(channel) ?? []).filter((entry) => entry !== handler)); };
			},
		},
		publish: (payload: unknown) => { for (const handler of handlers.get(PR_WATCH_EVENT_CHANNEL) ?? []) handler(payload); },
		listeners: () => (handlers.get(PR_WATCH_EVENT_CHANNEL) ?? []).length,
		disposed: () => disposed,
	};
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function ciFailed(pr: number): PrWatchEvent {
	return { kind: "ci-failed", repo: "lennix1337/pi-subagents", pr, branch: `feat/${pr}`, ts: 1, detail: "calendar-timezones" };
}

function harness() {
	const launches: SpeculativeTask[] = [];
	const finishers = new Map<string, (outcome: SpeculativeOutcome) => void>();
	const reports: string[] = [];
	const steered: Array<{ subscription: PrThreadSubscription; event: PrWatchEvent }> = [];
	const errors: unknown[] = [];
	const fake = fakeBus();
	const service = startActingAhead({
		config,
		bus: fake.bus,
		launch: async (task) => {
			launches.push(task);
			const runId = `spec-${launches.length}`;
			const finished = new Promise<SpeculativeOutcome>((resolve) => { finishers.set(runId, resolve); });
			return { runId, asyncDir: `C:/async/${runId}`, stepIndex: 0, finished } satisfies SpeculativeRun;
		},
		report: (message) => { reports.push(message); },
		onError: (error) => { errors.push(error); },
		verify: async () => ({ confirmed: true }),
		steerChild: (subscription, event) => { steered.push({ subscription, event }); },
	});
	return { service, fake, launches, finishers, reports, steered, errors };
}

describe("acting ahead service", () => {
	it("starts a speculation from a bus CI failure, then sends the owning child the later CI results for its PR", async () => {
		const h = harness();
		h.fake.publish(ciFailed(9));
		await flush();
		assert.equal(h.launches.length, 1);
		assert.deepEqual(h.service.registry.snapshot().map((sub) => [sub.ownerRunId, sub.pr]), [["spec-1", 9]]);

		h.fake.publish({ kind: "ci-passed", repo: "lennix1337/pi-subagents", pr: 9, ts: 2 });
		assert.equal(h.steered.length, 1, "the CI result goes to the child, not to the parent");
		assert.equal(h.steered[0]!.subscription.ownerRunId, "spec-1");
		assert.equal(h.steered[0]!.event.kind, "ci-passed");
	});

	it("does not launch for a CI result that is not a failure, or for a PR nobody owns", async () => {
		const h = harness();
		h.fake.publish({ kind: "ci-passed", repo: "lennix1337/pi-subagents", pr: 9, ts: 2 });
		h.fake.publish({ kind: "ci-failed", repo: "someone/else", pr: 9, ts: 2 });
		await flush();
		assert.equal(h.launches.length, 0);
		assert.equal(h.errors.length, 0);
	});

	it("reports a confirmed fix once and drops the child's PR subscription when the run ends", async () => {
		const h = harness();
		h.fake.publish(ciFailed(9));
		await flush();
		h.finishers.get("spec-1")!({ ok: true, evidence: { worktreePath: "C:/wt/spec-1", baseRef: "abc", fixFiles: ["src/a.ts"], testFiles: ["test/unit/a.test.ts"] } });
		await flush();
		assert.equal(h.reports.length, 1);
		assert.equal(h.service.registry.snapshot().length, 0);
		h.fake.publish({ kind: "ci-passed", repo: "lennix1337/pi-subagents", pr: 9, ts: 3 });
		assert.equal(h.steered.length, 0, "after the run ends, its PR events return to the parent path");
	});

	it("works without a bus, and removes its listeners on dispose", async () => {
		const service = startActingAhead({ config, launch: async () => { throw new Error("no runner in this test"); }, report: () => {}, onError: () => {} });
		assert.deepEqual(await service.handle(ciFailed(9)), { admit: false, reason: "launch failed" });
		assert.doesNotThrow(() => service.dispose());

		const h = harness();
		assert.equal(h.fake.listeners(), 2, "the routing and the admission listeners are bound");
		h.service.dispose();
		assert.equal(h.fake.listeners(), 0);
		assert.equal(h.fake.disposed(), 2, "both the routing and the admission listeners are removed");
	});
});
