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

function isPublishableKey(key: unknown): key is string {
	if (typeof key !== "string" || key.length > 8192) return false;
	if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return true;
	const parts = key.split(".");
	const payloadPart = parts[1];
	if (parts.length !== 3 || !payloadPart || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part)))
		return false;
	try {
		const normalized = payloadPart.replaceAll("-", "+").replaceAll("_", "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
		const payload = JSON.parse(atob(padded)) as { role?: unknown; sub?: unknown };
		return payload.role === "anon" && !payload.sub;
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
