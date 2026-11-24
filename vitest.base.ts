import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	contractsIndex: fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
 ...["runtime", "cloud-client"].flatMap((name) => [
 { find: new RegExp('^@qorpera/' + name + '$'), replacement: fileURLToPath(new URL('./packages/' + name + '/src/index.ts', import.meta.url)) },
 { find: new RegExp('^@qorpera/' + name + '/(.+)$'), replacement: fileURLToPath(new URL('./packages/' + name + '/src/', import.meta.url)) + '$1.ts' },
 ]),
			{ find: /^@qorpera\/contracts$/, replacement: workspaceSourcePaths.contractsIndex },
		],
	},
});
