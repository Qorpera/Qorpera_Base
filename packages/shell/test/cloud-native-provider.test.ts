import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { describe, expect, it, vi } from "vitest";
import { captureCloudCompanyTree } from "../src/cloud-company-snapshot.ts";
import type { ResolvedCompanySubstrateReference } from "../src/cloud-company-substrate.ts";
import {
	executeNativeCloudRunnerJob,
	HttpNativeProviderComputerBridge,
	type NativeProviderComputerBridge,
	nativeProviderExecutionGuarantees,
} from "../src/cloud-native-provider.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type { CloudRunnerNativeAuthority } from "../src/cloud-runner-broker.ts";
import type { CloudRunnerJob } from "../src/cloud-runner-control.ts";
import type {
	CloudRunnerSandboxProcess,
	CloudRunnerSandboxRequest,
	CloudRunnerSubstrateResolver,
	ResolvedCloudRunnerExecutionContext,
} from "../src/cloud-runner-sandbox.ts";
import type { HostedArtifactIndex, HostedCompanySubstrateVersion } from "../src/hosted-primary.ts";

const authority: CloudRunnerNativeAuthority = {
	leaseId: "10000000-0000-4000-8000-000000000001",
	runId: "10000000-0000-4000-8000-000000000002",
	providerConnectionId: "10000000-0000-4000-8000-000000000003",
	providerConnectionVersion: 1,
	credentialCapsuleId: "10000000-0000-4000-8000-000000000004",
	encryptedCapsuleReference: "object://native-capsules/10000000-0000-4000-8000-000000000004",
	attestationPolicySha256: "a".repeat(64),
	computeIdentityId: "10000000-0000-4000-8000-000000000005",
	computeIdentityOwnershipKind: "member",
	computeIdentityOwnerUserId: "10000000-0000-4000-8000-000000000013",
	credentialOwnershipKind: "member",
	credentialOwnerUserId: "10000000-0000-4000-8000-000000000013",
	provider: "openai",
	authenticationMode: "native_subscription",
	nativeHarness: "codex-cli",
	model: "gpt-test",
	runnerId: "10000000-0000-4000-8000-000000000006",
	assignmentId: "10000000-0000-4000-8000-000000000007",
	expiresAt: "2026-08-21T12:05:00.000Z",
};

const request: CloudRunnerSandboxRequest = {
	job: {
		jobId: "10000000-0000-4000-8000-000000000008",
		jobType: "agent_turn",
		requiredCapability: "agent_turn",
		attemptCount: 1,
		payload: { schema: "qorpera.agent-turn/v1" },
	},
	substrate: {
		versionId: "10000000-0000-4000-8000-000000000009",
		contentSha256: "b".repeat(64),
		operationSequence: 1,
		operationCount: 1,
		artifactCount: 0,
	},
	input: {
		companyBaseRoot: "/work/input/company",
		companyRoot: "/work/company",
		executionContextPath: "/work/input/execution.json",
		queuedInputsPath: "/work/input/inputs.jsonl",
		transcriptPath: "/work/input/transcript.jsonl",
		substrateManifestPath: "/work/input/substrate.json",
		operationsPath: "/work/input/operations.jsonl",
		artifactsRoot: "/work/input/artifacts",
		attachmentsRoot: "/work/input/attachments",
	},
	outputRoot: "/work/output",
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

class MemoryObjectTransport implements CloudObjectTransport {
	readonly values = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		if (this.values.has(path)) return "exists";
		this.values.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const value = this.values.get(path);
		if (!value) throw new Error("missing native execution object");
		return Uint8Array.from(value);
	}
}

