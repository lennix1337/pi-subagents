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

async function restoreFix(git: SpeculativeGit, worktreePath: string, fixFiles: string[]): Promise<boolean> {
	const restored = await git.run(worktreePath, ["checkout", "HEAD", "--", ...fixFiles]);
	if (restored.exitCode !== 0) return false;
	const status = await git.run(worktreePath, ["status", "--porcelain"]);
	return status.exitCode === 0 && status.stdout.trim() === "";
}

export async function confirmRedGreen(evidence: SpeculativeEvidence, io: { git: SpeculativeGit; tests: SpeculativeTests }): Promise<SpeculativeVerdict> {
	const problem = evidenceProblem(evidence);
	if (problem) return { confirmed: false, reason: problem };
	const { worktreePath, fixFiles, testCommand } = evidence;

	const before = await io.git.run(worktreePath, ["status", "--porcelain"]);
	if (before.exitCode !== 0) return { confirmed: false, reason: "could not read the worktree status" };
	if (before.stdout.trim() !== "") return { confirmed: false, reason: "the worktree has uncommitted changes" };

	const green = await io.tests.run(worktreePath, testCommand);
	if (green.exitCode !== 0) return { confirmed: false, reason: "the tests fail with the fix in place" };

	const reverted = await io.git.run(worktreePath, ["checkout", evidence.baseRef, "--", ...fixFiles]);
	let redExit: number | undefined;
	if (reverted.exitCode === 0) redExit = (await io.tests.run(worktreePath, testCommand)).exitCode;

	const restored = await restoreFix(io.git, worktreePath, fixFiles);
	if (!restored) return { confirmed: false, reason: "could not restore the fix in the worktree; its state is unknown" };
	if (reverted.exitCode !== 0) return { confirmed: false, reason: "could not revert the fix to the base; the fix file may be missing there" };
	if (redExit === 0) return { confirmed: false, reason: "the tests pass without the fix, so they do not catch it" };
	return { confirmed: true };
}
