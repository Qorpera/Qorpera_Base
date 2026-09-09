import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DEFAULT_CLOUD_CONFIG, cloudConnectSources, parseCloudConfig } from "../src/cloud/deployment-config.ts";

export function prepareDeployment({ configPath, release = false, serve = false, headersTemplate }) {
	if (release && serve) throw new Error("A release build cannot use the development server");
	if (release && !configPath) throw new Error("A release build requires QORPERA_WEB_CONFIG");
	if (configPath && (!statSync(configPath).isFile() || statSync(configPath).size > 8192))
		throw new Error("Public cloud configuration must be a file of at most 8192 bytes");
	const config = parseCloudConfig(configPath ? JSON.parse(readFileSync(configPath, "utf8")) : DEFAULT_CLOUD_CONFIG, release);
	const marker = "__QORPERA_WEB_CONNECT_SRC__";
	if (headersTemplate.split(marker).length !== 2) throw new Error("Expected one connect-src marker in the header template");
	const headers = headersTemplate.replace(marker, cloudConnectSources(config));
	const locked = Boolean(configPath) || release;
	return {
		config,
		headers,
		define: {
			__QORPERA_WEB_CLOUD_CONFIG__: JSON.stringify(config),
			__QORPERA_WEB_CONFIG_LOCKED__: JSON.stringify(locked),
		},
		manifest: {
			schema: "qorpera.web-deployment/v1",
			release,
			config,
			configOverrideAllowed: !locked,
			headersSha256: createHash("sha256").update(headers).digest("hex"),
		},
	};
}
