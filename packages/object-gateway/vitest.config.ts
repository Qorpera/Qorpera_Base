import { mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

export default mergeConfig(base,{
	test: {
		testTimeout: 30_000,
	},
});
