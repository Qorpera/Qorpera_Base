import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudRequestTimeoutError } from "@qorpera/cloud-client/cloud-request";
import type { CloudAgentSendInput, CloudAgentSendReceipt } from "@qorpera/runtime/cloud-agent-mouth";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import { tagNativeRuntimeFailure } from "@qorpera/runtime/cloud-native-failure";
import { HttpNativeProviderComputerBridge } from "@qorpera/runtime/cloud-native-provider";
import {
	type CompleteNativeProviderLoginInput,
	type NativeCloudExecutionDriver,
	type NativeCompanyExecutionRequest,
	type NativeCredentialCapsuleStore,
	type NativeHarnessDriver,
	type NativeProviderExecutionAuthority,
	NativeProviderHost,
	type NativeProviderLoginDescription,
	nativeProviderUsageSignal,
	OfficialCliNativeHarnessDriver,
	openNativeCredentialCapsule,
	sealNativeCredentialCapsule,
} from "@qorpera/runtime/cloud-native-provider-host";
import {
	HttpNativeProviderHostService,
	SupabaseNativeCredentialCapsuleStore,
	SupabaseNativeProviderControlPlane,
} from "@qorpera/runtime/cloud-native-provider-service";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const masterKey = randomBytes(32).toString("base64url");
const loginId = "10000000-0000-4000-8000-000000000001";
const connectionId = "10000000-0000-4000-8000-000000000002";
const computeIdentityId = "10000000-0000-4000-8000-000000000003";
const otherComputeIdentityId = "10000000-0000-4000-8000-000000000013";
const ownerUserId = "10000000-0000-4000-8000-000000000004";
const profileId = "10000000-0000-4000-8000-000000000005";
const runnerId = "10000000-0000-4000-8000-000000000011";
const assignmentId = "10000000-0000-4000-8000-000000000012";
const capability = "a".repeat(43);
const expiresAt = "2099-08-21T12:15:00.000Z";
const chatContext = {
	schema: "qorpera.runner-execution-context/v1",
	run: {
		runId: "10000000-0000-4000-8000-000000000008",
		jobId: "10000000-0000-4000-8000-000000000010",
		sessionId: loginId,
	},
};

