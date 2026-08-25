import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "../src/orchestrator.ts";
import { type CloudRunnerProviderServiceBackend, HttpCloudRunnerProviderService } from "../src/provider-service.ts";

const token = "provider-service-token";
const runnerId = "55555555-5555-4555-8555-555555555555";
const work: CloudRunnerWork = {
	runId: "33333333-3333-4333-8333-333333333333",
	jobId: "44444444-4444-4444-8444-444444444444",
	profileId: "88888888-8888-4888-8888-888888888888",
	environmentId: "99999999-9999-4999-8999-999999999999",
	sourceKind: "session_turn",
	sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	sessionId: "abababab-abab-4bab-8bab-abababababab",
	substrateVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	companySnapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
	staffVersion: 4,
	inputIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
	transcriptStartSequence: 12,
	deadlineAt: "2026-08-21T18:00:00.000Z",
	requiredCapability: "agent_turn",
	jobType: "agent_turn",
	payload: { input_ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"] },
	publicationMode: "automatic",
	reviewerStaffIds: [],
	computeIdentityId: "13131313-1313-4313-8313-131313131313",
	computeIdentityOwnershipKind: "member",
	computeIdentityOwnerUserId: "14141414-1414-4414-8414-141414141414",
	computeTemplateKey: "qorpera-member-linux",
	computeTemplateVersion: "v1",
	computePolicySha256: "f".repeat(64),
	workerClass: "managed_sandbox",
	requestedByUserId: "14141414-1414-4414-8414-141414141414",
	sponsoredByUserId: "14141414-1414-4414-8414-141414141414",
	sponsor: {
		bindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		version: 2,
		kind: "member_connection",
		providerConnectionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
		providerConnectionVersion: 1,
		provider: "openai",
		authenticationMode: "native_subscription",
		nativeHarness: "codex-cli",
		allowAutonomous: false,
	},
	modelPolicy: {
		provider: "openai",
		model: "gpt-test",
		maxCalls: 32,
		maxInputTokens: 2_000_000,
		maxOutputTokens: 500_000,
		maxCostMicrousd: 100_000,
	},
	attempt: 1,
};
const runner: CloudRunnerInstance = {
	runnerId,
	computeIdentityId: work.computeIdentityId,
	workerClass: "managed_sandbox",
	providerAdapter: "managed",
	capabilities: ["agent_turn", "company_substrate"],
	templateKey: "qorpera-member-linux",
	templateVersion: "v1",
	policySha256: "f".repeat(64),
};

const services: HttpCloudRunnerProviderService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

function backend(): CloudRunnerProviderServiceBackend & {
	acquire: ReturnType<typeof vi.fn>;
	deliver: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
} {
	return {
		adapterId: "managed",
		reconcile: vi.fn(async () => undefined),
		acquire: vi.fn(async () => runner),
		deliver: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
}

describe("runner provider HTTP service", () => {
	it("provisions and delivers exact immutable work over an authenticated boundary", async () => {
		const provider = backend();
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		const port = await service.start();
		const endpoint = `http://127.0.0.1:${port}/v1/qorpera-runner-provider`;
		const acquire = await fetch(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.runner-provider/v1",
				action: "acquire",
				adapter_id: "managed",
				acquisition_id: work.runId,
				work,
			}),
		});
		expect(acquire.status).toBe(200);
		await expect(acquire.json()).resolves.toEqual({
			value: {
				runner_id: runnerId,
				logical_computer_id: null,
				compute_identity_id: work.computeIdentityId,
				worker_class: "managed_sandbox",
				provider_adapter: "managed",
				capabilities: ["agent_turn", "company_substrate"],
				template_key: "qorpera-member-linux",
				template_version: "v1",
				policy_sha256: "f".repeat(64),
			},
		});
		expect(provider.acquire).toHaveBeenCalledWith(work.runId, work, expect.any(AbortSignal));

		const delivery: CloudRunnerAssignmentDelivery = {
			assignment: {
				assignmentId: "77777777-7777-4777-8777-777777777777",
				claimId: "22222222-2222-4222-8222-222222222222",
				runId: work.runId,
				jobId: work.jobId,
				runnerId,
				capabilitySha256: "b".repeat(64),
				expiresAt: "2026-08-21T18:00:00.000Z",
			},
			capability: "a".repeat(43),
			work,
		};
		const delivered = await fetch(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.runner-provider/v1",
				action: "deliver",
				adapter_id: "managed",
				runner,
				delivery,
			}),
		});
		expect(delivered.status).toBe(200);
		expect(provider.deliver).toHaveBeenCalledWith(runner, delivery, expect.any(AbortSignal));
		await service.close();
		expect(provider.close).toHaveBeenCalledOnce();
	});

	it("rejects an unauthenticated or mismatched acquisition", async () => {
		const provider = backend();
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		const port = await service.start();
		const endpoint = `http://127.0.0.1:${port}/v1/qorpera-runner-provider`;
		expect(
			(
				await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(endpoint, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({
						schema: "qorpera.runner-provider/v1",
						action: "acquire",
						adapter_id: "managed",
						acquisition_id: "99999999-9999-4999-8999-999999999999",
						work,
					}),
				})
			).status,
		).toBe(422);
		expect(provider.acquire).not.toHaveBeenCalled();
	});

	it("rejects every endpoint outside the configured management VM source", async () => {
		const provider = backend();
		const denied = new HttpCloudRunnerProviderService(provider, token, "127.0.0.1", 0, {
			trustedSource: "192.0.2.10",
		});
		services.push(denied);
		const deniedPort = await denied.start();
		expect((await fetch(`http://127.0.0.1:${deniedPort}/healthz`)).status).toBe(403);
		expect(provider.acquire).not.toHaveBeenCalled();

		const allowed = new HttpCloudRunnerProviderService(provider, token, "127.0.0.1", 0, {
			trustedSource: "127.0.0.1",
		});
		services.push(allowed);
		const allowedPort = await allowed.start();
		await expect(
			fetch(`http://127.0.0.1:${allowedPort}/healthz`).then((response) => response.json()),
		).resolves.toEqual({
			ok: true,
		});
	});

	it("rejects an invalid source fence or empty TLS material", () => {
		const provider = backend();
		expect(
			() => new HttpCloudRunnerProviderService(provider, token, "127.0.0.1", 0, { trustedSource: "localhost" }),
		).toThrow("trusted source");
		expect(
			() =>
				new HttpCloudRunnerProviderService(provider, token, "127.0.0.1", 0, {
					tls: { certificate: Buffer.alloc(0), privateKey: Buffer.from("key") },
				}),
		).toThrow("TLS material");
	});
});
