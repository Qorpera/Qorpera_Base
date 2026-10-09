import { HttpNativeProviderComputerBridge, parseNativeHarnessResult } from "@qorpera/runtime/cloud-native-provider";
import type { CloudRunnerNativeAuthority } from "@qorpera/runtime/cloud-runner-broker";
import { describe, expect, it, vi } from "vitest";

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

const companyJob = { jobId: "10000000-0000-4000-8000-000000000008", attemptCount: 1 };

describe("native provider computer bridge", () => {
	it("passes only opaque capsule authority to the trusted native boundary", async () => {
		const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			// The company execution names the job and its authority only: no Company File, path or credential.
			expect(Object.keys(body).sort()).toEqual(["authority", "job", "schema"]);
			expect(body.schema).toBe("qorpera.native-company-execution/v1");
			expect(body.job).toEqual({ job_id: companyJob.jobId, attempt_count: 1 });
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
					schema: "qorpera.native-harness-result/v2",
					run_id: authority.runId,
					message_count: 1,
					final_message_id: "10000000-0000-4000-8000-000000000010",
					provider_session_id: "codex-session-1",
				},
			});
		});
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"c".repeat(43),
			fetchImplementation,
			{ executionBoundary: "virtual_machine" },
		);
		const process = await bridge.startCompany(authority, companyJob);
		await expect(process.result).resolves.toMatchObject({
			schema: "qorpera.native-harness-result/v2",
			provider_session_id: "codex-session-1",
		});
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
	});

	it("rejects private model output and legacy text results at the completion boundary", () => {
		const receipt = {
			schema: "qorpera.native-harness-result/v2",
			run_id: authority.runId,
			message_count: 1,
			final_message_id: authority.assignmentId,
			provider_session_id: null,
		};
		expect(parseNativeHarnessResult(receipt, authority.runId)).toEqual(receipt);
		const silent = { ...receipt, message_count: 0, final_message_id: null };
		expect(parseNativeHarnessResult(silent, authority.runId, false)).toEqual(silent);
		expect(() => parseNativeHarnessResult(silent, authority.runId)).toThrow("private completion receipt");
		for (const invalid of [
			{ ...receipt, assistant_entry: { message: { content: [{ type: "thinking", thinking: "private" }] } } },
			{ ...receipt, text: "private final text" },
			{ ...receipt, message_count: 0 },
			{ ...receipt, final_message_id: null },
			{ ...receipt, run_id: authority.assignmentId },
			{ schema: "qorpera.native-harness-result/v1", assistant_entry: { text: "legacy public fallback" } },
		])
			expect(() => parseNativeHarnessResult(invalid, authority.runId)).toThrow("private completion receipt");
	});

	it("rejects non-native and malformed company work before contacting the bridge", async () => {
		const fetchImplementation = vi.fn<typeof fetch>();
		const bridge = new HttpNativeProviderComputerBridge(
			"http://127.0.0.1:9898/",
			"d".repeat(43),
			fetchImplementation,
		);
		await expect(
			bridge.startCompany({ ...authority, authenticationMode: "api_key" as "native_subscription" }, companyJob),
		).rejects.toThrow("unsupported company runtime");
		await expect(bridge.startCompany(authority, { ...companyJob, jobId: "not-a-job" })).rejects.toThrow(
			"unsupported company runtime",
		);
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("rejects non-HTTP loopback bridge URLs", () => {
		expect(() => new HttpNativeProviderComputerBridge("file://localhost/private", "d".repeat(43))).toThrow(
			"loopback transport",
		);
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
		const process = await bridge.startCompany(authority, companyJob);
		await expect(process.result).rejects.toThrow("credential boundary");
	});

	it("rejects a generic token field returned across the execution bridge", async () => {
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"i".repeat(43),
			async () =>
				Response.json({
					schema: "qorpera.native-provider-result/v1",
					lease_id: authority.leaseId,
					result: { schema: "qorpera.native-harness-result/v1", provider_state: { token: "no" } },
				}),
		);
		const process = await bridge.startCompany(authority, companyJob);
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
				expiresAt: "2099-08-21T12:15:00.000Z",
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
				expiresAt: "2099-08-21T12:15:00.000Z",
			}),
		).rejects.toThrow("credential boundary");
	});

	it("rejects expired login capabilities before contacting the bridge", async () => {
		const fetchImplementation = vi.fn<typeof fetch>();
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native-runner.example.test/",
			"g".repeat(43),
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
				provider: "openai",
				nativeHarness: "codex-cli",
				capability: "h".repeat(43),
				expiresAt: "2000-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow("authority is invalid");
		expect(fetchImplementation).not.toHaveBeenCalled();
	});
});
