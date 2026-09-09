/** Preserve the existing ESM artifact URL while requiring Node builtins
 * through CommonJS. Node 22's ESM facade for node:http evaluates WebSocket
 * exports and eagerly loads Undici/WASM, even for a named request import. */
export const jitlessServiceBundleOptions = Object.freeze({
	format: "cjs",
	define: { "import.meta.url": "__qorperaModuleUrl" },
	banner: {
		js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const __qorperaModuleUrl = import.meta.url; const require = __qorperaCreateRequire(__qorperaModuleUrl); const module = { exports: {} }; const exports = module.exports;',
	},
});
