/** Public client endpoints shared by the browser and the static build. */
export interface CloudConfig {
	projectUrl: string;
	publishableKey: string;
	objectGatewayUrl: string;
	officeViewerOrigin?: string;
}

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
	projectUrl: "https://wovsmjvghnbcbfazdtvr.supabase.co",
	publishableKey: "sb_publishable_nOLb65dGcfMmfiEJHVPuEg_aS2uzVjS",
	objectGatewayUrl: "https://objects.qorpera.com",
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

export function parseCloudConfig(value: unknown, requireViewer = false): CloudConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid public cloud configuration");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) => !["projectUrl", "publishableKey", "objectGatewayUrl", "officeViewerOrigin"].includes(key),
		)
	)
		throw new Error("Unknown public cloud configuration field");
	if (typeof input.publishableKey !== "string" || !/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(input.publishableKey))
		throw new Error("Expected a publishable key");
	const projectUrl = origin(input.projectUrl, "https:");
	const objectGatewayUrl = origin(input.objectGatewayUrl, "https:");
	const officeViewerOrigin =
		input.officeViewerOrigin === undefined ? undefined : origin(input.officeViewerOrigin, "wss:");
	if (requireViewer && !officeViewerOrigin) throw new Error("A release build requires the office viewer origin");
	return {
		projectUrl,
		objectGatewayUrl,
		publishableKey: input.publishableKey,
		...(officeViewerOrigin ? { officeViewerOrigin } : {}),
	};
}

export function cloudConnectSources(config: CloudConfig): string {
	const checked = parseCloudConfig(config);
	return [
		...new Set([
			checked.projectUrl,
			checked.projectUrl.replace(/^https:/, "wss:"),
			checked.objectGatewayUrl,
			...(checked.officeViewerOrigin ? [checked.officeViewerOrigin] : []),
		]),
	].join(" ");
}
