import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confirmRedGreen, evidenceProblem, type SpeculativeEvidence, type SpeculativeGit, type SpeculativeTests } from "../../src/speculative/acting-ahead-verify.ts";

const BASE = "1111111";
const evidence: SpeculativeEvidence = {
	worktreePath: "C:/wt/spec",
	baseRef: BASE,
	fixFiles: ["src/parse.ts"],
	testFiles: ["test/unit/parse.test.ts"],
	testCommand: ["node", "--test", "test/unit/parse.test.ts"],
};

interface Fake {
	git: SpeculativeGit;
	tests: SpeculativeTests;
	gitCalls: string[][];
	testRuns: number[];
}

/**
 * Scripted git and test runner. `testExit` is consumed in order: the first run is
 * the green run with the fix, the second is the red run without it.
 */
function fake(options: { status?: string; testExit?: number[]; failArgs?: (args: string[]) => boolean }): Fake {
	const gitCalls: string[][] = [];
	const testRuns: number[] = [];
	const exits = [...(options.testExit ?? [0, 1])];
	return {
		gitCalls,
		testRuns,
		git: {
			run: async (_cwd, args) => {
				gitCalls.push(args);
				if (options.failArgs?.(args)) return { exitCode: 1, stdout: "" };
				if (args[0] === "status") return { exitCode: 0, stdout: options.status ?? "" };
				return { exitCode: 0, stdout: "" };
			},
		},
		tests: {
			run: async () => {
				const exit = exits.shift() ?? 0;
				testRuns.push(exit);
				return { exitCode: exit };
			},
		},
	};
}

describe("acting ahead evidence checks", () => {
	it("accepts relative, disjoint, non-empty evidence", () => {
		assert.equal(evidenceProblem(evidence), undefined);
	});

	it("refuses absolute or escaping paths, overlapping files and empty lists before running anything", () => {
		assert.match(evidenceProblem({ ...evidence, fixFiles: ["/etc/passwd"] }) ?? "", /relative path/);
		assert.match(evidenceProblem({ ...evidence, fixFiles: ["../outside.ts"] }) ?? "", /relative path/);
		assert.match(evidenceProblem({ ...evidence, fixFiles: ["C:/x.ts"] }) ?? "", /relative path/);
		assert.match(evidenceProblem({ ...evidence, testFiles: ["src/parse.ts"] }) ?? "", /both a fix and a test/);
		assert.match(evidenceProblem({ ...evidence, fixFiles: [] }) ?? "", /fix file/);
		assert.match(evidenceProblem({ ...evidence, testFiles: [] }) ?? "", /test file/);
		assert.match(evidenceProblem({ ...evidence, testCommand: [] }) ?? "", /test command/);
	});

	it("runs nothing when the evidence is refused", async () => {
		const io = fake({});
		const verdict = await confirmRedGreen({ ...evidence, fixFiles: ["../x.ts"] }, io);
		assert.equal(verdict.confirmed, false);
		assert.deepEqual(io.gitCalls, []);
		assert.deepEqual(io.testRuns, []);
	});
});

describe("acting ahead red-without / green-with confirmation", () => {
	it("confirms when the tests pass with the fix, fail without it, and the fix is restored", async () => {
		const io = fake({ testExit: [0, 1] });
		const verdict = await confirmRedGreen(evidence, io);
		assert.deepEqual(verdict, { confirmed: true });
		assert.deepEqual(io.testRuns, [0, 1], "green first, then red without the fix");
		assert.deepEqual(io.gitCalls, [
			["status", "--porcelain"],
			["checkout", BASE, "--", "src/parse.ts"],
			["checkout", "HEAD", "--", "src/parse.ts"],
			["status", "--porcelain"],
		]);
	});

	it("refuses when the tests fail even with the fix, and does not revert anything", async () => {
		const io = fake({ testExit: [1] });
		const verdict = await confirmRedGreen(evidence, io);
		assert.equal(verdict.confirmed, false);
		assert.match((verdict as { reason: string }).reason, /fail with the fix in place/);
		assert.equal(io.gitCalls.some((args) => args[0] === "checkout"), false);
	});

	it("refuses a test that passes without the fix, since it is not a regression test", async () => {
		const io = fake({ testExit: [0, 0] });
		const verdict = await confirmRedGreen(evidence, io);
		assert.equal(verdict.confirmed, false);
		assert.match((verdict as { reason: string }).reason, /pass without the fix/);
	});

	it("refuses a dirty worktree before running tests", async () => {
		const io = fake({ status: " M src/parse.ts\n" });
		const verdict = await confirmRedGreen(evidence, io);
		assert.equal(verdict.confirmed, false);
		assert.match((verdict as { reason: string }).reason, /uncommitted changes/);
		assert.deepEqual(io.testRuns, []);
	});

	it("refuses a fix file that does not exist at the base, and still restores the worktree", async () => {
		const io = fake({ testExit: [0], failArgs: (args) => args[0] === "checkout" && args[1] === BASE });
		const verdict = await confirmRedGreen(evidence, io);
		assert.equal(verdict.confirmed, false);
		assert.match((verdict as { reason: string }).reason, /could not revert the fix/);
		assert.deepEqual(io.gitCalls.at(-2), ["checkout", "HEAD", "--", "src/parse.ts"], "restore runs after a failed revert");
	});

	it("does not confirm when the fix cannot be restored, because the worktree state is unknown", async () => {
		const io = fake({ testExit: [0, 1], failArgs: (args) => args[0] === "checkout" && args[1] === "HEAD" });
		const verdict = await confirmRedGreen(evidence, io);
		assert.equal(verdict.confirmed, false);
		assert.match((verdict as { reason: string }).reason, /could not restore the fix/);
	});
});
