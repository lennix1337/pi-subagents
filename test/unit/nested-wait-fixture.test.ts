import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../fixtures/native-nested-wait-provider.ts";

it("native fixture continues a timed-out wait without relaunching or reading absent evidence", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-wait-fixture-"));
	const previous = process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT;
	process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT = path.join(root, "audit.jsonl");
	let provider: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	register({ on() {}, registerProvider(_name, config) { provider = config; } } as ExtensionAPI);
	assert.ok(provider?.streamSimple);
	const streamSimple = provider.streamSimple;
	const model = { id: "reviewer", api: "openai-completions", provider: "nested-wait-fixture" } as Parameters<typeof streamSimple>[0];
	const result = (toolName: string, text: string) => ({ role: "toolResult" as const, toolCallId: toolName, toolName, content: [{ type: "text" as const, text }], isError: false, timestamp: 0 });
	const launch = result("subagent", "Started 11111111-1111-1111-1111-111111111111");
	const timedOut = result("bg_wait", "Wait window elapsed after 20.0s with 1 async run(s) and 0 provider item(s) still active: 11111111-1111-1111-1111-111111111111 (running). The work keeps going; call bg_wait again or inspect subagent status.");
	try {
		const retry = await streamSimple(model, { messages: [launch, timedOut] }).result();
		assert.equal(retry.stopReason, "toolUse", retry.errorMessage);
		assert.deepEqual(retry.content.map(part => part.type === "toolCall" ? { name: part.name, arguments: part.arguments } : part), [{ name: "bg_wait", arguments: { all: true, timeoutMs: 20000 } }]);
		const complete = result("bg_wait", "Result [workflow]: /tmp/workflow-result.json");
		const read = await streamSimple(model, { messages: [launch, timedOut, complete] }).result();
		assert.equal(read.stopReason, "toolUse", read.errorMessage);
		assert.deepEqual(read.content.map(part => part.type === "toolCall" ? { name: part.name, arguments: part.arguments } : part), [{ name: "read", arguments: { path: "/tmp/workflow-result.json" } }]);
		const malformed = await streamSimple(model, { messages: [launch, result("bg_wait", "Finished without a result reference")] }).result();
		assert.equal(malformed.stopReason, "error", "missing evidence without an active wait must still fail");
		assert.match(malformed.errorMessage ?? "", /Missing result references/);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT;
		else process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
