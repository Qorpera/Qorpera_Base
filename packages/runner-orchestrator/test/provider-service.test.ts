import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_OBSERVATIONS_PATH, ProviderNodeObservability } from "../src/node-observability.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "../src/orchestrator.ts";
import { HttpCloudRunnerProviderAdapter } from "../src/provider-http.ts";
import { type CloudRunnerProviderServiceBackend, HttpCloudRunnerProviderService } from "../src/provider-service.ts";
import { ProviderRpcFailed, ProviderStepFailed, providerRpcErrorCode } from "../src/provider-shared.ts";

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

function observations(): ProviderNodeObservability {
	return new ProviderNodeObservability({
		providerAdapter: "managed",
		nodeId: "20000000-0000-4000-8000-000000000001",
		softwareVersion: "0.83.0",
		sources: {
			cpuTimes: () => [{ user: 100, nice: 0, sys: 50, idle: 500, irq: 0 }],
			memory: () => ({ totalBytes: 1000, freeBytes: 250 }),
			disk: async () => ({ blockSize: 4096n, blocks: 1000n, availableBlocks: 500n }),
		},
	});
}

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
	it("cancels pending acquisition when the caller disconnects after sending its complete request", async () => {
		const provider = backend();
		let entered = (): void => undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let finish = (): void => undefined;
		let backendSignal: AbortSignal | undefined;
		provider.acquire.mockImplementation((_id: string, _work: CloudRunnerWork, signal: AbortSignal) => {
			backendSignal = signal;
			return new Promise<CloudRunnerInstance>((resolve, reject) => {
				finish = () => resolve(runner);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				entered();
			});
		});
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		const port = await service.start();
		const caller = new AbortController();
		const request = fetch(`http://127.0.0.1:${port}/v1/qorpera-runner-provider`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.runner-provider/v1",
				action: "acquire",
				adapter_id: "managed",
				acquisition_id: work.runId,
				work,
			}),
			signal: caller.signal,
		});
		const cancelled = expect(request).rejects.toThrow();
		try {
			await started;
			expect(backendSignal?.aborted).toBe(false);
			caller.abort();
			await cancelled;
			await vi.waitFor(() => expect(backendSignal?.aborted).toBe(true), { timeout: 500 });
		} finally {
			caller.abort();
			finish();
			await cancelled;
		}
	});

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

	it("source-fences and authenticates the cached operational view before reading it", async () => {
		const monitor = observations();
		const snapshot = vi.spyOn(monitor, "snapshot");
		const service = new HttpCloudRunnerProviderService(backend(), token, "127.0.0.1", 0, {
			nodeObservations: monitor,
			trustedSource: "127.0.0.1",
		});
		services.push(service);
		const port = await service.start();
		const endpoint = `http://127.0.0.1:${port}${NODE_OBSERVATIONS_PATH}`;
		expect((await fetch(endpoint)).status).toBe(401);
		expect((await fetch(endpoint, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
		expect(snapshot).not.toHaveBeenCalled();
		const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const value = await response.json();
		expect(value).toMatchObject({
			schema: "qorpera.node-observation/v1",
			providerAdapter: "managed",
			nodeId: "20000000-0000-4000-8000-000000000001",
			softwareVersion: "0.83.0",
			cpu: { status: "unknown", reason: "warming_up", value: null },
			network: { status: "unknown", reason: "not_observed" },
		});
		expect(JSON.stringify(value)).not.toContain(token);
		expect(snapshot).toHaveBeenCalledTimes(1);

		const deniedMonitor = observations();
		const deniedRead = vi.spyOn(deniedMonitor, "snapshot");
		const denied = new HttpCloudRunnerProviderService(backend(), token, "127.0.0.1", 0, {
			nodeObservations: deniedMonitor,
			trustedSource: "192.0.2.10",
		});
		services.push(denied);
		const deniedPort = await denied.start();
		expect(
			(
				await fetch(`http://127.0.0.1:${deniedPort}${NODE_OBSERVATIONS_PATH}`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(403);
		expect(deniedRead).not.toHaveBeenCalled();
	});

	it("keeps rich observations out of public health and rejects alternate operational routes", async () => {
		const monitor = observations();
		const snapshot = vi.spyOn(monitor, "snapshot");
		const service = new HttpCloudRunnerProviderService(backend(), token, "127.0.0.1", 0, {
			nodeObservations: monitor,
		});
		services.push(service);
		const port = await service.start();
		await expect(fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json())).resolves.toEqual({
			ok: true,
		});
		expect((await fetch(`http://127.0.0.1:${port}${NODE_OBSERVATIONS_PATH}`, { method: "POST" })).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}${NODE_OBSERVATIONS_PATH}?path=/private`)).status).toBe(404);
		expect(snapshot).not.toHaveBeenCalled();
	});

	it("reports an unconfigured observer explicitly instead of a healthy or zero-valued node", async () => {
		const service = new HttpCloudRunnerProviderService(backend(), token);
		services.push(service);
		const port = await service.start();
		const response = await fetch(`http://127.0.0.1:${port}${NODE_OBSERVATIONS_PATH}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			schema: "qorpera.node-observation-error/v1",
			status: "unknown",
			reason: "not_configured",
		});
	});

	it("serves cached stale measurements without resampling or overwriting their timestamps", async () => {
		let now = Date.parse("2026-08-31T12:00:00.000Z");
		const memory = vi.fn(() => ({ totalBytes: 1000, freeBytes: 250 }));
		const disk = vi.fn(async () => ({ blockSize: 4096n, blocks: 1000n, availableBlocks: 500n }));
		const monitor = new ProviderNodeObservability({
			providerAdapter: "managed",
			sources: {
				cpuTimes: () => [{ user: 100, nice: 0, sys: 50, idle: 500, irq: 0 }],
				memory,
				disk,
				now: () => now,
			},
		});
		const service = new HttpCloudRunnerProviderService(backend(), token, "127.0.0.1", 0, {
			nodeObservations: monitor,
		});
		services.push(service);
		const port = await service.start();
		now += 61_000;
		for (let index = 0; index < 3; index += 1) {
			const response = await fetch(`http://127.0.0.1:${port}${NODE_OBSERVATIONS_PATH}`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				memory: {
					observedAt: "2026-08-31T12:00:00.000Z",
					freshness: "stale",
					value: { totalBytes: 1000, freeBytes: 250, usedBytes: 750 },
				},
			});
		}
		expect(memory).toHaveBeenCalledTimes(1);
		expect(disk).toHaveBeenCalledTimes(1);
	});

	it.each(["start", "snapshot"] as const)(
		"contains %s failures without breaking product work or exporting errors",
		async (method) => {
			const monitor = observations();
			vi.spyOn(monitor, method).mockImplementation(() => {
				throw new Error("PRIVATE credential and /root/private-host-path");
			});
			const provider = backend();
			const service = new HttpCloudRunnerProviderService(provider, token, "127.0.0.1", 0, {
				nodeObservations: monitor,
			});
			services.push(service);
			const port = await service.start();
			const response = await fetch(`http://127.0.0.1:${port}${NODE_OBSERVATIONS_PATH}`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(503);
			await expect(response.json()).resolves.toEqual({
				schema: "qorpera.node-observation-error/v1",
				status: "unavailable",
				reason: "observation_failed",
			});
			const acquire = await fetch(`http://127.0.0.1:${port}/v1/qorpera-runner-provider`, {
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
			expect(provider.acquire).toHaveBeenCalledOnce();
		},
	);

	it("starts and stops sampling with service lifetime, even when optional cleanup fails", async () => {
		const monitor = observations();
		const start = vi.spyOn(monitor, "start");
		const stop = vi.spyOn(monitor, "stop");
		const provider = backend();
		const service = new HttpCloudRunnerProviderService(provider, token, "127.0.0.1", 0, {
			nodeObservations: monitor,
		});
		services.push(service);
		expect(start).not.toHaveBeenCalled();
		await service.start();
		expect(start).toHaveBeenCalledOnce();
		await service.close();
		expect(stop).toHaveBeenCalledOnce();
		expect(provider.close).toHaveBeenCalledOnce();
		stop.mockImplementation(() => {
			throw new Error("PRIVATE cleanup failure");
		});
		await expect(service.close()).resolves.toBeUndefined();
	});

	it("keeps raw backend diagnostics out of the operator journal", async () => {
		const provider = backend();
		provider.acquire.mockRejectedValue(new Error("PRIVATE_CREDENTIAL /private/company/file customer body"));
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		try {
			const port = await service.start();
			const response = await fetch(`http://127.0.0.1:${port}/v1/qorpera-runner-provider`, {
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
			expect(response.status).toBe(422);
			expect(log).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({
					schema: "qorpera.provider-request-error/v1",
					providerAdapter: "managed",
					status: "rejected",
					action: "acquire",
					errorCategory: "unknown",
				}),
			);
			expect(await response.text()).not.toContain("PRIVATE_CREDENTIAL");
		} finally {
			log.mockRestore();
		}
	});
	it("reads only a PostgREST error's code from a failed database answer", async () => {
		const answer = (body: string) => new Response(body, { status: 500 });
		expect(await providerRpcErrorCode(answer('{"code":"PGRSTX00","message":"PRIVATE"}'))).toBe("PGRSTX00");
		expect(await providerRpcErrorCode(answer('{"code":"PGRST202"}'))).toBe("PGRST202");
		expect(await providerRpcErrorCode(answer('{"code":"42501","details":"PRIVATE"}'))).toBe("42501");
		for (const body of [
			'{"code":"pgrstx00"}',
			'{"code":"PGRSTXX0"}',
			'{"code":"PRIVATE"}',
			'{"code":42501}',
			"<html>",
			"",
		])
			expect(await providerRpcErrorCode(answer(body))).toBeUndefined();
	});
	it("logs the failed step and a database call's function, status and code, never the error text", async () => {
		const provider = backend();
		provider.acquire.mockRejectedValueOnce(
			new ProviderStepFailed(
				"reserve",
				new ProviderRpcFailed(
					"PRIVATE_CREDENTIAL /private/path",
					"qorpera_reserve_runtime_machine",
					500,
					"PGRSTX00",
				),
			),
		);
		provider.acquire.mockRejectedValueOnce(
			Object.assign(new Error("PRIVATE_CREDENTIAL"), {
				category: "provider_step",
				stage: "Create /private",
				rpc: "drop table",
				rpcStatus: 9000,
				rpcCode: "PRIVATE",
			}),
		);
		provider.acquire.mockRejectedValueOnce(
			Object.assign(new Error("PRIVATE_CREDENTIAL"), {
				category: "provider_step",
				stage: "create",
				rpc: "drop table",
				rpcStatus: 9000,
				rpcCode: "PRIVATE",
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		try {
			const port = await service.start();
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const response = await fetch(`http://127.0.0.1:${port}/v1/qorpera-runner-provider`, {
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
				expect(response.status).toBe(422);
				expect(await response.text()).toBe('{"error":"request rejected"}\n');
			}
			const line = {
				schema: "qorpera.provider-request-error/v1",
				providerAdapter: "managed",
				status: "rejected",
				action: "acquire",
				errorCategory: "unknown",
			};
			expect(log.mock.calls).toEqual([
				[
					JSON.stringify({
						...line,
						stage: "reserve",
						rpc: "qorpera_reserve_runtime_machine",
						rpcStatus: 500,
						rpcCode: "PGRSTX00",
					}),
				],
				// A step name that is not a fixed name is not logged, nor anything with it.
				[JSON.stringify(line)],
				[JSON.stringify({ ...line, stage: "create" })],
			]);
		} finally {
			log.mockRestore();
		}
	});
	it("answers a typed admission refusal with its reason code only", async () => {
		const provider = backend();
		const refusal = Object.assign(new Error("Machine start was not admitted by the company ceiling"), {
			category: "admission_refused",
			state: "refused",
			reason: "NODE_NOT_PREFERRED",
		});
		provider.acquire.mockRejectedValue(refusal);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		try {
			const port = await service.start();
			const response = await fetch(`http://127.0.0.1:${port}/v1/qorpera-runner-provider`, {
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
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({
				error: "request rejected",
				category: "admission_refused",
				state: "refused",
				reason: "NODE_NOT_PREFERRED",
			});
			expect(log).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({
					schema: "qorpera.provider-request-error/v1",
					providerAdapter: "managed",
					status: "rejected",
					action: "acquire",
					errorCategory: "admission_refused",
					state: "refused",
					reason: "NODE_NOT_PREFERRED",
				}),
			);
		} finally {
			log.mockRestore();
		}
	});

	it("logs validation instead of an unvalidated request action", async () => {
		const provider = backend();
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const port = await service.start();
			const response = await fetch(`http://127.0.0.1:${port}/v1/qorpera-runner-provider`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ schema: "qorpera.runner-provider/v1", adapter_id: "managed", action: "PRIVATE" }),
			});
			expect(response.status).toBe(422);
			expect(JSON.parse(String(log.mock.calls[0]?.[0])).action).toBe("validation");
			expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
			expect(provider.acquire).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it("keeps concurrent provider refusal phases distinct without exporting backend secrets", async () => {
		const provider = backend();
		provider.acquire.mockRejectedValue(new Error("PRIVATE_ACQUIRE"));
		provider.deliver.mockRejectedValue(new Error("PRIVATE_DELIVERY"));
		provider.stop = vi.fn().mockRejectedValue(new Error("PRIVATE_STOP"));
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const service = new HttpCloudRunnerProviderService(provider, token);
		services.push(service);
		try {
			const port = await service.start();
			const adapter = new HttpCloudRunnerProviderAdapter(`http://127.0.0.1:${port}`, "managed", token);
			const results = await Promise.allSettled([
				adapter.acquire(work, new AbortController().signal),
				adapter.deliver(runner, {
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
				}),
				adapter.stop(runner, "idle"),
			]);
			expect(
				results.map((result) => (result.status === "rejected" ? String(result.reason) : "unexpected success")),
			).toEqual([
				"CloudRunnerProviderRequestError: Runner provider request failed (422) [code=PROVIDER_ACQUIRE]",
				"CloudRunnerProviderRequestError: Runner provider request failed (422) [code=PROVIDER_DELIVER]",
				"CloudRunnerProviderRequestError: Runner provider request failed (422) [code=PROVIDER_STOP]",
			]);
			expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).action).sort()).toEqual([
				"acquire",
				"deliver",
				"stop",
			]);
			expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
			expect(provider.acquire).toHaveBeenCalledOnce();
			expect(provider.deliver).toHaveBeenCalledOnce();
			expect(provider.stop).toHaveBeenCalledOnce();
		} finally {
			log.mockRestore();
		}
	});
});
