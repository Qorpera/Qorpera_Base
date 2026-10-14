import { randomUUID } from "node:crypto";
import {
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
	parseCloudRunnerJob,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import { nativeProviderExecutionGuarantees } from "@qorpera/runtime/cloud-native-provider";
import {
	type CloudRunnerBrokerTransport,
	CloudRunnerJobBroker,
	NATIVE_AUTHORITY_LEASE_SECONDS,
} from "@qorpera/runtime/cloud-runner-broker";
import { DisposableCloudRunner } from "@qorpera/runtime/cloud-runner-control";
import { EphemeralCloudRunnerWorker } from "@qorpera/runtime/cloud-runner-worker";
import { describe, expect, it, vi } from "vitest";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const versionId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";
const runnerId = "88888888-8888-4888-8888-888888888888";
const runId = "89898989-8989-4989-8989-898989898989";
const assignmentId = "78787878-7878-4787-8787-787878787878";
const sponsorBindingId = "56565656-5656-4565-8565-565656565656";
const providerConnectionId = "67676767-6767-4676-8676-676767676767";
const staffAgentId = "69696969-6969-4969-8969-696969696969";
const computeIdentityId = "71717171-7171-4717-8717-717171717171";
const capsuleId = "72727272-7272-4727-8727-727272727272";
const leaseId = "73737373-7373-4737-8737-737373737373";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-09-29T08:00:00.000Z";
const capability = "l".repeat(43);
const assignment = { assignmentId, jobId, capability };

/** A folder-v2 run (folder core C3, P23): its job and its description name no Company File substrate. */
let folderRun = false;

function jobRecord(status: "leased" | "completed" = "leased", result: unknown = null) {
	return {
		job_id: jobId,
		run_id: runId,
		assignment_id: assignmentId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: null,
		substrate_version_id: folderRun ? null : versionId,
		client_job_id: "11111111-1111-4111-8111-111111111111",
		required_capability: "agent_turn",
		job_type: "agent_turn",
		payload: { schema: "qorpera.wake-run/v1" },
		status,
		attempt_count: 1,
		runner_id: runnerId,
		result,
		output_artifact_count: 0,
		output_artifact_index_id: null,
		output_substrate_version_id: null,
		last_error: null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		started_at: createdAt,
		lease_expires_at: status === "leased" ? new Date(Date.now() + 120_000).toISOString() : null,
		finished_at: null,
		cancelled_by_user_id: null,
		cancelled_at: null,
	};
}

/** qorpera_runner_broker_describe for a native company run (for a folder-v2 run, with no substrate anywhere). */
function descriptionRecord() {
	const description = snapshotDescriptionRecord();
	if (!folderRun) return description;
	return {
		...description,
		run: { ...description.run, substrate_version_id: null, company_snapshot_id: null },
		version: null,
		snapshot: null,
		artifact_index: null,
		company_file_output_limits: null,
	};
}

function snapshotDescriptionRecord() {
	return {
		company_runtime: "company-path-v1",
		job: jobRecord(),
		run: {
			run_id: runId,
			profile_id: profileId,
			environment_id: environmentId,
			source_kind: "wake",
			source_id: "12121212-1212-4212-8212-121212121212",
			session_id: null,
			job_id: jobId,
			substrate_version_id: versionId,
			company_snapshot_id: snapshotId,
			staff_agent_id: staffAgentId,
			staff_version: 3,
			input_ids: [],
			sponsor_binding_id: sponsorBindingId,
			sponsor_version: 1,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			payload_sha256: "9".repeat(64),
			publication_mode: "automatic",
			review_policy_key: null,
			reviewer_staff_ids: [],
			logical_computer_id: null,
			compute_identity_id: computeIdentityId,
			compute_identity_ownership_kind: "member",
			compute_identity_owner_user_id: actorUserId,
			compute_identity_owner_scope_key: null,
			transcript_start_sequence: 0,
			status: "runner_started",
			created_by_user_id: actorUserId,
			created_at: createdAt,
		},
		sponsor: {
			binding_id: sponsorBindingId,
			version: 1,
			kind: "member_connection",
			provider_connection_id: providerConnectionId,
			provider_connection_version: 2,
			provider: "openai",
			authentication_mode: "native_subscription",
			native_harness: "codex-cli",
			allow_autonomous: true,
		},
		version: {
			version_id: versionId,
			profile_id: profileId,
			environment_id: environmentId,
			company_snapshot_id: snapshotId,
			client_version_id: "99999999-9999-4999-8999-999999999999",
			contract_version: 1,
			operation_sequence: 2,
			operation_count: 1,
			artifact_index_id: artifactIndexId,
			artifact_manifest_sha256: "a".repeat(64),
			content_sha256: "b".repeat(64),
			created_by_user_id: actorUserId,
			created_at: createdAt,
		},
		snapshot: {
			snapshot_id: snapshotId,
			profile_id: profileId,
			environment_id: environmentId,
			workspace_id: workspaceId,
			client_snapshot_id: "55555555-5555-4555-8555-555555555555",
			parent_snapshot_id: null,
			tree_manifest_sha256: "c".repeat(64),
			tree_manifest_bytes: 128,
			tree_contract_version: 3,
			file_count: 1,
			total_bytes: 32,
			created_by_user_id: actorUserId,
			created_at: createdAt,
		},
		artifact_index: {
			index_id: artifactIndexId,
			profile_id: profileId,
			environment_id: environmentId,
			client_index_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			contract_version: 1,
			content_sha256: "a".repeat(64),
			artifact_count: 0,
			total_bytes: 0,
			created_by_user_id: actorUserId,
			created_at: createdAt,
		},
		output_limits: {
			max_object_bytes: 8 * 1024 * 1024,
			max_object_count: 100,
			max_total_bytes: 64 * 1024 * 1024,
			root_contract: "qorpera.object/v1",
		},
		company_file_output_limits: {
			max_object_bytes: 8 * 1024 * 1024,
			max_object_count: 509_602,
			max_total_bytes: 50 * 1024 * 1024 * 1024,
			tree_contract_version: 3,
		},
	};
}

/** qorpera_acquire_native_provider_connection_lease plus the run's model authority. */
function nativeAuthorityRecord() {
	return {
		lease_id: leaseId,
		run_id: runId,
		provider_connection_id: providerConnectionId,
		provider_connection_version: 2,
		credential_capsule_id: capsuleId,
		encrypted_capsule_reference: `model-login/${randomUUID()}`,
		attestation_policy_sha256: "d".repeat(64),
		compute_identity_id: computeIdentityId,
		compute_identity_ownership_kind: "member",
		compute_identity_owner_user_id: actorUserId,
		compute_identity_owner_scope_key: null,
		credential_ownership_kind: "member",
		credential_owner_user_id: actorUserId,
		credential_owner_scope_key: null,
		provider: "openai",
		authentication_mode: "native_subscription",
		native_harness: "codex-cli",
		runner_id: runnerId,
		assignment_id: assignmentId,
		expires_at: new Date(Date.now() + NATIVE_AUTHORITY_LEASE_SECONDS * 1000).toISOString(),
		model: { provider: "openai", model: "gpt-native" },
	};
}

/** Serial cloud round trips ("waves"): a call that starts while another is in flight shares its wave. */
function cloudWaves() {
	let inFlight = 0;
	let waves = 0;
	const calls: string[] = [];
	return {
		calls,
		get waves() {
			return waves;
		},
		async track<T>(call: string, perform: () => T | Promise<T>): Promise<T> {
			if (inFlight++ === 0) waves++;
			calls.push(call);
			try {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return await perform();
			} finally {
				inFlight--;
			}
		},
	};
}

type Waves = ReturnType<typeof cloudWaves>;

function brokerTransport(waves: Waves): CloudRunnerBrokerTransport {
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected broker call before execution");
	};
	return {
		describe: vi.fn(() => waves.track("describe", descriptionRecord)),
		acquireNativeAuthority: vi.fn((_authority, _runId, _assignmentId, leaseSeconds: number) => {
			expect(leaseSeconds).toBe(NATIVE_AUTHORITY_LEASE_SECONDS);
			return waves.track("native_authority", nativeAuthorityRecord);
		}),
		renewNativeAuthority: vi.fn((_authority, lease: string) =>
			waves.track("renew_native_authority", () => ({
				lease_id: lease,
				run_id: runId,
				status: "active",
				expires_at: new Date(Date.now() + 120_000).toISOString(),
			})),
		),
		releaseNativeAuthority: vi.fn((_authority, lease: string, status) =>
			waves.track("release_native_authority", () => ({ lease_id: lease, status })),
		),
		listInputs: unexpected,
		listTranscript: unexpected,
		listOperations: unexpected,
		listArtifacts: unexpected,
		requestModel: unexpected,
		beginOperation: unexpected,
		completeOperation: unexpected,
		bindProviderSession: unexpected,
		appendTranscriptEvent: unexpected,
	};
}

