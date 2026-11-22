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
		expect(config.injectRuntimeSecrets).toBe(true);
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
			const config = parseAppDeployConfig({
				autoRedeploy: true,
				site: "billing-app",
				paths: ["apps/billing/**"],
				buildCommand: "npm run build",
				reloadCommand: "reload-app",
				healthUrl: "http://127.0.0.1:3000/health",
				healthAttempts: 2,
				healthIntervalMs: 0,
			});
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
			const config = parseAppDeployConfig({
				autoRedeploy: true,
				site: "billing-app",
				paths: ["apps/billing/**"],
				buildCommand: "npm run build",
				reloadCommand: "reload-app",
				rollbackCommand: "rollback-app",
				healthUrl: "http://127.0.0.1:3000/health",
				healthAttempts: 2,
				healthIntervalMs: 0,
			});
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

	it("wires createNativeEdgeAutoRedeploy from .qorpera/deploy.json through build, broker secrets, blue-green reload, and rollback", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-native-auto-redeploy-"));
		const secretsManager = new CompanyMachineSecretsManager({ rootDir: root, verifyTmpfs: async () => true });
		const companyId = randomUUID();
		const environmentId = randomUUID();
		const siteId = randomUUID();
		const oldDepId = randomUUID();
		const newDepId = randomUUID();
		const machineSha = "f".repeat(64);
		const oldImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"a".repeat(64)}`;
		const newImage = `127.0.0.1:5000/qorpera-apps/billing@sha256:${"b".repeat(64)}`;
		try {
			const controlCalls: { method: string; args: Record<string, unknown> }[] = [];
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
							currentDeploymentId: oldDepId,
							currentImageRef: oldImage,
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
					throw new Error(`unexpected rpc ${method}`);
				}),
			};
			const appHostBodies: Record<string, unknown>[] = [];
			const brokerCalls: Record<string, unknown>[] = [];
			const buildCalls: { buildEnvPath?: string }[] = [];
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
					secretsManager,
					appSecretsBroker: {
						origin: "https://broker.qorpera.test",
						executorToken: "exec-tok",
						executorOwner: "node-1",
						machineIdSha256: machineSha,
						fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
							const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
							brokerCalls.push(body);
							return new Response(
								JSON.stringify({
									schema: "qorpera.app-secrets/v1",
									siteId,
									slug: "billing-app",
									scope: body.scope,
									targetEnv: body.targetEnv,
									secrets:
										body.scope === "build"
											? { NPM_TOKEN: "npm-build-secret-123456" }
											: { OPENAI_API_KEY: "sk-runtime-secret-123456" },
								}),
								{ status: 200, headers: { "content-type": "application/json" } },
							);
						}) as unknown as typeof fetch,
					},
					buildAppImage: async (input) => {
						buildCalls.push({ buildEnvPath: input.buildEnvPath });
						expect(input.buildEnvPath).toBeTruthy();
						expect(await readFile(input.buildEnvPath!, "utf8")).toContain("npm-build-secret-123456");
						return { ociImageRef: newImage, builtMs: 15 };
					},
					appHostFetchImpl: async (_url, init) => {
						appHostBodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
						return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:44444" }) };
					},
				},
				owner: "node-1",
				machineIdSha256: machineSha,
				readDeployConfig: async () => ({
					rawConfig: JSON.stringify({
						autoRedeploy: true,
						site: "billing-app",
						paths: ["src/**"],
						buildCommand: "npm run build",
						reloadCommand: "reload",
						healthUrl: "http://127.0.0.1:3000/health",
						healthAttempts: 1,
						healthIntervalMs: 0,
					}),
					paths: ["src/server.ts"],
				}),
				exportSource: async () => ({ sourceDir: root }),
			});

			const ctx = await autoRedeploy(
				{
					profileId: companyId,
					environmentId,
					repository: { host: "qorpera", owner: "acme", name: "billing", baseBranch: "main" },
				} as never,
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
				secretsManager: ctx!.secretsManager,
				hooks: {
					...ctx!.hooks,
					probeHealth: async () => ({ ok: false, status: 503, error: "smoke failed" }),
				},
				signal: new AbortController().signal,
			});
			expect(result.status).toBe("rolled_back");
			expect(buildCalls).toHaveLength(1);
			expect(brokerCalls.map((c) => c.scope)).toEqual(["build", "runtime"]);
			expect(brokerCalls[1]?.deploymentId).toBe(newDepId);
			expect(appHostBodies.map((b) => [b.deployment_id, b.oci_image_ref, b.env_path])).toEqual([
				[newDepId, newImage, join(root, "billing-app.env")],
				[oldDepId, oldImage, undefined],
			]);
			expect(controlCalls.map((c) => c.method)).toEqual([
				"qorpera_code_site_for_auto_redeploy",
				"qorpera_web_code_deployment_register",
			]);
		} finally {
			await secretsManager.scrubAll();
			await rm(root, { recursive: true, force: true });
		}
	});
});
