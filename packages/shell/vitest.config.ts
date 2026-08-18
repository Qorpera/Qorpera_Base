import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@qorpera/pi-coding-agent/company-operation-broker": fileURLToPath(
				new URL("../coding-agent/src/core/company-operation-broker-client.ts", import.meta.url),
			),
			"@qorpera/pi-coding-agent/company-secret-vault": fileURLToPath(
				new URL("../coding-agent/src/core/company-secret-vault.ts", import.meta.url),
			),
			"@qorpera/pi-coding-agent/company-connections": fileURLToPath(
				new URL("../coding-agent/src/core/company-connections.ts", import.meta.url),
			),
			"@qorpera/pi-coding-agent/authority": fileURLToPath(
				new URL("../coding-agent/src/core/authority.ts", import.meta.url),
			),
			"@qorpera/pi-coding-agent/app-server": fileURLToPath(
				new URL("../coding-agent/src/core/app-server.ts", import.meta.url),
			),
			"@qorpera/pi-coding-agent/company-staff": fileURLToPath(
				new URL("../coding-agent/src/core/company-staff.ts", import.meta.url),
			),
			"@qorpera/pi-coding-agent/founder-identity": fileURLToPath(
				new URL("../coding-agent/src/core/founder-identity.ts", import.meta.url),
			),
		},
	},
});
