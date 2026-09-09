import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedArtifact, HostedObjectReachabilityGraph } from "@qorpera/cloud-client/hosted-primary";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ObjectReachabilityPrimary,
	publishArtifactRestoreProof,
	publishCompanySnapshotRestoreProofIfDue,
} from "../src/cloud-object-reachability.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const artifactId = "88888888-8888-4888-8888-888888888888";
const graphId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const proofId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-16T12:00:00.000Z";
const temporaryDirectories: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

function graphRecord(
	input: Parameters<ObjectReachabilityPrimary["beginObjectReachabilityGraph"]>[0],
	status: "uploading" | "complete",
): HostedObjectReachabilityGraph {
	return {
		graphId,
		profileId,
		environmentId,
		rootKind: input.rootKind,
		rootId: input.rootId,
		clientGraphId: input.clientGraphId,
		rootObjectSha256: input.rootObjectSha256,
		contractVersion: 1,
		contentSha256: input.contentSha256,
		objectCount: input.objectCount,
		storageBytes: input.storageBytes,
		status,
		createdByUserId: actorUserId,
		createdAt,
		...(status === "complete" ? { completedAt: createdAt } : {}),
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud object reachability", () => {
	it("reconstructs a chunked artifact before publishing its complete object closure", async () => {
		const store = new CloudContentAddressedStore(new MemoryObjectTransport());
		const bytes = Buffer.alloc(4 * 1024 * 1024 + 29, 9);
		const reference = await store.putFile(profileId, bytes, "application/pdf");
		const artifact: HostedArtifact = {
			artifactId,
			profileId,
			environmentId,
			clientArtifactId: artifactId,
			artifactType: "report",
			name: "Verified report",
			rootObjectSha256: reference.manifestSha256,
			rootContract: "qorpera.cloud-file-manifest/v1",
			contentSha256: reference.fileSha256,
			bytes: reference.bytes,
			mediaType: reference.mediaType,
			createdByUserId: actorUserId,
			createdAt,
			eligibleForGcAt: "2026-09-15T12:00:00.000Z",
		};
		let graph: HostedObjectReachabilityGraph | undefined;
		const uploaded: Array<{ sha256: string; bytes: number }> = [];
		const primary: ObjectReachabilityPrimary = {
			beginObjectReachabilityGraph: vi.fn(async (input) => {
				graph = graphRecord(input, "uploading");
				return graph;
			}),
			appendObjectReachabilityEntries: vi.fn(async (_graphId, entries) => {
				uploaded.push(...entries);
				return uploaded.length;
			}),
			completeObjectReachabilityGraph: vi.fn(async () => {
				if (!graph) throw new Error("reachability graph was not started");
				return { ...graph, status: "complete" as const, completedAt: createdAt };
			}),
			verifyCompanySnapshotClosure: vi.fn(async () => undefined),
			createObjectRestoreProof: vi.fn(async (requestedGraphId, clientProofId, contentSha256, restoredBytes) => ({
				proofId,
				graphId: requestedGraphId,
				profileId,
				clientProofId,
				restoredContentSha256: contentSha256,
				restoredBytes,
				verifiedByUserId: actorUserId,
				verifiedAt: createdAt,
				validUntil: "2026-08-23T12:00:00.000Z",
			})),
		};

		await expect(publishArtifactRestoreProof(artifact, store, primary)).resolves.toMatchObject({
			graph: { graphId, status: "complete", objectCount: 3 },
			proof: { graphId, restoredContentSha256: reference.fileSha256, restoredBytes: bytes.byteLength },
		});
		expect(uploaded).toHaveLength(3);
		expect(uploaded).toContainEqual({ sha256: reference.manifestSha256, bytes: expect.any(Number) });
		expect(primary.createObjectRestoreProof).toHaveBeenCalledWith(
			graphId,
			expect.stringMatching(/^[0-9a-f-]{36}$/),
			reference.fileSha256,
			bytes.byteLength,
		);
	});

	it("persists proof validity and skips redundant full snapshot restores", async () => {
		const store = new CloudContentAddressedStore(new MemoryObjectTransport());
		const manifest = Buffer.from(
			JSON.stringify({
				schema: "qorpera.company-tree/v1",
				contractVersion: 3,
				omittedLayers: [
					"company-git-history",
					"session-trail",
					"staff-registry",
					"product-git-checkouts",
					"dependency-caches",
					"staff-instructions",
					"system-metadata",
				],
				entries: [],
			}),
			"utf-8",
		);
		const root = await store.putObject(profileId, manifest, "application/vnd.qorpera.company-tree+json");
		let graph: HostedObjectReachabilityGraph | undefined;
		const primary: ObjectReachabilityPrimary = {
			beginObjectReachabilityGraph: vi.fn(async (input) => {
				graph = graphRecord(input, "uploading");
				return graph;
			}),
			appendObjectReachabilityEntries: vi.fn(async () => 1),
			completeObjectReachabilityGraph: vi.fn(async () => {
				if (!graph) throw new Error("reachability graph was not started");
				return { ...graph, status: "complete" as const, completedAt: createdAt };
			}),
			verifyCompanySnapshotClosure: vi.fn(async () => undefined),
			createObjectRestoreProof: vi.fn(async (requestedGraphId, clientProofId, contentSha256, restoredBytes) => ({
				proofId,
				graphId: requestedGraphId,
				profileId,
				clientProofId,
				restoredContentSha256: contentSha256,
				restoredBytes,
				verifiedByUserId: actorUserId,
				verifiedAt: createdAt,
				validUntil: "2026-08-23T12:00:00.000Z",
			})),
		};
		const userData = await mkdtemp(join(tmpdir(), "qorpera-reachability-"));
		temporaryDirectories.push(userData);
		const options = {
			userData,
			companyRoot: join(userData, "company"),
			snapshot: {
				snapshotId: artifactId,
				profileId,
				environmentId,
				workspaceId: "22222222-2222-4222-8222-222222222222",
				clientSnapshotId: "55555555-5555-4555-8555-555555555555",
				tree: {
					manifestSha256: root.sha256,
					manifestBytes: root.bytes,
					contractVersion: 3,
					fileCount: 0,
					totalBytes: 0,
				},
				createdByUserId: actorUserId,
				createdAt,
			},
			store,
			primary,
			now: new Date("2026-08-16T12:00:00.000Z"),
		};

		await expect(publishCompanySnapshotRestoreProofIfDue(options)).resolves.toBeDefined();
		await expect(publishCompanySnapshotRestoreProofIfDue(options)).resolves.toBeUndefined();
		expect(primary.beginObjectReachabilityGraph).toHaveBeenCalledTimes(1);
		expect(primary.verifyCompanySnapshotClosure).toHaveBeenCalledTimes(1);
	});
});
