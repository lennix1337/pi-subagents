import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFinalAsyncRunState, isSettledAsyncRunState } from "../../src/runs/shared/async-run-state.ts";

describe("async run state classification", () => {
	it("treats queued and running as active", () => {
		for (const state of ["queued", "running"]) {
			assert.equal(isSettledAsyncRunState(state), false, state);
			assert.equal(isFinalAsyncRunState(state), false, state);
		}
	});

	it("treats paused as settled but not final because it can continue", () => {
		assert.equal(isSettledAsyncRunState("paused"), true);
		assert.equal(isFinalAsyncRunState("paused"), false);
	});

	it("treats every other run state as settled and final, including partial", () => {
		for (const state of ["complete", "failed", "partial", "stopped", "rejected"]) {
			assert.equal(isSettledAsyncRunState(state), true, state);
			assert.equal(isFinalAsyncRunState(state), true, state);
		}
	});

	it("rejects persisted values that are not run states", () => {
		for (const value of [undefined, "", "runing", "COMPLETE", "failed "]) {
			assert.equal(isSettledAsyncRunState(value), false, String(value));
			assert.equal(isFinalAsyncRunState(value), false, String(value));
		}
	});
});
