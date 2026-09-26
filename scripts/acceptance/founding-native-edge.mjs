import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const repository = new URL("../../", import.meta.url);

/** Execute the actual Deno entrypoint with a minimal Deno.serve/env adapter.
 * Business/authentication/claim/activation code is compiled unchanged. The
 * only dependency alias maps its exact pinned npm import to that same locally
 * installed package. All network transport is constrained to the private REST
 * listener; no response, role claim or capability is synthesized here. */
export async function foundingNativeEdge({ name, restPort, serviceJwt, transport = fetch }) {
	assert(["runner-control", "runner-orchestrator"].includes(name));
	assert(Number.isSafeInteger(restPort) && restPort > 0 && restPort <= 65535);
	assert(
		typeof serviceJwt === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(serviceJwt),
	);
	const packageVersion = JSON.parse(
		await readFile(new URL("node_modules/@supabase/supabase-js/package.json", repository), "utf8"),
	).version;
	assert.equal(packageVersion, "2.112.3", "Match the actual pinned edge dependency");
	const entryPoint = fileURLToPath(new URL(`supabase/functions/${name}/index.ts`, repository));
	const compiled = await build({
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		platform: "node",
		format: "cjs",
		logLevel: "silent",
		plugins: [
			{
				name: "exact-deno-npm-pin",
				setup(builder) {
					builder.onResolve({ filter: /^npm:/ }, (args) => {
						assert.equal(args.path, "npm:@supabase/supabase-js@2.112.3");
						return { path: require.resolve("@supabase/supabase-js") };
					});
				},
			},
		],
	});
	assert.equal(compiled.outputFiles.length, 1);
	const source = compiled.outputFiles[0].text;
	const origin = `http://127.0.0.1:${restPort}`;
	const settings = { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: serviceJwt };
	let handler;
	const isolatedFetch = (input, init) => {
		const target = new URL(String(input));
		assert(
			target.origin === origin &&
				/^\/rest\/v1\/rpc\/qorpera_[a-z0-9_]+$/.test(target.pathname) &&
				!target.search &&
				!target.hash,
			"Joined edge cannot contact an external or non-RPC endpoint",
		);
		return transport(`${origin}${target.pathname.slice("/rest/v1".length)}`, { ...init, redirect: "error" });
	};
	runInNewContext(
		source,
		{
			require,
			exports: {},
			module: { exports: {} },
			Buffer,
			URL,
			URLSearchParams,
			TextEncoder,
			TextDecoder,
			Request,
			Response,
			Headers,
			AbortController,
			AbortSignal,
			crypto: webcrypto,
			fetch: isolatedFetch,
			WebSocket: class {
				constructor() {
					throw new Error("Joined edge does not expose Realtime transport");
				}
			},
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			queueMicrotask,
			process: { env: {}, version: process.version },
			console: { log() {}, warn() {}, error() {} },
			Deno: {
				env: { get: (key) => settings[key] },
				serve: (value) => {
					assert.equal(handler, undefined);
					handler = value;
				},
			},
		},
		{ timeout: 10000, filename: `isolated-${name}.cjs` },
	);
	assert.equal(typeof handler, "function");
	return {
		handler,
		sourceSha256: createHash("sha256").update(source).digest("hex"),
		boundary: `Actual ${name}/index.ts with local Deno API adapter and real private PostgREST transport`,
	};
}
