import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectAgentDefinitionDirectory, type AgentDefinitionInspectionFs } from "../../src/agents/agents.ts";

function recordingFs(readDirs: string[]): AgentDefinitionInspectionFs {
	return {
		existsSync: fs.existsSync,
		realpathSync: fs.realpathSync,
		statSync: fs.statSync,
		readdirSync: (dir) => {
			readDirs.push(path.resolve(dir));
			return fs.readdirSync(dir, { withFileTypes: true });
		},
	};
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

describe("agent definition walk and skill packs", () => {
	it("never reads a .agents/skills subtree, because its files are never agent definitions", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-walk-"));
		try {
			const root = path.join(tempDir, ".agents");
			fs.mkdirSync(path.join(root, "rules"), { recursive: true });
			fs.writeFileSync(path.join(root, "rules", "reviewer.md"), "---\nname: reviewer\ndescription: review\n---\nBody\n");
			const packDir = path.join(root, "skills", "pack", "deep", "nested");
			fs.mkdirSync(packDir, { recursive: true });
			fs.writeFileSync(path.join(packDir, "SKILL.md"), "---\nname: deep\n---\nSkill\n");
			fs.writeFileSync(path.join(root, "skills", "pack", "looks-like-agent.md"), "---\nname: not-an-agent\n---\n");

			const readDirs: string[] = [];
			const inspection = inspectAgentDefinitionDirectory(root, recordingFs(readDirs));

			assert.deepEqual(inspection.files, [path.join(root, "rules", "reviewer.md")]);
			assert.deepEqual(readDirs.filter((dir) => isWithin(path.resolve(root, "skills"), dir)), []);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prunes a .agents/skills subtree under any scanned root, not only a root named .agents", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-walk-nested-"));
		try {
			const root = path.join(tempDir, "agents");
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(path.join(root, "planner.md"), "---\nname: planner\ndescription: plan\n---\nBody\n");
			const skillPack = path.join(root, ".agents", "skills", "pack");
			fs.mkdirSync(skillPack, { recursive: true });
			fs.writeFileSync(path.join(skillPack, "agent-shaped.md"), "---\nname: nested\n---\n");

			const readDirs: string[] = [];
			const inspection = inspectAgentDefinitionDirectory(root, recordingFs(readDirs));

			assert.deepEqual(inspection.files, [path.join(root, "planner.md")]);
			assert.deepEqual(readDirs.filter((dir) => isWithin(path.resolve(root, ".agents", "skills"), dir)), []);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
