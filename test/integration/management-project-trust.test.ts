import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

// Drives the production extension wiring (src/extension/index.ts), so a dropped trust option is caught.
const script = String.raw`
	import fs from "node:fs";
	import path from "node:path";
	const { default: register } = await import("./src/extension/index.ts");
	const root = process.env.TRUST_FIXTURE_ROOT;
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "agents", "project-secret.md"), "---\nname: project-secret\ndescription: Project-only description\n---\nProject-only system prompt.\n");
	let tool;
	const pi = new Proxy({
		events: { on() { return () => {}; }, emit() {} },
		on() {}, registerTool(value) { if (value.name === "subagent") tool = value; },
		getActiveTools() { return ["subagent"]; },
	}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
	register(pi);
	const makeCtx = (trusted) => ({
		cwd: project, isIdle() { return false; }, hasUI: false, model: { provider: "test", id: "test" },
		isProjectTrusted: () => trusted,
		modelRegistry: { getAvailable() { return [{ provider: "test", id: "test", reasoning: false }]; }, getAll() { return []; }, find(provider, id) { return { provider, id, reasoning: false }; }, hasConfiguredAuth() { return true; } },
		sessionManager: { getSessionId() { return "trust-session"; }, getSessionFile() { return undefined; }, getBranch() { return []; } },
	});
	const run = async (trusted, params) => {
		try {
			const result = await tool.execute("call", params, new AbortController().signal, undefined, makeCtx(trusted));
			return { isError: false, text: result.content.map((part) => part.text).join("\n") };
		} catch (error) {
			return { isError: true, text: String(error instanceof Error ? error.message : error) };
		}
	};
	const out = {};
	for (const trusted of [true, false]) {
		out[trusted] = {
			list: await run(trusted, { action: "list" }),
			get: await run(trusted, { action: "get", agent: "project-secret" }),
			models: await run(trusted, { action: "models" }),
			doctor: await run(trusted, { action: "doctor" }),
		};
	}
	const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
	const agentFiles = () => files(path.join(project, ".pi", "agents"));
	const settingsExist = () => fs.existsSync(path.join(project, ".pi", "settings.json"));
	const newAgent = (name, scope) => ({ name, description: "Created in test", systemPrompt: "Created.", ...(scope ? { scope } : {}) });
	const before = agentFiles();
	out.declinedProject = {
		list: await run(false, { action: "list", agentScope: "project" }),
		get: await run(false, { action: "get", agent: "project-secret", agentScope: "project" }),
		models: await run(false, { action: "models", agentScope: "project" }),
		create: await run(false, { action: "create", config: newAgent("declined-create", "project") }),
		createJson: await run(false, { action: "create", config: JSON.stringify(newAgent("declined-json", "project")) }),
		createExisting: await run(false, { action: "create", config: newAgent("project-secret", "project") }),
		update: await run(false, { action: "update", agent: "project-secret", agentScope: "project", config: { description: "Changed" } }),
		disable: await run(false, { action: "disable", agent: "scout", agentScope: "project" }),
		enable: await run(false, { action: "enable", agent: "scout", agentScope: "project" }),
		reset: await run(false, { action: "reset", agent: "scout", agentScope: "project" }),
		eject: await run(false, { action: "eject", agent: "scout", agentScope: "project" }),
		delete: await run(false, { action: "delete", agent: "project-secret", agentScope: "project" }),
		userCreate: await run(false, { action: "create", config: newAgent("declined-user-create", "user") }),
		refine: await run(false, { action: "refine", agent: "project-secret" }),
		refineShow: await run(false, { action: "refine.show", agent: "project-secret" }),
		refineRollback: await run(false, { action: "refine.rollback", agent: "project-secret" }),
		watchdogProject: await run(false, { action: "watchdog.configure", scope: "project", model: "test/test", thinking: "off" }),
		watchdogUser: await run(false, { action: "watchdog.configure", scope: "user", model: "test/test", thinking: "off" }),
		filesChanged: JSON.stringify(agentFiles()) !== JSON.stringify(before),
		files: agentFiles(),
		settingsWritten: settingsExist(),
	};
	out.trustedProject = {
		create: await run(true, { action: "create", config: newAgent("trusted-create", "project") }),
		disable: await run(true, { action: "disable", agent: "scout", agentScope: "project" }),
		refineShow: await run(true, { action: "refine.show", agent: "project-secret" }),
		watchdogProject: await run(true, { action: "watchdog.configure", scope: "project", model: "test/test", thinking: "off" }),
		files: agentFiles(),
		settingsWritten: settingsExist(),
	};
	process.stdout.write(JSON.stringify(out));
`;

