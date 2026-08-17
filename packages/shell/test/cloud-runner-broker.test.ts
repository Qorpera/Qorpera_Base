import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CloudRunnerBrokerAuthority,
	CloudRunnerBrokerOutputPublisher,
	type CloudRunnerBrokerTransport,
	CloudRunnerJobBroker,
	type RegisterCloudRunnerArtifactInput,
	SupabaseCloudRunnerBrokerTransport,
} from "../src/cloud-runner-broker.ts";
import { parseCloudRunnerJob } from "../src/cloud-runner-control.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const versionId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";
const runnerId = "88888888-8888-4888-8888-888888888888";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-17T01:00:00.000Z";
const sessionToken = "s".repeat(43);
const leaseToken = "l".repeat(43);
const temporaryDirectories: string[] = [];

function jobRecord(): Record<string, unknown> {
	return {
		job_id: jobId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: null,
		substrate_version_id: versionId,
		client_job_id: "11111111-1111-4111-8111-111111111111",
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

function artifactRecord(input: {
	artifactId: string;
	clientArtifactId: string;
	sha256: string;
	bytes: number;
	name: string;
}): Record<string, unknown> {
	return {
		artifact_id: input.artifactId,
		profile_id: profileId,
		environment_id: environmentId,
		client_artifact_id: input.clientArtifactId,
		session_id: null,
		artifact_type: "runner_output",
		name: input.name,
		root_object_sha256: input.sha256,
		root_contract: "qorpera.object/v1",
		content_sha256: input.sha256,
		bytes: input.bytes,
		media_type: "application/octet-stream",
		created_by_user_id: actorUserId,
		created_at: createdAt,
		eligible_for_gc_at: "2026-09-17T01:00:00.000Z",
	};
}

function descriptionRecord(): Record<string, unknown> {
	return {
		job: jobRecord(),
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
			tree_contract_version: 1,
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
	};
}

class MemoryBrokerTransport implements CloudRunnerBrokerTransport {
	readonly objects = new Map<string, Uint8Array>();
	readonly authorities: CloudRunnerBrokerAuthority[] = [];
	readonly registrations: RegisterCloudRunnerArtifactInput[] = [];
	readonly description = descriptionRecord();

	async describe(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.authorities.push({ ...authority });
		return this.description;
	}

	async listOperations(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.authorities.push({ ...authority });
		return [
			{
				profile_id: profileId,
				sequence: 2,
				environment_id: environmentId,
				operation_type: "session_event",
				entity_id: "12121212-1212-4212-8212-121212121212",
				entity_version: 1,
				content_sha256: "e".repeat(64),
				payload: { message: "immutable" },
				actor_user_id: actorUserId,
				created_at: createdAt,
			},
		];
	}

	async listArtifacts(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.authorities.push({ ...authority });
		return [];
	}

	async getObject(authority: CloudRunnerBrokerAuthority, sha256: string): Promise<Uint8Array> {
		this.authorities.push({ ...authority });
		const bytes = this.objects.get(sha256);
		if (!bytes) throw new Error("object unavailable");
		return Uint8Array.from(bytes);
	}

	async putObject(
		authority: CloudRunnerBrokerAuthority,
		sha256: string,
		bytes: Uint8Array,
	): Promise<"exists" | "stored"> {
		this.authorities.push({ ...authority });
		if (this.objects.has(sha256)) return "exists";
		this.objects.set(sha256, Uint8Array.from(bytes));
		return "stored";
	}

	async registerArtifact(
		authority: CloudRunnerBrokerAuthority,
		input: RegisterCloudRunnerArtifactInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		this.registrations.push({ ...input });
		return artifactRecord({
			artifactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			clientArtifactId: input.clientArtifactId,
			sha256: input.objectSha256,
			bytes: input.bytes,
			name: input.name,
		});
	}
}

function broker(transport = new MemoryBrokerTransport()): {
	broker: CloudRunnerJobBroker;
	transport: MemoryBrokerTransport;
} {
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

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-runner-broker-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud runner object broker", () => {
	it("resolves only the leased substrate and refreshes credentials for every broker call", async () => {
		const memory = new MemoryBrokerTransport();
		let currentSessionToken = sessionToken;
		const current = new CloudRunnerJobBroker({
			job: parseCloudRunnerJob(jobRecord()),
			runnerId,
			credentials: () => ({ sessionToken: currentSessionToken, leaseToken }),
			transport: memory,
		});

		await expect(current.resolve(versionId)).resolves.toMatchObject({
			version: { versionId, operationSequence: 2 },
			snapshot: { snapshotId },
			artifactIndex: { indexId: artifactIndexId },
		});
		currentSessionToken = "n".repeat(43);
		await expect(current.listOperations((await current.describe()).version)).resolves.toMatchObject([
			{ sequence: 2, payload: { message: "immutable" } },
		]);
		expect(memory.authorities).toMatchObject([
			{ sessionToken, leaseToken, runnerId, jobId },
			{ sessionToken: currentSessionToken, leaseToken, runnerId, jobId },
		]);
		await expect(current.resolve("13131313-1313-4313-8313-131313131313")).rejects.toThrow("another substrate");
	});

	it("publishes verified output as deterministic direct artifacts through host-only authority", async () => {
		const current = broker();
		const outputRoot = await temporaryDirectory();
		const bytes = Buffer.from("brokered output\n", "utf-8");
		const contentSha256 = createHash("sha256").update(bytes).digest("hex");
		await writeFile(join(outputRoot, "answer.txt"), bytes);
		const publisher = new CloudRunnerBrokerOutputPublisher(current.broker);
		const input = {
			profileId,
			environmentId,
			jobId,
			substrateVersionId: versionId,
			outputRoot,
			files: [{ path: "answer.txt", sha256: contentSha256, bytes: bytes.byteLength, executable: false }],
		};

		await expect(publisher.publish(input)).resolves.toMatchObject({
			artifacts: [{ artifact_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", content_sha256: contentSha256 }],
		});
		await expect(publisher.publish(input)).resolves.toMatchObject({
			artifacts: [{ artifact_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
		});
		expect(Buffer.from(current.transport.objects.get(contentSha256) ?? [])).toEqual(bytes);
		expect(current.transport.registrations).toHaveLength(2);
		expect(current.transport.registrations[0]?.clientArtifactId).toBe(
			current.transport.registrations[1]?.clientArtifactId,
		);
		expect(current.transport.authorities.every((authority) => authority.sessionToken === sessionToken)).toBe(true);
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

		expect(calls[0]?.url).toBe("https://example.supabase.co/functions/v1/runner-broker");
		expect(calls[0]?.url).not.toContain(sessionToken);
		expect(calls[0]?.url).not.toContain(leaseToken);
		expect(String(calls[0]?.init?.body)).not.toContain(sessionToken);
		expect(String(calls[0]?.init?.body)).not.toContain(leaseToken);
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
		expect(new Headers(calls[0]?.init?.headers).get("x-qorpera-lease-token")).toBe(leaseToken);
	});
});
