import {
	SUBAGENT_CHILD_TOOL_ACTIVITY_EVENT,
	type IntercomEventBus,
	type SubagentChildToolActivityEvent,
} from "../../shared/types.ts";

/** Project native tool boundaries without copying any child-controlled content fields. */
export function projectChildToolActivity(
	event: { type?: string; toolName?: unknown; isError?: unknown },
	identity: Pick<SubagentChildToolActivityEvent, "runId" | "childId" | "agent">,
): SubagentChildToolActivityEvent | undefined {
	if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
	if (typeof event.toolName !== "string" || !event.toolName) return;
	return {
		runId: identity.runId,
		childId: identity.childId,
		agent: identity.agent,
		toolName: event.toolName,
		phase: event.type === "tool_execution_start" ? "start" : "end",
		isError: event.type === "tool_execution_end" && event.isError === true,
	};
}

/** The async journal is a boundary: validate and allowlist, never spread its records onto the bus. */
export function readChildToolActivity(value: unknown): SubagentChildToolActivityEvent | undefined {
	if (!value || typeof value !== "object") return;
	// SAFETY: value is a non-null object; each public field is validated below before use.
	const event = value as Record<string, unknown>;
	if (event.type !== "subagent.child-tool-activity" || event.version !== 1) return;
	if (typeof event.runId !== "string" || !event.runId
		|| typeof event.childId !== "string" || !event.childId
		|| typeof event.agent !== "string" || !event.agent
		|| typeof event.toolName !== "string" || !event.toolName
		|| (event.phase !== "start" && event.phase !== "end")
		|| typeof event.isError !== "boolean") return;
	const activity: SubagentChildToolActivityEvent = {
		runId: event.runId,
		childId: event.childId,
		agent: event.agent,
		toolName: event.toolName,
		phase: event.phase,
		isError: event.phase === "end" && event.isError,
	};
	if (typeof event.sessionId === "string" && event.sessionId) activity.sessionId = event.sessionId;
	return activity;
}

export function emitChildToolActivity(events: Pick<IntercomEventBus, "emit">, activity: SubagentChildToolActivityEvent): void {
	try {
		events.emit(SUBAGENT_CHILD_TOOL_ACTIVITY_EVENT, activity);
	} catch (error) {
		// Observability listeners must not interrupt the child's execution or journal replay.
		console.error("Failed to emit child tool activity event:", error);
	}
}
