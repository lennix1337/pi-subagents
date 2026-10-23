import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { makeMinimalCtx, writeFixtureTree } from "../support/helpers.ts";
import {
	available, createSubagentExecutor, installAsyncExecutionHooks, isAsyncAvailable, mockPi, readAsyncPayload, tempDir,
	waitForMockPiCall, waitForMockPiRuntime, type AsyncExecutionResult,
} from "../support/async-execution-fixture.ts";

const REFINEMENT_SENTINEL = "PROJECT_REFINEMENT_SENTINEL";
const PROJECT_MEMORY_SENTINEL = "PROJECT_MEMORY_SENTINEL";
const PROJECT_SKILL_SENTINEL = "PROJECT_ONLY_SKILL_SENTINEL";
const PROJECT_SHARED_SKILL_SENTINEL = "PROJECT_SHARED_SKILL_SENTINEL";
const USER_SHARED_SKILL_SENTINEL = "USER_SHARED_SKILL_SENTINEL";

function writeSkill(root: string, name: string, description: string): void {
	writeFixtureTree(root, [[`${name}/SKILL.md`, `---\ndescription: ${description}\n---\nbody\n`]]);
}

function writeMemory(root: string, content: string): void {
	writeFixtureTree(root, [["agent-memory/trust-probe/MEMORY.md", `${content}\n`]]);
}

function writeProjectSettings(projectDir: string, settings: string): void {
	writeFixtureTree(projectDir, [[".pi/settings.json", settings]]);
}

interface ChildLaunch {
	systemPrompt: string;
	childWatchdog: { model?: string } | undefined;
}

/** What each scripted child (foreground, background runner, workflow) was launched with, in launch order. */
async function childLaunches(): Promise<ChildLaunch[]> {
	const launches: ChildLaunch[] = [];
	for (let index = 0; index < mockPi.callCount(); index++) {
		const call = await waitForMockPiCall(mockPi, index);
		const runtime = await waitForMockPiRuntime(mockPi, index);
		// SAFETY: the mock runtime records the launch's childWatchdog object as written.
		launches.push({ systemPrompt: call.systemPrompts.map((prompt) => prompt.text ?? "").join("\n"), childWatchdog: runtime.childWatchdog as ChildLaunch["childWatchdog"] });
	}
	return launches;
}

