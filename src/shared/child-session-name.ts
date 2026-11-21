import { previewDisplayText } from "./display-text.ts";
import { PROMPT_REDACTED } from "./utils.ts";


const TASK_EXCERPT_MAX_CHARS = 60;
/** Hard cap on the final name so host UI rows stay one line. */
export const CHILD_SESSION_NAME_MAX_CHARS = 80;

const ROLE_PREAMBLE = /^(?:you are (?:a|an|the) [^.!\n]*?\b(?:sub-?agent|child|worker)\b[^.!\n]*[.!]?|(?:do not|don't|never) write (?:any )?memory pages?[.!]?)\s*/i;
const HEADLINE_LABEL = /^(?:goal|task|objective|mission)\s*:\s*/i;
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
