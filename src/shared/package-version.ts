import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

export function readInstalledPackageVersion(): string {
	const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as { version?: unknown };
	if (typeof parsed.version !== "string" || !parsed.version.trim()) {
		throw new Error(`Invalid package version in '${packagePath}'.`);
	}
	return parsed.version;
}

// external: Node caches imported modules for the lifetime of the process.
export const loadedPackageVersion = readInstalledPackageVersion();
