/**
 * Harness-side confirmation of a speculative fix. The child's own report is not
 * evidence: the harness runs the test command itself, green with the fix, then
 * reverts only the fix files to the base and runs it again, which must fail. The
 * fix is restored afterwards in every case, and a worktree that cannot be restored
 * is never confirmed.
 */

export interface SpeculativeEvidence {
	worktreePath: string;
	/** The commit the child started from; the fix files must exist there. */
	baseRef: string;
	/** Non-test files the fix changed. */
	fixFiles: string[];
	/** Test files the child added or changed. */
	testFiles: string[];
	/** Argv from the operator's config, run without a shell. */
	testCommand: string[];
}

export interface SpeculativeGit {
	run(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string }>;
}

export interface SpeculativeTests {
	run(cwd: string, argv: string[]): Promise<{ exitCode: number }>;
}

export type SpeculativeVerdict = { confirmed: true } | { confirmed: false; reason: string };

function isRelativeSafePath(file: string): boolean {
	if (!file.trim()) return false;
	if (file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:/.test(file)) return false;
	return !file.split(/[\\/]/).includes("..");
}

/** Pure check before anything runs; returns the first problem, or undefined when the evidence is usable. */
export function evidenceProblem(evidence: SpeculativeEvidence): string | undefined {
	if (evidence.fixFiles.length === 0) return "no fix file was reported";
	if (evidence.testFiles.length === 0) return "no test file was reported";
	if (evidence.testCommand.length === 0) return "no test command is configured";
	const files = [...evidence.fixFiles, ...evidence.testFiles];
	if (!files.every(isRelativeSafePath)) return "every reported file must be a relative path inside the worktree";
	const fixes = new Set(evidence.fixFiles);
	if (evidence.testFiles.some((file) => fixes.has(file))) return "a file cannot be both a fix and a test";
	return undefined;
}

type RunOutcome = { exitCode: number } | { error: string };

/** Never throws: an execution failure becomes a refusal reason, not a lost restore. */
async function runTests(tests: SpeculativeTests, cwd: string, argv: string[]): Promise<RunOutcome> {
	try {
		return await tests.run(cwd, argv);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function failure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Returns a problem, or undefined when the revert succeeded. Never throws. */
async function revertFix(git: SpeculativeGit, baseRef: string, worktreePath: string, fixFiles: string[]): Promise<string | undefined> {
	try {
		const result = await git.run(worktreePath, ["checkout", baseRef, "--", ...fixFiles]);
		return result.exitCode === 0 ? undefined : "the fix file may be missing there";
	} catch (error) {
		return failure(error);
	}
}

/** Returns a problem, or undefined when the fix is back and the worktree is clean. Never throws. */
async function restoreFix(git: SpeculativeGit, worktreePath: string, fixFiles: string[]): Promise<string | undefined> {
	try {
		const restored = await git.run(worktreePath, ["checkout", "HEAD", "--", ...fixFiles]);
		if (restored.exitCode !== 0) return "checkout failed";
		const status = await git.run(worktreePath, ["status", "--porcelain"]);
		if (status.exitCode !== 0) return "status failed";
		return status.stdout.trim() === "" ? undefined : "the worktree is still dirty";
	} catch (error) {
		return failure(error);
	}
}

const refused = (reason: string): SpeculativeVerdict => ({ confirmed: false, reason });

export async function confirmRedGreen(evidence: SpeculativeEvidence, io: { git: SpeculativeGit; tests: SpeculativeTests }): Promise<SpeculativeVerdict> {
	const problem = evidenceProblem(evidence);
	if (problem) return refused(problem);
	const { worktreePath, baseRef, fixFiles, testCommand } = evidence;

	let before: { exitCode: number; stdout: string };
	try {
		before = await io.git.run(worktreePath, ["status", "--porcelain"]);
	} catch (error) {
		return refused(`could not read the worktree status: ${failure(error)}`);
	}
	if (before.exitCode !== 0) return refused("could not read the worktree status");
	if (before.stdout.trim() !== "") return refused("the worktree has uncommitted changes");

	const green = await runTests(io.tests, worktreePath, testCommand);
	if (!("exitCode" in green)) return refused(`the tests could not run with the fix in place: ${green.error}`);
	if (green.exitCode !== 0) return refused("the tests fail with the fix in place");

	const revertProblem = await revertFix(io.git, baseRef, worktreePath, fixFiles);
	const red = revertProblem === undefined ? await runTests(io.tests, worktreePath, testCommand) : undefined;
	const restoreProblem = await restoreFix(io.git, worktreePath, fixFiles);
	if (restoreProblem !== undefined) return refused(`could not restore the fix in the worktree, so its state is unknown (${restoreProblem})`);
	if (revertProblem !== undefined) return refused(`could not revert the fix to the base; ${revertProblem}`);
	if (red === undefined) return refused("the tests could not run without the fix");
	if (!("exitCode" in red)) return refused(`the tests could not run without the fix: ${red.error}`);
	if (red.exitCode === 0) return refused("the tests pass without the fix, so they do not catch it");
	return { confirmed: true };
}
