import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../agents/agents.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { appendAgentRefinementOverlay } from "../../agents/agent-refinements.ts";
import { buildSkillInjection } from "../../agents/skills.ts";

export interface EffectiveSystemPromptInput {
	/** Agent as handed to the child, including runtime-declared overlays such as the Intercom bridge. */
	agent: AgentConfig;
	resolvedSkills: Parameters<typeof buildSkillInjection>[0];
	/** Directory that scopes memory and refinement lookups. */
	cwd: string;
	/** The launching session's project trust; `false` leaves out the project's refinement overlay and project-scope memory. */
	projectTrusted?: boolean;
}

function appendSection(prompt: string, section: string): string {
	return prompt ? `${prompt}\n\n${section}` : section;
}

function instructionFileContent(): string | undefined {
	const configured = process.env.PI_SUBAGENTS_INSTRUCTION_FILE;
	if (configured === undefined) return undefined;
	const expanded = configured === "~" ? os.homedir() : /^~[\\/]/.test(configured) ? path.join(os.homedir(), configured.slice(2)) : configured;
	if (!path.isAbsolute(expanded)) throw new Error(`PI_SUBAGENTS_INSTRUCTION_FILE must be an absolute path or start with ~/: '${configured}'.`);
	const file = path.resolve(expanded);
	try {
		const content = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
		return `Configured instruction file (${file}):\n${content}`;
	} catch (cause) {
		throw new Error(`Cannot read PI_SUBAGENTS_INSTRUCTION_FILE '${file}' as UTF-8: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	}
}

/**
 * Child system prompt in the order preflight and every execution path hash:
 * base prompt, optional instruction-file content, skills, memory, refinement overlay. The per-run output path goes
 * in the task message, so a child resumed with a new output path keeps the same
 * system prompt and its provider prompt cache. Runtime acceptance prose is
 * appended later and stays outside launch identity.
 */
export function buildEffectiveSystemPrompt(input: EffectiveSystemPromptInput): string {
	let prompt = input.agent.systemPrompt?.trim() ?? "";
	const instructionFile = instructionFileContent();
	if (instructionFile) prompt = appendSection(prompt, instructionFile);
	if (input.resolvedSkills.length > 0) prompt = appendSection(prompt, buildSkillInjection(input.resolvedSkills));
	const memoryInjection = buildAgentMemoryInjection(input.agent, input.cwd, input.projectTrusted);
	if (memoryInjection) prompt = appendSection(prompt, memoryInjection);
	if (input.projectTrusted !== false) prompt = appendAgentRefinementOverlay(prompt, { cwd: input.cwd, agentName: input.agent.name });
	return prompt;
}
