/**
 * File-mode path validation for the desktop host's HTTP lane.
 *
 * The host opens `sendFile` sources and creates `saveTo` targets outside
 * the sandbox, so containment cannot be lexical: any symlinked component
 * inside company territory could point anywhere on the host. Every existing
 * path component is resolved physically before the containment and
 * protected-territory checks; only the not-yet-created tail of a `saveTo`
 * target is appended lexically. Broken links fail closed.
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const casedPath = (path: string): string =>
	process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** lstat-based existence: a dangling symlink counts, so realpath rejects it. */
function componentExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Physical form: symlinks in every existing component resolved, missing tail appended lexically. */
function physicalPath(path: string): string {
	let existing = resolve(path);
	const missing: string[] = [];
	while (!componentExists(existing)) {
		missing.unshift(basename(existing));
		const parent = dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return join(realpathSync(existing), ...missing);
}

export function createCompanyFileResolver(
	root: string,
	protectedPaths: string[],
): (relativePath: string, mode: "read" | "write") => string {
	const physicalRoot = realpathSync(root);
	const protectedCased = protectedPaths.map((path) => {
		try {
			return casedPath(physicalPath(path));
		} catch {
			return casedPath(path);
		}
	});
	return (relativePath, mode) => {
		const label = mode === "write" ? "saveTo" : "sendFile";
		const target = resolve(physicalRoot, relativePath);
		const rootRelative = relative(physicalRoot, target);
		if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative)) {
			throw new Error(`${label} must stay inside the company folder`);
		}
		let physicalTarget: string;
		try {
			physicalTarget = physicalPath(target);
		} catch {
			throw new Error(`${label} cannot follow a broken link: ${relativePath}`);
		}
		const physicalRelative = relative(physicalRoot, physicalTarget);
		if (!physicalRelative || physicalRelative.startsWith("..") || isAbsolute(physicalRelative)) {
			throw new Error(`${label} cannot follow links outside the company folder`);
		}
		if (mode === "write") {
			const normalized = casedPath(physicalTarget);
			for (const protectedPath of protectedCased) {
				if (
					normalized === protectedPath ||
					normalized.startsWith(`${protectedPath}\\`) ||
					normalized.startsWith(`${protectedPath}/`)
				) {
					throw new Error(`saveTo cannot write into host-protected territory: ${relativePath}`);
				}
			}
		}
		return physicalTarget;
	};
}
