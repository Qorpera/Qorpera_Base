import { type CloudConfig, DEFAULT_CLOUD_CONFIG, parseCloudConfig } from "./deployment-config.ts";

export { type CloudConfig, DEFAULT_CLOUD_CONFIG } from "./deployment-config.ts";

declare const __QORPERA_WEB_CLOUD_CONFIG__: CloudConfig;
declare const __QORPERA_WEB_CONFIG_LOCKED__: boolean;
const builtConfig =
	typeof __QORPERA_WEB_CLOUD_CONFIG__ === "undefined"
		? DEFAULT_CLOUD_CONFIG
		: parseCloudConfig(__QORPERA_WEB_CLOUD_CONFIG__);
const configLocked = typeof __QORPERA_WEB_CONFIG_LOCKED__ !== "undefined" && __QORPERA_WEB_CONFIG_LOCKED__;

const OVERRIDE_KEY = "qorpera-web-cloud-config/v1";

export function readCloudConfigOverride(): CloudConfig | undefined {
	if (configLocked) return undefined;
	try {
		const raw = localStorage.getItem(OVERRIDE_KEY);
		return raw ? parseCloudConfig(JSON.parse(raw)) : undefined;
	} catch {
		return undefined;
	}
}

export function writeCloudConfigOverride(config: CloudConfig | undefined): void {
	if (!config) {
		localStorage.removeItem(OVERRIDE_KEY);
		return;
	}
	if (configLocked) throw new Error("This build uses its deployed cloud configuration");
	localStorage.setItem(OVERRIDE_KEY, JSON.stringify(config));
}

export function resolveCloudConfig(): CloudConfig {
	return readCloudConfigOverride() ?? builtConfig;
}

declare const __QORPERA_WEB_VERSION__: string;
declare const __QORPERA_WEB_MODE__: string;

export const WEB_CLIENT_VERSION: string = typeof __QORPERA_WEB_VERSION__ === "string" ? __QORPERA_WEB_VERSION__ : "dev";
export const WEB_CLIENT_MODE: string = typeof __QORPERA_WEB_MODE__ === "string" ? __QORPERA_WEB_MODE__ : "development";
