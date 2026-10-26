import * as fs from "node:fs";
import * as path from "node:path";

// Entries that Node's bare-specifier resolution or a Pi project walk would pick up from any ancestor directory.
const LEAKY_ENTRIES = ["node_modules", "package.json", ".pi"];

/** The ancestors of `dir` (itself included) holding an entry that a test fixture below it would inherit. */
export function leakyAncestors(dir) {
	const found = [];
	for (let current = path.resolve(dir); ; current = path.dirname(current)) {
		for (const entry of LEAKY_ENTRIES) {
			const candidate = path.join(current, entry);
			if (fs.existsSync(candidate)) found.push(candidate);
		}
		if (path.dirname(current) === current) return found;
	}
}

/**
 * The first existing directory in `candidates` with no leaky ancestor, so a stray ~/node_modules or ~/package.json
 * (common on Windows, where the temp dir sits under the user profile) cannot shadow test fixtures. Falls back to the
 * first candidate when none is clean; tests that depend on a clean root then fail with their own actionable message.
 */
export function cleanTempParent(candidates) {
	for (const dir of candidates) {
		if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && leakyAncestors(dir).length === 0) return dir;
	}
	return candidates[0];
}

/** Where unconfigured test runs create their temp root: the OS temp dir, else the drive or filesystem root's tmp. */
export function tempParentCandidates(tmpdir) {
	return [tmpdir, path.join(path.parse(path.resolve(tmpdir)).root, "tmp")];
}
