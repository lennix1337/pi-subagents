import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installModelRouteBus, MODEL_ROUTE_REQUEST_EVENT } from "../../src/shared/model-route.ts";
import { resolveModelSelection } from "../../src/runs/shared/model-resolution.ts";

const models = [
	{ provider: "openai-codex-account-2", id: "gpt-6.1-terra", fullId: "openai-codex-account-2/gpt-6.1-terra" },
	{ provider: "anthropic", id: "claude-sonnet-5-5", fullId: "anthropic/claude-sonnet-5-5" },
];

/** A root account manager that says codex-account-2 is spent and Sonnet is its ready peer. */
function spentCodexBus(answer: (model: { provider: string; id: string }) => unknown) {
	const asked: unknown[] = [];
	const uninstall = installModelRouteBus({
		emit: (name, payload) => {
			if (name !== MODEL_ROUTE_REQUEST_EVENT) return;
			const request = payload as { model: { provider: string; id: string }; result?: unknown };
			asked.push(request.model);
			request.result = answer(request.model);
		},
	});
	return { asked, uninstall };
}

const routeToSonnet = (model: { provider: string; id: string }) => model.provider === "openai-codex-account-2"
	? { action: "route", model: { provider: "anthropic", id: "claude-sonnet-5-5" }, reason: "openai-codex-account-2/gpt-6.1-terra is spent for ~4h" }
	: { action: "keep" };

let uninstall: (() => void) | undefined;
afterEach(() => {
	uninstall?.();
	uninstall = undefined;
});

describe("subagent launch model follows the parent's account failover", () => {
	it("moves a configured model off a spent account and keeps its thinking level", () => {
		const bus = spentCodexBus(routeToSonnet);
		uninstall = bus.uninstall;
		const evidence = resolveModelSelection("openai-codex-account-2/gpt-6.1-terra:low", models, undefined, { origin: "configured" });
		assert.deepEqual(bus.asked, [{ provider: "openai-codex-account-2", id: "gpt-6.1-terra" }]);
		assert.equal(evidence.model, "anthropic/claude-sonnet-5-5:low");
		assert.equal(evidence.routedFrom, "openai-codex-account-2/gpt-6.1-terra:low");
		assert.match(evidence.routeReason ?? "", /spent/);
	});

	it("moves an inherited model too", () => {
		uninstall = spentCodexBus(routeToSonnet).uninstall;
		const evidence = resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "inherited" });
		assert.equal(evidence.model, "anthropic/claude-sonnet-5-5");
	});

	it("never moves an explicitly requested model", () => {
		const bus = spentCodexBus(routeToSonnet);
		uninstall = bus.uninstall;
		const evidence = resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "explicit" });
		assert.equal(evidence.model, "openai-codex-account-2/gpt-6.1-terra");
		assert.deepEqual(bus.asked, []);
	});

	it("keeps the model when the root answers keep or nobody answers", () => {
		uninstall = spentCodexBus(() => ({ action: "keep", reason: "no ready account has the same tier" })).uninstall;
		assert.equal(resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "configured" }).model, "openai-codex-account-2/gpt-6.1-terra");
		uninstall();
		uninstall = spentCodexBus(() => undefined).uninstall;
		assert.equal(resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "configured" }).model, "openai-codex-account-2/gpt-6.1-terra");
		uninstall();
		uninstall = undefined;
		assert.equal(resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "configured" }).model, "openai-codex-account-2/gpt-6.1-terra");
	});

	it("ignores a replacement this session does not know or that an enforced scope forbids", () => {
		uninstall = spentCodexBus(() => ({ action: "route", model: { provider: "anthropic", id: "claude-unknown" }, reason: "spent" })).uninstall;
		assert.equal(resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "configured" }).model, "openai-codex-account-2/gpt-6.1-terra");
		uninstall();
		uninstall = spentCodexBus(routeToSonnet).uninstall;
		const scoped = resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, {
			origin: "configured",
			scope: { enforce: true, allow: ["openai-codex*/*"] },
		});
		assert.equal(scoped.model, "openai-codex-account-2/gpt-6.1-terra");
	});

	it("a stale uninstall does not unbind a newer runtime's bus", () => {
		const first = spentCodexBus(() => ({ action: "keep" }));
		const second = spentCodexBus(routeToSonnet);
		uninstall = second.uninstall;
		first.uninstall();
		assert.equal(resolveModelSelection("openai-codex-account-2/gpt-6.1-terra", models, undefined, { origin: "configured" }).model, "anthropic/claude-sonnet-5-5");
	});
});
