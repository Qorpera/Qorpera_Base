import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	IDENTITY_TOKENS_JSON_PATH,
	PRODUCT_SPECS_PATH,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeHostJob } from "../src/code-host-jobs.ts";
import { startCodeArea } from "../src/code-host-jobs.ts";
import type { LxdExecPipeRequest, LxdExecPipeResult } from "../src/lxd-client.ts";
import {
	type BlobUploadFetch,
	isNativeServableSitePath,
	isNativeSitePath,
	nativeSiteTreeProblem,
} from "../src/site-blob-upload.ts";
import { type SurfaceCodeHostControl, SurfaceCodeHostWorker } from "../src/surface-code-host-worker.ts";
import { collectAndUploadPreviewBuildToEdge } from "../src/surface-preview-build-upload.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function runLocalExecPipe(request: LxdExecPipeRequest, signal: AbortSignal): Promise<LxdExecPipeResult> {
	return await new Promise<LxdExecPipeResult>((resolve, reject) => {
		const [cmd, ...args] = request.command;
		const child = spawn(cmd!, args, {
			cwd: request.cwd,
			env: { ...request.environment },
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(outChunks),
				stderrTail: Buffer.concat(errChunks).subarray(-request.stderrTailBytes),
			});
		});
		if (request.stdin instanceof Uint8Array) {
			child.stdin.end(Buffer.from(request.stdin));
		} else {
			child.stdin.end();
		}
	});
}

function createFakeEdgeRouter() {
	const blobs = new Map<string, Uint8Array>();
	const calls: { method: string; url: string }[] = [];
	const fetchImpl: BlobUploadFetch = async (url, init) => {
		calls.push({ method: init.method, url });
		if (init.method === "POST" && url.endsWith("/_internal/blobs/exists")) {
			const parsed = JSON.parse(Buffer.from(init.body ?? new Uint8Array()).toString("utf8")) as { hashes: string[] };
			const existing = parsed.hashes.filter((hash) => blobs.has(hash));
			return { status: 200, json: async () => ({ existing }) };
		}
		const shaMatch = /\/_internal\/blobs\/([0-9a-f]{64})$/.exec(url);
		if (shaMatch) {
			const sha = shaMatch[1]!;
			if (init.method === "HEAD") return { status: blobs.has(sha) ? 200 : 404 };
			if (init.method === "PUT") {
				const bytes = init.body ? new Uint8Array(init.body) : new Uint8Array();
				const computed = createHash("sha256").update(bytes).digest("hex");
				if (computed !== sha) return { status: 400 };
				const existed = blobs.has(sha);
				blobs.set(sha, bytes);
				return { status: existed ? 200 : 201 };
			}
		}
		return { status: 404 };
	};
	return { blobs, calls, fetchImpl };
}

describe("native site path and limits", () => {
	it("allows framework route paths and rejects traversal, query chars, and reserved prefixes", () => {
		expect(isNativeSitePath("routes/[slug]/page.html")).toBe(true);
		expect(isNativeSitePath("@scope/(marketing)/chunk+1.cjs")).toBe(true);
		expect(isNativeServableSitePath("routes/[slug]/page.html")).toBe(true);
		expect(isNativeServableSitePath("chunks/bundle.cjs")).toBe(true);
		expect(isNativeSitePath("__qorpera/inspector.js")).toBe(false);
		expect(isNativeSitePath("../escape.html")).toBe(false);
		expect(isNativeSitePath(".hidden/file.html")).toBe(false);
		expect(isNativeSitePath("page?x=1.html")).toBe(false);
		expect(isNativeSitePath("a/b/c#hash.html")).toBe(false);
		expect(
			nativeSiteTreeProblem([
				{ path: "index.html", bytes: 10 },
				{ path: "_redirects", bytes: 20 },
				{ path: "routes/[id]/page.html", bytes: 30 },
			]),
		).toBeNull();
	});
});

