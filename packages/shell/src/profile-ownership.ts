/** Profile roles, capabilities, and team shapes. Membership itself lives in
 * the hosted profile team; this machine keeps no ownership registry. */
export const PROFILE_MEMBER_ROLES = ["admin", "contributor", "viewer"] as const;
export type ProfileMemberRole = (typeof PROFILE_MEMBER_ROLES)[number];
export type ProfileRole = "owner" | ProfileMemberRole;
export type ProfileCapability = "read" | "write" | "authorize" | "manage-members";

export interface ProfileAccountIdentity {
	id: string;
	email: string;
	displayName: string;
	avatarUrl?: string;
}

export interface ProfileMember {
	userId: string;
	email: string;
	displayName: string;
	avatarUrl?: string;
	role: ProfileRole;
	joinedAt: string;
}

export interface ProfileInvitation {
	id: string;
	email: string;
	role: ProfileMemberRole;
	invitedByUserId: string;
	createdAt: string;
	expiresAt: string;
}

export interface ProfileAccess {
	role: ProfileRole;
	ownerUserId: string;
	capabilities: {
		read: boolean;
		write: boolean;
		authorize: boolean;
		manageMembers: boolean;
	};
}

export interface ProfileTeamInfo extends ProfileAccess {
	members: ProfileMember[];
	invitations: ProfileInvitation[];
}
