import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CHILD_SESSION_NAME_MAX_CHARS,
	deriveChildSessionName,
} from "../../src/shared/child-session-name.ts";
import { PROMPT_REDACTED } from "../../src/shared/utils.ts";

describe("deriveChildSessionName", () => {
	it("combines agent and task excerpt", () => {
		assert.equal(
			deriveChildSessionName({ agent: "reviewer", task: "Review the diff since main" }),
			"reviewer: Review the diff since main",
		);
	});

	it("prefers a workflow label over the task", () => {
		assert.equal(
			deriveChildSessionName({ agent: "scout", label: "find-callers", task: "ignored task text" }),
			"scout: find-callers",
		);
	});

	it("falls back to the bare agent when no task or label is usable", () => {
		assert.equal(deriveChildSessionName({ agent: "worker" }), "worker");
		assert.equal(deriveChildSessionName({ agent: "worker", task: "   " }), "worker");
	});

	it("never builds a name from a redacted prompt", () => {
		assert.equal(deriveChildSessionName({ agent: "worker", task: PROMPT_REDACTED }), "worker");
		assert.equal(deriveChildSessionName({ task: PROMPT_REDACTED }), undefined);
	});

	it("collapses newlines and control characters into a single line", () => {
		const name = deriveChildSessionName({ agent: "scout", task: "line one\nline two" });
		assert.equal(name, "scout: line one line two");
		assert.doesNotMatch(name!, /[\n]/);
	});

	it("caps the final name at CHILD_SESSION_NAME_MAX_CHARS", () => {
		const name = deriveChildSessionName({ agent: "worker", task: "x".repeat(500) });
		assert.ok(name);
		assert.ok(name.length <= CHILD_SESSION_NAME_MAX_CHARS);
		assert.ok(name.endsWith("..."));
	});

	it("names the child by its goal, not the role boilerplate before it", () => {
		assert.equal(
			deriveChildSessionName({ agent: "worker", task: "You are a subagent. Don't write memory pages.\n\nGoal: fix the executor restore.\n\nWhere: worktree X" }),
			"worker: fix the executor restore.",
		);
		assert.equal(
			deriveChildSessionName({ agent: "worker", task: "You are a subagent. Don't write memory pages. Review the cache layer." }),
			"worker: Review the cache layer.",
		);
		assert.equal(deriveChildSessionName({ agent: "scout", task: "Task: map the auth flow" }), "scout: map the auth flow");
	});

	it("ignores a label deep in the task body", () => {
		const task = ["Audit the importer.", "a", "b", "c", "d", "Goal: unrelated detail"].join("\n");
		assert.equal(deriveChildSessionName({ agent: "worker", task }), "worker: Audit the importer. a b c d Goal: unrelated detail");
	});

	it("returns undefined when there is nothing to name", () => {
		assert.equal(deriveChildSessionName({}), undefined);
	});
});
