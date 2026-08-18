import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCompanyPublication } from "../src/cloud-company-publication.ts";
import type { CloudCompanyTreeReference } from "../src/cloud-company-snapshot.ts";
import type { CompanyWorkspacePrimary } from "../src/cloud-company-workspace.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type { HostedCompanySnapshot } from "../src/hosted-primary.ts";

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

class MemoryWorkspacePrimary implements CompanyWorkspacePrimary {
	readonly snapshots = new Map<string, HostedCompanySnapshot>();
	commitCount = 0;
	headSnapshotId?: string;

	async ensureCompanyWorkspace(input: { clientWorkspaceId: string; name: string }) {
		return {
			workspaceId,
			profileId,
			environmentId,
			clientWorkspaceId: input.clientWorkspaceId,
			name: input.name,
			...(this.headSnapshotId ? { headSnapshotId: this.headSnapshotId } : {}),
			createdByUserId: actorUserId,
			createdAt,
			updatedAt: createdAt,
		};
	}

	async commitCompanySnapshot(input: {
		clientSnapshotId: string;
		expectedHeadSnapshotId?: string;
		tree: CloudCompanyTreeReference;
	}): Promise<HostedCompanySnapshot> {
		if (this.headSnapshotId !== input.expectedHeadSnapshotId)
			throw new Error("company workspace head changed (PT409)");
		this.commitCount++;
		const snapshotId = `${String(this.commitCount).padStart(8, "0")}-0000-4000-8000-000000000000`;
		const snapshot: HostedCompanySnapshot = {
			snapshotId,
			profileId,
			environmentId,
			workspaceId,
			clientSnapshotId: input.clientSnapshotId,
			...(input.expectedHeadSnapshotId ? { parentSnapshotId: input.expectedHeadSnapshotId } : {}),
			tree: input.tree,
			createdByUserId: actorUserId,
			createdAt,
		};
		this.snapshots.set(snapshotId, snapshot);
		this.headSnapshotId = snapshotId;
		return snapshot;
	}

	async getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot> {
		const snapshot = this.snapshots.get(snapshotId);
		if (!snapshot) throw new Error("snapshot not found");
		return snapshot;
	}
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-publication-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("automatic cloud company publication", () => {
	it("deduplicates steady checkpoints, debounces logical changes, and stops on a remote head conflict", async () => {
		const root = join(await temporaryDirectory(), "company");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "app", "substrates"), { recursive: true });
		const primary = new MemoryWorkspacePrimary();
		let debounceCallback: (() => void) | undefined;
		const timer = setTimeout(() => undefined, 60_000);
		clearTimeout(timer);
		const checkpoints: boolean[] = [];
		const publication = new CloudCompanyPublication({
			userData,
			companyRoot: root,
			profileId,
			environmentId,
			workspaceName: "Local test workspace",
			primary,
			objects: new CloudContentAddressedStore(new MemoryObjectTransport()),
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
		expect(primary.commitCount).toBe(1);
		await publication.publishNow();
		expect(primary.commitCount).toBe(1);
		expect(checkpoints).toEqual([true, false]);

		publication.notifyPathChanged("trail/local.jsonl");
		expect(debounceCallback).toBeUndefined();
		await writeFile(join(root, "app", "substrates", "market.md"), "new evidence\n", "utf-8");
		publication.notifyPathChanged("app/substrates/market.md");
		expect(debounceCallback).toBeDefined();
		debounceCallback?.();
		await vi.waitFor(() => expect(primary.commitCount).toBe(2));
		expect(publication.lastCheckpoint()).toMatchObject({ changed: true });

		primary.headSnapshotId = "99999999-9999-4999-8999-999999999999";
		await expect(publication.publishNow()).resolves.toMatchObject({ phase: "attention" });
		expect(publication.health().lastError).toContain("head changed");
		expect(primary.commitCount).toBe(2);
	});
});
