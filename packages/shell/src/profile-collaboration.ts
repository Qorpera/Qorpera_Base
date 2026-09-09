import type { HostedProfileTeam } from "@qorpera/cloud-client/hosted-primary";
import type { ProfileAccess } from "./profile-ownership.ts";

export function hostedProfileAccess(team: HostedProfileTeam): ProfileAccess {
	const owner = team.members.find((member) => member.role === "owner");
	if (!owner) throw new Error("Cloud profile does not identify an owner");
	return {
		role: team.role,
		ownerUserId: owner.userId,
		capabilities: { ...team.capabilities },
	};
}
