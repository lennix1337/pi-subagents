import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLease } from "./file-lease.ts";

/** Physical file a settings path writes to, following file and directory links (including a dangling file link). */
export function resolveSettingsWriteTarget(filePath: string): string {
	let targetPath = filePath;
	for (;;) {
		try {
			return fs.realpathSync.native(targetPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			// external: a trailing filesystem path separator requires a directory.
			if (targetPath.endsWith("/") || targetPath.endsWith(path.sep)) throw error;
		}

		const parentPath = fs.realpathSync.native(path.dirname(targetPath));
		const unresolvedPath = path.join(parentPath, path.basename(targetPath));
		let linkText: string;
		try {
			linkText = fs.readlinkSync(unresolvedPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			return unresolvedPath;
		}
		// external: filesystems resolve directory symlinks before subsequent .. path segments.
		targetPath = path.isAbsolute(linkText) ? linkText : `${parentPath}${path.sep}${linkText}`;
	}
}

/** Hold the physical settings file's lease for a whole read-modify-write. */
export function withSettingsFileLease<T>(filePath: string, action: () => T): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return withFileLease(resolveSettingsWriteTarget(filePath), action);
}
