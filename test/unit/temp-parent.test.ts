import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanTempParent, leakyAncestors, tempParentCandidates } from "../support/temp-parent.mjs";

describe("test temp parent", () => {
	it("skips a temp dir under a stray node_modules or package.json and takes the next clean candidate", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "temp-parent-"));
		try {
			const profile = path.join(fixture, "profile");
			const dirtyTemp = path.join(profile, "AppData", "Local", "Temp");
			const cleanTemp = path.join(fixture, "clean", "tmp");
			fs.mkdirSync(dirtyTemp, { recursive: true });
			fs.mkdirSync(cleanTemp, { recursive: true });
			assert.equal(cleanTempParent([dirtyTemp, cleanTemp]), dirtyTemp, "both are clean before the leak");

			fs.mkdirSync(path.join(profile, "node_modules", "typebox"), { recursive: true });
			assert.deepEqual(leakyAncestors(dirtyTemp), [path.join(profile, "node_modules")]);
			assert.equal(cleanTempParent([dirtyTemp, cleanTemp]), cleanTemp);

			fs.rmSync(path.join(profile, "node_modules"), { recursive: true });
			fs.writeFileSync(path.join(profile, "package.json"), "{}");
			assert.equal(cleanTempParent([dirtyTemp, cleanTemp]), cleanTemp);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("keeps the first candidate when no candidate is clean or the fallback does not exist", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "temp-parent-"));
		try {
			const dirtyTemp = path.join(fixture, "Temp");
			fs.mkdirSync(dirtyTemp);
			fs.writeFileSync(path.join(fixture, "package.json"), "{}");
			assert.equal(cleanTempParent([dirtyTemp, path.join(fixture, "missing")]), dirtyTemp);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("falls back to the tmp directory at the root of the temp dir's drive", () => {
		const tmp = path.resolve("/some/user/AppData/Local/Temp");
		assert.deepEqual(tempParentCandidates(tmp), [tmp, path.join(path.parse(tmp).root, "tmp")]);
	});
});
