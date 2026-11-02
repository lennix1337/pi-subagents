import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readGitFingerprint } from "../../src/runs/background/subagent-runner.ts";

const abort = new AbortController().signal;
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
const gitError = (message: string) => Object.assign(new Error(message), { code: 128, stderr: message });

// Fake git reads: each takes real time, so overlapping reads show up as in-flight count 2.
function fakeGit(reads: { head: () => Buffer; status: () => Buffer }) {
	let inFlight = 0, maxInFlight = 0;
	const run = async (args: string[]): Promise<Buffer> => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await pause();
			return args[0] === "rev-parse" ? reads.head() : reads.status();
		} finally {
			inFlight--;
		}
	};
	return { run, get maxInFlight() { return maxInFlight; } };
}

describe("git activity fingerprint", () => {
	it("reads HEAD and porcelain status together and fingerprints both", async () => {
		const status = Buffer.from(" M src/file.ts\0");
		const git = fakeGit({ head: () => Buffer.from("abc123\n"), status: () => status });
		const errors: unknown[] = [];
		const fingerprint = await readGitFingerprint("/repo", abort, (error) => errors.push(error), git.run);
		assert.equal(fingerprint, `abc123\0${status.toString("base64")}`);
		assert.equal(git.maxInFlight, 2, "HEAD and status are independent reads");
		assert.deepEqual(errors, []);
	});

	it("ignores a status failure when HEAD is empty, as the sequential read did", async () => {
		const git = fakeGit({ head: () => Buffer.from("\n"), status: () => { throw gitError("fatal: status"); } });
		const errors: unknown[] = [];
		assert.equal(await readGitFingerprint("/repo", abort, (error) => errors.push(error), git.run), undefined);
		assert.deepEqual(errors, []);
	});

	it("reports a failed HEAD read ahead of a failed status read", async () => {
		const headError = gitError("fatal: bad HEAD");
		const statusError = gitError("fatal: status broke");
		const git = fakeGit({ head: () => { throw headError; }, status: () => { throw statusError; } });
		const errors: unknown[] = [];
		assert.equal(await readGitFingerprint("/repo", abort, (error) => errors.push(error), git.run), undefined);
		assert.deepEqual(errors, [headError]);
	});

	it("reports a status failure after a good HEAD", async () => {
		const statusError = gitError("fatal: index");
		const git = fakeGit({ head: () => Buffer.from("abc\n"), status: () => { throw statusError; } });
		const errors: unknown[] = [];
		assert.equal(await readGitFingerprint("/repo", abort, (error) => errors.push(error), git.run), undefined);
		assert.deepEqual(errors, [statusError]);
	});

	it("never hides a process-tree failure from the status read behind a HEAD failure", async () => {
		const treeError = Object.assign(new Error("Worktree setup process tree settlement is unverified"), { code: "PROCESS_TREE_UNVERIFIED" });
		const git = fakeGit({ head: () => { throw gitError("fatal: bad HEAD"); }, status: () => { throw treeError; } });
		await assert.rejects(
			readGitFingerprint("/repo", abort, () => assert.fail("a process-tree failure must not be reported as missing evidence"), git.run),
			treeError,
		);
	});
});
