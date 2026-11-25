import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, cloudRecord, cloudUuid, timestamp } from "./parse.ts";

/* What each agent's work waits on the signed-in member for (migration 20260930723000): the cards an agent raised for
 * them in its own thread (a question, a secret, a takeover or an email draft) and the approval cards that wait for their
 * answer there. The rail says "Stopped: {what}" on such an agent, and the tab's title counts them. A cloud before the
 * migration answers the read as missing (CloudRpcError.missing): the web then reads the approval cards alone, as
 * before. */

export const WAITING_WORK_SCHEMA = "qorpera.member-waiting-work/v1";

/** The newest item's kind: a card's surface, or an approval card. */
export type WaitingKind = "question" | "secret" | "takeover" | "draft" | "approval";
const KINDS: readonly WaitingKind[] = ["question", "secret", "takeover", "draft", "approval"];

export interface WaitingWork {
	staffAgentId: string;
	/** The conversation the newest item is in: the agent's own thread. */
	sessionId: string;
	/** How many items wait: the cards and the approval cards. */
	count: number;
	questions: number;
	approvals: number;
	latestAt: string;
	/** The newest item's kind; undefined for a kind this version doesn't know. */
	kind?: WaitingKind;
	/** The newest item in a few words (a card's title, an approval's action), one line, at most 120 characters. */
	what?: string;
}

export function parseWaitingWork(value: unknown): WaitingWork[] {
	const input = cloudRecord(value, "waiting work");
	if (input.schema !== WAITING_WORK_SCHEMA) throw new CloudShapeError("waiting work");
	return array(input.agents, "waiting work").map((value): WaitingWork => {
		const item = cloudRecord(value, "waiting agent");
		const kind = KINDS.find((candidate) => candidate === item.kind);
		const what = typeof item.what === "string" ? item.what.replace(/\s+/gu, " ").trim() : "";
		return {
			staffAgentId: cloudUuid(item.staffAgentId, "waiting agent"),
			sessionId: cloudUuid(item.sessionId, "waiting conversation"),
			count: boundedInteger(item.count, "waiting count", 1, 1_000_000),
			questions: boundedInteger(item.questions, "waiting questions", 0, 1_000_000),
			approvals: boundedInteger(item.approvals, "waiting approvals", 0, 1_000_000),
			latestAt: timestamp(item.latestAt, "waiting time"),
			...(kind ? { kind } : {}),
			...(what ? { what } : {}),
		};
	});
}

export async function listWaitingWork(cloud: Cloud, profileId: string): Promise<WaitingWork[]> {
	return parseWaitingWork(await cloud.rpc("qorpera_list_member_waiting_work", { p_profile_id: profileId }));
}
