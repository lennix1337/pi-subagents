import { openGhosttyInspector, type GhosttyRunner } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";


const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty";

export interface GhosttyPluginDeps {
	platform?: NodeJS.Platform;
	runner?: GhosttyRunner;
}

export function createGhosttyInspectorPlugin(deps: GhosttyPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	return {
		name: "ghostty",
		available: (context) => {
			// external: cmux also reports TERM_PROGRAM=ghostty but is not the Ghostty app.

			if (platform !== "darwin") return false;
			if (context.env.TERM_PROGRAM?.toLowerCase() !== "ghostty") return false;
			// external: macOS provides __CFBundleIdentifier for GUI app child processes.


			return context.env.__CFBundleIdentifier?.trim() === GHOSTTY_BUNDLE_ID;
		},
		owns: () => false,
		open: (context, launch, params) => openGhosttyInspector(context, launch, params, deps.runner),
	};
}
