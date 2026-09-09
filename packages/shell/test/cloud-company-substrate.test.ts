import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HostedArtifactIndex,
	HostedCompanyOperation,
	HostedCompanySnapshot,
	HostedCompanySubstrateVersion,
} from "@qorpera/cloud-client/hosted-primary";
import {
	CloudCompanySubstrate,
	type CompanySubstratePrimary,
} from "@qorpera/cloud-client/node/cloud-company-substrate";
import { afterEach, describe, expect, it } from "vitest";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const clientSnapshotId = "55555555-5555-4555-8555-555555555555";
const versionId = "66666666-6666-4666-8666-666666666666";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const staffAgentId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-08-16T12:00:00.000Z";
const temporaryDirectories: string[] = [];

const snapshot: HostedCompanySnapshot = {
	snapshotId,
	profileId,
	environmentId,
	workspaceId,
	clientSnapshotId,
	tree: {
		manifestSha256: "a".repeat(64),
		manifestBytes: 128,
		contractVersion: 1,
		fileCount: 1,
		totalBytes: 32,
	},
	createdByUserId: actorUserId,
	createdAt,
};

const operation: HostedCompanyOperation = {
	profileId,
	sequence: 1,
	operationType: "staff_state",
	entityId: staffAgentId,
	entityVersion: 1,
	contentSha256: "b".repeat(64),
	payload: { staff_agent_id: staffAgentId, display_name: "Financial Officer", version: 1 },
	actorUserId,
	createdAt,
};

class MemorySubstratePrimary implements CompanySubstratePrimary {
	readonly versionsByClientId = new Map<string, HostedCompanySubstrateVersion>();
	readonly artifactIndexesByClientId = new Map<string, HostedArtifactIndex>();
	readonly captureClientIds: string[] = [];
	failAfterFirstCapture = false;

	async captureCompanySubstrateVersion(input: {
		snapshotId: string;
		clientVersionId: string;
		artifactIndexId: string;
	}): Promise<HostedCompanySubstrateVersion> {
		this.captureClientIds.push(input.clientVersionId);
		let version = this.versionsByClientId.get(input.clientVersionId);
		if (!version) {
			version = {
				versionId,
				profileId,
				environmentId,
				companySnapshotId: input.snapshotId,
				clientVersionId: input.clientVersionId,
				contractVersion: 1,
				operationSequence: 1,
				operationCount: 1,
				artifactIndexId: input.artifactIndexId,
				artifactManifestSha256: "d".repeat(64),
				contentSha256: "c".repeat(64),
				createdByUserId: actorUserId,
				createdAt,
			};
			this.versionsByClientId.set(input.clientVersionId, version);
			if (this.failAfterFirstCapture) {
				this.failAfterFirstCapture = false;
				throw new Error("response lost after commit");
			}
		}
		return { ...version };
	}

	async createArtifactIndex(input: { clientIndexId: string; artifactIds: string[] }): Promise<HostedArtifactIndex> {
		let index = this.artifactIndexesByClientId.get(input.clientIndexId);
		if (!index) {
			index = {
				indexId: artifactIndexId,
				profileId,
				environmentId,
				clientIndexId: input.clientIndexId,
				contractVersion: 1,
				contentSha256: "d".repeat(64),
				artifactCount: input.artifactIds.length,
				totalBytes: 0,
				createdByUserId: actorUserId,
				createdAt,
			};
			this.artifactIndexesByClientId.set(input.clientIndexId, index);
		}
		return { ...index };
	}

	async getArtifactIndex(requestedIndexId: string): Promise<HostedArtifactIndex> {
		const index = [...this.artifactIndexesByClientId.values()].find(
			(candidate) => candidate.indexId === requestedIndexId,
		);
		if (!index) throw new Error("artifact index not found");
		return { ...index };
	}

	async listArtifactIndexEntries(): Promise<[]> {
		return [];
	}

	async getCompanySubstrateVersion(requestedVersionId: string): Promise<HostedCompanySubstrateVersion> {
		const version = [...this.versionsByClientId.values()].find(
			(candidate) => candidate.versionId === requestedVersionId,
		);
		if (!version) throw new Error("substrate version not found");
		return { ...version };
	}

	async getCompanySnapshot(requestedSnapshotId: string): Promise<HostedCompanySnapshot> {
		if (requestedSnapshotId !== snapshotId) throw new Error("snapshot not found");
		return { ...snapshot, tree: { ...snapshot.tree } };
	}

	async listCompanySubstrateOperations(
		requestedVersionId: string,
		afterSequence = 0,
	): Promise<HostedCompanyOperation[]> {
		if (requestedVersionId !== versionId) throw new Error("substrate version not found");
		return operation.sequence > afterSequence ? [{ ...operation }] : [];
	}
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-substrate-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud company substrate versions", () => {
	it("reuses a durable client identity when a capture response is lost", async () => {
		const primary = new MemorySubstratePrimary();
		primary.failAfterFirstCapture = true;
		const userData = await temporaryDirectory();
		const companyRoot = await temporaryDirectory();
		const options = { userData, companyRoot, profileId, environmentId, primary };

		await expect(new CloudCompanySubstrate(options).publish(snapshot)).rejects.toThrow("response lost");
		await expect(new CloudCompanySubstrate(options).publish(snapshot)).resolves.toMatchObject({
			versionId,
			companySnapshotId: snapshotId,
			operationSequence: 1,
		});
		expect(primary.captureClientIds).toHaveLength(2);
		expect(primary.captureClientIds[0]).toBe(primary.captureClientIds[1]);
	});

	it("lets another machine resolve the immutable tree pointer and replay boundary", async () => {
		const primary = new MemorySubstratePrimary();
		const publisher = new CloudCompanySubstrate({
			userData: await temporaryDirectory(),
			companyRoot: await temporaryDirectory(),
			profileId,
			environmentId,
			primary,
		});
		const published = await publisher.publish(snapshot);
		const collaborator = new CloudCompanySubstrate({
			userData: await temporaryDirectory(),
			companyRoot: await temporaryDirectory(),
			profileId,
			environmentId,
			primary,
		});

		await expect(collaborator.resolve(published.versionId)).resolves.toMatchObject({
			version: { versionId, operationSequence: 1, operationCount: 1, artifactIndexId },
			snapshot: { snapshotId },
			artifactIndex: { indexId: artifactIndexId, artifactCount: 0 },
		});
		await expect(collaborator.listOperations(published, 0, 50)).resolves.toEqual([operation]);
	});
});
