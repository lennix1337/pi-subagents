import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { PROPERTY_CASES, intBetween, pick, seededRandom, shuffled, type Rng } from "../support/seeded-random.ts";

// Property test for `subagents.defaultModelByProvider`: the default for a parent session's provider is the
// entry for that exact provider or, failing that, for its longest family prefix ending at a `-` boundary
// (`openai` matches `openai-codex-account-2`, `anthropic` does not match `anthropicx`). A bare model id runs on
// the parent's own provider; an id with a `/` is used as written. The model below states that rule directly.

const FALLBACK = "openai-codex-account-2/gpt-6.1-terra:low";
const KEY_POOL = ["anthropic", "anthropic-account", "openai", "openai-codex", "openai-codex-account", "open", "openrouter"];
const VALUE_POOL = ["claude-sonnet-5-5:low", "gpt-6.1-terra:high", "vendor/model:low", "m-a"];
const PARENT_POOL = [
	"anthropic", "anthropic-account", "anthropic-account-2", "anthropic-2", "anthropicx",
	"openai", "openai-codex", "openai-codex-account-2", "openai-codexx", "open", "open-ai",
	"openrouter", "openrouter-free", "x-anthropic", "constructor", "toString",
];

let tempHome = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function randomByProvider(next: Rng): Record<string, string> {
	const byProvider: Record<string, string> = {};
	for (const key of shuffled(next, KEY_POOL).slice(0, intBetween(next, 1, 5))) byProvider[key] = pick(next, VALUE_POOL);
	return byProvider;
}

// Nested families (`openai`, `openai-codex`, `openai-codex-account`) are what the longest-prefix rule decides.
function randomParent(next: Rng, byProvider: Record<string, string>): string {
	const keys = Object.keys(byProvider);
	const roll = next();
	if (roll < 0.2) return pick(next, keys);
	if (roll < 0.6) return `${pick(next, keys)}-${pick(next, ["codex", "account", "account-2", "x", "2"])}`;
	return `${pick(next, PARENT_POOL)}${pick(next, ["", "", "-2", "x", "-account-3"])}`;
}

/** The worker's model for a parent provider. A throw on a legal provider name is reported as a failed property. */
function workerModel(project: string, parent: string): string | undefined {
	let worker: { model?: string } | undefined;
	try {
		worker = discoverAgents(project, "both", parent, { globalNpmRoot: null }).agents.find((agent) => agent.name === "worker");
	} catch (error) {
		assert.fail(`discovery threw for parent ${JSON.stringify(parent)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	assert.ok(worker, `builtin worker agent not discovered for parent ${JSON.stringify(parent)}`);
	return worker.model;
}

function expectedDefault(byProvider: Record<string, string>, parent: string): string {
	const family = Object.hasOwn(byProvider, parent)
		? parent
		: Object.keys(byProvider)
			.filter((candidate) => parent.startsWith(`${candidate}-`))
			.sort((a, b) => b.length - a.length)[0];
	if (family === undefined) return FALLBACK;
	const value = byProvider[family]!;
	return value.includes("/") ? value : `${parent}/${value}`;
}

describe("provider default model (property tests)", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		if (originalExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = originalExtraAgentDirs;
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("property: the worker's model follows the longest family prefix, exact provider first, else the fallback", () => {
		const outcomes = new Set<string>();
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const byProvider = randomByProvider(next);
			const parent = randomParent(next, byProvider);
			writeJson(settingsPath, { subagents: { defaultModel: FALLBACK, defaultModelByProvider: byProvider } });
			// A fresh project directory per case: discovery results are cached per directory and provider.
			const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
			try {
				const expected = expectedDefault(byProvider, parent);
				outcomes.add(expected);
				assert.equal(workerModel(project, parent), expected, `seed ${seed}: parent ${JSON.stringify(parent)} with ${JSON.stringify(byProvider)}`);
			} finally {
				fs.rmSync(project, { recursive: true, force: true });
			}
		}
		assert.ok(outcomes.size >= 12, `generator coverage: only ${outcomes.size} distinct outcomes`);
	});

	it("property: a provider that only shares a string prefix, without the dash boundary, gets no family default", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, { subagents: { defaultModel: FALLBACK, defaultModelByProvider: { anthropic: "claude-sonnet-5-5:low" } } });
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const parent = `anthropic${pick(next, ["x", "2", "ai", "_1", "s"])}${next() < 0.5 ? "-account" : ""}`;
			const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
			try {
				assert.equal(workerModel(project, parent), FALLBACK, `seed ${seed}: ${parent} matched the anthropic family`);
			} finally {
				fs.rmSync(project, { recursive: true, force: true });
			}
		}
	});

	it("property: names inherited from Object.prototype are not provider families", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, { subagents: { defaultModel: FALLBACK, defaultModelByProvider: { anthropic: "claude-sonnet-5-5:low" } } });
		for (const parent of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
			try {
				assert.equal(workerModel(project, parent), FALLBACK, `${parent} read an inherited property as its default model`);
			} finally {
				fs.rmSync(project, { recursive: true, force: true });
			}
		}
	});
});
