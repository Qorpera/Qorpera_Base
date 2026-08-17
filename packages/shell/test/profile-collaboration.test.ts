import { describe, expect, it } from "vitest";
import type { HostedProfileTeam } from "../src/hosted-primary.ts";
import { hostedProfileAccess } from "../src/profile-collaboration.ts";

const ownerId = "10000000-0000-4000-8000-000000000001";
const contributorId = "10000000-0000-4000-8000-000000000002";

function team(role: HostedProfileTeam["role"]): HostedProfileTeam {
	return {
		profileType: "cloud",
		profileId: "20000000-0000-4000-8000-000000000001",
		role,
		capabilities: {
			read: true,
			write: role !== "viewer",
			authorize: role === "owner" || role === "admin",
			manageMembers: role === "owner" || role === "admin",
		},
		members: [
			{
				userId: ownerId,
				email: "owner@example.com",
				displayName: "Owner",
				role: "owner",
				joinedAt: "2026-08-16T00:00:00.000Z",
			},
			{
				userId: contributorId,
				email: "friend@example.com",
				displayName: "Friend",
				role,
				joinedAt: "2026-08-16T00:00:00.000Z",
			},
		],
		invitations: [],
	};
}

describe("hostedProfileAccess", () => {
	it("uses the cloud profile owner while preserving the actor role and capabilities", () => {
		expect(hostedProfileAccess(team("contributor"))).toEqual({
			role: "contributor",
			ownerUserId: ownerId,
			capabilities: { read: true, write: true, authorize: false, manageMembers: false },
		});
	});

	it("rejects malformed team projections without an owner", () => {
		const value = team("viewer");
		value.members = value.members.filter((member) => member.role !== "owner");
		expect(() => hostedProfileAccess(value)).toThrow("Cloud profile does not identify an owner");
	});
});
