import type { HostedSession } from "../cloud/types.ts";

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
