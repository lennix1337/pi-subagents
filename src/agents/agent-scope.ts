import type { AgentScope } from "./agents.ts";

export function resolveExecutionAgentScope(scope: unknown): AgentScope {
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return "both";
}

export function projectScopeRequiresTrustMessage(cwd: string): string {
	return `agentScope: "project" requires project trust. This session declined trust for ${cwd}, so project agents and project subagent settings are ignored. Re-run with agentScope: "user" or approve the project folder.`;
}

export function projectStateRequiresTrustMessage(action: string, cwd: string): string {
	return `Action '${action}' reads or writes project state under ${cwd} and requires project trust. This session declined trust, so project agents, project subagent settings and refinement overlays are ignored. Approve the project folder to use it.`;
}
