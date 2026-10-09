import {
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import {
	type NativeProviderComputerBridge,
	nativeProviderExecutionGuarantees,
} from "@qorpera/runtime/cloud-native-provider";
import {
	type CloudRunnerBrokerDescription,
	type CloudRunnerBrokerTransport,
	CloudRunnerJobBroker,
	type CloudRunnerNativeAuthority,
} from "@qorpera/runtime/cloud-runner-broker";
import { DisposableCloudRunner } from "@qorpera/runtime/cloud-runner-control";
import type { CloudRunnerExecutionResult } from "@qorpera/runtime/cloud-runner-sandbox";
import { type CloudRunnerCompanyExecutor, EphemeralCloudRunnerWorker } from "@qorpera/runtime/cloud-runner-worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const clientRunnerId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const actorUserId = "ec30142e-47c8-4532-a6c4-10612d02c619";
const jobId = "b953532a-c4f0-4b81-b901-d4bb21237001";
const assignmentId = "b953532a-c4f0-4b81-b901-d4bb21237005";
const assignment = { assignmentId, jobId, capability: "z".repeat(43) };
const environmentId = "b953532a-c4f0-4b81-b901-d4bb21237002";
const substrateVersionId = "b953532a-c4f0-4b81-b901-d4bb21237003";
const clientJobId = "b953532a-c4f0-4b81-b901-d4bb21237004";
const createdAt = "2026-08-17T00:00:00.000Z";
const activationToken = "a".repeat(43);
const outputSnapshotId = "b953532a-c4f0-4b81-b901-d4bb21237006";

type CompanyJobOptions = Parameters<CloudRunnerCompanyExecutor>[0];

function runnerRecord(activeLeases: number) {
	return {
		runner_id: runnerId,
		profile_id: profileId,
		client_runner_id: clientRunnerId,
		display_name: "Ephemeral worker",
		runner_kind: "local",
		capabilities: ["agent_turn"],
		max_concurrency: 1,
		status: "active",
		online: true,
		platform: "linux-x64",
		runner_version: "0.1.0",
		activation_expires_at: "2026-08-17T00:15:00.000Z",
		session_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
		registered_by_user_id: actorUserId,
		created_at: createdAt,
		activated_at: createdAt,
		last_seen_at: createdAt,
		revoked_by_user_id: null,
		revoked_at: null,
		active_lease_count: activeLeases,
	};
}

function jobRecord(status: "queued" | "leased" | "completed" | "failed", result?: JsonValue) {
	return {
		job_id: jobId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: null,
		substrate_version_id: substrateVersionId,
		client_job_id: clientJobId,
		required_capability: "agent_turn",
		job_type: "agent_turn",
		payload: { prompt: "Build the plan" },
		status,
		attempt_count: 1,
		runner_id: status === "queued" ? null : runnerId,
		result: status === "completed" ? (result ?? { outcome: "ok" }) : null,
		output_artifact_count: 0,
		output_artifact_index_id: null,
		output_substrate_version_id: null,
		last_error: status === "failed" ? "terminal" : null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		started_at: status === "queued" ? null : createdAt,
		lease_expires_at: status === "leased" ? new Date(Date.now() + 2 * 60_000).toISOString() : null,
		finished_at: status === "completed" || status === "failed" ? createdAt : null,
		cancelled_by_user_id: null,
		cancelled_at: null,
	};
}

class RunnerService implements CloudRunnerControlTransport {
	readonly requests: CloudRunnerControlRequest[] = [];
	status: "queued" | "leased" | "completed" | "failed" = "queued";
	failCompletionOnce = false;
	completionErrorStatus?: number;

	async request(_token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		this.requests.push(structuredClone(body));
		if (body.action === "activate" || body.action === "heartbeat") {
			return runnerRecord(this.status === "leased" ? 1 : 0);
		}
		if (body.action === "start") {
			if (this.status !== "queued") return null;
			this.status = "leased";
			// A start that defers its reads: the company-lane spies serve the description and authority.
			return { job: jobRecord("leased"), description: null, native_authority: null };
		}
		if (body.action === "renew") return jobRecord("leased");
		if (body.action === "complete") {
			if (this.completionErrorStatus !== undefined) {
				const status = this.completionErrorStatus;
				this.completionErrorStatus = undefined;
				throw new CloudRunnerControlRequestError(status);
			}
			this.status = "completed";
			if (this.failCompletionOnce) {
				this.failCompletionOnce = false;
				throw new Error("completion response lost");
			}
			return jobRecord("completed", body.result);
		}
		if (body.action !== "fail") throw new Error("unexpected runner action");
		this.status = body.retryable ? "queued" : "failed";
		return jobRecord(this.status);
	}
}

const authority: CloudRunnerNativeAuthority = {
	leaseId: clientJobId,
	runId: environmentId,
	providerConnectionId: clientRunnerId,
	providerConnectionVersion: 1,
	credentialCapsuleId: clientRunnerId,
	encryptedCapsuleReference: "synthetic-private-capsule",
	attestationPolicySha256: "a".repeat(64),
	computeIdentityId: clientRunnerId,
	computeIdentityOwnershipKind: "member",
	computeIdentityOwnerUserId: actorUserId,
	credentialOwnershipKind: "member",
	credentialOwnerUserId: actorUserId,
	provider: "openai",
	authenticationMode: "native_subscription",
	nativeHarness: "codex-cli",
	model: "faux-no-model",
	runnerId,
	assignmentId,
	expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};

const bridge: NativeProviderComputerBridge = {
	executionGuarantees: nativeProviderExecutionGuarantees("virtual_machine"),
	startCompany: async () => {
		throw new Error("worker test uses an injected company executor");
	},
};

/** The company lane's broker reads. This is a worker lifecycle test: broker parsing and native
 * execution have their own fixtures, so only what the worker consumes is stubbed. */
function companyLane() {
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

afterEach(() => {
	vi.restoreAllMocks();
});

function brokerTransport(): CloudRunnerBrokerTransport {
	return {
		describe: vi.fn(async () => ({})),
		listInputs: vi.fn(async () => []),
		listTranscript: vi.fn(async () => []),
		listOperations: vi.fn(async () => []),
		listArtifacts: vi.fn(async () => []),
		requestModel: vi.fn(async () => ({})),
		beginOperation: vi.fn(async () => ({})),
		completeOperation: vi.fn(async () => ({})),
		bindProviderSession: vi.fn(async () => ({})),
		appendTranscriptEvent: vi.fn(async () => ({})),
	};
}

function successfulExecution(result: JsonValue = { outcome: "ok" }): CloudRunnerExecutionResult {
	return {
		result,
		outputFiles: [],
		outputBytes: 0,
		usage: {
			executionMs: 10,
			inputBytes: 1,
			outputBytes: 0,
			resultBytes: 16,
			limits: {
				wallTimeMs: 30 * 60 * 1000,
				memoryBytes: 2 * 1024 * 1024 * 1024,
				cpuMillis: 2000,
				maxPids: 256,
				maxInputBytes: 16 * 1024 * 1024 * 1024,
				maxOutputBytes: 256 * 1024 * 1024,
				maxResultBytes: 32 * 1024,
			},
		},
	};
}

async function activeRunner(service: RunnerService): Promise<DisposableCloudRunner> {
	const runner = new DisposableCloudRunner(service, runnerId, activationToken);
	await runner.activate("linux-x64", "0.1.0");
	return runner;
}

function worker(
	runner: DisposableCloudRunner,
	executeJob: CloudRunnerCompanyExecutor,
	options: { leaseRenewalMs?: number; heartbeatMs?: number; now?: () => number } = {},
): EphemeralCloudRunnerWorker {
	return new EphemeralCloudRunnerWorker({
		runner,
		brokerTransport: brokerTransport(),
		nativeProviderBridge: bridge,
		platform: "linux-x64",
		runnerVersion: "0.1.0",
		executeJob,
		...options,
	});
}

describe("ephemeral cloud runner worker", () => {
	it("starts assigned work on the native company lane and completes it", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const executeJob = vi.fn(async (_options: CompanyJobOptions) => ({
			...successfulExecution({ outcome: "built" }),
			outputSnapshotId,
		}));

		const result = await worker(runner, executeJob).runNext(assignment);

		expect(result).toMatchObject({ status: "completed", job: { jobId, status: "completed" } });
		expect(executeJob).toHaveBeenCalledOnce();
		expect(executeJob.mock.calls[0]?.[0]).toMatchObject({
			job: { jobId, substrateVersionId },
			authority,
			bridge,
			// The job's lease token travels with it, for the host's calls (G2-2).
			leaseToken: assignment.capability,
		});
		expect(lane.acquire).toHaveBeenCalledOnce();
		// Governed completion releases the native lease atomically with its receipt.
		expect(lane.release).not.toHaveBeenCalled();
		expect(service.requests.map((request) => request.action)).toEqual(["activate", "start", "complete"]);
		expect(service.requests.at(-1)).toMatchObject({ action: "complete", outputSnapshotId });
		expect(runner.leasedJobs()).toEqual([]);
	});

	it.each([
		["a whole-tree company run", "whole-tree-v1", "native_subscription", "does not support a whole-tree"],
		["a non-native company run", "company-path-v1", "api_key", "requires the native cloud runtime"],
	] as const)(
		"refuses %s before any authority or execution, with no fallback",
		async (_label, companyRuntime, authenticationMode, message) => {
			const description = { companyRuntime, sponsor: { authenticationMode } } as CloudRunnerBrokerDescription;
			lane.describe.mockResolvedValue(description);
			const service = new RunnerService();
			const runner = await activeRunner(service);
			const executeJob = vi.fn(async () => successfulExecution());

			const result = await worker(runner, executeJob).runNext(assignment);

			expect(result).toMatchObject({ status: "failed", job: { status: "failed" } });
			expect(service.requests.at(-1)).toMatchObject({
				action: "fail",
				error: expect.stringContaining(message),
				retryable: false,
			});
			expect(executeJob).not.toHaveBeenCalled();
			expect(lane.acquire).not.toHaveBeenCalled();
			expect(lane.release).not.toHaveBeenCalled();
		},
	);

	it("refuses a company run when no native execution bridge is configured", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const executeJob = vi.fn(async () => successfulExecution());

		const result = await new EphemeralCloudRunnerWorker({
			runner,
			brokerTransport: brokerTransport(),
			platform: "linux-x64",
			runnerVersion: "0.1.0",
			executeJob,
		}).runNext(assignment);

		expect(result).toMatchObject({ status: "failed" });
		expect(service.requests.at(-1)).toMatchObject({
			action: "fail",
			error: expect.stringContaining("bridge is not configured"),
		});
		expect(executeJob).not.toHaveBeenCalled();
		expect(lane.acquire).not.toHaveBeenCalled();
	});

	it("renews the lease, the native authority and the heartbeat serially while a company run is in flight", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const executeJob = vi.fn(
			async () =>
				new Promise<CloudRunnerExecutionResult>((resolveExecution) => {
					setTimeout(() => resolveExecution(successfulExecution()), 45);
				}),
		);

		await worker(runner, executeJob, { leaseRenewalMs: 10, heartbeatMs: 20 }).runNext(assignment);

		const actions = service.requests.map((request) => request.action);
		expect(actions.filter((action) => action === "renew").length).toBeGreaterThanOrEqual(2);
		expect(lane.renew).toHaveBeenCalled();
		expect(actions).toContain("heartbeat");
		expect(actions.at(-1)).toBe("complete");
	});

	it("reports deterministic job-contract failures without retrying them, and releases the native lease", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const result = await worker(runner, async () => {
			throw new Error("Runner substrate is inconsistent");
		}).runNext(assignment);

		expect(result).toMatchObject({ status: "failed", job: { status: "failed" } });
		expect(service.requests.at(-1)).toMatchObject({ action: "fail", retryable: false });
		expect(lane.release).toHaveBeenCalledExactlyOnceWith("released");
	});

	it("destroys execution on shutdown without falsely failing the leased job, and revokes the native lease", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const controller = new AbortController();
		const executeJob = vi.fn(
			async (options: CompanyJobOptions) =>
				new Promise<CloudRunnerExecutionResult>((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("computer destroyed")), {
						once: true,
					});
				}),
		);
		const running = worker(runner, executeJob, { leaseRenewalMs: 50, heartbeatMs: 50 }).runNext(
			assignment,
			controller.signal,
		);
		await vi.waitFor(() => expect(executeJob).toHaveBeenCalledOnce());
		controller.abort();

		await expect(running).rejects.toThrow("worker stopped");
		expect(service.requests.some((request) => request.action === "fail")).toBe(false);
		expect(runner.leasedJobs()).toMatchObject([{ jobId, status: "leased" }]);
		expect(lane.release).toHaveBeenCalledExactlyOnceWith("revoked");
	});

	it("replays a staged completion after an ambiguous response without rerunning the company run", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		service.failCompletionOnce = true;
		const executeJob = vi.fn(async () => ({
			...successfulExecution({ outcome: "durable" }),
			outputSnapshotId,
		}));
		const ephemeralWorker = worker(runner, executeJob);
		await expect(ephemeralWorker.runNext(assignment)).rejects.toThrow("completion response lost");
		expect(runner.pendingCompletion(jobId)).toEqual({ outcome: "durable" });

		await expect(ephemeralWorker.runNext(undefined)).resolves.toMatchObject({ status: "completed" });
		expect(executeJob).toHaveBeenCalledOnce();
		expect(lane.acquire).toHaveBeenCalledOnce();
		// The staged completion still owns the native lease; the replayed completion releases it.
		expect(lane.release).not.toHaveBeenCalled();
		const completions = service.requests.filter((request) => request.action === "complete");
		expect(completions).toHaveLength(2);
		expect(completions[0]).toEqual(completions[1]);
		expect(completions[0]).toMatchObject({ outputSnapshotId });
	});

	it("discards a staged completion after the hosted lease is definitively unavailable", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		service.failCompletionOnce = true;
		const executeJob = vi.fn(async () => successfulExecution({ outcome: "staged" }));
		const ephemeralWorker = worker(runner, executeJob);
		await expect(ephemeralWorker.runNext(assignment)).rejects.toThrow("completion response lost");
		expect(runner.pendingCompletion(jobId)).toEqual({ outcome: "staged" });
		service.completionErrorStatus = 409;

		await expect(ephemeralWorker.runNext(undefined)).resolves.toEqual({ status: "idle" });
		expect(runner.leasedJobs()).toEqual([]);
		expect(executeJob).toHaveBeenCalledOnce();
	});

	it("retains a staged completion while a model request is unresolved", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		service.failCompletionOnce = true;
		const executeJob = vi.fn(async () => successfulExecution({ outcome: "waiting" }));
		const ephemeralWorker = worker(runner, executeJob);
		await expect(ephemeralWorker.runNext(assignment)).rejects.toThrow("completion response lost");
		service.completionErrorStatus = 423;

		await expect(ephemeralWorker.runNext(undefined)).rejects.toThrow("Runner control request failed (423)");
		expect(runner.pendingCompletion(jobId)).toEqual({ outcome: "waiting" });
		expect(runner.leasedJobs()).toHaveLength(1);
		expect(executeJob).toHaveBeenCalledOnce();
	});

	it("does not replay a staged completion after its local lease expiry", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		service.failCompletionOnce = true;
		const executeJob = vi.fn(async () => successfulExecution({ outcome: "expired" }));
		await expect(worker(runner, executeJob).runNext(assignment)).rejects.toThrow("completion response lost");
		const leaseExpiry = Date.parse(runner.leasedJobs()[0]?.leaseExpiresAt as string);

		await expect(worker(runner, executeJob, { now: () => leaseExpiry + 1 }).runNext(undefined)).resolves.toEqual({
			status: "idle",
		});
		expect(service.requests.filter((request) => request.action === "complete")).toHaveLength(1);
		expect(runner.leasedJobs()).toEqual([]);
		expect(executeJob).toHaveBeenCalledOnce();
	});
});
