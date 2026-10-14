import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CloudRunnerAuthorityStore,
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import { nativeProviderExecutionGuarantees } from "@qorpera/runtime/cloud-native-provider";
import {
	type CloudRunnerBrokerDescription,
	type CloudRunnerBrokerTransport,
	CloudRunnerJobBroker,
	type CloudRunnerNativeAuthority,
} from "@qorpera/runtime/cloud-runner-broker";
import { DisposableCloudRunner, SupabaseCloudRunnerControlTransport } from "@qorpera/runtime/cloud-runner-control";
import type { CloudRunnerExecutionResult } from "@qorpera/runtime/cloud-runner-sandbox";
import { type CloudRunnerCompanyExecutor, EphemeralCloudRunnerWorker } from "@qorpera/runtime/cloud-runner-worker";
import { FileCloudRunnerAuthorityStore } from "@qorpera/runtime/cloud-runner-worker-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const actorId = "ec30142e-47c8-4532-a6c4-10612d02c619";
const jobId = "b953532a-c4f0-4b81-b901-d4bb21237001";
const runId = "b953532a-c4f0-4b81-b901-d4bb21237002";
const assignmentId = "b953532a-c4f0-4b81-b901-d4bb21237003";
const snapshotId = "b953532a-c4f0-4b81-b901-d4bb21237004";
const assignment = { assignmentId, jobId, capability: "a".repeat(43) };
const roots: string[] = [];

class Control implements CloudRunnerControlTransport {
	readonly calls: CloudRunnerControlRequest[] = [];
	status: "leased" | "completed" | "failed" = "leased";
	leaseMs = 120_000;
	loseCompletion = false;
	loseFailure = false;
	stallRenewal = false;
	rejectRenewal?: number;
	completion?: JsonValue;
	wrongCompletion = false;
	enrichCompletion = false;
	profile = profileId;

	async request(_token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		this.calls.push(structuredClone(body));
		if (body.action === "activate" || body.action === "heartbeat")
			return {
				runner_id: runnerId,
				profile_id: profileId,
				client_runner_id: actorId,
				display_name: "Cloud outage fixture",
				runner_kind: "qorpera_computer",
				capabilities: ["agent_turn"],
				max_concurrency: 1,
				status: "active",
				online: true,
				activation_expires_at: new Date(Date.now() + 900_000).toISOString(),
				session_expires_at: new Date(Date.now() + 900_000).toISOString(),
				registered_by_user_id: actorId,
				created_at: new Date().toISOString(),
				active_lease_count: 0,
			};
		if (body.action === "renew") {
			if (this.rejectRenewal) throw new CloudRunnerControlRequestError(this.rejectRenewal);
			if (this.stallRenewal) return new Promise<unknown>(() => {});
		}
		if (body.action === "complete") {
			this.status = "completed";
			this.completion = body.result;
			if (this.enrichCompletion)
				this.completion = {
					...(body.result as Record<string, JsonValue>),
					output_substrate: null,
					company_file: { runtime: "company-path-v1", disposition: "unchanged" },
				};
			if (this.loseCompletion) {
				this.loseCompletion = false;
				throw new Error("completion response lost");
			}
		}
		if (body.action === "fail") {
			this.status = "failed";
			if (this.loseFailure) {
				this.loseFailure = false;
				throw new Error("failure response lost");
			}
		}
		const job = {
			job_id: jobId,
			run_id: runId,
			assignment_id: assignmentId,
			profile_id: this.profile,
			environment_id: actorId,
			substrate_version_id: actorId,
			client_job_id: jobId,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			payload: { prompt: "synthetic intent" },
			status: this.status,
			attempt_count: 1,
			runner_id: runnerId,
			result:
				this.status === "completed"
					? this.wrongCompletion
						? { outcome: "different completion" }
						: this.completion
					: null,
			output_artifact_count: 0,
			created_by_user_id: actorId,
			created_at: new Date().toISOString(),
			lease_expires_at: this.status === "leased" ? new Date(Date.now() + this.leaseMs).toISOString() : null,
		};
		// A start that defers its reads: the broker spies below serve describe and authority.
		return body.action === "start" ? { job, description: null, native_authority: null } : job;
	}
}

function broker() {
	return {
		describe: vi.fn(async () => ({})),
	} satisfies CloudRunnerBrokerTransport;
}

/** The company lane's broker reads. This is a worker lifecycle test: broker parsing and native
 * execution have their own fixtures, so only what the worker consumes is stubbed. */
