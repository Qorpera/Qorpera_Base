import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	companyIndex: fileURLToPath(new URL("./packages/company/src/index.ts", import.meta.url)),
	companySource: fileURLToPath(new URL("./packages/company/src", import.meta.url)),
	contractsIndex: fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
 ...["runtime", "cloud-client"].flatMap((name) => [
 { find: new RegExp('^@qorpera/' + name + '$'), replacement: fileURLToPath(new URL('./packages/' + name + '/src/index.ts', import.meta.url)) },
 { find: new RegExp('^@qorpera/' + name + '/(.+)$'), replacement: fileURLToPath(new URL('./packages/' + name + '/src/', import.meta.url)) + '$1.ts' },
 ]),
			{ find: /^@qorpera\/company$/, replacement: workspaceSourcePaths.companyIndex },
			{
				find: /^@qorpera\/company\/(.+)$/,
				replacement: `${workspaceSourcePaths.companySource}/$1.ts`,
			},
			{ find: /^@qorpera\/contracts$/, replacement: workspaceSourcePaths.contractsIndex },
		],
	},
});
