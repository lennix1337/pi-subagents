import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MODEL_ONLY_TOOL } from "../shared/extension-context.ts";
import type { ToolActivationMode } from "../shared/types.ts";
import { registerPinnedTool } from "./declaration-pinning.ts";
import { listBackgroundWorkProviders } from "../api/background-work.ts";
import { CONTACT_SUPERVISOR_TOOL_NAME as SUPERVISOR_NAME, NATIVE_SUPERVISOR_TOOL_NAME as PARENT_SUPERVISOR_NAME } from "../intercom/native-supervisor-channel.ts";

interface ActivationDetails {
	enabled?: string[];
	missing?: string[];
	unavailable?: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
const WAIT_NAME = "bg_wait";
const UNLOAD_SENTINELS = new Set([LOADER_NAME, SUBAGENT_NAME, WAIT_NAME]);

type ToolSelectionMessage = {
	role: string;
	toolsAdded?: readonly { name: string }[];
	toolsRemoved?: readonly { name: string }[];
};

function hasNativeToolSelection(messages: readonly ToolSelectionMessage[]): boolean {
	return messages.some((message) => message.role === "system"
		&& (Object.hasOwn(message, "toolsAdded") || Object.hasOwn(message, "toolsRemoved")));
}

function setSelection(pi: ExtensionAPI, includeSubagent: boolean, includeLoader: boolean, includeWait: boolean, restore: readonly string[] = [], keepParentSupervisor = false): void {
	const next = [...pi.getActiveTools(), ...restore].filter((name) => (includeSubagent || (name !== SUBAGENT_NAME && name !== SUPERVISOR_NAME && (keepParentSupervisor || name !== PARENT_SUPERVISOR_NAME)))
		&& (includeLoader || name !== LOADER_NAME) && (includeWait || name !== WAIT_NAME));
	if (includeSubagent) next.push(SUBAGENT_NAME, SUPERVISOR_NAME, PARENT_SUPERVISOR_NAME);
	if (includeLoader) next.push(LOADER_NAME);
	if (includeWait) next.push(WAIT_NAME);
	pi.setActiveTools([...new Set(next)]);
}

// external: pi-ai transcript handling can resend history under a new leading system message after tool changes.
function addsToolsWithoutCheckpoint(model: ExtensionContext["model"]): boolean {
	const compat = model?.compat as {
		supportsMidConvoSystemMessages?: boolean;
		supportsMidConvoToolChanges?: boolean;
		supportsMidConvoToolAdditions?: boolean;
		supportsAdditionalTools?: boolean;
		supportsToolSearch?: boolean;
	} | undefined;
	if (!model || compat?.supportsMidConvoSystemMessages !== true) return false;
	switch (model.api) {
		case "anthropic-messages": return compat.supportsMidConvoToolChanges === true;
		case "openai-completions": return compat.supportsMidConvoToolAdditions === true;
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses": return compat.supportsAdditionalTools === true || compat.supportsToolSearch === true;
		default: return false;
	}
}

function applyRecordedSelection(pi: ExtensionAPI, ctx: ExtensionContext, mode: "auto" | "dynamic", replyOwed: boolean): boolean {
	const available = pi.getAllTools();
	if (!Array.isArray(available) || !Array.isArray(pi.getActiveTools())) return true;
	if (!available.some((tool) => tool.name === LOADER_NAME)) return true;
	const messages = (ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: ToolSelectionMessage[] } }).buildSessionContext().messages;
	const lost = messages.find((message) => message.role === "system" || message.role === "compactionSummary")?.role === "compactionSummary";
	if (lost || hasNativeToolSelection(messages)) {
		const recorded = new Set<string>();
		const unloadedNames = new Set<string>();
		const declaredSentinels = new Set<string>();
		const evidenced = new Set<string>();
		for (const message of messages) {
			if (message.role !== "system") continue;
			// external: Pi records extension unloads as removals of its active tools.
			// external: Pi removes only declared tools.
			const removedSentinels = (message.toolsRemoved ?? []).filter((tool) => UNLOAD_SENTINELS.has(tool.name));
			const allDeclared = removedSentinels.every((tool) => declaredSentinels.has(tool.name));
			for (const tool of message.toolsRemoved ?? []) declaredSentinels.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) if (UNLOAD_SENTINELS.has(tool.name)) declaredSentinels.add(tool.name);
			const unloaded = removedSentinels.length > 0 && allDeclared && declaredSentinels.size === 0;
			for (const tool of message.toolsRemoved ?? []) {
				if (unloaded) unloadedNames.add(tool.name);
				else {
					recorded.delete(tool.name);
					evidenced.add(tool.name);
				}
			}
			for (const tool of message.toolsAdded ?? []) {
				recorded.add(tool.name);
				evidenced.add(tool.name);
			}
		}
		const fresh = lost && !evidenced.has(LOADER_NAME) && !evidenced.has(SUBAGENT_NAME);
		const startsEager = fresh && mode === "auto" && !addsToolsWithoutCheckpoint(ctx.model);
		const loaderSelected = mode === "dynamic" || recorded.has(LOADER_NAME) || (fresh && !startsEager);
		const source = unloadedNames.size > 0 ? available.find((tool) => tool.name === LOADER_NAME)?.sourceInfo.path : undefined;
		const restore = source === undefined ? [] : available
			.filter((tool) => unloadedNames.has(tool.name) && recorded.has(tool.name) && tool.sourceInfo.path === source)
			.map((tool) => tool.name);
		setSelection(pi, recorded.has(SUBAGENT_NAME) || startsEager, loaderSelected, recorded.has(WAIT_NAME) || (!evidenced.has(WAIT_NAME) && startsEager), replyOwed ? [...restore, PARENT_SUPERVISOR_NAME] : restore, replyOwed || recorded.has(PARENT_SUPERVISOR_NAME));
		return loaderSelected;
	}
	const eager = mode === "auto" && messages.length === 0 && !addsToolsWithoutCheckpoint(ctx.model);
	const kept = (name: string) => eager || (messages.length > 0 && pi.getActiveTools().includes(name));
	setSelection(pi, kept(SUBAGENT_NAME), !eager, kept(WAIT_NAME), replyOwed ? [PARENT_SUPERVISOR_NAME] : [], replyOwed || messages.length > 0);
	return !eager;
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined | Promise<string | undefined>; mode?: ToolActivationMode; hasPendingSupervisorRequest?: () => boolean },
): void {
	const mode = options.mode ?? "auto";
	if (mode === "eager") return;

	// external: DeepSeek can send stray arguments to no-argument tools.
	const parameters = Type.Object({});
	const loader: ToolDefinition<typeof parameters, ActivationDetails> = {
		name: LOADER_NAME,
		...MODEL_ONLY_TOOL,
		label: "Enable Subagents",
		description: "Enable pi-subagents delegation and management tools without launching work. Call when delegation is authorized by the current request or applicable user/project instructions, or when managing existing runs. Direct execution is the default; complexity alone never authorizes delegation. Full tools are available on the next model request.",
		promptSnippet: "pi-subagents is installed. For authorized specialist, independent-review, or parallel work, call subagents_enable, then subagent. Authorization must come from the current request or applicable instructions; complexity alone is not authorization.",
		parameters,
		async execute() {
			if (!pi.getAllTools().some((tool) => tool.name === SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Cannot enable unavailable tools: subagent." }],
				details: { unavailable: [SUBAGENT_NAME] },
			};
			try {
				setSelection(pi, true, true, true);
			} catch (error) {
				return {
					isError: true,
					content: [{ type: "text", text: `Activation failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { missing: [SUBAGENT_NAME] },
				};
			}
			if (!pi.getActiveTools().includes(SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Activation failed: subagent." }],
				details: { missing: [SUBAGENT_NAME] },
			};
			const advertised = await options.advertisedPrompt();
			return {
				content: [{ type: "text", text: `Enabled: subagent. If your tool list includes subagent (possibly prefixed), call it now. Otherwise, wait for the next user prompt; do not retry now. Start Pi with --exclude-tools subagents_enable to keep subagent always available.${advertised ? `\n\n${advertised}` : ""}` }],
				details: { enabled: [SUBAGENT_NAME] },
			};
		},
	};
	registerPinnedTool(pi, loader);

	let loaderSelected = true;
	const replyOwed = () => options.hasPendingSupervisorRequest?.() === true;
	pi.on("session_start", (_event, ctx) => { loaderSelected = applyRecordedSelection(pi, ctx, mode, replyOwed()); });
	pi.on("session_tree", (_event, ctx) => { loaderSelected = applyRecordedSelection(pi, ctx, mode, replyOwed()); });
	pi.on("before_agent_start", (event) => {
		const available = pi.getAllTools();
		if (!Array.isArray(available) || !available.some((tool) => tool.name === LOADER_NAME)) return;
		const providedWait = available.some((tool) => tool.name === WAIT_NAME) && listBackgroundWorkProviders().length > 0;
		const names = [...(loaderSelected ? [LOADER_NAME] : []), ...(providedWait ? [WAIT_NAME] : [])];
		if (names.length === 0) return;
		const selectedTools = event.systemPromptOptions.selectedTools ??= [...pi.getActiveTools()];
		for (const name of names) if (!selectedTools.includes(name)) selectedTools.push(name);
		const inactive = names.filter((name) => !pi.getActiveTools().includes(name));
		if (inactive.length > 0) pi.setActiveTools([...pi.getActiveTools(), ...inactive]);
	});
}
