import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createNativeEdgeAutoRedeploy,
	globMatchesPath,
	parseAppDeployConfig,
	runPostLandAppAutoRedeploy,
	shouldAutoRedeployOnCodeChange,
} from "../src/app-auto-redeploy.ts";
import { CompanyMachineSecretsManager } from "../src/company-machine-secrets.ts";

const SHA_BEFORE = "1".repeat(40);
const SHA_AFTER = "2".repeat(40);

describe("app-auto-redeploy", () => {
	it("parses and validates .qorpera/deploy.json strictly", () => {
		const config = parseAppDeployConfig(
			JSON.stringify({
				autoRedeploy: true,
				site: "billing-app",
				targetEnv: "prod",
				paths: ["apps/billing/**", "packages/shared/*.ts"],
				buildCommand: "npm run build",
				reloadCommand: "systemctl reload billing-app",
				rollbackCommand: "systemctl reload billing-app-prev",
				healthUrl: "http://127.0.0.1:3000/health",
				healthExpectStatus: 200,
				healthTimeoutMs: 3000,
				healthAttempts: 2,
				healthIntervalMs: 0,
			}),
		);
		expect(config.autoRedeploy).toBe(true);
		expect(config.site).toBe("billing-app");
		expect(config.injectRuntimeSecrets).toBe(false);
		expect(config.injectDatabaseUrl).toBe(false);
		expect(() =>
			parseAppDeployConfig({
				site: "billing-app",
				buildCommand: "npm run build",
				reloadCommand: "reload",
				healthUrl: "http://127.0.0.1:3000/health",
				injectRuntimeSecrets: true,
			}),
		).toThrow(/not yet supported/);
		expect(() =>
			parseAppDeployConfig({
				site: "billing-app",
				buildCommand: "npm run build",
				reloadCommand: "reload",
				healthUrl: "http://127.0.0.1:3000/health",
				injectDatabaseUrl: true,
			}),
		).toThrow(/not yet supported/);
		expect(() =>
			parseAppDeployConfig({
				site: "billing-app",
				buildCommand: "npm run build",
				reloadCommand: "reload",
				healthUrl: "http://evil.example.com/health",
			}),
		).toThrow(/https/);
		expect(() =>
			parseAppDeployConfig({
				site: "billing-app",
				buildCommand: "npm run build",
				reloadCommand: "reload",
				healthUrl: "https://169.254.169.254/latest/meta-data",
			}),
		).toThrow(/blocked/);
		expect(() =>
			parseAppDeployConfig({
				site: "BAD_SLUG",
				buildCommand: "npm run build",
				reloadCommand: "reload",
				healthUrl: "https://billing.qorpera.site/health",
			}),
		).toThrow(/slug/);
	});

	it("matches path globs without regex backtracking", () => {
		expect(globMatchesPath("apps/billing/**/*.ts", "apps/billing/src/server.ts")).toBe(true);
		expect(globMatchesPath("apps/billing/**/*.ts", "apps/billing/index.ts")).toBe(true);
		expect(globMatchesPath("apps/billing/*.ts", "apps/billing/src/server.ts")).toBe(false);
		expect(globMatchesPath("docs/README.md", "apps/billing/index.ts")).toBe(false);
	});

	it("isolates build secrets from prod runtime secrets and delivers runtime secrets only after build succeeds", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-redeploy-"));
		const secretsManager = new CompanyMachineSecretsManager({ rootDir: root, verifyTmpfs: async () => true });
		try {
			const config = parseAppDeployConfig(
				{
					autoRedeploy: true,
					site: "billing-app",
					paths: ["apps/billing/**"],
					buildCommand: "npm run build",
					reloadCommand: "reload-app",
					healthUrl: "http://127.0.0.1:3000/health",
					healthAttempts: 2,
					healthIntervalMs: 0,
					injectRuntimeSecrets: true,
				},
				{ allowRuntimeSecretInjection: true },
			);
			await expect(
				runPostLandAppAutoRedeploy({
					config,
					event: {
						kind: "landed",
						repo: "acme/web",
						change: "chg-no-mgr",
						mainBefore: SHA_BEFORE,
						mainAfter: SHA_AFTER,
						paths: ["apps/billing/server.ts"],
					},
					hooks: {
						currentReleaseId: async () => "rel-1",
						build: async () => ({ releaseId: "rel-2" }),
						reload: async () => undefined,
						rollback: async () => undefined,
					},
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("APP_SECRETS_DELIVERY_UNAVAILABLE");
			const skip = shouldAutoRedeployOnCodeChange(config, {
				kind: "landed",
				repo: "acme/web",
				change: "chg-1",
				mainBefore: SHA_BEFORE,
				mainAfter: SHA_AFTER,
				paths: ["docs/readme.md"],
			});
			expect(skip).toEqual({ matched: false, reason: "paths_unmatched" });

			let observedBuildEnvPath: string | null = null;
			const reload = vi.fn().mockResolvedValue(undefined);
			const rollback = vi.fn().mockResolvedValue(undefined);
			const probeHealth = vi
				.fn()
				.mockResolvedValueOnce({ ok: false, status: 503, error: "starting" })
				.mockResolvedValueOnce({ ok: true, status: 200 });
			const result = await runPostLandAppAutoRedeploy({
				config,
				event: {
					kind: "landed",
					repo: "acme/web",
					change: "chg-2",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ["apps/billing/server.ts"],
				},
				secretsManager,
				signal: new AbortController().signal,
				hooks: {
					currentReleaseId: async () => "rel-1",
					loadBuildSecrets: async () => ({
						siteId: randomUUID(),
						slug: "billing-app",
						scope: "build",
						targetEnv: "prod",
						secrets: { NPM_TOKEN: "npm_build_token_12345678" },
					}),
					loadRuntimeSecrets: async () => ({
						siteId: randomUUID(),
						slug: "billing-app",
						scope: "runtime",
						targetEnv: "prod",
						secrets: { OPENAI_API_KEY: "sk-proj-secret-redeploy-12345" },
					}),
					build: async ({ envPath }) => {
						observedBuildEnvPath = envPath;
						expect(envPath).not.toBeNull();
						expect(envPath).not.toBe(join(root, "billing-app.env"));
						const buildContent = await readFile(envPath!, "utf8");
						expect(buildContent).toContain("NPM_TOKEN");
						expect(buildContent).not.toContain("OPENAI_API_KEY");
						await expect(stat(join(root, "billing-app.env"))).rejects.toThrow();
						return { releaseId: "rel-2" };
					},
					reload: async (input, s) => {
						expect(input.envPath).toBe(join(root, "billing-app.env"));
						const runtimeContent = await readFile(input.envPath!, "utf8");
						expect(runtimeContent).toContain("OPENAI_API_KEY");
						await reload(input, s);
					},
					rollback,
					probeHealth,
				},
			});
			expect(result).toEqual({
				status: "deployed",
				site: "billing-app",
				commitSha: SHA_AFTER,
				releaseId: "rel-2",
				healthStatus: 200,
				attempts: 2,
			});
			expect(observedBuildEnvPath).not.toBeNull();
			await expect(stat(observedBuildEnvPath!)).rejects.toThrow();
			expect(reload).toHaveBeenCalledTimes(1);
			expect(rollback).not.toHaveBeenCalled();
		} finally {
			await secretsManager.scrubAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("restores previous runtime env file on rollback and masks rollback failures too", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-rollback-"));
		const secretsManager = new CompanyMachineSecretsManager({ rootDir: root, verifyTmpfs: async () => true });
		const prevSecret = "sk-proj-previous-release-key-111";
		const newSecret = "sk-proj-never-leak-in-alert-999";
		const siteId = randomUUID();
		try {
			await secretsManager.deliver({
				siteId,
				slug: "billing-app",
				scope: "runtime",
				targetEnv: "prod",
				secrets: { OPENAI_API_KEY: prevSecret },
			});
			const config = parseAppDeployConfig(
				{
					autoRedeploy: true,
					site: "billing-app",
					paths: ["apps/billing/**"],
					buildCommand: "npm run build",
					reloadCommand: "reload-app",
					rollbackCommand: "rollback-app",
					healthUrl: "http://127.0.0.1:3000/health",
					healthAttempts: 2,
					healthIntervalMs: 0,
					injectRuntimeSecrets: true,
				},
				{ allowRuntimeSecretInjection: true },
			);
			const rollback = vi.fn().mockResolvedValue(undefined);
			const emitAppUnhealthy = vi.fn().mockResolvedValue(undefined);
			const result = await runPostLandAppAutoRedeploy({
				config,
				event: {
					kind: "landed",
					repo: "acme/web",
					change: "chg-3",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ["apps/billing/index.ts"],
				},
				secretsManager,
				signal: new AbortController().signal,
				hooks: {
					currentReleaseId: async () => "rel-1",
					loadRuntimeSecrets: async () => ({
						siteId,
						slug: "billing-app",
						scope: "runtime",
						targetEnv: "prod",
						secrets: { OPENAI_API_KEY: newSecret },
					}),
					build: async () => ({ releaseId: "rel-3" }),
					reload: async () => undefined,
					rollback,
					probeHealth: async () => ({ ok: false, status: 500, error: `Crash using ${newSecret}` }),
					emitAppUnhealthy,
				},
			});
			expect(result.status).toBe("rolled_back");
			if (result.status === "rolled_back") {
				expect(result.restoredReleaseId).toBe("rel-1");
				expect(result.failedReleaseId).toBe("rel-3");
				expect(result.error).not.toContain(newSecret);
				expect(result.error).toContain("***");
			}
			const restoredEnv = await readFile(join(root, "billing-app.env"), "utf8");
			expect(restoredEnv).toContain(prevSecret);
			expect(restoredEnv).not.toContain(newSecret);
			expect(emitAppUnhealthy).toHaveBeenCalledTimes(1);

			const emitRollbackFailed = vi.fn().mockResolvedValue(undefined);
			const failedRollback = await runPostLandAppAutoRedeploy({
				config,
				event: {
					kind: "landed",
					repo: "acme/web",
					change: "chg-4",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ["apps/billing/index.ts"],
				},
				secretsManager,
				signal: new AbortController().signal,
				hooks: {
					currentReleaseId: async () => "rel-1",
					loadRuntimeSecrets: async () => ({
						siteId,
						slug: "billing-app",
						scope: "runtime",
						targetEnv: "prod",
						secrets: { OPENAI_API_KEY: newSecret },
					}),
					build: async () => ({ releaseId: "rel-4" }),
					reload: async () => undefined,
					rollback: async () => {
						throw new Error(`rollback crashed with ${newSecret}`);
					},
					probeHealth: async () => ({ ok: false, status: 500, error: `probe fail ${newSecret}` }),
					emitAppUnhealthy: emitRollbackFailed,
				},
			});
			expect(failedRollback.status).toBe("rollback_failed");
			if (failedRollback.status === "rollback_failed") {
				expect(failedRollback.rollbackError).not.toContain(newSecret);
				expect(failedRollback.rollbackError).toContain("***");
			}
			expect(emitRollbackFailed).toHaveBeenCalledWith(
				expect.objectContaining({
					site: "billing-app",
					status: "rollback_failed",
				}),
				expect.any(AbortSignal),
			);
			const alertArg = emitRollbackFailed.mock.calls[0]?.[0] as { error: string };
			expect(alertArg.error).not.toContain(newSecret);
		} finally {
			await secretsManager.scrubAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("wires createNativeEdgeAutoRedeploy through build, DB live switch, and DB + app-host rollback on smoke failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-native-auto-redeploy-"));
		const companyId = randomUUID();
		const environmentId = randomUUID();
		const siteId = randomUUID();
		const oldDepId = randomUUID();
		const newDepId = randomUUID();
		const machineSha = "f".repeat(64);
		const oldImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"a".repeat(64)}`;
		const newImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"b".repeat(64)}`;
		const rawDeployConfig = JSON.stringify({
			autoRedeploy: true,
			site: "billing-app",
			paths: ["src/**"],
			buildCommand: "npm run build",
			reloadCommand: "reload",
			healthUrl: "http://127.0.0.1:3000/health",
			healthAttempts: 1,
			healthIntervalMs: 0,
		});
		const claim = {
			profileId: companyId,
			environmentId,
			repository: { host: "qorpera", owner: "acme", name: "billing", baseBranch: "main" },
		} as never;
		try {
			const controlCalls: { method: string; args: Record<string, unknown> }[] = [];
			const switchCalls: { deploymentId: string; upstreamAddr: string; mode: string }[] = [];
			let appHostSeq = 0;
			const control = {
				call: vi.fn(async (method: string, args: Record<string, unknown>) => {
					controlCalls.push({ method, args });
					if (method === "qorpera_code_site_for_auto_redeploy") {
						return {
							schema: "qorpera.code-site-auto-redeploy/v1",
							found: true,
							companyId,
							siteId,
							slug: "billing-app",
							kind: "server",
							tree: SHA_AFTER,
							dockerfile: null,
							currentDeploymentId: oldDepId,
							currentImageRef: oldImage,
							existingDeploymentId: null,
							existingImageRef: null,
							appPort: 3000,
							healthPath: "/health",
							idleTimeoutSec: 600,
							memoryMb: 512,
							vcpuLimit: 1,
						};
					}
					if (method === "qorpera_web_code_deployment_register") {
						return {
							schema: "qorpera.web-code-deployment/v1",
							state: "ready",
							siteId,
							slug: "billing-app",
							versionId: randomUUID(),
							deploymentId: newDepId,
							versionNumber: 2,
							kind: "server",
						};
					}
					if (method === "qorpera_code_site_auto_redeploy_switch") {
						switchCalls.push({
							deploymentId: String(args.p_deployment_id),
							upstreamAddr: String(args.p_upstream_addr),
							mode: String(args.p_mode),
						});
						return {
							schema: "qorpera.code-site-auto-redeploy-switch/v1",
							state: "live",
							siteId,
							deploymentId: args.p_deployment_id,
							versionId: randomUUID(),
							upstreamAddr: args.p_upstream_addr,
						};
					}
					throw new Error(`unexpected rpc ${method}`);
				}),
			};
			const appHostBodies: Record<string, unknown>[] = [];
			const buildCalls = vi.fn(async () => ({ ociImageRef: newImage, builtMs: 15 }));
			const registeredKeys: string[] = [];
			const autoRedeploy = createNativeEdgeAutoRedeploy({
				control,
				codeHostJobs: {
					run: async (_c, _e, _s, fn) => await fn({} as never, {} as never),
				},
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-tok",
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-tok",
					buildAppImage: buildCalls,
					appHostFetchImpl: async (_url, init) => {
						appHostSeq += 1;
						appHostBodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
						return {
							status: 200,
							body: JSON.stringify({ upstream_addr: `127.0.0.1:${44440 + appHostSeq}` }),
						};
					},
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({ rawConfig: rawDeployConfig, paths: ["src/server.ts"] }),
				exportSource: async () => ({ sourceDir: root }),
				onRegistered: (k) => registeredKeys.push(k),
			});

			expect(
				await autoRedeploy(
					claim,
					{ state: "fast-forward", mainBefore: SHA_BEFORE, mainSha: SHA_AFTER, filesChanged: 1, change: null },
					new AbortController().signal,
				),
			).toBeNull();

			const ctx = await autoRedeploy(
				claim,
				{ state: "fast-forward", mainBefore: SHA_BEFORE, mainSha: SHA_AFTER, filesChanged: 1, change: 4 },
				new AbortController().signal,
			);
			expect(ctx).not.toBeNull();
			const config = parseAppDeployConfig(ctx!.rawConfig);
			const result = await runPostLandAppAutoRedeploy({
				config,
				event: {
					kind: "landed",
					repo: "acme/billing",
					change: "4",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ctx!.paths ?? [],
				},
				hooks: {
					...ctx!.hooks,
					probeHealth: async () => ({ ok: false, status: 503, error: "smoke failed" }),
				},
				signal: new AbortController().signal,
			});
			expect(result.status).toBe("rolled_back");
			expect(buildCalls).toHaveBeenCalledTimes(1);
			expect(registeredKeys).toEqual([`${environmentId}:acme/billing:4`]);
			expect(appHostBodies.map((b) => [b.deployment_id, b.oci_image_ref])).toEqual([
				[newDepId, newImage],
				[oldDepId, oldImage],
			]);
			expect(switchCalls).toEqual([
				{ deploymentId: newDepId, upstreamAddr: "127.0.0.1:44441", mode: "release" },
				{ deploymentId: oldDepId, upstreamAddr: "127.0.0.1:44442", mode: "back" },
			]);
			expect(controlCalls.map((c) => c.method)).toEqual([
				"qorpera_code_site_for_auto_redeploy",
				"qorpera_code_site_for_auto_redeploy",
				"qorpera_web_code_deployment_register",
				"qorpera_code_site_auto_redeploy_switch",
				"qorpera_code_site_auto_redeploy_switch",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails build cleanly on refused register, refuses static sites, and reuses already-built deployments without duplicate builds", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-native-auto-redeploy-edge-"));
		const companyId = randomUUID();
		const environmentId = randomUUID();
		const siteId = randomUUID();
		const oldDepId = randomUUID();
		const existingDepId = randomUUID();
		const machineSha = "e".repeat(64);
		const oldImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"a".repeat(64)}`;
		const newImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"c".repeat(64)}`;
		const rawDeployConfig = JSON.stringify({
			autoRedeploy: true,
			site: "billing-app",
			paths: ["src/**"],
			buildCommand: "npm run build",
			reloadCommand: "reload",
			healthUrl: "http://127.0.0.1:3000/health",
			healthAttempts: 1,
			healthIntervalMs: 0,
		});
		const claim = {
			profileId: companyId,
			environmentId,
			repository: { host: "qorpera", owner: "acme", name: "billing", baseBranch: "main" },
		} as never;
		const landed = {
			state: "fast-forward" as const,
			mainBefore: SHA_BEFORE,
			mainSha: SHA_AFTER,
			filesChanged: 1,
			change: 7,
		};
		try {
			const staticRedeploy = createNativeEdgeAutoRedeploy({
				control: {
					call: vi.fn(async () => ({
						schema: "qorpera.code-site-auto-redeploy/v1",
						found: true,
						companyId,
						siteId,
						slug: "billing-app",
						kind: "static",
						currentDeploymentId: oldDepId,
						currentImageRef: oldImage,
					})),
				},
				codeHostJobs: { run: async (_c, _e, _s, fn) => await fn({} as never, {} as never) },
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-tok",
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-tok",
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({ rawConfig: rawDeployConfig, paths: ["src/server.ts"] }),
				exportSource: async () => ({ sourceDir: root }),
			});
			expect(await staticRedeploy(claim, landed, new AbortController().signal)).toBeNull();

			const refusedAppHost = vi.fn();
			const refusedRedeploy = createNativeEdgeAutoRedeploy({
				control: {
					call: vi.fn(async (method: string) => {
						if (method === "qorpera_code_site_for_auto_redeploy") {
							return {
								schema: "qorpera.code-site-auto-redeploy/v1",
								found: true,
								companyId,
								siteId,
								slug: "billing-app",
								kind: "server",
								tree: SHA_AFTER,
								currentDeploymentId: oldDepId,
								currentImageRef: oldImage,
								existingDeploymentId: null,
								existingImageRef: null,
								appPort: 3000,
								healthPath: "/health",
								idleTimeoutSec: 600,
								memoryMb: 512,
								vcpuLimit: 1,
							};
						}
						if (method === "qorpera_web_code_deployment_register") {
							return { schema: "qorpera.web-code-deployment/v1", state: "refused", code: "SITE_ROW_GONE" };
						}
						throw new Error(`unexpected rpc ${method}`);
					}),
				},
				codeHostJobs: { run: async (_c, _e, _s, fn) => await fn({} as never, {} as never) },
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-tok",
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-tok",
					buildAppImage: async () => ({ ociImageRef: newImage, builtMs: 5 }),
					appHostFetchImpl: refusedAppHost,
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({ rawConfig: rawDeployConfig, paths: ["src/server.ts"] }),
				exportSource: async () => ({ sourceDir: root }),
			});
			const refusedCtx = await refusedRedeploy(claim, landed, new AbortController().signal);
			expect(refusedCtx).not.toBeNull();
			const refusedRes = await runPostLandAppAutoRedeploy({
				config: parseAppDeployConfig(refusedCtx!.rawConfig),
				event: {
					kind: "landed",
					repo: "acme/billing",
					change: "7",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ["src/server.ts"],
				},
				hooks: refusedCtx!.hooks,
				signal: new AbortController().signal,
			});
			expect(refusedRes).toMatchObject({
				status: "build_failed",
				error: "AUTO_REDEPLOY_REGISTER_FAILED_SITE_ROW_GONE",
			});
			expect(refusedAppHost).not.toHaveBeenCalled();

			const reuseBuildSpy = vi.fn();
			const reuseSwitches: string[] = [];
			const reuseRedeploy = createNativeEdgeAutoRedeploy({
				control: {
					call: vi.fn(async (method: string, args: Record<string, unknown>) => {
						if (method === "qorpera_code_site_for_auto_redeploy") {
							return {
								schema: "qorpera.code-site-auto-redeploy/v1",
								found: true,
								companyId,
								siteId,
								slug: "billing-app",
								kind: "server",
								tree: SHA_AFTER,
								currentDeploymentId: oldDepId,
								currentImageRef: oldImage,
								existingDeploymentId: existingDepId,
								existingImageRef: newImage,
								appPort: 3000,
								healthPath: "/health",
								idleTimeoutSec: 600,
								memoryMb: 512,
								vcpuLimit: 1,
							};
						}
						if (method === "qorpera_code_site_auto_redeploy_switch") {
							reuseSwitches.push(String(args.p_deployment_id));
							return {
								schema: "qorpera.code-site-auto-redeploy-switch/v1",
								state: "live",
								siteId,
								deploymentId: args.p_deployment_id,
								versionId: randomUUID(),
								upstreamAddr: args.p_upstream_addr,
							};
						}
						throw new Error(`unexpected rpc ${method}`);
					}),
				},
				codeHostJobs: { run: async (_c, _e, _s, fn) => await fn({} as never, {} as never) },
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-tok",
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-tok",
					buildAppImage: reuseBuildSpy,
					appHostFetchImpl: async () => ({
						status: 200,
						body: JSON.stringify({ upstream_addr: "127.0.0.1:45555" }),
					}),
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({ rawConfig: rawDeployConfig, paths: ["src/server.ts"] }),
				exportSource: async () => ({ sourceDir: root }),
			});
			const reuseCtx = await reuseRedeploy(claim, landed, new AbortController().signal);
			expect(reuseCtx).not.toBeNull();
			const reuseRes = await runPostLandAppAutoRedeploy({
				config: parseAppDeployConfig(reuseCtx!.rawConfig),
				event: {
					kind: "landed",
					repo: "acme/billing",
					change: "7",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ["src/server.ts"],
				},
				hooks: {
					...reuseCtx!.hooks,
					probeHealth: async () => ({ ok: true, status: 200 }),
				},
				signal: new AbortController().signal,
			});
			expect(reuseRes).toMatchObject({ status: "deployed", releaseId: existingDepId });
			expect(reuseBuildSpy).not.toHaveBeenCalled();
			expect(reuseSwitches).toEqual([existingDepId]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("injects broker secrets and scoped DATABASE_URL on createNativeEdgeAutoRedeploy reload and rollback without tmpfs secretsManager", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-native-redeploy-secrets-"));
		const companyId = randomUUID();
		const environmentId = randomUUID();
		const siteId = randomUUID();
		const oldDepId = randomUUID();
		const newDepId = randomUUID();
		const machineSha = "d".repeat(64);
		const oldImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"a".repeat(64)}`;
		const newImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"b".repeat(64)}`;
		const stripeSecret = "sk-live-redeploy-secret-445566";
		const dbUrl = "postgresql://billing_rw:redeploy-db-pass-332211@10.99.0.10:5432/co_billing?sslmode=require";
		const rawDeployConfig = JSON.stringify({
			autoRedeploy: true,
			site: "billing-app",
			paths: ["src/**"],
			buildCommand: "npm run build",
			reloadCommand: "reload",
			healthUrl: "http://127.0.0.1:3000/health",
			healthAttempts: 1,
			healthIntervalMs: 0,
			injectRuntimeSecrets: true,
			injectDatabaseUrl: true,
		});
		const claim = {
			profileId: companyId,
			environmentId,
			repository: { host: "qorpera", owner: "acme", name: "billing", baseBranch: "main" },
		} as never;
		try {
			const registerEnvSpecs: Array<Record<string, string>> = [];
			const appHostBodies: Array<Record<string, unknown>> = [];
			let appHostSeq = 0;
			const control = {
				call: vi.fn(async (method: string, args: Record<string, unknown>) => {
					if (method === "qorpera_code_site_for_auto_redeploy") {
						return {
							schema: "qorpera.code-site-auto-redeploy/v1",
							found: true,
							companyId,
							siteId,
							slug: "billing-app",
							kind: "server",
							tree: SHA_AFTER,
							dockerfile: null,
							currentDeploymentId: oldDepId,
							currentImageRef: oldImage,
							existingDeploymentId: null,
							existingImageRef: null,
							appPort: 3000,
							healthPath: "/health",
							idleTimeoutSec: 600,
							memoryMb: 512,
							vcpuLimit: 1,
							runtimeEnvConfig: { PUBLIC_BILLING_MODE: "live" },
							linkedDatabaseName: "billing",
							hasRuntimeDevSecrets: false,
							hasRuntimeProdSecrets: true,
						};
					}
					if (method === "qorpera_web_code_deployment_register") {
						registerEnvSpecs.push((args.p_env_spec ?? {}) as Record<string, string>);
						return {
							schema: "qorpera.web-code-deployment/v1",
							state: "ready",
							siteId,
							slug: "billing-app",
							versionId: randomUUID(),
							deploymentId: newDepId,
							versionNumber: 2,
							kind: "server",
						};
					}
					if (method === "qorpera_code_site_auto_redeploy_switch") {
						return {
							schema: "qorpera.code-site-auto-redeploy-switch/v1",
							state: "live",
							siteId,
							deploymentId: args.p_deployment_id,
							versionId: randomUUID(),
							upstreamAddr: args.p_upstream_addr,
						};
					}
					throw new Error(`unexpected rpc ${method}`);
				}),
			};
			const autoRedeploy = createNativeEdgeAutoRedeploy({
				control,
				codeHostJobs: {
					run: async (_c, _e, _s, fn) => await fn({} as never, {} as never),
				},
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-tok",
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-tok",
					companyDataUrl: "http://127.0.0.1:8091",
					companyDataPublicUrl: "https://data.qorpera.com",
					companyDataDirectLoginToken: "direct-tok",
					companyDataFetchImpl: async () => ({
						status: 200,
						body: JSON.stringify({
							connectionString: dbUrl,
							host: "10.99.0.10",
							port: 5432,
							database: "co_billing",
							schema: "public",
							user: "billing_rw",
						}),
					}),
					broker: {
						origin: "https://broker.internal",
						executorToken: "exec-tok",
						executorOwner: "node-1",
						machineIdSha256: machineSha,
						fetchImpl: async () =>
							new Response(
								JSON.stringify({
									schema: "qorpera.app-secrets/v1",
									siteId,
									slug: "billing-app",
									scope: "runtime",
									targetEnv: "prod",
									secrets: { STRIPE_KEY: stripeSecret },
								}),
								{ status: 200, headers: { "content-type": "application/json" } },
							),
					},
					buildAppImage: async () => ({ ociImageRef: newImage, builtMs: 12 }),
					appHostFetchImpl: async (_url, init) => {
						appHostSeq += 1;
						appHostBodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
						return {
							status: 200,
							body: JSON.stringify({ upstream_addr: `127.0.0.1:${46440 + appHostSeq}` }),
						};
					},
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({ rawConfig: rawDeployConfig, paths: ["src/server.ts"] }),
				exportSource: async () => ({ sourceDir: root }),
			});

			const ctx = await autoRedeploy(
				claim,
				{ state: "fast-forward", mainBefore: SHA_BEFORE, mainSha: SHA_AFTER, filesChanged: 1, change: 9 },
				new AbortController().signal,
			);
			expect(ctx).not.toBeNull();
			expect(ctx!.allowRuntimeSecretInjection).toBe(true);
			expect(ctx!.allowDatabaseUrlInjection).toBe(true);
			expect(ctx!.hooks.runtimeEnvManagedByReload).toBe(true);

			const config = parseAppDeployConfig(ctx!.rawConfig, {
				allowRuntimeSecretInjection: ctx!.allowRuntimeSecretInjection === true,
				allowDatabaseUrlInjection: ctx!.allowDatabaseUrlInjection === true,
			});
			const res = await runPostLandAppAutoRedeploy({
				config,
				event: {
					kind: "landed",
					repo: "acme/billing",
					change: "9",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: ctx!.paths ?? [],
				},
				hooks: {
					...ctx!.hooks,
					probeHealth: async () => ({ ok: false, status: 503, error: "smoke failed" }),
				},
				signal: new AbortController().signal,
			});
			expect(res.status).toBe("rolled_back");
			expect(registerEnvSpecs).toHaveLength(1);
			expect(registerEnvSpecs[0]?.PUBLIC_BILLING_MODE).toBe("live");
			expect(registerEnvSpecs[0]?.STRIPE_KEY).toBeUndefined();
			expect(registerEnvSpecs[0]?.DATABASE_URL).toBeUndefined();

			expect(appHostBodies).toHaveLength(2);
			for (const body of appHostBodies) {
				expect(body.env).toMatchObject({
					PUBLIC_BILLING_MODE: "live",
					QORPERA_COMPANY_DATA_PUBLIC_URL: "https://data.qorpera.com",
					STRIPE_KEY: stripeSecret,
					DATABASE_URL: dbUrl,
				});
			}

			expect(() =>
				parseAppDeployConfig(
					{
						site: "billing-app",
						buildCommand: "npm run build",
						reloadCommand: "reload",
						healthUrl: "http://127.0.0.1:3000/health",
						injectRuntimeSecrets: true,
					},
					{ allowRuntimeSecretInjection: false, allowDatabaseUrlInjection: true },
				),
			).toThrow(/runtime secret injection/);
			expect(() =>
				parseAppDeployConfig(
					{
						site: "billing-app",
						buildCommand: "npm run build",
						reloadCommand: "reload",
						healthUrl: "http://127.0.0.1:3000/health",
						injectDatabaseUrl: true,
					},
					{ allowRuntimeSecretInjection: true, allowDatabaseUrlInjection: false },
				),
			).toThrow(/database URL injection/);

			const implicitDeployConfig = JSON.stringify({
				autoRedeploy: true,
				site: "billing-app",
				paths: ["src/**"],
				buildCommand: "npm run build",
				reloadCommand: "reload",
				healthUrl: "http://127.0.0.1:3000/health",
				healthAttempts: 1,
				healthIntervalMs: 0,
			});
			appHostBodies.length = 0;
			const implicitAutoRedeploy = createNativeEdgeAutoRedeploy({
				control,
				codeHostJobs: {
					run: async (_c, _e, _s, fn) => await fn({} as never, {} as never),
				},
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8094",
					controlToken: "edge-tok",
					appHostInternalUrl: "http://127.0.0.1:8096",
					appHostControlToken: "app-tok",
					companyDataUrl: "http://127.0.0.1:8091",
					companyDataPublicUrl: "https://data.qorpera.com",
					companyDataDirectLoginToken: "direct-tok",
					companyDataFetchImpl: async () => ({
						status: 200,
						body: JSON.stringify({
							connectionString: dbUrl,
							host: "10.99.0.10",
							port: 5432,
							database: "co_billing",
							schema: "public",
							user: "billing_rw",
						}),
					}),
					broker: {
						origin: "https://broker.internal",
						executorToken: "exec-tok",
						executorOwner: "node-1",
						machineIdSha256: machineSha,
						fetchImpl: async () =>
							new Response(
								JSON.stringify({
									schema: "qorpera.app-secrets/v1",
									siteId,
									slug: "billing-app",
									scope: "runtime",
									targetEnv: "prod",
									secrets: { STRIPE_KEY: stripeSecret },
								}),
								{ status: 200, headers: { "content-type": "application/json" } },
							),
					},
					buildAppImage: async () => ({ ociImageRef: newImage, builtMs: 12 }),
					appHostFetchImpl: async (_url, init) => {
						appHostSeq += 1;
						appHostBodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
						return {
							status: 200,
							body: JSON.stringify({ upstream_addr: `127.0.0.1:${46540 + appHostSeq}` }),
						};
					},
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({ rawConfig: implicitDeployConfig, paths: ["src/server.ts"] }),
				exportSource: async () => ({ sourceDir: root }),
			});
			const implicitCtx = await implicitAutoRedeploy(
				claim,
				{ state: "fast-forward", mainBefore: SHA_BEFORE, mainSha: SHA_AFTER, filesChanged: 1, change: 10 },
				new AbortController().signal,
			);
			expect(implicitCtx).not.toBeNull();
			const implicitRes = await runPostLandAppAutoRedeploy({
				config: parseAppDeployConfig(implicitCtx!.rawConfig),
				event: {
					kind: "landed",
					repo: "acme/billing",
					change: "10",
					mainBefore: SHA_BEFORE,
					mainAfter: SHA_AFTER,
					paths: implicitCtx!.paths ?? [],
				},
				hooks: {
					...implicitCtx!.hooks,
					probeHealth: async () => ({ ok: true, status: 200 }),
				},
				signal: new AbortController().signal,
			});
			expect(implicitRes.status).toBe("deployed");
			expect(appHostBodies[0]?.env).toMatchObject({
				PUBLIC_BILLING_MODE: "live",
				STRIPE_KEY: stripeSecret,
				DATABASE_URL: dbUrl,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
