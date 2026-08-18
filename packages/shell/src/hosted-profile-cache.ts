import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	HostedInvitationDeliveryStatus,
	HostedProfile,
	HostedProfileInvitation,
	HostedProfileMember,
	HostedProfileRole,
	HostedProfileTeam,
} from "./hosted-primary.ts";

const HOSTED_PROFILE_CACHE_SCHEMA = "qorpera.hosted-profile-cache/v1";
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = ["owner", "admin", "contributor", "viewer"] as const;
const DELIVERY_STATUSES = ["pending", "delivering", "retrying", "delivered", "failed"] as const;

interface CachedValue<T> {
	cachedAt: string;
	value: T;
}

interface HostedProfileCacheFile {
	schema: typeof HOSTED_PROFILE_CACHE_SCHEMA;
	accountId: string;
	profiles?: CachedValue<HostedProfile[]>;
	teams: Record<string, CachedValue<HostedProfileTeam>>;
}

export interface HostedProfileCacheSnapshot {
	profiles: HostedProfile[];
	teams: Record<string, HostedProfileTeam>;
}

export function offlineHostedProfileTeam(team: HostedProfileTeam): HostedProfileTeam {
	return {
		...team,
		capabilities: {
			read: true,
			write: team.role !== "viewer",
			authorize: false,
			manageMembers: false,
		},
		members: team.members.map((member) => ({ ...member })),
		invitations: team.invitations.map((invitation) => ({
			...invitation,
			delivery: { ...invitation.delivery },
		})),
	};
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function role(value: unknown): HostedProfileRole | undefined {
	return ROLES.find((candidate) => candidate === value);
}

function deliveryStatus(value: unknown): HostedInvitationDeliveryStatus | undefined {
	return DELIVERY_STATUSES.find((candidate) => candidate === value);
}

function text(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function profile(value: unknown): HostedProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HostedProfile>;
	const profileRole = role(input.role);
	if (
		input.profileType !== "cloud" ||
		!UUID_PATTERN.test(input.profileId ?? "") ||
		!UUID_PATTERN.test(input.environmentId ?? "") ||
		!text(input.profileName, 120) ||
		!text(input.environmentName, 120) ||
		!profileRole ||
		!Number.isSafeInteger(input.contractVersion) ||
		(input.contractVersion ?? 0) < 1 ||
		!timestamp(input.createdAt)
	) {
		return undefined;
	}
	return {
		profileType: "cloud",
		profileId: input.profileId!,
		environmentId: input.environmentId!,
		profileName: input.profileName!,
		environmentName: input.environmentName!,
		role: profileRole,
		contractVersion: input.contractVersion as number,
		createdAt: input.createdAt,
	};
}

function invitation(value: unknown, profileId: string): HostedProfileInvitation | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HostedProfileInvitation>;
	const invitationRole = role(input.role);
	const status = deliveryStatus(input.delivery?.status);
	if (
		!UUID_PATTERN.test(input.id ?? "") ||
		input.profileId !== profileId ||
		!text(input.email, 320) ||
		!invitationRole ||
		invitationRole === "owner" ||
		!UUID_PATTERN.test(input.invitedByUserId ?? "") ||
		!timestamp(input.createdAt) ||
		!timestamp(input.expiresAt) ||
		!input.delivery ||
		!status ||
		!Number.isSafeInteger(input.delivery.attemptCount) ||
		input.delivery.attemptCount < 0 ||
		!timestamp(input.delivery.nextAttemptAt) ||
		(input.delivery.providerMessageId !== undefined && !text(input.delivery.providerMessageId, 256)) ||
		(input.delivery.lastError !== undefined && !text(input.delivery.lastError, 1000)) ||
		(status === "delivered" ? !timestamp(input.delivery.sentAt) : input.delivery.sentAt !== undefined)
	) {
		return undefined;
	}
	return {
		id: input.id!,
		profileId,
		email: input.email!,
		role: invitationRole,
		invitedByUserId: input.invitedByUserId!,
		createdAt: input.createdAt,
		expiresAt: input.expiresAt,
		delivery: {
			status,
			attemptCount: input.delivery.attemptCount,
			nextAttemptAt: input.delivery.nextAttemptAt,
			...(input.delivery.providerMessageId ? { providerMessageId: input.delivery.providerMessageId } : {}),
			...(input.delivery.lastError ? { lastError: input.delivery.lastError } : {}),
			...(input.delivery.sentAt ? { sentAt: input.delivery.sentAt } : {}),
		},
	};
}

function member(value: unknown): HostedProfileMember | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HostedProfileMember>;
	const memberRole = role(input.role);
	if (
		!UUID_PATTERN.test(input.userId ?? "") ||
		!text(input.email, 320) ||
		!text(input.displayName, 256) ||
		(input.avatarUrl !== undefined && !text(input.avatarUrl, 2048)) ||
		!memberRole ||
		!timestamp(input.joinedAt)
	) {
		return undefined;
	}
	return {
		userId: input.userId!,
		email: input.email!,
		displayName: input.displayName!,
		...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
		role: memberRole,
		joinedAt: input.joinedAt,
	};
}

