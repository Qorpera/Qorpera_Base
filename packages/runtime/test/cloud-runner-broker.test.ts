import { parseCloudRunnerJob } from "@qorpera/cloud-client/node/cloud-runner-protocol";
import {
	type CloudRunnerBrokerAuthority,
	CloudRunnerBrokerRequestError,
	type CloudRunnerBrokerTransport,
	CloudRunnerJobBroker,
	NATIVE_AUTHORITY_LEASE_SECONDS,
	SupabaseCloudRunnerBrokerTransport,
} from "@qorpera/runtime/cloud-runner-broker";
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
const sessionId = "45454545-4545-4454-8545-454545454545";
const sponsorBindingId = "56565656-5656-4565-8565-565656565656";
const providerConnectionId = "67676767-6767-4676-8676-676767676767";
const staffAgentId = "69696969-6969-4969-8969-696969696969";
const computeIdentityId = "71717171-7171-4717-8717-717171717171";
const capsuleId = "72727272-7272-4727-8727-727272727272";
const leaseId = "73737373-7373-4737-8737-737373737373";
const otherId = "13131313-1313-4313-8313-131313131313";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-17T01:00:00.000Z";
const sessionToken = "s".repeat(43);
const leaseToken = "l".repeat(43);
const RUNTIME_REFUSAL = "Runner broker returned an invalid Company File runtime selection";
const SUBSTRATE_REFUSAL = "Runner broker returned a run with a Company File substrate";

/** A folder-v2 run's leased job: no Company File substrate. */
function jobRecord(): Record<string, unknown> {
	return {
		job_id: jobId,
		run_id: runId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: sessionId,
		substrate_version_id: null,
		client_job_id: "11111111-1111-4111-8111-111111111111",
		assignment_id: assignmentId,
		required_capability: "agent_turn",
		job_type: "agent_turn",
		payload: { prompt: "Run safely" },
		status: "leased",
		attempt_count: 1,
		runner_id: runnerId,
		result: null,
		output_artifact_count: 0,
		output_artifact_index_id: null,
		output_substrate_version_id: null,
		last_error: null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		started_at: createdAt,
		lease_expires_at: "2026-08-17T01:02:00.000Z",
		finished_at: null,
		cancelled_by_user_id: null,
		cancelled_at: null,
	};
}