function sendReceipt(
	request: NativeCompanyExecutionRequest,
	input: CloudAgentSendInput,
): Promise<CloudAgentSendReceipt> {
	return Promise.resolve({
		schema: "qorpera.agent-send/v1",
		runId: request.authority.runId,
		sessionId: loginId,
		messageId: connectionId,
		phase: input.phase,
		sequence: 1,
	});
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

class MemoryCapsules implements NativeCredentialCapsuleStore {
	readonly values = new Map<string, Uint8Array>();

	async put(reference: string, bytes: Uint8Array): Promise<void> {
		this.values.set(reference, Uint8Array.from(bytes));
	}

	async get(reference: string): Promise<Uint8Array> {
		const value = this.values.get(reference);
		if (!value) throw new Error("missing capsule");
		return Uint8Array.from(value);
	}
}

function description(): NativeProviderLoginDescription {
	return {
		loginId,
		profileId,
		clientConnectionId: connectionId,
		computeIdentityId,
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: ownerUserId,
		provider: "openai",
		nativeHarness: "codex-cli",
		expiresAt,
	};
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not reached");
}

/** A folder-v2 company execution: no paths, no payload; the company runtime reads its folder itself. */
function companyRequest(
	capsuleId: string,
	authority: Partial<NativeProviderExecutionAuthority> = {},
): NativeCompanyExecutionRequest {
	return {
		runtime: "company-path-v1",
		authority: {
			leaseId: "10000000-0000-4000-8000-000000000007",
			runId: chatContext.run.runId,
			credentialCapsuleId: capsuleId,
			encryptedCapsuleReference: `native-capsule/${capsuleId}`,
			attestationPolicySha256: "b".repeat(64),
			computeIdentityId,
			runnerId,
			assignmentId,
			provider: "openai",
			nativeHarness: "codex-cli",
			model: "gpt-test",
			expiresAt,
			...authority,
		},
		job: {
			jobId: chatContext.run.jobId,
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: null,
		},
	};
}

/** Matches exactly this message, so nothing private can ride along after it. */
function exactly(message: string): RegExp {
	const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}$`);
}

describe("native provider usage signal", () => {
	it("maps only the safe allowance, capacity and network categories to typed signals", () => {
		expect(
			nativeProviderUsageSignal(new Error("Provider harness exited with 7 (provider allowance unavailable)")),
		).toBe("usage_limit");
		expect(
			nativeProviderUsageSignal(
				new Error("Native provider execution harness-execution stage failed (unknown) [mouth=ready]", {
					cause: new Error("Codex did not complete its turn (provider capacity unavailable)"),
				}),
			),
		).toBe("rate_limited");
		expect(
			nativeProviderUsageSignal(new Error("Provider harness exited with 1 (provider network unavailable)")),
		).toBe("provider_outage");
		for (const message of [
			"Provider harness exited with 7 (authentication unavailable)",
			"Provider harness exited with 7 (provider context unavailable)",
			"You've hit your usage limit. Try again later.",
			"Provider harness output exceeded its byte limit",
		]) {
			expect(nativeProviderUsageSignal(new Error(message))).toBeUndefined();
		}
		expect(nativeProviderUsageSignal("provider allowance unavailable")).toBeUndefined();
	});
});

describe("native provider host", () => {
	it("authenticates, seals and restores a provider-native credential directory", async () => {
		const source = await temporaryRoot("qorpera-capsule-source-");
		const restored = await temporaryRoot("qorpera-capsule-restored-");
		const capsuleId = "10000000-0000-4000-8000-000000000006";
		await mkdir(join(source, "codex"), { recursive: true });
		await mkdir(join(source, "home"), { recursive: true });
		await writeFile(join(source, "codex", "auth.json"), '{"access_token":"secret"}\n', { mode: 0o600 });
		await symlink(join(source, "codex"), join(source, "home", ".codex"), "dir");
		const sealed = await sealNativeCredentialCapsule(source, masterKey, capsuleId);
		expect(Buffer.from(sealed).toString("utf-8")).not.toContain("access_token");
		await openNativeCredentialCapsule(sealed, restored, masterKey, capsuleId);
		await expect(readFile(join(restored, "codex", "auth.json"), "utf-8")).resolves.toContain("secret");
		await expect(lstat(join(restored, "home", ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(openNativeCredentialCapsule(sealed, restored, masterKey, loginId)).rejects.toThrow(
			"authenticated decryption",
		);
	});

	// The official CLI drives login only; the company lane's Codex process is covered by
	// cloud-codex-tool-session.test.ts.
	it("drives the official Codex login process contract inside the identity root", async () => {
		const identity = await temporaryRoot("qorpera-official-codex-login-");
		await writeFile(
			join(identity, "login"),
			[
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				"const [action] = process.argv.slice(2);",
				'if (process.env.TERM === "dumb") process.exit(4);',
				'if (process.env.DISABLE_AUTOUPDATER !== "1") process.exit(6);',
				'if (action === "--device-auth" && fs.existsSync("diagnostic")) {',
				'  console.error(fs.readFileSync("diagnostic", "utf8"));',
				"  process.exit(7);",
				"}",
				'if (action === "--device-auth") {',
				"  for (const directory of [process.env.HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME]) {",
				"    if (!fs.statSync(directory).isDirectory()) process.exit(7);",
				"  }",
				'  fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ refresh_token: "private" }));',
				'  console.log("Follow these steps to sign in with ChatGPT using device code authorization:\\n1. Open this link in your browser\\n   \\u001b[4mhttps://auth.openai.com/device\\u001b[0m\\n2. Enter this one-time code (expires in 15 minutes)\\n   \\u001b[1mABCD-EFGHI\\u001b[0m");',
				'} else if (action === "status") {',
				'  console.log("ChatGPT subscription test account");',
				"} else { process.exitCode = 2; }",
			].join("\n"),
			"utf-8",
		);
		const driver = new OfficialCliNativeHarnessDriver(process.execPath, process.execPath);
		const login = await driver.beginLogin("codex-cli", identity);
		await expect(login.prompt).resolves.toEqual({
			interactionUrl: "https://auth.openai.com/device",
			userCode: "ABCD-EFGHI",
		});
		await expect(login.completed).resolves.toEqual({
			providerAccountReference: `codex-cli:${createHash("sha256")
				.update("ChatGPT subscription test account")
				.digest("hex")}`,
		});
		await expect(readFile(join(identity, "codex", "auth.json"), "utf-8")).resolves.toContain("private");
		// A failed official process is reported as a fixed category, never with its output.
		for (const [diagnostic, category] of [
			["MCP startup failed: connection timeout", "public message transport"],
			["Error loading config.toml: invalid value", "harness configuration"],
			[
				JSON.stringify({ error: { code: "invalid_function_parameters", message: "invalid schema" } }),
				"provider tool schema",
			],
			[JSON.stringify({ error: { type: "invalid_request_error", message: "invalid input" } }), "provider request"],
			[JSON.stringify({ type: "error", message: "401 Unauthorized" }), "authentication"],
			["403 Forbidden", "provider authorization"],
			["Refresh token was already used", "authentication"],
			["Your access token could not be refreshed. Please log out and sign in again.", "authentication"],
			["model PRIVATE_NAME not found", "model"],
			["prompt_cache_retention is not supported on this model", "model"],
			["Unsupported parameter: PRIVATE_NAME", "model"],
			["You've hit your usage limit. Try again later.", "provider allowance"],
			["Your workspace is out of credits. Add credits to continue.", "provider allowance"],
			["You hit your spend cap set in your workspace.", "provider allowance"],
			[JSON.stringify({ error: { type: "usage_limit_reached" } }), "provider allowance"],
			["Selected model is at capacity. Please try a different model.", "provider capacity"],
			["We're currently experiencing high demand, which may cause temporary errors.", "provider capacity"],
			["Codex ran out of room in the model's context window.", "provider context"],
			["context_window_exceeded", "provider context"],
			["content_filter", "provider policy"],
			["stream disconnected before completion", "provider network"],
			["internal error; agent loop died unexpectedly", "harness internal"],
			["Missing environment variable: PRIVATE_NAME", "harness configuration"],
			["duplicate tool: PRIVATE_NAME", "provider tool schema"],
			["opaque", undefined],
		] as const) {
			await writeFile(join(identity, "diagnostic"), `${diagnostic}\nprivate-token-must-not-leak`);
			const failed = await driver.beginLogin("codex-cli", identity);
			await failed.prompt;
			await expect(failed.completed).rejects.toThrow(
				category
					? new RegExp(`^Provider harness exited with 7 \\(${category} unavailable\\)$`)
					: /^Provider harness exited with 7$/,
			);
		}
	});

	it("keeps modern Supabase secret keys out of bearer authorization", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
			calls.push({ url: String(input), headers: new Headers(init?.headers) });
			if (String(input).includes("qorpera_describe_native_provider_login")) {
				return Response.json({
					login_id: loginId,
					profile_id: profileId,
					client_connection_id: connectionId,
					compute_identity_id: computeIdentityId,
					compute_identity_ownership_kind: "member",
					compute_identity_owner_user_id: ownerUserId,
					compute_identity_owner_scope_key: null,
					provider: "openai",
					native_harness: "codex-cli",
					expires_at: expiresAt,
				});
			}
			return new Response(Uint8Array.from([1, 2, 3]));
		});
		const control = new SupabaseNativeProviderControlPlane(
			"https://project.supabase.co",
			"sb_secret_private",
			fetchImplementation,
		);
		await control.describeLogin(loginId, capability);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("apikey")).toBe("sb_secret_private");
		expect(calls[0]?.headers.get("authorization")).toBeNull();
		// G2-4: the capsule store holds no key; the native host's dispatch signs its requests.
		const capsules = new SupabaseNativeCredentialCapsuleStore("https://project.supabase.co", fetchImplementation);
		await capsules.get(`native-capsule/${loginId}`);
		expect(calls[1]?.url).toBe(
			`https://project.supabase.co/storage/v1/object/qorpera-native-compute-capsules/${loginId}.capsule`,
		);
		expect(calls[1]?.headers.get("apikey")).toBeNull();
		expect(calls[1]?.headers.get("authorization")).toBeNull();
	});

	it("rejects native requests that did not arrive from the configured infrastructure source", async () => {
		const describeLogin = vi.fn();
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin,
				completeLogin: vi.fn(),
				validateExecution: vi.fn(),
				sendMessage: vi.fn(sendReceipt),
			},
			capsules: new MemoryCapsules(),
			harness: { beginLogin: vi.fn() },
			masterKey,
			computeIdentityId,
		});
		const service = new HttpNativeProviderHostService(
			host,
			randomBytes(32).toString("base64url"),
			"127.0.0.1",
			0,
			"192.0.2.1",
		);
		const port = await service.start();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/login`, {
				method: "POST",
				headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(403);
			expect(describeLogin).not.toHaveBeenCalled();
		} finally {
			await service.close();
		}
	});

	it.each([
		"opaque private-token-must-not-leak",
		"Provider harness exited with 1 [mouth=private-token-must-not-leak]",
		"private-token-must-not-leak [mouth=ready]",
	])("redacts unexpected service errors to a fixed safe class: %s", async (privateDiagnostic) => {
		const host = {
			beginLogin: vi.fn(async () => {
				throw new Error(privateDiagnostic);
			}),
		} as unknown as NativeProviderHost;
		const service = new HttpNativeProviderHostService(host, randomBytes(32).toString("base64url"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const port = await service.start();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/login`, {
				method: "POST",
				headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.native-provider-login/v1",
					login_id: loginId,
					client_connection_id: connectionId,
					compute_identity_id: computeIdentityId,
					compute_identity_ownership_kind: "member",
					compute_identity_owner_user_id: ownerUserId,
					compute_identity_owner_scope_key: null,
					provider: "openai",
					native_harness: "codex-cli",
					login_capability: capability,
					expires_at: expiresAt,
				}),
			});
			expect(response.status).toBe(422);
			expect(logged).toHaveBeenCalledWith(
				`Native provider request rejected: internal rejection (error; message-sha256=${createHash("sha256").update(privateDiagnostic).digest("hex").slice(0, 16)}) [code=UNCLASSIFIED]`,
			);
			expect(logged.mock.calls.flat().join("\n")).not.toContain(privateDiagnostic);
		} finally {
			logged.mockRestore();
			await service.close();
		}
	});

	it("runs official login inside the identity and returns only interaction metadata", async () => {
		const root = await temporaryRoot("qorpera-native-host-");
		const capsules = new MemoryCapsules();
		const completed: CompleteNativeProviderLoginInput[] = [];
		let finishLogin: (() => void) | undefined;
		const harness: NativeHarnessDriver = {
			beginLogin: vi.fn(async (_harness, identityRoot) => {
				await mkdir(join(identityRoot, "codex"), { recursive: true });
				await writeFile(join(identityRoot, "codex", "auth.json"), '{"refresh_token":"private"}\n');
				await writeFile(join(identityRoot, "codex", "config.toml"), 'model = "not-credential-state"\n');
				await mkdir(join(identityRoot, "codex", "log"));
				await writeFile(join(identityRoot, "codex", "log", "login.log"), "private login diagnostic\n");
				return {
					prompt: Promise.resolve({
						interactionUrl: "https://auth.openai.com/device",
						userCode: "ABCD-EFGH",
					}),
					completed: new Promise<{ providerAccountReference?: string }>((resolve) => {
						finishLogin = () => resolve({ providerAccountReference: "ChatGPT subscription" });
					}),
					cancel: async () => undefined,
				};
			}),
		};
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(async () => description()),
				completeLogin: vi.fn(async (input) => {
					completed.push(input);
				}),
				validateExecution: vi.fn(),
				sendMessage: vi.fn(sendReceipt),
			},
			capsules,
			harness,
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		const request = {
			loginId,
			clientConnectionId: connectionId,
			computeIdentityId,
			computeIdentityOwnershipKind: "member" as const,
			computeIdentityOwnerUserId: ownerUserId,
			provider: "openai" as const,
			nativeHarness: "codex-cli" as const,
			capability,
			expiresAt,
		};
		await expect(host.beginLogin({ ...request, computeIdentityId: otherComputeIdentityId })).rejects.toThrow(
			"another Compute Identity",
		);
		await expect(host.beginLogin(request)).resolves.toEqual({
			schema: "qorpera.native-provider-login-result/v1",
			login_id: loginId,
			status: "awaiting_member",
			interaction_url: "https://auth.openai.com/device",
			user_code: "ABCD-EFGH",
		});
		finishLogin?.();
		await waitFor(() => completed.length === 1);
		expect(completed[0]).toMatchObject({
			loginId,
			capability,
			// Named for the sign-in: the one capsule its login guest may write (G2-4).
			capsuleId: loginId,
			encryptedCapsuleReference: `native-capsule/${loginId}`,
			providerAccountReference: "ChatGPT subscription",
		});
		const capsule = capsules.values.get(completed[0]?.encryptedCapsuleReference as string);
		expect(capsule).toBeDefined();
		expect(Buffer.from(capsule as Uint8Array).toString("utf-8")).not.toContain("refresh_token");
		const restored = await temporaryRoot("qorpera-native-login-restored-");
		await openNativeCredentialCapsule(capsule as Uint8Array, restored, masterKey, completed[0]!.capsuleId);
		expect(await readdir(restored)).toEqual(["codex"]);
		expect(await readdir(join(restored, "codex"))).toEqual(["auth.json"]);
		expect(await readFile(join(restored, "codex", "auth.json"), "utf8")).toContain("private");
		await expect(host.beginLogin(request)).resolves.toMatchObject({ status: "completed" });
	});

	// The company runtime gets the identity root and nothing else; prompts, the public mouth and the
	// final-send rule are the company runtime's own.
	it("restores the capsule only for the company runtime and returns transcript-safe output", async () => {
		const root = await temporaryRoot("qorpera-native-company-execution-");
		const identity = await temporaryRoot("qorpera-native-company-identity-");
		const capsules = new MemoryCapsules();
		const capsuleId = "10000000-0000-4000-8000-000000000006";
		const reference = `native-capsule/${capsuleId}`;
		await mkdir(join(identity, "codex"), { recursive: true });
		await writeFile(join(identity, "codex", "auth.json"), '{"access_token":"private"}\n');
		await writeFile(join(identity, "codex", "config.toml"), 'model = "not-credential-state"\n');
		const original = await sealNativeCredentialCapsule(identity, masterKey, capsuleId);
		await capsules.put(reference, original);
		let completion: Awaited<ReturnType<NativeCloudExecutionDriver["execute"]>> = {
			providerSessionId: "session-1",
			delivery: { messageCount: 1, finalMessageId: connectionId },
		};
		const execute = vi.fn<NativeCloudExecutionDriver["execute"]>(async (request, identityRoot) => {
			expect(request).toMatchObject({ runtime: "company-path-v1", job: { payload: null } });
			expect(request).not.toHaveProperty("input");
			expect(request).not.toHaveProperty("outputRoot");
			// Only the login itself is opened: no configuration, hooks or sessions reach the harness.
			expect(await readdir(identityRoot)).toEqual(["codex"]);
			expect(await readdir(join(identityRoot, "codex"))).toEqual(["auth.json"]);
			expect(await readFile(join(identityRoot, "codex", "auth.json"), "utf-8")).toContain("private");
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"access_token":"refreshed-private"}\n');
			await mkdir(join(identityRoot, "codex", "sessions"), { recursive: true });
			await writeFile(join(identityRoot, "codex", "sessions", "transient.jsonl"), "runtime-only\n");
			// Whatever else a runtime hands back never reaches the result.
			const returned = { ...completion, privateFinalText: "private final text must never be delivered" };
			return returned;
		});
		const validateExecution = vi.fn();
		const sendMessage = vi.fn(sendReceipt);
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(),
				completeLogin: vi.fn(),
				validateExecution,
				sendMessage,
			},
			capsules,
			harness: { beginLogin: vi.fn() },
			cloudRuntime: { execute },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		const executionRequest = companyRequest(capsuleId);
		await expect(
			host.execute(companyRequest(capsuleId, { computeIdentityId: otherComputeIdentityId })),
		).rejects.toThrow("another Compute Identity");
		// The company runtime is the host's only execution lane: without it the host opens nothing.
		const withoutRuntime = new NativeProviderHost({
			controlPlane: { describeLogin: vi.fn(), completeLogin: vi.fn(), validateExecution, sendMessage },
			capsules,
			harness: { beginLogin: vi.fn() },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		await expect(withoutRuntime.execute(executionRequest)).rejects.toThrow(
			exactly("Native provider execution runtime is not configured for this request"),
		);
		expect(validateExecution).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		const result = await host.execute(executionRequest);
		expect(result).toEqual({
			schema: "qorpera.native-harness-result/v2",
			run_id: executionRequest.authority.runId,
			message_count: 1,
			final_message_id: connectionId,
			provider_session_id: "session-1",
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(validateExecution).toHaveBeenCalledTimes(2);
		expect(validateExecution).toHaveBeenLastCalledWith(executionRequest, expect.any(AbortSignal));
		// The renewed login is saved, pruned to the login itself.
		const refreshedIdentity = await temporaryRoot("qorpera-native-company-refreshed-identity-");
		await openNativeCredentialCapsule(await capsules.get(reference), refreshedIdentity, masterKey, capsuleId);
		expect(await readdir(join(refreshedIdentity, "codex"))).toEqual(["auth.json"]);
		expect(await readFile(join(refreshedIdentity, "codex", "auth.json"), "utf-8")).toContain("refreshed-private");
		expect(await readdir(root)).toEqual([]);

		// Authority revoked before the end: the renewal is not saved.
		await capsules.put(reference, original);
		validateExecution.mockReset();
		validateExecution.mockResolvedValueOnce(undefined);
		validateExecution.mockRejectedValueOnce(new Error("private revoked authority"));
		await expect(host.execute(executionRequest)).rejects.toThrow(
			exactly("Native provider execution completion-authority-validation stage failed"),
		);
		expect(Buffer.from(await capsules.get(reference)).equals(Buffer.from(original))).toBe(true);

		// The stored login is the original again, so this run's renewal is a change to save.
		const uploadFailureHost = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(),
				completeLogin: vi.fn(),
				validateExecution: vi.fn(),
				sendMessage,
			},
			capsules: {
				get: async (capsuleReference) => capsules.get(capsuleReference),
				put: async () => {
					throw new Error("private storage response");
				},
			},
			harness: { beginLogin: vi.fn() },
			cloudRuntime: { execute },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		await expect(uploadFailureHost.execute(executionRequest)).rejects.toThrow(
			exactly("Native provider execution credential-upload stage failed"),
		);

		// A turn without its final send fails in the company runtime (cloud-native-company-runtime.test.ts,
		// "requires a final send when there is an audience"); the host passes only its stage on.
		execute.mockRejectedValueOnce(
			tagNativeRuntimeFailure(new Error("Native agent turn ended without a final send"), "public-completion"),
		);
		await expect(host.execute(executionRequest)).rejects.toThrow(
			exactly("Native provider execution failed (stage=public-completion, category=unknown) [mouth=uninitialized]"),
		);
		completion = { providerSessionId: "silent-job", delivery: { messageCount: 0, finalMessageId: null } };
		await expect(host.execute(executionRequest)).resolves.toEqual({
			schema: "qorpera.native-harness-result/v2",
			run_id: executionRequest.authority.runId,
			message_count: 0,
			final_message_id: null,
			provider_session_id: "silent-job",
		});
		expect(sendMessage).not.toHaveBeenCalled();
		expect(await readdir(root)).toEqual([]);
	});

	it("names a capsule download that got no answer a timeout, and one the store refused a plain failure", async () => {
		const root = await temporaryRoot("qorpera-native-company-download-");
		const capsuleId = "10000000-0000-4000-8000-000000000016";
		const get = vi.fn<NativeCredentialCapsuleStore["get"]>();
		const execute = vi.fn<NativeCloudExecutionDriver["execute"]>();
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(),
				completeLogin: vi.fn(),
				validateExecution: vi.fn(),
				sendMessage: vi.fn(),
			},
			capsules: { get, put: vi.fn() },
			harness: { beginLogin: vi.fn() },
			cloudRuntime: { execute },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		for (const [error, message] of [
			// The store's own deadline (withCloudDeadline).
			[new CloudRequestTimeoutError(), "Native provider execution credential-download stage failed (timeout)"],
			[
				new TypeError("terminated", {
					cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
				}),
				"Native provider execution credential-download stage failed (timeout)",
			],
			// What SupabaseNativeCredentialCapsuleStore.get throws for a refused download.
			[
				new Error("Native capsule download failed (403)"),
				"Native provider execution credential-download stage failed",
			],
		] as const) {
			get.mockRejectedValueOnce(error);
			await expect(host.execute(companyRequest(capsuleId))).rejects.toThrow(exactly(message));
		}
		expect(get).toHaveBeenCalledTimes(3);
		expect(execute).not.toHaveBeenCalled();
		expect(await readdir(root)).toEqual([]);
	});

	it.each(["provider_failed", "missing_final", "revoked", "cancelled"] as const)(
		"preserves rotated credentials after a company %s only while the execution remains authorized",
		async (outcome) => {
			const root = await temporaryRoot("qorpera-native-company-failure-");
			const identity = await temporaryRoot("qorpera-native-company-failure-identity-");
			const capsules = new MemoryCapsules();
			const capsuleId = "10000000-0000-4000-8000-000000000006";
			const reference = `native-capsule/${capsuleId}`;
			await mkdir(join(identity, "codex"));
			await writeFile(join(identity, "codex", "auth.json"), '{"refresh_token":"original-private"}\n');
			await capsules.put(reference, await sealNativeCredentialCapsule(identity, masterKey, capsuleId));
			const put = vi.spyOn(capsules, "put");
			const controller = new AbortController();
			let authorized = true;
			const validateExecution = vi.fn(async () => {
				if (!authorized) throw new Error("revoked-private");
			});
			const sendMessage = vi.fn(sendReceipt);
			const host = new NativeProviderHost({
				controlPlane: { describeLogin: vi.fn(), completeLogin: vi.fn(), validateExecution, sendMessage },
				capsules,
				harness: { beginLogin: vi.fn() },
				cloudRuntime: {
					execute: vi.fn<NativeCloudExecutionDriver["execute"]>(async (_request, identityRoot, signal) => {
						await writeFile(join(identityRoot, "codex", "auth.json"), '{"refresh_token":"rotated-private"}\n');
						await mkdir(join(identityRoot, "codex", "sessions"));
						await writeFile(join(identityRoot, "codex", "sessions", "private.jsonl"), "PRIVATE_REASONING\n");
						if (outcome === "revoked") authorized = false;
						if (outcome === "cancelled") {
							controller.abort(new Error("Native execution cancelled"));
							signal.throwIfAborted();
						}
						if (outcome === "missing_final")
							throw tagNativeRuntimeFailure(
								new Error("Native agent turn ended without a final send"),
								"public-completion",
							);
						throw new Error("Provider harness exited with 1 (provider network unavailable)");
					}),
				},
				masterKey,
				computeIdentityId,
				temporaryRoot: root,
			});
			await expect(host.execute(companyRequest(capsuleId), controller.signal)).rejects.toThrow(
				exactly(
					outcome === "missing_final"
						? "Native provider execution failed (stage=public-completion, category=unknown) [mouth=uninitialized]"
						: outcome === "cancelled"
							? "Native provider execution harness-execution stage failed (cancelled) [mouth=uninitialized]"
							: "Provider harness exited with 1 (provider network unavailable) [mouth=uninitialized]",
				),
			);
			const shouldRefresh = outcome === "provider_failed" || outcome === "missing_final";
			expect(put).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
			expect(validateExecution).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 2);
			expect(sendMessage).not.toHaveBeenCalled();
			const restored = await temporaryRoot("qorpera-native-company-failure-restored-");
			await openNativeCredentialCapsule(await capsules.get(reference), restored, masterKey, capsuleId);
			expect(JSON.parse(await readFile(join(restored, "codex", "auth.json"), "utf-8"))).toEqual({
				refresh_token: shouldRefresh ? "rotated-private" : "original-private",
			});
			await expect(lstat(join(restored, "codex", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readdir(root)).toEqual([]);
		},
	);

	// A company execution carries no paths and no payload; the company runtime has no public mouth on this
	// host, so every failure reads [mouth=uninitialized].
	it("runs login and company execution through the standalone cloud bridge and fences revoked authority", async () => {
		const root = await temporaryRoot("qorpera-native-company-service-");
		const capsules = new MemoryCapsules();
		const completed: CompleteNativeProviderLoginInput[] = [];
		let finishLogin: (() => void) | undefined;
		let authorized = true;
		const harness: NativeHarnessDriver = {
			beginLogin: vi.fn(async (_harness, identityRoot) => {
				await mkdir(join(identityRoot, "codex"), { recursive: true });
				await writeFile(join(identityRoot, "codex", "auth.json"), '{"refresh_token":"private"}\n');
				return {
					prompt: Promise.resolve({
						interactionUrl: "https://auth.openai.com/device",
						userCode: "ABCD-EFGH",
					}),
					completed: new Promise<{ providerAccountReference?: string }>((resolveLogin) => {
						finishLogin = () => resolveLogin({ providerAccountReference: "ChatGPT subscription" });
					}),
					cancel: async () => undefined,
				};
			}),
		};
		const execute = vi.fn<NativeCloudExecutionDriver["execute"]>(async (request, identityRoot) => {
			const credential = completed[0] as CompleteNativeProviderLoginInput;
			// The bridge's closed company schema arrives as exactly this request: no paths, no copied payload.
			expect(request).toEqual(
				companyRequest(credential.capsuleId, {
					encryptedCapsuleReference: credential.encryptedCapsuleReference,
					attestationPolicySha256: credential.attestationPolicySha256,
				}),
			);
			expect(await readFile(join(identityRoot, "codex", "auth.json"), "utf-8")).toContain("private");
			return { providerSessionId: "native-session-1", delivery: { messageCount: 1, finalMessageId: connectionId } };
		});
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(async () => description()),
				completeLogin: vi.fn(async (value) => {
					completed.push(value);
				}),
				validateExecution: vi.fn(async () => {
					if (!authorized) throw new Error("native authority revoked");
				}),
				sendMessage: vi.fn(sendReceipt),
			},
			capsules,
			harness,
			cloudRuntime: { execute },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		const bridgeToken = randomBytes(32).toString("base64url");
		const service = new HttpNativeProviderHostService(host, bridgeToken);
		const port = await service.start();
		try {
			const bridge = new HttpNativeProviderComputerBridge(`http://127.0.0.1:${port}/`, bridgeToken, fetch, {
				executionBoundary: "virtual_machine",
			});
			await expect(
				bridge.beginLogin({
					loginId,
					clientLoginId: "10000000-0000-4000-8000-000000000014",
					clientConnectionId: connectionId,
					computeIdentityId,
					computeIdentityOwnershipKind: "member",
					computeIdentityOwnerUserId: ownerUserId,
					provider: "openai",
					nativeHarness: "codex-cli",
					capability,
					expiresAt,
				}),
			).resolves.toMatchObject({ status: "awaiting_member", userCode: "ABCD-EFGH" });
			finishLogin?.();
			await waitFor(() => completed.length === 1);
			const credential = completed[0] as CompleteNativeProviderLoginInput;
			const nativeAuthority = {
				leaseId: "10000000-0000-4000-8000-000000000007",
				runId: chatContext.run.runId,
				providerConnectionId: connectionId,
				providerConnectionVersion: 1,
				credentialCapsuleId: credential.capsuleId,
				encryptedCapsuleReference: credential.encryptedCapsuleReference,
				attestationPolicySha256: credential.attestationPolicySha256,
				computeIdentityId,
				computeIdentityOwnershipKind: "member" as const,
				computeIdentityOwnerUserId: ownerUserId,
				credentialOwnershipKind: "member" as const,
				credentialOwnerUserId: ownerUserId,
				provider: "openai",
				authenticationMode: "native_subscription" as const,
				nativeHarness: "codex-cli" as const,
				model: "gpt-test",
				runnerId,
				assignmentId,
				expiresAt,
			};
			const job = { jobId: chatContext.run.jobId, attemptCount: 1 };
			const execution = await bridge.startCompany(nativeAuthority, job);
			await expect(execution.result).resolves.toEqual({
				schema: "qorpera.native-harness-result/v2",
				run_id: chatContext.run.runId,
				message_count: 1,
				final_message_id: connectionId,
				provider_session_id: "native-session-1",
			});

			// Revoked authority stops the run before the company runtime starts, and says only its stage.
			authorized = false;
			const revokedLogged = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				const revoked = await bridge.startCompany({ ...nativeAuthority, leaseId: loginId }, job);
				await expect(revoked.result).rejects.toThrow(
					exactly("Native provider bridge request failed (422) [code=NATIVE_INITIAL_AUTHORITY_VALIDATION]"),
				);
				expect(revokedLogged).toHaveBeenCalledWith(
					"Native provider request rejected: Native provider execution initial-authority-validation stage failed [code=NATIVE_INITIAL_AUTHORITY_VALIDATION]",
				);
				expect(revokedLogged.mock.calls.flat().join("\n")).not.toContain("native authority revoked");
			} finally {
				revokedLogged.mockRestore();
			}
			expect(execute).toHaveBeenCalledTimes(1);

			authorized = true;
			const privateDiagnostic = "opaque private-token-must-not-leak";
			const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				execute.mockRejectedValueOnce(Object.assign(new Error(privateDiagnostic), { code: "EACCES" }));
				const denied = await bridge.startCompany({ ...nativeAuthority, leaseId: otherComputeIdentityId }, job);
				await expect(denied.result).rejects.toThrow(
					exactly(
						"Native provider bridge request failed (422) [code=NATIVE_HARNESS_EXECUTION:FILESYSTEM_PERMISSION]",
					),
				);
				expect(logged).toHaveBeenLastCalledWith(
					"Native provider request rejected: Native provider execution harness-execution stage failed (filesystem-permission) [mouth=uninitialized] [code=NATIVE_HARNESS_EXECUTION:FILESYSTEM_PERMISSION]",
				);
				// The company runtime tags its failures; only the stage and category travel on.
				execute.mockRejectedValueOnce(
					tagNativeRuntimeFailure(new Error(privateDiagnostic), "codex-turn-completion", "provider_failed"),
				);
				const tagged = await bridge.startCompany({ ...nativeAuthority, leaseId: otherComputeIdentityId }, job);
				await expect(tagged.result).rejects.toThrow(
					exactly(
						"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]",
					),
				);
				expect(logged).toHaveBeenLastCalledWith(
					"Native provider request rejected: Native provider execution failed (stage=codex-turn-completion, category=provider_failed) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]",
				);
				execute.mockRejectedValueOnce(
					new Error("Provider harness exited with 1 (provider authorization unavailable)"),
				);
				const exited = await bridge.startCompany({ ...nativeAuthority, leaseId: otherComputeIdentityId }, job);
				await expect(exited.result).rejects.toThrow(
					exactly("Native provider bridge request failed (422) [code=HARNESS_EXITED:PROVIDER_AUTHORIZATION]"),
				);
				expect(logged).toHaveBeenLastCalledWith(
					"Native provider request rejected: Provider harness exited with 1 (provider authorization unavailable) [mouth=uninitialized] [code=HARNESS_EXITED:PROVIDER_AUTHORIZATION]",
				);
				expect(logged).toHaveBeenCalledTimes(3);
				expect(logged.mock.calls.flat().join("\n")).not.toContain(privateDiagnostic);
			} finally {
				logged.mockRestore();
			}

			// A run has no deadline: the host answers the execution's headers at once (and keeps
			// the body alive), so an HTTP client's five-minute header timeout never applies.
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			execute.mockImplementationOnce(async () => {
				await gate;
				return {
					providerSessionId: "native-session-long",
					delivery: { messageCount: 1, finalMessageId: connectionId },
				};
			});
			let headersAt = 0;
			const timed = new HttpNativeProviderComputerBridge(
				`http://127.0.0.1:${port}/`,
				bridgeToken,
				async (input, init) => {
					const response = await fetch(input, init);
					headersAt = Date.now();
					return response;
				},
				{ executionBoundary: "virtual_machine" },
			);
			const long = await timed.startCompany(nativeAuthority, job);
			await vi.waitFor(() => expect(headersAt).toBeGreaterThan(0));
			const releasedAt = Date.now();
			release();
			await expect(long.result).resolves.toEqual({
				schema: "qorpera.native-harness-result/v2",
				run_id: chatContext.run.runId,
				message_count: 1,
				final_message_id: connectionId,
				provider_session_id: "native-session-long",
			});
			expect(headersAt).toBeLessThanOrEqual(releasedAt);

			// A failure after those early headers still reaches the bridge as a refusal, never a result.
			let fail: () => void = () => undefined;
			const failGate = new Promise<void>((resolve) => {
				fail = resolve;
			});
			execute.mockImplementationOnce(async () => {
				await failGate;
				throw new Error("harness stopped");
			});
			headersAt = 0;
			const lateLogged = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				const failing = await timed.startCompany(nativeAuthority, job);
				await vi.waitFor(() => expect(headersAt).toBeGreaterThan(0));
				fail();
				await expect(failing.result).rejects.toThrow(
					exactly("Native provider bridge request failed (422) [code=NATIVE_HARNESS_EXECUTION:UNKNOWN]"),
				);
				expect(lateLogged).toHaveBeenCalledWith(
					"Native provider request rejected: Native provider execution harness-execution stage failed (unknown) [mouth=uninitialized] [code=NATIVE_HARNESS_EXECUTION:UNKNOWN]",
				);
			} finally {
				lateLogged.mockRestore();
			}
			expect(await readdir(root)).toEqual([]);
		} finally {
			await service.close();
		}
	});
});

