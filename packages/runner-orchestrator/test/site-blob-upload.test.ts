import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildCanonicalSiteManifest,
	htmlContainsCredentialInputs,
	parseRedirectsFile,
	scanSiteCredentialInputs,
	uploadSiteBlobsToEdge,
} from "../src/site-blob-upload.ts";

function makeFile(path: string, text: string) {
	const content = new TextEncoder().encode(text);
	const sha256 = createHash("sha256").update(content).digest("hex");
	return { path, bytes: content.byteLength, sha256, content };
}

describe("site-blob-upload", () => {
	it("detects password and credit-card inputs in HTML files", () => {
		expect(htmlContainsCredentialInputs('<form><input type="password" name="pw"></form>')).toBe(true);
		expect(htmlContainsCredentialInputs('<input type="text" autocomplete="billing cc-number">')).toBe(true);
		expect(htmlContainsCredentialInputs('<input type="email" autocomplete="email">')).toBe(false);

		const flagged = scanSiteCredentialInputs([
			makeFile("index.html", "<h1>Welcome</h1>"),
			makeFile("login.html", "<input type='password'>"),
			makeFile("app.js", '<input type="password">'),
		]);
		expect(flagged).toEqual(["login.html"]);
	});

	it("builds canonical manifest with immutable hashing detection and auto 404.html", () => {
		const files = [
			makeFile("index.html", "<h1>Home</h1>"),
			makeFile("_next/static/chunk-abcdef12.js", "console.log(1)"),
			makeFile("404.html", "<h1>Missing</h1>"),
		];
		const built = buildCanonicalSiteManifest(files);
		expect(built.manifest.not_found_page).toBe("404.html");
		expect(built.manifest.files["index.html"]?.immutable).toBe(false);
		expect(built.manifest.files["_next/static/chunk-abcdef12.js"]?.immutable).toBe(true);
		expect(built.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("maps expanded static web asset extensions to their MIME types", () => {
		const built = buildCanonicalSiteManifest([
			makeFile("engine.wasm", "\x00asm"),
			makeFile("models/hero.glb", "glTF"),
			makeFile("models/hero.gltf", "{}"),
			makeFile("captions/en.vtt", "WEBVTT"),
			makeFile("docs/guide.md", "# Guide"),
			makeFile("feed.rss", "<rss/>"),
			makeFile("feed.atom", "<feed/>"),
		]);
		expect(built.manifest.files["engine.wasm"]?.content_type).toBe("application/wasm");
		expect(built.manifest.files["models/hero.glb"]?.content_type).toBe("model/gltf-binary");
		expect(built.manifest.files["models/hero.gltf"]?.content_type).toBe("model/gltf+json");
		expect(built.manifest.files["captions/en.vtt"]?.content_type).toBe("text/vtt; charset=utf-8");
		expect(built.manifest.files["docs/guide.md"]?.content_type).toBe("text/markdown; charset=utf-8");
		expect(built.manifest.files["feed.rss"]?.content_type).toBe("application/rss+xml; charset=utf-8");
		expect(built.manifest.files["feed.atom"]?.content_type).toBe("application/atom+xml; charset=utf-8");
	});

	it("deduplicates identical blobs and uploads only missing ones via batch POST /exists + PUT", async () => {
		const existing = makeFile("a.txt", "already-on-nas");
		const fresh1 = makeFile("index.html", "<h1>Fresh</h1>");
		const freshDup = makeFile("copy.html", "<h1>Fresh</h1>");
		const stored = new Set<string>([existing.sha256]);
		const calls: string[] = [];

		const result = await uploadSiteBlobsToEdge({
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "tok-123",
			files: [existing, fresh1, freshDup],
			fetchImpl: async (url, init) => {
				expect(init.headers.authorization).toBe("Bearer tok-123");
				const sha = url.split("/").at(-1) ?? "";
				calls.push(`${init.method}:${sha}`);
				if (init.method === "POST" && url.endsWith("/_internal/blobs/exists")) {
					const payload = JSON.parse(new TextDecoder().decode(init.body)) as { hashes: string[] };
					return {
						status: 200,
						json: async () => ({ existing: payload.hashes.filter((h) => stored.has(h)) }),
					};
				}
				if (init.method === "HEAD") {
					return { status: stored.has(sha) ? 200 : 404 };
				}
				stored.add(sha);
				return { status: 201 };
			},
		});

		expect(result.fileCount).toBe(3);
		expect(result.uploadedBlobs).toBe(1);
		expect(result.deduplicatedBlobs).toBe(1);
		expect(result.hasCredentialInputs).toBe(false);
		expect(calls.filter((c) => c.startsWith("POST:"))).toHaveLength(1);
		expect(calls.filter((c) => c.startsWith("HEAD:"))).toHaveLength(0);
		expect(calls.filter((c) => c.startsWith("PUT:"))).toHaveLength(1);
	});

	it("falls back to HEAD + PUT when POST /_internal/blobs/exists returns 404 or 405", async () => {
		for (const unsupportedStatus of [404, 405] as const) {
			const existing = makeFile("a.txt", "already-on-nas");
			const fresh = makeFile("index.html", "<h1>Fresh</h1>");
			const stored = new Set<string>([existing.sha256]);
			const calls: string[] = [];

			const result = await uploadSiteBlobsToEdge({
				routerInternalUrl: "http://127.0.0.1:8094",
				controlToken: "tok-fallback",
				files: [existing, fresh],
				fetchImpl: async (url, init) => {
					const sha = url.split("/").at(-1) ?? "";
					calls.push(`${init.method}:${sha}`);
					if (init.method === "POST") return { status: unsupportedStatus };
					if (init.method === "HEAD") return { status: stored.has(sha) ? 200 : 404 };
					stored.add(sha);
					return { status: 201 };
				},
			});

			expect(result.uploadedBlobs).toBe(1);
			expect(result.deduplicatedBlobs).toBe(1);
			expect(calls.filter((c) => c.startsWith("POST:"))).toHaveLength(1);
			expect(calls.filter((c) => c.startsWith("HEAD:"))).toHaveLength(2);
			expect(calls.filter((c) => c.startsWith("PUT:"))).toHaveLength(1);
		}
	});

	it("retries transient 5xx blob uploads and rejects protocol-relative open redirects", async () => {
		const rules = parseRedirectsFile(
			"/ok /target 301\n/bad //evil.example/steal 302\n/ext https://example.dk/x 301\n",
		);
		expect(rules).toEqual([
			{ from: "/ok", to: "/target", status: 301 },
			{ from: "/ext", to: "https://example.dk/x", status: 301 },
		]);

		const file = makeFile("index.html", "<h1>Retry test</h1>");
		let putAttempts = 0;
		const res = await uploadSiteBlobsToEdge({
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "tok-retry",
			files: [file],
			fetchImpl: async (_url, init) => {
				if (init.method === "HEAD") return { status: 404 };
				putAttempts += 1;
				if (putAttempts < 2) return { status: 503 };
				return { status: 201 };
			},
		});
		expect(res.uploadedBlobs).toBe(1);
		expect(putAttempts).toBe(2);
	});

	it("uploads multiple missing blobs in one POST /_internal/blobs/batch request and falls back to PUT on 404", async () => {
		const f1 = makeFile("index.html", "<h1>One</h1>");
		const f2 = makeFile("app.js", "console.log('two')");
		const f3 = makeFile("style.css", "body{color:#111}");
		const calls: string[] = [];

		const batched = await uploadSiteBlobsToEdge({
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "tok-batch",
			files: [f1, f2, f3],
			fetchImpl: async (url, init) => {
				calls.push(`${init.method}:${url.split("/").at(-1)}`);
				if (init.method === "POST" && url.endsWith("/_internal/blobs/exists")) {
					return { status: 200, json: async () => ({ existing: [] }) };
				}
				if (init.method === "POST" && url.endsWith("/_internal/blobs/batch")) {
					expect(init.headers["content-type"]).toBe("application/vnd.qorpera.blob-batch+v1");
					return { status: 200, json: async () => ({ stored: 3, exists: 0 }) };
				}
				return { status: 404 };
			},
		});
		expect(batched.uploadedBlobs).toBe(3);
		expect(batched.deduplicatedBlobs).toBe(0);
		expect(calls).toEqual(["POST:exists", "POST:batch"]);

		const fallbackCalls: string[] = [];
		const fallback = await uploadSiteBlobsToEdge({
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "tok-batch-fallback",
			files: [f1, f2],
			fetchImpl: async (url, init) => {
				fallbackCalls.push(`${init.method}:${url.split("/").at(-1)}`);
				if (init.method === "POST" && url.endsWith("/_internal/blobs/exists")) {
					return { status: 200, json: async () => ({ existing: [] }) };
				}
				if (init.method === "POST" && url.endsWith("/_internal/blobs/batch")) {
					return { status: 404 };
				}
				return { status: 201 };
			},
		});
		expect(fallback.uploadedBlobs).toBe(2);
		expect(fallbackCalls.filter((c) => c.startsWith("PUT:"))).toHaveLength(2);
	});
});