/** qorpera_folder_runner_broker_describe (folder core C3, P23): the path lane with no substrate anywhere. */
function descriptionRecord(): Record<string, unknown> {
	return {
		company_runtime: "company-path-v1",
		job: jobRecord(),
		run: {
			run_id: runId,
			profile_id: profileId,
			environment_id: environmentId,
			source_kind: "wake",
			source_id: "12121212-1212-4212-8212-121212121212",
			session_id: sessionId,
			job_id: jobId,
			substrate_version_id: null,
			company_snapshot_id: null,
			// The folder clock's pin (folder core C4, P28: qorpera_folder_runner_broker_describe sends it).
			company_seq: 7,
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
			transcript_start_sequence: 1,
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
		version: null,
		snapshot: null,
		proposal_snapshot: null,
		artifact_index: null,
		output_limits: {
			max_object_bytes: 8 * 1024 * 1024,
			max_object_count: 100,
			max_total_bytes: 64 * 1024 * 1024,
			root_contract: "qorpera.object/v1",
		},
		company_file_output_limits: null,
	};
}

/** The whole-tree lane's description of a snapshot-v1 run (removed in legacy sweep step C): a substrate everywhere. */
function wholeTreeRecord(): Record<string, unknown> {
	const folder = descriptionRecord();
	return {
		...folder,
		company_runtime: "whole-tree-v1",
		job: { ...jobRecord(), substrate_version_id: versionId },
		run: {
			...(folder.run as Record<string, unknown>),
			substrate_version_id: versionId,
			company_snapshot_id: snapshotId,
			company_seq: null,
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
		company_file_output_limits: {
			max_object_bytes: 8 * 1024 * 1024,
			max_object_count: 509_602,
			max_total_bytes: 50 * 1024 * 1024 * 1024,
			tree_contract_version: 3,
		},
	};
}

/** qorpera_acquire_native_provider_connection_lease plus the run's model authority. */
function nativeAuthorityRecord(): Record<string, unknown> {
	return {
		lease_id: leaseId,
		run_id: runId,
		provider_connection_id: providerConnectionId,
		provider_connection_version: 2,
		credential_capsule_id: capsuleId,
		encrypted_capsule_reference: "model-login/fixture",
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

class MemoryBrokerTransport implements CloudRunnerBrokerTransport {
	readonly actions: string[] = [];
	readonly authorities: CloudRunnerBrokerAuthority[] = [];
	readonly description = descriptionRecord();

	async describe(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.#called("describe", authority);
		return this.description;
	}

	async acquireNativeAuthority(
		authority: CloudRunnerBrokerAuthority,
		receivedRunId: string,
		receivedAssignmentId: string,
		leaseSeconds: number,
	): Promise<unknown> {
		this.#called("native_authority", authority);
		expect(receivedRunId).toBe(runId);
		expect(receivedAssignmentId).toBe(assignmentId);
		expect(leaseSeconds).toBe(NATIVE_AUTHORITY_LEASE_SECONDS);
		return nativeAuthorityRecord();
	}

	async renewNativeAuthority(
		authority: CloudRunnerBrokerAuthority,
		receivedLeaseId: string,
		leaseSeconds: number,
	): Promise<unknown> {
		this.#called("renew_native_authority", authority);
		return {
			lease_id: receivedLeaseId,
			run_id: runId,
			status: "active",
			expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
		};
	}

	async releaseNativeAuthority(
		authority: CloudRunnerBrokerAuthority,
		receivedLeaseId: string,
		status: "released" | "revoked" | "expired",
	): Promise<unknown> {
		this.#called("release_native_authority", authority);
		return { lease_id: receivedLeaseId, status };
	}

	#called(action: string, authority: CloudRunnerBrokerAuthority): void {
		this.actions.push(action);
		this.authorities.push({ ...authority });
	}
}

function broker(description?: Record<string, unknown>): {
	broker: CloudRunnerJobBroker;
	transport: MemoryBrokerTransport;
} {
	const transport = new MemoryBrokerTransport();
	if (description) Object.assign(transport.description, description);
	return {
		broker: new CloudRunnerJobBroker({
			job: parseCloudRunnerJob(jobRecord()),
			runnerId,
			credentials: () => ({ sessionToken, leaseToken }),
			transport,
		}),
		transport,
	};
}

describe("cloud runner object broker", () => {
	it.each([undefined, null, "company-path-v2", "", "whole-tree-v1"])(
		"rejects a missing or unknown cloud runtime selection (%s)",
		async (mode) => {
			const current = broker();
			current.transport.description.company_runtime = mode;
			await expect(current.broker.describe()).rejects.toThrow("runtime selection");
		},
	);

	it("rejects non-HTTP loopback broker URLs", () => {
		expect(() => new SupabaseCloudRunnerBrokerTransport("file://localhost/private", "publishable-key")).toThrow(
			"must use HTTPS",
		);
	});

	it("binds every broker call to the leased job and refreshes credentials for each", async () => {
		const memory = new MemoryBrokerTransport();
		let currentSessionToken = sessionToken;
		const current = new CloudRunnerJobBroker({
			job: parseCloudRunnerJob(jobRecord()),
			runnerId,
			credentials: () => ({ sessionToken: currentSessionToken, leaseToken }),
			transport: memory,
		});

		await expect(current.describe()).resolves.toMatchObject({
			job: { jobId, runId, assignmentId },
			run: { runId, jobId },
		});
		const authority = await current.acquireNativeAuthority();
		expect(authority).toMatchObject({ leaseId, runId, assignmentId, runnerId });
		currentSessionToken = "n".repeat(43);
		await expect(current.renewNativeAuthority()).resolves.toMatchObject({ leaseId, runId });
		await current.releaseNativeAuthority();
		expect(memory.actions).toEqual([
			"describe",
			"native_authority",
			"renew_native_authority",
			"release_native_authority",
		]);
		expect(memory.authorities).toEqual([
			{ runnerId, jobId, sessionToken, leaseToken },
			{ runnerId, jobId, sessionToken, leaseToken },
			{ runnerId, jobId, sessionToken: currentSessionToken, leaseToken },
			{ runnerId, jobId, sessionToken: currentSessionToken, leaseToken },
		]);
	});

	it.each([
		["another job", { job: { ...jobRecord(), job_id: otherId } }],
		["another assignment", { job: { ...jobRecord(), assignment_id: otherId } }],
		["another job's run", { run: { ...(descriptionRecord().run as Record<string, unknown>), job_id: otherId } }],
		[
			"another sponsor binding",
			{ sponsor: { ...(descriptionRecord().sponsor as Record<string, unknown>), binding_id: otherId } },
		],
		// The broker refuses a proposal review on folder-v2 (0A000): it reads a proposal snapshot, which a folder-v2 run
		// has none of.
		[
			"a proposal review",
			{ run: { ...(descriptionRecord().run as Record<string, unknown>), source_kind: "proposal_review" } },
		],
	])("refuses a description of %s", async (_label, change) => {
		await expect(broker(change).broker.describe()).rejects.toThrow("another job substrate");
	});

	it("acquires a native authority only for a native subscription sponsor", async () => {
		const current = broker();
		Object.assign(current.transport.description.sponsor as Record<string, unknown>, {
			authentication_mode: "api_key",
			native_harness: "openai-responses",
		});
		await expect(current.broker.acquireNativeAuthority()).rejects.toThrow("does not use a native subscription");
		expect(current.transport.actions).toEqual(["describe"]);
	});

	it("keeps runner credentials out of broker URLs and request bodies", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return Response.json({ value: {} });
		}) as typeof fetch;
		const transport = new SupabaseCloudRunnerBrokerTransport(
			"https://example.supabase.co",
			"publishable-key",
			fetchImplementation,
		);
		const authority = { runnerId, jobId, sessionToken, leaseToken };

		await transport.describe(authority);
		await transport.acquireNativeAuthority(authority, runId, assignmentId, NATIVE_AUTHORITY_LEASE_SECONDS);
		await transport.renewNativeAuthority(authority, leaseId, NATIVE_AUTHORITY_LEASE_SECONDS);
		await transport.releaseNativeAuthority(authority, leaseId, "released");

		expect(calls).toHaveLength(4);
		for (const call of calls) {
			expect(call.url).toBe("https://example.supabase.co/functions/v1/runner-broker");
			expect(call.url).not.toContain(sessionToken);
			expect(call.url).not.toContain(leaseToken);
			expect(String(call.init?.body)).not.toContain(sessionToken);
			expect(String(call.init?.body)).not.toContain(leaseToken);
			expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
			expect(new Headers(call.init?.headers).get("x-qorpera-lease-token")).toBe(leaseToken);
		}
		expect(String(calls[1]?.init?.body)).toContain('"action":"native_authority"');
	});

	it("aborts a stalled broker request when its job execution is fenced", async () => {
		const execution = new AbortController();
		const fetchImplementation = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return reject(new Error("missing request signal"));
					if (signal.aborted) return reject(signal.reason);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const transport = new SupabaseCloudRunnerBrokerTransport(
			"https://example.supabase.co",
			"publishable-key",
			fetchImplementation as typeof fetch,
			{ requestTimeoutMs: 1_000 },
		);
		const request = transport.describe({ runnerId, jobId, sessionToken, leaseToken, signal: execution.signal });
		execution.abort(new Error("job lease lost"));
		await expect(request).rejects.toThrow("job lease lost");
	});
});

