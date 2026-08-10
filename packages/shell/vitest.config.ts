import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@qorpera/pi-coding-agent/authority": fileURLToPath(
				new URL("../coding-agent/src/core/authority.ts", import.meta.url),
			),
		},
	},
});
