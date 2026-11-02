#!/usr/bin/env node
// The single required check. A job blocks the merge when it ran and did not succeed. A job
// that no hosted runner ever picked up (cancelled with no runner and no steps, as macOS arm64
// capacity does) is reported as a warning instead: it tested nothing, so it proves nothing
// either way. If the job list cannot be read, the check fails closed.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PASSED = new Set(["success", "skipped"]);
const SELF = "ci-ok";

const neverAcquired = (job) => job.conclusion === "cancelled" && !job.runner_name && (job.steps ?? []).length === 0;

export function ciVerdict(jobs) {
	const others = jobs.filter((job) => job.name !== SELF);
	const unacquired = others.filter(neverAcquired).map((job) => job.name);
	const failed = others.filter((job) => !PASSED.has(job.conclusion) && !neverAcquired(job)).map((job) => `${job.name}=${job.conclusion}`);
	const ranSomething = others.some((job) => job.conclusion === "success");
	return { ok: failed.length === 0 && ranSomething, failed, unacquired };
}

async function runJobs() {
	const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_TOKEN } = process.env;
	const jobs = [];
	for (let page = 1; ; page++) {
		const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`;
		const response = await fetch(url, { headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json" } });
		if (!response.ok) throw new Error(`job list: HTTP ${response.status}`);
		const body = await response.json();
		jobs.push(...body.jobs);
		if (jobs.length >= body.total_count || body.jobs.length === 0) return jobs;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const verdict = ciVerdict(await runJobs());
	for (const name of verdict.unacquired) console.log(`::warning::${name}: no hosted runner picked it up; it did not run and does not block the merge`);
	if (process.env.GITHUB_STEP_SUMMARY && verdict.unacquired.length) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Not run (no runner): ${verdict.unacquired.join(", ")}\n`);
	}
	if (!verdict.ok) {
		console.error(verdict.failed.length ? `failed or cancelled: ${verdict.failed.join(", ")}` : "no job ran");
		process.exit(1);
	}
}
