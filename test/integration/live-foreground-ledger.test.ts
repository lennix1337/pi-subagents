/**
 * Integration test for the live foreground ledger written by runSync:
 * the record exists while the child runs, never holds the task prompt, and
 * is gone once the child ends.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
	tempDir, mockPi, available, runSync, installSingleExecutionHooks,
} from "../support/single-execution-fixture.ts";
import { makeAgentConfigs } from "../support/helpers.ts";
import { liveForegroundRecordPath } from "../../src/runs/foreground/panel-ledger.ts";

describe("live foreground ledger during a single execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	it("publishes a prompt-free record while the child runs and removes it when the child ends", async () => {
		const secret = "synthetic-secret-token-4c1e: rotate the production key";
		mockPi.onCall({ delay: 400, output: "done" });
		const file = liveForegroundRecordPath("ledger-lifecycle", 0);

		const running = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", secret, { runId: "ledger-lifecycle" });
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(fs.existsSync(file), "the record is published while the child runs");
		const raw = fs.readFileSync(file, "utf8");
		assert.equal(raw.includes("synthetic-secret-token-4c1e"), false, "the raw prompt never reaches the ledger");
		const record = JSON.parse(raw);
		assert.equal(record.agent, "echo");
		assert.equal(record.state, "running");
		assert.equal("task" in record, false);

		const result = await running;
		assert.equal(result.exitCode, 0);
		// Cleanup runs on the completion chain, a few microtasks after the result is returned.
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fs.existsSync(file), false, "the record is removed when the child ends");
	});
});