describe("collectAndUploadPreviewBuildToEdge", () => {
	it("streams sites over 500 files and 100 folders directly to edge and deduplicates unchanged blobs on rebuild", async () => {
		const root = await makeTempDir("preview-build-upload-");
		const dist = join(root, "dist");
		const company = join(root, "company");
		await mkdir(dist, { recursive: true });
		await mkdir(dirname(join(company, IDENTITY_TOKENS_JSON_PATH)), { recursive: true });
		await mkdir(join(company, "products/band"), { recursive: true });

		await writeFile(join(dist, "index.html"), "<!doctype html><html><body><h1>V1</h1></body></html>");
		await writeFile(join(dist, "_redirects"), "/docs/* /docs/index.html 200\n");
		await writeFile(join(dist, "_headers"), "/assets/*\n  x-custom-test: ok\n");
		await mkdir(join(dist, "routes/[slug]"), { recursive: true });
		await writeFile(join(dist, "routes/[slug]/page.html"), "<p>dynamic route</p>");
		for (let i = 0; i < 550; i += 1) {
			const folder = join(dist, `chunks/f${String(i % 130).padStart(3, "0")}`);
			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, `chunk-${i}.js`), `export const n = ${i};\n`);
		}
		await writeFile(join(company, IDENTITY_TOKENS_JSON_PATH), JSON.stringify({ colors: { primary: "#112233" } }));
		await writeFile(join(company, "products/band/specs.json"), JSON.stringify({ model: "X1" }));

		const edge = createFakeEdgeRouter();
		const uid = process.getuid?.() ?? 1000;
		const gid = process.getgid?.() ?? 1000;

		const first = await collectAndUploadPreviewBuildToEdge({
			execPipe: runLocalExecPipe,
			uid,
			gid,
			outputDir: dist,
			recipeFolder: "dist",
			companyMountDir: company,
			productFolderRoots: ["products/band"],
			secretValues: ["super-secret-token-9999"],
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "test-token",
			fetchImpl: edge.fetchImpl,
			signal: new AbortController().signal,
		});

		expect(first.outcome).toBe("built");
		if (first.outcome !== "built") throw new Error("expected built");
		expect(first.builtTreeSha).toBeNull();
		expect(first.native).toBeDefined();
		expect(first.native!.fileCount).toBe(556);
		expect(first.native!.hasCredentialInputs).toBe(false);
		expect(first.native!.manifest.files["routes/[slug]/page.html"]).toBeDefined();
		expect(first.native!.manifest.files[SURFACE_IDENTITY_CSS_MOUNT_PATH]).toBeDefined();
		expect(first.native!.manifest.files[`${SURFACE_SHARED_DIR}/${PRODUCT_SPECS_PATH}`]).toBeDefined();
		expect(first.native!.manifest.files._redirects).toBeUndefined();
		expect(first.native!.manifest.redirects).toEqual([{ from: "/docs/*", to: "/docs/index.html", status: 200 }]);
		expect(first.native!.manifest.headers).toEqual([{ path_prefix: "/assets/", headers: { "x-custom-test": "ok" } }]);

		edge.calls.length = 0;
		await writeFile(join(dist, "index.html"), "<!doctype html><html><body><h1>V2</h1></body></html>");
		const second = await collectAndUploadPreviewBuildToEdge({
			execPipe: runLocalExecPipe,
			uid,
			gid,
			outputDir: dist,
			recipeFolder: "dist",
			companyMountDir: company,
			productFolderRoots: ["products/band"],
			secretValues: ["super-secret-token-9999"],
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "test-token",
			fetchImpl: edge.fetchImpl,
			signal: new AbortController().signal,
		});

		expect(second.outcome).toBe("built");
		const putCalls = edge.calls.filter((call) => call.method === "PUT");
		expect(putCalls).toHaveLength(1);
		const existsCalls = edge.calls.filter((call) => call.method === "POST");
		expect(existsCalls).toHaveLength(2);
	});

	it("detects credential inputs and blocks secret leaks without exposing the secret value", async () => {
		const root = await makeTempDir("preview-build-security-");
		const dist = join(root, "dist");
		await mkdir(dist, { recursive: true });
		await writeFile(join(dist, "index.html"), '<form><input type="password" name="pw"></form>');

		const edge = createFakeEdgeRouter();
		const uid = process.getuid?.() ?? 1000;
		const gid = process.getgid?.() ?? 1000;

		const credsResult = await collectAndUploadPreviewBuildToEdge({
			execPipe: runLocalExecPipe,
			uid,
			gid,
			outputDir: dist,
			recipeFolder: "dist",
			companyMountDir: join(root, "missing-company"),
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "test-token",
			fetchImpl: edge.fetchImpl,
			signal: new AbortController().signal,
		});
		expect(credsResult.outcome).toBe("built");
		if (credsResult.outcome === "built") {
			expect(credsResult.native?.hasCredentialInputs).toBe(true);
		}

		await writeFile(join(dist, "app.js"), 'const k = "super-secret-value-12345";');
		const secretResult = await collectAndUploadPreviewBuildToEdge({
			execPipe: runLocalExecPipe,
			uid,
			gid,
			outputDir: dist,
			recipeFolder: "dist",
			companyMountDir: join(root, "missing-company"),
			secretValues: ["super-secret-value-12345"],
			routerInternalUrl: "http://127.0.0.1:8094",
			controlToken: "test-token",
			fetchImpl: edge.fetchImpl,
			signal: new AbortController().signal,
		});
		expect(secretResult.outcome).toBe("failed");
		if (secretResult.outcome === "failed") {
			expect(secretResult.errorDetail).toContain("SITE_HOLDS_SECRET");
			expect(secretResult.errorDetail).not.toContain("super-secret-value-12345");
		}
	});
});

