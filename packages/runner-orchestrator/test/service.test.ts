import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CloudRunnerWork, SupabaseCloudRunnerOrchestratorControlPlane } from "../src/orchestrator.ts";
import { HttpCloudRunnerProviderAdapter } from "../src/provider-http.ts";
import {
	cloudRunnerOrchestratorServiceConfigFromEnvironment,
	createDefaultSurfaceWorkerConfig,
	runCloudRunnerOrchestratorService,
} from "../src/service.ts";

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

	it("keeps push wake-ups off unless they are switched on", () => {
		const environment = {
			QORPERA_SUPABASE_URL: "https://project.supabase.co",
			QORPERA_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
			QORPERA_RUNNER_ORCHESTRATOR_ID: "11111111-1111-4111-8111-111111111111",
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN: "c".repeat(43),
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE: resolve(".test/orchestrator-control.json"),
			QORPERA_RUNNER_PROVIDER_URL: "https://provider.example",
			QORPERA_RUNNER_PROVIDER_ADAPTER: "managed",
			QORPERA_RUNNER_PROVIDER_TOKEN: "provider-service-token",
		};
		expect(cloudRunnerOrchestratorServiceConfigFromEnvironment(environment).wake).toBeUndefined();
		// With wake-ups off, their backstop is not read: a slow poll and a stray value stay accepted.
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_POLL_MS: "6000",
				QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS: "250",
			}),
		).toMatchObject({ pollIntervalMs: 6000 });
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "off",
			}).wake,
		).toBeUndefined();
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "realtime",
			}).wake,
		).toEqual({ backstopMs: 5000 });
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "realtime",
				QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS: "10000",
			}).wake,
		).toEqual({ backstopMs: 10_000 });
		expect(() =>
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "notify",
			}),
		).toThrow("must be off or realtime");
		// A backstop equal to the 250 ms poll keeps the claim cadence; wake-ups then only bring work forward.
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "realtime",
				QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS: "250",
			}).wake,
		).toEqual({ backstopMs: 250 });
		expect(() =>
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "realtime",
				QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS: "200",
			}),
		).toThrow("outside the supported range");
		expect(() =>
			cloudRunnerOrchestratorServiceConfigFromEnvironment({
				...environment,
				QORPERA_RUNNER_ORCHESTRATOR_POLL_MS: "2000",
				QORPERA_RUNNER_ORCHESTRATOR_WAKE: "realtime",
				QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS: "1000",
			}),
		).toThrow("outside the supported range");
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

	it("defaults surfaceWorkerEnabled to off and enables it only when QORPERA_SURFACE_WORKER=1", () => {
		const baseEnv = {
			QORPERA_SUPABASE_URL: "https://project.supabase.co",
			QORPERA_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
			QORPERA_RUNNER_ORCHESTRATOR_ID: "11111111-1111-4111-8111-111111111111",
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN: "c".repeat(43),
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE: resolve(".test/orchestrator-control.json"),
			QORPERA_RUNNER_PROVIDER_URL: "https://provider.example",
			QORPERA_RUNNER_PROVIDER_ADAPTER: "managed",
			QORPERA_RUNNER_PROVIDER_TOKEN: "provider-service-token",
		};
		expect(cloudRunnerOrchestratorServiceConfigFromEnvironment(baseEnv).surfaceWorkerEnabled).toBe(false);
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({ ...baseEnv, QORPERA_SURFACE_WORKER: "1" })
				.surfaceWorkerEnabled,
		).toBe(true);
		expect(
			cloudRunnerOrchestratorServiceConfigFromEnvironment({ ...baseEnv, QORPERA_SURFACE_WORKER: "0" })
				.surfaceWorkerEnabled,
		).toBe(false);
	});

	it("auto-starts default SurfaceWorkerLoop when surfaceWorkerEnabled is true and logs gracefully without crashing", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "orch-default-surface-")));
		try {
			const orchestratorId = "11111111-1111-4111-8111-111111111111";
			const events: Record<string, unknown>[] = [];
			const fakeControl = new SupabaseCloudRunnerOrchestratorControlPlane(
				"https://project.supabase.co",
				"publishable-key",
				orchestratorId,
				"c".repeat(43),
				vi.fn(async () => Response.json({ value: { jobId: runnerId, status: "failed" } })) as typeof fetch,
			);
			const providerCalls: Record<string, unknown>[] = [];
			const fakeProvider = new HttpCloudRunnerProviderAdapter(
				"https://provider.example",
				"managed",
				"provider-token",
				vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					providerCalls.push(body);
					if (providerCalls.length === 1) {
						return new Response(JSON.stringify({ ok: true }), {
							status: 202,
							headers: { "content-type": "application/json" },
						});
					}
					return new Response(
						JSON.stringify({ error: "Surface session execution is not enabled on this provider" }),
						{
							status: 501,
							headers: { "content-type": "application/json" },
						},
					);
				}) as typeof fetch,
			);
			const defaultConfig = createDefaultSurfaceWorkerConfig(
				{ controlPlane: fakeControl, providerAdapter: fakeProvider, orchestratorId },
				{ onEvent: (event) => events.push(event) },
			);
			const sampleSession = {
				sessionId: runnerId,
				surfaceId: logicalComputerId,
				profileId: "88888888-8888-4888-8888-888888888888",
				state: "queued" as const,
				prompt: "Test turn",
				originKind: "member",
				originRef: null,
				repositoryKey: null,
				retryCount: 1,
				sponsor: {
					sponsorBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
					sponsorVersion: 2,
				},
				placement: { strategy: "reuse_machine" as const, machineId: runnerId, activeTurns: 0, targetDensity: 6 },
			};
			await defaultConfig.dispatchSessionTurn(sampleSession, runnerId, new AbortController().signal);
			expect(providerCalls).toHaveLength(1);
			expect(providerCalls[0]).toEqual({
				schema: "qorpera.runner-provider/v1",
				action: "surface_session",
				adapter_id: "managed",
				machine_id: runnerId,
				session: sampleSession,
			});
			expect(events).toHaveLength(0);

			await expect(
				defaultConfig.dispatchSessionTurn(sampleSession, runnerId, new AbortController().signal),
			).rejects.toThrow(/not enabled/);
			await defaultConfig.runAutomationJob?.(
				{
					automationId: runnerId,
					profileId: "88888888-8888-4888-8888-888888888888",
					key: "cofounder-pulse",
					title: "Co-Founder Pulse",
					prompt: "Check in",
					targetSurfaceSlug: null,
					outputMode: "decision_card",
					sessionId: null,
					surfaceId: null,
				},
				new AbortController().signal,
			);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "session_dispatch_unconfigured",
						sessionId: runnerId,
						status: 501,
					}),
					expect.objectContaining({ kind: "automation_dispatch_unconfigured", key: "cofounder-pulse" }),
				]),
			);

			let resolveSurfaceClaimed!: () => void;
			const surfaceClaimed = new Promise<void>((resolveClaim) => {
				resolveSurfaceClaimed = resolveClaim;
			});
			const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
				if (href.includes("provider.example")) return Response.json({ value: null });
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				switch (body.action) {
					case "surface_claim_jobs":
						resolveSurfaceClaimed();
						return Response.json({
							value: { sessions: [], previews: [], merges: [], publishes: [], automations: [] },
						});
					case "due_summary":
						return Response.json({ value: {} });
					case "folder_dynamic_routines":
						return Response.json({ value: { items: [], has_more: false } });
					case "retained":
						return Response.json({ value: [] });
					default:
						return Response.json({ value: null });
				}
			});

			const controller = new AbortController();
			const run = runCloudRunnerOrchestratorService({
				config: {
					supabaseUrl: "https://project.supabase.co",
					supabasePublishableKey: "publishable-key",
					orchestratorId,
					orchestratorControlToken: "c".repeat(43),
					orchestratorControlStatePath: join(dir, "control.json"),
					providerUrl: "https://provider.example",
					providerAdapterId: "managed",
					providerServiceToken: "provider-token",
					pollIntervalMs: 50,
					reconcileIntervalMs: 250,
					dispatchConcurrency: 2,
					surfaceWorkerEnabled: true,
				},
				signal: controller.signal,
				fetchImplementation: fakeFetch as typeof fetch,
			});

			await Promise.race([
				surfaceClaimed,
				run.then(() => {
					throw new Error("Service exited before default SurfaceWorkerLoop claimed surface jobs");
				}),
			]);
			controller.abort();
			await run;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