// Project-controlled files that reach a child's prompt or a launch decision: the refinement overlay, project
// skills and project memory of a user-level agent, and the watchdog settings the launch resolves. A session that
// declined trust ignores all of them; user-level skills and memory keep applying.
describe("project trust reaches project-controlled child inputs", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();
	const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	const realFetch = globalThis.fetch;
	let project = "";

	beforeEach(() => {
		// Offline: a child, watchdog, or probe that tried the network would fail here rather than leave the machine.
		// SAFETY: the stub rejects every call, which is all a caller of fetch observes here.
		globalThis.fetch = (() => Promise.reject(new Error("outbound network is rejected in this test"))) as typeof fetch;
		const home = path.join(tempDir, "trust-home");
		const agentDir = path.join(home, ".pi", "agent");
		project = path.join(tempDir, "trust-project");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "trust-probe.md"), "---\nname: trust-probe\ndescription: Trust probe\nskills: shared-skill, project-only-skill\nmemory: { scope: project, path: trust-probe }\n---\nUser body.\n", "utf-8");
		writeSkill(path.join(agentDir, "skills"), "shared-skill", USER_SHARED_SKILL_SENTINEL);
		writeSkill(path.join(project, ".pi", "skills"), "shared-skill", PROJECT_SHARED_SKILL_SENTINEL);
		writeSkill(path.join(project, ".pi", "skills"), "project-only-skill", PROJECT_SKILL_SENTINEL);
		writeMemory(path.join(project, ".pi"), PROJECT_MEMORY_SENTINEL);
		const refinementPath = path.join(project, ".pi", "subagents", "refinements", "trust-probe.md");
		fs.mkdirSync(path.dirname(refinementPath), { recursive: true });
		fs.writeFileSync(refinementPath, `<!-- pi-subagents-refinement:v1
{"agent":"trust-probe","revision":1,"updatedAt":"2026-01-01T00:00:00.000Z","base":{"source":"user","filePath":"trust-probe.md","systemPromptSha256":"0"},"evidence":{"maxItems":8,"maxAgeDays":14,"itemBytes":2048,"totalBytes":16384}}
-->

\`\`\`pi-subagents-refinement-current
${REFINEMENT_SENTINEL}
\`\`\`

\`\`\`pi-subagents-refinement-snapshots-json
[]
\`\`\`
`, "utf-8");
		writeProjectSettings(project, JSON.stringify({ subagents: { watchdog: { enabled: true, children: { enabled: true, model: "openai/astra" } } } }));
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	function makeExecutor() {
		return createSubagentExecutor!({
			// SAFETY: the executor only subscribes to events and reads the session name in these paths.
			pi: { events: { on: () => () => {}, emit() {} }, getSessionName: () => undefined } as never,
			state: { baseCwd: project, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: (cwd, scope, provider, options) => discoverAgents(cwd, scope, provider, { globalNpmRoot: null, ...options }),
		});
	}

	async function launchForegroundBackgroundAndWorkflow(trusted: boolean): Promise<void> {
		const executor = makeExecutor();
		const ctx = { ...makeMinimalCtx(project), isProjectTrusted: () => trusted };
		const signal = new AbortController().signal;
		mockPi.onCall({ output: "foreground done" });
		const foreground = await executor.execute(`trust-fg-${trusted}`, { agent: "trust-probe", task: "Inspect", acceptance: false }, signal, undefined, ctx);
		assert.equal(foreground.isError, undefined, foreground.content[0]?.text);
		mockPi.onCall({ output: "background done" });
		// SAFETY: an async launch returns its asyncId details, checked by readAsyncPayload below.
		const background = await executor.execute(`trust-bg-${trusted}`, { agent: "trust-probe", task: "Inspect", async: true, acceptance: false }, signal, undefined, ctx) as AsyncExecutionResult;
		assert.equal(background.isError, undefined, background.content[0]?.text);
		await readAsyncPayload(background.details.asyncId!);
		mockPi.onCall({ output: "workflow child done" });
		const workflow = await executor.execute(`trust-wf-${trusted}`, { workflowScript: `return await runs.run("child", { agent: "trust-probe", task: "Inspect" });`, async: false, mission: false }, signal, undefined, ctx);
		assert.equal(workflow.isError, undefined, workflow.content[0]?.text);
	}

	it("omits project refinement, skills, memory and watchdog config from foreground, background and workflow children when trust was declined", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		await launchForegroundBackgroundAndWorkflow(false);
		const launches = await childLaunches();
		assert.equal(launches.length, 3);
		for (const launch of launches) {
			assert.doesNotMatch(launch.systemPrompt, new RegExp(`${REFINEMENT_SENTINEL}|${PROJECT_MEMORY_SENTINEL}|${PROJECT_SKILL_SENTINEL}|${PROJECT_SHARED_SKILL_SENTINEL}`));
			assert.match(launch.systemPrompt, new RegExp(USER_SHARED_SKILL_SENTINEL), "the user-level skill of the same name still resolves");
			assert.equal(launch.childWatchdog, undefined, "declined trust ignores the project's watchdog settings");
		}
	});

	it("keeps the project inputs when the session trusts the project", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		await launchForegroundBackgroundAndWorkflow(true);
		const launches = await childLaunches();
		assert.equal(launches.length, 3);
		for (const launch of launches) {
			assert.match(launch.systemPrompt, new RegExp(REFINEMENT_SENTINEL));
			assert.match(launch.systemPrompt, new RegExp(PROJECT_MEMORY_SENTINEL));
			assert.match(launch.systemPrompt, new RegExp(PROJECT_SKILL_SENTINEL));
			assert.match(launch.systemPrompt, new RegExp(PROJECT_SHARED_SKILL_SENTINEL), "the project skill outranks the user skill of the same name");
			assert.doesNotMatch(launch.systemPrompt, new RegExp(USER_SHARED_SKILL_SENTINEL));
			assert.equal(launch.childWatchdog?.model, "openai/astra");
		}
	});

	it("applies project watchdog launch rules only when the session trusts the project", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		writeProjectSettings(project, JSON.stringify({ subagents: { watchdog: { enabled: true, rules: { action: "block", roleModels: { "trust-probe": { deny: ["openai/*"] } } } } } }));
		const executor = makeExecutor();
		const params = { agent: "trust-probe", task: "Inspect", model: "openai/luna", acceptance: false };
		const signal = new AbortController().signal;
		const trusted = await executor.execute("rules-trusted", params, signal, undefined, { ...makeMinimalCtx(project), isProjectTrusted: () => true });
		assert.equal(trusted.isError, true);
		assert.match(trusted.content[0]?.text ?? "", /Launch blocked by subagents\.watchdog\.rules/);

		mockPi.onCall({ output: "foreground done" });
		const declined = await executor.execute("rules-declined", params, signal, undefined, { ...makeMinimalCtx(project), isProjectTrusted: () => false });
		assert.equal(declined.isError, undefined, declined.content[0]?.text);

		mockPi.onCall({ output: "background done" });
		// SAFETY: an async launch returns its asyncId details, checked by readAsyncPayload below.
		const background = await executor.execute("rules-declined-bg", { ...params, async: true }, signal, undefined, { ...makeMinimalCtx(project), isProjectTrusted: () => false }) as AsyncExecutionResult;
		assert.equal(background.isError, undefined, background.content[0]?.text);
		await readAsyncPayload(background.details.asyncId!);
	});
});