describe("native provider computer bridge", () => {
	it("materializes the canonical run through the native harness and synchronizes its provider result", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "qorpera-native-run-test-"));
		try {
			const companyRoot = join(temporaryRoot, "company");
			scaffoldCompany(companyRoot);
			await writeFile(join(companyRoot, "company.md"), "# Native company\n", "utf-8");
			const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
			const tree = await captureCloudCompanyTree(companyRoot, request.job.jobId, objects);
			const createdAt = "2026-08-21T12:00:00.000Z";
			const snapshot = {
				snapshotId: request.substrate.versionId,
				profileId: request.job.jobId,
				environmentId: authority.runId,
				workspaceId: authority.assignmentId,
				clientSnapshotId: authority.runnerId,
				tree,
				createdByUserId: authority.computeIdentityOwnerUserId as string,
				createdAt,
			};
			const version: HostedCompanySubstrateVersion = {
				versionId: request.substrate.versionId,
				profileId: request.job.jobId,
				environmentId: authority.runId,
				companySnapshotId: snapshot.snapshotId,
				clientVersionId: "10000000-0000-4000-8000-000000000014",
				contractVersion: 1,
				operationSequence: 0,
				operationCount: 0,
				contentSha256: request.substrate.contentSha256,
				createdByUserId: authority.computeIdentityOwnerUserId as string,
				createdAt,
			};
			const execution: ResolvedCloudRunnerExecutionContext = {
				run: {
					runId: authority.runId,
					profileId: version.profileId,
					environmentId: version.environmentId,
					sourceKind: "session_turn",
					sourceId: authority.runId,
					sessionId: "10000000-0000-4000-8000-000000000015",
					jobId: request.job.jobId,
					substrateVersionId: version.versionId,
					companySnapshotId: snapshot.snapshotId,
					staffAgentId: "10000000-0000-4000-8000-000000000016",
					staffVersion: 1,
					inputIds: ["10000000-0000-4000-8000-000000000017"],
					sponsorBindingId: "10000000-0000-4000-8000-000000000018",
					sponsorVersion: 1,
					requiredCapability: "agent_turn",
					jobType: "agent_turn",
					payloadSha256: "c".repeat(64),
					publicationMode: "automatic",
					reviewerStaffIds: [],
					computeIdentityId: authority.computeIdentityId,
					computeIdentityOwnershipKind: "member",
					computeIdentityOwnerUserId: authority.computeIdentityOwnerUserId,
					workerClass: "managed_sandbox",
					transcriptStartSequence: 0,
					status: "runner_started",
					createdByUserId: authority.computeIdentityOwnerUserId as string,
					requestedByUserId: authority.computeIdentityOwnerUserId,
					sponsoredByUserId: authority.computeIdentityOwnerUserId,
					createdAt,
				},
				sponsor: {
					bindingId: "10000000-0000-4000-8000-000000000018",
					version: 1,
					kind: "member_connection",
					providerConnectionId: authority.providerConnectionId,
					providerConnectionVersion: authority.providerConnectionVersion,
					provider: authority.provider,
					authenticationMode: "native_subscription",
					nativeHarness: authority.nativeHarness,
					allowAutonomous: false,
				},
			};
			const substrate: CloudRunnerSubstrateResolver = {
				resolveExecution: async () => execution,
				listInputs: async () => [
					{
						inputId: execution.run.inputIds[0] as string,
						position: 1,
						kind: "user_message",
						authorUserId: authority.computeIdentityOwnerUserId as string,
						authorDisplayName: "Native member",
						body: { schema: "qorpera.session-prompt/v1", text: "Use my subscription", images: [] },
						createdAt,
					},
				],
				listTranscript: async () => [],
				resolve: async (): Promise<ResolvedCompanySubstrateReference> => ({ version, snapshot }),
				listOperations: async (_version: HostedCompanySubstrateVersion) => [],
				listArtifacts: async (_index: HostedArtifactIndex) => [],
			};
			const job: CloudRunnerJob = {
				jobId: request.job.jobId,
				runId: authority.runId,
				profileId: version.profileId,
				environmentId: version.environmentId,
				sessionId: execution.run.sessionId,
				substrateVersionId: version.versionId,
				clientJobId: "10000000-0000-4000-8000-000000000019",
				assignmentId: authority.assignmentId,
				requiredCapability: "agent_turn",
				jobType: "agent_turn",
				payload: { schema: "qorpera.agent-turn/v1" },
				status: "leased",
				attemptCount: 1,
				runnerId: authority.runnerId,
				outputArtifactCount: 0,
				createdByUserId: authority.computeIdentityOwnerUserId as string,
				createdAt,
				startedAt: createdAt,
				leaseExpiresAt: "2099-08-21T12:05:00.000Z",
			};
			const bridge: NativeProviderComputerBridge = {
				executionGuarantees: nativeProviderExecutionGuarantees("virtual_machine"),
				start: vi.fn(async (receivedAuthority, receivedRequest): Promise<CloudRunnerSandboxProcess> => {
					expect(receivedAuthority).toEqual(authority);
					expect(receivedRequest.hostBroker).toBeUndefined();
					return {
						result: Promise.resolve({
							schema: "qorpera.native-harness-result/v1",
							assistant_entry: {
								type: "message",
								id: "10000000-0000-4000-8000-000000000020",
								parentId: null,
								timestamp: createdAt,
								message: {
									role: "assistant",
									content: [{ type: "text", text: "Native subscription response" }],
								},
							},
							provider_session_id: "official-session-1",
						}),
						terminate: vi.fn(async () => undefined),
					};
				}),
			};
			const appendTranscriptEvent = vi.fn(async () => ({}));
			const bindProviderSession = vi.fn(async () => ({}));
			const completed = await executeNativeCloudRunnerJob({
				job,
				substrate,
				objects,
				authority,
				bridge,
				nativeBroker: { appendTranscriptEvent, bindProviderSession },
				temporaryRoot,
			});
			expect(completed.result).toMatchObject({
				backend: "native-provider-computer",
				backend_result: { provider_session_id: "official-session-1" },
			});
			expect(appendTranscriptEvent).toHaveBeenCalledWith({
				eventId: "10000000-0000-4000-8000-000000000020",
				eventType: "message",
				entry: expect.objectContaining({
					message: { role: "assistant", content: [{ type: "text", text: "Native subscription response" }] },
				}),
			});
			expect(bindProviderSession).toHaveBeenCalledWith({ providerSessionId: "official-session-1" });
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("passes only opaque capsule authority to the trusted native boundary", async () => {
		const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const projectedAuthority = body.authority as Record<string, unknown>;
			expect(projectedAuthority.authentication_mode).toBe("native_subscription");
			expect(projectedAuthority.native_harness).toBe("codex-cli");
			expect(projectedAuthority.encrypted_capsule_reference).toBe(authority.encryptedCapsuleReference);
			expect(projectedAuthority).toMatchObject({
				compute_identity_ownership_kind: "member",
				compute_identity_owner_user_id: authority.computeIdentityOwnerUserId,
				credential_ownership_kind: "member",
				credential_owner_user_id: authority.credentialOwnerUserId,
			});
			expect(JSON.stringify(body)).not.toContain("access_token");
			expect(JSON.stringify(body)).not.toContain("refresh_token");
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"c".repeat(43)}`);
			return Response.json({
				schema: "qorpera.native-provider-result/v1",
				lease_id: authority.leaseId,
				result: {
					schema: "qorpera.native-harness-result/v1",
					assistant_entry: {
						type: "message",
						id: "10000000-0000-4000-8000-000000000010",
						parentId: null,
						timestamp: "2026-08-21T12:00:00.000Z",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					},
					provider_session_id: "codex-session-1",
				},
			});
		});
		const bridge: NativeProviderComputerBridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"c".repeat(43),
			fetchImplementation,
			{ executionBoundary: "virtual_machine" },
		);
		const process = await bridge.start(authority, request);
		await expect(process.result).resolves.toMatchObject({
			schema: "qorpera.native-harness-result/v1",
			provider_session_id: "codex-session-1",
		});
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
	});

	it("rejects non-agent and non-native work before contacting the bridge", async () => {
		const fetchImplementation = vi.fn<typeof fetch>();
		const bridge = new HttpNativeProviderComputerBridge(
			"http://127.0.0.1:9898/",
			"d".repeat(43),
			fetchImplementation,
		);
		await expect(
			bridge.start({ ...authority, authenticationMode: "api_key" as "native_subscription" }, request),
		).rejects.toThrow("unsupported execution");
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("rejects credential material returned across the execution bridge", async () => {
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"i".repeat(43),
			async () =>
				Response.json({
					schema: "qorpera.native-provider-result/v1",
					lease_id: authority.leaseId,
					result: { schema: "qorpera.native-harness-result/v1", provider_state: { refresh_token: "no" } },
				}),
		);
		const process = await bridge.start(authority, request);
		await expect(process.result).rejects.toThrow("credential boundary");
	});

	it("starts official provider login inside the isolated cloud identity without returning OAuth material", async () => {
		const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body).toMatchObject({
				schema: "qorpera.native-provider-login/v1",
				provider: "anthropic",
				native_harness: "claude-code",
				compute_identity_id: authority.computeIdentityId,
				compute_identity_ownership_kind: "member",
				compute_identity_owner_user_id: authority.computeIdentityOwnerUserId,
			});
			expect(JSON.stringify(body)).not.toMatch(/access[_-]?token|refresh[_-]?token|oauth[_-]?token/i);
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"f".repeat(43)}`);
			return Response.json({
				schema: "qorpera.native-provider-login-result/v1",
				login_id: authority.runId,
				status: "awaiting_member",
				interaction_url: "https://native-runner.example.test/session/login",
				user_code: null,
			});
		});
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"e".repeat(43),
			fetchImplementation,
		);
		await expect(
			bridge.beginLogin({
				loginId: authority.runId,
				clientLoginId: "10000000-0000-4000-8000-000000000011",
				clientConnectionId: "10000000-0000-4000-8000-000000000012",
				computeIdentityId: authority.computeIdentityId,
				computeIdentityOwnershipKind: "member",
				computeIdentityOwnerUserId: authority.computeIdentityOwnerUserId,
				provider: "anthropic",
				nativeHarness: "claude-code",
				capability: "f".repeat(43),
				expiresAt: "2026-08-21T12:15:00.000Z",
			}),
		).resolves.toEqual({
			loginId: authority.runId,
			status: "awaiting_member",
			interactionUrl: "https://native-runner.example.test/session/login",
		});
	});

	it("rejects any undeclared login response field at the credential boundary", async () => {
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"g".repeat(43),
			async () =>
				Response.json({
					schema: "qorpera.native-provider-login-result/v1",
					login_id: authority.runId,
					status: "completed",
					interaction_url: null,
					user_code: null,
					provider_state: { access_token: "must-never-cross" },
				}),
		);
		await expect(
			bridge.beginLogin({
				loginId: authority.runId,
				clientLoginId: "10000000-0000-4000-8000-000000000011",
				clientConnectionId: "10000000-0000-4000-8000-000000000012",
				computeIdentityId: authority.computeIdentityId,
				computeIdentityOwnershipKind: "member",
				computeIdentityOwnerUserId: authority.computeIdentityOwnerUserId,
				provider: "openai",
				nativeHarness: "codex-cli",
				capability: "h".repeat(43),
				expiresAt: "2026-08-21T12:15:00.000Z",
			}),
		).rejects.toThrow("credential boundary");
	});
});
