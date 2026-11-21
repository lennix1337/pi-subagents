import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTempParent, tempParentCandidates } from "./temp-parent.mjs";

const harnessInput = /^PI_SUBAGENTS_(TEMP_ROOT|TERMINAL_EVIDENCE_DIR|NATIVE_PI_ROOT|NATIVE_SDK|\w+_SMOKE(_\w+)?)$/;
if (process.env.PI_SUBAGENTS_TEST_LOADER === undefined) {
	for (const name of Object.keys(process.env)) if (name.startsWith("PI_") && !harnessInput.test(name)) delete process.env[name];
}

const configuredTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
const tempRoot = configuredTempRoot
	? path.resolve(configuredTempRoot)
	: fs.mkdtempSync(path.join(cleanTempParent(tempParentCandidates(os.tmpdir())), "pst-"));
fs.mkdirSync(tempRoot, { recursive: true });
if (process.platform === "darwin") fs.closeSync(fs.openSync(path.join(tempRoot, ".metadata_never_index"), "a"));
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
process.env.TMPDIR = tempRoot;
process.env.TMP = tempRoot;
process.env.TEMP = tempRoot;

const loaderState = process.env.PI_SUBAGENTS_TEST_LOADER;
const nestedTestProcess = loaderState !== undefined;
const testFileProcess = process.env.NODE_TEST_CONTEXT !== undefined && loaderState !== "test-file";
if (!nestedTestProcess || testFileProcess) process.env.PI_SUBAGENTS_TEST_PARENT_PID = String(process.pid);
const isolatedHome = path.join(tempRoot, "home");
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.PI_SUBAGENTS_TEST_LOADER = testFileProcess ? "test-file" : "loaded";

if (!configuredTempRoot) {
	process.on("exit", () => {
		try {
			fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch (error) {
			try {
				fs.writeSync(2, `warning: test temp root not removed: ${tempRoot} (${error?.code ?? error})\n`);
			} catch {}
		}
	});
}
