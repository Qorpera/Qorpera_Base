import {
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudRunnerBrokerTransport } from "@qorpera/runtime/cloud-runner-broker";
import { DisposableCloudRunner } from "@qorpera/runtime/cloud-runner-control";
import type {
	CloudRunnerExecutionResult,
	CloudRunnerSandboxBackend,
	CloudRunnerSandboxGuarantees,
	ExecuteCloudRunnerJobOptions,
} from "@qorpera/runtime/cloud-runner-sandbox";
import { EphemeralCloudRunnerWorker } from "@qorpera/runtime/cloud-runner-worker";
import { describe, expect, it, vi } from "vitest";

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
		if (body.action === "accept") {
			if (this.status !== "queued") return null;
			this.status = "leased";
			return jobRecord("leased");
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

const guarantees: CloudRunnerSandboxGuarantees = {
	boundary: "rootless_container",
	hostFilesystem: "none",
	inputFilesystem: "read_only",
	companyCheckout: "job_private",
	outputFilesystem: "job_private",
	network: "deny_by_default",
	environment: "allowlist_only",
	privileges: "unprivileged",
	resourceLimits: "kernel_enforced",
	termination: "boundary_destroyed",
};

function backend() {
	return {
		backendId: "worker-test",
		guarantees,
		capabilities: ["agent_turn"] as const,
		jobTypes: ["agent_turn"] as const,
		prepare: vi.fn(async () => undefined),
		start: vi.fn(async () => {
			throw new Error("worker test uses an injected executor");
		}),
	} satisfies CloudRunnerSandboxBackend;
}

function brokerTransport(): CloudRunnerBrokerTransport {
	return {
		describe: vi.fn(async () => ({})),
		listInputs: vi.fn(async () => []),
		listTranscript: vi.fn(async () => []),
		listOperations: vi.fn(async () => []),
		listArtifacts: vi.fn(async () => []),
		getObject: vi.fn(async () => new Uint8Array()),
		putObject: vi.fn(async () => "stored" as const),
		registerArtifact: vi.fn(async () => ({})),
		requestModel: vi.fn(async () => ({})),
		beginOperation: vi.fn(async () => ({})),
		completeOperation: vi.fn(async () => ({})),
		bindProviderSession: vi.fn(async () => ({})),
		prepareCompanyRevision: vi.fn(async () => ({})),
		beginCompanyRevisionGraph: vi.fn(async () => ({})),
		appendCompanyRevisionGraph: vi.fn(async () => 1),
		completeCompanyRevisionGraph: vi.fn(async () => ({})),
		verifyCompanyRevision: vi.fn(async () => ({ verified: true, pending: false })),
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
	serviceBackend: CloudRunnerSandboxBackend,
	executeJob: (options: ExecuteCloudRunnerJobOptions) => Promise<CloudRunnerExecutionResult>,
	options: { leaseRenewalMs?: number; heartbeatMs?: number; now?: () => number } = {},
): EphemeralCloudRunnerWorker {
	return new EphemeralCloudRunnerWorker({
		runner,
		brokerTransport: brokerTransport(),
		backend: serviceBackend,
		platform: "linux-x64",
		runnerVersion: "0.1.0",
		executeJob,
		...options,
	});
}

describe("ephemeral cloud runner worker", () => {
	it("accepts assigned work, executes through the broker boundary, and completes", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const serviceBackend = backend();
		const executeJob = vi.fn(async (_options: ExecuteCloudRunnerJobOptions) => ({
			...successfulExecution({ outcome: "built" }),
			outputSnapshotId,
		}));

		const result = await worker(runner, serviceBackend, executeJob).runNext(assignment);

		expect(result).toMatchObject({ status: "completed", job: { jobId, status: "completed" } });
		expect(serviceBackend.prepare).toHaveBeenCalledOnce();
		expect(executeJob).toHaveBeenCalledOnce();
		expect(executeJob.mock.calls[0]?.[0]).toMatchObject({
			job: { jobId, substrateVersionId },
			backend: serviceBackend,
			modelBroker: { requestModel: expect.any(Function) },
		});
		expect(service.requests.map((request) => request.action)).toEqual(["activate", "accept", "complete"]);
		expect(service.requests.at(-1)).toMatchObject({ action: "complete", outputSnapshotId });
		expect(runner.leasedJobs()).toEqual([]);
	});

	it("renews the lease and heartbeat serially while a container is running", async () => {
		vi.useFakeTimers();
		try {
			const service = new RunnerService();
			const runner = await activeRunner(service);
			const executeJob = vi.fn(
				async () =>
					new Promise<CloudRunnerExecutionResult>((resolveExecution) => {
						setTimeout(() => resolveExecution(successfulExecution()), 45);
					}),
			);

			const running = worker(runner, backend(), executeJob, { leaseRenewalMs: 10, heartbeatMs: 20 }).runNext(
				assignment,
			);
			await vi.advanceTimersByTimeAsync(45);
			await running;

			const actions = service.requests.map((request) => request.action);
			expect(actions.filter((action) => action === "renew").length).toBeGreaterThanOrEqual(2);
			expect(actions).toContain("heartbeat");
			expect(actions.at(-1)).toBe("complete");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports deterministic job-contract failures without retrying them", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const result = await worker(runner, backend(), async () => {
			throw new Error("Runner substrate is inconsistent");
		}).runNext(assignment);

		expect(result).toMatchObject({ status: "failed", job: { status: "failed" } });
		expect(service.requests.at(-1)).toMatchObject({ action: "fail", retryable: false });
	});

	it("destroys execution on shutdown without falsely failing the leased job", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const controller = new AbortController();
		const executeJob = vi.fn(
			async (options: ExecuteCloudRunnerJobOptions) =>
				new Promise<CloudRunnerExecutionResult>((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("container destroyed")), {
						once: true,
					});
				}),
		);
		const running = worker(runner, backend(), executeJob, { leaseRenewalMs: 50, heartbeatMs: 50 }).runNext(
			assignment,
			controller.signal,
		);
		await vi.waitFor(() => expect(executeJob).toHaveBeenCalledOnce());
		controller.abort();

		await expect(running).rejects.toThrow("worker stopped");
		expect(service.requests.some((request) => request.action === "fail")).toBe(false);
		expect(runner.leasedJobs()).toMatchObject([{ jobId, status: "leased" }]);
	});

	it("replays a staged completion after an ambiguous response without rerunning the container", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		service.failCompletionOnce = true;
		const executeJob = vi.fn(async () => ({
			...successfulExecution({ outcome: "durable" }),
			outputSnapshotId,
		}));
		const ephemeralWorker = worker(runner, backend(), executeJob);
		await expect(ephemeralWorker.runNext(assignment)).rejects.toThrow("completion response lost");
		expect(runner.pendingCompletion(jobId)).toEqual({ outcome: "durable" });

		await expect(ephemeralWorker.runNext(undefined)).resolves.toMatchObject({ status: "completed" });
		expect(executeJob).toHaveBeenCalledOnce();
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
		const ephemeralWorker = worker(runner, backend(), executeJob);
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
		const ephemeralWorker = worker(runner, backend(), executeJob);
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
		await expect(worker(runner, backend(), executeJob).runNext(assignment)).rejects.toThrow(
			"completion response lost",
		);
		const leaseExpiry = Date.parse(runner.leasedJobs()[0]?.leaseExpiresAt as string);

		await expect(
			worker(runner, backend(), executeJob, { now: () => leaseExpiry + 1 }).runNext(undefined),
		).resolves.toEqual({
			status: "idle",
		});
		expect(service.requests.filter((request) => request.action === "complete")).toHaveLength(1);
		expect(runner.leasedJobs()).toEqual([]);
		expect(executeJob).toHaveBeenCalledOnce();
	});
});
