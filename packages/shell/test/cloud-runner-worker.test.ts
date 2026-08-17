import type { JsonValue } from "@qorpera/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import type { CloudRunnerBrokerTransport } from "../src/cloud-runner-broker.ts";
import {
	type CloudRunnerControlRequest,
	type CloudRunnerControlTransport,
	DisposableCloudRunner,
} from "../src/cloud-runner-control.ts";
import type {
	CloudRunnerExecutionResult,
	CloudRunnerSandboxBackend,
	CloudRunnerSandboxGuarantees,
	ExecuteCloudRunnerJobOptions,
} from "../src/cloud-runner-sandbox.ts";
import { EphemeralCloudRunnerWorker } from "../src/cloud-runner-worker.ts";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const clientRunnerId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const actorUserId = "ec30142e-47c8-4532-a6c4-10612d02c619";
const jobId = "b953532a-c4f0-4b81-b901-d4bb21237001";
const environmentId = "b953532a-c4f0-4b81-b901-d4bb21237002";
const substrateVersionId = "b953532a-c4f0-4b81-b901-d4bb21237003";
const clientJobId = "b953532a-c4f0-4b81-b901-d4bb21237004";
const createdAt = "2026-08-17T00:00:00.000Z";
const activationToken = "a".repeat(43);

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

	async request(_token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		this.requests.push(structuredClone(body));
		if (body.action === "activate" || body.action === "heartbeat") {
			return runnerRecord(this.status === "leased" ? 1 : 0);
		}
		if (body.action === "claim") {
			if (this.status !== "queued") return null;
			this.status = "leased";
			return jobRecord("leased");
		}
		if (body.action === "renew") return jobRecord("leased");
		if (body.action === "complete") {
			this.status = "completed";
			if (this.failCompletionOnce) {
				this.failCompletionOnce = false;
				throw new Error("completion response lost");
			}
			return jobRecord("completed", body.result);
		}
		this.status = body.retryable ? "queued" : "failed";
		return jobRecord(this.status);
	}
}

const guarantees: CloudRunnerSandboxGuarantees = {
	boundary: "rootless_container",
	hostFilesystem: "none",
	inputFilesystem: "read_only",
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
		listOperations: vi.fn(async () => []),
		listArtifacts: vi.fn(async () => []),
		getObject: vi.fn(async () => new Uint8Array()),
		putObject: vi.fn(async () => "stored" as const),
		registerArtifact: vi.fn(async () => ({})),
	};
}

function successfulExecution(result: JsonValue = { outcome: "ok" }): CloudRunnerExecutionResult {
	return { result, outputFiles: [], outputBytes: 0 };
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
	options: { leaseRenewalMs?: number; heartbeatMs?: number } = {},
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
	it("claims, executes, publishes through the broker boundary, and completes", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const serviceBackend = backend();
		const executeJob = vi.fn(async (_options: ExecuteCloudRunnerJobOptions) =>
			successfulExecution({ outcome: "built" }),
		);

		const result = await worker(runner, serviceBackend, executeJob).runNext();

		expect(result).toMatchObject({ status: "completed", job: { jobId, status: "completed" } });
		expect(serviceBackend.prepare).toHaveBeenCalledOnce();
		expect(executeJob).toHaveBeenCalledOnce();
		expect(executeJob.mock.calls[0]?.[0]).toMatchObject({
			job: { jobId, substrateVersionId },
			backend: serviceBackend,
		});
		expect(service.requests.map((request) => request.action)).toEqual(["activate", "claim", "complete"]);
		expect(runner.leasedJobs()).toEqual([]);
	});

	it("renews the lease and heartbeat serially while a container is running", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const executeJob = vi.fn(
			async () =>
				new Promise<CloudRunnerExecutionResult>((resolveExecution) => {
					setTimeout(() => resolveExecution(successfulExecution()), 45);
				}),
		);

		await worker(runner, backend(), executeJob, { leaseRenewalMs: 10, heartbeatMs: 20 }).runNext();

		const actions = service.requests.map((request) => request.action);
		expect(actions.filter((action) => action === "renew").length).toBeGreaterThanOrEqual(2);
		expect(actions).toContain("heartbeat");
		expect(actions.at(-1)).toBe("complete");
	});

	it("reports deterministic job-contract failures without retrying them", async () => {
		const service = new RunnerService();
		const runner = await activeRunner(service);
		const result = await worker(runner, backend(), async () => {
			throw new Error("Runner substrate is inconsistent");
		}).runNext();

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
		const executeJob = vi.fn(async () => successfulExecution({ outcome: "durable" }));
		const ephemeralWorker = worker(runner, backend(), executeJob);
		await expect(ephemeralWorker.runNext()).rejects.toThrow("completion response lost");
		expect(runner.pendingCompletion(jobId)).toEqual({ outcome: "durable" });

		await expect(ephemeralWorker.runNext()).resolves.toMatchObject({ status: "completed" });
		expect(executeJob).toHaveBeenCalledOnce();
		const completions = service.requests.filter((request) => request.action === "complete");
		expect(completions).toHaveLength(2);
		expect(completions[0]).toEqual(completions[1]);
	});
});
