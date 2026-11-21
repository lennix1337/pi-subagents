import type { ChildSessionEvent } from "./child-session.ts";
import { extractTextFromContent } from "../../shared/utils.ts";

export type PartialOutputCause = "timeout" | "child error";

export interface PartialOutputTracker {
	observe(event: ChildSessionEvent): void;
	/** Latest unfinished assistant text that is newer than the last completed reply. */
	text(): string | undefined;
}

function isAssistant(message: unknown): boolean {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

function isErroredAssistant(message: unknown): boolean {
	const { stopReason, errorMessage } = message as { stopReason?: unknown; errorMessage?: unknown };
	return stopReason === "error" || (typeof errorMessage === "string" && errorMessage.length > 0);
}

export function createPartialOutputTracker(): PartialOutputTracker {
	let latest: { content?: unknown } | undefined;
	return {
		observe(event) {
			if ((event.type !== "message_update" && event.type !== "message_end") || !isAssistant(event.message)) return;
			latest = event.type === "message_update" || isErroredAssistant(event.message) ? event.message as { content?: unknown } : undefined;
		},
		text() {
			const text = extractTextFromContent(latest?.content);
			return text.trim() ? text : undefined;
		},
	};
}

export function formatPartialOutput(text: string, cause: PartialOutputCause): string {
	return `Partial output before ${cause}:\n${text}`;
}

/**
 * Summary of a timed-out background run. The timeout message comes first; when a child kept text streamed before
 * the kill, the per-child summary follows, so the completion notice and status show it (capped, with its file path).
 */
export function timedOutRunSummary(message: string, summary: string, results: ReadonlyArray<{ outputPartial?: boolean }>): string {
	return results.some((result) => result.outputPartial === true) ? `${message}\n\n${summary}` : message;
}
