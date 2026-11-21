import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";


describe("path.isAbsolute vs startsWith('/')", () => {

	it("startsWith('/') misses Windows absolute paths", () => {
		const windowsAbsolute = "C:\\dev\\pi-subagents\\output.md";
		const windowsAbsoluteForward = "C:/dev/pi-subagents/output.md";

		assert.equal(windowsAbsolute.startsWith("/"), false,
			"Windows backslash absolute path not detected by startsWith('/')");
		assert.equal(windowsAbsoluteForward.startsWith("/"), false,
			"Windows forward-slash absolute path not detected by startsWith('/')");

		assert.equal(path.isAbsolute(windowsAbsolute), process.platform === "win32",
			"path.isAbsolute correctly identifies Windows paths on Windows");
		assert.equal(path.isAbsolute(windowsAbsoluteForward), process.platform === "win32",
			"path.isAbsolute correctly identifies forward-slash Windows paths on Windows");

		assert.equal("/home/user/output.md".startsWith("/"), true);
		assert.equal(path.isAbsolute("/home/user/output.md"), true);
	});

	it("path.isAbsolute is the correct cross-platform check", () => {
		assert.equal(path.isAbsolute("output.md"), false);
		assert.equal(path.isAbsolute("subdir/output.md"), false);
		assert.equal("output.md".startsWith("/"), false);

		if (process.platform === "win32") {
			assert.equal(path.isAbsolute("C:\\output.md"), true);
			assert.equal(path.isAbsolute("C:/output.md"), true);
			assert.equal(path.isAbsolute("\\\\server\\share"), true);
			assert.equal("C:\\output.md".startsWith("/"), false);
			assert.equal("C:/output.md".startsWith("/"), false);
		}
	});
});

describe("path.join vs template string concatenation", () => {

	it("template concatenation produces forward slashes regardless of platform", () => {
		const chainDir = "C:\\Users\\marc\\temp\\chain-abc";
		const file = "progress.md";

		const templateResult = `${chainDir}/${file}`;
		assert.equal(templateResult, "C:\\Users\\marc\\temp\\chain-abc/progress.md",
			"template string produces mixed separators");

		const joinResult = path.join(chainDir, file);
		if (process.platform === "win32") {
			assert.equal(joinResult, "C:\\Users\\marc\\temp\\chain-abc\\progress.md",
				"path.join uses consistent backslashes on Windows");
		}
	});

	it("resolveChainPath pattern should use path.join for relative paths", () => {
		const chainDir = "C:\\temp\\chain-runs\\abc123";
		const relative = "synthesis.md";

		const current = `${chainDir}/${relative}`;
		const fixed = path.join(chainDir, relative);

		if (process.platform === "win32") {
			assert.notEqual(current, fixed, "concat and path.join produce different results on Windows");
			assert.ok(fixed.includes(path.sep), "path.join uses native separator");
		}
	});

	it("parallel subdir naming should use path.join", () => {
		const subdir = "parallel-0/0-_code-reviewer";
		const output = "review.md";

		const templateResult = `${subdir}/${output}`;
		const joinResult = path.join(subdir, output);

		const windowsSubdir = path.join("parallel-0", "0-_code-reviewer");
		const windowsJoin = path.join(windowsSubdir, output);
		assert.equal(windowsJoin, path.join("parallel-0", "0-_code-reviewer", output));
	});
});

