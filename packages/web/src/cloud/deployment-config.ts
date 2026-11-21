/** Public client endpoints shared by the browser and the static build. */
export interface CloudConfig {
	projectUrl: string;
	publishableKey: string;
	objectGatewayUrl: string;
	officeViewerOrigin?: string;
	nativeProviderLoginUrl?: string;
	memberCompanyGatewayUrl?: string;
	/** Node 1's door of members' live pictures of agents' desktops (`wss://screens.…`, 20260930745000): the large view
	 * streams a desktop from there; without it, the window keeps its looks. */
	machineStreamUrl?: string;
}

/** A build given no configuration (development) talks to the live cloud the release build uses: project
 * `phqlfrkcvstmxlebljcj` and its object gateway. A release build always names its own. The key is publishable. */
export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
	projectUrl: "https://phqlfrkcvstmxlebljcj.supabase.co",
	publishableKey: "sb_publishable_xn-Yy0QJ5iGEFmsiJGmw7w_JMsDTo8N",
	objectGatewayUrl: "https://company41-node-01.tailbb15c7.ts.net:10000",
};

function origin(value: unknown, protocol: "https:" | "wss:"): string {
	if (typeof value !== "string" || /[\s*\\]/u.test(value)) throw new Error("Expected an exact secure origin");
	const url = new URL(value);
	if (
		url.protocol !== protocol ||
		!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/.test(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		(value !== url.origin && value !== `${url.origin}/`)
	)
		throw new Error("Expected an exact secure origin");
	return url.origin;
}

/** Explicit public bridge base. The SDK resolves its login child route. */
function loginBase(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048 || /[\s*\\]/u.test(value))
		throw new Error("Expected an exact secure login gateway base URL");
	const url = new URL(value);
	origin(url.origin, "https:");
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		value !== url.href ||
		!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname)
	)
		throw new Error("Expected an exact secure login gateway base URL ending in /");
	return url.href;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function decodeBase64UrlUtf8(input: string): string | null {
	if (input.length === 0 || input.length % 4 === 1) return null;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < input.length; i++) {
		const code = BASE64URL_ALPHABET.indexOf(input.charAt(i));
		if (code === -1) return null;
		buffer = (buffer << 6) | code;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
	let out = "";
	for (let i = 0; i < bytes.length; ) {
		const b0 = bytes[i++]!;
		if (b0 < 0x80) {
			out += String.fromCharCode(b0);
		} else if (b0 >= 0xc2 && b0 <= 0xdf && i < bytes.length) {
			const b1 = bytes[i++]!;
			if ((b1 & 0xc0) !== 0x80) return null;
			out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
		} else if (b0 >= 0xe0 && b0 <= 0xef && i + 1 < bytes.length) {
			const b1 = bytes[i++]!;
			const b2 = bytes[i++]!;
			if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return null;
			const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
			if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return null;
			out += String.fromCharCode(cp);
		} else if (b0 >= 0xf0 && b0 <= 0xf4 && i + 2 < bytes.length) {
			const b1 = bytes[i++]!;
			const b2 = bytes[i++]!;
			const b3 = bytes[i++]!;
			if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return null;
			const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
			if (cp < 0x10000 || cp > 0x10ffff) return null;
			out += String.fromCodePoint(cp);
		} else {
			return null;
		}
	}
	return out;
}

function isPublishableKey(key: unknown): key is string {
	if (typeof key !== "string" || key.length > 8192) return false;
	if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return true;
	const parts = key.split(".");
	const headerPart = parts[0];
	const payloadPart = parts[1];
	const sigPart = parts[2];
	if (
		parts.length !== 3 ||
		!headerPart ||
		!payloadPart ||
		!sigPart ||
		sigPart.length < 16 ||
		parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
	)
		return false;
	const headerText = decodeBase64UrlUtf8(headerPart);
	const payloadText = decodeBase64UrlUtf8(payloadPart);
	if (headerText === null || payloadText === null) return false;
	try {
		const header = JSON.parse(headerText) as Record<string, unknown>;
		const payload = JSON.parse(payloadText) as Record<string, unknown>;
		if (
			!header ||
			typeof header !== "object" ||
			Array.isArray(header) ||
			typeof header.alg !== "string" ||
			header.alg.length === 0 ||
			header.alg.toLowerCase() === "none"
		)
			return false;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
		return payload.role === "anon" && payload.sub === undefined;
	} catch {
		return false;
	}
}

export function parseCloudConfig(value: unknown, requireViewer = false): CloudConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid public cloud configuration");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) =>
				![
					"projectUrl",
					"publishableKey",
					"objectGatewayUrl",
					"officeViewerOrigin",
					"nativeProviderLoginUrl",
					"memberCompanyGatewayUrl",
					"machineStreamUrl",
				].includes(key),
		)
	)
		throw new Error("Unknown public cloud configuration field");
	if (!isPublishableKey(input.publishableKey)) throw new Error("Expected a publishable key");
	const projectUrl = origin(input.projectUrl, "https:");
	const objectGatewayUrl = origin(input.objectGatewayUrl, "https:");
	const officeViewerOrigin =
		input.officeViewerOrigin === undefined ? undefined : origin(input.officeViewerOrigin, "wss:");
	if (requireViewer && !officeViewerOrigin) throw new Error("A release build requires the office viewer origin");
	const nativeProviderLoginUrl =
		input.nativeProviderLoginUrl === undefined ? undefined : loginBase(input.nativeProviderLoginUrl);
	const memberCompanyGatewayUrl = input.memberCompanyGatewayUrl;
	if (
		memberCompanyGatewayUrl !== undefined &&
		memberCompanyGatewayUrl !== `${projectUrl}/functions/v1/member-company-gateway`
	)
		throw new Error("Expected the exact project member gateway URL");
	const machineStreamUrl = input.machineStreamUrl === undefined ? undefined : origin(input.machineStreamUrl, "wss:");
	return {
		projectUrl,
		objectGatewayUrl,
		publishableKey: input.publishableKey,
		...(officeViewerOrigin ? { officeViewerOrigin } : {}),
		...(nativeProviderLoginUrl ? { nativeProviderLoginUrl } : {}),
		...(memberCompanyGatewayUrl ? { memberCompanyGatewayUrl } : {}),
		...(machineStreamUrl ? { machineStreamUrl } : {}),
	};
}

/** Where a request to one of the object gateway's member routes (`/v1/member-…`) goes: the public bridge when the
 * build names one, else the gateway itself. The bridge spares a member on a tailnet the browser's local-network check,
 * since the gateway's name resolves to a private address there (4 Nov 2026). A configured transport, never a fallback:
 * a bridged request never retries against the gateway. Anything else is returned as given. */
export function memberRouteTarget(config: CloudConfig, input: string): string {
	const url = new URL(input);
	return config.memberCompanyGatewayUrl &&
		url.origin === new URL(config.objectGatewayUrl).origin &&
		url.pathname.startsWith("/v1/member-")
		? `${config.memberCompanyGatewayUrl}${url.pathname}${url.search}`
		: input;
}

export function cloudConnectSources(config: CloudConfig): string {
	const checked = parseCloudConfig(config);
	return [
		...new Set([
			checked.projectUrl,
			checked.projectUrl.replace(/^https:/, "wss:"),
			checked.objectGatewayUrl,
			...(checked.officeViewerOrigin ? [checked.officeViewerOrigin] : []),
			...(checked.nativeProviderLoginUrl ? [new URL(checked.nativeProviderLoginUrl).origin] : []),
			...(checked.machineStreamUrl ? [checked.machineStreamUrl] : []),
		]),
	].join(" ");
}
