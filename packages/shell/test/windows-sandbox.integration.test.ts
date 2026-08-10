import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelIntentCapability, KernelModelIntentBudget } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	provisionWindowsSandbox,
	sandboxCommandArgs,
	sandboxRuntimeDir,
	writeSandboxProfile,
} from "../src/agent-runtime.ts";
import { type ModelRequestRuntime, startModelRequestBroker } from "../src/model-request-broker.ts";

vi.mock("@qorpera/pi-coding-agent", () => ({
	ModelRuntime: {
		create: vi.fn(async () => {
			throw new Error("Windows integration must supply its explicit broker runtime");
		}),
	},
}));

const RUN_WINDOWS_INTEGRATION = process.platform === "win32" && process.env.QORPERA_WINDOWS_SANDBOX_INTEGRATION === "1";
const CODEX_ENTRY = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
let integrationRoot: string | undefined;
let integrationRuntimeRoot: string | undefined;

function cleanEnvironment(configDir: string, runtimeDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"LOCALAPPDATA",
		"PROGRAMDATA",
		"ProgramFiles",
		"ProgramFiles(x86)",
		"USERNAME",
		"USERDOMAIN",
	]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	env.CODEX_HOME = configDir;
	env.HOME = runtimeDir;
	env.USERPROFILE = runtimeDir;
	env.APPDATA = runtimeDir;
	env.TEMP = runtimeDir;
	env.TMP = runtimeDir;
	return env;
}

afterEach(() => {
	if (integrationRoot && existsSync(integrationRoot)) rmSync(integrationRoot, { recursive: true, force: true });
	if (integrationRuntimeRoot && existsSync(integrationRuntimeRoot)) {
		rmSync(integrationRuntimeRoot, { recursive: true, force: true });
	}
	integrationRoot = undefined;
	integrationRuntimeRoot = undefined;
});

function modelIntent(nonce: string, budget: KernelModelIntentBudget, lifetimeMs = 30_000): KernelIntentCapability {
	const issuedAt = Date.now();
	return {
		nonce,
		sessionId: "windows-integration-session",
		requestHash: "a".repeat(64),
		attended: true,
		issuedAt: new Date(issuedAt).toISOString(),
		expiresAt: new Date(issuedAt + lifetimeMs).toISOString(),
		budget,
		signature: "windows-kernel-signature",
	};
}

function modelRequest(handle: string, intent: KernelIntentCapability, requestId: string, systemPrompt: string): object {
	return {
		type: "qorpera_model_request",
		requestId,
		handle,
		intent,
		model: { provider: "openai", id: "gpt-5.5" },
		context: { systemPrompt, messages: [] },
		options: { transport: "sse", maxTokens: 100 },
	};
}

