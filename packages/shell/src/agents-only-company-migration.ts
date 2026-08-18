import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AgentsOnlyCompanyMigrationResult {
	removed: boolean;
	removedRoots: readonly string[];
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
		throw new Error(`legacy company storage must be physical: ${path}`);
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
 * Remove company-authored UI from the obsolete self-evolving application
 * architecture. Qorpera Base now owns one fixed renderer; durable company
 * state lives in `.qorpera/`, `agents/`, `connectors/`, `files/`, `inbox/`,
 * and `trail/`.
 */
export function migrateCompanyToAgentsOnly(companyRoot: string): AgentsOnlyCompanyMigrationResult {
	const root = realpathSync(resolve(companyRoot));
	const candidates = ["userland", "app"].map((name) => ({ name, path: join(root, name) }));
	for (const candidate of candidates) {
		if (normalizedPath(dirname(candidate.path)) !== normalizedPath(root)) {
			throw new Error("legacy company target escaped the company root");
		}
	}
	const targets = candidates.filter((candidate) => existsSync(candidate.path));
	const inspected = targets.map((target) => ({ target, ...inspectPhysicalTree(target.path) }));
	for (const entry of inspected) {
		rmSync(entry.target.path, { recursive: true, force: false });
		if (existsSync(entry.target.path)) {
			throw new Error(`legacy company storage still exists after migration: ${entry.target.path}`);
		}
	}
	return {
		removed: inspected.length > 0,
		removedRoots: Object.freeze(inspected.map((entry) => entry.target.name)),
		filesRemoved: inspected.reduce((total, entry) => total + entry.files, 0),
		versionsRemoved: inspected.reduce((total, entry) => total + entry.versions, 0),
	};
}
