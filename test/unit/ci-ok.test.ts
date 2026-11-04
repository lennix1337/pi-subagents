import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciVerdict } from "../../.github/scripts/ci-ok.mjs";

const ran = (name: string, conclusion: string) => ({ name, conclusion, runner_name: "GitHub Actions 7", steps: [{ name: "Set up job", conclusion: "success" }] });
const neverStarted = (name: string) => ({ name, conclusion: "cancelled", runner_name: null, steps: [] });

describe("ci-ok verdict", () => {
	it("passes when every job succeeded or was skipped", () => {
		const verdict = ciVerdict([ran("test (ubuntu-latest, 1)", "success"), ran("bun-workflow-script", "skipped")]);
		assert.deepEqual(verdict, { ok: true, failed: [], unacquired: [] });
	});

	it("blocks when a needed job never acquired a hosted runner, even if other jobs passed", () => {
		const verdict = ciVerdict([ran("test (ubuntu-latest, 1)", "success"), neverStarted("native-nested-wait (macos-latest)")]);
		assert.deepEqual(verdict, { ok: false, failed: ["native-nested-wait (macos-latest)=cancelled"], unacquired: ["native-nested-wait (macos-latest)"] });
	});

	it("still blocks on a job that ran and failed, was cancelled mid-run or timed out", () => {
		const verdict = ciVerdict([
			ran("test (windows-latest, 2)", "failure"),
			ran("native-nested-wait (windows-latest)", "cancelled"),
			ran("clean-install", "timed_out"),
			neverStarted("native-nested-wait (macos-latest)"),
		]);
		assert.equal(verdict.ok, false);
		assert.deepEqual(verdict.failed, ["test (windows-latest, 2)=failure", "native-nested-wait (windows-latest)=cancelled", "clean-install=timed_out", "native-nested-wait (macos-latest)=cancelled"]);
	});

	it("blocks when no job ran at all, so an all-unacquired run is never green", () => {
		const verdict = ciVerdict([neverStarted("changes"), neverStarted("native-nested-wait (macos-latest)")]);
		assert.equal(verdict.ok, false);
	});

	it("ignores the ci-ok job itself, which is still running", () => {
		const verdict = ciVerdict([ran("test (ubuntu-latest, 1)", "success"), { name: "ci-ok", conclusion: null, runner_name: "GitHub Actions 9", steps: [] }]);
		assert.equal(verdict.ok, true);
	});
});
