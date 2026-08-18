import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROFILE_OWNERS_FILE = "profile-owners.json";
const LEGACY_PROFILE_OWNERS_SCHEMA = "qorpera.profile-owners/v1";
const PROFILE_ACCESS_SCHEMA = "qorpera.profile-access/v1";
const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

interface ProfileRecord {
	members: Record<string, ProfileMember>;
	invitations: Record<string, ProfileInvitation>;
}

interface ProfileOwners {
	schema: typeof PROFILE_ACCESS_SCHEMA;
	profiles: Record<string, ProfileRecord>;
}

export function profileOwnersPath(userData: string): string {
	return join(userData, PROFILE_OWNERS_FILE);
}

function profileKey(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyOwners(): ProfileOwners {
	return { schema: PROFILE_ACCESS_SCHEMA, profiles: {} };
}

function normalizedEmail(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function validEmail(value: string): boolean {
	return value.length <= 320 && EMAIL_PATTERN.test(value);
}

function validTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function validRole(value: unknown): value is ProfileRole {
	return value === "owner" || PROFILE_MEMBER_ROLES.some((role) => role === value);
}

function validMemberRole(value: unknown): value is ProfileMemberRole {
	return PROFILE_MEMBER_ROLES.some((role) => role === value);
}

function parseMember(value: unknown): ProfileMember | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const member = value as Partial<ProfileMember>;
	if (
		typeof member.userId !== "string" ||
		!USER_ID_PATTERN.test(member.userId) ||
		typeof member.email !== "string" ||
		typeof member.displayName !== "string" ||
		member.displayName.length > 256 ||
		!validRole(member.role) ||
		typeof member.joinedAt !== "string" ||
		!validTimestamp(member.joinedAt) ||
		(member.avatarUrl !== undefined && (typeof member.avatarUrl !== "string" || member.avatarUrl.length > 2048))
	) {
		return undefined;
	}
	const email = member.email ? normalizedEmail(member.email) : "";
	if (email && !validEmail(email)) return undefined;
	return {
		userId: member.userId,
		email,
		displayName: member.displayName,
		...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
		role: member.role,
		joinedAt: member.joinedAt,
	};
}

function parseInvitation(value: unknown): ProfileInvitation | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const invitation = value as Partial<ProfileInvitation>;
	if (
		typeof invitation.id !== "string" ||
		!USER_ID_PATTERN.test(invitation.id) ||
		typeof invitation.email !== "string" ||
		!validMemberRole(invitation.role) ||
		typeof invitation.invitedByUserId !== "string" ||
		!USER_ID_PATTERN.test(invitation.invitedByUserId) ||
		typeof invitation.createdAt !== "string" ||
		!validTimestamp(invitation.createdAt) ||
		typeof invitation.expiresAt !== "string" ||
		!validTimestamp(invitation.expiresAt)
	) {
		return undefined;
	}
	const email = normalizedEmail(invitation.email);
	if (!validEmail(email) || Date.parse(invitation.expiresAt) <= Date.now()) return undefined;
	return {
		id: invitation.id,
		email,
		role: invitation.role,
		invitedByUserId: invitation.invitedByUserId,
		createdAt: invitation.createdAt,
		expiresAt: invitation.expiresAt,
	};
}

function legacyOwner(userId: string): ProfileRecord {
	return {
		members: {
			[userId]: {
				userId,
				email: "",
				displayName: "Profile owner",
				role: "owner",
				joinedAt: new Date(0).toISOString(),
			},
		},
		invitations: {},
	};
}

function parseRecord(value: unknown): ProfileRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as { members?: unknown; invitations?: unknown };
	if (!record.members || typeof record.members !== "object" || Array.isArray(record.members)) return undefined;
	const members: Record<string, ProfileMember> = {};
	for (const memberValue of Object.values(record.members)) {
		const member = parseMember(memberValue);
		if (member) members[member.userId] = member;
	}
	if (Object.values(members).filter((member) => member.role === "owner").length !== 1) return undefined;
	const invitations: Record<string, ProfileInvitation> = {};
	if (record.invitations && typeof record.invitations === "object" && !Array.isArray(record.invitations)) {
		for (const invitationValue of Object.values(record.invitations)) {
			const invitation = parseInvitation(invitationValue);
			if (invitation) invitations[invitation.id] = invitation;
		}
	}
	return { members, invitations };
}

function readOwners(path: string): ProfileOwners {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyOwners();
		const value = parsed as { schema?: unknown; profiles?: unknown };
		if (!value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles)) return emptyOwners();
		const profiles: Record<string, ProfileRecord> = {};
		if (value.schema === LEGACY_PROFILE_OWNERS_SCHEMA) {
			for (const [root, userId] of Object.entries(value.profiles)) {
				if (typeof userId === "string" && USER_ID_PATTERN.test(userId)) profiles[root] = legacyOwner(userId);
			}
			return { schema: PROFILE_ACCESS_SCHEMA, profiles };
		}
		if (value.schema !== PROFILE_ACCESS_SCHEMA) return emptyOwners();
		for (const [root, recordValue] of Object.entries(value.profiles)) {
			const record = parseRecord(recordValue);
			if (record) profiles[root] = record;
		}
		return { schema: PROFILE_ACCESS_SCHEMA, profiles };
	} catch {
		return emptyOwners();
	}
}

