/* Cloud endpoints. Only public values live here: the project URL, its
 * publishable key, and the object gateway origin (CLIENT-CONTRACT.md §1, §4).
 * A preview project can be selected per browser through a stored override so
 * the same build can point at an isolated preview without a rebuild. */

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

const OVERRIDE_KEY = "qorpera-web-cloud-config/v1";

function httpsOrigin(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function readCloudConfigOverride(): CloudConfig | undefined {
	try {
		const raw = localStorage.getItem(OVERRIDE_KEY);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as Partial<CloudConfig>;
		const projectUrl = httpsOrigin(parsed.projectUrl);
		const objectGatewayUrl = httpsOrigin(parsed.objectGatewayUrl);
		const publishableKey =
			typeof parsed.publishableKey === "string" && /^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(parsed.publishableKey)
				? parsed.publishableKey
				: undefined;
		if (!projectUrl || !objectGatewayUrl || !publishableKey) return undefined;
		let officeViewerOrigin: string | undefined;
		if (parsed.officeViewerOrigin !== undefined) {
			if (typeof parsed.officeViewerOrigin !== "string") return undefined;
			const viewer = new URL(parsed.officeViewerOrigin);
			if (
				viewer.protocol !== "wss:" ||
				viewer.username ||
				viewer.password ||
				viewer.pathname !== "/" ||
				viewer.search ||
				viewer.hash
			)
				return undefined;
			officeViewerOrigin = viewer.origin;
		}
		return { projectUrl, publishableKey, objectGatewayUrl, ...(officeViewerOrigin ? { officeViewerOrigin } : {}) };
	} catch {
		return undefined;
	}
}

export function writeCloudConfigOverride(config: CloudConfig | undefined): void {
	if (!config) {
		localStorage.removeItem(OVERRIDE_KEY);
		return;
	}
	localStorage.setItem(OVERRIDE_KEY, JSON.stringify(config));
}

export function resolveCloudConfig(): CloudConfig {
	return readCloudConfigOverride() ?? DEFAULT_CLOUD_CONFIG;
}

declare const __QORPERA_WEB_VERSION__: string;
declare const __QORPERA_WEB_MODE__: string;

export const WEB_CLIENT_VERSION: string = typeof __QORPERA_WEB_VERSION__ === "string" ? __QORPERA_WEB_VERSION__ : "dev";
export const WEB_CLIENT_MODE: string = typeof __QORPERA_WEB_MODE__ === "string" ? __QORPERA_WEB_MODE__ : "development";