/** The runner control Edge Function: `start` as the new function answers it, or as an older
 * function (400, it does not know the action) or database (501, no function) refuses it. */
function controlTransport(waves: Waves, start: "combined" | "deferred" | 400 | 501): CloudRunnerControlTransport {
	return {
		request: (_token, body: CloudRunnerControlRequest) => {
			if (body.action === "activate") {
				return Promise.resolve({
					runner_id: runnerId,
					profile_id: profileId,
					client_runner_id: actorUserId,
					display_name: "Runner start fixture",
					runner_kind: "qorpera_computer",
					capabilities: ["agent_turn"],
					max_concurrency: 1,
					status: "active",
					online: true,
					activation_expires_at: new Date(Date.now() + 900_000).toISOString(),
					session_expires_at: new Date(Date.now() + 900_000).toISOString(),
					registered_by_user_id: actorUserId,
					created_at: createdAt,
					active_lease_count: 0,
				});
			}
			return waves.track(body.action, () => {
				if (body.action === "start") {
					if (typeof start === "number") throw new CloudRunnerControlRequestError(start);
					expect(body.nativeLeaseSeconds).toBe(NATIVE_AUTHORITY_LEASE_SECONDS);
					return start === "combined"
						? { job: jobRecord(), description: descriptionRecord(), native_authority: nativeAuthorityRecord() }
						: { job: jobRecord(), description: null, native_authority: null };
				}
				if (body.action === "accept" || body.action === "renew") return jobRecord();
				if (body.action === "complete") return jobRecord("completed", body.result);
				throw new Error(`Unexpected runner action ${body.action}`);
			});
		},
	};
}

