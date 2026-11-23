import type { HostedSession } from "../cloud/types.ts";

/* Where a member is in the company, as their tab says on the company's presence channel (Jonas, 9 Nov 2026: "when a
 * friend IS online, I would like a visual to show what they are doing more inside of a multiplayer company").
 *
 * A tab tracks one string. It used to be the conversation it shows; it is now that conversation's id, then "@" and the
 * place in the rail: "agent:<staff agent id>", "room:<room id>", "page:<interface name>", "app:<app name>", "concepts",
 * "sites" or "site:<website name>" (a website's own view, company views step 4). The conversation id stays first, so
 * "who has this conversation open" works as before (and an older tab's bare conversation id still reads); the place is
 * what another member's rail can find, since each member has a conversation of their own with an agent. The presence
 * channel takes any string up to 256 characters. */

export interface PresencePlace {
	/** The conversation the tab shows, if any. */
	sessionId?: string;
	/** Where that is in the rail, if anywhere. */
	place?: string;
}

const MAX = 256;
export const COMPANY_PRESENCE_PLACE = "company";

export function presenceValue(sessionId: string | undefined, place: string | undefined): string | null {
	if (!sessionId && !place) return null;
	const value = place ? `${sessionId ?? ""}@${place}` : (sessionId ?? "");
	return value.length <= MAX ? value : (sessionId ?? null);
}

export function parsePresenceValue(value: string | null | undefined): PresencePlace {
	if (!value) return {};
	const at = value.indexOf("@");
	const sessionId = at < 0 ? value : value.slice(0, at);
	const rawPlace = at < 0 ? "" : value.slice(at + 1);
	const place = rawPlace === COMPANY_PRESENCE_PLACE ? "" : rawPlace;
	return { ...(sessionId ? { sessionId } : {}), ...(place ? { place } : {}) };
}

/** A conversation's place in the rail: the agent it is with, or its group chat's room. An agent's thread is bound to a
 * room of its own too (`agentThread`), and stands for the agent, as its row does. */
export function sessionPlace(session: HostedSession | undefined): string | undefined {
	if (!session) return undefined;
	const scope = session.executionScope ?? {};
	const agent = session.staffAgentId ? `agent:${session.staffAgentId.toLowerCase()}` : undefined;
	if (scope.agentThread === true && agent) return agent;
	const roomId = scope.roomId;
	if (typeof roomId === "string" && roomId) return `room:${roomId.toLowerCase()}`;
	return agent;
}
