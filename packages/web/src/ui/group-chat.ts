import type { HostedSession } from "../cloud/types.ts";

export { groupAvatar as groupChatAvatar } from "./group-avatar.ts";

/** Agent threads also use rooms internally, but retain their agent identity. */
export function isGroupChat(session: HostedSession | undefined): boolean {
	return typeof session?.executionScope?.roomId === "string" && !session.staffAgentId;
}
