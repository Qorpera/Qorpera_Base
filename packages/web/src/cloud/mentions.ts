import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, record, timestamp, uuid } from "./parse.ts";

/* Mentions of the signed-in member that they have not seen yet, by conversation
 * (migration 20260928010000_runtime_room_mentions). The cloud finds mentions in a
 * posted message's text; opening the conversation marks them seen. */

export interface MemberMentions {
	sessionId: string;
	count: number;
	latestAt: string;
}

export async function listMemberMentions(cloud: Cloud, profileId: string): Promise<MemberMentions[]> {
	const input = record(await cloud.rpc("qorpera_list_member_mentions", { p_profile_id: profileId }), "mentions");
	if (input.schema !== "qorpera.member-mentions/v1") throw new CloudShapeError("mentions");
	return array(input.sessions, "mentions").map((value) => {
		const item = record(value, "mention");
		return {
			sessionId: uuid(item.sessionId, "mention conversation"),
			count: boundedInteger(item.count, "mention count", 1, 1_000_000),
			latestAt: timestamp(item.latestAt, "mention time"),
		};
	});
}

export async function markMentionsSeen(cloud: Cloud, sessionId: string): Promise<void> {
	await cloud.rpc("qorpera_mark_member_mentions_seen", { p_session_id: sessionId });
}
