import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalCompanyRoot,
	claimCompanyRuntimeLock,
	releaseCompanyRuntimeLock,
	scaffoldCompany,
} from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it } from "vitest";
import {
	inspectCloudCompanyMerge,
	mergeCloudCompanySnapshots,
	previewCloudCompanySnapshot,
	recoverInterruptedCloudCompanyMerges,
} from "../src/cloud-company-merge.ts";
import { captureCloudCompanyTree, readCloudCompanyTreeManifest } from "../src/cloud-company-snapshot.ts";
import type { CompanyWorkspacePrimary } from "../src/cloud-company-workspace.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type { HostedCompanySnapshot } from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const baseWorkspaceId = "11111111-1111-4111-8111-111111111111";
const localWorkspaceId = "22222222-2222-4222-8222-222222222222";
const remoteWorkspaceId = "33333333-3333-4333-8333-333333333333";
const baseSnapshotId = "44444444-4444-4444-8444-444444444444";
const localSnapshotId = "55555555-5555-4555-8555-555555555555";
const remoteSnapshotId = "66666666-6666-4666-8666-666666666666";
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

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-merge-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function companyRoots(): Promise<{ base: string; local: string; remote: string }> {
	const parent = await temporaryDirectory();
	const base = join(parent, "base");
	const local = join(parent, "local");
	const remote = join(parent, "remote");
	scaffoldCompany(base);
	await writeFile(join(base, "company.md"), "# Shared company\n", "utf-8");
	await mkdir(join(base, "app", "substrates"), { recursive: true });
	await writeFile(join(base, "app", "substrates", "market.md"), "base market\n", "utf-8");
	await cp(base, local, { recursive: true });
	await cp(base, remote, { recursive: true });
	return { base, local, remote };
}

function snapshot(
	snapshotId: string,
	workspaceId: string,
	tree: Awaited<ReturnType<typeof captureCloudCompanyTree>>,
	parentSnapshotId?: string,
): HostedCompanySnapshot {
	return {
		snapshotId,
		profileId,
		environmentId,
		workspaceId,
		clientSnapshotId: snapshotId,
		...(parentSnapshotId ? { parentSnapshotId } : {}),
		tree,
		createdByUserId: actorUserId,
		createdAt,
	};
}

