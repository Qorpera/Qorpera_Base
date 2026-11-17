import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import type { HostedProfileTeam } from "../cloud/types.ts";

const key = (profileId: string, userId: string) => `qorpera:pending-spectators:${profileId}:${userId}`;

export function pendingSpectators(profileId: string, userId: string): string[] {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(key(profileId, userId)) ?? "[]");
		return Array.isArray(saved)
			? saved.filter((item): item is string => typeof item === "string" && item.includes("@"))
			: [];
	} catch {
		return [];
	}
}

export function keepPendingSpectators(profileId: string, userId: string, emails: readonly string[]): void {
	try {
		if (emails.length) localStorage.setItem(key(profileId, userId), JSON.stringify([...new Set(emails)]));
		else localStorage.removeItem(key(profileId, userId));
	} catch {
		return;
	}
}

export async function invitePendingSpectators(
	api: CloudApi,
	team: HostedProfileTeam,
	userId: string,
): Promise<string[]> {
	const known = new Set([...team.members, ...team.invitations].map((person) => person.email.trim().toLowerCase()));
	const missed: string[] = [];
	for (const email of pendingSpectators(team.profileId, userId)) {
		if (known.has(email)) continue;
		await api.inviteMember(team.profileId, email, "viewer").catch((error: unknown) => {
			if (!(error instanceof CloudRpcError && error.code === "23505")) missed.push(email);
		});
	}
	keepPendingSpectators(team.profileId, userId, missed);
	return missed;
}
