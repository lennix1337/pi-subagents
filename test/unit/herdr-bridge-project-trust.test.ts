import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import netModule from "node:net";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import registerHerdrPiBridge from "../../src/extension/herdr-pi-bridge.ts";
import { encodeHerdrPiFrame, HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV, HerdrPiFrameDecoder } from "../../src/runs/shared/herdr-pi-protocol.ts";
import { writeFixtureTree } from "../support/helpers.ts";

const RUN_ID = "run_trust001";
const SENTINELS = ["REMOTE_PROJECT_MEMORY", "REMOTE_PROJECT_SKILL_SHARED", "REMOTE_PROJECT_REFINEMENT"] as const;

interface FakeBridgeSocket extends EventEmitter {
	write(chunk: Buffer): boolean;
	destroy(error?: Error): void;
}

interface BridgeFrame {
	type: string;
}

interface BridgePromptEvent {
	systemPrompt: string;
}

type BridgeHandler = (event: BridgePromptEvent | undefined, ctx: RemoteContext | undefined) => { systemPrompt: string } | undefined;

interface ConfigureResources {
	agent: string;
	skills?: string[];
	toolCeiling: string[];
}

/** The remote Pi session context the bridge reads; `isProjectTrusted` is absent on hosts older than Pi's trust concept. */
interface RemoteContext {
	sessionManager: { getSessionId(): string; getSessionFile(): string };
	getActiveTools(): string[];
	model: { provider: string; id: string };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	isProjectTrusted?: () => boolean;
}

/** The bridge's executed configure path, driven through a fake `node:net` server so no socket or remote host is used. */
function startBridge() {
	const handlers = new Map<string, BridgeHandler>();
	const pi = { registerTool() {}, registerCommand() {}, on(name: string, handler: BridgeHandler) { handlers.set(name, handler); }, setActiveTools() {} };
	let connect: ((socket: FakeBridgeSocket) => void) | undefined;
	const originalCreateServer = netModule.createServer;
	// SAFETY: the bridge calls only listen and close on the server and registers one connection listener.
	netModule.createServer = ((listener: (socket: FakeBridgeSocket) => void) => {
		connect = listener;
		return { listen() {}, close() {} };
	}) as unknown as typeof netModule.createServer;
	syncBuiltinESMExports();
	try {
		// SAFETY: the bridge uses only registerTool, registerCommand, on and setActiveTools of the extension API.
		registerHerdrPiBridge(pi as never);
	} finally {
		netModule.createServer = originalCreateServer;
		syncBuiltinESMExports();
	}
	const frames: BridgeFrame[] = [];
	const decoder = new HerdrPiFrameDecoder();
	let destroyedWith: Error | undefined;
	const socket: FakeBridgeSocket = Object.assign(new EventEmitter(), {
		write(chunk: Buffer) { frames.push(...decoder.push(chunk)); return true; },
		destroy(error?: Error) { destroyedWith = error; },
	});
	connect?.(socket);
	return {
		handlers,
		frames,
		destroyedWith: () => destroyedWith,
		startSession(ctx: RemoteContext) { handlers.get("session_start")?.(undefined, ctx); },
		configure(resources: ConfigureResources) { socket.emit("data", encodeHerdrPiFrame({ protocol: 1, runId: RUN_ID, type: "configure", requestId: "cfg", resources })); },
		agentPrompt: () => handlers.get("before_agent_start")?.({ systemPrompt: "base" }, undefined)?.systemPrompt ?? "",
	};
}

