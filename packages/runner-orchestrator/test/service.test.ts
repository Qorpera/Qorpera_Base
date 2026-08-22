import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CloudRunnerWork } from "../src/orchestrator.ts";
import { HttpCloudRunnerProviderAdapter } from "../src/provider-http.ts";
import { cloudRunnerOrchestratorServiceConfigFromEnvironment } from "../src/service.ts";

const runnerId = "55555555-5555-4555-8555-555555555555";
const logicalComputerId = "66666666-6666-4666-8666-666666666666";

function work(): CloudRunnerWork {
	return {
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
		deadlineAt: "2026-08-20T18:00:00.000Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: { input_ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"] },
		publicationMode: "automatic",
		reviewerStaffIds: [],
		logicalComputerId,
		workerClass: "managed_sandbox",
		requestedByUserId: "12121212-1212-4212-8212-121212121212",
		sponsor: {
			bindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			version: 2,
			kind: "company_api_billing",
			providerConnectionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			providerConnectionVersion: 1,
			provider: "openai",
			authenticationMode: "api_key",
			nativeHarness: "openai-responses",
			allowAutonomous: true,
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
}

describe("runner orchestrator service boundary", () => {
	it("loads a complete service configuration without desktop state", () => {
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				QORPERA_SUPABASE_URL: "https://project.supabase.co",
				QORPERA_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				QORPERA_RUNNER_ORCHESTRATOR_ID: "11111111-1111-4111-8111-111111111111",
				QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN: "c".repeat(43),
				QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE: resolve(".test/orchestrator-control.json"),
				QORPERA_RUNNER_PROVIDER_URL: "https://provider.example",
				QORPERA_RUNNER_PROVIDER_ADAPTER: "managed",
				QORPERA_RUNNER_PROVIDER_TOKEN: "provider-service-token",
				QORPERA_RUNNER_ORCHESTRATOR_POLL_MS: "2500",
			}),
		).toMatchObject({
			orchestratorId: "11111111-1111-4111-8111-111111111111",
			orchestratorControlStatePath: resolve(".test/orchestrator-control.json"),
			providerAdapterId: "managed",
			pollIntervalMs: 2500,
			dispatchConcurrency: 8,
		});
	});

	it("permits HTTP only on loopback and rejects non-HTTP loopback schemes", () => {
		const environment = {
			QORPERA_SUPABASE_URL: "file://localhost/project",
			QORPERA_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
			QORPERA_RUNNER_ORCHESTRATOR_ID: "11111111-1111-4111-8111-111111111111",
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN: "c".repeat(43),
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE: resolve(".test/orchestrator-control.json"),
			QORPERA_RUNNER_PROVIDER_URL: "https://provider.example",
			QORPERA_RUNNER_PROVIDER_ADAPTER: "managed",
			QORPERA_RUNNER_PROVIDER_TOKEN: "provider-service-token",
		};
		expect(() => cloudRunnerOrchestratorServiceConfigFromEnvironment(environment)).toThrow("must use HTTPS");
		expect(
			() => new HttpCloudRunnerProviderAdapter("file://localhost/provider", "managed", "provider-token"),
		).toThrow("must use HTTPS");
		expect(
			() => new HttpCloudRunnerProviderAdapter("http://127.0.0.1:8080", "managed", "provider-token"),
		).not.toThrow();
	});

	it("provisions and delivers through the independent provider endpoint", async () => {
		const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
		const providerToken = "provider-service-token";
		const capability = "a".repeat(43);
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			calls.push({ body, headers: new Headers(init?.headers) });
			if (body.action === "acquire") {
				return Response.json({
					value: {
						runner_id: runnerId,
						logical_computer_id: logicalComputerId,
						compute_identity_id: null,
						worker_class: "managed_sandbox",
						provider_adapter: "managed",
						capabilities: ["agent_turn"],
						template_key: "qorpera-test",
						template_version: "runner-v1",
						policy_sha256: "f".repeat(64),
					},
				});
			}
			return Response.json({ value: null });
		});
		const adapter = new HttpCloudRunnerProviderAdapter(
			"https://provider.example",
			"managed",
			providerToken,
			fakeFetch as typeof fetch,
		);
		const controller = new AbortController();
		const runner = await adapter.acquire(work(), controller.signal);
		await adapter.deliver(runner, {
			assignment: {
				assignmentId: "77777777-7777-4777-8777-777777777777",
				claimId: "22222222-2222-4222-8222-222222222222",
				runId: work().runId,
				jobId: work().jobId,
				runnerId,
				capabilitySha256: "b".repeat(64),
				expiresAt: "2026-08-20T18:00:00.000Z",
			},
			capability,
			work: work(),
		});

		expect(runner).toEqual({
			runnerId,
			logicalComputerId,
			workerClass: "managed_sandbox",
			providerAdapter: "managed",
			capabilities: ["agent_turn"],
			templateKey: "qorpera-test",
			templateVersion: "runner-v1",
			policySha256: "f".repeat(64),
		});
		expect(calls.map((call) => call.body.action)).toEqual(["acquire", "deliver"]);
		expect(calls[0]?.body.acquisition_id).toBe(work().runId);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${providerToken}`);
		expect(JSON.stringify(calls[0]?.body)).not.toContain(providerToken);
		expect(JSON.stringify(calls[1]?.body)).toContain(capability);
		expect(JSON.stringify(calls[1]?.body)).not.toContain(providerToken);
	});

	it("rejects a provider response that changes the adapter identity", async () => {
		const fakeFetch = vi.fn(async () =>
			Response.json({
				value: {
					runner_id: runnerId,
					logical_computer_id: logicalComputerId,
					provider_adapter: "other",
					capabilities: ["agent_turn"],
					template_key: "qorpera-test",
					template_version: "runner-v1",
					policy_sha256: "f".repeat(64),
				},
			}),
		);
		const adapter = new HttpCloudRunnerProviderAdapter(
			"https://provider.example",
			"managed",
			"provider-service-token",
			fakeFetch as typeof fetch,
		);

		await expect(adapter.acquire(work(), new AbortController().signal)).rejects.toThrow("invalid runner instance");
	});

	it("propagates cancellation into a hung provider request", async () => {
		const fakeFetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason ?? new Error("provider request aborted")),
						{ once: true },
					);
				}),
		);
		const adapter = new HttpCloudRunnerProviderAdapter(
			"https://provider.example",
			"managed",
			"provider-service-token",
			fakeFetch as typeof fetch,
		);
		const controller = new AbortController();
		const request = adapter.reconcile(controller.signal);
		controller.abort(new Error("service stopping"));

		await expect(request).rejects.toThrow("service stopping");
	});
});
