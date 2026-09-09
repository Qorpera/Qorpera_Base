import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRunnerModelRequest } from "@qorpera/cloud-client/cloud-runner-model";
import { parseCloudRunnerJob } from "@qorpera/cloud-client/node/cloud-runner-protocol";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import {
	type AppendCloudRunnerCompanyRevisionGraphInput,
	type AppendCloudRunnerTranscriptEventInput,
	type BeginCloudRunnerCompanyRevisionGraphInput,
	type BeginCloudRunnerOperationInput,
	type BindCloudRunnerProviderSessionInput,
	type CloudRunnerBrokerAuthority,
	CloudRunnerBrokerCompanyFilePublisher,
	CloudRunnerBrokerOutputPublisher,
	type CloudRunnerBrokerTransport,
	CloudRunnerJobBroker,
	type CompleteCloudRunnerOperationInput,
	type PrepareCloudRunnerCompanyRevisionInput,
	type RegisterCloudRunnerArtifactInput,
	SupabaseCloudRunnerBrokerTransport,
} from "@qorpera/runtime/cloud-runner-broker";
import { afterEach, describe, expect, it, vi } from "vitest";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const candidateSnapshotId = "44444444-4444-4444-8444-444444444445";
const graphId = "44444444-4444-4444-8444-444444444446";
const versionId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";
const runnerId = "88888888-8888-4888-8888-888888888888";
const runId = "89898989-8989-4989-8989-898989898989";
const assignmentId = "78787878-7878-4787-8787-787878787878";
const sessionId = "45454545-4545-4454-8545-454545454545";
const sponsorBindingId = "56565656-5656-4565-8565-565656565656";
const providerConnectionId = "67676767-6767-4676-8676-676767676767";
const staffAgentId = "69696969-6969-4969-8969-696969696969";
const inputId = "70707070-7070-4070-8070-707070707070";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-17T01:00:00.000Z";
const sessionToken = "s".repeat(43);
const leaseToken = "l".repeat(43);
const temporaryDirectories: string[] = [];

