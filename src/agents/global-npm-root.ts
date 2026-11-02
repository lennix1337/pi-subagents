import { exec, execFile, execSync } from "node:child_process";
import { promises as fs, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `npm root -g` answers keyed by the environment npm reads: the child runs once per distinct environment,
 * so a changed PATH or prefix is never answered with a root found under the old one.
 */
const spawnedGlobalNpmRoots = new Map<string, string | null>();

function npmEnvironmentKey(env: NodeJS.ProcessEnv): string {
	return [env.PATH, env.Path, env.npm_config_prefix, env.NPM_CONFIG_PREFIX, env.APPDATA, env.ComSpec, env.HOME, env.USERPROFILE].join("\u0000");
}

/**
 * Synchronous global root for callers that cannot await `resolveGlobalNpmRoot`.
 * The APPDATA layout is checked on every call, so a directory created later is seen at once.
 * Elsewhere `npm root -g` is the only authority; its answer, including a failure, is remembered for this process.
 */
export function resolveGlobalNpmRootSync(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): string | null {
	const env = options.env ?? process.env;
	const offline = env.PI_OFFLINE?.toLowerCase();
	if (offline === "1" || offline === "true" || offline === "yes") return null;
	if ((options.platform ?? process.platform) === "win32" && env.APPDATA) {
		try {
			const appDataRoot = path.join(env.APPDATA, "npm", "node_modules");
			if (statSync(appDataRoot).isDirectory()) return realpathSync(appDataRoot);
		} catch {
			// Invalid or disappearing APPDATA roots fall back to npm.
		}
	}
	// An injected environment is a test seam; only the process environment's answers are remembered.
	if (options.env !== undefined) return spawnNpmRootSync(env);
	const key = npmEnvironmentKey(env);
	if (!spawnedGlobalNpmRoots.has(key)) spawnedGlobalNpmRoots.set(key, spawnNpmRootSync(env));
	return spawnedGlobalNpmRoots.get(key) ?? null;
}

function spawnNpmRootSync(env: NodeJS.ProcessEnv): string | null {
	try {
		return realpathSync(execSync("npm root -g", { encoding: "utf-8", timeout: 5000, windowsHide: true, env, stdio: ["ignore", "pipe", "ignore"] }).trim());
	} catch {
		// The global root is optional in constrained environments.
		return null;
	}
}

/** Optional global package discovery; a failure never prevents local discovery. */
export async function resolveGlobalNpmRoot(options: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	timeoutMs?: number;
} = {}): Promise<string | null> {
	const env = options.env ?? process.env;
	const offline = env.PI_OFFLINE?.toLowerCase();
	if (offline === "1" || offline === "true" || offline === "yes") return null;

	if ((options.platform ?? process.platform) === "win32" && env.APPDATA) {
		const appDataRoot = path.join(env.APPDATA, "npm", "node_modules");
		try {
			if ((await fs.stat(appDataRoot)).isDirectory()) return await fs.realpath(appDataRoot);
		} catch {
			// Invalid APPDATA roots fall back to npm (including disappearing directories).
		}
	}

	const timeoutMs = options.timeoutMs ?? 5000;
	const output = await new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const commandOptions = {
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
			env,
			maxBuffer: 64 * 1024,
		} as const;
		// POSIX npm is executable directly: killing a shell would leave npm running.
		// Windows npm.cmd requires a shell, matching the existing command behavior.
		const callback = (error: Error | null, stdout: string) => finish(error ? null : stdout.trim());
		const child = (options.platform ?? process.platform) === "win32"
			? exec("npm root -g", commandOptions, callback)
			: execFile("npm", ["root", "-g"], commandOptions, callback);
		// Resolve at the deadline even if inherited pipes hold the callback open.
		const timer = setTimeout(() => {
			child.kill();
			finish(null);
		}, timeoutMs);
	});
	if (!output) return null;
	try {
		return await fs.realpath(output);
	} catch {
		return null;
	}
}