async function nativeWorker(start: Parameters<typeof controlTransport>[1]) {
	const waves = cloudWaves();
	const runner = new DisposableCloudRunner(controlTransport(waves, start), runnerId, "a".repeat(43));
	await runner.activate("linux-x64", "start-test");
	let wavesAtStart: number | undefined;
	const startCompany = vi.fn(async () => {
		wavesAtStart = waves.waves;
		return {
			result: Promise.resolve({
				schema: "qorpera.native-harness-result/v2",
				run_id: runId,
				message_count: 0,
				final_message_id: null,
				provider_session_id: randomUUID(),
			}),
			terminate: async () => {},
		};
	});
	const broker = brokerTransport(waves);
	const worker = new EphemeralCloudRunnerWorker({
		runner,
		brokerTransport: broker,
		nativeProviderBridge: {
			executionGuarantees: nativeProviderExecutionGuarantees("virtual_machine"),
			startCompany,
		},
		platform: "linux-x64",
		runnerVersion: "start-test",
	});
	return {
		waves,
		broker,
		startCompany,
		runNext: async () => {
			const result = await worker.runNext(assignment);
			return { result, wavesAtStart, calls: [...waves.calls] };
		},
	};
}

describe("runner start", () => {
	it("hands a native company run to its computer after one cloud round trip", async () => {
		const f = await nativeWorker("combined");
		const { result, wavesAtStart, calls } = await f.runNext();
		expect(result.status).toBe("completed");
		// Before: accept, describe, native authority and an immediate renewal (4 waves).
		expect(wavesAtStart).toBe(1);
		expect(calls).toEqual(["start", "complete"]);
		// The job's lease token (the assignment's capability) travels with it, for the host's calls (G2-2).
		expect(f.startCompany).toHaveBeenCalledWith(
			expect.objectContaining({ leaseId, runId, assignmentId, runnerId, model: "gpt-native" }),
			{ jobId, attemptCount: 1, leaseToken: capability },
		);
		expect(f.broker.describe).not.toHaveBeenCalled();
		expect(f.broker.acquireNativeAuthority).not.toHaveBeenCalled();
		expect(f.broker.renewNativeAuthority).not.toHaveBeenCalled();
	});

	it("hands a folder-v2 run (no Company File substrate) to its computer and completes it naming none", async () => {
		folderRun = true;
		try {
			const f = await nativeWorker("deferred");
			const { result } = await f.runNext();
			// The completed job echoes the completion's result: the path lane's, naming no substrate.
			expect(result).toMatchObject({
				status: "completed",
				job: { result: { runtime: "company-path-v1", substrate_version_id: null } },
			});
			expect(f.startCompany).toHaveBeenCalledOnce();
			expect(f.broker.describe).toHaveBeenCalled();
		} finally {
			folderRun = false;
		}
	});

	it("makes the separate calls when the cloud deferred the start's reads", async () => {
		const f = await nativeWorker("deferred");
		const { result, wavesAtStart, calls } = await f.runNext();
		expect(result.status).toBe("completed");
		expect(wavesAtStart).toBe(3);
		expect(calls).toEqual(["start", "describe", "native_authority", "complete"]);
	});

	it.each([400, 501] as const)(
		"accepts alone and makes the separate calls on a control plane without the start (%s)",
		async (status) => {
			const f = await nativeWorker(status);
			const { result, wavesAtStart, calls } = await f.runNext();
			expect(result.status).toBe("completed");
			// One refused start, then today's acceptance, description and authority.
			expect(wavesAtStart).toBe(4);
			expect(calls).toEqual(["start", "accept", "describe", "native_authority", "complete"]);
		},
	);
});

