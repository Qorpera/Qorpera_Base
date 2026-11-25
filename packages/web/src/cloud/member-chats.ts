import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, cloudRecord, cloudUuid, timestamp } from "./parse.ts";

/* Members of a company message each other (supabase/CLIENT-CONTRACT.md "Member chats", migration
 * 20260930715000_member_messages): one chat per pair of members per company. The list says, per other member, what
 * is unread and how far each side has read; a chat is read a page at a time, newest first. Nothing here wakes an
 * agent or takes a login.
 *
 * Each member also keeps where the other members stand in their own rail ("Member contacts' places", migration
 * 20260930717000_member_contact_places): the list says it per chat, and `place` sets it. */

/** The longest message, in UTF-8 bytes, as the cloud checks it. */
export const MEMBER_MESSAGE_MAX_BYTES = 16 * 1024;
/** How many messages a chat opens with, and how many "Show earlier messages" adds. */
export const MEMBER_CHAT_PAGE = 50;
/** The most messages one read gives, as the cloud bounds it. */
export const MEMBER_CHAT_READ_MAX = 200;

export interface MemberMessage {
	readonly id: string;
	/** Its place in the chat: later messages have higher ones. */
	readonly seq: number;
	readonly authorUserId: string;
	readonly createdAt: string;
	/** Its words; none once its author took it back. */
	readonly text?: string;
	readonly deleted?: true;
	/** On a message the reading member wrote: the id they sent it with. Never on the other member's. */
	readonly clientMessageId?: string;
}

/** Where a member keeps a contact in their own rail: the Members group, the pinned row, what is in no section, or a
 * section. */
export type MemberContactZone = "members" | "pinned" | "unassigned" | "section";

export interface MemberContactPlace {
	readonly zone: MemberContactZone;
	/** The section, with zone "section" only. */
	readonly sectionId?: string;
	/** The agent or group chat the contact stands after in its zone; none: first. Never in "members". */
	readonly after?: string;
	/** Its order among the contacts after the same item (in "members": among all of them), 0 to 9999. */
	readonly rank: number;
}

/** One contact's whole place, as `place` sends it. */
export interface MemberContactPlacing {
	readonly userId: string;
	readonly place: MemberContactPlace;
	readonly hidden: boolean;
}

/** The highest rank a place takes, and how many places one call takes, as the cloud bounds them. */
export const MEMBER_CONTACT_RANK_MAX = 9999;
export const MEMBER_CONTACT_PLACES_MAX = 100;

export interface MemberChatSummary {
	/** The other member. */
	readonly userId: string;
	/** When they were last online, when the cloud knows. */
	readonly lastSeenAt: string | null;
	/** Their messages this member has not seen (the cloud counts to 100). */
	readonly unread: number;
	/** The newest message this member has seen, 0 for none. */
	readonly readSeq: number;
	/** The newest message the other member has seen, 0 for none. */
	readonly theirReadSeq: number;
	/** The chat's newest message, its words cut short. */
	readonly last: MemberMessage | null;
	/** Where this member put the contact in their rail; none until they place it. */
	readonly place?: MemberContactPlace;
	/** This member hid the contact from their rail. */
	readonly hidden?: true;
}

/** The list, and whether the cloud keeps contacts' places (20260930717000): where it does not, none can be moved. */
export interface MemberChatList {
	readonly chats: readonly MemberChatSummary[];
	readonly placing: boolean;
}

export interface MemberChatPage {
	readonly userId: string;
	/** Oldest first. */
	readonly messages: readonly MemberMessage[];
	/** There are messages before the page's first. */
	readonly hasMore: boolean;
	readonly readSeq: number;
	readonly theirReadSeq: number;
}

const SEQ_MAX = Number.MAX_SAFE_INTEGER;

function parseMessage(value: unknown): MemberMessage {
	const input = cloudRecord(value, "member message");
	const base = {
		id: cloudUuid(input.id, "member message id"),
		seq: boundedInteger(input.seq, "member message order", 1, SEQ_MAX),
		authorUserId: cloudUuid(input.authorUserId, "member message author"),
		createdAt: timestamp(input.createdAt, "member message time"),
		...(input.clientMessageId === undefined || input.clientMessageId === null
			? {}
			: { clientMessageId: cloudUuid(input.clientMessageId, "member message client id") }),
	};
	if (input.deleted === true) return { ...base, deleted: true };
	if (typeof input.text !== "string" || !input.text.trim()) throw new CloudShapeError("member message words");
	return { ...base, text: input.text };
}

function parsePlace(value: unknown): MemberContactPlace {
	const input = cloudRecord(value, "member contact place");
	const zone = input.zone;
	if (zone !== "members" && zone !== "pinned" && zone !== "unassigned" && zone !== "section")
		throw new CloudShapeError("member contact place");
	const given = (field: unknown) => field !== undefined && field !== null;
	// A section goes with zone "section" alone, and the Members group has no anchor: as the cloud keeps them.
	if (given(input.sectionId) !== (zone === "section") || (zone === "members" && given(input.after)))
		throw new CloudShapeError("member contact place");
	return {
		zone,
		...(given(input.sectionId) ? { sectionId: cloudUuid(input.sectionId, "member contact section") } : {}),
		...(given(input.after) ? { after: cloudUuid(input.after, "member contact anchor") } : {}),
		rank: boundedInteger(input.rank, "member contact rank", 0, MEMBER_CONTACT_RANK_MAX),
	};
}

