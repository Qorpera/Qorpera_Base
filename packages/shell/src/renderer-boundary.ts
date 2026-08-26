import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session, WebContents } from "electron";

const LOOPBACK_WEBSOCKET_PATH_PATTERN = /^\/[A-Za-z0-9_-]{43}$/;
const rendererLoopbackWebSocketUrls = new Set<string>();

function normalized(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function insideOrEqual(target: string, parent: string): boolean {
	const rel = relative(parent, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Durable per-company renderer partition. Companies never share a partition,
 * so one company's (agent-authored) chrome can never read another's storage —
 * the isolation wipe-on-close used to provide — while a company's own prefs
 * survive close, switch, and restart. Hub windows use an ephemeral partition
 * until a company claims them. */
export function rendererPartitionForCompany(companyId: string): string {
	if (!/^[0-9a-f]{64}$/.test(companyId)) throw new Error("renderer partition requires a company root id");
	return `persist:qorpera-company-${companyId}`;
}

/** Registers one unguessable main-process WebSocket URL for exactly one
 * renderer connection. The URL itself is the local capability: no other
 * loopback origin or path is opened by the renderer boundary. */
export function registerRendererLoopbackWebSocketUrl(value: string): () => void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("renderer loopback WebSocket URL is invalid");
	}
	if (
		url.protocol !== "ws:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!LOOPBACK_WEBSOCKET_PATH_PATTERN.test(url.pathname)
	) {
		throw new Error("renderer loopback WebSocket URL is invalid");
	}
	const exact = url.href;
	if (rendererLoopbackWebSocketUrls.has(exact)) {
		throw new Error("renderer loopback WebSocket URL is already registered");
	}
	rendererLoopbackWebSocketUrls.add(exact);
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		rendererLoopbackWebSocketUrls.delete(exact);
	};
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
	if (url.protocol === "ws:" && rendererLoopbackWebSocketUrls.has(url.href)) return true;
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

/** Deny every ambient browser/OS capability not explicitly brokered by main. */
export function lockDownRendererSession(
	session: Pick<
		Session,
		| "setPermissionCheckHandler"
		| "setPermissionRequestHandler"
		| "setDevicePermissionHandler"
		| "setDisplayMediaRequestHandler"
		| "on"
	>,
): void {
	session.setPermissionCheckHandler(() => false);
	session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	session.setDevicePermissionHandler(() => false);
	session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
	session.on("will-download", (event, item) => {
		event.preventDefault();
		item.cancel();
	});
}

export function lockDownRendererWebContents(contents: Pick<WebContents, "setWebRTCIPHandlingPolicy">): void {
	contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}
