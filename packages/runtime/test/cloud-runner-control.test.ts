import {
	type CloudRunnerAuthorityStore,
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
	createCloudRunnerPairingSecret,
	parseCloudRunnerJob,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudRunnerBrokerAuthority, CloudRunnerBrokerTransport } from "@qorpera/runtime/cloud-runner-broker";
import { DisposableCloudRunner, SupabaseCloudRunnerControlTransport } from "@qorpera/runtime/cloud-runner-control";
import { describe, expect, it, vi } from "vitest";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const clientRunnerId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const actorUserId = "ec30142e-47c8-4532-a6c4-10612d02c619";
const jobId = "b953532a-c4f0-4b81-b901-d4bb21237001";
const assignmentId = "b953532a-c4f0-4b81-b901-d4bb21237005";
const assignmentCapability = "z".repeat(43);
const environmentId = "b953532a-c4f0-4b81-b901-d4bb21237002";
const substrateVersionId = "b953532a-c4f0-4b81-b901-d4bb21237003";
const clientJobId = "b953532a-c4f0-4b81-b901-d4bb21237004";
const createdAt = "2026-08-16T12:00:00.000Z";

class MemoryAuthorityStore implements CloudRunnerAuthorityStore {
	value?: JsonValue;
	saves = 0;

	async load(): Promise<unknown | undefined> {
		return this.value === undefined ? undefined : structuredClone(this.value);
	}

	async save(value: JsonValue): Promise<void> {
		this.value = structuredClone(value);
		this.saves++;
	}
}

function runnerRecord() {
	return {
		runner_id: runnerId,
		profile_id: profileId,
		client_runner_id: clientRunnerId,
		display_name: "Disposable Linux runner",
		runner_kind: "local",
		capabilities: ["agent_turn", "git_worktree", "company_substrate"],
		max_concurrency: 1,
		status: "active",
		online: true,
		platform: "linux-x64",
		runner_version: "0.1.0",
		activation_expires_at: "2026-08-16T12:15:00.000Z",
		session_expires_at: "2026-08-16T12:30:00.000Z",
		registered_by_user_id: actorUserId,
		created_at: createdAt,
		activated_at: "2026-08-16T12:01:00.000Z",
		last_seen_at: "2026-08-16T12:15:00.000Z",
		revoked_by_user_id: null,
		revoked_at: null,
		active_lease_count: 0,
	};
}

function jobRecord(status: "leased" | "completed") {
	return {
		job_id: jobId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: null,
		substrate_version_id: substrateVersionId,
		client_job_id: clientJobId,
		required_capability: "agent_turn",
		job_type: "agent_turn",
		payload: { prompt: "Review the company substrate" },
		status,
		attempt_count: 1,
		runner_id: runnerId,
		result: status === "completed" ? { outcome: "ok" } : null,
		output_artifact_count: 0,
		output_artifact_index_id: null,
		output_substrate_version_id: null,
		last_error: null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		started_at: "2026-08-16T12:02:00.000Z",
		lease_expires_at: status === "leased" ? "2026-08-16T12:04:00.000Z" : null,
		finished_at: status === "completed" ? "2026-08-16T12:03:00.000Z" : null,
		cancelled_by_user_id: null,
		cancelled_at: null,
	};
}

