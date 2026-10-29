#!/usr/bin/env node
// Decides which CI jobs a change needs, so a docs or single-test change does not pay for
// the whole cross-platform matrix. Any doubt (unknown diff, build or CI config, shared test
// support, product source) runs everything that could be affected.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Changes here can affect every job.
const EVERYTHING = [
	/^\.github\//,
	/^package(-lock)?\.json$/,
	/^tsconfig[^/]*\.json$/,
	/^test\/support\//,
	/^[^/]+\.(ts|mjs|js)$/,
];

// Text no code reads unless a test names it.
const PROSE = [/^[^/]+\.md$/, /^LICENSE$/, /^banner\.png$/, /^examples\//];

// Platform jobs that cover one area; a product change outside it skips them.
export const AREA_JOBS = {
	calendar: [/calendar|schedul/],
	worktree: [/worktree|parallel-handoff/],
	schedule: [/schedul/],
	bun: [/workflow|scripted/],
	loader: [/loader|^runner-|^test\/smoke\/runner-loader/],
	runtime: [/^src\/(runs|extension|shared|agents|api|policy|profiles)\//, /^test\/smoke\//, /^test\/integration\/(nested-async-wait|builtin-mcp-readiness)/],
};

const TEST_FILE = /^test\/(unit|integration)\/[^/]+\.test\.ts$/;

/**
 * @param {string[] | null} files changed paths, or null when the diff is unknown
 * @param {Map<string, string>} testSources test path -> its source text
 */
export function ciScope(files, testSources) {
	const jobs = Object.fromEntries(Object.keys(AREA_JOBS).map((job) => [job, false]));
	const all = () => ({ full: true, typecheck: true, unit: [], integration: [], jobs: Object.fromEntries(Object.keys(jobs).map((job) => [job, true])) });
	if (files === null || files.some((file) => EVERYTHING.some((rule) => rule.test(file)))) return all();

	let full = false;
	let typecheck = false;
	const focused = new Set();
	const namedBy = (path) => [...testSources].filter(([, source]) => source.includes(path)).map(([test]) => test);
	const markAreas = (file) => {
		for (const [job, rules] of Object.entries(AREA_JOBS)) if (rules.some((rule) => rule.test(file))) jobs[job] = true;
	};
	for (const file of files) {
		if (TEST_FILE.test(file)) {
			focused.add(file);
			typecheck = true;
			markAreas(file);
		} else if (file.startsWith("docs/")) {
			focused.add("test/unit/subagent-guide.test.ts");
			for (const test of namedBy(file)) focused.add(test);
		} else if (PROSE.some((rule) => rule.test(file))) {
			for (const test of namedBy(file)) focused.add(test);
		} else {
			full = true;
			markAreas(file);
		}
	}
	if (full) return { full: true, typecheck: true, unit: [], integration: [], jobs };
	const sorted = [...focused].filter((test) => testSources.has(test)).sort();
	return {
		full: false,
		typecheck,
		unit: sorted.filter((test) => test.startsWith("test/unit/")),
		integration: sorted.filter((test) => test.startsWith("test/integration/")),
		jobs,
	};
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function changedFiles() {
	const event = process.env.GITHUB_EVENT_NAME;
	try {
		// pull_request checks out the merge commit: its first parent is the base tip.
		if (event === "pull_request") return git("diff", "--name-only", "HEAD^1", "HEAD").split("\n").filter(Boolean);
		const before = process.env.CI_BEFORE ?? "";
		if (event === "push" && before && !/^0+$/.test(before)) {
			git("fetch", "--no-tags", "--depth=1", "origin", before);
			return git("diff", "--name-only", before, "HEAD").split("\n").filter(Boolean);
		}
	} catch {
		// Unknown diff: run everything.
	}
	return null;
}

function readTests() {
	const sources = new Map();
	for (const dir of ["test/unit", "test/integration"]) {
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".test.ts")) sources.set(`${dir}/${name}`, readFileSync(join(dir, name), "utf8"));
		}
	}
	return sources;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const files = changedFiles();
	const scope = ciScope(files, readTests());
	const lines = [
		`full=${scope.full}`,
		`typecheck=${scope.typecheck}`,
		`unit=${scope.unit.join(" ")}`,
		`integration=${scope.integration.join(" ")}`,
		`focused=${!scope.full && scope.unit.length + scope.integration.length > 0}`,
		...Object.entries(scope.jobs).map(([job, run]) => `${job}=${run}`),
	];
	console.log(files === null ? "Changed files unknown: running everything." : `Changed files:\n${files.join("\n")}`);
	console.log(lines.join("\n"));
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
