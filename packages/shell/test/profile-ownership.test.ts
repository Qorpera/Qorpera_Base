import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cancelProfileInvitation,
	claimProfile,
	claimUnownedProfiles,
	forgetProfile,
	inviteProfileMember,
	profileAccessFor,
	profileHasCapability,
	profileOwnedBy,
	profileOwnersPath,
	profileTeamInfo,
	removeProfileMember,
	updateProfileMemberRole,
} from "../src/profile-ownership.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-profile-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

const founder = {
	id: "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f",
	email: "founder@example.com",
	displayName: "Founder",
};
const friend = {
	id: "73dc6943-b71c-4ba4-a38d-78da0861e0dc",
	email: "friend@example.com",
	displayName: "Friend",
};
const teammate = {
	id: "a17381c2-3508-4573-b351-a5394adbd1f4",
	email: "teammate@example.com",
	displayName: "Teammate",
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("profile access", () => {
	it("claims profiles once and gives the founder owner capabilities", () => {
		const userData = temporaryRoot();
		const first = join(userData, "company-a");
		const second = join(userData, "company-b");
		claimUnownedProfiles(userData, founder, [first, second]);
		expect(profileOwnedBy(userData, founder.id, first)).toBe(true);
		expect(profileAccessFor(userData, founder.id, first)).toMatchObject({
			role: "owner",
			capabilities: { read: true, write: true, authorize: true, manageMembers: true },
		});
		claimUnownedProfiles(userData, friend, [first]);
		expect(profileAccessFor(userData, friend.id, first)).toBeUndefined();
	});

	it("migrates the existing owner file without transferring profiles", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		mkdirSync(userData, { recursive: true });
		writeFileSync(
			profileOwnersPath(userData),
			`${JSON.stringify({
				schema: "qorpera.profile-owners/v1",
				profiles: { [process.platform === "win32" ? root.toLowerCase() : root]: founder.id },
			})}\n`,
			"utf-8",
		);
		claimUnownedProfiles(userData, founder, [root]);
		const team = profileTeamInfo(userData, founder.id, root);
		expect(team?.members[0]).toMatchObject({
			userId: founder.id,
			email: founder.email,
			displayName: founder.displayName,
			role: "owner",
		});
	});

	it("accepts an email invitation on sign-in and enforces contributor access", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		claimProfile(userData, founder, root);
		inviteProfileMember(userData, founder.id, root, " Friend@Example.com ", "contributor");

		claimUnownedProfiles(userData, friend, [root]);
		expect(profileHasCapability(userData, friend.id, root, "read")).toBe(true);
		expect(profileHasCapability(userData, friend.id, root, "write")).toBe(true);
		expect(profileHasCapability(userData, friend.id, root, "authorize")).toBe(false);
		expect(profileHasCapability(userData, friend.id, root, "manage-members")).toBe(false);
		expect(profileTeamInfo(userData, founder.id, root)?.invitations).toEqual([]);
	});

	it("keeps viewer access read-only", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		claimProfile(userData, founder, root);
		inviteProfileMember(userData, founder.id, root, friend.email, "viewer");
		claimUnownedProfiles(userData, friend, [root]);
		expect(profileAccessFor(userData, friend.id, root)).toMatchObject({
			role: "viewer",
			capabilities: { read: true, write: false, authorize: false, manageMembers: false },
		});
	});

	it("lets admins manage collaborators but protects full access", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		claimProfile(userData, founder, root);
		inviteProfileMember(userData, founder.id, root, friend.email, "admin");
		claimUnownedProfiles(userData, friend, [root]);

		expect(() => inviteProfileMember(userData, friend.id, root, teammate.email, "admin")).toThrow("only the owner");
		inviteProfileMember(userData, friend.id, root, teammate.email, "contributor");
		claimUnownedProfiles(userData, teammate, [root]);
		expect(() => updateProfileMemberRole(userData, friend.id, root, teammate.id, "admin")).toThrow("only the owner");
		updateProfileMemberRole(userData, founder.id, root, teammate.id, "viewer");
		expect(profileAccessFor(userData, teammate.id, root)?.role).toBe("viewer");
		expect(() => removeProfileMember(userData, friend.id, root, founder.id)).toThrow("owner cannot be removed");
		removeProfileMember(userData, founder.id, root, friend.id);
		expect(profileAccessFor(userData, friend.id, root)).toBeUndefined();
	});

	it("cancels pending invitations and removes only owner-owned profiles", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		claimProfile(userData, founder, root);
		const invitation = inviteProfileMember(userData, founder.id, root, friend.email, "viewer");
		expect(() => inviteProfileMember(userData, founder.id, root, friend.email, "viewer")).toThrow("already pending");
		cancelProfileInvitation(userData, founder.id, root, invitation.id);
		expect(profileTeamInfo(userData, founder.id, root)?.invitations).toEqual([]);
		forgetProfile(userData, friend.id, root);
		expect(profileOwnedBy(userData, founder.id, root)).toBe(true);
		forgetProfile(userData, founder.id, root);
		expect(profileAccessFor(userData, founder.id, root)).toBeUndefined();
	});
});
