import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveRetainedWorktreeCwd } from "../../src/runs/shared/parallel-handoff.ts";

test("retained cwd treats a Windows short-name alias as the same directory", { skip: process.platform !== "win32" }, (t) => {
	// Existing system directory is read-only input; every write stays in a disposable root.
	const programFiles = process.env.ProgramFiles;
	if (!programFiles) return t.skip("ProgramFiles is unavailable");
	const shortName = path.join(path.parse(programFiles).root, "PROGRA~1");
	if (!fs.existsSync(shortName)) return t.skip("No existing Windows short-name alias");
	const canonical = fs.realpathSync.native(shortName);
	assert.notEqual(path.relative(canonical, fs.realpathSync(shortName)), "", "negative control: JS realpath preserves the short-name alias");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retained-alias-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const worktree = path.join(root, "worktree");
	fs.mkdirSync(worktree);
	const manifestPath = path.join(root, "handoff.json");
	for (const [repoRoot, cwd] of [[canonical, shortName], [shortName, canonical]]) {
		fs.writeFileSync(manifestPath, JSON.stringify({
			version: 1, runId: "alias", mode: "single", source: "async", cwd, createdAt: 1, updatedAt: 1,
			groups: [{
				stepIndex: 0, baseCommit: "base", repoRoot,
				children: [{ index: 0, taskIndex: 0, agent: "worker", status: "completed", summary: "done", patch: { path: path.join(root, "patch"), branch: "b", changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 } }],
				cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: worktree, branch: "b", worktreeRemoved: false, branchRemoved: false, preserved: true }] },
			}],
		}));
		assert.equal(resolveRetainedWorktreeCwd(manifestPath, "alias", 0), worktree);
	}
});
