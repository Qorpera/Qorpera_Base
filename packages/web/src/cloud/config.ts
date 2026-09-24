import { type CloudConfig, DEFAULT_CLOUD_CONFIG, parseCloudConfig } from "./deployment-config.ts";

export { type CloudConfig, DEFAULT_CLOUD_CONFIG } from "./deployment-config.ts";

declare const __QORPERA_WEB_CLOUD_CONFIG__: CloudConfig;
const builtConfig =
	typeof __QORPERA_WEB_CLOUD_CONFIG__ === "undefined"
		? DEFAULT_CLOUD_CONFIG
		: parseCloudConfig(__QORPERA_WEB_CLOUD_CONFIG__);

/** The endpoints compiled into this build. The browser never overrides them. */
export function resolveCloudConfig(): CloudConfig {
	return builtConfig;
}
