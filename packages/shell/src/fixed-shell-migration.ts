import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface FixedShellMigrationResult {
	removed: boolean;
	filesRemoved: number;
	versionsRemoved: number;
}

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inspectPhysicalTree(path: string): { files: number; versions: number } {
	const entry = lstatSync(path);
	if (entry.isSymbolicLink() || normalizedPath(realpathSync(path)) !== normalizedPath(path)) {
		throw new Error(`legacy shell storage must be physical: ${path}`);
	}
	if (!entry.isDirectory()) return { files: 1, versions: 0 };
	let files = 0;
	let versions = 0;
	for (const child of readdirSync(path, { withFileTypes: true })) {
		const childPath = join(path, child.name);
		const inspected = inspectPhysicalTree(childPath);
		files += inspected.files;
		versions += inspected.versions;
		if (child.name === ".versions" && child.isDirectory()) {
			versions += readdirSync(childPath, { withFileTypes: true }).filter((item) => item.isDirectory()).length;
		}
	}
	return { files, versions };
}

/**
 * Remove the obsolete company-owned shell copy. Qorpera Base now owns one
 * fixed renderer; durable company state lives elsewhere (`.qorpera/`,
 * `trail/`, schedules, and `app/surfaces/`). The target is resolved as the
 * exact direct `userland` child and every entry must be physical before the
 * recursive delete is allowed.
 */
export function migrateCompanyToFixedShell(companyRoot: string): FixedShellMigrationResult {
	const root = realpathSync(resolve(companyRoot));
	const target = join(root, "userland");
	if (normalizedPath(dirname(target)) !== normalizedPath(root)) {
		throw new Error("legacy shell target escaped the company root");
	}
	if (!existsSync(target)) return { removed: false, filesRemoved: 0, versionsRemoved: 0 };
	const inspected = inspectPhysicalTree(target);
	rmSync(target, { recursive: true, force: false });
	if (existsSync(target)) throw new Error(`legacy shell storage still exists after migration: ${target}`);
	return {
		removed: true,
		filesRemoved: inspected.files,
		versionsRemoved: inspected.versions,
	};
}