describe("native provider host authority checks in a control-plane outage (WB-001, 28 Oct 2026)", () => {
	const realSetTimeout = setTimeout;
	const fileWork = () => new Promise((resolve) => realSetTimeout(resolve, 5));

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** A capsule run on fake timers that goes on until `finish`, or stops with its signal. `check` sees each authority
	 * check's number, from 1, and throws to fail it. */
	async function outageRun(check: (call: number) => void) {
		const root = await temporaryRoot("qorpera-native-outage-");
		const identity = await temporaryRoot("qorpera-native-outage-identity-");
		const capsules = new MemoryCapsules();
		const capsuleId = "10000000-0000-4000-8000-000000000006";
		await mkdir(join(identity, "codex"));
		await writeFile(join(identity, "codex", "auth.json"), '{"refresh_token":"original-private"}\n');
		await capsules.put(
			`native-capsule/${capsuleId}`,
			await sealNativeCredentialCapsule(identity, masterKey, capsuleId),
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const origin = Date.now();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
		let calls = 0;
		const validateExecution = vi.fn(async () => {
			calls += 1;
			check(calls);
		});
		let started = false;
		let finish = (): void => undefined;
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(),
				completeLogin: vi.fn(),
				validateExecution,
				sendMessage: vi.fn(sendReceipt),
			},
			capsules,
			harness: { beginLogin: vi.fn() },
			cloudRuntime: {
				execute: vi.fn<NativeCloudExecutionDriver["execute"]>(
					async (_request, _identityRoot, signal) =>
						new Promise((resolve, reject) => {
							finish = () =>
								resolve({
									providerSessionId: "session-1",
									delivery: { messageCount: 1, finalMessageId: connectionId },
								});
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
							started = true;
						}),
				),
			},
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		let settled = false;
		const result = host.execute(companyRequest(capsuleId)).finally(() => {
			settled = true;
		});
		result.catch(() => undefined);
		// Opening the login is file work: the clock stands still until the run is under way.
		for (let wait = 0; wait < 1_000 && !started; wait += 1) await fileWork();
		expect(started).toBe(true);
		return {
			validateExecution,
			finish: () => finish(),
			/** Lets the run's file work and short pauses go on until it ends. */
			async end() {
				for (let wait = 0; wait < 1_000 && !settled; wait += 1) {
					await fileWork();
					await vi.advanceTimersByTimeAsync(50);
				}
				return result;
			},
		};
	}

	it("asks a lost or late check again and keeps the run", async () => {
		// The checks at 15, 30 and 45 s and the first at the run's end are lost; the rest answer.
		const run = await outageRun((call) => {
			if ([2, 3, 4, 6].includes(call)) throw new CloudRuntimeDiagnosticError("transport_unavailable");
		});
		await vi.advanceTimersByTimeAsync(65_000);
		expect(run.validateExecution).toHaveBeenCalledTimes(5);
		run.finish();
		await expect(run.end()).resolves.toMatchObject({ message_count: 1, provider_session_id: "session-1" });
		expect(run.validateExecution).toHaveBeenCalledTimes(7);
	});

	it("stops the run at once on a refusal", async () => {
		const run = await outageRun((call) => {
			if (call === 2) throw new CloudControlRpcRefused("42501", "Run is no longer authorized");
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(run.end()).rejects.toThrow(
			exactly("Native provider execution completion-authority-validation stage failed"),
		);
		expect(run.validateExecution).toHaveBeenCalledTimes(2);
	});

	it("stops the run once its checks have gone unanswered for a native lease's length", async () => {
		const run = await outageRun((call) => {
			if (call > 1) throw new CloudRuntimeDiagnosticError("timeout");
		});
		// Asked every 15 s: the one at 105 s fails, and the next would begin 120 s after the last answer.
		await vi.advanceTimersByTimeAsync(104_000);
		expect(run.validateExecution).toHaveBeenCalledTimes(7);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(run.end()).rejects.toThrow(
			exactly("Native provider execution completion-authority-validation stage failed"),
		);
		expect(run.validateExecution).toHaveBeenCalledTimes(8);
	});
});
