import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface BackgroundCompanyRegistry {
	version: 1;
	roots: string[];
}

const REGISTRY_FILE = "background-companies.json";
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_BACKGROUND_COMPANIES = 100;

function normalizedRoot(root: string): string {
	const resolved = resolve(root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function backgroundCompanyRegistryPath(userData: string): string {
	return join(resolve(userData), REGISTRY_FILE);
}

export function readBackgroundCompanyRoots(userData: string): string[] {
	const path = backgroundCompanyRegistryPath(userData);
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		const content = readFileSync(path, "utf-8");
		if (Buffer.byteLength(content, "utf-8") > MAX_REGISTRY_BYTES) return [];
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const record = parsed as Record<string, unknown>;
	if (
		Object.keys(record).some((key) => key !== "version" && key !== "roots") ||
		record.version !== 1 ||
		!Array.isArray(record.roots) ||
		record.roots.length > MAX_BACKGROUND_COMPANIES ||
		record.roots.some((root) => typeof root !== "string" || !root.trim() || root !== root.trim() || !isAbsolute(root))
	) {
		return [];
	}
	const roots = record.roots.map((root) => resolve(root as string));
	return new Set(roots.map(normalizedRoot)).size === roots.length ? roots : [];
}

export function setBackgroundCompanyEnabled(userData: string, root: string, enabled: boolean): string[] {
	const resolvedRoot = resolve(root);
	const roots = readBackgroundCompanyRoots(userData).filter(
		(candidate) => normalizedRoot(candidate) !== normalizedRoot(resolvedRoot),
	);
	if (enabled) roots.push(resolvedRoot);
	if (roots.length > MAX_BACKGROUND_COMPANIES) throw new Error("Background company registry is full");
	const registry: BackgroundCompanyRegistry = { version: 1, roots };
	const path = backgroundCompanyRegistryPath(userData);
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(registry, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return [...roots];
}
