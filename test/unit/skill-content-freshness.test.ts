import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearSkillCache, resolveSkills } from "../../src/agents/skills.ts";

describe("skill content freshness", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-freshness-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
		clearSkillCache();
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns a rewritten skill's new text even when its mtime did not change", () => {
		const cwd = path.join(tempDir, "project");
		const skillFile = path.join(cwd, ".pi", "skills", "fresh-skill", "SKILL.md");
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, "---\nname: fresh-skill\ndescription: d\n---\nVERSION-ONE\n");
		const stamp = new Date("2026-01-01T00:00:00Z");
		fs.utimesSync(skillFile, stamp, stamp);

		const first = resolveSkills(["fresh-skill"], cwd);
		assert.match(first.resolved[0]?.content ?? "", /VERSION-ONE/);

		// Same length, same timestamp: a copy keyed by mtime would serve the old text.
		fs.writeFileSync(skillFile, "---\nname: fresh-skill\ndescription: d\n---\nVERSION-TWO\n");
		fs.utimesSync(skillFile, stamp, stamp);

		const second = resolveSkills(["fresh-skill"], cwd);
		assert.match(second.resolved[0]?.content ?? "", /VERSION-TWO/);
		assert.doesNotMatch(second.resolved[0]?.content ?? "", /VERSION-ONE/);
	});
});
