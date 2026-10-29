import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciScope } from "../../.github/scripts/ci-scope.mjs";

const tests = new Map([
	["test/unit/subagent-guide.test.ts", "readSubagentGuide()"],
	["test/unit/changelog-format.test.ts", 'readFileSync("CHANGELOG.md")'],
	["test/unit/calendar-schedule.test.ts", ""],
	["test/integration/nested-async-wait.test.ts", ""],
]);

describe("ci scope", () => {
	it("runs everything when the diff is unknown or touches build, CI or shared test support", () => {
		for (const files of [null, [".github/workflows/test.yml"], ["package-lock.json"], ["test/support/isolated-temp-root.mjs"], ["index.ts"]]) {
			const scope = ciScope(files, tests);
			assert.equal(scope.full, true, String(files));
			assert.ok(Object.values(scope.jobs).every(Boolean), String(files));
		}
	});

	it("runs only the guide test and tests naming the file for a docs change", () => {
		const scope = ciScope(["docs/workflows.md", "CHANGELOG.md"], tests);
		assert.equal(scope.full, false);
		assert.equal(scope.typecheck, false);
		assert.deepEqual(scope.unit, ["test/unit/changelog-format.test.ts", "test/unit/subagent-guide.test.ts"]);
		assert.ok(Object.values(scope.jobs).every((run) => !run));
	});

	it("runs nothing for prose no test reads", () => {
		const scope = ciScope(["README.md"], tests);
		assert.deepEqual([scope.full, scope.unit, scope.integration], [false, [], []]);
	});

	it("runs a changed test file alone, plus the platform job that owns it", () => {
		const scope = ciScope(["test/unit/calendar-schedule.test.ts", "test/integration/nested-async-wait.test.ts"], tests);
		assert.equal(scope.full, false);
		assert.equal(scope.typecheck, true);
		assert.deepEqual(scope.unit, ["test/unit/calendar-schedule.test.ts"]);
		assert.deepEqual(scope.integration, ["test/integration/nested-async-wait.test.ts"]);
		assert.equal(scope.jobs.calendar, true);
		assert.equal(scope.jobs.schedule, true);
		assert.equal(scope.jobs.runtime, true);
		assert.equal(scope.jobs.worktree, false);
	});

	it("runs the full suite for a source change, and only the platform jobs of its area", () => {
		const watchdog = ciScope(["src/watchdog/review.ts"], tests);
		assert.equal(watchdog.full, true);
		assert.ok(Object.values(watchdog.jobs).every((run) => !run));

		const worktree = ciScope(["src/runs/shared/worktree-lock.ts"], tests);
		assert.equal(worktree.full, true);
		assert.equal(worktree.jobs.worktree, true);
		assert.equal(worktree.jobs.runtime, true);
		assert.equal(worktree.jobs.calendar, false);
	});

	it("treats shipped prompts, skills and agents as product source", () => {
		for (const file of ["skills/pi-subagents/SKILL.md", "prompts/review.md", "agents/worker.md"]) {
			assert.equal(ciScope([file], tests).full, true, file);
		}
	});
});
