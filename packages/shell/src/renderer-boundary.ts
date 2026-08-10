import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function normalized(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function insideOrEqual(target: string, parent: string): boolean {
	const rel = relative(parent, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Exact renderer network/file boundary, independent of agent-authored UI code. */
export function isRendererRequestAllowed(
	value: string,
	options: { backendOrigin?: string; trustedFileRoot: string },
): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === "data:" || url.href === "about:blank") return true;
	if (url.protocol === "blob:") {
		return options.backendOrigin !== undefined && url.origin === options.backendOrigin;
	}
	if (options.backendOrigin) return url.origin === options.backendOrigin;
	if (url.protocol !== "file:") return false;
	try {
		const root = realpathSync(options.trustedFileRoot);
		const target = realpathSync(fileURLToPath(url));
		return insideOrEqual(normalized(target), normalized(root));
	} catch {
		return false;
	}
}