describe("job broker with a runner start", () => {
	function startedBroker(start: ConstructorParameters<typeof CloudRunnerJobBroker>[0]["start"]) {
		const waves = cloudWaves();
		const transport = brokerTransport(waves);
		const broker = new CloudRunnerJobBroker({
			job: parseCloudRunnerJob(jobRecord()),
			runnerId,
			credentials: () => ({ sessionToken: "s".repeat(43), leaseToken: capability }),
			transport,
			...(start ? { start } : {}),
		});
		return { broker, transport };
	}

	it("serves the start's description and authority once, validated like the separate calls", async () => {
		const { broker, transport } = startedBroker({
			description: descriptionRecord(),
			nativeAuthority: { value: nativeAuthorityRecord(), leaseSeconds: NATIVE_AUTHORITY_LEASE_SECONDS },
		});
		await expect(broker.describe()).resolves.toMatchObject({ companyRuntime: "company-path-v1", job: { jobId } });
		await expect(broker.acquireNativeAuthority()).resolves.toMatchObject({ leaseId, model: "gpt-native" });
		expect(transport.describe).not.toHaveBeenCalled();
		expect(transport.acquireNativeAuthority).not.toHaveBeenCalled();
		// A second acquisition is a new request.
		await broker.acquireNativeAuthority();
		expect(transport.acquireNativeAuthority).toHaveBeenCalledTimes(1);
	});

	it("asks the cloud when the start's authority was for another lease length", async () => {
		const { broker, transport } = startedBroker({
			description: descriptionRecord(),
			nativeAuthority: { value: nativeAuthorityRecord(), leaseSeconds: 300 },
		});
		await broker.acquireNativeAuthority();
		expect(transport.acquireNativeAuthority).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"another job's description",
			{ ...descriptionRecord(), job: { ...jobRecord(), job_id: randomUUID() } },
			undefined,
		],
		["an unknown runtime", { ...descriptionRecord(), company_runtime: "company-path-v2" }, undefined],
		["another runner's authority", descriptionRecord(), { ...nativeAuthorityRecord(), runner_id: randomUUID() }],
		[
			"another assignment's authority",
			descriptionRecord(),
			{ ...nativeAuthorityRecord(), assignment_id: randomUUID() },
		],
		[
			"another connection's authority",
			descriptionRecord(),
			{ ...nativeAuthorityRecord(), provider_connection_id: randomUUID() },
		],
		[
			"a model for another provider",
			descriptionRecord(),
			{ ...nativeAuthorityRecord(), model: { provider: "anthropic", model: "x" } },
		],
	] as const)(
		"refuses %s exactly as it refuses the separate call's answer",
		async (_label, description, authority) => {
			const { broker } = startedBroker({
				description,
				...(authority
					? { nativeAuthority: { value: authority, leaseSeconds: NATIVE_AUTHORITY_LEASE_SECONDS } }
					: {}),
			});
			const separate = startedBroker(undefined);
			separate.transport.describe = vi.fn(async () => description);
			if (authority) separate.transport.acquireNativeAuthority = vi.fn(async () => authority);
			const outcome = (current: CloudRunnerJobBroker) =>
				current
					.acquireNativeAuthority()
					.then(() => "accepted")
					.catch((error: Error) => error.message);
			const refused = await outcome(broker);
			expect(refused).not.toBe("accepted");
			expect(refused).toBe(await outcome(separate.broker));
		},
	);
});