function companyLane() {
	const authority: CloudRunnerNativeAuthority = {
		leaseId: actorId,
		runId,
		providerConnectionId: actorId,
		providerConnectionVersion: 1,
		credentialCapsuleId: actorId,
		encryptedCapsuleReference: "synthetic-private-capsule",
		attestationPolicySha256: "a".repeat(64),
		computeIdentityId: actorId,
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: actorId,
		credentialOwnershipKind: "member",
		credentialOwnerUserId: actorId,
		provider: "openai",
		authenticationMode: "native_subscription",
		nativeHarness: "codex-cli",
		model: "faux-no-model",
		runnerId,
		assignmentId,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	return {
		describe: vi.spyOn(CloudRunnerJobBroker.prototype, "describe").mockResolvedValue({
			companyRuntime: "company-path-v1",
			sponsor: { authenticationMode: "native_subscription" },
		} as CloudRunnerBrokerDescription),
		acquire: vi.spyOn(CloudRunnerJobBroker.prototype, "acquireNativeAuthority").mockResolvedValue(authority),
		renew: vi.spyOn(CloudRunnerJobBroker.prototype, "renewNativeAuthority").mockResolvedValue(authority),
		release: vi.spyOn(CloudRunnerJobBroker.prototype, "releaseNativeAuthority").mockResolvedValue(undefined),
	};
}

let lane: ReturnType<typeof companyLane>;

beforeEach(() => {
	lane = companyLane();
});

function result(): CloudRunnerExecutionResult {
	return {
		result: { outcome: "private receipt", privateCanary: "must-not-become-a-message" },
		outputSnapshotId: snapshotId,
		outputFiles: [],
		outputBytes: 0,
		usage: {
			executionMs: 1,
			inputBytes: 0,
			outputBytes: 0,
			resultBytes: 32,
			limits: {
				wallTimeMs: 1000,
				memoryBytes: 1024,
				cpuMillis: 10,
				maxPids: 1,
				maxInputBytes: 1024,
				maxOutputBytes: 1024,
				maxResultBytes: 1024,
			},
		},
	};
}

function worker(
	runner: DisposableCloudRunner,
	executeJob: CloudRunnerCompanyExecutor,
	transport = broker(),
	now?: () => number,
) {
	return new EphemeralCloudRunnerWorker({
		runner,
		brokerTransport: transport,
		nativeProviderBridge: {
			executionGuarantees: nativeProviderExecutionGuarantees("virtual_machine"),
			startCompany: async () => {
				throw new Error("Only injected faux execution is allowed");
			},
		},
		executeJob,
		platform: "linux-x64",
		runnerVersion: "synthetic",
		leaseRenewalMs: 10,
		now,
	});
}

async function durable(control: Control) {
	const root = await mkdtemp(join(realpathSync(tmpdir()), "qorpera-outage-worker-"));
	roots.push(root);
	const store = new FileCloudRunnerAuthorityStore(join(root, "private", "authority.json"));
	const runner = await DisposableCloudRunner.open(control, runnerId, store, "b".repeat(43));
	await runner.activate("linux-x64", "synthetic");
	return { runner, store, restart: () => DisposableCloudRunner.open(control, runnerId, store) };
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("cloud worker outage recovery", () => {
	it("accepts exact result echoes with server-owned completion receipts, but not submitted receipt metadata", async () => {
		const control = new Control();
		control.enrichCompletion = true;
		const fixture = await durable(control);
		const execute = vi.fn(async () => result());
		await expect(worker(fixture.runner, execute).runNext(assignment)).resolves.toMatchObject({ status: "completed" });
		expect(fixture.runner.leasedJobs()).toEqual([]);
		const other = await durable(new Control());
		await other.runner.acceptAssignment(assignment);
		await expect(other.runner.stageCompletion(jobId, { company_file: { disposition: "published" } })).rejects.toThrow(
			"invalid",
		);
	});

	it("retains a returned company result without releasing its native lease, and replays it after restart", async () => {
		const control = new Control();
		control.loseCompletion = true;
		const fixture = await durable(control);
		const transport = broker();
		// Governed completion releases the native lease atomically with its receipt: a staged
		// company result never asks for a separate release, whose response could be lost.
		lane.release.mockImplementation(async () => {
			throw new Error("A staged company result must not release its native lease");
		});
		const execute = vi.fn(async () => result());
		await expect(worker(fixture.runner, execute, transport).runNext(assignment)).rejects.toThrow(
			"completion response lost",
		);
		expect(fixture.runner.stagedCompletion(jobId)?.result).toEqual(result().result);
		const restored = await fixture.restart();
		const forbidden = vi.fn(async () => {
			throw new Error("Retained work must not rerun");
		});
		await expect(worker(restored, forbidden, transport).runNext(undefined)).resolves.toMatchObject({
			status: "completed",
		});
		expect(execute).toHaveBeenCalledOnce();
		expect(forbidden).not.toHaveBeenCalled();
		expect(lane.acquire).toHaveBeenCalledOnce();
		expect(lane.release).not.toHaveBeenCalled();
	});

	it("replays an exact durable completion after process restart without rerunning work or sending messages", async () => {
		const control = new Control();
		control.loseCompletion = true;
		const fixture = await durable(control);
		const execute = vi.fn(async () => result());
		const transport = broker();
		await expect(worker(fixture.runner, execute, transport).runNext(assignment)).rejects.toThrow("response lost");
		const restored = await fixture.restart();
		expect(restored.leasedJobs()).toMatchObject([{ profileId, runId, assignmentId }]);
		await expect(worker(restored, execute, transport).runNext(undefined)).resolves.toMatchObject({
			status: "completed",
		});
		expect(execute).toHaveBeenCalledOnce();
		const calls = control.calls.filter((call) => call.action === "complete");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual(calls[1]);
	});

	it("persists a failed outcome before the request and recovers it idempotently", async () => {
		const control = new Control();
		control.loseFailure = true;
		const fixture = await durable(control);
		const execute = vi.fn(async () => {
			throw new Error("ambiguous external transport failure");
		});
		await expect(worker(fixture.runner, execute).runNext(assignment)).rejects.toThrow("failure response lost");
		const restored = await fixture.restart();
		expect(restored.stagedFailure(jobId)).toMatchObject({ retryable: false });
		await expect(restored.fail(jobId, "replacement failure", true)).rejects.toThrow("changed");
		await expect(worker(restored, execute).runNext(undefined)).resolves.toMatchObject({ status: "failed" });
		expect(execute).toHaveBeenCalledOnce();
		const failures = control.calls.filter((call) => call.action === "fail");
		expect(failures[0]).toEqual(failures[1]);
	});

	it("retains an expired outcome without retaining executable authority or publishing private text", async () => {
		const control = new Control();
		control.loseCompletion = true;
		const fixture = await durable(control);
		const execute = vi.fn(async () => result());
		await expect(worker(fixture.runner, execute).runNext(assignment)).rejects.toThrow("response lost");
		const deadline = Date.parse(fixture.runner.leasedJobs()[0]!.leaseExpiresAt!);
		const transport = broker();
		const restored = await fixture.restart();
		await worker(restored, execute, transport, () => deadline + 1).runNext(undefined);
		expect(restored.leasedJobs()).toEqual([]);
		expect(restored.recoveryRecords()).toMatchObject([
			{ job: { runId, assignmentId }, completion: { outputSnapshotId: snapshotId, result: result().result } },
		]);
		expect(execute).toHaveBeenCalledOnce();
		const again = await fixture.restart();
		expect(again.snapshot().recoveryJobIds).toEqual([jobId]);
		await expect(again.acceptAssignment(assignment)).rejects.toThrow("reconciliation");
		expect(JSON.stringify(again.recoveryRecords())).not.toContain(assignment.capability);
	});

	it("quarantines interrupted execution after restart instead of rerunning it", async () => {
		const control = new Control();
		const fixture = await durable(control);
		await fixture.runner.acceptAssignment(assignment);
		await fixture.runner.markExecutionStarted(jobId);
		const restored = await fixture.restart();
		const execute = vi.fn(async () => result());
		await worker(restored, execute).runNext(undefined);
		expect(execute).not.toHaveBeenCalled();
		expect(restored.recoveryRecords()).toMatchObject([{ reason: "interrupted", job: { jobId, runId, profileId } }]);
		await expect(restored.acceptAssignment(assignment)).rejects.toThrow("reconciliation");
	});

	it("retains ambiguous outcomes across credential repair without restoring executable leases", async () => {
		const control = new Control();
		control.loseCompletion = true;
		const fixture = await durable(control);
		const execute = vi.fn(async () => result());
		await expect(worker(fixture.runner, execute).runNext(assignment)).rejects.toThrow("response lost");
		const repaired = await DisposableCloudRunner.repair(control, runnerId, fixture.store, "r".repeat(43));
		expect(repaired.leasedJobs()).toEqual([]);
		expect(repaired.recoveryRecords()).toMatchObject([
			{ job: { jobId, runId, assignmentId }, completion: { result: result().result } },
		]);
		const restored = await fixture.restart();
		expect(restored.recoveryRecords()).toEqual(repaired.recoveryRecords());
		await restored.activate("linux-x64", "synthetic");
		await expect(restored.acceptAssignment(assignment)).rejects.toThrow("reconciliation");
		expect(execute).toHaveBeenCalledOnce();
	});

	it("does not discard the retained result for a mismatched completion receipt", async () => {
		const control = new Control();
		control.wrongCompletion = true;
		const fixture = await durable(control);
		const execute = vi.fn(async () => result());
		await expect(worker(fixture.runner, execute).runNext(assignment)).rejects.toThrow("inconsistent");
		expect((await fixture.restart()).stagedCompletion(jobId)).toEqual({
			result: result().result,
			outputSnapshotId: snapshotId,
		});
		expect(execute).toHaveBeenCalledOnce();
	});

	it("stops execution at the lease deadline while renewal ignores cancellation forever", async () => {
		vi.useFakeTimers();
		const control = new Control();
		control.leaseMs = 100;
		control.stallRenewal = true;
		let saved: JsonValue | undefined;
		const store: CloudRunnerAuthorityStore = {
			load: async () => saved,
			save: async (value) => {
				saved = structuredClone(value);
			},
		};
		const runner = await DisposableCloudRunner.open(control, runnerId, store, "b".repeat(43));
		await runner.activate("linux-x64", "synthetic");
		const execute = vi.fn(
			async (options: Parameters<CloudRunnerCompanyExecutor>[0]) =>
				new Promise<CloudRunnerExecutionResult>((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
				}),
		);
		const running = worker(runner, execute)
			.runNext(assignment)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(execute).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(101);
		expect(await running).toBeInstanceOf(Error);
		expect(execute.mock.calls[0]![0].signal.aborted).toBe(true);
		expect(control.calls.filter((call) => call.action === "complete" || call.action === "fail")).toHaveLength(0);
		await worker(runner, execute).runNext(undefined);
		expect(runner.recoveryRecords()).toHaveLength(1);
		expect(execute).toHaveBeenCalledOnce();
	});

	it.each([401, 403, 409])("stops immediately on a definitive renewal rejection (%s)", async (status) => {
		vi.useFakeTimers();
		const control = new Control();
		control.rejectRenewal = status;
		const runner = new DisposableCloudRunner(control, runnerId, "b".repeat(43));
		await runner.activate("linux-x64", "synthetic");
		const execute = vi.fn(
			async (options: Parameters<CloudRunnerCompanyExecutor>[0]) =>
				new Promise<CloudRunnerExecutionResult>((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
				}),
		);
		const running = worker(runner, execute)
			.runNext(assignment)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(11);
		expect(await running).toMatchObject({ status });
		await worker(runner, execute).runNext(undefined);
		expect(runner.snapshot().recoveryJobIds).toEqual([jobId]);
		expect(execute).toHaveBeenCalledOnce();
	});

	it("rejects a cross-tenant assignment before execution", async () => {
		const control = new Control();
		control.profile = actorId;
		const fixture = await durable(control);
		const execute = vi.fn(async () => result());
		await expect(worker(fixture.runner, execute).runNext(assignment)).rejects.toThrow("inconsistent lease");
		expect(execute).not.toHaveBeenCalled();
	});

	it("bounds stalled control headers and bodies even for a non-cooperative transport", async () => {
		for (const fetcher of [
			async () => new Promise<Response>(() => {}),
			async () => new Response(new ReadableStream()),
		]) {
			const transport = new SupabaseCloudRunnerControlTransport("https://cloud.test", "synthetic-public", fetcher, {
				requestTimeoutMs: 15,
			});
			await expect(
				transport.request("a".repeat(43), { action: "renew", runnerId, jobId, leaseToken: "b".repeat(43) }),
			).rejects.toThrow("deadline");
		}
	});

	it("denies control redirects and oversized/invalid bodies without exposing backend data", async () => {
		for (const response of [
			new Response("x".repeat(256 * 1024 + 1)),
			new Response("PRIVATE_BACKEND_CANARY"),
			new Response(new Uint8Array([0xff, 0xff])),
		]) {
			const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				expect(init?.redirect).toBe("error");
				return response;
			});
			const transport = new SupabaseCloudRunnerControlTransport("https://cloud.test", "synthetic-public", fetcher);
			const failure = await transport
				.request("a".repeat(43), { action: "renew", runnerId, jobId, leaseToken: "b".repeat(43) })
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).not.toContain("PRIVATE_BACKEND_CANARY");
		}
	});

	it.each([401, 403, 409])("preserves control rejection %s without reading a stalled error body", async (status) => {
		const cancelled = vi.fn();
		const transport = new SupabaseCloudRunnerControlTransport(
			"https://cloud.test",
			"synthetic-public",
			async () => new Response(new ReadableStream({ cancel: cancelled }), { status }),
		);
		await expect(
			transport.request("a".repeat(43), { action: "renew", runnerId, jobId, leaseToken: "b".repeat(43) }),
		).rejects.toMatchObject({ status });
		expect(cancelled).toHaveBeenCalledOnce();
	});
});