function remoteContext(trust: Pick<RemoteContext, "isProjectTrusted">): RemoteContext {
	return {
		sessionManager: { getSessionId: () => "native", getSessionFile: () => "/remote/session" },
		getActiveTools: () => ["read"],
		model: { provider: "p", id: "m" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		...trust,
	};
}

// The remote Pi's own trust governs the remote machine's project files. Resource assembly runs in the bridge's
// `configure` handler, so these tests drive that handler rather than the helper.
describe("pane-native bridge project trust", () => {
	const previous = { cwd: process.cwd(), run: process.env[HERDR_PI_RUN_ENV], dir: process.env[HERDR_PI_RUNTIME_DIR_ENV], agentDir: process.env.PI_CODING_AGENT_DIR };
	const realFetch = globalThis.fetch;
	let root = "";
	let runtimeDir = "";
	let bridge: ReturnType<typeof startBridge> | undefined;

	beforeEach(() => {
		// A bridge, skill or refinement lookup that tried the network would fail here rather than leave the machine.
		// SAFETY: the stub rejects every call, which is all a caller of fetch observes here.
		globalThis.fetch = (() => Promise.reject(new Error("outbound network is rejected in this test"))) as typeof fetch;
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-trust-"));
		const agentDir = path.join(root, "agent-dir");
		const project = path.join(root, "remote-project");
		runtimeDir = path.join(root, "run");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		fs.mkdirSync(runtimeDir);
		writeFixtureTree(agentDir, [
			["agents/remote-user.md", "---\nname: remote-user\ndescription: Remote user agent\ntools: read\nskills: shared-skill\nmemory: { scope: project, path: remote-user }\n---\nREMOTE_USER_AGENT\n"],
			["skills/shared-skill/SKILL.md", "---\ndescription: REMOTE_USER_SKILL\n---\nbody\n"],
		]);
		writeFixtureTree(project, [
			[".pi/skills/shared-skill/SKILL.md", "---\ndescription: REMOTE_PROJECT_SKILL_SHARED\n---\nbody\n"],
			[".pi/skills/project-only-skill/SKILL.md", "---\ndescription: REMOTE_PROJECT_SKILL\n---\nbody\n"],
			[".pi/agent-memory/remote-user/MEMORY.md", "REMOTE_PROJECT_MEMORY\n"],
			[".pi/subagents/refinements/remote-user.md", `<!-- pi-subagents-refinement:v1\n${JSON.stringify({ agent: "remote-user", revision: 1, updatedAt: "2026-01-01T00:00:00.000Z", base: { source: "user", filePath: "remote-user.md", systemPromptSha256: "0" }, evidence: {} })}\n-->\n\n\`\`\`pi-subagents-refinement-current\nREMOTE_PROJECT_REFINEMENT\n\`\`\`\n\n\`\`\`pi-subagents-refinement-snapshots-json\n[]\n\`\`\`\n`],
			[".pi/agents/remote-project-agent.md", "---\nname: remote-project-agent\ndescription: Remote project agent\ntools: read\n---\nREMOTE_PROJECT_AGENT\n"],
		]);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env[HERDR_PI_RUN_ENV] = RUN_ID;
		process.env[HERDR_PI_RUNTIME_DIR_ENV] = runtimeDir;
		process.chdir(project);
	});

	afterEach(() => {
		bridge?.handlers.get("session_shutdown")?.(undefined, undefined);
		bridge = undefined;
		process.chdir(previous.cwd);
		globalThis.fetch = realFetch;
		for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], [HERDR_PI_RUN_ENV, previous.run], [HERDR_PI_RUNTIME_DIR_ENV, previous.dir]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	function configureWith(trust: Pick<RemoteContext, "isProjectTrusted">, resources: ConfigureResources = { agent: "remote-user", toolCeiling: ["read"] }) {
		bridge = startBridge();
		bridge.startSession(remoteContext(trust));
		bridge.configure(resources);
		return bridge;
	}

	it("leaves the remote project's skills, memory and refinement out when the remote Pi declined trust", () => {
		const configured = configureWith({ isProjectTrusted: () => false });
		assert.equal(configured.destroyedWith(), undefined);
		assert.ok(configured.frames.some((frame) => frame.type === "configured"));
		const prompt = configured.agentPrompt();
		assert.match(prompt, /REMOTE_USER_AGENT/u);
		assert.match(prompt, /REMOTE_USER_SKILL/u, "the remote user skill of the same name still resolves");
		for (const sentinel of SENTINELS) assert.doesNotMatch(prompt, new RegExp(sentinel, "u"));
	});

	it("fails closed on a skill only the remote project provides when the remote Pi declined trust", () => {
		const configured = configureWith({ isProjectTrusted: () => false }, { agent: "remote-user", skills: ["project-only-skill"], toolCeiling: ["read"] });
		assert.match(configured.destroyedWith()?.message ?? "", /Remote Pi skills not found: project-only-skill/u);
		assert.equal(configured.frames.some((frame) => frame.type === "configured"), false);
	});

	it("does not resolve a remote project agent when the remote Pi declined trust", () => {
		const configured = configureWith({ isProjectTrusted: () => false }, { agent: "remote-project-agent", toolCeiling: ["read"] });
		assert.match(configured.destroyedWith()?.message ?? "", /not found unambiguously/u);
		assert.equal(configured.frames.some((frame) => frame.type === "configured"), false);
	});

	for (const [label, trust] of [["trusts the project", { isProjectTrusted: () => true }], ["predates Pi's trust concept", {}]] as const) {
		it(`keeps the remote project inputs when the remote Pi ${label}`, () => {
			const configured = configureWith(trust);
			assert.equal(configured.destroyedWith(), undefined);
			const prompt = configured.agentPrompt();
			for (const sentinel of SENTINELS) assert.match(prompt, new RegExp(sentinel, "u"));
			assert.match(prompt, /REMOTE_PROJECT_SKILL_SHARED/u, "the project skill outranks the user skill of the same name");
		});
	}

	it("fails closed before reading project inputs when the remote session has no trust context yet", () => {
		bridge = startBridge();
		bridge.configure({ agent: "remote-user", toolCeiling: ["read"] });
		assert.match(bridge.destroyedWith()?.message ?? "", /project trust is unknown/u);
		assert.equal(bridge.frames.some((frame) => frame.type === "configured"), false);
	});
});
