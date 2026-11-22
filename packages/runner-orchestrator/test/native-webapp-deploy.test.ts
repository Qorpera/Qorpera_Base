import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readCodeChecks } from "../src/code-checks.ts";
import { codeSiteCollectAnswer, codeSiteReported } from "../src/code-site.ts";
import { type CodeSiteUploadFile, CodeSiteUploads } from "../src/code-site-uploads.ts";
import { CompanyMachineSecretsManager } from "../src/company-machine-secrets.ts";
import {
	buildNativeAppEnvSpec,
	deployCodeSiteToNativeEdge,
	fetchAppLogs,
	NATIVE_WEB_HOSTING_RPCS,
	parseNativeCodeSiteSpec,
	triggerBlueGreenAppDeploy,
} from "../src/native-webapp-deploy.ts";
import { parseHeadersFile, parseRedirectsFile, uploadSiteBlobsToEdge } from "../src/site-blob-upload.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const ROUTER_BIN = join(REPO_ROOT, "crates/qorpera-web-router/target/debug/qorpera-web-router");
const APP_HOST_BIN = join(REPO_ROOT, "crates/qorpera-app-host/target/debug/qorpera-app-host");

const BLOB_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const MACHINE_SHA = "c".repeat(64);
const IMAGE_REF = `127.0.0.1:5000/qorpera-apps/demo@sha256:${"d".repeat(64)}`;

function makeFile(path: string, body: string): CodeSiteUploadFile {
	const content = new TextEncoder().encode(body);
	const sha256 = createHash("sha256").update(content).digest("hex");
	return { path, bytes: content.byteLength, sha256, content };
}

function readChecksObj(obj: Record<string, unknown>) {
	return readCodeChecks({
		blob: BLOB_SHA,
		entry: { kind: "file", bytes: new TextEncoder().encode(JSON.stringify(obj)) },
	});
}

async function freePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const address = srv.address();
			if (!address || typeof address === "string") {
				srv.close();
				reject(new Error("no port"));
				return;
			}
			const port = address.port;
			srv.close(() => resolvePort(port));
		});
		srv.on("error", reject);
	});
}

async function waitForHealth(url: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`Timed out waiting for ${url}`);
}

describe("checks.json static, server, and hybrid site recipes", () => {
	const baseChecks = [{ name: "build", run: "npm run build" }];

	it("parses server webapp recipes without requiring a static folder", () => {
		const read = readChecksObj({
			checks: baseChecks,
			site: {
				kind: "server",
				name: "booking-app",
				title: "Booking App",
				port: 3000,
				healthPath: "/api/health",
				dockerfile: "Dockerfile",
				idleTimeoutSec: 600,
				memoryMb: 1024,
				vcpuLimit: 2,
			},
		});
		expect(read.state).toBe("ok");
		if (read.state !== "ok") return;
		expect(read.site).toEqual({
			folder: ".",
			name: "booking-app",
			title: "Booking App",
			kind: "server",
			port: 3000,
			healthPath: "/api/health",
			dockerfile: "Dockerfile",
			idleTimeoutSec: 600,
			memoryMb: 1024,
			vcpuLimit: 2,
		});
	});

	it("parses hybrid and SPA recipes and rejects invalid values", () => {
		const hybrid = readChecksObj({
			checks: baseChecks,
			site: {
				kind: "hybrid",
				folder: "dist/client",
				port: 8080,
				spaFallback: "index.html",
			},
		});
		expect(hybrid.state).toBe("ok");
		if (hybrid.state === "ok") {
			expect(hybrid.site?.kind).toBe("hybrid");
			expect(hybrid.site?.folder).toBe("dist/client");
			expect(hybrid.site?.spaFallback).toBe("index.html");
		}

		const missingFolder = readChecksObj({
			checks: baseChecks,
			site: { kind: "hybrid", port: 8080 },
		});
		expect(missingFolder.state).toBe("refused");

		const badPort = readChecksObj({
			checks: baseChecks,
			site: { kind: "server", port: 70000 },
		});
		expect(badPort.state).toBe("refused");

		const badHealth = readChecksObj({
			checks: baseChecks,
			site: { kind: "server", healthPath: "health" },
		});
		expect(badHealth.state).toBe("refused");
	});

	it("emits v2 code-site report for server/hybrid and parses v2 collect answers", () => {
		const parsed = codeSiteCollectAnswer(`tree ${TREE_SHA}\nfiles 0\nbytes 0\n`, 0, { allowEmpty: true });
		expect(parsed).toEqual({ made: { tree: TREE_SHA, files: 0, bytes: 0 } });
		expect(codeSiteCollectAnswer(`tree ${TREE_SHA}\nfiles 0\nbytes 0\n`, 0)).toBeNull();

		const reported = codeSiteReported({
			state: "made",
			tree: TREE_SHA,
			files: 0,
			bytes: 0,
			folder: ".",
			name: "booking-app",
			title: "Booking App",
			kind: "server",
			port: 3000,
			healthPath: "/api/health",
		});
		expect(reported).toEqual({
			state: "made",
			site: {
				schema: "qorpera.code-site/v2",
				kind: "server",
				tree: TREE_SHA,
				files: 0,
				bytes: 0,
				folder: ".",
				name: "booking-app",
				title: "Booking App",
				port: 3000,
				healthPath: "/api/health",
			},
		});
		expect(parseNativeCodeSiteSpec(reported?.site)).toMatchObject({
			schema: "qorpera.code-site/v2",
			kind: "server",
			port: 3000,
			healthPath: "/api/health",
		});
	});
});

