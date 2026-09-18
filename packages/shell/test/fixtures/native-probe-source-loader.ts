import { registerHooks } from "node:module";

// Standalone acceptance runs the checked source graph, as Vitest does. It must
// neither require an application build nor pick up stale package dist files.
registerHooks({
	resolve(specifier, context, nextResolve) {
		const match = /^@qorpera\/(runtime|contracts|company|cloud-client)(?:\/([a-z0-9-]+))?$/.exec(specifier);
		if (!match) return nextResolve(specifier, context);
		return {
			url: new URL(`../../../${match[1]}/src/${match[2] ?? "index"}.ts`, import.meta.url).href,
			shortCircuit: true,
		};
	},
});