export function parseMemberChats(value: unknown): MemberChatSummary[] {
	const input = cloudRecord(value, "member chats");
	if (input.schema !== "qorpera.member-chats/v1") throw new CloudShapeError("member chats");
	const chats = array(input.chats, "member chats").map((entry): MemberChatSummary => {
		const item = cloudRecord(entry, "member chat");
		if (item.hidden !== undefined && typeof item.hidden !== "boolean") throw new CloudShapeError("member chat");
		return {
			userId: cloudUuid(item.userId, "member chat member"),
			lastSeenAt:
				item.lastSeenAt === null || item.lastSeenAt === undefined
					? null
					: timestamp(item.lastSeenAt, "member last online"),
			unread: boundedInteger(item.unread, "member chat unread", 0, 100),
			readSeq: boundedInteger(item.readSeq, "member chat read mark", 0, SEQ_MAX),
			theirReadSeq: boundedInteger(item.theirReadSeq, "member chat read mark", 0, SEQ_MAX),
			last: item.last === null || item.last === undefined ? null : parseMessage(item.last),
			...(item.place === undefined || item.place === null ? {} : { place: parsePlace(item.place) }),
			...(item.hidden === true ? { hidden: true as const } : {}),
		};
	});
	if (new Set(chats.map((chat) => chat.userId)).size !== chats.length) throw new CloudShapeError("member chats");
	return chats;
}

/** The list as the cloud answers it, from the read and from a place alike. */
export function parseMemberChatList(value: unknown): MemberChatList {
	const chats = parseMemberChats(value);
	return { chats, placing: cloudRecord(value, "member chats").placing === true };
}

export function parseMemberChatPage(value: unknown, userId: string): MemberChatPage {
	const input = cloudRecord(value, "member chat");
	if (
		input.schema !== "qorpera.member-chat/v1" ||
		cloudUuid(input.userId, "member chat member") !== userId.toLowerCase()
	)
		throw new CloudShapeError("member chat");
	if (typeof input.hasMore !== "boolean") throw new CloudShapeError("member chat");
	const messages = array(input.messages, "member chat messages").map(parseMessage);
	if (messages.some((message, index) => index > 0 && message.seq <= messages[index - 1]!.seq))
		throw new CloudShapeError("member chat order");
	return {
		userId: userId.toLowerCase(),
		messages,
		hasMore: input.hasMore,
		readSeq: boundedInteger(input.readSeq, "member chat read mark", 0, SEQ_MAX),
		theirReadSeq: boundedInteger(input.theirReadSeq, "member chat read mark", 0, SEQ_MAX),
	};
}

function parseSent(value: unknown, userId?: string): MemberMessage {
	const input = cloudRecord(value, "member message");
	if (input.schema !== "qorpera.member-message/v1") throw new CloudShapeError("member message");
	if (userId && cloudUuid(input.userId, "member chat member") !== userId.toLowerCase())
		throw new CloudShapeError("member message");
	return parseMessage(input.message);
}

export interface MemberChatCalls {
	list(): Promise<MemberChatList>;
	/** Sets where this member keeps the named contacts in their own rail, each one's whole place; answers the list. */
	place(contacts: readonly MemberContactPlacing[]): Promise<MemberChatList>;
	/** The chat's newest messages, or those before `beforeSeq`. */
	read(userId: string, beforeSeq?: number, limit?: number): Promise<MemberChatPage>;
	/** `clientMessageId` is this browser's id for the message: the same call again is the same message. */
	send(userId: string, clientMessageId: string, text: string): Promise<MemberMessage>;
	/** This member has seen the chat up to `seq`; answers their mark as it stands. */
	markRead(userId: string, seq: number): Promise<number>;
	/** Takes back a message of this member's own. */
	remove(messageId: string): Promise<MemberMessage>;
}

export function memberChatCalls(cloud: Pick<Cloud, "rpc">, profileId: string): MemberChatCalls {
	return {
		list: async () => parseMemberChatList(await cloud.rpc("qorpera_list_member_chats", { p_profile_id: profileId })),
		place: async (contacts) =>
			parseMemberChatList(
				await cloud.rpc("qorpera_place_member_contacts", {
					p_profile_id: profileId,
					p_contacts: contacts.map(({ userId, place, hidden }) => ({
						userId,
						zone: place.zone,
						...(place.sectionId ? { sectionId: place.sectionId } : {}),
						...(place.after ? { after: place.after } : {}),
						rank: place.rank,
						hidden,
					})),
				}),
			),
		read: async (userId, beforeSeq, limit = MEMBER_CHAT_PAGE) =>
			parseMemberChatPage(
				await cloud.rpc("qorpera_read_member_chat", {
					p_profile_id: profileId,
					p_user_id: userId,
					p_before_seq: beforeSeq ?? null,
					p_limit: Math.min(MEMBER_CHAT_READ_MAX, Math.max(1, limit)),
				}),
				userId,
			),
		send: async (userId, clientMessageId, text) =>
			parseSent(
				await cloud.rpc("qorpera_send_member_message", {
					p_profile_id: profileId,
					p_user_id: userId,
					p_client_message_id: clientMessageId,
					p_text: text,
				}),
				userId,
			),
		markRead: async (userId, seq) => {
			const input = cloudRecord(
				await cloud.rpc("qorpera_mark_member_chat_read", {
					p_profile_id: profileId,
					p_user_id: userId,
					p_seq: seq,
				}),
				"member chat read mark",
			);
			if (input.schema !== "qorpera.member-chat-read/v1") throw new CloudShapeError("member chat read mark");
			return boundedInteger(input.readSeq, "member chat read mark", 0, SEQ_MAX);
		},
		remove: async (messageId) =>
			parseSent(
				await cloud.rpc("qorpera_delete_member_message", { p_profile_id: profileId, p_message_id: messageId }),
			),
	};
}