describe("_redirects and _headers parsing", () => {
	it("parses Cloudflare/Netlify compatible _redirects and _headers", () => {
		const redirects = parseRedirectsFile(
			["# comment", "/old/* /new/:splat 301", "/app/* /index.html 200", "/blog https://blog.example.dk/ 302"].join(
				"\n",
			),
		);
		expect(redirects).toEqual([
			{ from: "/old/*", to: "/new/:splat", status: 301 },
			{ from: "/app/*", to: "/index.html", status: 200 },
			{ from: "/blog", to: "https://blog.example.dk/", status: 302 },
		]);

		const headers = parseHeadersFile(
			[
				"/assets/*",
				"  Cache-Control: public, max-age=31536000",
				"  X-Custom-Tag: v1",
				"/*",
				"  X-Frame-Options: DENY",
			].join("\n"),
		);
		expect(headers).toEqual([
			{ path_prefix: "/assets/", headers: { "cache-control": "public, max-age=31536000", "x-custom-tag": "v1" } },
			{ path_prefix: "/", headers: { "x-frame-options": "DENY" } },
		]);
	});
});

describe("CodeSiteUploads with nativeEdge for static and full-stack webapps", () => {
	it("uploads static assets to blob store and builds server webapps into native deployments", async () => {
		expect(NATIVE_WEB_HOSTING_RPCS).toEqual([
			"qorpera_web_code_deployment_register",
			"qorpera_code_site_for_auto_redeploy",
			"qorpera_emit_app_unhealthy_routine_wakes",
		]);
		expect(
			buildNativeAppEnvSpec({
				port: 3000,
				repositoryOwner: "company",
				repositoryName: "booking",
				companyDataUrl: "http://127.0.0.1:8088",
			}),
		).toEqual({
			PORT: "3000",
			NODE_ENV: "production",
			QORPERA_REPOSITORY: "company/booking",
			QORPERA_COMPANY_DATA_URL: "http://127.0.0.1:8088",
		});

		const storedBlobs = new Map<string, Uint8Array>();
		const blobFetch = vi.fn(async (url: string, init: { method: "HEAD" | "PUT"; body?: Uint8Array }) => {
			const sha = url.split("/").at(-1) as string;
			if (init.method === "HEAD") return { status: storedBlobs.has(sha) ? 200 : 404 };
			if (init.body) storedBlobs.set(sha, init.body);
			return { status: 201 };
		});
		const buildAppImage = vi.fn(async () => ({ ociImageRef: IMAGE_REF, builtMs: 42 }));
		const registeredCalls: Record<string, unknown>[] = [];

		const control = {
			call: vi.fn(async (method: string, args: Record<string, unknown>) => {
				if (method === "qorpera_code_sites_due") {
					return {
						schema: "qorpera.code-sites-due/v1",
						sites: [
							{
								companyId: COMPANY,
								environmentId: ENVIRONMENT,
								owner: "company",
								name: "marketing",
								change: 5,
								site: {
									schema: "qorpera.code-site/v1",
									tree: TREE_SHA,
									files: 2,
									bytes: 60,
									folder: "dist",
									name: "nordic-marketing",
									title: "Nordic Marketing",
								},
							},
							{
								companyId: COMPANY,
								environmentId: ENVIRONMENT,
								owner: "company",
								name: "booking",
								change: 8,
								site: {
									schema: "qorpera.code-site/v2",
									kind: "server",
									tree: TREE_SHA,
									files: 0,
									bytes: 0,
									folder: ".",
									name: "booking-app",
									title: "Booking App",
									port: 3000,
									healthPath: "/health",
								},
							},
						],
					};
				}
				if (method === "qorpera_web_code_deployment_register") {
					registeredCalls.push(args);
					return {
						schema: "qorpera.web-code-deployment/v1",
						state: "ready",
						siteId: SITE_ID,
						slug: args.p_name === "booking" ? "booking-app" : "nordic-marketing",
						versionId: VERSION_ID,
						deploymentId: DEPLOYMENT_ID,
						versionNumber: 1,
						kind: args.p_kind,
					};
				}
				throw new Error(`unexpected rpc ${method}`);
			}),
		};

		const staticFiles = [
			makeFile("index.html", "<html><body>Hej</body></html>"),
			makeFile("_redirects", "/old / 301\n"),
		];
		const manifestSha256 = createHash("sha256")
			.update(staticFiles.map((f) => `${f.path}\t${f.sha256}\t${f.bytes}`).join("\n"))
			.digest("hex");

		const uploads = new CodeSiteUploads({
			control,
			hosts: {
				run: async (_c, _e, _s, fn) => await fn({} as Parameters<typeof fn>[0], {} as Parameters<typeof fn>[1]),
			},
			read: async () => ({ files: staticFiles, manifestSha256 }),
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8094",
				controlToken: "edge-token",
				buildAppImage,
				fetchImpl: blobFetch,
			},
		});

		const result = await uploads.pass(new AbortController().signal);
		expect(result).toEqual({ uploaded: 2, failed: 0 });
		expect(storedBlobs.size).toBe(1);
		expect(buildAppImage).toHaveBeenCalledTimes(1);
		expect(registeredCalls).toHaveLength(2);
		expect(registeredCalls[0]).toMatchObject({
			p_name: "marketing",
			p_kind: "static",
			p_file_count: 1,
			p_oci_image_ref: null,
		});
		expect((registeredCalls[0]?.p_manifest_json as { redirects: unknown[] }).redirects).toEqual([
			{ from: "/old", to: "/", status: 301 },
		]);
		expect(registeredCalls[1]).toMatchObject({
			p_name: "booking",
			p_kind: "server",
			p_file_count: 0,
			p_oci_image_ref: IMAGE_REF,
			p_app_port: 3000,
			p_health_path: "/health",
		});

		const blueGreen = await triggerBlueGreenAppDeploy({
			appHostInternalUrl: "http://127.0.0.1:8096",
			controlToken: "app-token",
			deploymentId: DEPLOYMENT_ID,
			siteId: SITE_ID,
			ociImageRef: IMAGE_REF,
			healthPath: "/health",
			idleTimeoutSec: 600,
			memoryMb: 512,
			vcpuLimit: 1,
			env: { PORT: "3000" },
			fetchImpl: async () => ({ status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:41234" }) }),
		});
		expect(blueGreen).toEqual({ upstreamAddr: "127.0.0.1:41234" });
	});

	it("delivers tmpfs runtime secrets, masks fetched logs, restores tmpfs and emits app_unhealthy on deploy failure, and scrubs build secrets", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "qorpera-webapp-secrets-"));
		const secretsManager = new CompanyMachineSecretsManager({ rootDir, verifyTmpfs: async () => true });
		try {
			const controlCalls: { method: string; args: Record<string, unknown> }[] = [];
			const control = {
				call: vi.fn(async (method: string, args: Record<string, unknown>) => {
					controlCalls.push({ method, args });
					if (method === "qorpera_web_code_deployment_register") {
						return {
							schema: "qorpera.web-code-deployment/v1",
							state: "ready",
							siteId: SITE_ID,
							slug: "booking-app",
							versionId: VERSION_ID,
							deploymentId: DEPLOYMENT_ID,
							versionNumber: 2,
							kind: "server",
						};
					}
					return { schema: "qorpera.app-unhealthy-wakes/v1", state: "emitted", wakes: 1, skipped: 0, wakeIds: [] };
				}),
			};

			const buildSecret = "sk-build-secret-value-123456";
			let observedBuildPath: string | undefined;
			let observedBuildContent = "";
			const brokerFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
				const parsedBody = JSON.parse(String(init?.body ?? "{}")) as { scope: string; targetEnv: string };
				expect(String(input)).toContain(`/v1/app-secrets?company=${COMPANY}`);
				return new Response(
					JSON.stringify({
						schema: "qorpera.app-secrets/v1",
						siteId: SITE_ID,
						slug: "booking-app",
						scope: parsedBody.scope,
						targetEnv: parsedBody.targetEnv,
						secrets:
							parsedBody.scope === "build"
								? { NPM_TOKEN: buildSecret }
								: { OPENAI_API_KEY: "sk-runtime-secret-value-999999" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as unknown as typeof fetch;

			await deployCodeSiteToNativeEdge({
				control,
				owner: "node-1",
				machineIdSha256: MACHINE_SHA,
				target: { companyId: COMPANY, environmentId: ENVIRONMENT, owner: "company", name: "booking" },
				change: 9,
				siteId: SITE_ID,
				spec: parseNativeCodeSiteSpec({
					schema: "qorpera.code-site/v2",
					kind: "server",
					tree: TREE_SHA,
					files: 0,
					bytes: 0,
					folder: ".",
					name: "booking-app",
					title: "Booking App",
					port: 3000,
					healthPath: "/health",
				})!,
				files: [],
				edge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-token",
					secretsManager,
					appSecretsBroker: {
						origin: "https://broker.qorpera.test",
						executorToken: "exec-tok",
						executorOwner: "node-1",
						machineIdSha256: MACHINE_SHA,
						fetchImpl: brokerFetch,
					},
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-token",
					appHostFetchImpl: async (_url, init) => {
						const parsed = JSON.parse(init.body ?? "{}") as { env_path?: string };
						expect(parsed.env_path).toBe(join(rootDir, "booking-app.env"));
						return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:41230" }) };
					},
					buildAppImage: async (input) => {
						observedBuildPath = input.buildEnvPath;
						observedBuildContent = await readFile(input.buildEnvPath!, "utf8");
						return { ociImageRef: IMAGE_REF, builtMs: 12 };
					},
				},
				signal: new AbortController().signal,
			});
			expect(observedBuildPath).toBeTruthy();
			expect(observedBuildContent).toContain(buildSecret);
			expect(existsSync(observedBuildPath!)).toBe(false);
			expect(await readFile(join(rootDir, "booking-app.env"), "utf8")).toContain("sk-runtime-secret-value-999999");

			const previousSecret = "sk-old-runtime-secret-111111";
			const oldDelivered = await secretsManager.deliver({
				siteId: SITE_ID,
				slug: "booking-app",
				scope: "runtime",
				targetEnv: "prod",
				secrets: { OPENAI_API_KEY: previousSecret },
			});
			const runtimeSecret = "sk-runtime-secret-value-999999";
			let sentBody = "";
			const okDeploy = await triggerBlueGreenAppDeploy({
				appHostInternalUrl: "http://127.0.0.1:8096",
				controlToken: "app-token",
				deploymentId: DEPLOYMENT_ID,
				siteId: SITE_ID,
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				control,
				ociImageRef: IMAGE_REF,
				healthPath: "/health",
				idleTimeoutSec: 600,
				memoryMb: 512,
				vcpuLimit: 1,
				env: { PORT: "3000" },
				secretsManager,
				appSecretsBroker: {
					origin: "https://broker.qorpera.test",
					executorToken: "exec-tok",
					executorOwner: "node-1",
					machineIdSha256: MACHINE_SHA,
					fetchImpl: brokerFetch,
				},
				fetchImpl: async (_url, init) => {
					sentBody = init.body ?? "";
					return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:41234" }) };
				},
			});
			expect(okDeploy.envPath).toBe(oldDelivered.envPath);
			expect(sentBody).not.toContain(runtimeSecret);
			expect(JSON.parse(sentBody).env_path).toBe(oldDelivered.envPath);

			const logs = await fetchAppLogs({
				appHostInternalUrl: "http://127.0.0.1:8096",
				controlToken: "app-token",
				deploymentId: DEPLOYMENT_ID,
				secretsManager,
				slug: "booking-app",
				fetchImpl: async () => ({
					status: 200,
					body: JSON.stringify({
						entries: [{ ts_ms: 1, stream: "stdout", line: `using key ${runtimeSecret}` }],
					}),
				}),
			});
			expect(logs[0]?.line).not.toContain(runtimeSecret);

			await expect(
				triggerBlueGreenAppDeploy({
					appHostInternalUrl: "http://127.0.0.1:8096",
					controlToken: "app-token",
					deploymentId: DEPLOYMENT_ID,
					siteId: SITE_ID,
					environmentId: ENVIRONMENT,
					control,
					ociImageRef: IMAGE_REF,
					healthPath: "/health",
					idleTimeoutSec: 600,
					memoryMb: 512,
					vcpuLimit: 1,
					env: { PORT: "3000" },
					secretsManager,
					appSecrets: {
						siteId: SITE_ID,
						slug: "booking-app",
						scope: "runtime",
						targetEnv: "prod",
						secrets: { OPENAI_API_KEY: "sk-new-failing-secret-777777" },
					},
					fetchImpl: async () => ({ status: 503, body: "unhealthy" }),
				}),
			).rejects.toThrow("APP_HOST_DEPLOY_FAILED_503");

			expect(await readFile(oldDelivered.envPath, "utf8")).toContain(runtimeSecret);
			expect(controlCalls).toContainEqual({
				method: "qorpera_emit_app_unhealthy_routine_wakes",
				args: {
					p_environment_id: ENVIRONMENT,
					p_site_id: SITE_ID,
					p_event: {
						status: "deploy_failed",
						restartCount: 0,
						error: "APP_HOST_DEPLOY_FAILED_503",
					},
				},
			});
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});
});

const hasRustBinaries = existsSync(ROUTER_BIN) && existsSync(APP_HOST_BIN);

describe.skipIf(!hasRustBinaries)("cross-process E2E: live qorpera-web-router + qorpera-app-host + UDP DNS", () => {
	const children: ReturnType<typeof spawn>[] = [];
	const tempDirs: string[] = [];

	afterAll(async () => {
		for (const child of children) {
			child.kill("SIGTERM");
		}
		for (const dir of tempDirs) {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	it("deploys static website and dynamic webapp to qorpera.site then transitions to verified custom domain", async () => {
		const blobDir = await mkdtemp(join(tmpdir(), "qorpera-e2e-blobs-"));
		tempDirs.push(blobDir);

		const routerPubPort = await freePort();
		const routerIntPort = await freePort();
		const appHostPort = await freePort();

		const dnsSocket = createSocket("udp4");
		const dnsPort = await new Promise<number>((resolvePort) => {
			dnsSocket.bind(0, "127.0.0.1", () => resolvePort(dnsSocket.address().port));
		});
		let dnsConfigured = false;
		dnsSocket.on("message", (msg, rinfo) => {
			if (msg.length < 12) return;
			let offset = 12;
			const labels: string[] = [];
			while (offset < msg.length && msg[offset] !== 0) {
				const len = msg[offset] as number;
				offset += 1;
				labels.push(msg.subarray(offset, offset + len).toString("utf8"));
				offset += len;
			}
			const qname = labels.join(".");
			const afterName = offset + 1;
			const qtype = msg.readUInt16BE(afterName);
			let rdata: { type: number; data: Buffer } | null = null;
			if (dnsConfigured && qname === "minbutik.dk" && qtype === 1) {
				rdata = { type: 1, data: Buffer.from([93, 164, 62, 162]) };
			} else if (dnsConfigured && qname === "_qorpera.minbutik.dk" && qtype === 16) {
				const txt = Buffer.from("qorpera-verify=e2etoken1234", "utf8");
				rdata = { type: 16, data: Buffer.concat([Buffer.from([txt.length]), txt]) };
			}
			const header = Buffer.alloc(12);
			msg.copy(header, 0, 0, 2);
			header.writeUInt16BE(0x8180, 2);
			header.writeUInt16BE(1, 4);
			header.writeUInt16BE(rdata ? 1 : 0, 6);
			const question = msg.subarray(12, afterName + 4);
			const parts: Uint8Array[] = [header, question];
			if (rdata) {
				const rr = Buffer.alloc(12);
				rr[0] = 0xc0;
				rr[1] = 0x0c;
				rr.writeUInt16BE(rdata.type, 2);
				rr.writeUInt16BE(1, 4);
				rr.writeUInt32BE(60, 6);
				rr.writeUInt16BE(rdata.data.length, 10);
				parts.push(rr, rdata.data);
			}
			dnsSocket.send(Buffer.concat(parts), rinfo.port, rinfo.address);
		});

		const token = "e2e-shared-control-token";
		const appHost = spawn(APP_HOST_BIN, [], {
			env: {
				PATH: process.env.PATH ?? "",
				QORPERA_APP_HOST_BIND: `127.0.0.1:${appHostPort}`,
				QORPERA_APP_HOST_CONTROL_TOKEN: token,
				QORPERA_APP_HOST_DRIVER: "local",
			},
			stdio: "ignore",
		});
		children.push(appHost);

		const router = spawn(ROUTER_BIN, [], {
			env: {
				PATH: process.env.PATH ?? "",
				QORPERA_WEB_ROUTER_PUBLIC_BIND: `127.0.0.1:${routerPubPort}`,
				QORPERA_WEB_ROUTER_INTERNAL_BIND: `127.0.0.1:${routerIntPort}`,
				QORPERA_WEB_ROUTER_BLOB_ROOT: blobDir,
				QORPERA_WEB_ROUTER_CONTROL_TOKEN: token,
				QORPERA_WEB_ROUTER_COOKIE_SECRET: "e2e-cookie-signing-secret-32-bytes!",
				QORPERA_WEB_APP_HOST_URL: `http://127.0.0.1:${appHostPort}`,
				QORPERA_WEB_DNS_SERVERS: `127.0.0.1:${dnsPort}`,
			},
			stdio: "ignore",
		});
		children.push(router);

		const routerIntUrl = `http://127.0.0.1:${routerIntPort}`;
		const routerPubUrl = `http://127.0.0.1:${routerPubPort}`;
		const appHostUrl = `http://127.0.0.1:${appHostPort}`;

		try {
			await waitForHealth(`${routerIntUrl}/_internal/health`);
			await waitForHealth(`${appHostUrl}/_internal/health`);

			const files = [
				makeFile("index.html", "<html><body><h1>Nordic Shop Static</h1></body></html>"),
				makeFile("_redirects", "/old-home / 301\n"),
				makeFile("_headers", "/*\n  X-Powered-By: qorpera-native\n"),
			];
			const uploaded = await uploadSiteBlobsToEdge({
				routerInternalUrl: routerIntUrl,
				controlToken: token,
				files,
			});
			expect(uploaded.uploadedBlobs).toBe(1);

			const nodeScript =
				"const http=require('http');const port=Number(process.env.PORT);console.log('webapp-started');http.createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200);res.end('ok');return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({host:req.headers['x-forwarded-host'],path:req.url}));}).listen(port,'127.0.0.1');";
			const deployRes = await fetch(`${appHostUrl}/_internal/apps/deploy`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({
					deployment_id: "dep-hybrid-e2e",
					site_id: "site-e2e",
					command: ["node", "-e", nodeScript],
					health_path: "/health",
					idle_timeout_sec: 300,
					env: { APP_MODE: "prod" },
				}),
			});
			expect(deployRes.status).toBe(200);
			const deployed = (await deployRes.json()) as { upstream_addr: string };

			let sawStartLog = false;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const logs = await fetchAppLogs({
					appHostInternalUrl: appHostUrl,
					controlToken: token,
					deploymentId: "dep-hybrid-e2e",
				});
				if (logs.some((e) => e.line.includes("webapp-started"))) {
					sawStartLog = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(sawStartLog).toBe(true);

			const snapshot = {
				hosts_domain: "qorpera.site",
				legacy_hosts_domains: ["qorpera.com"],
				hosts_enabled: true,
				public_enabled: true,
				domains_enabled: true,
				edge_ipv4: "93.164.62.162",
				edge_ipv6: null,
				edge_cname_target: "sites.qorpera.site",
				sites: [
					{
						id: "site-e2e",
						slug: "nordic-shop",
						is_public: true,
						taken_down: false,
						password_sha256: null,
						password_version: 1,
						primary_custom_domain: "minbutik.dk",
						live_deployment: {
							id: "dep-hybrid-e2e",
							kind: "hybrid",
							manifest: uploaded.manifest,
							upstream_addr: deployed.upstream_addr,
							oci_image_ref: null,
							health_path: "/health",
							idle_timeout_sec: 300,
						},
						preview_deployments: {},
					},
				],
				custom_domains: [
					{
						id: "dom-e2e",
						site_id: "site-e2e",
						hostname: "minbutik.dk",
						is_apex: true,
						is_primary: true,
						status: "pending_dns",
						verification_token: "e2etoken1234",
					},
				],
			};

			const snapRes = await fetch(`${routerIntUrl}/_internal/routes/snapshot`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(snapshot),
			});
			expect(snapRes.status).toBe(200);

			const staticBeforeDomain = await fetch(`${routerPubUrl}/`, {
				headers: { "x-forwarded-host": "nordic-shop.qorpera.site" },
			});
			expect(staticBeforeDomain.status).toBe(200);
			expect(await staticBeforeDomain.text()).toContain("Nordic Shop Static");
			expect(staticBeforeDomain.headers.get("x-powered-by")).toBe("qorpera-native");

			const apiBeforeDomain = await fetch(`${routerPubUrl}/api/orders`, {
				headers: { "x-forwarded-host": "nordic-shop.qorpera.site" },
			});
			expect(apiBeforeDomain.status).toBe(200);
			expect(await apiBeforeDomain.json()).toEqual({
				host: "nordic-shop.qorpera.site",
				path: "/api/orders",
			});

			expect((await fetch(`${routerIntUrl}/_internal/tls/allow?domain=minbutik.dk`)).status).toBe(403);

			dnsConfigured = true;
			const verifyRes = await fetch(`${routerIntUrl}/_internal/domains/verify`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(verifyRes.status).toBe(200);

			expect((await fetch(`${routerIntUrl}/_internal/tls/allow?domain=minbutik.dk`)).status).toBe(200);

			const redirectRes = await fetch(`${routerPubUrl}/shop?ref=1`, {
				headers: { "x-forwarded-host": "nordic-shop.qorpera.site" },
				redirect: "manual",
			});
			expect(redirectRes.status).toBe(308);
			expect(redirectRes.headers.get("location")).toBe("https://minbutik.dk/shop?ref=1");

			const customApiRes = await fetch(`${routerPubUrl}/api/orders`, {
				headers: { "x-forwarded-host": "minbutik.dk" },
			});
			expect(customApiRes.status).toBe(200);
			expect(await customApiRes.json()).toEqual({
				host: "minbutik.dk",
				path: "/api/orders",
			});

			await fetch(`${appHostUrl}/_internal/apps/dep-hybrid-e2e/stop`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			});
		} finally {
			dnsSocket.close();
		}
	});
});