function writeOwners(path: string, owners: ProfileOwners): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(owners, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function requireIdentity(account: ProfileAccountIdentity): void {
	if (!USER_ID_PATTERN.test(account.id)) throw new Error("invalid Qorpera account id");
	const email = normalizedEmail(account.email);
	if (!validEmail(email)) throw new Error("invalid Qorpera account email");
	if (!account.displayName.trim() || account.displayName.length > 256) throw new Error("invalid Qorpera account name");
	if (account.avatarUrl !== undefined && account.avatarUrl.length > 2048)
		throw new Error("invalid Qorpera account avatar");
}

function memberFor(
	account: ProfileAccountIdentity,
	role: ProfileRole,
	joinedAt = new Date().toISOString(),
): ProfileMember {
	return {
		userId: account.id,
		email: normalizedEmail(account.email),
		displayName: account.displayName.trim(),
		...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
		role,
		joinedAt,
	};
}

function refreshIdentity(record: ProfileRecord, account: ProfileAccountIdentity): boolean {
	const current = record.members[account.id];
	if (!current) return false;
	const next = memberFor(account, current.role, current.joinedAt);
	if (JSON.stringify(current) === JSON.stringify(next)) return false;
	record.members[account.id] = next;
	return true;
}

function acceptInvitations(owners: ProfileOwners, account: ProfileAccountIdentity): boolean {
	const email = normalizedEmail(account.email);
	let changed = false;
	for (const record of Object.values(owners.profiles)) {
		const invitations = Object.values(record.invitations).filter((invitation) => invitation.email === email);
		if (!invitations.length) continue;
		const current = record.members[account.id];
		if (!current) {
			const selected = invitations.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
			record.members[account.id] = memberFor(account, selected.role);
		} else {
			changed = refreshIdentity(record, account) || changed;
		}
		for (const invitation of invitations) delete record.invitations[invitation.id];
		changed = true;
	}
	return changed;
}

function ownerOf(record: ProfileRecord): ProfileMember {
	const owner = Object.values(record.members).find((member) => member.role === "owner");
	if (!owner) throw new Error("profile owner is unavailable");
	return owner;
}

function accessFor(record: ProfileRecord, userId: string): ProfileAccess | undefined {
	const member = record.members[userId];
	if (!member) return undefined;
	const authorize = member.role === "owner" || member.role === "admin";
	const write = authorize || member.role === "contributor";
	return {
		role: member.role,
		ownerUserId: ownerOf(record).userId,
		capabilities: {
			read: true,
			write,
			authorize,
			manageMembers: authorize,
		},
	};
}

function requireActor(record: ProfileRecord, actorUserId: string): ProfileAccess {
	const access = accessFor(record, actorUserId);
	if (!access) throw new Error("profile is not available to this account");
	return access;
}

function requireManager(record: ProfileRecord, actorUserId: string): ProfileAccess {
	const access = requireActor(record, actorUserId);
	if (!access.capabilities.manageMembers) throw new Error("member management requires full access");
	return access;
}

export function claimUnownedProfiles(
	userData: string,
	account: ProfileAccountIdentity,
	roots: readonly string[],
): void {
	requireIdentity(account);
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	let changed = false;
	for (const root of roots) {
		const key = profileKey(root);
		const existing = owners.profiles[key];
		if (!existing) {
			owners.profiles[key] = {
				members: { [account.id]: memberFor(account, "owner") },
				invitations: {},
			};
			changed = true;
			continue;
		}
		changed = refreshIdentity(existing, account) || changed;
	}
	changed = acceptInvitations(owners, account) || changed;
	if (changed) writeOwners(path, owners);
}

export function claimProfile(userData: string, account: ProfileAccountIdentity, root: string): void {
	requireIdentity(account);
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const key = profileKey(root);
	const existing = owners.profiles[key];
	if (existing && ownerOf(existing).userId !== account.id) {
		throw new Error("profile belongs to another Qorpera account");
	}
	if (existing) {
		if (refreshIdentity(existing, account)) writeOwners(path, owners);
		return;
	}
	owners.profiles[key] = {
		members: { [account.id]: memberFor(account, "owner") },
		invitations: {},
	};
	writeOwners(path, owners);
}

export function profileAccessFor(userData: string, userId: string, root: string): ProfileAccess | undefined {
	if (!USER_ID_PATTERN.test(userId)) return undefined;
	const record = readOwners(profileOwnersPath(userData)).profiles[profileKey(root)];
	return record ? accessFor(record, userId) : undefined;
}

export function profileHasCapability(
	userData: string,
	userId: string,
	root: string,
	capability: ProfileCapability,
): boolean {
	const access = profileAccessFor(userData, userId, root);
	if (!access) return false;
	if (capability === "manage-members") return access.capabilities.manageMembers;
	return access.capabilities[capability];
}

export function profileOwnedBy(userData: string, userId: string, root: string): boolean {
	return profileAccessFor(userData, userId, root)?.role === "owner";
}

export function profileTeamInfo(userData: string, userId: string, root: string): ProfileTeamInfo | undefined {
	if (!USER_ID_PATTERN.test(userId)) return undefined;
	const record = readOwners(profileOwnersPath(userData)).profiles[profileKey(root)];
	if (!record) return undefined;
	const access = accessFor(record, userId);
	if (!access) return undefined;
	const roleOrder: Record<ProfileRole, number> = { owner: 0, admin: 1, contributor: 2, viewer: 3 };
	return {
		...access,
		members: Object.values(record.members).sort(
			(left, right) =>
				roleOrder[left.role] - roleOrder[right.role] || left.displayName.localeCompare(right.displayName),
		),
		invitations: access.capabilities.manageMembers
			? Object.values(record.invitations).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			: [],
	};
}

export function inviteProfileMember(
	userData: string,
	actorUserId: string,
	root: string,
	emailInput: string,
	role: ProfileMemberRole,
): ProfileInvitation {
	if (!validMemberRole(role)) throw new Error("invalid profile role");
	const email = normalizedEmail(emailInput);
	if (!validEmail(email)) throw new Error("enter a valid email address");
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const record = owners.profiles[profileKey(root)];
	if (!record) throw new Error("profile is unavailable");
	const actor = requireManager(record, actorUserId);
	if (actor.role === "admin" && role === "admin") throw new Error("only the owner can grant full access");
	if (Object.values(record.members).some((member) => member.email === email)) {
		throw new Error("this account already has access");
	}
	if (Object.values(record.invitations).some((invitation) => invitation.email === email)) {
		throw new Error("an invitation is already pending for this email");
	}
	const createdAt = new Date();
	const invitation: ProfileInvitation = {
		id: randomUUID(),
		email,
		role,
		invitedByUserId: actorUserId,
		createdAt: createdAt.toISOString(),
		expiresAt: new Date(createdAt.getTime() + INVITATION_LIFETIME_MS).toISOString(),
	};
	record.invitations[invitation.id] = invitation;
	writeOwners(path, owners);
	return invitation;
}

export function cancelProfileInvitation(
	userData: string,
	actorUserId: string,
	root: string,
	invitationId: string,
): void {
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const record = owners.profiles[profileKey(root)];
	if (!record) throw new Error("profile is unavailable");
	const actor = requireManager(record, actorUserId);
	const invitation = record.invitations[invitationId];
	if (!invitation) throw new Error("invitation is unavailable");
	if (actor.role === "admin" && invitation.role === "admin") {
		throw new Error("only the owner can revoke a full-access invitation");
	}
	delete record.invitations[invitationId];
	writeOwners(path, owners);
}

export function updateProfileMemberRole(
	userData: string,
	actorUserId: string,
	root: string,
	memberUserId: string,
	role: ProfileMemberRole,
): ProfileMember {
	if (!validMemberRole(role)) throw new Error("invalid profile role");
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const record = owners.profiles[profileKey(root)];
	if (!record) throw new Error("profile is unavailable");
	const actor = requireManager(record, actorUserId);
	const member = record.members[memberUserId];
	if (!member || member.role === "owner") throw new Error("the profile owner cannot be changed");
	if (actor.role === "admin" && (member.role === "admin" || role === "admin")) {
		throw new Error("only the owner can change full access");
	}
	member.role = role;
	writeOwners(path, owners);
	return member;
}

export function removeProfileMember(userData: string, actorUserId: string, root: string, memberUserId: string): void {
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const record = owners.profiles[profileKey(root)];
	if (!record) throw new Error("profile is unavailable");
	const actor = requireManager(record, actorUserId);
	const member = record.members[memberUserId];
	if (!member || member.role === "owner") throw new Error("the profile owner cannot be removed");
	if (memberUserId === actorUserId) throw new Error("you cannot remove your own access here");
	if (actor.role === "admin" && member.role === "admin") {
		throw new Error("only the owner can remove a full-access member");
	}
	delete record.members[memberUserId];
	writeOwners(path, owners);
}

export function forgetProfile(userData: string, userId: string, root: string): void {
	if (!USER_ID_PATTERN.test(userId)) return;
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const key = profileKey(root);
	const record = owners.profiles[key];
	if (!record || ownerOf(record).userId !== userId) return;
	delete owners.profiles[key];
	writeOwners(path, owners);
}
