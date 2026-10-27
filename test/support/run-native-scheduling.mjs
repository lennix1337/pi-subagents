import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real installed SDK, synthetic HTTP only; no dependency installation or provider calls.
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const result = spawnSync(process.execPath, [
	"--experimental-strip-types",
	"--import", "./test/support/isolated-temp-root.mjs",
	"--test",
	"test/unit/acceptance-compaction.test.ts",
	"test/unit/watchdog-native-scheduling.test.ts",
], {
	cwd,
	env: { ...process.env, PI_SUBAGENTS_NATIVE_SDK: process.env.PI_SUBAGENTS_NATIVE_SDK || cwd },
	stdio: "inherit",
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
