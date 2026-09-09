import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedCompanySnapshot, HostedCompanyWorkspace } from "@qorpera/cloud-client/hosted-primary";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyWorkspaceInboxSync,
	type CompanyWorkspaceInboxPrimary,
	readCloudCompanyInbox,
} from "../src/cloud-company-inbox.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const localWorkspaceId = "22222222-2222-4222-8222-222222222222";
const localClientWorkspaceId = "33333333-3333-4333-8333-333333333333";
const localSnapshotId = "44444444-4444-4444-8444-444444444444";
const remoteWorkspaceId = "55555555-5555-4555-8555-555555555555";
const remoteClientWorkspaceId = "66666666-6666-4666-8666-666666666666";
const remoteSnapshotId = "77777777-7777-4777-8777-777777777777";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-16T12:00:00.000Z";
const temporaryDirectories: string[] = [];

function workspace(
	workspaceId: string,
	clientWorkspaceId: string,
	name: string,
	headSnapshotId: string,
): HostedCompanyWorkspace {
	return {
		workspaceId,
		profileId,
		environmentId,
		clientWorkspaceId,
		name,
		headSnapshotId,
		createdByUserId: actorUserId,
		createdAt,
		updatedAt: createdAt,
	};
}

function snapshot(snapshotId: string, workspaceId: string, hash: string): HostedCompanySnapshot {
	return {
		snapshotId,
		profileId,
		environmentId,
		workspaceId,
		clientSnapshotId: snapshotId,
		tree: {
			manifestSha256: hash.repeat(64),
			manifestBytes: 128,
			contractVersion: 1,
			fileCount: 1,
			totalBytes: 64,
		},
		createdByUserId: actorUserId,
		createdAt,
	};
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-inbox-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud company workspace inbox", () => {
	it("persists verified local and remote heads and refreshes only from workspace invalidations", async () => {
		const userData = await temporaryDirectory();
		const companyRoot = await temporaryDirectory();
		const workspaces = [
			workspace(remoteWorkspaceId, remoteClientWorkspaceId, "Contributor fork", remoteSnapshotId),
			workspace(localWorkspaceId, localClientWorkspaceId, "This machine", localSnapshotId),
		];
		const snapshots = new Map([
			[localSnapshotId, snapshot(localSnapshotId, localWorkspaceId, "a")],
			[remoteSnapshotId, snapshot(remoteSnapshotId, remoteWorkspaceId, "b")],
		]);
		const primary: CompanyWorkspaceInboxPrimary = {
			listCompanyWorkspaces: vi.fn(async () => workspaces),
			getCompanySnapshot: vi.fn(async (snapshotId) => {
				const result = snapshots.get(snapshotId);
				if (!result) throw new Error("snapshot not found");
				return result;
			}),
		};
		const sync = new CloudCompanyWorkspaceInboxSync({
			userData,
			companyRoot,
			profileId,
			environmentId,
			localClientWorkspaceId,
			primary,
			now: () => Date.parse(createdAt),
		});

		await expect(sync.refreshNow()).resolves.toMatchObject({ phase: "healthy" });
		expect(sync.inbox()).toMatchObject({
			refreshedAt: createdAt,
			workspaces: [
				{ workspaceId: localWorkspaceId, isLocal: true, head: { snapshotId: localSnapshotId } },
				{ workspaceId: remoteWorkspaceId, isLocal: false, head: { snapshotId: remoteSnapshotId } },
			],
		});
		expect(readCloudCompanyInbox(userData, profileId, environmentId)).toEqual(sync.inbox());

		const listCalls = vi.mocked(primary.listCompanyWorkspaces).mock.calls.length;
		sync.handleRealtimeChange({ resource: "trail" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(primary.listCompanyWorkspaces).toHaveBeenCalledTimes(listCalls);
		sync.handleRealtimeChange({ resource: "company-file" });
		await vi.waitFor(() => expect(primary.listCompanyWorkspaces).toHaveBeenCalledTimes(listCalls + 1));
		expect(primary.getCompanySnapshot).toHaveBeenCalledWith(remoteSnapshotId);
	});
});
