import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cases = [
	["timeout-minimum", "src/slash/delegation-request.ts", "value.timeoutMs < 1", "value.timeoutMs < 0", "strictly parses the structured owned-leaf request", "delegation-api"],
	["timeout-maximum", "src/slash/delegation-request.ts", "timeoutMs > 2_147_483_647", "timeoutMs > 2_147_483_648", "strictly parses the structured owned-leaf request", "delegation-api"],
	["model-deny", "src/watchdog/rules.ts", "if (denied !== undefined)", "if (false)", "applies deny before allow", "watchdog-rules"],
	["model-allow", "src/watchdog/rules.ts", "modelMatches(roleRule.allow, model) !== undefined", "true", "applies deny before allow", "watchdog-rules"],
	["args-digest-key-order", "src/shared/utils.ts", ".sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));", ";", "property:", "property-tool-args-key"],
	["args-digest-undefined", "src/shared/utils.ts", ".filter(([, entry]) => entry !== undefined)", ".filter(() => true)", "property:", "property-tool-args-key"],
	["args-digest-preview", "src/shared/utils.ts", "update(canonicalJson(args))", "update(extractToolArgsPreview(args))", "property:", "property-tool-args-key"],
	["loop-identity-preview", "src/watchdog/progress/progress-signals.ts", "(call.argsKey ?? call.args) !== (last.argsKey ?? last.args)", "call.args !== last.args", "property:", "property-progress-signals"],
	["loop-identity-digest-only", "src/watchdog/progress/progress-signals.ts", "(call.argsKey ?? call.args) !== (last.argsKey ?? last.args)", "call.argsKey !== last.argsKey", "property:", "property-progress-signals"],
	["loop-threshold", "src/watchdog/progress/progress-signals.ts", "if (identical >= policy.identicalCallRepeats) {", "if (identical > policy.identicalCallRepeats) {", "property:", "property-progress-signals"],
	["loop-failed-run", "src/watchdog/progress/progress-signals.ts", "calls[index]!.failed === true", "calls[index]!.failed !== true", "property:", "property-progress-signals"],
	["loop-runner-gone", "src/watchdog/progress/progress-signals.ts", "if (observation.runnerAlive === false) {", "if (false) {", "property:", "property-progress-signals"],
];

for (const [name, file, before, after, pattern, test] of cases) {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-mutant-"));
	try {
		for (const entry of ["src", "test", "package.json"]) cpSync(join(root, entry), join(dir, entry), { recursive: true });
		symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const path = join(dir, file);
		const source = readFileSync(path, "utf8");
		assert.equal(source.split(before).length, 2, `${name}: mutation must be unique`);
		writeFileSync(path, source.replace(before, after));
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/isolated-temp-root.mjs", "--test", `--test-name-pattern=${pattern}`, `test/unit/${test}.test.ts`], { cwd: dir, encoding: "utf8", timeout: 30000 });
		assert.equal(result.error, undefined, `${name}: process must run without timing out`);
		assert.notEqual(result.status, 0, `${name}: survived`);
		assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
		console.log(`${name}: killed by assertion`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`${cases.length}/${cases.length} guard mutants killed; disposable copies only`);
