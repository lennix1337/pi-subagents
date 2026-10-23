import assert from "node:assert/strict";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SUBAGENT_CHILD_TOOL_ACTIVITY_EVENT, type SubagentChildToolActivityEvent } from "../../src/api/shared-types.ts";
import { emitChildToolActivity, projectChildToolActivity, readChildToolActivity } from "../../src/runs/shared/child-tool-activity.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { ChildSession } from "../../src/runs/shared/child-session.ts";
import { createEventBus, makeAgentConfigs } from "../support/helpers.ts";

const identity = { runId: "run-1", childId: "step:2", agent: "worker" };

it("projects only native start/end boundaries and never copies child content", () => {
	const sensitive = { args: { command: "private command" }, result: "private result", task: "private task", prompt: "private prompt" };
	assert.deepEqual(projectChildToolActivity({ type: "tool_execution_start", toolName: "bash", isError: true, ...sensitive }, identity), {
		...identity, toolName: "bash", phase: "start", isError: false,
	});
	assert.deepEqual(projectChildToolActivity({ type: "tool_execution_end", toolName: "bash", isError: true, ...sensitive }, identity), {
		...identity, toolName: "bash", phase: "end", isError: true,
	});
	for (const event of [
		{ type: "tool_execution_update", toolName: "bash" },
		{ type: "message_end", toolName: "bash" },
		{ type: "tool_execution_start" },
		{ type: "tool_execution_end", toolName: "" },
		{ type: "tool_execution_end", toolName: 123 },
	]) assert.equal(projectChildToolActivity(event, identity), undefined);
});

it("validates journal records and allowlists the exact public payload", () => {
	const record = { type: "subagent.child-tool-activity", version: 1, ...identity, toolName: "read", phase: "end", isError: false, sessionId: "session-1" };
	assert.deepEqual(readChildToolActivity({ ...record, args: "secret", result: "secret", task: "secret", prompt: "secret", source: "async", ts: 123 }), {
		...identity, toolName: "read", phase: "end", isError: false, sessionId: "session-1",
	});
	for (const invalid of [null, [], { ...record, version: 2 }, { ...record, runId: "" }, { ...record, childId: 2 }, { ...record, agent: null }, { ...record, toolName: false }, { ...record, phase: "update" }, { ...record, isError: "false" }]) {
		assert.equal(readChildToolActivity(invalid), undefined);
	}
});

it("contains a throwing activity subscriber", (t) => {
	const diagnostics: unknown[][] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { diagnostics.push(args); };
	t.after(() => { console.error = original; });
	emitChildToolActivity({ emit() { throw new Error("subscriber failed"); } }, { ...identity, toolName: "read", phase: "start", isError: false });
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]?.[0], "Failed to emit child tool activity event:");
});

for (const workflow of [false, true]) {
	it(`emits foreground native boundaries with ${workflow ? "workflow root/key" : "owning run/step"} identity`, async () => {
		let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
		const bus = createEventBus();
		const activities: SubagentChildToolActivityEvent[] = [];
		bus.on(SUBAGENT_CHILD_TOOL_ACTIVITY_EVENT, (data) => activities.push(data as SubagentChildToolActivityEvent));
		const messages: ChildSession["messages"] = [];
		const session: ChildSession = {
			subscribe(handler) { listener = handler; return () => {}; },
			async prompt() {
				listener({ type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: { path: "private path" } });
				listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-2", args: { command: "private command" } });
				listener({ type: "tool_execution_update", toolName: "bash", partialResult: "private partial result" });
				listener({ type: "tool_execution_end", toolName: "bash", toolCallId: "call-2", isError: true, result: "private error" });
				listener({ type: "tool_execution_end", toolName: "read", toolCallId: "call-1", isError: false, result: "private result" });
				const message = fauxAssistantMessage("Done");
				messages.push(message);
				listener({ type: "message_end", message });
				listener({ type: "agent_end", messages });
				listener({ type: "agent_settled" });
			},
			async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
			messages, sessionId: "child-session", modelId: "mock/model",
		};
		const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "private task", {
			runId: "child-run", index: 2, intercomEvents: bus,
			...(workflow ? { childToolActivityIdentity: { runId: "workflow-root", childId: "review" } } : {}),
			childSessionFactory: { create: async () => session, async dispose() {} },
		});
		assert.equal(result.exitCode, 0);
		const expectedIdentity = { runId: workflow ? "workflow-root" : "child-run", childId: workflow ? "review" : "step:2", agent: "worker" };
		assert.deepEqual(activities, [
			{ ...expectedIdentity, toolName: "read", phase: "start", isError: false },
			{ ...expectedIdentity, toolName: "bash", phase: "start", isError: false },
			{ ...expectedIdentity, toolName: "bash", phase: "end", isError: true },
			{ ...expectedIdentity, toolName: "read", phase: "end", isError: false },
		]);
	});
}