describe("SurfaceCodeHostWorker native edge registration", () => {
	it("verifies cached native build blobs and registers directly in one RPC, rebuilding on missing blob", async () => {
		const root = await makeTempDir("surface-worker-native-");
		const companyRoot = join(root, "company");
		const scratchRoot = join(root, "scratch");
		await mkdir(companyRoot, { recursive: true });
		await mkdir(scratchRoot, { recursive: true });
		const repo = { host: "qorpera" as const, owner: "acme", name: "web", baseBranch: "main" };
		const setupJob: CodeHostJob = {
			shell: localShell([]),
			layout: { companyRoot, scratchRoot, git: "/usr/bin/git" },
			signal: new AbortController().signal,
		};
		await startCodeArea(setupJob, { repository: repo });

		const htmlBytes = Buffer.from("<h1>Cached Native</h1>");
		const htmlSha = createHash("sha256").update(htmlBytes).digest("hex");
		const manifest = {
			files: {
				"index.html": {
					sha256: htmlSha,
					bytes: htmlBytes.byteLength,
					content_type: "text/html; charset=utf-8",
					immutable: false,
				},
			},
			redirects: [],
			headers: [],
			spa_fallback: null,
			not_found_page: null,
		};
		const manifestSha256 = createHash("sha256")
			.update(`index.html\t${htmlSha}\t${htmlBytes.byteLength}`, "utf8")
			.digest("hex");

		const edge = createFakeEdgeRouter();
		edge.blobs.set(htmlSha, new Uint8Array(htmlBytes));

		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const previewId = "11111111-1111-4111-8111-111111111111";
		const surfaceId = "22222222-2222-4222-8222-222222222222";
		const profileId = "33333333-3333-4333-8333-333333333333";
		const environmentId = "44444444-4444-4444-8444-444444444444";
		const buildId = "55555555-5555-4555-8555-555555555555";
		const versionId = "66666666-6666-4666-8666-666666666666";
		const siteId = "77777777-7777-4777-8777-777777777777";

		const control: SurfaceCodeHostControl = {
			async call(method, args) {
				calls.push({ method, args });
				if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
					return {
						sessions: [],
						previews: [
							{
								previewId,
								surfaceId,
								profileId,
								environmentId,
								repositoryKey: "acme/web",
								shortHostId: "0",
								baseSha: "0".repeat(40),
								selectedChangeIds: [],
								changes: [],
								leaseToken: "88888888-8888-4888-8888-888888888888",
							},
						],
						merges: [],
						publishes: [],
						cleanups: [],
					};
				}
				if (method === "qorpera_surface_shared_product_folder_roots") return [];
				if (method === "qorpera_surface_request_build") {
					if (args.p_stale_built_tree === manifestSha256) {
						return { state: "waiting", buildId };
					}
					return {
						state: "built",
						buildId,
						builtTreeSha: null,
						manifestSha256,
						manifestJson: manifest,
						fileCount: 1,
						totalBytes: htmlBytes.byteLength,
						hasCredentialInputs: false,
					};
				}
				if (method === "qorpera_surface_site_deployment_register") {
					return { state: "ready", versionId, siteId, siteSlug: "web" };
				}
				if (method === "qorpera_surface_complete_preview") {
					return { previewId, status: args.p_status };
				}
				return {};
			},
		};

		const worker = new SurfaceCodeHostWorker({
			control,
			hosts: {
				async run(_profileId, _envId, signal, fn) {
					return await fn(
						{
							shell: localShell([]),
							layout: { companyRoot, scratchRoot, git: "/usr/bin/git" },
							signal,
						},
						{
							begin: async () => ({ state: "blocking" as const, held: 0 }),
							end: async () => {},
						},
					);
				},
			},
			readPlan: async () => ({
				kind: "build",
				recipe: { run: "npm run build", cwd: ".", folder: "dist", timeoutSeconds: 120 },
			}),
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8094",
				controlToken: "test-token",
				fetchImpl: edge.fetchImpl,
			},
		});

		const firstPass = await worker.pass(new AbortController().signal);
		expect(firstPass).toEqual({ previews: 1, merges: 0, publishes: 0, cleanups: 0, failed: 0 });
		expect(calls.some((c) => c.method === "qorpera_surface_site_version_begin")).toBe(false);
		expect(calls.find((c) => c.method === "qorpera_surface_site_deployment_register")?.args).toMatchObject({
			p_surface_id: surfaceId,
			p_manifest_sha256: manifestSha256,
			p_file_count: 1,
			p_promote_live: false,
		});
		expect(calls.find((c) => c.method === "qorpera_surface_complete_preview")?.args).toMatchObject({
			p_preview_id: previewId,
			p_status: "ready",
			p_site_version_id: versionId,
		});

		edge.blobs.clear();
		calls.length = 0;
		const secondPass = await worker.pass(new AbortController().signal);
		expect(secondPass).toEqual({ previews: 1, merges: 0, publishes: 0, cleanups: 0, failed: 0 });
		const requestBuildCalls = calls.filter((c) => c.method === "qorpera_surface_request_build");
		expect(requestBuildCalls).toHaveLength(2);
		expect(requestBuildCalls[1]?.args.p_stale_built_tree).toBe(manifestSha256);
		expect(calls.some((c) => c.method === "qorpera_surface_site_deployment_register")).toBe(false);
	});
});
