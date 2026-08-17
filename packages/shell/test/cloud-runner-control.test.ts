import type { JsonValue } from "@qorpera/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import type { CloudRunnerBrokerAuthority, CloudRunnerBrokerTransport } from "../src/cloud-runner-broker.ts";
import {
	type CloudRunnerAuthorityStore,
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
	createCloudRunnerPairingSecret,
	DisposableCloudRunner,
	parseCloudRunnerJob,
	SupabaseCloudRunnerControlTransport,
} from "../src/cloud-runner-control.ts";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const clientRunnerId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const actorUserId = "ec30142e-47c8-4532-a6c4-10612d02c619";
const jobId = "b953532a-c4f0-4b81-b901-d4bb21237001";
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
	it("reuses secrets and idempotency ids after ambiguous activation, heartbeat, claim, and completion", async () => {
		const pairing = createCloudRunnerPairingSecret();
		expect(pairing.activationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(pairing.activationTokenSha256).toMatch(/^[0-9a-f]{64}$/);
		const attempts = new Map<string, Array<{ token: string; body: CloudRunnerControlRequest }>>();
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (token, body) => {
				const entries = attempts.get(body.action) ?? [];
				entries.push({ token, body });
				attempts.set(body.action, entries);
				if (["activate", "heartbeat", "claim", "complete"].includes(body.action) && entries.length === 1) {
					throw new Error("response lost");
				}
				if (body.action === "activate" || body.action === "heartbeat") return runnerRecord();
				if (body.action === "claim" || body.action === "renew") return jobRecord("leased");
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

		await expect(runner.claim()).rejects.toThrow("response lost");
		const claimedJob = await runner.claim();
		expect(claimedJob).toMatchObject({ jobId, status: "leased" });
		expect(attempts.get("claim")?.[0]).toEqual(attempts.get("claim")?.[1]);
		expect(runner.snapshot()).toMatchObject({ active: true, activeJobIds: [jobId] });
		const brokerAuthorities: CloudRunnerBrokerAuthority[] = [];
		const brokerTransport: CloudRunnerBrokerTransport = {
			describe: vi.fn(async () => ({})),
			listOperations: vi.fn(async () => []),
			listArtifacts: vi.fn(async () => []),
			getObject: vi.fn(async (authority) => {
				brokerAuthorities.push({ ...authority });
				return new Uint8Array();
			}),
			putObject: vi.fn(async () => "stored" as const),
			registerArtifact: vi.fn(async () => ({})),
			requestModel: vi.fn(async () => ({})),
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
		const failures = new Set(["activate", "claim", "complete"]);
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (token, body) => {
				const entries = attempts.get(body.action) ?? [];
				entries.push({ token, body });
				attempts.set(body.action, entries);
				if (failures.delete(body.action)) throw new Error("response lost");
				if (body.action === "activate") return runnerRecord();
				if (body.action === "claim") return jobRecord("leased");
				if (body.action === "complete") return jobRecord("completed");
				throw new Error("unexpected runner action");
			}),
		};

		let runner = await DisposableCloudRunner.open(transport, runnerId, store, pairing.activationToken);
		await expect(runner.activate("linux-x64", "0.1.0")).rejects.toThrow("response lost");
		runner = await DisposableCloudRunner.open(transport, runnerId, store);
		await expect(runner.activate("linux-x64", "0.1.0")).resolves.toMatchObject({ runnerId });
		expect(attempts.get("activate")?.[0]).toEqual(attempts.get("activate")?.[1]);

		await expect(runner.claim()).rejects.toThrow("response lost");
		runner = await DisposableCloudRunner.open(transport, runnerId, store);
		await expect(runner.claim()).resolves.toMatchObject({ jobId, status: "leased" });
		expect(attempts.get("claim")?.[0]).toEqual(attempts.get("claim")?.[1]);
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

	it("replaces an expired ambiguous claim identity and claims again", async () => {
		const pairing = createCloudRunnerPairingSecret();
		const claims: Array<Extract<CloudRunnerControlRequest, { action: "claim" }>> = [];
		let firstClientLeaseId: string | undefined;
		const transport: CloudRunnerControlTransport = {
			request: vi.fn(async (_token, body) => {
				if (body.action === "activate") return runnerRecord();
				if (body.action !== "claim") throw new Error("unexpected runner action");
				claims.push(structuredClone(body));
				if (!firstClientLeaseId) {
					firstClientLeaseId = body.clientLeaseId;
					throw new Error("claim response lost");
				}
				if (body.clientLeaseId === firstClientLeaseId) throw new CloudRunnerControlRequestError(409);
				return jobRecord("leased");
			}),
		};
		const runner = new DisposableCloudRunner(transport, runnerId, pairing.activationToken);
		await runner.activate("linux-x64", "0.1.0");

		await expect(runner.claim()).rejects.toThrow("claim response lost");
		await expect(runner.claim()).resolves.toMatchObject({ jobId, status: "leased" });

		expect(claims).toHaveLength(3);
		expect(claims[1]).toEqual(claims[0]);
		expect(claims[2]?.clientLeaseId).not.toBe(claims[0]?.clientLeaseId);
		expect(claims[2]?.leaseToken).not.toBe(claims[0]?.leaseToken);
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
