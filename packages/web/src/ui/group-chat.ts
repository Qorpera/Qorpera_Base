import type { HostedSession } from "../cloud/types.ts";
import { h, icon } from "./dom.ts";

/** Agent threads also use rooms internally, but retain their agent identity. */
export function isGroupChat(session: HostedSession | undefined): boolean {
	return typeof session?.executionScope?.roomId === "string" && !session.staffAgentId;
}

/** Match the group symbol used by the new-conversation picker. */
export function groupChatAvatar(): HTMLElement {
	return h("span", { class: "avatar group-chat-avatar", "aria-hidden": "true" }, icon("friends"));
}
