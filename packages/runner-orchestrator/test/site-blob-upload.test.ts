import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildCanonicalSiteManifest,
	htmlContainsCredentialInputs,
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

	it("deduplicates identical blobs and uploads only missing ones via HEAD + PUT", async () => {
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
		expect(calls.filter((c) => c.startsWith("PUT:"))).toHaveLength(1);
	});
});