function team(value: unknown, profileId: string): HostedProfileTeam | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HostedProfileTeam>;
	const teamRole = role(input.role);
	if (
		input.profileType !== "cloud" ||
		input.profileId !== profileId ||
		!teamRole ||
		!input.capabilities ||
		input.capabilities.read !== true ||
		input.capabilities.write !== (teamRole !== "viewer") ||
		input.capabilities.authorize !== (teamRole === "owner" || teamRole === "admin") ||
		input.capabilities.manageMembers !== input.capabilities.authorize ||
		!Array.isArray(input.members) ||
		!Array.isArray(input.invitations)
	) {
		return undefined;
	}
	const members = input.members.map(member);
	const invitations = input.invitations.map((candidate) => invitation(candidate, profileId));
	if (
		members.some((candidate) => !candidate) ||
		invitations.some((candidate) => !candidate) ||
		new Set(members.map((candidate) => candidate!.userId)).size !== members.length ||
		new Set(invitations.map((candidate) => candidate!.id)).size !== invitations.length ||
		!members.some((candidate) => candidate!.role === "owner")
	) {
		return undefined;
	}
	return {
		profileType: "cloud",
		profileId,
		role: teamRole,
		capabilities: { ...input.capabilities },
		members: members as HostedProfileMember[],
		invitations: invitations as HostedProfileInvitation[],
	};
}

export function hostedProfileCachePath(userData: string, accountId: string): string {
	return join(userData, "hosted-profile-cache", `${accountId}.json`);
}

function emptyFile(accountId: string): HostedProfileCacheFile {
	return { schema: HOSTED_PROFILE_CACHE_SCHEMA, accountId, teams: {} };
}

function readFile(path: string, accountId: string): HostedProfileCacheFile {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyFile(accountId);
		const input = value as Partial<HostedProfileCacheFile>;
		if (
			input.schema !== HOSTED_PROFILE_CACHE_SCHEMA ||
			input.accountId !== accountId ||
			!input.teams ||
			typeof input.teams !== "object" ||
			Array.isArray(input.teams)
		) {
			return emptyFile(accountId);
		}
		return input as HostedProfileCacheFile;
	} catch {
		return emptyFile(accountId);
	}
}

function writeFile(path: string, file: HostedProfileCacheFile): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(file)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function fresh(cachedAt: string, now: number): boolean {
	return timestamp(cachedAt) && now - Date.parse(cachedAt) >= 0 && now - Date.parse(cachedAt) <= CACHE_MAX_AGE_MS;
}

export function loadHostedProfileCache(
	userData: string,
	accountId: string,
	now = Date.now(),
): HostedProfileCacheSnapshot {
	if (!UUID_PATTERN.test(accountId)) return { profiles: [], teams: {} };
	const file = readFile(hostedProfileCachePath(userData, accountId), accountId);
	const profiles =
		file.profiles && fresh(file.profiles.cachedAt, now)
			? file.profiles.value.map(profile).filter((candidate): candidate is HostedProfile => candidate !== undefined)
			: [];
	const teams: Record<string, HostedProfileTeam> = {};
	for (const [profileId, cached] of Object.entries(file.teams)) {
		if (!UUID_PATTERN.test(profileId) || !cached || !fresh(cached.cachedAt, now)) continue;
		const parsed = team(cached.value, profileId);
		if (parsed) teams[profileId] = parsed;
	}
	return { profiles, teams };
}

export function cacheHostedProfiles(
	userData: string,
	accountId: string,
	profiles: readonly HostedProfile[],
	now = Date.now(),
): void {
	if (!UUID_PATTERN.test(accountId)) throw new Error("Hosted profile cache account id is invalid");
	const path = hostedProfileCachePath(userData, accountId);
	const file = readFile(path, accountId);
	file.profiles = { cachedAt: new Date(now).toISOString(), value: profiles.map((entry) => ({ ...entry })) };
	const profileIds = new Set(profiles.map((entry) => entry.profileId));
	file.teams = Object.fromEntries(Object.entries(file.teams).filter(([profileId]) => profileIds.has(profileId)));
	writeFile(path, file);
}

export function cacheHostedTeam(userData: string, accountId: string, team: HostedProfileTeam, now = Date.now()): void {
	if (!UUID_PATTERN.test(accountId)) throw new Error("Hosted profile cache account id is invalid");
	const path = hostedProfileCachePath(userData, accountId);
	const file = readFile(path, accountId);
	file.teams[team.profileId] = {
		cachedAt: new Date(now).toISOString(),
		value: {
			...team,
			capabilities: { ...team.capabilities },
			members: team.members.map((entry) => ({ ...entry })),
			invitations: team.invitations.map((entry) => ({ ...entry, delivery: { ...entry.delivery } })),
		},
	};
	writeFile(path, file);
}
