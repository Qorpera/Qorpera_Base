import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CloudAgentMouthConnection,
	CloudAgentSendInput,
	CloudAgentSendReceipt,
} from "@qorpera/runtime/cloud-agent-mouth";
import { HttpNativeProviderComputerBridge } from "@qorpera/runtime/cloud-native-provider";
import {
	type CompleteNativeProviderLoginInput,
	type NativeCredentialCapsuleStore,
	type NativeHarnessDriver,
	type NativeProviderExecutionRequest,
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
const mouth = { url: "http://127.0.0.1:1/mcp", bearerToken: "m".repeat(43) };
const chatContext = {
	schema: "qorpera.runner-execution-context/v1",
	run: {
		runId: "10000000-0000-4000-8000-000000000008",
		jobId: "10000000-0000-4000-8000-000000000010",
		sessionId: loginId,
	},
};

async function sendFinal(connection: CloudAgentMouthConnection): Promise<void> {
	const response = await fetch(connection.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${connection.bearerToken}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "send_message",
				arguments: { text: "Explicit public result", phase: "final", idempotencyKey: "result" },
			},
		}),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ result: { structuredContent: { phase: "final" } } });
}

function sendReceipt(
	request: NativeProviderExecutionRequest,
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

	it("drives the official Codex login and execution process contract inside the identity root", async () => {
		const identity = await temporaryRoot("qorpera-official-codex-identity-");
		const company = await temporaryRoot("qorpera-official-codex-company-");
		await writeFile(
			join(identity, "login"),
			[
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				"const [action] = process.argv.slice(2);",
				'if (process.env.TERM === "dumb") process.exit(4);',
				'if (process.env.DISABLE_AUTOUPDATER !== "1") process.exit(6);',
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
		await writeFile(
			join(company, "exec"),
			[
				'const fs = require("node:fs");',
				"const args = process.argv.slice(2);",
				'if (args.includes("--output-last-message")) process.exit(10);',
				'if (!args.includes("--ephemeral") || !args.includes("--ignore-user-config")) process.exit(11);',
				'if (!args.some((arg) => arg.startsWith("mcp_servers.qorpera=") && arg.includes("required=true"))) process.exit(12);',
				'if (process.env.QORPERA_AGENT_SEND_TOKEN !== "m".repeat(43)) process.exit(13);',
				'let prompt = "";',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", (chunk) => { prompt += chunk; });',
				'process.stdin.on("end", () => {',
				'  if (prompt.startsWith("diagnostic fixture: ")) {',
				'    console.error(prompt.slice("diagnostic fixture: ".length));',
				"    process.exit(7);",
				"  }",
				'  if (prompt.includes("diagnostic authentication failure")) {',
				'    console.log(JSON.stringify({ type: "error", message: "401 Unauthorized private-token-must-not-leak" }));',
				"    process.exit(9);",
				"  }",
				'  if (prompt.includes("diagnostic opaque failure")) {',
				'    console.log(JSON.stringify({ type: "error", message: "opaque private-token-must-not-leak" }));',
				"    process.exit(8);",
				"  }",
				'  if (prompt.includes("diagnostic zero-exit model failure")) {',
				'    console.log(JSON.stringify({ type: "turn.failed", error: { message: "prompt_cache_retention is not supported on this model private-token-must-not-leak" } }));',
				"    return;",
				"  }",
				'  if (prompt.includes("diagnostic zero-exit opaque failure")) {',
				'    console.log(JSON.stringify({ type: "error", message: "opaque private-token-must-not-leak" }));',
				"    return;",
				"  }",
				'  if (!prompt.includes("canonical transcript")) process.exit(3);',
				'  if (prompt.includes("provider default") && args.includes("--model")) process.exit(5);',
				'  console.log(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning must never be delivered" } }));',
				'  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "private final text must never be delivered" } }));',
				'  console.log(JSON.stringify({ type: "thread.started", thread_id: "official-thread-1" }));',
				'  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));',
				"});",
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
		await expect(
			driver.execute({
				mouth,
				harness: "codex-cli",
				model: "gpt-test",
				identityRoot: identity,
				companyRoot: company,
				prompt: "canonical transcript and queued input",
			}),
		).resolves.toEqual({
			providerSessionId: "official-thread-1",
		});
		expect((await readdir(identity)).some((name) => name.startsWith(".qorpera-last-message-"))).toBe(false);
		await expect(
			driver.execute({
				mouth,
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "canonical transcript using the provider default",
			}),
		).resolves.toEqual({
			providerSessionId: "official-thread-1",
		});
		await expect(
			driver.execute({
				mouth,
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic authentication failure",
			}),
		).rejects.toThrow("Provider harness exited with 9 (authentication unavailable)");
		await expect(
			driver.execute({
				mouth,
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic opaque failure",
			}),
		).rejects.toThrow(/^Provider harness exited with 8$/);
		await expect(
			driver.execute({
				mouth,
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic zero-exit model failure",
			}),
		).rejects.toThrow("Codex did not complete its turn (model unavailable)");
		await expect(
			driver.execute({
				mouth,
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic zero-exit opaque failure",
			}),
		).rejects.toThrow(/^Codex did not complete its turn$/);
		for (const [diagnostic, category] of [
			["MCP startup failed: connection timeout", "public message transport"],
			["Error loading config.toml: invalid value", "harness configuration"],
			[
				JSON.stringify({ error: { code: "invalid_function_parameters", message: "invalid schema" } }),
				"provider tool schema",
			],
			[JSON.stringify({ error: { type: "invalid_request_error", message: "invalid input" } }), "provider request"],
			["403 Forbidden", "provider authorization"],
			["Refresh token was already used", "authentication"],
			["Your access token could not be refreshed. Please log out and sign in again.", "authentication"],
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
		] as const) {
			await expect(
				driver.execute({
					mouth,
					harness: "codex-cli",
					model: "provider-default",
					identityRoot: identity,
					companyRoot: company,
					prompt: `diagnostic fixture: ${diagnostic}\nprivate-token-must-not-leak`,
				}),
			).rejects.toThrow(new RegExp(`^Provider harness exited with 7 \\(${category} unavailable\\)$`));
		}
		expect((await readdir(identity)).some((name) => name.startsWith(".qorpera-last-message-"))).toBe(false);
	});

	it("wires the existing Claude driver to the same mouth without exposing ordinary output", async () => {
		const identity = await temporaryRoot("qorpera-claude-mouth-identity-");
		const company = await temporaryRoot("qorpera-claude-mouth-company-");
		const executable = join(identity, "claude-fixture.cjs");
		await writeFile(
			executable,
			[
				`#!${process.execPath}`,
				'const assert = require("node:assert/strict");',
				"const args = process.argv.slice(2);",
				'assert(args.includes("--strict-mcp-config"));',
				'assert(args.includes("--no-session-persistence"));',
				'assert(!args.includes("--safe-mode"));',
				'assert.equal(args[args.indexOf("--setting-sources") + 1], "");',
				'assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks, true);',
				'assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__qorpera__send_message");',
				'const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);',
				'assert.equal(config.mcpServers.qorpera.url, "http://127.0.0.1:1/mcp");',
				'assert(config.mcpServers.qorpera.headers.Authorization.includes("QORPERA_AGENT_SEND_TOKEN"));',
				"assert(!config.mcpServers.qorpera.headers.Authorization.includes(process.env.QORPERA_AGENT_SEND_TOKEN));",
				"process.stdin.resume();",
				'process.stdin.on("end", () => console.log(JSON.stringify({type:"result", subtype:"success", is_error:false, session_id:"claude-private-session", result:"PRIVATE_CLAUDE_OUTPUT"})));',
			].join("\n"),
			{ mode: 0o700 },
		);
		const driver = new OfficialCliNativeHarnessDriver(process.execPath, executable);
		await expect(
			driver.execute({
				harness: "claude-code",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "Use the public mouth",
				mouth,
			}),
		).resolves.toEqual({ providerSessionId: "claude-private-session" });
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
			harness: { beginLogin: vi.fn(), execute: vi.fn() },
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
			execute: vi.fn(async () => ({})),
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

	it("restores the capsule only for the native harness and returns transcript-safe output", async () => {
		const root = await temporaryRoot("qorpera-native-execution-");
		const identity = await temporaryRoot("qorpera-native-identity-");
		const company = await temporaryRoot("qorpera-native-company-");
		const input = await temporaryRoot("qorpera-native-input-");
		const capsules = new MemoryCapsules();
		const capsuleId = "10000000-0000-4000-8000-000000000006";
		const reference = `native-capsule/${capsuleId}`;
		await mkdir(join(identity, "codex"), { recursive: true });
		await writeFile(join(identity, "codex", "auth.json"), '{"access_token":"private"}\n');
		await capsules.put(reference, await sealNativeCredentialCapsule(identity, masterKey, capsuleId));
		const parentId = "10000000-0000-4000-8000-000000000009";
		await writeFile(join(input, "execution.json"), JSON.stringify(chatContext));
		await writeFile(join(input, "inputs.jsonl"), '{"body":{"text":"hello"}}\n');
		await writeFile(join(input, "transcript.jsonl"), `${JSON.stringify({ id: parentId, type: "message" })}\n`);
		const execute = vi.fn<NativeHarnessDriver["execute"]>(async ({ identityRoot, prompt, mouth }) => {
			expect(await readFile(join(identityRoot, "codex", "auth.json"), "utf-8")).toContain("private");
			expect(prompt).toContain("canonical-transcript");
			expect(prompt).toContain("digital company");
			expect(prompt).toContain("send_message");
			await sendFinal(mouth);
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"access_token":"refreshed-private"}\n');
			await mkdir(join(identityRoot, "codex", "sessions"), { recursive: true });
			await writeFile(join(identityRoot, "codex", "sessions", "transient.jsonl"), "runtime-only\n");
			return { providerSessionId: "session-1" };
		});
		const validateExecution = vi.fn();
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(),
				completeLogin: vi.fn(),
				validateExecution,
				sendMessage: vi.fn(sendReceipt),
			},
			capsules,
			harness: { beginLogin: vi.fn(), execute },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		const executionRequest: NativeProviderExecutionRequest = {
			authority: {
				leaseId: "10000000-0000-4000-8000-000000000007",
				runId: "10000000-0000-4000-8000-000000000008",
				credentialCapsuleId: capsuleId,
				encryptedCapsuleReference: reference,
				attestationPolicySha256: "b".repeat(64),
				computeIdentityId,
				runnerId,
				assignmentId,
				provider: "openai",
				nativeHarness: "codex-cli",
				model: "gpt-test",
				expiresAt,
			},
			job: {
				jobId: "10000000-0000-4000-8000-000000000010",
				jobType: "agent_turn",
				requiredCapability: "agent_turn",
				attemptCount: 1,
				payload: {},
			},
			input: {
				companyRoot: company,
				executionContextPath: join(input, "execution.json"),
				queuedInputsPath: join(input, "inputs.jsonl"),
				transcriptPath: join(input, "transcript.jsonl"),
			},
			outputRoot: join(root, "output"),
		};
		await expect(
			host.execute({
				...executionRequest,
				authority: { ...executionRequest.authority, computeIdentityId: otherComputeIdentityId },
			}),
		).rejects.toThrow("another Compute Identity");
		const result = await host.execute(executionRequest);
		expect(result).toMatchObject({
			schema: "qorpera.native-harness-result/v2",
			run_id: executionRequest.authority.runId,
			message_count: 1,
			final_message_id: connectionId,
			provider_session_id: "session-1",
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(validateExecution).toHaveBeenCalledTimes(2);
		const refreshedIdentity = await temporaryRoot("qorpera-native-refreshed-identity-");
		await openNativeCredentialCapsule(await capsules.get(reference), refreshedIdentity, masterKey, capsuleId);
		expect(await readFile(join(refreshedIdentity, "codex", "auth.json"), "utf-8")).toContain("refreshed-private");
		await expect(lstat(join(refreshedIdentity, "codex", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });

		validateExecution.mockReset();
		validateExecution.mockResolvedValueOnce(undefined);
		validateExecution.mockRejectedValueOnce(new Error("private revoked authority"));
		await expect(host.execute(executionRequest)).rejects.toThrow(
			"Native provider execution completion-authority-validation stage failed",
		);

		// The stored login is the original again, so this run's renewal is a change to save.
		await capsules.put(reference, await sealNativeCredentialCapsule(identity, masterKey, capsuleId));
		const uploadFailureHost = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(),
				completeLogin: vi.fn(),
				validateExecution: vi.fn(),
				sendMessage: vi.fn(sendReceipt),
			},
			capsules: {
				get: async (capsuleReference) => capsules.get(capsuleReference),
				put: async () => {
					throw new Error("private storage response");
				},
			},
			harness: { beginLogin: vi.fn(), execute },
			masterKey,
			computeIdentityId,
			temporaryRoot: root,
		});
		await expect(uploadFailureHost.execute(executionRequest)).rejects.toThrow(
			"Native provider execution credential-upload stage failed",
		);
		execute.mockResolvedValueOnce({ providerSessionId: "private-turn-without-send" });
		await expect(host.execute(executionRequest)).rejects.toThrow(
			"Native provider execution public-mouth-completion stage failed",
		);
		await writeFile(
			join(input, "execution.json"),
			JSON.stringify({
				...chatContext,
				run: { ...chatContext.run, sessionId: undefined },
			}),
		);
		execute.mockImplementationOnce(async ({ prompt }) => {
			expect(prompt).toContain("This job has no conversation recipient");
			return { providerSessionId: "silent-job" };
		});
		await expect(host.execute(executionRequest)).resolves.toMatchObject({
			message_count: 0,
			final_message_id: null,
			provider_session_id: "silent-job",
		});
	});

	it.each(["provider_failed", "missing_final", "revoked", "cancelled"] as const)(
		"preserves rotated credentials after %s only while the execution remains authorized",
		async (outcome) => {
			const root = await temporaryRoot("qorpera-native-failure-");
			const identity = await temporaryRoot("qorpera-native-failure-identity-");
			const company = await temporaryRoot("qorpera-native-failure-company-");
			const input = await temporaryRoot("qorpera-native-failure-input-");
			const capsules = new MemoryCapsules();
			const capsuleId = "10000000-0000-4000-8000-000000000006";
			const reference = `native-capsule/${capsuleId}`;
			await mkdir(join(identity, "codex"));
			await writeFile(join(identity, "codex", "auth.json"), '{"refresh_token":"original-private"}\n');
			await capsules.put(reference, await sealNativeCredentialCapsule(identity, masterKey, capsuleId));
			const put = vi.spyOn(capsules, "put");
			await writeFile(join(input, "execution.json"), JSON.stringify(chatContext));
			await writeFile(join(input, "inputs.jsonl"), '{"body":{"text":"hello"}}\n');
			await writeFile(join(input, "transcript.jsonl"), "");
			const controller = new AbortController();
			let authorized = true;
			const validateExecution = vi.fn(async () => {
				if (!authorized) throw new Error("revoked-private");
			});
			const sendMessage = vi.fn(sendReceipt);
			const host = new NativeProviderHost({
				controlPlane: { describeLogin: vi.fn(), completeLogin: vi.fn(), validateExecution, sendMessage },
				capsules,
				harness: {
					beginLogin: vi.fn(),
					execute: vi.fn(async ({ identityRoot }) => {
						await writeFile(join(identityRoot, "codex", "auth.json"), '{"refresh_token":"rotated-private"}\n');
						await mkdir(join(identityRoot, "codex", "sessions"));
						await writeFile(join(identityRoot, "codex", "sessions", "private.jsonl"), "PRIVATE_REASONING\n");
						if (outcome === "revoked") authorized = false;
						if (outcome === "cancelled") {
							controller.abort(new Error("Native execution cancelled"));
							controller.signal.throwIfAborted();
						}
						if (outcome === "missing_final") return {};
						throw new Error("Provider harness exited with 1 (provider network unavailable)");
					}),
				},
				masterKey,
				computeIdentityId,
				temporaryRoot: root,
			});
			const request: NativeProviderExecutionRequest = {
				authority: {
					leaseId: "10000000-0000-4000-8000-000000000007",
					runId: chatContext.run.runId,
					credentialCapsuleId: capsuleId,
					encryptedCapsuleReference: reference,
					attestationPolicySha256: "b".repeat(64),
					computeIdentityId,
					runnerId,
					assignmentId,
					provider: "openai",
					nativeHarness: "codex-cli",
					model: "provider-default",
					expiresAt,
				},
				job: {
					jobId: chatContext.run.jobId,
					jobType: "agent_turn",
					requiredCapability: "agent_turn",
					attemptCount: 1,
					payload: {},
				},
				input: {
					companyRoot: company,
					executionContextPath: join(input, "execution.json"),
					queuedInputsPath: join(input, "inputs.jsonl"),
					transcriptPath: join(input, "transcript.jsonl"),
				},
				outputRoot: join(root, "output"),
			};
			await expect(host.execute(request, controller.signal)).rejects.toThrow(
				outcome === "missing_final"
					? "Native provider execution public-mouth-completion stage failed"
					: outcome === "cancelled"
						? "Native provider execution harness-execution stage failed (cancelled) [mouth=uninitialized]"
						: "Provider harness exited with 1 (provider network unavailable) [mouth=uninitialized]",
			);
			const shouldRefresh = outcome === "provider_failed" || outcome === "missing_final";
			expect(put).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
			expect(validateExecution).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 2);
			expect(sendMessage).not.toHaveBeenCalled();
			const restored = await temporaryRoot("qorpera-native-failure-restored-");
			await openNativeCredentialCapsule(await capsules.get(reference), restored, masterKey, capsuleId);
			expect(JSON.parse(await readFile(join(restored, "codex", "auth.json"), "utf-8"))).toEqual({
				refresh_token: shouldRefresh ? "rotated-private" : "original-private",
			});
			await expect(lstat(join(restored, "codex", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readdir(root)).toEqual([]);
		},
	);

	it("runs login and execution through the standalone cloud bridge and fences revoked authority", async () => {
		const root = await temporaryRoot("qorpera-native-service-");
		const company = await temporaryRoot("qorpera-native-service-company-");
		const input = await temporaryRoot("qorpera-native-service-input-");
		const capsules = new MemoryCapsules();
		const completed: CompleteNativeProviderLoginInput[] = [];
		let finishLogin: (() => void) | undefined;
		let authorized = true;
		await writeFile(join(input, "execution.json"), JSON.stringify(chatContext));
		await writeFile(join(input, "inputs.jsonl"), '{"body":{"text":"hello"}}\n');
		await writeFile(join(input, "transcript.jsonl"), "");
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
			execute: vi.fn(async ({ identityRoot, companyRoot, mouth }) => {
				expect(await readFile(join(identityRoot, "codex", "auth.json"), "utf-8")).toContain("private");
				await mkdir(join(companyRoot, "step2-acceptance"), { recursive: true });
				await writeFile(join(companyRoot, "step2-acceptance", "PROBE.md"), "probe\n");
				await chmod(join(companyRoot, "step2-acceptance"), 0o700);
				await chmod(join(companyRoot, "step2-acceptance", "PROBE.md"), 0o600);
				await sendFinal(mouth);
				return { providerSessionId: "native-session-1" };
			}),
		};
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
				runId: "10000000-0000-4000-8000-000000000008",
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
			const request = {
				job: {
					jobId: "10000000-0000-4000-8000-000000000010",
					jobType: "agent_turn" as const,
					requiredCapability: "agent_turn" as const,
					attemptCount: 1,
					payload: {},
				},
				substrate: {
					versionId: "10000000-0000-4000-8000-000000000015",
					contentSha256: "b".repeat(64),
					operationSequence: 0,
					operationCount: 0,
					artifactCount: 0,
				},
				input: {
					companyBaseRoot: company,
					companyRoot: company,
					executionContextPath: join(input, "execution.json"),
					queuedInputsPath: join(input, "inputs.jsonl"),
					transcriptPath: join(input, "transcript.jsonl"),
					substrateManifestPath: join(input, "substrate.json"),
					operationsPath: join(input, "operations.jsonl"),
					artifactsRoot: input,
					attachmentsRoot: input,
				},
				outputRoot: root,
				environment: {},
				limits: {
					wallTimeMs: 60_000,
					memoryBytes: 1024 * 1024 * 1024,
					cpuCount: 1,
					maxPids: 128,
					maxInputBytes: 1024 * 1024 * 1024,
					maxOutputBytes: 1024 * 1024,
					maxResultBytes: 32 * 1024,
				},
			};
			const process = await bridge.start(nativeAuthority, request);
			await expect(process.result).resolves.toMatchObject({
				schema: "qorpera.native-harness-result/v2",
				provider_session_id: "native-session-1",
			});
			expect((await lstat(join(company, "step2-acceptance"))).mode & 0o050).toBe(0o050);
			expect((await lstat(join(company, "step2-acceptance", "PROBE.md"))).mode & 0o040).toBe(0o040);
			authorized = false;
			const revoked = await bridge.start({ ...nativeAuthority, leaseId: loginId }, request);
			await expect(revoked.result).rejects.toThrow("Native provider bridge request failed (422)");
			expect(harness.execute).toHaveBeenCalledTimes(1);

			authorized = true;
			const privateDiagnostic = "opaque private-token-must-not-leak";
			vi.mocked(harness.execute).mockRejectedValueOnce(
				Object.assign(new Error(privateDiagnostic), { code: "EACCES" }),
			);
			const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				const rejected = await bridge.start({ ...nativeAuthority, leaseId: otherComputeIdentityId }, request);
				await expect(rejected.result).rejects.toThrow(
					/^Native provider bridge request failed \(422\) \[code=NATIVE_HARNESS_EXECUTION:FILESYSTEM_PERMISSION\]$/,
				);
				expect(logged).toHaveBeenCalledWith(
					"Native provider request rejected: Native provider execution harness-execution stage failed (filesystem-permission) [mouth=uninitialized] [code=NATIVE_HARNESS_EXECUTION:FILESYSTEM_PERMISSION]",
				);
				expect(logged.mock.calls.flat().join("\n")).not.toContain(privateDiagnostic);
			} finally {
				logged.mockRestore();
			}
			vi.mocked(harness.execute).mockImplementationOnce(async ({ mouth }) => {
				await fetch(mouth.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						authorization: `Bearer ${mouth.bearerToken}`,
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				});
				throw new Error("Provider harness exited with 1 (provider authorization unavailable)");
			});
			const startupLogged = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				const rejected = await bridge.start({ ...nativeAuthority, leaseId: otherComputeIdentityId }, request);
				await expect(rejected.result).rejects.toThrow(
					/^Native provider bridge request failed \(422\) \[code=HARNESS_EXITED:PROVIDER_AUTHORIZATION\]$/,
				);
				expect(startupLogged).toHaveBeenCalledWith(
					"Native provider request rejected: Provider harness exited with 1 (provider authorization unavailable) [mouth=ready] [code=HARNESS_EXITED:PROVIDER_AUTHORIZATION]",
				);
			} finally {
				startupLogged.mockRestore();
			}

			// A run has no deadline: the host answers the execution's headers at once (and keeps
			// the body alive), so an HTTP client's five-minute header timeout never applies.
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.mocked(harness.execute).mockImplementationOnce(async ({ mouth }) => {
				await gate;
				await sendFinal(mouth);
				return { providerSessionId: "native-session-long" };
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
			const long = await timed.start(nativeAuthority, request);
			await vi.waitFor(() => expect(headersAt).toBeGreaterThan(0));
			const releasedAt = Date.now();
			release();
			await expect(long.result).resolves.toMatchObject({ provider_session_id: "native-session-long" });
			expect(headersAt).toBeLessThanOrEqual(releasedAt);

			// A failure after those early headers still reaches the bridge as a refusal, never a result.
			let fail: () => void = () => undefined;
			const failGate = new Promise<void>((resolve) => {
				fail = resolve;
			});
			vi.mocked(harness.execute).mockImplementationOnce(async () => {
				await failGate;
				throw new Error("harness stopped");
			});
			headersAt = 0;
			const failing = await timed.start(nativeAuthority, request);
			await vi.waitFor(() => expect(headersAt).toBeGreaterThan(0));
			fail();
			await expect(failing.result).rejects.toThrow("Native provider bridge request failed (422)");
		} finally {
			await service.close();
		}
	});
});
