import type { CloudApi } from "../cloud/api.ts";

const key = (profileId: string) => `qorpera:pending-spectators:${profileId}`;

export function pendingSpectators(profileId: string): string[] {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(key(profileId)) ?? "[]");
		return Array.isArray(saved)
			? saved.filter((item): item is string => typeof item === "string" && item.includes("@"))
			: [];
	} catch {
		return [];
	}
}

export function keepPendingSpectators(profileId: string, emails: readonly string[]): void {
	try {
		if (emails.length) localStorage.setItem(key(profileId), JSON.stringify([...new Set(emails)]));
		else localStorage.removeItem(key(profileId));
	} catch {
		return;
	}
}

export async function invitePendingSpectators(api: CloudApi, profileId: string): Promise<string[]> {
	const missed: string[] = [];
	for (const email of pendingSpectators(profileId))
		await api.inviteMember(profileId, email, "viewer").catch(() => missed.push(email));
	keepPendingSpectators(profileId, missed);
	return missed;
}
