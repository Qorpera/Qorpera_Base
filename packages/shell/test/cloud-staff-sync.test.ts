import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archiveStaffAgent,
	createStaffAgent,
	deleteStaffAgent,
	readStaffAgents,
	type StaffAgent,
	updateStaffAgent,
} from "@qorpera/pi-coding-agent/company-staff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudStaffSynchronizer } from "../src/cloud-staff-sync.ts";
import type { HostedStaffAgent, QorperaHostedPrimary } from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";

describe("cloud staff sync", () => {
	let userData: string;
	let ownerRoot: string;
	let friendRoot: string;
	let records: Map<string, HostedStaffAgent>;
	let primary: Pick<QorperaHostedPrimary, "deleteStaff" | "listStaff" | "putStaff">;

	beforeEach(() => {
		userData = mkdtempSync(join(tmpdir(), "qorpera-cloud-staff-state-"));
		ownerRoot = mkdtempSync(join(tmpdir(), "qorpera-cloud-staff-owner-"));
		friendRoot = mkdtempSync(join(tmpdir(), "qorpera-cloud-staff-friend-"));
		records = new Map();
		primary = {
			listStaff: async () =>
				[...records.values()].map((staff) => ({ ...staff, appearance: { ...staff.appearance } })),
			deleteStaff: async (_profileId: string, staffAgentId: string, expectedVersion: number) => {
				const current = records.get(staffAgentId);
				if (current && current.version !== expectedVersion) throw new Error("staff version conflict (40001)");
				records.delete(staffAgentId);
			},
			putStaff: async (_profileId: string, staff: StaffAgent, expectedVersion?: number) => {
				const current = records.get(staff.id);
				if ((current?.version ?? undefined) !== expectedVersion) throw new Error("staff version conflict (40001)");
				const hosted: HostedStaffAgent = {
					...staff,
					appearance: { ...staff.appearance },
					profileId,
					version: (current?.version ?? 0) + 1,
					updatedByUserId: actorUserId,
				};
				records.set(staff.id, hosted);
				return hosted;
			},
		};
	});

	afterEach(() => {
		for (const path of [userData, ownerRoot, friendRoot]) rmSync(path, { recursive: true, force: true });
	});

	it("seeds a promoted roster and materializes it on another machine", async () => {
		const created = createStaffAgent(ownerRoot, {
			displayName: "Financial Officer",
			role: "Finance lead",
			charter: "Maintain the verified financial baseline.",
			appearance: { color: "green", shape: "gem" },
		});
		const owner = new CloudStaffSynchronizer({ root: ownerRoot, userData, profileId, primary, canWrite: () => true });
		await expect(owner.sync()).resolves.toEqual({ created: 1, updated: 0, downloaded: 0 });

		const friend = new CloudStaffSynchronizer({
			root: friendRoot,
			userData,
			profileId,
			primary,
			canWrite: () => true,
		});
		await expect(friend.sync()).resolves.toEqual({ created: 0, updated: 0, downloaded: 1 });
		expect(readStaffAgents(friendRoot)).toEqual([created]);
	});

	it("repairs a missing generated instruction file from an unchanged cloud roster", async () => {
		const created = createStaffAgent(ownerRoot, {
			displayName: "Research Lead",
			role: "Research lead",
			charter: "Maintain the verified research baseline.",
			appearance: { color: "blue", shape: "round" },
		});
		const owner = new CloudStaffSynchronizer({ root: ownerRoot, userData, profileId, primary, canWrite: () => true });
		const friend = new CloudStaffSynchronizer({
			root: friendRoot,
			userData,
			profileId,
			primary,
			canWrite: () => true,
		});
		await owner.sync();
		await friend.sync();
		rmSync(join(friendRoot, "agents", created.id, "instructions.md"));
		expect(() => readStaffAgents(friendRoot)).toThrow(`Agent instructions are missing: ${created.id}`);

		await expect(friend.sync()).resolves.toEqual({ created: 0, updated: 0, downloaded: 0 });
		expect(readStaffAgents(friendRoot)).toEqual([created]);
	});

	it("uploads one-sided edits and rejects concurrent edits", async () => {
		const created = createStaffAgent(ownerRoot, {
			displayName: "Operator",
			role: "Operations lead",
			charter: "Keep recurring work moving.",
			appearance: { color: "orange", shape: "round" },
		});
		const owner = new CloudStaffSynchronizer({ root: ownerRoot, userData, profileId, primary, canWrite: () => true });
		await owner.sync();
		const friend = new CloudStaffSynchronizer({
			root: friendRoot,
			userData,
			profileId,
			primary,
			canWrite: () => true,
		});
		await friend.sync();

		updateStaffAgent(ownerRoot, created.id, { displayName: "Owner edit" });
		await expect(owner.sync()).resolves.toMatchObject({ updated: 1 });
		await expect(friend.sync()).resolves.toMatchObject({ downloaded: 1 });
		expect(readStaffAgents(friendRoot)[0]?.displayName).toBe("Owner edit");

		updateStaffAgent(ownerRoot, created.id, { displayName: "Concurrent owner edit" });
		updateStaffAgent(friendRoot, created.id, { displayName: "Concurrent friend edit" });
		await owner.sync();
		await expect(friend.sync()).rejects.toThrow("changed on this computer and in the cloud");
	});

	it("accepts equal content after a remote update commits but its response is lost", async () => {
		const created = createStaffAgent(ownerRoot, {
			displayName: "Operator",
			role: "Operations lead",
			charter: "Keep recurring work moving.",
			appearance: { color: "orange", shape: "round" },
		});
		const initial = new CloudStaffSynchronizer({
			root: ownerRoot,
			userData,
			profileId,
			primary,
			canWrite: () => true,
		});
		await initial.sync();
		updateStaffAgent(ownerRoot, created.id, { displayName: "Committed remotely" });
		const stablePrimary = primary;
		let loseResponse = true;
		const unreliablePrimary: Pick<QorperaHostedPrimary, "deleteStaff" | "listStaff" | "putStaff"> = {
			deleteStaff: (requestedProfileId, staffAgentId, expectedVersion) =>
				stablePrimary.deleteStaff(requestedProfileId, staffAgentId, expectedVersion),
			listStaff: (requestedProfileId) => stablePrimary.listStaff(requestedProfileId),
			putStaff: async (requestedProfileId, staff, expectedVersion) => {
				const hosted = await stablePrimary.putStaff(requestedProfileId, staff, expectedVersion);
				if (loseResponse) {
					loseResponse = false;
					throw new Error("fetch failed after staff commit");
				}
				return hosted;
			},
		};
		const interrupted = new CloudStaffSynchronizer({
			root: ownerRoot,
			userData,
			profileId,
			primary: unreliablePrimary,
			canWrite: () => true,
		});
		await expect(interrupted.sync()).rejects.toThrow("fetch failed after staff commit");

		const recovered = new CloudStaffSynchronizer({
			root: ownerRoot,
			userData,
			profileId,
			primary: stablePrimary,
			canWrite: () => true,
		});
		await expect(recovered.sync()).resolves.toEqual({ created: 0, updated: 0, downloaded: 0 });
		expect(readStaffAgents(ownerRoot)[0]?.displayName).toBe("Committed remotely");
	});

	it("permanently deletes hosted staff and removes it from other machines", async () => {
		const created = createStaffAgent(ownerRoot, {
			displayName: "Temporary analyst",
			role: "Analyst",
			charter: "Complete a bounded analysis.",
			appearance: { color: "blue", shape: "round" },
		});
		const owner = new CloudStaffSynchronizer({ root: ownerRoot, userData, profileId, primary, canWrite: () => true });
		const friend = new CloudStaffSynchronizer({
			root: friendRoot,
			userData,
			profileId,
			primary,
			canWrite: () => true,
		});
		await owner.sync();
		await friend.sync();

		archiveStaffAgent(ownerRoot, created.id);
		await owner.sync();
		await owner.deleteStaff(created.id);
		deleteStaffAgent(ownerRoot, created.id);
		await owner.sync();
		await friend.sync();

		expect(records.has(created.id)).toBe(false);
		expect(readStaffAgents(ownerRoot)).toEqual([]);
		expect(readStaffAgents(friendRoot)).toEqual([]);
	});
});
