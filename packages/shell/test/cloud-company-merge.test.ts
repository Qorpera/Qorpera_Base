import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
	mergeCloudCompanySnapshotsForReview,
	previewCloudCompanySnapshot,
	recoverInterruptedCloudCompanyMerges,
} from "../src/cloud-company-merge.ts";
import { prepareCompanyProposalReview } from "../src/cloud-company-proposal-review.ts";
import { captureCloudCompanyTree, readCloudCompanyTreeManifest } from "../src/cloud-company-snapshot.ts";
import type { CompanyWorkspacePrimary } from "../src/cloud-company-workspace.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type { HostedCompanyProposal, HostedCompanySnapshot, QorperaHostedPrimary } from "../src/hosted-primary.ts";

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

	it("keeps conflict metadata outside the logical merge result", async () => {
		const roots = await companyRoots();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const base = snapshot(
			baseSnapshotId,
			baseWorkspaceId,
			await captureCloudCompanyTree(roots.base, profileId, objects),
		);
		await writeFile(join(roots.local, "company.md"), "# Proposed company\n", "utf-8");
		const local = snapshot(
			localSnapshotId,
			localWorkspaceId,
			await captureCloudCompanyTree(roots.local, profileId, objects),
			baseSnapshotId,
		);
		await writeFile(join(roots.remote, "company.md"), "# Current company\n", "utf-8");
		const remote = snapshot(
			remoteSnapshotId,
			remoteWorkspaceId,
			await captureCloudCompanyTree(roots.remote, profileId, objects),
			baseSnapshotId,
		);

		const result = await mergeCloudCompanySnapshotsForReview({
			companyRoot: roots.local,
			profileId,
			environmentId,
			localSnapshotId,
			remoteSnapshotId,
			primary: primary([base, local, remote]),
			objects,
		});

		expect(result).toMatchObject({ applied: false, plan: { conflicts: [{ path: "company.md" }] } });
		await expect(readFile(join(roots.local, "company.md"), "utf-8")).resolves.toBe("# Proposed company\n");
		await expect(
			readFile(join(roots.local, "Company File Conflicts", remoteSnapshotId, "company.md"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("persists a stale-head proposal review until its conflict copies are resolved", async () => {
		const roots = await companyRoots();
		const userData = await temporaryDirectory();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const base = snapshot(
			baseSnapshotId,
			baseWorkspaceId,
			await captureCloudCompanyTree(roots.base, profileId, objects),
		);
		await writeFile(join(roots.local, "company.md"), "# Proposed company\n", "utf-8");
		const proposed = snapshot(
			localSnapshotId,
			localWorkspaceId,
			await captureCloudCompanyTree(roots.local, profileId, objects),
			baseSnapshotId,
		);
		await writeFile(join(roots.remote, "company.md"), "# Current company\n", "utf-8");
		const current = snapshot(
			remoteSnapshotId,
			remoteWorkspaceId,
			await captureCloudCompanyTree(roots.remote, profileId, objects),
			baseSnapshotId,
		);
		const proposal: HostedCompanyProposal = {
			proposalId: "77777777-7777-4777-8777-777777777777",
			profileId,
			environmentId,
			clientProposalId: "88888888-8888-4888-8888-888888888888",
			baseSnapshotId,
			proposalSnapshot: proposed,
			execution: {
				kind: "turn",
				id: "99999999-9999-4999-8999-999999999999",
				claimantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			},
			sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			trailEndSequence: 2,
			reason: "conflict",
			title: "Review Company File",
			reviewerStaffIds: [],
			reviewRevision: 1,
			reviews: [],
			status: "open",
			createdByUserId: actorUserId,
			createdByName: "Founder",
			createdAt,
		};
		const snapshots = primary([base, proposed, current]);
		const input = {
			userData,
			profileId,
			environmentId,
			proposal,
			head: current,
			primary: snapshots as unknown as QorperaHostedPrimary,
			objects,
		};

		const review = await prepareCompanyProposalReview(input);

		expect(review).toMatchObject({ conflictCount: 1, hasUnresolvedConflicts: true });
		const unresolved = (await readdir(join(review.path, "Conflict Review", "Unresolved"))).filter((name) =>
			name.endsWith(".json"),
		);
		expect(unresolved).toHaveLength(1);
		const conflictId = unresolved[0]?.slice(0, -".json".length);
		await expect(
			readFile(join(review.path, "Conflict Review", "Evidence", conflictId ?? "", "current.bin"), "utf-8"),
		).resolves.toBe("# Current company\n");
		await rm(join(review.path, "Conflict Review", "Unresolved", unresolved[0] ?? "missing"));
		await expect(prepareCompanyProposalReview(input)).resolves.toMatchObject({
			path: review.path,
			conflictCount: 1,
			hasUnresolvedConflicts: false,
		});
	});

	it("requires an explicit marker resolution for edit-versus-delete conflicts", async () => {
		const roots = await companyRoots();
		const userData = await temporaryDirectory();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const base = snapshot(
			baseSnapshotId,
			baseWorkspaceId,
			await captureCloudCompanyTree(roots.base, profileId, objects),
		);
		await writeFile(join(roots.local, "company.md"), "# Proposed company\n", "utf-8");
		const proposed = snapshot(
			localSnapshotId,
			localWorkspaceId,
			await captureCloudCompanyTree(roots.local, profileId, objects),
			baseSnapshotId,
		);
		await rm(join(roots.remote, "company.md"));
		const current = snapshot(
			remoteSnapshotId,
			remoteWorkspaceId,
			await captureCloudCompanyTree(roots.remote, profileId, objects),
			baseSnapshotId,
		);
		const proposal: HostedCompanyProposal = {
			proposalId: "77777777-7777-4777-8777-777777777777",
			profileId,
			environmentId,
			clientProposalId: "88888888-8888-4888-8888-888888888888",
			baseSnapshotId,
			proposalSnapshot: proposed,
			execution: {
				kind: "run",
				id: "99999999-9999-4999-8999-999999999999",
				claimantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			},
			trailEndSequence: 2,
			reason: "conflict",
			title: "Review Company File",
			reviewerStaffIds: [],
			reviewRevision: 1,
			reviews: [],
			status: "open",
			createdByUserId: actorUserId,
			createdByName: "Founder",
			createdAt,
		};
		const snapshots = primary([base, proposed, current]);
		const input = {
			userData,
			profileId,
			environmentId,
			proposal,
			head: current,
			primary: snapshots as unknown as QorperaHostedPrimary,
			objects,
		};
		const review = await prepareCompanyProposalReview(input);
		expect(review).toMatchObject({ conflictCount: 1, hasUnresolvedConflicts: true });
		await rm(join(review.path, "Conflict Review"), { recursive: true });
		await expect(prepareCompanyProposalReview(input)).rejects.toThrow("conflict review metadata is missing");
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
