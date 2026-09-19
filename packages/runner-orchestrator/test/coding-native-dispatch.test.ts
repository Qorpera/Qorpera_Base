import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingNativeDispatchOptions, runCodingNativeTurn } from "../src/coding-native-dispatch.ts";
import type { CloudRunnerProviderAdapter } from "../src/orchestrator.ts";

const paths: string[] = [];
afterEach(async () => {
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-native-dispatch-")));
	paths.push(root);
	const requestId = randomUUID(),
		leaseToken = randomUUID(),
		orchestratorId = randomUUID(),
		occurrenceId = randomUUID();
	const runId = randomUUID(),
		jobId = randomUUID(),
		runnerId = randomUUID();
	const worker = {
		schema: "qorpera.coding-worker/v1",
		id: randomUUID(),
		companyId: randomUUID(),
		parentAgentId: randomUUID(),
		parentRunId: randomUUID(),
		repository: { host: "github.com", owner: "Qorpera", name: "app", baseBranch: "main" },
		branch: "",
		vmId: randomUUID(),
		version: 4,
		state: "running",
		turn: 1,
		pullRequest: null,
	};
	worker.branch = `qorpera/${worker.id}`;
	const finish = {
		schema: "qorpera.coding-finish/v1",
		requestId,
		workerId: worker.id,
		turn: 1,
		state: "ready-to-publish",
		summary: "Build passed",
		headSha: "f".repeat(40),
	};
	let state = "materialized";
	let submitted = false;
	let materialize = false;
	const work = {
		run_id: runId,
		job_id: jobId,
		profile_id: worker.companyId,
		environment_id: randomUUID(),
		source_kind: "wake",
		source_id: occurrenceId,
		substrate_version_id: randomUUID(),
		company_snapshot_id: randomUUID(),
		staff_agent_id: worker.parentAgentId,
		staff_version: 1,
		input_ids: [],
		transcript_start_sequence: 0,
		deadline_at: new Date(Date.now() + 60000).toISOString(),
		required_capability: "agent_turn",
		job_type: "agent_turn",
		payload: { schema: "qorpera.coding-run/v1", requestId, occurrenceId },
		publication_mode: "automatic",
		reviewer_staff_ids: [],
		worker_class: "managed_sandbox",
		requested_by_user_id: randomUUID(),
		sponsor: {
			binding_id: randomUUID(),
			version: 1,
			kind: "member_connection",
			provider_connection_id: randomUUID(),
			provider_connection_version: 1,
			provider: "openai",
			authentication_mode: "api_key",
			native_harness: "codex-cli",
			allow_autonomous: false,
		},
		model_policy: {
			allowed_models: [{ provider: "openai", model: "test" }],
			max_calls: 32,
			max_input_tokens: 10000,
			max_output_tokens: 5000,
			max_cost_microusd: 10000,
		},
		attempt: 1,
	};
	const call = vi.fn<CodingNativeDispatchOptions["codingControl"]["call"]>(async (method, args) => {
		if (method === "qorpera_prepare_coding_execution")
			return { schema: "qorpera.coding-execution-admission/v1", requestId, occurrenceId };
		if (method === "qorpera_describe_coding_execution")
			return {
				schema: "qorpera.coding-execution/v1",
				requestId,
				workerId: worker.id,
				turn: worker.turn,
				vmId: worker.vmId,
				worker,
				occurrenceId,
				runId: materialize ? null : runId,
				jobId: materialize ? null : jobId,
				admissionState: materialize ? "queued" : state,
				finish: submitted ? finish : null,
			};
		if (method === "qorpera_materialize_wake_execution_runs") {
			materialize = false;
			return 1;
		}
		return {
			claim_id: args.p_client_claim_id,
			orchestrator_id: orchestratorId,
			status: "claimed",
			lease_expires_at: new Date(Date.now() + 60000).toISOString(),
			work,
		};
	});
	const http = vi.fn<NonNullable<CodingNativeDispatchOptions["controlPlaneConfig"]["fetch"]>>(async (_url, init) => {
		const input = JSON.parse(String(init?.body));
		if (input.action === "rotate_control") return new Response(JSON.stringify({ value: null }));
		if (input.action === "assign")
			return new Response(
				JSON.stringify({
					value: {
						assignment_id: input.clientAssignmentId,
						claim_id: input.claimId,
						run_id: runId,
						job_id: jobId,
						runner_id: runnerId,
						capability_sha256: input.capabilitySha256,
						expires_at: new Date(Date.now() + 60000).toISOString(),
					},
				}),
			);
		throw new Error(`Unexpected generic action ${input.action}`);
	});
	const acquire = vi.fn<CloudRunnerProviderAdapter["acquire"]>(async () => ({
		runnerId,
		providerAdapter: "local",
		workerClass: "managed_sandbox",
		capabilities: ["agent_turn"],
		templateKey: "test",
		templateVersion: "v1",
		policySha256: "a".repeat(64),
	}));
	const deliver = vi.fn<CloudRunnerProviderAdapter["deliver"]>(async () => {
		state = "completed";
		submitted = true;
	});
	const stop = vi.fn<CloudRunnerProviderAdapter["stop"]>(async () => undefined);
	const reconcile = vi.fn(async () => undefined);
	const options: CodingNativeDispatchOptions = {
		requestId,
		leaseToken,
		orchestratorId,
		controlPlaneConfig: {
			supabaseUrl: "https://control.example.org",
			publishableKey: "public-test-key",
			controlToken: "a".repeat(43),
			controlStatePath: join(root, "control.json"),
			fetch: http,
		},
		codingControl: { call },
		providerAdapter: { adapterId: "local", acquire, deliver, stop, reconcile },
		signal: new AbortController().signal,
		pollIntervalMs: 10,
	};
	return {
		options,
		call,
		http,
		work,
		worker,
		finish,
		acquire,
		deliver,
		stop,
		reconcile,
		setState: (value: string) => {
			state = value;
		},
		setSubmitted: (value: boolean) => {
			submitted = value;
		},
		queue: () => {
			materialize = true;
		},
	};
}

describe("exact coding native canonical dispatch", () => {
	it("materializes and dispatches only its exact coding job through the real orchestrator and waits for durable finish", async () => {
		const f = await fixture();
		f.queue();
		expect(await runCodingNativeTurn(f.options)).toMatchObject({ worker: f.worker, finish: f.finish });
		expect(f.call.mock.calls.some(([method]) => method === "qorpera_materialize_wake_execution_runs")).toBe(true);
		expect(f.acquire).toHaveBeenCalledTimes(1);
		expect(f.deliver).toHaveBeenCalledTimes(1);
		expect(f.reconcile).not.toHaveBeenCalled();
		expect(f.http.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual([
			"rotate_control",
			"assign",
		]);
	});
	it("waits beyond assignment delivery until actual native completion", async () => {
		const f = await fixture();
		f.deliver.mockImplementation(async () => {
			setTimeout(() => {
				f.setState("completed");
				f.setSubmitted(true);
			}, 35);
		});
		expect(await runCodingNativeTurn(f.options)).toMatchObject({ finish: f.finish });
		expect(
			f.call.mock.calls.filter(([method]) => method === "qorpera_describe_coding_execution").length,
		).toBeGreaterThan(3);
	});
	it("does not provision or deliver an already completed native turn", async () => {
		const f = await fixture();
		f.setState("completed");
		f.setSubmitted(true);
		await runCodingNativeTurn(f.options);
		expect(f.acquire).not.toHaveBeenCalled();
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each(["generic", "other-request", "other-occurrence", "extra-key"])(
		"refuses a substituted claim %s before acquiring",
		async (mode) => {
			const f = await fixture();
			if (mode === "generic") f.work.payload.schema = "qorpera.wake-run/v1";
			if (mode === "other-request") f.work.payload.requestId = randomUUID();
			if (mode === "other-occurrence") f.work.payload.occurrenceId = randomUUID();
			if (mode === "extra-key") Object.assign(f.work.payload, { allowAutonomous: true });
			await expect(runCodingNativeTurn(f.options)).rejects.toThrow();
			expect(f.acquire).not.toHaveBeenCalled();
		},
	);
	it("preserves an unknown assignment and durable intent, never retrying after process replacement", async () => {
		const f = await fixture();
		f.http.mockImplementation(async (_url, init) => {
			if (JSON.parse(String(init?.body)).action === "assign") throw new Error("Lost assignment response");
			return new Response(JSON.stringify({ value: null }));
		});
		await expect(runCodingNativeTurn(f.options)).rejects.toThrow("Lost assignment");
		expect(f.stop).not.toHaveBeenCalled();
		expect(f.deliver).not.toHaveBeenCalled();
		await expect(runCodingNativeTurn({ ...f.options, signal: AbortSignal.timeout(60) })).rejects.toThrow();
		expect(f.acquire).toHaveBeenCalledTimes(1);
		expect(f.call.mock.calls.filter(([method]) => method === "qorpera_claim_coding_execution")).toHaveLength(1);
	});
	it("rejects a failed job or successful job without a durable submission", async () => {
		for (const state of ["failed", "completed"]) {
			const f = await fixture();
			f.setState(state);
			await expect(runCodingNativeTurn(f.options)).rejects.toThrow();
			expect(f.acquire).not.toHaveBeenCalled();
		}
	});
});
