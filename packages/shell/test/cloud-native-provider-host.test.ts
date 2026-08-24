import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpNativeProviderComputerBridge } from "../src/cloud-native-provider.ts";
import {
	type CompleteNativeProviderLoginInput,
	type NativeCredentialCapsuleStore,
	type NativeHarnessDriver,
	type NativeProviderExecutionRequest,
	NativeProviderHost,
	type NativeProviderLoginDescription,
	OfficialCliNativeHarnessDriver,
	openNativeCredentialCapsule,
	sealNativeCredentialCapsule,
} from "../src/cloud-native-provider-host.ts";
import {
	HttpNativeProviderHostService,
	SupabaseNativeCredentialCapsuleStore,
	SupabaseNativeProviderControlPlane,
} from "../src/cloud-native-provider-service.ts";

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
				'const output = args[args.indexOf("--output-last-message") + 1];',
				'let prompt = "";',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", (chunk) => { prompt += chunk; });',
				'process.stdin.on("end", () => {',
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
				'  fs.writeFileSync(output, "official Codex response\\n");',
				'  console.log(JSON.stringify({ type: "thread.started", thread_id: "official-thread-1" }));',
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
				harness: "codex-cli",
				model: "gpt-test",
				identityRoot: identity,
				companyRoot: company,
				prompt: "canonical transcript and queued input",
			}),
		).resolves.toEqual({
			text: "official Codex response",
			providerSessionId: "official-thread-1",
		});
		expect((await readdir(identity)).some((name) => name.startsWith(".qorpera-last-message-"))).toBe(false);
		await expect(
			driver.execute({
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "canonical transcript using the provider default",
			}),
		).resolves.toEqual({
			text: "official Codex response",
			providerSessionId: "official-thread-1",
		});
		await expect(
			driver.execute({
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic authentication failure",
			}),
		).rejects.toThrow("Provider harness exited with 9 (authentication unavailable)");
		await expect(
			driver.execute({
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic opaque failure",
			}),
		).rejects.toThrow(/^Provider harness exited with 8$/);
		await expect(
			driver.execute({
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic zero-exit model failure",
			}),
		).rejects.toThrow("Codex returned no assistant response (model unavailable)");
		await expect(
			driver.execute({
				harness: "codex-cli",
				model: "provider-default",
				identityRoot: identity,
				companyRoot: company,
				prompt: "diagnostic zero-exit opaque failure",
			}),
		).rejects.toThrow(/^Codex returned no assistant response$/);
		expect((await readdir(identity)).some((name) => name.startsWith(".qorpera-last-message-"))).toBe(false);
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
		const capsules = new SupabaseNativeCredentialCapsuleStore(
			"https://project.supabase.co",
			"sb_secret_private",
			fetchImplementation,
		);
		await capsules.get(`native-capsule/${loginId}`);
		for (const call of calls) {
			expect(call.headers.get("apikey")).toBe("sb_secret_private");
			expect(call.headers.get("authorization")).toBeNull();
		}
	});

	it("rejects native requests that did not arrive from the configured infrastructure source", async () => {
		const describeLogin = vi.fn();
		const host = new NativeProviderHost({
			controlPlane: { describeLogin, completeLogin: vi.fn(), validateExecution: vi.fn() },
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

	it("runs official login inside the identity and returns only interaction metadata", async () => {
		const root = await temporaryRoot("qorpera-native-host-");
		const capsules = new MemoryCapsules();
		const completed: CompleteNativeProviderLoginInput[] = [];
		let finishLogin: (() => void) | undefined;
		const harness: NativeHarnessDriver = {
			beginLogin: vi.fn(async (_harness, identityRoot) => {
				await mkdir(join(identityRoot, "codex"), { recursive: true });
				await writeFile(join(identityRoot, "codex", "auth.json"), '{"refresh_token":"private"}\n');
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
			execute: vi.fn(async () => ({ text: "unused" })),
		};
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: vi.fn(async () => description()),
				completeLogin: vi.fn(async (input) => {
					completed.push(input);
				}),
				validateExecution: vi.fn(),
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
			providerAccountReference: "ChatGPT subscription",
		});
		const capsule = capsules.values.get(completed[0]?.encryptedCapsuleReference as string);
		expect(capsule).toBeDefined();
		expect(Buffer.from(capsule as Uint8Array).toString("utf-8")).not.toContain("refresh_token");
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
		await writeFile(join(input, "execution.json"), '{"schema":"qorpera.execution-context/v1"}\n');
		await writeFile(join(input, "inputs.jsonl"), '{"body":{"text":"hello"}}\n');
		await writeFile(join(input, "transcript.jsonl"), `${JSON.stringify({ id: parentId, type: "message" })}\n`);
		const execute = vi.fn(async ({ identityRoot, prompt }) => {
			expect(await readFile(join(identityRoot, "codex", "auth.json"), "utf-8")).toContain("private");
			expect(prompt).toContain("canonical-transcript");
			return { text: "native response", providerSessionId: "session-1" };
		});
		const validateExecution = vi.fn();
		const host = new NativeProviderHost({
			controlPlane: { describeLogin: vi.fn(), completeLogin: vi.fn(), validateExecution },
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
			schema: "qorpera.native-harness-result/v1",
			assistant_entry: {
				parentId,
				message: { role: "assistant", content: [{ type: "text", text: "native response" }] },
			},
			provider_session_id: "session-1",
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(validateExecution).toHaveBeenCalledTimes(2);

		validateExecution.mockReset();
		validateExecution.mockResolvedValueOnce(undefined);
		validateExecution.mockRejectedValueOnce(new Error("private revoked authority"));
		await expect(host.execute(executionRequest)).rejects.toThrow(
			"Native provider execution completion-authority-validation stage failed",
		);

		const uploadFailureHost = new NativeProviderHost({
			controlPlane: { describeLogin: vi.fn(), completeLogin: vi.fn(), validateExecution: vi.fn() },
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
	});

	it("runs login and execution through the standalone cloud bridge and fences revoked authority", async () => {
		const root = await temporaryRoot("qorpera-native-service-");
		const company = await temporaryRoot("qorpera-native-service-company-");
		const input = await temporaryRoot("qorpera-native-service-input-");
		const capsules = new MemoryCapsules();
		const completed: CompleteNativeProviderLoginInput[] = [];
		let finishLogin: (() => void) | undefined;
		let authorized = true;
		await writeFile(join(input, "execution.json"), '{"schema":"qorpera.execution-context/v1"}\n');
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
			execute: vi.fn(async ({ identityRoot }) => {
				expect(await readFile(join(identityRoot, "codex", "auth.json"), "utf-8")).toContain("private");
				return { text: "cloud-native response", providerSessionId: "native-session-1" };
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
				schema: "qorpera.native-harness-result/v1",
				provider_session_id: "native-session-1",
			});
			authorized = false;
			const revoked = await bridge.start({ ...nativeAuthority, leaseId: loginId }, request);
			await expect(revoked.result).rejects.toThrow("Native provider bridge request failed (422)");
			expect(harness.execute).toHaveBeenCalledTimes(1);
		} finally {
			await service.close();
		}
	});
});