type Outcome = { isError: boolean; text: string };
type Fixture = {
	true: Record<"list" | "get" | "models" | "doctor", Outcome>;
	false: Record<"list" | "get" | "models" | "doctor", Outcome>;
	declinedProject: Record<"list" | "get" | "models" | "create" | "createJson" | "createExisting" | "update" | "disable" | "enable" | "reset" | "eject" | "delete" | "userCreate" | "refine" | "refineShow" | "refineRollback" | "watchdogProject" | "watchdogUser", Outcome> & { filesChanged: boolean; files: string[]; settingsWritten: boolean };
	trustedProject: Record<"create" | "disable" | "refineShow" | "watchdogProject", Outcome> & { files: string[]; settingsWritten: boolean };
};

function runFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-trust-"));
	try {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], {
			cwd: process.cwd(), encoding: "utf-8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_CODING_AGENT_DIR: path.join(root, "agent"), TRUST_FIXTURE_ROOT: root },
		});
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout) as Fixture;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("management actions follow the session's project trust", () => {
	const fixture = runFixture();

	it("hides project agents from list, get, models and doctor when the session declined trust", () => {
		const out = fixture;
		assert.match(out.true.list.text, /project-secret/, "trusted control lists the project agent");
		assert.match(out.true.get.text, /Project-only system prompt/, "trusted control reads the project agent");
		assert.match(out.true.doctor.text, /project 1/, "trusted control counts the project agent");
		for (const action of ["list", "models", "doctor"] as const) {
			assert.doesNotMatch(out.false[action].text, /project-secret|Project-only/, `${action} must not expose project agents`);
		}
		assert.doesNotMatch(out.false.get.text, /Project-only/, "get must not expose the project agent");
		assert.equal(out.false.get.isError, true);
		assert.match(out.false.get.text, /Agent 'project-secret' not found\. Available: /);
		assert.doesNotMatch(out.false.get.text, /Available:.*project-secret/);
		assert.doesNotMatch(out.false.doctor.text, /project 1/, "doctor must not count project agents");
	});

	it("refuses project-scope management with the trust message and writes nothing when the session declined trust", () => {
		const declined = fixture.declinedProject;
		const projectActions = ["list", "get", "models", "create", "createJson", "createExisting", "update", "disable", "enable", "reset", "eject", "delete"] as const;
		for (const action of projectActions) {
			assert.equal(declined[action].isError, true, `${action} must be refused`);
			assert.match(declined[action].text, /agentScope: "project" requires project trust\. This session declined trust for /, `${action} must name the real cause`);
			assert.doesNotMatch(declined[action].text, /project config root|already exists|not a valid agent definition|not found/, `${action} must not give a misleading cause`);
		}
		assert.equal(declined.filesChanged, false, "declined create/eject must not write project agent files");
		assert.deepEqual(declined.files, ["project-secret.md"]);
		assert.equal(declined.settingsWritten, false, "declined disable/enable/reset must not write project settings");
		assert.equal(declined.userCreate.isError, false, "user-scope management stays available when trust is declined");
	});

	it("refuses refinement and project-scope watchdog actions with a project-trust error and writes nothing when the session declined trust", () => {
		const declined = fixture.declinedProject;
		for (const action of ["refine", "refineShow", "refineRollback", "watchdogProject"] as const) {
			assert.equal(declined[action].isError, true, `${action} must be refused`);
			assert.match(declined[action].text, /requires project trust\. This session declined trust, so /, `${action} must name the real cause`);
			assert.doesNotMatch(declined[action].text, /No refinement overlay|configured|Updated:|not found/, `${action} must not resolve project state`);
		}
		assert.equal(declined.settingsWritten, false, "declined watchdog.configure must not write project settings");
		assert.equal(declined.watchdogUser.isError, false, declined.watchdogUser.text);
	});

	it("keeps project-scope create and disable working when the session trusted the project", () => {
		const trusted = fixture.trustedProject;
		assert.equal(trusted.create.isError, false, trusted.create.text);
		assert.deepEqual(trusted.files, ["project-secret.md", "trusted-create.md"]);
		assert.equal(trusted.disable.isError, false, trusted.disable.text);
		assert.equal(trusted.settingsWritten, true);
		assert.equal(trusted.refineShow.isError, false, trusted.refineShow.text);
		assert.equal(trusted.watchdogProject.isError, false, trusted.watchdogProject.text);
	});
});
