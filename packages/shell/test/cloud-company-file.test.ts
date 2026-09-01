import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it } from "vitest";
import {
	CloudCompanyFileCacheState,
	type CompanyFilePrimary,
	checkpointCloudCompanyFile,
} from "../src/cloud-company-file.ts";
import { replaceCloudCompanyCacheWithSnapshot } from "../src/cloud-company-merge.ts";
import {
	type CloudCompanyTreeReference,
	captureCloudCompanyTree,
	currentCloudCompanyTreeReference,
	materializeCloudCompanyTree,
	readCloudCompanyTreeManifest,
} from "../src/cloud-company-snapshot.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type {
	BeginHostedObjectReachabilityGraphInput,
	HostedCompanyFile,
	HostedCompanySnapshot,
	HostedObjectReachabilityGraph,
	HostedObjectRestoreProof,
} from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-20T12:00:00.000Z";
const temporaryDirectories: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array, _mediaType: string): Promise<"exists" | "stored"> {
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

class MemoryCompanyFilePrimary implements CompanyFilePrimary {
	readonly snapshots = new Map<string, HostedCompanySnapshot>();
	readonly revisions = new Map<string, HostedCompanySnapshot>();
	commitCount = 0;
	headSnapshotId?: string;
	loseNextCommitResponse = false;

	async getCompanyFile(_environmentId: string): Promise<HostedCompanyFile> {
		return {
			profileId,
			environmentId,
			canonicalWorkspaceId: workspaceId,
			...(this.headSnapshotId ? { headSnapshotId: this.headSnapshotId } : {}),
			state: this.headSnapshotId ? "ready" : "provisioning",
			logicalBytes: this.headSnapshotId ? (this.snapshots.get(this.headSnapshotId)?.tree.totalBytes ?? 0) : 0,
			retainedStorageBytes: 0,
			storageUsedBytes: 0,
			storageLimitBytes: 50 * 1024 * 1024 * 1024,
			objectBackends: [],
			entitlement: {
				planKey: "freemium",
				billingMode: "free",
				featureSet: "standard",
				storageAllocation: "metered",
				storageAllocationBytes: 50 * 1024 * 1024 * 1024,
				source: "default",
			},
			createdAt,
			updatedAt: createdAt,
		};
	}

	async prepareCompanyFileRevision(input: {
		environmentId: string;
		clientRevisionId: string;
		expectedHeadSnapshotId?: string;
		tree: CloudCompanyTreeReference;
	}): Promise<HostedCompanySnapshot> {
		const existing = this.revisions.get(input.clientRevisionId);
		if (existing) return existing;
		if (this.headSnapshotId !== input.expectedHeadSnapshotId) {
			throw new Error("company file head changed (PT409)");
		}
		this.commitCount++;
		const snapshotId = `${String(this.commitCount).padStart(8, "0")}-0000-4000-8000-000000000000`;
		const snapshot: HostedCompanySnapshot = {
			snapshotId,
			profileId,
			environmentId,
			workspaceId,
			clientSnapshotId: input.clientRevisionId,
			...(input.expectedHeadSnapshotId ? { parentSnapshotId: input.expectedHeadSnapshotId } : {}),
			tree: input.tree,
			createdByUserId: actorUserId,
			createdAt,
		};
		this.snapshots.set(snapshotId, snapshot);
		this.revisions.set(input.clientRevisionId, snapshot);
		return snapshot;
	}

	async publishCompanyFileRevision(
		_environmentId: string,
		snapshotId: string,
		expectedHeadSnapshotId?: string,
	): Promise<HostedCompanySnapshot> {
		const snapshot = this.snapshots.get(snapshotId);
		if (!snapshot) throw new Error("snapshot not found");
		if (this.headSnapshotId === snapshotId) return snapshot;
		if (this.headSnapshotId !== expectedHeadSnapshotId) throw new Error("company file head changed (PT409)");
		this.headSnapshotId = snapshotId;
		if (this.loseNextCommitResponse) {
			this.loseNextCommitResponse = false;
			throw new Error("network response lost");
		}
		return snapshot;
	}

	async commitCompanyFileRevision(input: {
		environmentId: string;
		clientRevisionId: string;
		expectedHeadSnapshotId?: string;
		tree: CloudCompanyTreeReference;
	}): Promise<HostedCompanySnapshot> {
		const prepared = await this.prepareCompanyFileRevision(input);
		return this.publishCompanyFileRevision(input.environmentId, prepared.snapshotId, input.expectedHeadSnapshotId);
	}

	async beginObjectReachabilityGraph(
		input: BeginHostedObjectReachabilityGraphInput,
	): Promise<HostedObjectReachabilityGraph> {
		return {
			graphId: input.rootId,
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
			status: "complete",
			createdByUserId: actorUserId,
			createdAt,
			completedAt: createdAt,
		};
	}

	async appendObjectReachabilityEntries(
		_graphId: string,
		entries: Array<{ sha256: string; bytes: number }>,
	): Promise<number> {
		return entries.length;
	}

	async completeObjectReachabilityGraph(_graphId: string): Promise<HostedObjectReachabilityGraph> {
		throw new Error("already complete");
	}

	async verifyCompanySnapshotClosure(_snapshotId: string, _graphId: string): Promise<void> {}

	async createObjectRestoreProof(
		graphId: string,
		clientProofId: string,
		restoredContentSha256: string,
		restoredBytes: number,
	): Promise<HostedObjectRestoreProof> {
		return {
			proofId: graphId,
			graphId,
			profileId,
			clientProofId,
			restoredContentSha256,
			restoredBytes,
			verifiedByUserId: actorUserId,
			verifiedAt: createdAt,
			validUntil: "2026-08-27T12:00:00.000Z",
		};
	}

	async getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot> {
		const snapshot = this.snapshots.get(snapshotId);
		if (!snapshot) throw new Error("snapshot not found");
		return snapshot;
	}
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(realpathSync(tmpdir()), "qorpera-company-file-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function captureRemoteTree(root: string, store: CloudContentAddressedStore): Promise<CloudCompanyTreeReference> {
	return captureCloudCompanyTree(root, profileId, store);
}

async function seedCanonicalHead(
	primary: MemoryCompanyFilePrimary,
	root: string,
	objects: CloudContentAddressedStore,
): Promise<void> {
	const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	await mkdir(join(root, "organization", "responsibilities"), { recursive: true });
	await mkdir(join(root, "organization", "projects"), { recursive: true });
	await writeFile(
		join(root, "organization", "formation.json"),
		`${JSON.stringify({
			schema: "qorpera.company-formation/v1",
			formationId: "11111111-1111-4111-8111-111111111112",
			cofounderStaffAgentId: "11111111-1111-4111-8111-111111111111",
			state: "source_inventory",
			status: "active",
			revision: 1,
		})}\n`,
	);
	const tree = await captureRemoteTree(root, objects);
	primary.snapshots.set(snapshotId, {
		snapshotId,
		profileId,
		environmentId,
		workspaceId,
		clientSnapshotId: snapshotId,
		tree,
		createdByUserId: actorUserId,
		createdAt,
	});
	primary.headSnapshotId = snapshotId;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("canonical Company File cache", () => {
	it("refuses to publish any client-owned tree before cloud bootstrap", async () => {
		const root = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "organization"), { recursive: true });
		await writeFile(join(root, "organization", "formation.json"), '{"formationId":"different"}\n');
		const primary = new MemoryCompanyFilePrimary();
		await expect(
			checkpointCloudCompanyFile({
				userData,
				companyRoot: root,
				profileId,
				environmentId,
				primary,
				objects: new CloudContentAddressedStore(new MemoryObjectTransport()),
			}),
		).rejects.toThrow("cloud bootstrap is still provisioning");
		expect(primary.commitCount).toBe(0);
	});

	it("clones the canonical file onto another device and publishes native deletion", async () => {
		const root = join(await temporaryDirectory(), "company");
		const clonedRoot = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "files"), { recursive: true });
		await writeFile(join(root, "files", "clone-me.txt"), "portable\n");
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		await seedCanonicalHead(primary, root, objects);
		const published = await checkpointCloudCompanyFile({
			userData,
			companyRoot: root,
			profileId,
			environmentId,
			primary,
			objects,
		});

		await materializeCloudCompanyTree(
			clonedRoot,
			profileId,
			currentCloudCompanyTreeReference(published.snapshot.tree),
			objects,
		);
		scaffoldCompany(clonedRoot);
		CloudCompanyFileCacheState.open(userData, profileId, environmentId, clonedRoot).adopt(published.snapshot);
		expect(await readFile(join(clonedRoot, "files", "clone-me.txt"), "utf-8")).toBe("portable\n");

		await unlink(join(clonedRoot, "files", "clone-me.txt"));
		const deleted = await checkpointCloudCompanyFile({
			userData,
			companyRoot: clonedRoot,
			profileId,
			environmentId,
			primary,
			objects,
		});
		const manifest = await readCloudCompanyTreeManifest(
			profileId,
			currentCloudCompanyTreeReference(deleted.snapshot.tree),
			objects,
		);
		expect(manifest.entries.map((entry) => entry.path)).toEqual(
			expect.arrayContaining([
				"organization",
				"organization/formation.json",
				"organization/projects",
				"organization/responsibilities",
			]),
		);
		expect(manifest.entries.some((entry) => entry.path === "files/clone-me.txt")).toBe(false);
	});

	it("publishes once and reuses a durable revision id after a lost response", async () => {
		const root = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "files"), { recursive: true });
		await writeFile(join(root, "files", "report.txt"), "first\n");
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		await seedCanonicalHead(primary, root, objects);
		const input = { userData, companyRoot: root, profileId, environmentId, primary, objects };

		await expect(checkpointCloudCompanyFile(input)).resolves.toMatchObject({ changed: false, merged: false });
		expect(primary.commitCount).toBe(0);
		await writeFile(join(root, "files", "report.txt"), "second\n");
		primary.loseNextCommitResponse = true;
		await expect(checkpointCloudCompanyFile(input)).rejects.toThrow("network response lost");
		await writeFile(join(root, "files", "report.txt"), "third\n");
		const recovered = await checkpointCloudCompanyFile(input);
		expect(recovered).toMatchObject({ changed: true, merged: false });
		expect(primary.commitCount).toBe(2);
		const manifest = await readCloudCompanyTreeManifest(
			profileId,
			currentCloudCompanyTreeReference(recovered.snapshot.tree),
			objects,
		);
		const report = manifest.entries.find((entry) => entry.path === "files/report.txt");
		expect(report?.kind).toBe("file");
		if (!report || report.kind !== "file") throw new Error("report was not captured");
		expect(Buffer.from(await objects.getFile(profileId, report.file)).toString("utf-8")).toBe("third\n");
	});

	it("re-uploads an aged-out pending revision before resuming publication", async () => {
		const root = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "files"), { recursive: true });
		const primary = new MemoryCompanyFilePrimary();
		const transport = new MemoryObjectTransport();
		const objects = new CloudContentAddressedStore(transport);
		await seedCanonicalHead(primary, root, objects);
		await checkpointCloudCompanyFile({ userData, companyRoot: root, profileId, environmentId, primary, objects });
		await writeFile(join(root, "files", "report.txt"), "durable\n");
		const input = { userData, companyRoot: root, profileId, environmentId, primary, objects };

		primary.loseNextCommitResponse = true;
		await expect(checkpointCloudCompanyFile(input)).rejects.toThrow("network response lost");
		transport.objects.clear();

		await expect(checkpointCloudCompanyFile(input)).resolves.toMatchObject({ changed: true, merged: false });
		expect(transport.objects.size).toBeGreaterThan(0);
		expect(primary.commitCount).toBe(1);
	});

	it("automatically combines non-conflicting local and canonical changes", async () => {
		const root = join(await temporaryDirectory(), "company");
		const remoteRoot = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "files"), { recursive: true });
		await writeFile(join(root, "files", "base.txt"), "base\n");
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const input = { userData, companyRoot: root, profileId, environmentId, primary, objects };
		await seedCanonicalHead(primary, root, objects);
		await checkpointCloudCompanyFile(input);
		const base = primary.headSnapshotId;

		await cp(root, remoteRoot, { recursive: true });
		await writeFile(join(root, "files", "local.txt"), "local\n");
		await writeFile(join(remoteRoot, "files", "remote.txt"), "remote\n");
		await primary.commitCompanyFileRevision({
			environmentId,
			clientRevisionId: "88888888-8888-4888-8888-888888888888",
			expectedHeadSnapshotId: base,
			tree: await captureRemoteTree(remoteRoot, objects),
		});

		await expect(checkpointCloudCompanyFile(input)).resolves.toMatchObject({ changed: true, merged: true });
		expect(await readFile(join(root, "files", "local.txt"), "utf-8")).toBe("local\n");
		expect(await readFile(join(root, "files", "remote.txt"), "utf-8")).toBe("remote\n");
		expect(primary.commitCount).toBe(2);
	});

	it("stops on conflicting changes until the local version is explicitly published", async () => {
		const root = join(await temporaryDirectory(), "company");
		const remoteRoot = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "files"), { recursive: true });
		await writeFile(join(root, "files", "direction.txt"), "base\n");
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const input = { userData, companyRoot: root, profileId, environmentId, primary, objects };
		await seedCanonicalHead(primary, root, objects);
		await checkpointCloudCompanyFile(input);
		const base = primary.headSnapshotId;

		await cp(root, remoteRoot, { recursive: true });
		await writeFile(join(root, "files", "direction.txt"), "local recommendation\n");
		await writeFile(join(remoteRoot, "files", "direction.txt"), "remote recommendation\n");
		await writeFile(join(remoteRoot, "files", "remote-note.txt"), "remote context\n");
		const remote = await primary.commitCompanyFileRevision({
			environmentId,
			clientRevisionId: "99999999-9999-4999-8999-999999999999",
			expectedHeadSnapshotId: base,
			tree: await captureRemoteTree(remoteRoot, objects),
		});

		await expect(checkpointCloudCompanyFile(input)).rejects.toThrow("change conflict(s) waiting for review");
		expect(await readFile(join(root, "files", "direction.txt"), "utf-8")).toBe("local recommendation\n");
		expect(await readFile(join(root, "files", "remote-note.txt"), "utf-8")).toBe("remote context\n");
		const state = CloudCompanyFileCacheState.open(userData, profileId, environmentId, root);
		expect(state.binding.conflict).toMatchObject({
			baseSnapshotId: base,
			remoteSnapshotId: remote.snapshotId,
			paths: [{ path: "files/direction.txt" }].map((entry) => entry.path),
		});
		expect(primary.commitCount).toBe(1);

		state.resolveConflictAgainst(remote);
		await expect(checkpointCloudCompanyFile(input)).resolves.toMatchObject({ changed: true, merged: false });
		expect(await readFile(join(root, "files", "direction.txt"), "utf-8")).toBe("local recommendation\n");
		expect(await readFile(join(root, "files", "remote-note.txt"), "utf-8")).toBe("remote context\n");
		expect(primary.commitCount).toBe(2);
	});

	it("replaces the exact conflicting local tree only after the cloud version is chosen", async () => {
		const root = join(await temporaryDirectory(), "company");
		const remoteRoot = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "files"), { recursive: true });
		await writeFile(join(root, "files", "direction.txt"), "base\n");
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const input = { userData, companyRoot: root, profileId, environmentId, primary, objects };
		await seedCanonicalHead(primary, root, objects);
		await checkpointCloudCompanyFile(input);
		const base = primary.headSnapshotId;

		await cp(root, remoteRoot, { recursive: true });
		await writeFile(join(root, "files", "direction.txt"), "local recommendation\n");
		await writeFile(join(root, "files", "local-context.txt"), "keep this local context\n");
		await writeFile(join(remoteRoot, "files", "direction.txt"), "remote recommendation\n");
		await writeFile(join(remoteRoot, "files", "remote-note.txt"), "keep this cloud context\n");
		const remote = await primary.commitCompanyFileRevision({
			environmentId,
			clientRevisionId: "77777777-7777-4777-8777-777777777777",
			expectedHeadSnapshotId: base,
			tree: await captureRemoteTree(remoteRoot, objects),
		});
		await expect(checkpointCloudCompanyFile(input)).rejects.toThrow("change conflict(s) waiting for review");
		const state = CloudCompanyFileCacheState.open(userData, profileId, environmentId, root);
		const conflict = state.binding.conflict;
		expect(conflict).toBeDefined();
		if (!conflict) throw new Error("expected a durable Company File conflict");
		expect(await readFile(join(root, "files", "local-context.txt"), "utf-8")).toBe("keep this local context\n");
		expect(await readFile(join(root, "files", "remote-note.txt"), "utf-8")).toBe("keep this cloud context\n");

		await replaceCloudCompanyCacheWithSnapshot({
			companyRoot: root,
			profileId,
			environmentId,
			localTree: conflict.localTree,
			remoteSnapshot: remote,
			conflictPaths: conflict.paths,
			objects,
		});
		state.resolveConflictAgainst(remote);
		await expect(checkpointCloudCompanyFile(input)).resolves.toMatchObject({ changed: true, merged: false });
		expect(await readFile(join(root, "files", "direction.txt"), "utf-8")).toBe("remote recommendation\n");
		expect(await readFile(join(root, "files", "local-context.txt"), "utf-8")).toBe("keep this local context\n");
		expect(await readFile(join(root, "files", "remote-note.txt"), "utf-8")).toBe("keep this cloud context\n");
		expect(primary.commitCount).toBe(2);
	});
});