describe.skipIf(!RUN_WINDOWS_INTEGRATION)("bundled Codex Windows sandbox integration", () => {
	it(
		"provisions a clean profile and enforces filesystem and network authority",
		async () => {
			const parent = process.env.LOCALAPPDATA ?? tmpdir();
			integrationRoot = join(parent, "QorperaSandboxIntegration", `run-${randomUUID()}`);
			const configDir = join(integrationRoot, "codex-home");
			const companyRoot = join(integrationRoot, "company");
			const runtimeDir = sandboxRuntimeDir(integrationRoot, companyRoot, "product-worker", randomUUID());
			integrationRuntimeRoot = dirname(dirname(runtimeDir));
			const repositoryPath = join("departments", "widget-development", "repository");
			const worktreesPath = join("departments", "widget-development", "worktrees");
			const worktreePath = join(worktreesPath, "task-reviewed");
			const worktreeRoot = join(companyRoot, worktreePath);
			const siblingWorktreeRoot = join(companyRoot, worktreesPath, "task-sibling");
			const outsideRoot = join(integrationRoot, "outside");
			for (const directory of [
				configDir,
				runtimeDir,
				worktreeRoot,
				join(worktreeRoot, ".git"),
				siblingWorktreeRoot,
				join(companyRoot, repositoryPath),
				join(companyRoot, "app"),
				outsideRoot,
			]) {
				mkdirSync(directory, { recursive: true });
			}
			const env = cleanEnvironment(configDir, runtimeDir);
			writeSandboxProfile(
				configDir,
				runtimeDir,
				companyRoot,
				{
					actor: "product-worker",
					attended: false,
					department: join("departments", "widget-development"),
					worktree: worktreePath,
				},
				[join(companyRoot, repositoryPath), join(companyRoot, worktreesPath)],
				[dirname(process.execPath), resolve(CODEX_ENTRY, "..", "..", "..")],
			);
			expect(existsSync(join(configDir, ".sandbox", "setup_marker.json"))).toBe(false);
			expect(existsSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"))).toBe(false);

			provisionWindowsSandbox({
				codexEntry: CODEX_ENTRY,
				configDir,
				runtimeDir,
				nodeExecutable: process.execPath,
				env,
			});
			// The supported Codex setup path owns and validates these records.
			expect(existsSync(join(configDir, ".sandbox", "setup_marker.json"))).toBe(true);
			expect(existsSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"))).toBe(true);
			// Provisioning is idempotent and refreshes the Codex-owned ACL state.
			provisionWindowsSandbox({
				codexEntry: CODEX_ENTRY,
				configDir,
				runtimeDir,
				nodeExecutable: process.execPath,
				env,
			});
			const identityProbe = join(runtimeDir, "identity-probe.mjs");
			writeFileSync(
				identityProbe,
				'import { userInfo } from "node:os"; console.log(userInfo().username);\n',
				"utf-8",
			);
			const identity = spawnSync(
				process.execPath,
				sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, [identityProbe]),
				{ cwd: runtimeDir, env, encoding: "utf-8", timeout: 120_000 },
			);
			expect(identity.status, identity.stderr).toBe(0);
			expect(identity.stdout.trim().toLowerCase()).toContain("codexsandboxoffline");

			const writeProbeSource = [
				'import { writeFileSync } from "node:fs";',
				"const [target, expected] = process.argv.slice(2);",
				"try {",
				'  writeFileSync(target, "sandbox write\\n", "utf-8");',
				'  process.exit(expected === "allow" ? 0 : 42);',
				"} catch {",
				'  process.exit(expected === "deny" ? 0 : 43);',
				"}",
			].join("\n");
			const writeProbe = join(runtimeDir, "write-probe.mjs");
			writeFileSync(writeProbe, writeProbeSource, "utf-8");
			const runProbe = (target: string, expected: "allow" | "deny") =>
				spawnSync(
					process.execPath,
					sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, [writeProbe, target, expected]),
					{ cwd: runtimeDir, env, encoding: "utf-8", timeout: 120_000 },
				);

			const assignedTarget = join(worktreeRoot, "authorized.txt");
			const allowed = runProbe(assignedTarget, "allow");
			expect({ status: allowed.status, stderr: allowed.stderr }).toMatchObject({ status: 0 });
			expect(existsSync(assignedTarget)).toBe(true);

			for (const deniedTarget of [
				join(companyRoot, repositoryPath, "blocked-product-repository.txt"),
				join(siblingWorktreeRoot, "blocked-sibling.txt"),
				join(companyRoot, "blocked-company.txt"),
				join(worktreeRoot, ".git", "blocked-hook"),
				join(outsideRoot, "blocked.txt"),
			]) {
				const denied = runProbe(deniedTarget, "deny");
				expect({ target: deniedTarget, status: denied.status, stderr: denied.stderr }).toMatchObject({ status: 0 });
				expect(existsSync(deniedTarget)).toBe(false);
			}

			const networkProbe = join(runtimeDir, "network-probe.mjs");
			writeFileSync(
				networkProbe,
				[
					"try {",
					"  await fetch(process.argv[2]);",
					"  process.exit(42);",
					"} catch {",
					"  process.exit(0);",
					"}",
				].join("\n"),
				"utf-8",
			);
			const networkTarget = "https://example.com/";
			const hostNetwork = spawnSync(process.execPath, [networkProbe, networkTarget], {
				cwd: runtimeDir,
				env,
				encoding: "utf-8",
				timeout: 120_000,
			});
			expect(hostNetwork.status, "integration host must have direct network access before sandboxing").toBe(42);
			const network = spawnSync(
				process.execPath,
				sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, [networkProbe, networkTarget]),
				{ cwd: runtimeDir, env, encoding: "utf-8", timeout: 120_000 },
			);
			expect({ status: network.status, stderr: network.stderr }).toMatchObject({ status: 0 });

			// Re-provision the same actor profile for a fresh capability. Access
			// granted to the prior assigned clone must not accumulate in the
			// underlying Windows sandbox identity.
			const replacementRuntimeDir = sandboxRuntimeDir(integrationRoot, companyRoot, "product-worker", randomUUID());
			mkdirSync(replacementRuntimeDir, { recursive: true });
			const replacementEnv = cleanEnvironment(configDir, replacementRuntimeDir);
			writeSandboxProfile(
				configDir,
				replacementRuntimeDir,
				companyRoot,
				{
					actor: "product-worker",
					attended: false,
					department: join("departments", "widget-development"),
					worktree: join(worktreesPath, "task-sibling"),
				},
				[join(companyRoot, repositoryPath), join(companyRoot, worktreesPath)],
				[dirname(process.execPath), resolve(CODEX_ENTRY, "..", "..", "..")],
			);
			provisionWindowsSandbox({
				codexEntry: CODEX_ENTRY,
				configDir,
				runtimeDir: replacementRuntimeDir,
				nodeExecutable: process.execPath,
				env: replacementEnv,
			});
			const replacementProbe = join(replacementRuntimeDir, "write-probe.mjs");
			writeFileSync(replacementProbe, writeProbeSource, "utf-8");
			const runReplacementProbe = (target: string, expected: "allow" | "deny") =>
				spawnSync(
					process.execPath,
					sandboxCommandArgs(CODEX_ENTRY, replacementRuntimeDir, process.execPath, [
						replacementProbe,
						target,
						expected,
					]),
					{ cwd: replacementRuntimeDir, env: replacementEnv, encoding: "utf-8", timeout: 120_000 },
				);
			const replacementTarget = join(siblingWorktreeRoot, "replacement-authorized.txt");
			expect(runReplacementProbe(replacementTarget, "allow").status).toBe(0);
			expect(existsSync(replacementTarget)).toBe(true);
			const revokedTarget = join(worktreeRoot, "prior-capability-revoked.txt");
			expect(runReplacementProbe(revokedTarget, "deny").status).toBe(0);
			expect(existsSync(revokedTarget)).toBe(false);

			const controllerConfigDir = join(integrationRoot, "controller-codex-home");
			const controllerRuntimeDir = sandboxRuntimeDir(integrationRoot, companyRoot, "controller", randomUUID());
			mkdirSync(controllerConfigDir, { recursive: true });
			mkdirSync(controllerRuntimeDir, { recursive: true });
			const controllerEnv = cleanEnvironment(controllerConfigDir, controllerRuntimeDir);
			writeSandboxProfile(
				controllerConfigDir,
				controllerRuntimeDir,
				companyRoot,
				{ actor: "controller", attended: false },
				[join(companyRoot, repositoryPath), join(companyRoot, worktreesPath)],
				[dirname(process.execPath), resolve(CODEX_ENTRY, "..", "..", "..")],
			);
			provisionWindowsSandbox({
				codexEntry: CODEX_ENTRY,
				configDir: controllerConfigDir,
				runtimeDir: controllerRuntimeDir,
				nodeExecutable: process.execPath,
				env: controllerEnv,
			});
			const controllerWriteProbe = join(controllerRuntimeDir, "write-probe.mjs");
			writeFileSync(controllerWriteProbe, writeProbeSource, "utf-8");
			const runControllerProbe = (target: string, expected: "allow" | "deny") =>
				spawnSync(
					process.execPath,
					sandboxCommandArgs(CODEX_ENTRY, controllerRuntimeDir, process.execPath, [
						controllerWriteProbe,
						target,
						expected,
					]),
					{ cwd: controllerRuntimeDir, env: controllerEnv, encoding: "utf-8", timeout: 120_000 },
				);
			const controllerTarget = join(companyRoot, "app", "controller-allowed.txt");
			expect(runControllerProbe(controllerTarget, "allow").status).toBe(0);
			expect(existsSync(controllerTarget)).toBe(true);
			for (const deniedTarget of [
				join(companyRoot, repositoryPath, "controller-blocked-repository.txt"),
				join(worktreeRoot, "controller-blocked-worktree.txt"),
				join(worktreeRoot, ".git", "controller-blocked-git"),
			]) {
				expect(runControllerProbe(deniedTarget, "deny").status, deniedTarget).toBe(0);
				expect(existsSync(deniedTarget)).toBe(false);
			}
			const controllerNetworkProbe = join(controllerRuntimeDir, "network-probe.mjs");
			writeFileSync(controllerNetworkProbe, readFileSync(networkProbe, "utf-8"), "utf-8");
			const controllerNetwork = spawnSync(
				process.execPath,
				sandboxCommandArgs(CODEX_ENTRY, controllerRuntimeDir, process.execPath, [
					controllerNetworkProbe,
					networkTarget,
				]),
				{ cwd: controllerRuntimeDir, env: controllerEnv, encoding: "utf-8", timeout: 120_000 },
			);
			expect({ status: controllerNetwork.status, stderr: controllerNetwork.stderr }).toMatchObject({ status: 0 });
		},
		15 * 60 * 1000,
	);

	it("enforces trusted model-intent expiry, replay, abort, and budgets", async () => {
		const model = {
			id: "gpt-5.5",
			name: "Windows broker integration model",
			api: "openai-responses" as const,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"] as const,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
			contextWindow: 100_000,
			maxTokens: 100,
		} satisfies NonNullable<ReturnType<ModelRequestRuntime["getModel"]>>;
		const prompts: string[] = [];
		const outputLimits: number[] = [];
		const streamSimple = ((
			_model: unknown,
			context: { systemPrompt?: string },
			options?: { signal?: AbortSignal; maxTokens?: number },
		) => ({
			async *[Symbol.asyncIterator]() {
				prompts.push(context.systemPrompt ?? "");
				outputLimits.push(options?.maxTokens ?? 0);
				const assistant = (text: string, stopReason: "stop" | "aborted") => ({
					role: "assistant" as const,
					content: text ? [{ type: "text" as const, text }] : [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0.000001, output: 0.000001, cacheRead: 0, cacheWrite: 0, total: 0.000002 },
					},
					stopReason,
					timestamp: Date.now(),
				});
				if (context.systemPrompt === "wait-for-abort") {
					await new Promise<void>((resolvePromise) => {
						const abort = () => resolvePromise();
						if (options?.signal?.aborted) abort();
						else options?.signal?.addEventListener("abort", abort, { once: true });
					});
					const error = assistant("aborted", "aborted");
					yield { type: "error" as const, reason: "aborted" as const, error };
					return;
				}
				const message = assistant("ok", "stop");
				yield { type: "done" as const, reason: "stop" as const, message };
			},
		})) as unknown as ModelRequestRuntime["streamSimple"];
		const runtime: ModelRequestRuntime = {
			getModel: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
			streamSimple,
		};
		const broker = await startModelRequestBroker({
			authPath: "unused-auth.json",
			modelsPath: "unused-models.json",
			allowedProviders: new Set(["openai"]),
			runtime,
		});
		const child = broker.registerChild(
			"windows-integration-session",
			{ openai: { type: "api_key", key: "integration-secret" } },
			[],
		);
		const handle = child.handles.openai;
		const frames: object[] = [];
		const send = (frame: object) => frames.push(frame);
		const expectDenied = async (requestId: string): Promise<void> => {
			await vi.waitFor(() =>
				expect(frames).toContainEqual({
					type: "qorpera_model_end",
					requestId,
					error: "kernel model request denied",
				}),
			);
		};
		const generous: KernelModelIntentBudget = {
			maxCalls: 8,
			maxInputTokens: 100_000,
			maxOutputTokens: 1_000,
			maxCostUsd: 100,
		};
		try {
			const replay = modelIntent("11111111-1111-4111-8111-111111111111", generous);
			expect(child.authorizeIntent(replay)).toBe(true);
			child.handleFrame(
				modelRequest(handle, replay, "21111111-1111-4111-8111-111111111111", "semantic-replay"),
				send,
			);
			await vi.waitFor(() =>
				expect(frames).toContainEqual({
					type: "qorpera_model_end",
					requestId: "21111111-1111-4111-8111-111111111111",
				}),
			);
			child.handleFrame(
				modelRequest(handle, replay, "31111111-1111-4111-8111-111111111111", "semantic-replay"),
				send,
			);
			await expectDenied("31111111-1111-4111-8111-111111111111");

			const expired = modelIntent("41111111-1111-4111-8111-111111111111", generous, 5);
			expect(child.authorizeIntent(expired)).toBe(true);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
			child.handleFrame(modelRequest(handle, expired, "51111111-1111-4111-8111-111111111111", "expired"), send);
			await expectDenied("51111111-1111-4111-8111-111111111111");

			const aborted = modelIntent("61111111-1111-4111-8111-111111111111", generous);
			expect(child.authorizeIntent(aborted)).toBe(true);
			child.handleFrame(
				modelRequest(handle, aborted, "71111111-1111-4111-8111-111111111111", "wait-for-abort"),
				send,
			);
			await vi.waitFor(() => expect(prompts).toContain("wait-for-abort"));
			child.handleFrame({ type: "qorpera_model_abort", requestId: "71111111-1111-4111-8111-111111111111" }, send);
			await vi.waitFor(() =>
				expect(frames).toContainEqual({
					type: "qorpera_model_end",
					requestId: "71111111-1111-4111-8111-111111111111",
				}),
			);
			child.handleFrame(modelRequest(handle, aborted, "81111111-1111-4111-8111-111111111111", "after-abort"), send);
			await expectDenied("81111111-1111-4111-8111-111111111111");

			const bounded = modelIntent("91111111-1111-4111-8111-111111111111", {
				maxCalls: 1,
				maxInputTokens: 100_000,
				maxOutputTokens: 1,
				maxCostUsd: 100,
			});
			expect(child.authorizeIntent(bounded)).toBe(true);
			child.handleFrame(modelRequest(handle, bounded, "a1111111-1111-4111-8111-111111111111", "output-bound"), send);
			await vi.waitFor(() => expect(prompts).toContain("output-bound"));
			expect(outputLimits[prompts.indexOf("output-bound")]).toBe(1);
			child.handleFrame(
				modelRequest(handle, bounded, "b1111111-1111-4111-8111-111111111111", "over-call-budget"),
				send,
			);
			await expectDenied("b1111111-1111-4111-8111-111111111111");

			const noInput = modelIntent("c1111111-1111-4111-8111-111111111111", {
				...generous,
				maxInputTokens: 1,
			});
			expect(child.authorizeIntent(noInput)).toBe(true);
			child.handleFrame(
				modelRequest(handle, noInput, "d1111111-1111-4111-8111-111111111111", "over-input-budget"),
				send,
			);
			await expectDenied("d1111111-1111-4111-8111-111111111111");

			const noCost = modelIntent("e1111111-1111-4111-8111-111111111111", {
				...generous,
				maxCostUsd: 0,
			});
			expect(child.authorizeIntent(noCost)).toBe(true);
			child.handleFrame(
				modelRequest(handle, noCost, "f1111111-1111-4111-8111-111111111111", "over-cost-budget"),
				send,
			);
			await expectDenied("f1111111-1111-4111-8111-111111111111");
		} finally {
			child.release();
			broker.close();
		}
	});
});
