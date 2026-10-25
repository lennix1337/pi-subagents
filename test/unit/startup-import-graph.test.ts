import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionEntry = path.join(projectRoot, "src", "extension", "index.ts");

/** Modules only needed once a user runs the command or RPC method that uses them. */
const deferredUntilFirstUse = [
	"src/slash/subagents-admin.ts",
	"src/slash/subagent-cost.ts",
	"src/runs/background/inspect-rpc.ts",
];

/** Top-level `import`/`export ... from` specifiers, skipping type-only statements. */
function staticRuntimeSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const lines = source.split("\n");
	let i = 0;
	while (i < lines.length) {
		let statement = lines[i]!.trim();
		if (!/^(?:import|export)\b/.test(statement)) {
			i++;
			continue;
		}
		while (!/from\s+["'][^"']+["']/.test(statement) && !statement.includes(";") && i + 1 < lines.length) {
			i++;
			statement += ` ${lines[i]!.trim()}`;
		}
		i++;
		if (/^(?:import|export)\s+type\b/.test(statement)) continue;
		const match = statement.match(/from\s+["']([^"']+)["']/) ?? statement.match(/^import\s+["']([^"']+)["']/);
		if (match) specifiers.push(match[1]!);
	}
	return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
	const base = path.dirname(fromFile);
	return [path.resolve(base, specifier), path.resolve(base, `${specifier}.ts`), path.resolve(base, specifier, "index.ts")]
		.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function staticModuleGraph(entry: string): Set<string> {
	const visited = new Set<string>([entry]);
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop()!;
		for (const specifier of staticRuntimeSpecifiers(fs.readFileSync(file, "utf-8"))) {
			if (!specifier.startsWith(".")) continue;
			const resolved = resolveRelative(file, specifier);
			if (resolved && !visited.has(resolved)) {
				visited.add(resolved);
				queue.push(resolved);
			}
		}
	}
	return visited;
}

test("extension startup does not statically load modules that only run on first use", () => {
	const loaded = new Set([...staticModuleGraph(extensionEntry)].map((file) => path.relative(projectRoot, file).split(path.sep).join("/")));
	const eager = deferredUntilFirstUse.filter((module) => loaded.has(module));
	assert.deepEqual(eager, [], "these modules must be loaded with a dynamic import inside the handler that uses them");
});
