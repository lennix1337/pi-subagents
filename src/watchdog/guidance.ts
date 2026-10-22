import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

export const WATCHDOG_GUIDANCE_MAX_CHARS = 8_000;

function readOptional(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8").trim();
	} catch {
		return "";
	}
}

/** Read fresh on every review; project file first, then user file. `projectTrusted: false` leaves the project file unread. */
export function loadWatchdogGuidance(cwd: string, enabled: boolean, projectTrusted?: boolean): string {
	if (!enabled) return "";
	const dirs = projectTrusted === false ? [getAgentDir()] : [getProjectConfigDir(cwd), getAgentDir()];
	const sections = dirs.map((dir) => readOptional(path.join(dir, "WATCHDOG.md"))).filter(Boolean);
	return sections.join("\n\n").slice(0, WATCHDOG_GUIDANCE_MAX_CHARS);
}
