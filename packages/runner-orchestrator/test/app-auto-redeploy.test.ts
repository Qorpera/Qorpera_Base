import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
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
		).toThrow(/localhost/);
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

	it("deploys on matching landed changes with tmpfs runtime secrets and health check", async () => {
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
					loadRuntimeSecrets: async () => ({
						siteId: randomUUID(),
						slug: "billing-app",
						scope: "runtime",
						targetEnv: "prod",
						secrets: { OPENAI_API_KEY: "sk-proj-secret-redeploy-12345" },
					}),
					build: async ({ envPath }) => {
						expect(envPath).toBe(join(root, "billing-app.env"));
						return { releaseId: "rel-2" };
					},
					reload,
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
			expect(reload).toHaveBeenCalledTimes(1);
			expect(rollback).not.toHaveBeenCalled();
		} finally {
			await secretsManager.scrubAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("automatically rolls back and emits masked app_unhealthy alert when smoke health check fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-rollback-"));
		const secretsManager = new CompanyMachineSecretsManager({ rootDir: root, verifyTmpfs: async () => true });
		const secretValue = "sk-proj-never-leak-in-alert-999";
		try {
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
						siteId: randomUUID(),
						slug: "billing-app",
						scope: "runtime",
						targetEnv: "prod",
						secrets: { OPENAI_API_KEY: secretValue },
					}),
					build: async () => ({ releaseId: "rel-3" }),
					reload: async () => undefined,
					rollback,
					probeHealth: async () => ({ ok: false, status: 500, error: `Crash using ${secretValue}` }),
					emitAppUnhealthy,
				},
			});
			expect(result.status).toBe("rolled_back");
			if (result.status === "rolled_back") {
				expect(result.restoredReleaseId).toBe("rel-1");
				expect(result.failedReleaseId).toBe("rel-3");
				expect(result.error).not.toContain(secretValue);
				expect(result.error).toContain("***");
			}
			expect(rollback).toHaveBeenCalledWith(
				{
					site: "billing-app",
					previousReleaseId: "rel-1",
					failedReleaseId: "rel-3",
					command: "rollback-app",
				},
				expect.any(AbortSignal),
			);
			expect(emitAppUnhealthy).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(emitAppUnhealthy.mock.calls[0])).not.toContain(secretValue);
		} finally {
			await secretsManager.scrubAll();
			await rm(root, { recursive: true, force: true });
		}
	});
});