function primary(snapshots: HostedCompanySnapshot[]): Pick<CompanyWorkspacePrimary, "getCompanySnapshot"> {
	const byId = new Map(snapshots.map((entry) => [entry.snapshotId, entry]));
	return {
		getCompanySnapshot: async (snapshotId) => {
			const result = byId.get(snapshotId);
			if (!result) throw new Error("snapshot not found");
			return result;
		},
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud company merge", () => {
	it("previews a verified remote fork and explicitly applies a conflict-free three-way merge", async () => {
		const roots = await companyRoots();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const base = snapshot(
			baseSnapshotId,
			baseWorkspaceId,
			await captureCloudCompanyTree(roots.base, profileId, objects),
		);
		await writeFile(join(roots.local, "local-plan.md"), "local plan\n", "utf-8");
		const local = snapshot(
			localSnapshotId,
			localWorkspaceId,
			await captureCloudCompanyTree(roots.local, profileId, objects),
			baseSnapshotId,
		);
		await writeFile(join(roots.remote, "company.md"), "# Remote company\n", "utf-8");
		await writeFile(join(roots.remote, "remote-plan.md"), "remote plan\n", "utf-8");
		await mkdir(join(roots.remote, "trail"), { recursive: true });
		await writeFile(join(roots.remote, "trail", "private.jsonl"), "remote trail\n", "utf-8");
		const remote = snapshot(
			remoteSnapshotId,
			remoteWorkspaceId,
			await captureCloudCompanyTree(roots.remote, profileId, objects),
			baseSnapshotId,
		);
		const snapshots = primary([base, local, remote]);
		const preview = await previewCloudCompanySnapshot({
			userData: await temporaryDirectory(),
			profileId,
			snapshot: remote,
			objects,
		});
		await expect(readFile(join(preview.path, "remote-plan.md"), "utf-8")).resolves.toBe("remote plan\n");
		await expect(readFile(join(preview.path, "trail", "private.jsonl"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});

		const input = {
			companyRoot: roots.local,
			profileId,
			environmentId,
			localSnapshotId,
			remoteSnapshotId,
			primary: snapshots,
			objects,
		};
		await expect(inspectCloudCompanyMerge(input)).resolves.toMatchObject({
			ancestorSnapshotId: baseSnapshotId,
			conflicts: [],
		});
		const runtimeLock = claimCompanyRuntimeLock(roots.local);
		const merged = await (async () => {
			try {
				return await mergeCloudCompanySnapshots({ ...input, runtimeLock });
			} finally {
				releaseCompanyRuntimeLock(runtimeLock);
			}
		})();
		expect(merged.applied).toBe(true);
		await expect(readFile(join(roots.local, "company.md"), "utf-8")).resolves.toBe("# Remote company\n");
		await expect(readFile(join(roots.local, "local-plan.md"), "utf-8")).resolves.toBe("local plan\n");
		await expect(readFile(join(roots.local, "remote-plan.md"), "utf-8")).resolves.toBe("remote plan\n");
	});

	it("preserves divergent local work without mutating the cache before review", async () => {
		const roots = await companyRoots();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const base = snapshot(
			baseSnapshotId,
			baseWorkspaceId,
			await captureCloudCompanyTree(roots.base, profileId, objects),
		);
		await writeFile(join(roots.local, "company.md"), "# Local company\n", "utf-8");
		const local = snapshot(
			localSnapshotId,
			localWorkspaceId,
			await captureCloudCompanyTree(roots.local, profileId, objects),
			baseSnapshotId,
		);
		await writeFile(join(roots.remote, "company.md"), "# Remote company\n", "utf-8");
		const remote = snapshot(
			remoteSnapshotId,
			remoteWorkspaceId,
			await captureCloudCompanyTree(roots.remote, profileId, objects),
			baseSnapshotId,
		);
		const result = await mergeCloudCompanySnapshots({
			companyRoot: roots.local,
			profileId,
			environmentId,
			localSnapshotId,
			remoteSnapshotId,
			primary: primary([base, local, remote]),
			objects,
		});
		expect(result).toMatchObject({ applied: false, plan: { conflicts: [{ path: "company.md" }] } });
		await expect(readFile(join(roots.local, "company.md"), "utf-8")).resolves.toBe("# Local company\n");
		await expect(
			readFile(join(roots.local, "Company File Conflicts", remoteSnapshotId, "company.md"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("requires unpublished local edits to be checkpointed before applying a remote fork", async () => {
		const roots = await companyRoots();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const base = snapshot(
			baseSnapshotId,
			baseWorkspaceId,
			await captureCloudCompanyTree(roots.base, profileId, objects),
		);
		const local = snapshot(
			localSnapshotId,
			localWorkspaceId,
			await captureCloudCompanyTree(roots.local, profileId, objects),
			baseSnapshotId,
		);
		await writeFile(join(roots.remote, "remote-plan.md"), "remote plan\n", "utf-8");
		const remote = snapshot(
			remoteSnapshotId,
			remoteWorkspaceId,
			await captureCloudCompanyTree(roots.remote, profileId, objects),
			baseSnapshotId,
		);
		await writeFile(join(roots.local, "company.md"), "# Unpublished local company\n", "utf-8");
		await expect(
			mergeCloudCompanySnapshots({
				companyRoot: roots.local,
				profileId,
				environmentId,
				localSnapshotId,
				remoteSnapshotId,
				primary: primary([base, local, remote]),
				objects,
			}),
		).rejects.toThrow("publish them before merging");
		await expect(readFile(join(roots.local, "company.md"), "utf-8")).resolves.toBe("# Unpublished local company\n");
		await expect(readFile(join(roots.local, "remote-plan.md"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["after-backup", "after-install"] as const)(
		"rolls back an interrupted merge %s before the next capture",
		async (crashPoint) => {
			const roots = await companyRoots();
			const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
			const localTree = await captureCloudCompanyTree(roots.local, profileId, objects);
			await writeFile(join(roots.remote, "company.md"), "# Remote company\n", "utf-8");
			const remoteTree = await captureCloudCompanyTree(roots.remote, profileId, objects);
			const [localManifest, remoteManifest] = await Promise.all([
				readCloudCompanyTreeManifest(profileId, localTree, objects),
				readCloudCompanyTreeManifest(profileId, remoteTree, objects),
			]);
			const transactionRoot = join(roots.local, ".qorpera", "w", `cloud-merge-crash-${crashPoint}`);
			const backupRoot = join(transactionRoot, "backup");
			await mkdir(backupRoot, { recursive: true });
			await writeFile(
				join(transactionRoot, "journal.json"),
				`${JSON.stringify({
					schema: "qorpera.cloud-company-merge-journal/v1",
					companyRoot: canonicalCompanyRoot(roots.local),
					localEntries: localManifest.entries,
					resultEntries: remoteManifest.entries,
					createdAt,
				})}\n`,
				"utf-8",
			);
			await rename(join(roots.local, "company.md"), join(backupRoot, "company.md"));
			if (crashPoint === "after-install") {
				await writeFile(join(roots.local, "company.md"), "# Remote company\n", "utf-8");
			}

			await recoverInterruptedCloudCompanyMerges(roots.local);

			await expect(readFile(join(roots.local, "company.md"), "utf-8")).resolves.toBe("# Shared company\n");
			await expect(readFile(transactionRoot, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
});
