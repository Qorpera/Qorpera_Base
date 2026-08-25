import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	companyIndex: fileURLToPath(new URL("./packages/company/src/index.ts", import.meta.url)),
	companySource: fileURLToPath(new URL("./packages/company/src", import.meta.url)),
	contractsIndex: fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@qorpera\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@qorpera\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@qorpera\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@qorpera\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@qorpera\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@qorpera\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			{ find: /^@qorpera\/company$/, replacement: workspaceSourcePaths.companyIndex },
			{
				find: /^@qorpera\/company\/(.+)$/,
				replacement: `${workspaceSourcePaths.companySource}/$1.ts`,
			},
			{ find: /^@qorpera\/contracts$/, replacement: workspaceSourcePaths.contractsIndex },
		],
	},
});