describe("disposable cloud runner", () => {
	it("rejects non-HTTP loopback control URLs", () => {
		expect(() => new SupabaseCloudRunnerControlTransport("file://localhost/private", "publishable-key")).toThrow(
			"must use HTTPS",
		);
	});

	it("reuses secrets and assignment identity after ambiguous activation, heartbeat, acceptance, and completion", async () => {
		const pairing = createCloudRunnerPairingSecret();
		expect(pairing.activationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(pairing.activationTokenSha256).toMatch(/^[0-9a-f]{64}$/);
		const attempts = new Map<string, Array<{ token: string; body: CloudRunnerControlRequest }>>();
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (token, body) => {
				const entries = attempts.get(body.action) ?? [];
				entries.push({ token, body });
				attempts.set(body.action, entries);
				if (["activate", "heartbeat", "accept", "complete"].includes(body.action) && entries.length === 1) {
					throw new Error("response lost");
				}
				if (body.action === "activate" || body.action === "heartbeat") return runnerRecord();
				if (body.action === "accept" || body.action === "renew") return jobRecord("leased");
				if (body.action === "complete") return jobRecord("completed");
				return { ...jobRecord("leased"), status: "queued", runner_id: null, lease_expires_at: null };
			}),
		};
		const runner = new DisposableCloudRunner(transport, runnerId, pairing.activationToken);

		await expect(runner.activate("linux-x64", "0.1.0")).rejects.toThrow("response lost");
		await expect(runner.activate("linux-x64", "0.1.0")).resolves.toMatchObject({ runnerId, online: true });
		expect(attempts.get("activate")?.[0]).toEqual(attempts.get("activate")?.[1]);

		await expect(runner.heartbeat()).rejects.toThrow("response lost");
		await expect(runner.heartbeat()).resolves.toMatchObject({ runnerId, online: true });
		expect(attempts.get("heartbeat")?.[0]).toEqual(attempts.get("heartbeat")?.[1]);

		const assignment = { assignmentId, jobId, capability: assignmentCapability };
		await expect(runner.acceptAssignment(assignment)).rejects.toThrow("response lost");
		const claimedJob = await runner.acceptAssignment(assignment);
		expect(claimedJob).toMatchObject({ jobId, status: "leased" });
		expect(attempts.get("accept")?.[0]).toEqual(attempts.get("accept")?.[1]);
		expect(runner.snapshot()).toMatchObject({ active: true, activeJobIds: [jobId] });
		const brokerAuthorities: CloudRunnerBrokerAuthority[] = [];
		const brokerTransport: CloudRunnerBrokerTransport = {
			describe: vi.fn(async () => ({})),
			listInputs: vi.fn(async () => []),
			listTranscript: vi.fn(async () => []),
			listOperations: vi.fn(async () => []),
			listArtifacts: vi.fn(async () => []),
			getObject: vi.fn(async (authority) => {
				brokerAuthorities.push({ ...authority });
				return new Uint8Array();
			}),
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
		const broker = runner.broker(claimedJob as NonNullable<typeof claimedJob>, brokerTransport);
		await broker.readObject("f".repeat(64));
		expect(brokerAuthorities).toMatchObject([{ runnerId, jobId }]);
		expect(brokerAuthorities[0]?.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(brokerAuthorities[0]?.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

		await expect(runner.renew(jobId)).resolves.toMatchObject({ jobId, status: "leased" });
		await expect(runner.complete(jobId, { outcome: "ok" })).rejects.toThrow("response lost");
		await expect(runner.complete(jobId, { outcome: "ok" })).resolves.toMatchObject({
			jobId,
			status: "completed",
		});
		expect(attempts.get("complete")?.[0]).toEqual(attempts.get("complete")?.[1]);
		expect(attempts.get("complete")?.[0]?.body).toMatchObject({
			clientArtifactIndexId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			clientSubstrateVersionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(runner.snapshot().activeJobIds).toEqual([]);
		await expect(broker.readObject("f".repeat(64))).rejects.toThrow("lease is unavailable");
		expect(JSON.stringify(runner.snapshot())).not.toContain(pairing.activationToken);
	});

	it("restores pending authority and exact leased work after process restarts", async () => {
		const pairing = createCloudRunnerPairingSecret();
		const store = new MemoryAuthorityStore();
		const attempts = new Map<string, Array<{ token: string; body: CloudRunnerControlRequest }>>();
		const failures = new Set(["activate", "accept", "complete"]);
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (token, body) => {
				const entries = attempts.get(body.action) ?? [];
				entries.push({ token, body });
				attempts.set(body.action, entries);
				if (failures.delete(body.action)) throw new Error("response lost");
				if (body.action === "activate") return runnerRecord();
				if (body.action === "accept") return jobRecord("leased");
				if (body.action === "complete") return jobRecord("completed");
				throw new Error("unexpected runner action");
			}),
		};

		let runner = await DisposableCloudRunner.open(transport, runnerId, store, pairing.activationToken);
		await expect(runner.activate("linux-x64", "0.1.0")).rejects.toThrow("response lost");
		runner = await DisposableCloudRunner.open(transport, runnerId, store);
		await expect(runner.activate("linux-x64", "0.1.0")).resolves.toMatchObject({ runnerId });
		expect(attempts.get("activate")?.[0]).toEqual(attempts.get("activate")?.[1]);

		const assignment = { assignmentId, jobId, capability: assignmentCapability };
		await expect(runner.acceptAssignment(assignment)).rejects.toThrow("response lost");
		runner = await DisposableCloudRunner.open(transport, runnerId, store);
		await expect(runner.acceptAssignment(assignment)).resolves.toMatchObject({ jobId, status: "leased" });
		expect(attempts.get("accept")?.[0]).toEqual(attempts.get("accept")?.[1]);
		expect(runner.leasedJobs()).toMatchObject([{ jobId, substrateVersionId }]);

		await expect(runner.complete(jobId, { outcome: "ok" })).rejects.toThrow("response lost");
		runner = await DisposableCloudRunner.open(transport, runnerId, store);
		expect(runner.pendingCompletion(jobId)).toEqual({ outcome: "ok" });
		await expect(runner.complete(jobId, runner.pendingCompletion(jobId) as JsonValue)).resolves.toMatchObject({
			jobId,
			status: "completed",
		});
		expect(attempts.get("complete")?.[0]).toEqual(attempts.get("complete")?.[1]);
		expect(runner.leasedJobs()).toEqual([]);
		expect(store.saves).toBeGreaterThan(6);
		expect(JSON.stringify(runner.snapshot())).not.toContain(pairing.activationToken);
	});

	it("keeps a folder-v2 job with no Company File substrate across restarts and completes it (folder core C3, P23)", async () => {
		const pairing = createCloudRunnerPairingSecret();
		const store = new MemoryAuthorityStore();
		const completions: CloudRunnerControlRequest[] = [];
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (_token, body) => {
				if (body.action === "activate") return runnerRecord();
				if (body.action === "accept") return { ...jobRecord("leased"), substrate_version_id: null };
				if (body.action === "complete") {
					completions.push(body);
					return { ...jobRecord("completed"), substrate_version_id: null };
				}
				throw new Error("unexpected runner action");
			}),
		};
		let runner = await DisposableCloudRunner.open(transport, runnerId, store, pairing.activationToken);
		await runner.activate("linux-x64", "0.1.0");
		await runner.acceptAssignment({ assignmentId, jobId, capability: assignmentCapability });
		runner = await DisposableCloudRunner.open(transport, runnerId, store);
		const [leased] = runner.leasedJobs();
		expect(leased?.jobId).toBe(jobId);
		expect(leased).not.toHaveProperty("substrateVersionId");
		await expect(runner.complete(jobId, { outcome: "ok" })).resolves.toMatchObject({ jobId, status: "completed" });
		// The client substrate id is the runner's own deterministic id, never the job's: completion writes no null.
		expect(completions[0]).toMatchObject({ action: "complete", clientSubstrateVersionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
	});

	it("recovers heartbeat authority after the previous-token grace period", async () => {
		const pairing = createCloudRunnerPairingSecret();
		const attempts: Array<{ token: string; body: CloudRunnerControlRequest }> = [];
		let sessionToken: string | undefined;
		let loseFirstHeartbeat = true;
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (token, body) => {
				attempts.push({ token, body: structuredClone(body) });
				if (body.action === "activate") {
					sessionToken = body.nextSessionToken;
					return runnerRecord();
				}
				if (body.action !== "heartbeat") throw new Error("unexpected runner action");
				if (token !== sessionToken) throw new CloudRunnerControlRequestError(401);
				sessionToken = body.nextSessionToken;
				if (loseFirstHeartbeat) {
					loseFirstHeartbeat = false;
					throw new Error("heartbeat response lost");
				}
				return runnerRecord();
			}),
		};
		const runner = new DisposableCloudRunner(transport, runnerId, pairing.activationToken);
		await runner.activate("linux-x64", "0.1.0");

		await expect(runner.heartbeat()).rejects.toThrow("heartbeat response lost");
		await expect(runner.heartbeat()).resolves.toMatchObject({ runnerId, status: "active" });

		const heartbeats = attempts.filter((attempt) => attempt.body.action === "heartbeat");
		expect(heartbeats).toHaveLength(3);
		expect(heartbeats[1]).toEqual(heartbeats[0]);
		expect(heartbeats[2]?.token).toBe(
			heartbeats[0]?.body.action === "heartbeat" ? heartbeats[0].body.nextSessionToken : undefined,
		);
		expect(heartbeats[2]?.body).not.toEqual(heartbeats[0]?.body);
	});

	it("does not replace an orchestrator assignment after an ambiguous response", async () => {
		const pairing = createCloudRunnerPairingSecret();
		const acceptances: Array<Extract<CloudRunnerControlRequest, { action: "accept" }>> = [];
		let loseResponse = true;
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (_token, body) => {
				if (body.action === "activate") return runnerRecord();
				if (body.action !== "accept") throw new Error("unexpected runner action");
				acceptances.push(structuredClone(body));
				if (loseResponse) {
					loseResponse = false;
					throw new Error("acceptance response lost");
				}
				return jobRecord("leased");
			}),
		};
		const runner = new DisposableCloudRunner(transport, runnerId, pairing.activationToken);
		await runner.activate("linux-x64", "0.1.0");

		const assignment = { assignmentId, jobId, capability: assignmentCapability };
		await expect(runner.acceptAssignment(assignment)).rejects.toThrow("acceptance response lost");
		await expect(
			runner.acceptAssignment({
				assignmentId: clientRunnerId,
				jobId,
				capability: assignmentCapability,
			}),
		).rejects.toThrow("another assignment");
		await expect(runner.acceptAssignment(assignment)).resolves.toMatchObject({ jobId, status: "leased" });

		expect(acceptances).toHaveLength(2);
		expect(acceptances[1]).toEqual(acceptances[0]);
	});

	it("sends only the publishable key and custom short-lived bearer to the control function", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify({ value: runnerRecord() }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const transport = new SupabaseCloudRunnerControlTransport(
			"https://project.supabase.co",
			"publishable-key",
			fakeFetch as typeof fetch,
		);
		const token = "a".repeat(43);
		await transport.request(token, {
			action: "heartbeat",
			runnerId,
			nextSessionToken: "b".repeat(43),
			renewalId: clientRunnerId,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://project.supabase.co/functions/v1/runner-control",
			init: {
				headers: {
					apikey: "publishable-key",
					authorization: `Bearer ${token}`,
				},
			},
		});
	});

	it("aborts a stalled control request when the runner service stops", async () => {
		const stop = new AbortController();
		const fakeFetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return reject(new Error("missing request signal"));
					if (signal.aborted) return reject(signal.reason);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const transport = new SupabaseCloudRunnerControlTransport(
			"https://project.supabase.co",
			"publishable-key",
			fakeFetch as typeof fetch,
			{ signal: stop.signal, requestTimeoutMs: 1_000 },
		);
		const request = transport.request("a".repeat(43), {
			action: "heartbeat",
			runnerId,
			nextSessionToken: "b".repeat(43),
			renewalId: clientRunnerId,
		});
		stop.abort(new Error("service stopped"));
		await expect(request).rejects.toThrow("service stopped");
	});

	it("rejects non-object work payloads and inconsistent terminal projections", () => {
		expect(() => parseCloudRunnerJob({ ...jobRecord("leased"), payload: [] })).toThrow("payload");
		expect(() => parseCloudRunnerJob({ ...jobRecord("completed"), result: null })).toThrow("result");
		const published = parseCloudRunnerJob({
			...jobRecord("completed"),
			result: {
				outcome: "ok",
				output_substrate: {
					artifact_count: 1,
					artifact_index_id: "b953532a-c4f0-4b81-b901-d4bb21237005",
					substrate_version_id: "b953532a-c4f0-4b81-b901-d4bb21237006",
				},
			},
			output_artifact_count: 1,
			output_artifact_index_id: "b953532a-c4f0-4b81-b901-d4bb21237005",
			output_substrate_version_id: "b953532a-c4f0-4b81-b901-d4bb21237006",
		});
		expect(published).toMatchObject({
			outputArtifactCount: 1,
			outputArtifactIndexId: "b953532a-c4f0-4b81-b901-d4bb21237005",
			outputSubstrateVersionId: "b953532a-c4f0-4b81-b901-d4bb21237006",
		});
		expect(() =>
			parseCloudRunnerJob({
				...jobRecord("leased"),
				output_artifact_count: 1,
				output_artifact_index_id: "b953532a-c4f0-4b81-b901-d4bb21237005",
				output_substrate_version_id: "b953532a-c4f0-4b81-b901-d4bb21237006",
			}),
		).toThrow("output substrate");
	});
});

