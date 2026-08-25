import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			testTimeout: 30_000,
		},
		resolve: {
			alias: [
				{
					find: /^@qorpera\/pi-coding-agent\/company$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/core/company.ts", import.meta.url)),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/company-operation-broker$/,
					replacement: fileURLToPath(
						new URL("../coding-agent/src/core/company-operation-broker-client.ts", import.meta.url),
					),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/company-secret-vault$/,
					replacement: fileURLToPath(
						new URL("../coding-agent/src/core/company-secret-vault.ts", import.meta.url),
					),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/company-connections$/,
					replacement: fileURLToPath(
						new URL("../coding-agent/src/core/company-connections.ts", import.meta.url),
					),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/company-connectors$/,
					replacement: fileURLToPath(
						new URL("../coding-agent/src/core/company-connectors.ts", import.meta.url),
					),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/authority$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/core/authority.ts", import.meta.url)),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/app-server$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/core/app-server.ts", import.meta.url)),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/company-staff$/,
					replacement: fileURLToPath(
						new URL("../coding-agent/src/core/company-staff.ts", import.meta.url),
					),
				},
				{
					find: /^@qorpera\/pi-coding-agent\/founder-identity$/,
					replacement: fileURLToPath(
						new URL("../coding-agent/src/core/founder-identity.ts", import.meta.url),
					),
				},
			],
		},
	}),
);
