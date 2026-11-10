import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, record, timestamp, uuid } from "./parse.ts";

/* Members of a company message each other (supabase/CLIENT-CONTRACT.md "Member chats", migration
 * 20260930715000_member_messages): one chat per pair of members per company. The list says, per other member, what
 * is unread and how far each side has read; a chat is read a page at a time, newest first. Nothing here wakes an
 * agent or takes a login. */

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
}

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
	const input = record(value, "member message");
	const base = {
		id: uuid(input.id, "member message id"),
		seq: boundedInteger(input.seq, "member message order", 1, SEQ_MAX),
		authorUserId: uuid(input.authorUserId, "member message author"),
		createdAt: timestamp(input.createdAt, "member message time"),
	};
	if (input.deleted === true) return { ...base, deleted: true };
	if (typeof input.text !== "string" || !input.text.trim()) throw new CloudShapeError("member message words");
	return { ...base, text: input.text };
}

export function parseMemberChats(value: unknown): MemberChatSummary[] {
	const input = record(value, "member chats");
	if (input.schema !== "qorpera.member-chats/v1") throw new CloudShapeError("member chats");
	const chats = array(input.chats, "member chats").map((entry) => {
		const item = record(entry, "member chat");
		return {
			userId: uuid(item.userId, "member chat member"),
			lastSeenAt:
				item.lastSeenAt === null || item.lastSeenAt === undefined
					? null
					: timestamp(item.lastSeenAt, "member last online"),
			unread: boundedInteger(item.unread, "member chat unread", 0, 100),
			readSeq: boundedInteger(item.readSeq, "member chat read mark", 0, SEQ_MAX),
			theirReadSeq: boundedInteger(item.theirReadSeq, "member chat read mark", 0, SEQ_MAX),
			last: item.last === null || item.last === undefined ? null : parseMessage(item.last),
		};
	});
	if (new Set(chats.map((chat) => chat.userId)).size !== chats.length) throw new CloudShapeError("member chats");
	return chats;
}

export function parseMemberChatPage(value: unknown, userId: string): MemberChatPage {
	const input = record(value, "member chat");
	if (input.schema !== "qorpera.member-chat/v1" || uuid(input.userId, "member chat member") !== userId.toLowerCase())
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
	const input = record(value, "member message");
	if (input.schema !== "qorpera.member-message/v1") throw new CloudShapeError("member message");
	if (userId && uuid(input.userId, "member chat member") !== userId.toLowerCase())
		throw new CloudShapeError("member message");
	return parseMessage(input.message);
}

export interface MemberChatCalls {
	list(): Promise<MemberChatSummary[]>;
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
		list: async () => parseMemberChats(await cloud.rpc("qorpera_list_member_chats", { p_profile_id: profileId })),
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
			const input = record(
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