describe("runner start", () => {
	const assignment = { assignmentId, jobId, capability: assignmentCapability };
	const description = { company_runtime: "company-path-v1", marker: "raw description" };
	const nativeAuthority = { lease_id: clientRunnerId, marker: "raw native authority" };

	function startService(answer: (body: CloudRunnerControlRequest) => unknown) {
		const requests: CloudRunnerControlRequest[] = [];
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (_token, body) => {
				if (body.action === "activate") return runnerRecord();
				requests.push(structuredClone(body));
				return answer(body);
			}),
		};
		return { transport, requests };
	}

	async function activeRunner(transport: CloudRunnerControlTransport, store = new MemoryAuthorityStore()) {
		const runner = await DisposableCloudRunner.open(
			transport,
			runnerId,
			store,
			createCloudRunnerPairingSecret().activationToken,
		);
		await runner.activate("linux-x64", "0.1.0");
		return runner;
	}

	it("accepts, describes and takes the native authority in one request, and keeps the acceptance's state", async () => {
		const service = startService(() => ({
			job: jobRecord("leased"),
			description,
			native_authority: nativeAuthority,
		}));
		const store = new MemoryAuthorityStore();
		const runner = await activeRunner(service.transport, store);
		const started = await runner.startAssignment(assignment, 120);
		expect(service.requests).toEqual([
			{ action: "start", runnerId, assignmentId, jobId, assignmentCapability, nativeLeaseSeconds: 120 },
		]);
		expect(started).toEqual({
			job: parseCloudRunnerJob(jobRecord("leased")),
			start: { description, nativeAuthority: { value: nativeAuthority, leaseSeconds: 120 } },
		});
		// The same local authority an acceptance records: the lease, not yet started.
		const accepting = startService(() => jobRecord("leased"));
		const acceptedStore = new MemoryAuthorityStore();
		const accepted = await activeRunner(accepting.transport, acceptedStore);
		await accepted.acceptAssignment(assignment);
		const persisted = (value: JsonValue | undefined) => {
			const state = structuredClone(value) as Record<string, JsonValue>;
			delete state.session_token;
			delete state.runner;
			return state;
		};
		expect(persisted(store.value)).toEqual(persisted(acceptedStore.value));
		expect(runner.executionStarted(jobId)).toBe(false);
		expect(runner.snapshot().activeJobIds).toEqual([jobId]);
	});

	it("asks for no native authority when the runner cannot execute native subscriptions", async () => {
		const service = startService(() => ({ job: jobRecord("leased"), description, native_authority: null }));
		const runner = await activeRunner(service.transport);
		await expect(runner.startAssignment(assignment)).resolves.toEqual({
			job: parseCloudRunnerJob(jobRecord("leased")),
			start: { description },
		});
		expect(service.requests).toEqual([{ action: "start", runnerId, assignmentId, jobId, assignmentCapability }]);
	});

	it("returns only the lease when the cloud deferred the reads to the separate calls", async () => {
		const service = startService(() => ({ job: jobRecord("leased"), description: null, native_authority: null }));
		const runner = await activeRunner(service.transport);
		await expect(runner.startAssignment(assignment, 120)).resolves.toEqual({
			job: parseCloudRunnerJob(jobRecord("leased")),
		});
	});

	it("replays the identical start after an ambiguous response", async () => {
		let lose = true;
		const service = startService(() => {
			if (lose) {
				lose = false;
				throw new Error("start response lost");
			}
			return { job: jobRecord("leased"), description, native_authority: nativeAuthority };
		});
		const store = new MemoryAuthorityStore();
		let runner = await activeRunner(service.transport, store);
		await expect(runner.startAssignment(assignment, 120)).rejects.toThrow("start response lost");
		runner = await DisposableCloudRunner.open(service.transport, runnerId, store);
		await expect(runner.startAssignment(assignment, 120)).resolves.toMatchObject({ job: { jobId } });
		expect(service.requests).toHaveLength(2);
		expect(service.requests[1]).toEqual(service.requests[0]);
	});

	it.each([400, 501])(
		"accepts alone for ten minutes when the control plane has no start (%s), then asks again",
		async (status) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const service = startService((body) => {
					if (body.action === "start") throw new CloudRunnerControlRequestError(status);
					if (body.action === "accept") return { ...jobRecord("leased"), job_id: body.jobId };
					throw new Error("unexpected runner action");
				});
				const runner = await activeRunner(service.transport);
				await expect(runner.startAssignment(assignment, 120)).resolves.toEqual({
					job: parseCloudRunnerJob(jobRecord("leased")),
				});
				const next = (id: string) => ({ assignmentId: id, jobId: id, capability: assignmentCapability });
				vi.advanceTimersByTime(10 * 60_000 - 1);
				await expect(runner.startAssignment(next(substrateVersionId), 120)).resolves.toMatchObject({
					job: { jobId: substrateVersionId },
				});
				vi.advanceTimersByTime(1);
				await runner.startAssignment(next(clientJobId), 120);
				expect(service.requests.map((request) => request.action)).toEqual([
					"start",
					"accept",
					"accept",
					"start",
					"accept",
				]);
				expect(service.requests[1]).toEqual({
					action: "accept",
					runnerId,
					assignmentId,
					jobId,
					assignmentCapability,
				});
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it.each([401, 409, 423, 503, undefined])(
		"does not fall back when a start may have run or was refused (%s)",
		async (status) => {
			const service = startService(() => {
				throw status === undefined ? new Error("start response lost") : new CloudRunnerControlRequestError(status);
			});
			const store = new MemoryAuthorityStore();
			const runner = await activeRunner(service.transport, store);
			await expect(runner.startAssignment(assignment, 120)).rejects.toThrow();
			expect(service.requests.map((request) => request.action)).toEqual(["start"]);
			expect(runner.snapshot().activeJobIds).toEqual([]);
			// The assignment stays pending, exactly as after a failed acceptance.
			expect((store.value as Record<string, JsonValue>).pending_assignment).toEqual({
				assignment_id: assignmentId,
				job_id: jobId,
				capability: assignmentCapability,
			});
		},
	);

	it.each([
		["an unknown field", { job: jobRecord("leased"), description, native_authority: null, extra: true }, 120],
		[
			"an authority without a description",
			{ job: jobRecord("leased"), description: null, native_authority: nativeAuthority },
			120,
		],
		[
			"an authority nobody asked for",
			{ job: jobRecord("leased"), description, native_authority: nativeAuthority },
			undefined,
		],
		["a bare job", jobRecord("leased"), 120],
	] as const)("refuses a start receipt with %s and records no lease", async (_label, receipt, nativeLeaseSeconds) => {
		const service = startService(() => structuredClone(receipt));
		const runner = await activeRunner(service.transport);
		await expect(runner.startAssignment(assignment, nativeLeaseSeconds)).rejects.toThrow();
		expect(runner.snapshot().activeJobIds).toEqual([]);
	});
});
