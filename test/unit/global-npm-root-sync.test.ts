import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveGlobalNpmRootSync } from "../../src/agents/global-npm-root.ts";

describe("resolveGlobalNpmRootSync", () => {
	it("reads the APPDATA npm root on every call, so a directory created later is seen at once", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "global-npm-root-sync-"));
		try {
			const appData = path.join(dir, "appdata");
			const root = path.join(appData, "npm", "node_modules");
			// PATH is empty: an `npm root -g` spawn cannot run here, so any answer must come from APPDATA.
			const env = { APPDATA: appData, PATH: "" };
			fs.mkdirSync(appData, { recursive: true });
			fs.mkdirSync(root, { recursive: true });
			const expected = fs.realpathSync(root);
			assert.equal(resolveGlobalNpmRootSync({ env, platform: "win32" }), expected);

			fs.rmSync(root, { recursive: true, force: true });
			assert.notEqual(resolveGlobalNpmRootSync({ env, platform: "win32" }), expected);

			fs.mkdirSync(root);
			assert.equal(resolveGlobalNpmRootSync({ env, platform: "win32" }), expected);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("answers nothing while offline, even when APPDATA holds a root", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "global-npm-root-offline-"));
		try {
			const appData = path.join(dir, "appdata");
			fs.mkdirSync(path.join(appData, "npm", "node_modules"), { recursive: true });
			assert.equal(resolveGlobalNpmRootSync({ env: { APPDATA: appData, PATH: "", PI_OFFLINE: "YeS" }, platform: "win32" }), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
