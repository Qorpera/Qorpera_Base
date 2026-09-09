import {
	COMPANY_PATH_PRESENCE_TTL_MS,
	type CompanyPathPresenceView,
	companyPresencePaths,
	presenceUuid,
} from "./company-path-presence.ts";

export interface MemberCompanyPresenceReply {
	companyId: string;
	environmentId: string;
	view: CompanyPathPresenceView;
	/** Verified newest statements, including ones no longer overlapping a path. */
	confirmed: { clientId: string; sequence: number }[];
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_MEMBER_PATH_PRESENCE");
	return value as Record<string, unknown>;
}
export function parseMemberCompanyPresenceReply(
	value: unknown,
	companyId: string,
	environmentId: string,
	paths: readonly string[],
): MemberCompanyPresenceReply {
	companyPresencePaths(paths);
	const root = record(value, "companyId,confirmed,environmentId,view");
	if (
		root.companyId !== companyId ||
		root.environmentId !== environmentId ||
		!Array.isArray(root.confirmed) ||
		root.confirmed.length > 32
	)
		throw new Error("MEMBER_PATH_PRESENCE_SCOPE_CHANGED");
	const view = record(root.view, "observedAt,paths,schema,state"),
		now = Date.now();
	if (
		view.schema !== "qorpera.company-path-presence-view/v1" ||
		!["available", "partial", "unavailable"].includes(view.state as string) ||
		!Number.isSafeInteger(view.observedAt) ||
		(view.observedAt as number) < now - COMPANY_PATH_PRESENCE_TTL_MS ||
		(view.observedAt as number) > now + 2000 ||
		!Array.isArray(view.paths) ||
		view.paths.length !== paths.length
	)
		throw new Error("INVALID_MEMBER_PATH_PRESENCE");
	const parsed = view.paths.map((input, index) => {
		const row = record(input, "participants,path");
		if (
			row.path !== paths[index] ||
			!Array.isArray(row.participants) ||
			row.participants.length > 192 ||
			(view.state === "unavailable" && row.participants.length)
		)
			throw new Error("INVALID_MEMBER_PATH_PRESENCE");
		const seen = new Set<string>();
		const participants = row.participants
			.map((input) => {
				const participant = record(input, "activity,expiresAt,overlap,runId,staffAgentId");
				const runId = presenceUuid(participant.runId),
					staffAgentId = presenceUuid(participant.staffAgentId);
				const key = JSON.stringify([runId, participant.activity, participant.overlap]);
				if (
					!["reading", "writing"].includes(participant.activity as string) ||
					!["same_object", "within_subtree", "ancestor_subtree"].includes(participant.overlap as string) ||
					seen.has(key) ||
					!Number.isSafeInteger(participant.expiresAt) ||
					(participant.expiresAt as number) < 1 ||
					(participant.expiresAt as number) > (view.observedAt as number) + COMPANY_PATH_PRESENCE_TTL_MS + 2000
				)
					throw new Error("INVALID_MEMBER_PATH_PRESENCE");
				seen.add(key);
				return {
					runId,
					staffAgentId,
					activity: participant.activity as "reading" | "writing",
					overlap: participant.overlap as "same_object" | "within_subtree" | "ancestor_subtree",
					expiresAt: participant.expiresAt as number,
				};
			})
			.filter((participant) => participant.expiresAt > now);
		return { path: paths[index], participants };
	});
	const seen = new Set<string>(),
		confirmed = root.confirmed.map((input) => {
			const row = record(input, "clientId,sequence"),
				clientId = presenceUuid(row.clientId);
			if (seen.has(clientId) || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1)
				throw new Error("INVALID_MEMBER_PATH_PRESENCE");
			seen.add(clientId);
			return { clientId, sequence: row.sequence as number };
		});
	return {
		companyId,
		environmentId,
		view: {
			schema: "qorpera.company-path-presence-view/v1",
			state: view.state as CompanyPathPresenceView["state"],
			observedAt: view.observedAt as number,
			paths: parsed,
		},
		confirmed,
	};
}
