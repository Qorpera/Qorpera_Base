import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		// Preserve styles used by DOM regressions instead of returning empty CSS mocks.
		css: { include: [/\.css\?raw$/] },
	},
});
