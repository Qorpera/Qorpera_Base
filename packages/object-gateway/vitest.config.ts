import { mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

export default mergeConfig(base,{
	test: {
		testTimeout: 30_000,
		// The folder service's unit starts node with V8's linear-time regular expressions (its search's `regex`).
		execArgv: ["--enable-experimental-regexp-engine"],
	},
});
