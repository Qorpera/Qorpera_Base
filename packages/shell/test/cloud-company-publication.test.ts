import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeginHostedObjectReachabilityGraphInput,
	HostedCompanyFile,
	HostedCompanySnapshot,
	HostedObjectReachabilityGraph,
	HostedObjectRestoreProof,
} from "@qorpera/cloud-client/hosted-primary";
import {
	type CloudCompanyTreeReference,
	captureCloudCompanyTree,
} from "@qorpera/cloud-client/node/cloud-company-snapshot";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyFilePrimary } from "../src/cloud-company-file.ts";
import { CloudCompanyPublication } from "../src/cloud-company-publication.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
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

class MemoryCompanyFilePrimary implements CompanyFilePrimary {
	readonly snapshots = new Map<string, HostedCompanySnapshot>();
	readonly revisions = new Map<string, HostedCompanySnapshot>();
	commitCount = 0;
	headSnapshotId?: string;

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
		if (this.headSnapshotId !== input.expectedHeadSnapshotId) throw new Error("company file head changed (PT409)");
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
		return snapshot;
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
	const directory = await mkdtemp(join(realpathSync(tmpdir()), "qorpera-company-publication-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function seedCanonicalHead(
	primary: MemoryCompanyFilePrimary,
	root: string,
	objects: CloudContentAddressedStore,
): Promise<void> {
	const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const tree = await captureCloudCompanyTree(root, profileId, objects);
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

describe("automatic cloud company publication", () => {
	it("deduplicates checkpoints, debounces logical changes, and adopts a newer canonical head", async () => {
		const root = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "app", "substrates"), { recursive: true });
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		await seedCanonicalHead(primary, root, objects);
		let debounceCallback: (() => void) | undefined;
		const timer = setTimeout(() => undefined, 60_000);
		clearTimeout(timer);
		const checkpoints: boolean[] = [];
		const publication = new CloudCompanyPublication({
			userData,
			companyRoot: root,
			profileId,
			environmentId,
			primary,
			objects,
			onCheckpoint: (checkpoint) => {
				checkpoints.push(checkpoint.changed);
			},
			setDebounceTimer: (callback) => {
				debounceCallback = callback;
				return timer;
			},
			clearDebounceTimer: () => undefined,
		});

		await expect(publication.publishNow()).resolves.toMatchObject({ phase: "healthy" });
		expect(primary.commitCount).toBe(0);
		await publication.publishNow();
		expect(primary.commitCount).toBe(0);
		expect(checkpoints).toEqual([false, false]);

		publication.notifyPathChanged("trail/local.jsonl");
		expect(debounceCallback).toBeUndefined();
		await writeFile(join(root, "app", "substrates", "market.md"), "new evidence\n", "utf-8");
		publication.notifyPathChanged("app/substrates/market.md");
		expect(debounceCallback).toBeDefined();
		debounceCallback?.();
		await vi.waitFor(() => expect(publication.lastCheckpoint()).toMatchObject({ changed: true }), {
			timeout: 15_000,
		});
		expect(primary.commitCount).toBe(1);

		const localHead = primary.headSnapshotId!;
		const remoteHead = "99999999-9999-4999-8999-999999999999";
		const localSnapshot = primary.snapshots.get(localHead)!;
		primary.snapshots.set(remoteHead, {
			...localSnapshot,
			snapshotId: remoteHead,
			clientSnapshotId: "88888888-8888-4888-8888-888888888888",
			parentSnapshotId: localHead,
		});
		primary.headSnapshotId = remoteHead;
		await expect(publication.publishNow()).resolves.toMatchObject({ phase: "healthy" });
		expect(primary.commitCount).toBe(1);
	});

	it("does not clear a newer dirty generation after an older checkpoint finishes", async () => {
		const root = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "app", "substrates"), { recursive: true });
		const primary = new MemoryCompanyFilePrimary();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		await writeFile(join(root, "app", "substrates", "market.md"), "first\n", "utf-8");
		await seedCanonicalHead(primary, root, objects);
		let checkpointRuns = 0;
		let publication: CloudCompanyPublication;
		publication = new CloudCompanyPublication({
			userData,
			companyRoot: root,
			profileId,
			environmentId,
			primary,
			objects,
			runCheckpoint: async (run) => {
				const result = await run();
				checkpointRuns += 1;
				if (checkpointRuns === 1) {
					await writeFile(join(root, "app", "substrates", "market.md"), "second\n", "utf-8");
					publication.notifyPathChanged("app/substrates/market.md");
				}
				return result;
			},
		});

		await expect(publication.publishNow()).resolves.toMatchObject({ phase: "healthy" });
		expect(primary.commitCount).toBe(1);
		expect(checkpointRuns).toBeGreaterThanOrEqual(2);
		expect(publication.hasPendingWork()).toBe(false);
	});
});