describe("cloud runner broker transient retries", () => {
	it("retries transient action statuses briefly and returns the recovered response", async () => {
		vi.useFakeTimers();
		try {
			const statuses = [503, 429, 200];
			let calls = 0;
			const fetchImplementation = (async () => {
				calls++;
				const status = statuses.shift() ?? 200;
				if (status !== 200) return new Response("shed", { status });
				return Response.json({ value: { recovered: true } });
			}) as typeof fetch;
			const transport = new SupabaseCloudRunnerBrokerTransport(
				"https://qorpera.example",
				"publishable-key",
				fetchImplementation,
			);
			const pending = transport.describe({ runnerId, jobId, sessionToken, leaseToken });
			await vi.advanceTimersByTimeAsync(2_000);
			await vi.advanceTimersByTimeAsync(4_000);
			await expect(pending).resolves.toEqual({ recovered: true });
			expect(calls).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails definitive action statuses without retrying", async () => {
		let calls = 0;
		const fetchImplementation = (async () => {
			calls++;
			return new Response("rejected", { status: 400 });
		}) as typeof fetch;
		const transport = new SupabaseCloudRunnerBrokerTransport(
			"https://qorpera.example",
			"publishable-key",
			fetchImplementation,
		);
		await expect(transport.describe({ runnerId, jobId, sessionToken, leaseToken })).rejects.toThrow(
			"Runner broker request (describe) failed (400)",
		);
		expect(calls).toBe(1);
	});

	it("fails an answer cut while its body arrives as a lost one, but a malformed or stopped one as before (WB-001, 28 Oct 2026)", async () => {
		const execution = new AbortController();
		const authority = { runnerId, jobId, sessionToken, leaseToken, signal: execution.signal };
		const answering = (body: () => ConstructorParameters<typeof Response>[0]) =>
			new SupabaseCloudRunnerBrokerTransport(
				"https://qorpera.example",
				"publishable-key",
				(async () => new Response(body())) as typeof fetch,
			);
		const cut = await answering(
			() =>
				new ReadableStream({
					start: (controller) => controller.enqueue(new TextEncoder().encode('{"value":')),
					pull: (controller) => controller.error(new TypeError("terminated")),
				}),
		)
			.renewNativeAuthority(authority, leaseId, NATIVE_AUTHORITY_LEASE_SECONDS)
			.catch((error: unknown) => error);
		expect(cut).toBeInstanceOf(CloudRunnerBrokerRequestError);
		expect(cut).toMatchObject({
			message: "Runner broker request (renew_native_authority) failed",
			status: undefined,
			transient: true,
		});
		await expect(
			answering(() => '{"value":').renewNativeAuthority(authority, leaseId, NATIVE_AUTHORITY_LEASE_SECONDS),
		).rejects.toBeInstanceOf(SyntaxError);
		const stopped = await answering(
			() =>
				new ReadableStream({
					pull: (controller) => {
						execution.abort(new Error("job lease lost"));
						controller.error(execution.signal.reason);
					},
				}),
		)
			.renewNativeAuthority(authority, leaseId, NATIVE_AUTHORITY_LEASE_SECONDS)
			.catch((error: unknown) => error);
		expect(stopped).toBeInstanceOf(Error);
		expect(stopped).not.toBeInstanceOf(CloudRunnerBrokerRequestError);
	});
});

describe("cloud runner broker incident-scale retry budgets", () => {
	it("rides out minutes of shedding on the durable action path", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const fetchImplementation = (async () => {
				calls++;
				if (calls <= 6) return new Response("shed", { status: 503 });
				return Response.json({ value: { recovered: true } });
			}) as typeof fetch;
			const transport = new SupabaseCloudRunnerBrokerTransport(
				"https://qorpera.example",
				"publishable-key",
				fetchImplementation,
			);
			const pending = transport.describe({ runnerId, jobId, sessionToken, leaseToken });
			for (const delay of [2_000, 4_000, 6_000, 8_000, 10_000, 10_000]) {
				await vi.advanceTimersByTimeAsync(delay);
			}
			await expect(pending).resolves.toEqual({ recovered: true });
			expect(calls).toBe(7);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps cadence-sensitive actions inside the short budget", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const fetchImplementation = (async () => {
				calls++;
				return new Response("shed", { status: 503 });
			}) as typeof fetch;
			const transport = new SupabaseCloudRunnerBrokerTransport(
				"https://qorpera.example",
				"publishable-key",
				fetchImplementation,
			);
			const pending = transport
				.renewNativeAuthority(
					{ runnerId, jobId, sessionToken, leaseToken },
					"55555555-5555-4555-8555-555555555555",
					120,
				)
				.then(
					() => "resolved",
					(error: unknown) => String(error),
				);
			await vi.advanceTimersByTimeAsync(30_000);
			const outcome = await pending;
			expect(outcome).toContain("Runner broker request (renew_native_authority) failed (503)");
			expect(calls).toBeLessThanOrEqual(4);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a folder-v2 run in the runner broker (folder core C3, P23)", () => {
	it("is described in the path lane with no substrate anywhere", async () => {
		const description = await broker().broker.describe();
		expect(description).toEqual({
			companyRuntime: "company-path-v1",
			job: expect.objectContaining({ jobId, runId, assignmentId, sessionId }),
			run: expect.objectContaining({ runId, jobId, sessionId, sourceKind: "wake", companySeq: 7 }),
			sponsor: {
				bindingId: sponsorBindingId,
				version: 1,
				kind: "member_connection",
				providerConnectionId,
				providerConnectionVersion: 2,
				provider: "openai",
				authenticationMode: "native_subscription",
				nativeHarness: "codex-cli",
				allowAutonomous: true,
			},
			outputLimits: {
				maxObjectBytes: 8 * 1024 * 1024,
				maxObjectCount: 100,
				maxTotalBytes: 64 * 1024 * 1024,
				rootContract: "qorpera.object/v1",
			},
		});
		expect(description.job).not.toHaveProperty("substrateVersionId");
		expect(description.run).not.toHaveProperty("substrateVersionId");
		expect(description.run).not.toHaveProperty("companySnapshotId");
	});

	it("carries a folder-v2 run's companySeq, never beside a snapshot (P28)", async () => {
		const folder = descriptionRecord();
		const run = folder.run as Record<string, unknown>;
		// A description from before P28 has no key; a run with no pin sends null.
		const { company_seq: _seq, ...withoutKey } = run;
		for (const unpinned of [withoutKey, { ...run, company_seq: null }]) {
			const described = await broker({ run: unpinned }).broker.describe();
			expect(described.run).not.toHaveProperty("companySeq");
		}
		for (const companySeq of [-1, 1.5, "7"]) {
			await expect(broker({ run: { ...run, company_seq: companySeq } }).broker.describe()).rejects.toThrow();
		}
		const snapshotRun = { ...run, substrate_version_id: versionId, company_snapshot_id: snapshotId };
		await expect(broker({ run: snapshotRun }).broker.describe()).rejects.toThrow(
			"both a snapshot and a folder sequence",
		);
	});

	it.each([
		["the whole-tree lane's description", wholeTreeRecord(), RUNTIME_REFUSAL],
		["the whole-tree lane", { company_runtime: "whole-tree-v1" }, RUNTIME_REFUSAL],
		[
			"the path lane over a snapshot-v1 substrate",
			{ ...wholeTreeRecord(), company_runtime: "company-path-v1" },
			SUBSTRATE_REFUSAL,
		],
		["a version", { version: wholeTreeRecord().version }, SUBSTRATE_REFUSAL],
		["a snapshot", { snapshot: wholeTreeRecord().snapshot }, SUBSTRATE_REFUSAL],
		["a proposal snapshot", { proposal_snapshot: wholeTreeRecord().snapshot }, SUBSTRATE_REFUSAL],
		["an artifact index", { artifact_index: wholeTreeRecord().artifact_index }, SUBSTRATE_REFUSAL],
		[
			"Company File output limits",
			{ company_file_output_limits: wholeTreeRecord().company_file_output_limits },
			SUBSTRATE_REFUSAL,
		],
		["a substrate on the job", { job: wholeTreeRecord().job }, SUBSTRATE_REFUSAL],
		["a substrate on the run", { run: wholeTreeRecord().run }, SUBSTRATE_REFUSAL],
		[
			"a substrate for a run that names none",
			{
				version: wholeTreeRecord().version,
				snapshot: wholeTreeRecord().snapshot,
				artifact_index: wholeTreeRecord().artifact_index,
				company_file_output_limits: wholeTreeRecord().company_file_output_limits,
			},
			SUBSTRATE_REFUSAL,
		],
	])("refuses a description naming a Company File substrate: %s", async (_label, change, message) => {
		const current = broker(change);
		await expect(current.broker.describe()).rejects.toThrow(message);
		expect(current.transport.actions).toEqual(["describe"]);
	});
});
