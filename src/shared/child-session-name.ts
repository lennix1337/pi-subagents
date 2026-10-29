import { previewDisplayText } from "./display-text.ts";
import { PROMPT_REDACTED } from "./utils.ts";

/**
 * Human-readable display name for a child session, derived at launch time from
 * the agent name and its task (or workflow node label). The parent computes it
 * once and threads it two ways:
 *
 *  1. Into the child's runtime config as `sessionName`, where the prompt
 *     runtime calls `pi.setSessionName(...)` so the child's own session file
 *     is identifiable in `pi --resume` and host session browsers.
 *  2. Into the `sessionName` field of result/progress payloads, so hosts
 *     rendering the parent stream can label each child row.
 *
 * The name is display-only metadata. When the intercom bridge is active the
 * child claims its machine intercom target as its pi-intercom session ID and
 * keeps this readable name. With a pi-intercom that does not support the claim,
 * the target stays the session name because it routes by name
 * (see subagent-prompt-runtime).
 */

/** Longest task excerpt kept in the name; the full string is capped below. */
const TASK_EXCERPT_MAX_CHARS = 60;
/** Hard cap on the final name so host UI rows stay one line. */
export const CHILD_SESSION_NAME_MAX_CHARS = 80;

/** Launch boilerplate that says nothing about what this child is doing. */
const ROLE_PREAMBLE = /^(?:you are (?:a|an|the) [^.!\n]*?\b(?:sub-?agent|child|worker)\b[^.!\n]*[.!]?|(?:do not|don't|never) write (?:any )?memory pages?[.!]?)\s*/i;
const HEADLINE_LABEL = /^(?:goal|task|objective|mission)\s*:\s*/i;
/** Only a label near the top names the task; deeper ones belong to the body. */
const HEADLINE_SCAN_LINES = 5;

/**
 * The part of a task prompt worth showing as its name: the text of an early
 * `Goal:`/`Task:` line, else the prompt with leading role boilerplate
 * ("You are a subagent. Don't write memory pages.") removed.
 */
export function taskHeadline(task: string): string {
	const lines = task.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (const line of lines.slice(0, HEADLINE_SCAN_LINES)) {
		const headline = stripPreamble(line);
		if (HEADLINE_LABEL.test(headline)) {
			const rest = headline.replace(HEADLINE_LABEL, "").trim();
			if (rest) return rest;
		}
	}
	return stripPreamble(lines.join(" ")).replace(HEADLINE_LABEL, "").trim() || task.trim();
}

function stripPreamble(text: string): string {
	let current = text;
	for (let previous = ""; previous !== current;) {
		previous = current;
		current = current.replace(ROLE_PREAMBLE, "");
	}
	return current;
}

export function deriveChildSessionName(input: {
	agent?: string;
	task?: string;
	/** Workflow node label; preferred over the task excerpt when present. */
	label?: string;
}): string | undefined {
	const agent = input.agent?.trim() ?? "";
	const rawLabel = input.label?.trim() ?? "";
	const rawTask = input.task?.trim() ?? "";
	// Never build a name from redacted text — the excerpt would be meaningless
	// and the redaction marker itself carries no information.
	const excerptSource =
		rawLabel && rawLabel !== PROMPT_REDACTED
			? rawLabel
			: rawTask && rawTask !== PROMPT_REDACTED
				? taskHeadline(rawTask)
				: "";
	const excerpt = excerptSource ? previewDisplayText(excerptSource, TASK_EXCERPT_MAX_CHARS) : "";
	const base = agent && excerpt ? `${agent}: ${excerpt}` : agent || excerpt;
	if (!base) return undefined;
	return previewDisplayText(base, CHILD_SESSION_NAME_MAX_CHARS);
}