function jobRecord(): Record<string, unknown> {
	return {
		job_id: jobId,
		run_id: runId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: sessionId,
		substrate_version_id: versionId,
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
		company_runtime: "whole-tree-v1",
		job: jobRecord(),
		run: {
			run_id: runId,
			profile_id: profileId,
			environment_id: environmentId,
			source_kind: "session_turn",
			source_id: "12121212-1212-4212-8212-121212121212",
			session_id: sessionId,
			job_id: jobId,
			substrate_version_id: versionId,
			company_snapshot_id: snapshotId,
			staff_agent_id: staffAgentId,
			staff_version: 3,
			input_ids: [inputId],
			sponsor_binding_id: sponsorBindingId,
			sponsor_version: 1,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			payload_sha256: "9".repeat(64),
			publication_mode: "automatic",
			review_policy_key: null,
			reviewer_staff_ids: [],
			logical_computer_id: null,
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
			authentication_mode: "api_key",
			native_harness: "openai-responses",
			allow_autonomous: false,
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
		company_file_output_limits: {
			max_object_bytes: 8 * 1024 * 1024,
			max_object_count: 509_602,
			max_total_bytes: 50 * 1024 * 1024 * 1024,
			tree_contract_version: 3,
		},
	};
}

class MemoryBrokerTransport implements CloudRunnerBrokerTransport {
	readonly objects = new Map<string, Uint8Array>();
	readonly authorities: CloudRunnerBrokerAuthority[] = [];
	readonly registrations: RegisterCloudRunnerArtifactInput[] = [];
	readonly modelRequests: CloudRunnerModelRequest[] = [];
	readonly begunOperations: BeginCloudRunnerOperationInput[] = [];
	readonly completedOperations: CompleteCloudRunnerOperationInput[] = [];
	readonly providerSessions: BindCloudRunnerProviderSessionInput[] = [];
	readonly companyRevisions: PrepareCloudRunnerCompanyRevisionInput[] = [];
	readonly companyGraphs: BeginCloudRunnerCompanyRevisionGraphInput[] = [];
	readonly companyGraphEntries: AppendCloudRunnerCompanyRevisionGraphInput[] = [];
	readonly transcriptEvents: AppendCloudRunnerTranscriptEventInput[] = [];
	readonly objectPurposes: Array<"artifact" | "company_file"> = [];
	readonly description = descriptionRecord();

	async describe(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.authorities.push({ ...authority });
		return this.description;
	}

	async listInputs(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.authorities.push({ ...authority });
		return [
			{
				input_id: inputId,
				position: 1,
				kind: "user_message",
				author_user_id: actorUserId,
				author_display_name: "Owner",
				body: { text: "Run safely" },
				created_at: createdAt,
			},
		];
	}

	async listTranscript(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		this.authorities.push({ ...authority });
		return [
			{
				session_id: sessionId,
				sequence: 1,
				event_id: "23232323-2323-4232-8232-232323232323",
				event_type: "message",
				actor_user_id: actorUserId,
				body: { schema: "qorpera.runner-transcript-entry/v1", entry: { id: "prior" } },
				previous_hash: null,
				event_hash: "8".repeat(64),
				execution_kind: "turn",
				execution_id: "24242424-2424-4242-8242-242424242424",
				execution_claimant_id: "25252525-2525-4252-8252-252525252525",
				runner_assignment_id: null,
				created_at: createdAt,
			},
		];
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
				entity_version: 0,
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
		_mediaType: string,
		purpose: "artifact" | "company_file",
	): Promise<"exists" | "stored"> {
		this.authorities.push({ ...authority });
		this.objectPurposes.push(purpose);
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

	async requestModel(authority: CloudRunnerBrokerAuthority, input: CloudRunnerModelRequest): Promise<unknown> {
		this.authorities.push({ ...authority });
		this.modelRequests.push(structuredClone(input));
		return {
			request_id: input.requestId,
			provider: input.provider,
			model: input.model,
			output: { text: "bounded answer" },
			usage: { input_tokens: 8, output_tokens: 3, cost_microusd: 125 },
		};
	}

	async beginOperation(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		input: BeginCloudRunnerOperationInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		this.begunOperations.push(structuredClone(input));
		return { state: "executing", receipt_id: input.receiptId, result: null };
	}

	async completeOperation(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		input: CompleteCloudRunnerOperationInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		this.completedOperations.push(structuredClone(input));
		return { state: "completed", receipt_id: input.receiptId, result: input.result };
	}

	async bindProviderSession(
		authority: CloudRunnerBrokerAuthority,
		input: BindCloudRunnerProviderSessionInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		this.providerSessions.push(structuredClone(input));
		return {
			run_id: runId,
			provider_connection_id: providerConnectionId,
			provider_session_id: input.providerSessionId,
		};
	}

	async prepareCompanyRevision(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		input: PrepareCloudRunnerCompanyRevisionInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		this.companyRevisions.push(structuredClone(input));
		const snapshot = structuredClone(descriptionRecord().snapshot) as Record<string, unknown>;
		return {
			...snapshot,
			snapshot_id: candidateSnapshotId,
			client_snapshot_id: input.clientRevisionId,
			parent_snapshot_id: snapshotId,
			tree_manifest_sha256: input.treeManifestSha256,
			tree_manifest_bytes: input.treeManifestBytes,
			tree_contract_version: input.treeContractVersion,
			file_count: input.fileCount,
			total_bytes: input.totalBytes,
		};
	}

	async beginCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		input: BeginCloudRunnerCompanyRevisionGraphInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		this.companyGraphs.push(structuredClone(input));
		return {
			graph_id: graphId,
			root_kind: "company_snapshot",
			root_id: input.snapshotId,
			client_graph_id: input.clientGraphId,
			root_object_sha256: input.rootObjectSha256,
			content_sha256: input.contentSha256,
			object_count: input.objectCount,
			storage_bytes: input.storageBytes,
			status: "uploading",
		};
	}

	async appendCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		input: AppendCloudRunnerCompanyRevisionGraphInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		this.companyGraphEntries.push(structuredClone(input));
		return input.entries.length;
	}

	async completeCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		receivedGraphId: string,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		expect(receivedGraphId).toBe(graphId);
		const input = this.companyGraphs[0] as BeginCloudRunnerCompanyRevisionGraphInput;
		return {
			graph_id: graphId,
			root_kind: "company_snapshot",
			root_id: input.snapshotId,
			client_graph_id: input.clientGraphId,
			root_object_sha256: input.rootObjectSha256,
			content_sha256: input.contentSha256,
			object_count: input.objectCount,
			storage_bytes: input.storageBytes,
			status: "complete",
		};
	}

	async verifyCompanyRevision(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		receivedSnapshotId: string,
		receivedGraphId: string,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		expect(receivedSnapshotId).toBe(candidateSnapshotId);
		expect(receivedGraphId).toBe(graphId);
		return { verified: true, pending: false };
	}

	async appendTranscriptEvent(
		authority: CloudRunnerBrokerAuthority,
		receivedAssignmentId: string,
		input: AppendCloudRunnerTranscriptEventInput,
	): Promise<unknown> {
		this.authorities.push({ ...authority });
		expect(receivedAssignmentId).toBe(assignmentId);
		this.transcriptEvents.push(structuredClone(input));
		return {
			session_id: "45454545-4545-4454-8545-454545454545",
			sequence: (input.expectedSequence ?? 0) + 1,
			event_id: input.eventId,
			event_type: input.eventType,
			body: { schema: "qorpera.runner-transcript-entry/v1", entry: input.entry },
			previous_hash: null,
			event_hash: "e".repeat(64),
			execution_kind: "run",
			execution_id: runId,
			execution_claimant_id: runId,
			runner_assignment_id: assignmentId,
			created_at: createdAt,
		};
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
	const directory = await mkdtemp(join(await realpath(tmpdir()), "qorpera-runner-broker-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud runner object broker", () => {
	it.each([undefined, null, "company-path-v2", ""])(
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
		await expect(current.listTranscript()).resolves.toMatchObject([
			{
				sessionId,
				sequence: 1,
				execution: { kind: "turn" },
			},
		]);
		await expect(current.listInputs()).resolves.toMatchObject([
			{ inputId, position: 1, kind: "user_message", body: { text: "Run safely" } },
		]);
		currentSessionToken = "n".repeat(43);
		await expect(current.listOperations((await current.describe()).version)).resolves.toMatchObject([
			{ sequence: 2, entityVersion: 0, payload: { message: "immutable" } },
		]);
		expect(memory.authorities).toMatchObject([
			{ sessionToken, leaseToken, runnerId, jobId },
			{ sessionToken, leaseToken, runnerId, jobId },
			{ sessionToken, leaseToken, runnerId, jobId },
			{ sessionToken: currentSessionToken, leaseToken, runnerId, jobId },
		]);
		await expect(current.resolve("13131313-1313-4313-8313-131313131313")).rejects.toThrow("another substrate");
	});

	it("keeps Company File objects on a quota-sized lane separate from ordinary artifacts", async () => {
		const current = broker();
		const artifact = new TextEncoder().encode("artifact");
		const companyFile = new TextEncoder().encode("company-file");

		await current.broker.objects.putObject(profileId, artifact, "application/octet-stream");
		await current.broker.companyFileObjects.putObject(profileId, companyFile, "application/octet-stream");

		expect((await current.broker.describe()).companyFileOutputLimits).toEqual({
			maxObjectBytes: 8 * 1024 * 1024,
			maxObjectCount: 509_602,
			maxTotalBytes: 50 * 1024 * 1024 * 1024,
			treeContractVersion: 3,
		});
		expect(current.transport.objectPurposes).toEqual(["artifact", "company_file"]);
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

	it("publishes a changed isolated Company File checkout as one verified candidate revision", async () => {
		const current = broker();
		const companyRoot = await temporaryDirectory();
		scaffoldCompany(companyRoot);
		await writeFile(join(companyRoot, "company.md"), "# Candidate from runner\n", "utf-8");
		const publisher = new CloudRunnerBrokerCompanyFilePublisher(current.broker);
		const description = await current.broker.describe();

		await expect(
			publisher.publish({
				profileId,
				environmentId,
				jobId,
				baseSnapshot: description.snapshot,
				companyRoot,
			}),
		).resolves.toBe(candidateSnapshotId);

		expect(current.transport.companyRevisions).toHaveLength(1);
		expect(current.transport.companyGraphs).toHaveLength(1);
		expect(current.transport.companyGraphEntries).toHaveLength(1);
		expect(current.transport.companyGraphEntries[0]?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sha256: current.transport.companyRevisions[0]?.treeManifestSha256 }),
			]),
		);
		expect(current.transport.objectPurposes.every((purpose) => purpose === "company_file")).toBe(true);
	});

	it("brokers a bounded model request with the current job lease and no provider credential", async () => {
		const current = broker();
		const request = {
			requestId: "34343434-3434-4434-8434-343434343434",
			provider: "openai",
			model: "gpt-test",
			input: { prompt: "Answer from the immutable substrate" },
			maxOutputTokens: 128,
		};
		await expect(current.broker.requestModel(request)).resolves.toMatchObject({
			requestId: request.requestId,
			output: { text: "bounded answer" },
			usage: { inputTokens: 8, outputTokens: 3, costMicrousd: 125 },
		});
		expect(current.transport.modelRequests).toEqual([request]);
		expect(current.transport.authorities.at(-1)).toEqual({ runnerId, jobId, sessionToken, leaseToken });
	});

	it("refuses to route native subscription traffic through the model gateway", async () => {
		const current = broker();
		const sponsor = current.transport.description.sponsor as Record<string, unknown>;
		sponsor.authentication_mode = "native_subscription";
		sponsor.native_harness = "codex-cli";

		await expect(
			current.broker.requestModel({
				requestId: "34343434-3434-4434-8434-343434343434",
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "must stay native" },
				maxOutputTokens: 128,
			}),
		).rejects.toThrow("provider-native harness");
		expect(current.transport.modelRequests).toEqual([]);
	});

	it("binds provider continuity, operation receipts, and transcript output to the assigned run", async () => {
		const current = broker();
		const receiptId = "34343434-3434-4434-8434-343434343434";
		const inputSha256 = "f".repeat(64);
		await expect(
			current.broker.beginOperation({
				receiptId,
				logicalOperationKey: "ticket:123:reply",
				operationKind: "send_email",
				inputSha256,
				downstreamIdempotencyKey: "qorpera-ticket-123-reply",
				requiresCompanyRevision: false,
			}),
		).resolves.toMatchObject({ state: "executing", receiptId });
		await expect(
			current.broker.completeOperation({ receiptId, inputSha256, result: { message_id: "mail-123" } }),
		).resolves.toMatchObject({ state: "completed", result: { message_id: "mail-123" } });
		await expect(
			current.broker.bindProviderSession({ providerSessionId: "codex-session-123" }),
		).resolves.toMatchObject({
			runId,
			providerSessionId: "codex-session-123",
		});
		await expect(
			current.broker.prepareCompanyRevision({
				clientRevisionId: "46464646-4646-4646-8646-464646464646",
				treeManifestSha256: "4".repeat(64),
				treeManifestBytes: 512,
				treeContractVersion: 3,
				fileCount: 4,
				totalBytes: 4096,
			}),
		).resolves.toMatchObject({ parentSnapshotId: snapshotId, tree: { manifestSha256: "4".repeat(64) } });
		await expect(
			current.broker.appendTranscriptEvent({
				eventId: "12121212-1212-4212-8212-121212121212",
				eventType: "message",
				entry: {
					type: "message",
					id: "12121212-1212-4212-8212-121212121212",
					parentId: null,
					timestamp: createdAt,
					message: { role: "assistant", text: "completed" },
				},
				expectedSequence: 0,
			}),
		).resolves.toMatchObject({ executionRunId: runId, assignmentId, sequence: 1 });
		expect(current.transport.begunOperations).toHaveLength(1);
		expect(current.transport.completedOperations).toHaveLength(1);
		expect(current.transport.providerSessions).toHaveLength(1);
		expect(current.transport.companyRevisions).toHaveLength(1);
		expect(current.transport.transcriptEvents).toHaveLength(1);
	});

	it("adopts the durable receipt id when a replacement runner replays a logical operation", async () => {
		const current = broker();
		const durableReceiptId = "34343434-3434-4434-8434-343434343434";
		vi.spyOn(current.transport, "beginOperation").mockResolvedValueOnce({
			state: "completed",
			receipt_id: durableReceiptId,
			result: { message_id: "mail-123" },
		});

		const replacementReceiptId = "35353535-3535-4535-8535-353535353535";
		await expect(
			current.broker.beginOperation({
				receiptId: replacementReceiptId,
				logicalOperationKey: "ticket:123:reply",
				operationKind: "send_email",
				inputSha256: "f".repeat(64),
				downstreamIdempotencyKey: "qorpera-ticket-123-reply",
				requiresCompanyRevision: false,
			}),
		).resolves.toMatchObject({
			state: "completed",
			receiptId: durableReceiptId,
			result: { message_id: "mail-123" },
		});
		await expect(
			current.broker.completeOperation({
				receiptId: replacementReceiptId,
				inputSha256: "f".repeat(64),
				result: { message_id: "mail-123" },
			}),
		).resolves.toMatchObject({ state: "completed", receiptId: durableReceiptId });
		expect(current.transport.completedOperations.at(-1)?.receiptId).toBe(durableReceiptId);
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
		await transport.requestModel(authority, {
			requestId: "34343434-3434-4434-8434-343434343434",
			provider: "openai",
			model: "gpt-test",
			input: { prompt: "safe" },
			maxOutputTokens: 64,
		});

		expect(calls[0]?.url).toBe("https://example.supabase.co/functions/v1/runner-broker");
		expect(calls[0]?.url).not.toContain(sessionToken);
		expect(calls[0]?.url).not.toContain(leaseToken);
		expect(String(calls[0]?.init?.body)).not.toContain(sessionToken);
		expect(String(calls[0]?.init?.body)).not.toContain(leaseToken);
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
		expect(new Headers(calls[0]?.init?.headers).get("x-qorpera-lease-token")).toBe(leaseToken);
		expect(String(calls[1]?.init?.body)).toContain('"action":"model"');
		expect(String(calls[1]?.init?.body)).not.toContain(sessionToken);
		expect(String(calls[1]?.init?.body)).not.toContain(leaseToken);
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

	it("retries transient object write statuses briefly", async () => {
		vi.useFakeTimers();
		try {
			const bytes = new TextEncoder().encode("retried-write");
			const sha = createHash("sha256").update(bytes).digest("hex");
			const statuses = [502, 200];
			let calls = 0;
			const fetchImplementation = (async () => {
				calls++;
				const status = statuses.shift() ?? 200;
				if (status !== 200) return new Response("shed", { status });
				return Response.json({ value: { status: "stored", sha256: sha, bytes: bytes.byteLength } });
			}) as typeof fetch;
			const transport = new SupabaseCloudRunnerBrokerTransport(
				"https://qorpera.example",
				"publishable-key",
				fetchImplementation,
			);
			const pending = transport.putObject(
				{ runnerId, jobId, sessionToken, leaseToken },
				sha,
				bytes,
				"application/octet-stream",
				"company_file",
			);
			await vi.advanceTimersByTimeAsync(2_000);
			await expect(pending).resolves.toBe("stored");
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not resend objects it has already proven durable in this run", async () => {
		const current = broker();
		const bytes = new TextEncoder().encode("durable-object");
		const sha = createHash("sha256").update(bytes).digest("hex");
		current.transport.objects.set(sha, Uint8Array.from(bytes));
		const putsBefore = current.transport.objectPurposes.length;
		await expect(current.broker.readObject(sha)).resolves.toEqual(Uint8Array.from(bytes));
		await expect(current.broker.writeObject(sha, bytes, "application/octet-stream", "company_file")).resolves.toBe(
			"stored",
		);
		expect(current.transport.objectPurposes.length).toBe(putsBefore);
		const fresh = new TextEncoder().encode("fresh-object");
		const freshSha = createHash("sha256").update(fresh).digest("hex");
		await expect(
			current.broker.writeObject(freshSha, fresh, "application/octet-stream", "company_file"),
		).resolves.toBe("stored");
		await expect(
			current.broker.writeObject(freshSha, fresh, "application/octet-stream", "company_file"),
		).resolves.toBe("stored");
		expect(current.transport.objectPurposes.length).toBe(putsBefore + 1);
	});
});

describe("cloud runner broker signed object reads", () => {
	it("follows a broker signed URL and verifies the content hash it addressed", async () => {
		const bytes = new TextEncoder().encode("signed-object-bytes");
		const sha = createHash("sha256").update(bytes).digest("hex");
		const urls: string[] = [];
		const fetchImplementation = (async (url: unknown) => {
			urls.push(String(url));
			if (String(url).startsWith("https://storage.example/")) {
				return new Response(Uint8Array.from(bytes).buffer, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			}
			return Response.json({
				value: {
					transport: "signed-url",
					signedUrl: "https://storage.example/object?token=opaque",
					bytes: bytes.byteLength,
					sha256: sha,
				},
			});
		}) as typeof fetch;
		const transport = new SupabaseCloudRunnerBrokerTransport(
			"https://qorpera.example",
			"publishable-key",
			fetchImplementation,
		);
		await expect(transport.getObject({ runnerId, jobId, sessionToken, leaseToken }, sha)).resolves.toEqual(
			Uint8Array.from(bytes),
		);
		expect(urls).toHaveLength(2);
		expect(urls[1]).toBe("https://storage.example/object?token=opaque");
	});

	it("rejects signed URL downloads whose bytes do not match the addressed hash", async () => {
		const bytes = new TextEncoder().encode("signed-object-bytes");
		const sha = createHash("sha256").update(bytes).digest("hex");
		const fetchImplementation = (async (url: unknown) => {
			if (String(url).startsWith("https://storage.example/")) {
				return new Response(new TextEncoder().encode("tampered").buffer as ArrayBuffer, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			}
			return Response.json({
				value: { transport: "signed-url", signedUrl: "https://storage.example/object", bytes: 8, sha256: sha },
			});
		}) as typeof fetch;
		const transport = new SupabaseCloudRunnerBrokerTransport(
			"https://qorpera.example",
			"publishable-key",
			fetchImplementation,
		);
		await expect(transport.getObject({ runnerId, jobId, sessionToken, leaseToken }, sha)).rejects.toThrow(
			"SHA-256 integrity verification",
		);
	});
});

describe("cloud runner broker incident-scale retry budgets", () => {
	it("rides out minutes of shedding on the durable object path", async () => {
		vi.useFakeTimers();
		try {
			const bytes = new TextEncoder().encode("incident-survivor");
			const sha = createHash("sha256").update(bytes).digest("hex");
			let calls = 0;
			const fetchImplementation = (async () => {
				calls++;
				if (calls <= 6) return new Response("shed", { status: 503 });
				return Response.json({ value: { status: "stored", sha256: sha, bytes: bytes.byteLength } });
			}) as typeof fetch;
			const transport = new SupabaseCloudRunnerBrokerTransport(
				"https://qorpera.example",
				"publishable-key",
				fetchImplementation,
			);
			const pending = transport.putObject(
				{ runnerId, jobId, sessionToken, leaseToken },
				sha,
				bytes,
				"application/octet-stream",
				"company_file",
			);
			for (const delay of [2_000, 4_000, 6_000, 8_000, 10_000, 10_000]) {
				await vi.advanceTimersByTimeAsync(delay);
			}
			await expect(pending).resolves.toBe("stored");
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
