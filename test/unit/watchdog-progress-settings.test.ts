import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveWatchdogConfig } from "../../src/watchdog/settings.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeUserSettings(watchdog: unknown): void {
	const filePath = path.join(tempHome, ".pi", "agent", "settings.json");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify({ subagents: { watchdog } }), "utf-8");
}

describe("watchdog progress settings", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-progress-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-progress-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("is off by default, reports only, and sweeps every minute", () => {
		const result = resolveWatchdogConfig(tempProject, { projectTrusted: false });
		assert.equal(result.ok, true);
		assert.deepEqual(result.config.progress, {
			enabled: false,
			intervalMs: 60_000,
			stallAfterMs: 600_000,
			actions: { stalled: "report", looping: "report" },
			maxNudges: 2,
			nudgeCooldownMs: 600_000,
			renotifyAfterMs: 1_800_000,
		});
	});

	it("merges a partial user section over the defaults, field by field", () => {
		writeUserSettings({ progress: { enabled: true, stallAfterMs: 300_000, actions: { looping: "nudge" } } });
		const result = resolveWatchdogConfig(tempProject, { projectTrusted: false });
		assert.equal(result.ok, true);
		assert.equal(result.config.progress.enabled, true);
		assert.equal(result.config.progress.stallAfterMs, 300_000);
		assert.deepEqual(result.config.progress.actions, { stalled: "report", looping: "nudge" });
		assert.equal(result.config.progress.intervalMs, 60_000);
	});

	it("rejects unknown fields and invalid action modes, and keeps the defaults", () => {
		writeUserSettings({ progress: { enabled: true, retry: true } });
		const unknownField = resolveWatchdogConfig(tempProject, { projectTrusted: false });
		assert.equal(unknownField.ok, false);
		assert.equal(unknownField.config.progress.enabled, false, "a rejected source does not switch the sweep on");
		assert.match(unknownField.errors.map((error) => error.message).join("\n"), /progress/);

		writeUserSettings({ progress: { enabled: true, actions: { stalled: "retry" } } });
		const badAction = resolveWatchdogConfig(tempProject, { projectTrusted: false });
		assert.equal(badAction.ok, false);
		assert.equal(badAction.config.progress.enabled, false);
	});

	it("refuses a sweep interval below one second", () => {
		writeUserSettings({ progress: { enabled: true, intervalMs: 10 } });
		const result = resolveWatchdogConfig(tempProject, { projectTrusted: false });
		assert.equal(result.ok, false);
		assert.equal(result.config.progress.intervalMs, 60_000);
	});
});
