// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { MemberChats, type MemberChatsHost } from "../src/app/member-chats.ts";
import { parseRoute, type Route, routeHash } from "../src/app/router.ts";
import { MemberChatView, memberPresence } from "../src/app/views/member-chat.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import {
	MEMBER_MESSAGE_MAX_BYTES,
	type MemberChatCalls,
	type MemberChatPage,
	type MemberChatSummary,
	type MemberMessage,
	memberChatCalls,
	parseMemberChatPage,
	parseMemberChats,
} from "../src/cloud/member-chats.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../src/cloud/types.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { h, linkHref } from "../src/ui/dom.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

/* Members of a company message each other (Jonas, 10 Nov 2026): the cloud's shapes (cloud/member-chats.ts), the chats'
 * state (app/member-chats.ts), the chat on screen (app/views/member-chat.ts) and the members as contacts in the rail. */

const me = userA.id;
const sofie = id(60);
const mads = id(61);
const member = (userId: string, name: string, role: HostedProfileMember["role"] = "admin"): HostedProfileMember => ({
	userId,
	email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.invalid`,
	displayName: name,
	role,
	joinedAt: timestamp,
});
const ann = member(me, "Ann Holm", "owner");
const people = [ann, member(sofie, "Sofie Lund"), member(mads, "Mads Berg")];
const message = (seq: number, author: string, text: string, at = "2026-11-10T09:00:00Z"): MemberMessage => ({
	id: id(7000 + seq),
	seq,
	authorUserId: author,
	createdAt: at,
	text,
});
const summary = (userId: string, extra: Partial<MemberChatSummary> = {}): MemberChatSummary => ({
	userId,
	lastSeenAt: null,
	unread: 0,
	readSeq: 0,
	theirReadSeq: 0,
	last: null,
	...extra,
});
const page = (userId: string, messages: MemberMessage[], extra: Partial<MemberChatPage> = {}): MemberChatPage => ({
	userId,
	messages,
	hasMore: false,
	readSeq: 0,
	theirReadSeq: 0,
	...extra,
});

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	openMenu()?.close();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The chats over calls a test answers, with what the host was told. */
function chats(calls: Partial<MemberChatCalls>, options: { visible?: boolean; available?: boolean } = {}) {
	const state: { summaries?: Readonly<Record<string, MemberChatSummary>>; unavailable: boolean; visible: boolean } = {
		unavailable: false,
		visible: options.visible ?? true,
	};
	const all: MemberChatCalls = {
		list: vi.fn(async () => []),
		read: vi.fn(async (userId: string) => page(userId, [])),
		send: vi.fn(async (_userId: string, _client: string, text: string) => message(99, me, text)),
		markRead: vi.fn(async (_userId: string, seq: number) => seq),
		remove: vi.fn(async () => ({ ...message(1, me, ""), text: undefined, deleted: true as const })),
		...calls,
	};
	const host: MemberChatsHost = {
		userId: me,
		calls: () => all,
		available: () => options.available !== false && !state.unavailable,
		visible: () => state.visible,
		summaries: () => state.summaries,
		setSummaries: (next) => {
			state.summaries = next;
		},
		setUnavailable: () => {
			state.unavailable = true;
			state.summaries = undefined;
		},
	};
	const controller = new MemberChats(host);
	cleanup.push(() => controller.stop());
	return { controller, calls: all, state };
}

describe("the cloud's member chat shapes", () => {
	const wire = (seq: number, extra: Record<string, unknown> = {}) => ({
		id: id(7000 + seq),
		seq,
		authorUserId: sofie,
		createdAt: "2026-11-10T09:00:00.123456+00:00",
		text: `Message ${seq}`,
		...extra,
	});

	it("reads the list, and a message taken back without its words", () => {
		const parsed = parseMemberChats({
			schema: "qorpera.member-chats/v1",
			chats: [
				{
					userId: sofie.toUpperCase(),
					lastSeenAt: "2026-11-10T08:00:00Z",
					unread: 2,
					readSeq: 3,
					theirReadSeq: 5,
					last: wire(5),
				},
				{
					userId: mads,
					lastSeenAt: null,
					unread: 0,
					readSeq: 0,
					theirReadSeq: 0,
					last: { ...wire(4, { deleted: true }), text: undefined },
				},
			],
		});
		expect(parsed).toEqual([
			{ userId: sofie, lastSeenAt: "2026-11-10T08:00:00Z", unread: 2, readSeq: 3, theirReadSeq: 5, last: wire(5) },
			{
				userId: mads,
				lastSeenAt: null,
				unread: 0,
				readSeq: 0,
				theirReadSeq: 0,
				last: {
					id: id(7004),
					seq: 4,
					authorUserId: sofie,
					createdAt: "2026-11-10T09:00:00.123456+00:00",
					deleted: true,
				},
			},
		]);
	});

	it("reads the id a member sent their own message with, and refuses one that is no id", () => {
		const good = {
			schema: "qorpera.member-chat/v1",
			userId: sofie,
			messages: [wire(1, { authorUserId: me, clientMessageId: id(77).toUpperCase() }), wire(2)],
			hasMore: false,
			readSeq: 0,
			theirReadSeq: 0,
		};
		const parsed = parseMemberChatPage(good, sofie);
		expect(parsed.messages[0]?.clientMessageId).toBe(id(77));
		expect(parsed.messages[1]).not.toHaveProperty("clientMessageId");
		expect(() => parseMemberChatPage({ ...good, messages: [wire(1, { clientMessageId: "mine" })] }, sofie)).toThrow();
	});

	it("refuses a list or a page that is not what the cloud answers", () => {
		const chat = { userId: sofie, lastSeenAt: null, unread: 0, readSeq: 0, theirReadSeq: 0, last: null };
		for (const bad of [
			{ schema: "qorpera.member-chats/v2", chats: [] },
			{ schema: "qorpera.member-chats/v1", chats: [chat, chat] },
			{ schema: "qorpera.member-chats/v1", chats: [{ ...chat, unread: -1 }] },
			{ schema: "qorpera.member-chats/v1", chats: [{ ...chat, userId: "sofie" }] },
			{ schema: "qorpera.member-chats/v1", chats: [{ ...chat, last: wire(1, { text: "  " }) }] },
			{ schema: "qorpera.member-chats/v1", chats: [{ ...chat, last: wire(0) }] },
		])
			expect(() => parseMemberChats(bad), JSON.stringify(bad)).toThrow();
		const good = {
			schema: "qorpera.member-chat/v1",
			userId: sofie,
			messages: [wire(1), wire(2)],
			hasMore: true,
			readSeq: 1,
			theirReadSeq: 2,
		};
		expect(parseMemberChatPage(good, sofie)).toMatchObject({
			userId: sofie,
			hasMore: true,
			readSeq: 1,
			theirReadSeq: 2,
		});
		for (const bad of [
			{ ...good, schema: "qorpera.member-chat/v2" },
			{ ...good, messages: [wire(2), wire(1)] },
			{ ...good, messages: [wire(1), wire(1)] },
			{ ...good, hasMore: "yes" },
		])
			expect(() => parseMemberChatPage(bad, sofie), JSON.stringify(bad)).toThrow();
		// Another member's page is never taken for this chat's.
		expect(() => parseMemberChatPage(good, mads)).toThrow();
	});

	it("calls the five functions with the company and the member", async () => {
		const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>): Promise<unknown> => {
			if (name === "qorpera_list_member_chats") return { schema: "qorpera.member-chats/v1", chats: [] };
			if (name === "qorpera_read_member_chat")
				return {
					schema: "qorpera.member-chat/v1",
					userId: sofie,
					messages: [],
					hasMore: false,
					readSeq: 0,
					theirReadSeq: 0,
				};
			if (name === "qorpera_mark_member_chat_read")
				return { schema: "qorpera.member-chat-read/v1", userId: sofie, readSeq: 7 };
			return { schema: "qorpera.member-message/v1", userId: sofie, message: { ...wire(8), authorUserId: me } };
		});
		const calls = memberChatCalls({ rpc }, profileA.profileId);
		await calls.list();
		await calls.read(sofie);
		await calls.read(sofie, 40);
		expect((await calls.send(sofie, id(1), "Hi")).seq).toBe(8);
		expect(await calls.markRead(sofie, 7)).toBe(7);
		await calls.remove(id(7008));
		expect(rpc.mock.calls).toEqual([
			["qorpera_list_member_chats", { p_profile_id: profileA.profileId }],
			[
				"qorpera_read_member_chat",
				{ p_profile_id: profileA.profileId, p_user_id: sofie, p_before_seq: null, p_limit: 50 },
			],
			[
				"qorpera_read_member_chat",
				{ p_profile_id: profileA.profileId, p_user_id: sofie, p_before_seq: 40, p_limit: 50 },
			],
			[
				"qorpera_send_member_message",
				{ p_profile_id: profileA.profileId, p_user_id: sofie, p_client_message_id: id(1), p_text: "Hi" },
			],
			["qorpera_mark_member_chat_read", { p_profile_id: profileA.profileId, p_user_id: sofie, p_seq: 7 }],
			["qorpera_delete_member_message", { p_profile_id: profileA.profileId, p_message_id: id(7008) }],
		]);
		// A sent message answered for another member is not this chat's.
		await expect(calls.send(mads, id(2), "Hi")).rejects.toThrow();
	});
});

/** A chat as the cloud keeps it: `read` answers its newest `limit` messages, or the `limit` before a place, with
 * whether older ones stand before them, as qorpera_read_member_chat does. */
function chatServer(initial: MemberMessage[] = []) {
	const kept = { messages: [...initial], readSeq: 0, theirReadSeq: 0 };
	const read = vi.fn(async (userId: string, before?: number, limit = 50) => {
		const older = kept.messages.filter((item) => before === undefined || item.seq < before);
		return page(userId, older.slice(-limit), {
			hasMore: older.length > limit,
			readSeq: kept.readSeq,
			theirReadSeq: kept.theirReadSeq,
		});
	});
	/** The message at a place taken back: its words go, its place stays. */
	const takeBack = (seq: number) => {
		kept.messages = kept.messages.map((item) =>
			item.seq === seq
				? { id: item.id, seq, authorUserId: item.authorUserId, createdAt: item.createdAt, deleted: true as const }
				: item,
		);
	};
	return { kept, read, takeBack };
}
const run = (from: number, to: number, author = sofie) =>
	Array.from({ length: to - from + 1 }, (_, index) => message(from + index, author, `m${from + index}`));
const seqs = (thread: { messages: readonly MemberMessage[] }) => thread.messages.map((item) => item.seq);

describe("the chats' state", () => {
	it("reads the list, the open chat, and marks what is on screen read", async () => {
		const { controller, calls, state } = chats({
			list: vi.fn(async () => [
				summary(sofie, { unread: 2, last: message(5, sofie, "Are you there?") }),
				summary(mads),
			]),
			read: vi.fn(async (userId: string) =>
				page(userId, [message(4, me, "Hi"), message(5, sofie, "Are you there?")], { readSeq: 3, theirReadSeq: 4 }),
			),
		});
		await controller.refresh();
		expect(state.summaries?.[sofie]?.unread).toBe(2);
		expect(controller.unread()).toBe(2);
		controller.setOpen(sofie);
		await settle();
		const thread = controller.thread(sofie).get();
		expect(thread.loaded).toBe(true);
		expect(thread.messages.map((item) => item.text)).toEqual(["Hi", "Are you there?"]);
		// In front of someone: the count goes at once, and the cloud is told the newest message was seen.
		expect(state.summaries?.[sofie]?.unread).toBe(0);
		expect(calls.markRead).toHaveBeenCalledWith(sofie, 5);
		expect(controller.thread(sofie).get().readSeq).toBe(5);
		// Nothing new: no second mark.
		controller.seen();
		expect(calls.markRead).toHaveBeenCalledTimes(1);
	});

	it("marks nothing for this member's own messages: they are never unread to them", async () => {
		const { controller, calls } = chats({
			read: vi.fn(async (userId: string) =>
				page(userId, [message(4, sofie, "Hi"), message(5, me, "Hello")], { readSeq: 4 }),
			),
		});
		controller.setOpen(sofie);
		await settle();
		expect(calls.markRead).not.toHaveBeenCalled();
		expect(controller.thread(sofie).get().readSeq).toBe(4);
	});

	it("marks nothing read while nobody looks, and marks it when they are back", async () => {
		const { controller, calls, state } = chats(
			{
				list: vi.fn(async () => [summary(sofie, { unread: 1, last: message(5, sofie, "Hello") })]),
				read: vi.fn(async (userId: string) => page(userId, [message(5, sofie, "Hello")])),
			},
			{ visible: false },
		);
		controller.setOpen(sofie);
		await controller.refresh();
		await settle();
		expect(calls.markRead).not.toHaveBeenCalled();
		expect(state.summaries?.[sofie]?.unread).toBe(1);
		state.visible = true;
		controller.seen();
		expect(calls.markRead).toHaveBeenCalledWith(sofie, 5);
		expect(state.summaries?.[sofie]?.unread).toBe(0);
	});

	it("steps a mark back when the cloud did not take it", async () => {
		const { controller, calls } = chats({
			read: vi.fn(async (userId: string) => page(userId, [message(5, sofie, "Hello")], { readSeq: 2 })),
			markRead: vi.fn(async () => {
				throw new Error("offline");
			}),
		});
		controller.setOpen(sofie);
		await settle();
		expect(calls.markRead).toHaveBeenCalledTimes(1);
		expect(controller.thread(sofie).get().readSeq).toBe(2);
		// The next look tries again.
		controller.seen();
		expect(calls.markRead).toHaveBeenCalledTimes(2);
	});

	it("shows a message at once, sends in the order written, and clears the draft", async () => {
		const server = chatServer();
		const first = deferred<MemberMessage>();
		const sent: string[] = [];
		const { controller, calls, state } = chats({
			list: vi.fn(async () => [summary(sofie)]),
			read: server.read,
			send: vi.fn(async (_userId: string, _client: string, text: string) => {
				sent.push(text);
				const stored = text === "One" ? await first.promise : message(11, me, text);
				server.kept.messages.push(stored);
				return stored;
			}),
		});
		await controller.refresh();
		controller.setOpen(sofie);
		await settle();
		controller.setDraft(sofie, "  One  ");
		expect(controller.send(sofie, "  One  ")).toBe(true);
		expect(controller.send(sofie, "Two")).toBe(true);
		const thread = controller.thread(sofie);
		expect(thread.get().draft).toBe("");
		expect(thread.get().outgoing.map((item) => item.text)).toEqual(["One", "Two"]);
		await settle();
		// The second waits for the first.
		expect(sent).toEqual(["One"]);
		first.resolve(message(10, me, "One"));
		await settle();
		expect(sent).toEqual(["One", "Two"]);
		expect(thread.get().outgoing).toEqual([]);
		expect(thread.get().messages.map((item) => item.text)).toEqual(["One", "Two"]);
		expect(state.summaries?.[sofie]?.last?.text).toBe("Two");
		// Writing moves no read mark, here or in the cloud.
		expect(thread.get().readSeq).toBe(0);
		expect(calls.markRead).not.toHaveBeenCalled();
		// Each send carries an id of its own, so a repeat is the same message.
		const ids = vi.mocked(calls.send).mock.calls.map((call) => call[1]);
		expect(new Set(ids).size).toBe(2);
	});

	it("sends nothing blank or too long", () => {
		const { controller, calls } = chats({});
		expect(controller.send(sofie, " \n ")).toBe(false);
		expect(controller.send(sofie, "a".repeat(MEMBER_MESSAGE_MAX_BYTES + 1))).toBe(false);
		expect(controller.thread(sofie).get().notice).toBe("This message is too long to send. Send it in parts.");
		// A message of exactly the longest size goes, and the line is gone.
		expect(controller.send(sofie, "æ".repeat(MEMBER_MESSAGE_MAX_BYTES / 2))).toBe(true);
		expect(controller.thread(sofie).get().notice).toBeUndefined();
		expect(calls.send).toHaveBeenCalledTimes(0);
	});

	it("keeps a message that was not sent, to send again as the same message or to drop", async () => {
		const server = chatServer();
		let fail: unknown = new Error("Failed to fetch");
		const { controller, calls } = chats({
			read: server.read,
			send: vi.fn(async (_userId: string, _client: string, text: string) => {
				if (fail) throw fail;
				const stored = message(12, me, text);
				server.kept.messages.push(stored);
				return stored;
			}),
		});
		controller.setOpen(sofie);
		await settle();
		controller.send(sofie, "Hello");
		await settle();
		const thread = controller.thread(sofie);
		expect(thread.get().outgoing).toMatchObject([
			{ text: "Hello", failed: "Not sent. Check your connection and try again." },
		]);
		const clientId = thread.get().outgoing[0]!.clientMessageId;
		// The member left meanwhile: the cloud refuses, and the line says so.
		fail = new CloudRpcError(
			"qorpera_send_member_message",
			{ message: "Member chat unavailable", code: "42501" },
			403,
		);
		controller.retry(sofie, clientId);
		await settle();
		expect(thread.get().outgoing[0]?.failed).toBe("You can no longer write to this member.");
		fail = undefined;
		controller.retry(sofie, clientId);
		await settle();
		expect(thread.get().outgoing).toEqual([]);
		expect(thread.get().messages.map((item) => item.text)).toEqual(["Hello"]);
		expect(vi.mocked(calls.send).mock.calls.map((call) => call[1])).toEqual([clientId, clientId, clientId]);
		// Another that fails is dropped: nothing is left, and nothing more is sent.
		fail = new Error("Failed to fetch");
		controller.send(sofie, "Never mind");
		await settle();
		controller.discard(sofie, thread.get().outgoing[0]!.clientMessageId);
		expect(thread.get().outgoing).toEqual([]);
		expect(calls.send).toHaveBeenCalledTimes(4);
	});

	it("reads the list and the open chat again on a hint, once for a burst", async () => {
		vi.useFakeTimers();
		const { controller, calls } = chats({});
		controller.setOpen(sofie);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.read).toHaveBeenCalledTimes(1);
		controller.hinted();
		controller.hinted();
		controller.hinted();
		await vi.advanceTimersByTimeAsync(200);
		expect(calls.list).toHaveBeenCalledTimes(1);
		expect(calls.read).toHaveBeenCalledTimes(2);
	});

	it("takes the words off a message taken back, however far up the chat it stands", async () => {
		// Review of #1638, F1: only the newest page was read again, so an older message kept its words.
		const server = chatServer(run(1, 120));
		const { controller, calls } = chats({ read: server.read });
		controller.setOpen(sofie);
		await settle();
		expect(seqs(controller.thread(sofie).get())).toEqual(run(71, 120).map((item) => item.seq));
		await controller.loadEarlier(sofie);
		expect(seqs(controller.thread(sofie).get())).toEqual(run(21, 120).map((item) => item.seq));
		expect(controller.thread(sofie).get().hasMore).toBe(true);
		// The oldest message shown is taken back, and one further up that is not shown.
		server.takeBack(21);
		server.takeBack(3);
		vi.mocked(calls.read).mockClear();
		await controller.load(sofie);
		const thread = controller.thread(sofie).get();
		// Every message shown was read again, in one read; the chat keeps its place and its earlier messages to show.
		expect(calls.read).toHaveBeenCalledTimes(1);
		expect(seqs(thread)).toEqual(run(21, 120).map((item) => item.seq));
		expect(thread.messages[0]).toMatchObject({ seq: 21, deleted: true });
		expect(thread.messages[0]?.text).toBeUndefined();
		expect(thread.hasMore).toBe(true);
		// Showing earlier messages brings the other one as it is now.
		await controller.loadEarlier(sofie);
		expect(
			controller
				.thread(sofie)
				.get()
				.messages.find((item) => item.seq === 3),
		).toMatchObject({ deleted: true });
		expect(controller.thread(sofie).get().hasMore).toBe(false);
	});

	it("never leaves a hole when a send is answered before the messages that came meanwhile are read", async () => {
		// Review of #1638, F2: [1] shown, 2 to 60 arrive unread, 61 is sent and answered: the chat must not be 1, 12…61.
		const server = chatServer([message(1, sofie, "m1")]);
		const { controller, calls } = chats({
			read: server.read,
			send: vi.fn(async (_userId: string, _client: string, text: string) => {
				const stored = message(61, me, text);
				server.kept.messages.push(stored);
				return stored;
			}),
		});
		controller.setOpen(sofie);
		await settle();
		expect(seqs(controller.thread(sofie).get())).toEqual([1]);
		// No hint came for these.
		server.kept.messages.push(...run(2, 60));
		vi.mocked(calls.read).mockClear();
		controller.send(sofie, "Sixty-one");
		await settle();
		const thread = controller.thread(sofie).get();
		expect(seqs(thread)).toEqual(run(1, 61).map((item) => item.seq));
		expect(thread.hasMore).toBe(false);
		// More was new than the first read asked for: it read on backwards to the oldest message shown.
		expect(vi.mocked(calls.read).mock.calls).toEqual([
			[sofie, undefined, 11],
			[sofie, 51, 200],
		]);
	});

	it("shows a sent message once when a read brought it before the send was answered", async () => {
		// Review of #1638 round 3, F1: the hint's read comes first, then the answer, then the read after it fails.
		const server = chatServer([message(1, sofie, "m1")]);
		const answer = deferred<MemberMessage>();
		let offline = false;
		const { controller } = chats({
			read: vi.fn(async (userId: string, before?: number, limit?: number) => {
				if (offline) throw new Error("Failed to fetch");
				return server.read(userId, before, limit);
			}),
			send: vi.fn(async () => answer.promise),
		});
		controller.setOpen(sofie);
		await settle();
		controller.send(sofie, "Mine");
		await settle();
		// The cloud has it, and a hint's read shows it, while this browser still waits for the send's answer. The
		// cloud names it by the id it was sent with, so it is known at once: it stands among the messages only.
		const thread = controller.thread(sofie);
		const stored = { ...message(2, me, "Mine"), clientMessageId: thread.get().outgoing[0]!.clientMessageId };
		server.kept.messages.push(stored);
		await controller.load(sofie);
		expect(seqs(thread.get())).toEqual([1, 2]);
		expect(thread.get().outgoing).toEqual([]);
		offline = true;
		answer.resolve(stored);
		await settle();
		expect(seqs(thread.get())).toEqual([1, 2]);
		expect(thread.get().outgoing).toEqual([]);
	});

	it("shows a sent message once when the read came first and did not name it", async () => {
		// The same order of things against a run that reaches its place without the id (an older cloud's answer).
		const server = chatServer([message(1, sofie, "m1")]);
		const answer = deferred<MemberMessage>();
		let offline = false;
		const { controller } = chats({
			read: vi.fn(async (userId: string, before?: number, limit?: number) => {
				if (offline) throw new Error("Failed to fetch");
				return server.read(userId, before, limit);
			}),
			send: vi.fn(async () => answer.promise),
		});
		controller.setOpen(sofie);
		await settle();
		controller.send(sofie, "Mine");
		await settle();
		server.kept.messages.push(message(2, me, "Mine"));
		await controller.load(sofie);
		const thread = controller.thread(sofie);
		expect(thread.get().outgoing).toHaveLength(1);
		offline = true;
		answer.resolve(message(2, me, "Mine"));
		await settle();
		// The run shown reaches its place: it stands there, and nowhere after it.
		expect(seqs(thread.get())).toEqual([1, 2]);
		expect(thread.get().outgoing).toEqual([]);
	});

	it("drops a message marked not sent once a read shows the cloud has it after all", async () => {
		// The send's answer was lost on the way back: the message was written, and this browser was told it failed.
		const server = chatServer([message(1, sofie, "m1")]);
		const { controller, calls } = chats({
			read: server.read,
			send: vi.fn(async (_userId: string, client: string, text: string) => {
				server.kept.messages.push({ ...message(2, me, text), clientMessageId: client });
				throw new Error("Failed to fetch");
			}),
		});
		controller.setOpen(sofie);
		await settle();
		controller.send(sofie, "Did it go?");
		await settle();
		const thread = controller.thread(sofie);
		expect(thread.get().outgoing).toMatchObject([
			{ text: "Did it go?", failed: "Not sent. Check your connection and try again." },
		]);
		// The hint for it, or the clock, reads the chat: there it is, once, and nothing is left to try again.
		await controller.poll();
		expect(thread.get().messages.map((item) => item.text)).toEqual(["m1", "Did it go?"]);
		expect(thread.get().outgoing).toEqual([]);
		expect(calls.send).toHaveBeenCalledTimes(1);
	});

	it("drops a message marked not sent when an earlier page shows the cloud has it", async () => {
		// Review of #1638 round 4, F1: the answer was lost, the chat left the screen, 50 newer messages came. Opened
		// again, the chat does not reach it; "Show earlier messages" brings it, and it must not stand twice.
		const server = chatServer([message(1, sofie, "m1")]);
		const { controller } = chats({
			read: server.read,
			send: vi.fn(async (_userId: string, client: string, text: string) => {
				server.kept.messages.push({ ...message(2, me, text), clientMessageId: client });
				throw new Error("Failed to fetch");
			}),
		});
		controller.setOpen(sofie);
		await settle();
		controller.send(sofie, "Did it go?");
		await settle();
		controller.setOpen(undefined);
		server.kept.messages.push(...run(3, 52));
		controller.setOpen(sofie);
		await settle();
		const thread = controller.thread(sofie);
		// The newest page starts after it: nothing says yet that the cloud has it.
		expect(seqs(thread.get())).toEqual(run(3, 52).map((item) => item.seq));
		expect(thread.get().outgoing).toMatchObject([
			{ text: "Did it go?", failed: "Not sent. Check your connection and try again." },
		]);
		await controller.loadEarlier(sofie);
		expect(seqs(thread.get())).toEqual(run(1, 52).map((item) => item.seq));
		expect(thread.get().messages[1]).toMatchObject({ seq: 2, text: "Did it go?" });
		expect(thread.get().outgoing).toEqual([]);
	});

	it("keeps a sent message after the chat's messages until a read brings it among them", async () => {
		const server = chatServer([message(1, sofie, "m1")]);
		let offline = false;
		const read = vi.fn(async (userId: string, before?: number, limit?: number) => {
			if (offline) throw new Error("Failed to fetch");
			return server.read(userId, before, limit);
		});
		const { controller, calls } = chats({
			read,
			send: vi.fn(async (_userId: string, _client: string, text: string) => {
				// Sofie wrote just before: her message stands between the one shown and this one.
				server.kept.messages.push(message(2, sofie, "m2"), message(3, me, text));
				return message(3, me, text);
			}),
			remove: vi.fn(async (messageId: string) => {
				const taken = server.kept.messages.find((item) => item.id === messageId)!;
				server.takeBack(taken.seq);
				return server.kept.messages.find((item) => item.id === messageId)!;
			}),
		});
		controller.setOpen(sofie);
		await settle();
		// The read after the send fails: the sent message is put nowhere among the messages by guess.
		offline = true;
		controller.send(sofie, "Mine");
		await settle();
		const thread = controller.thread(sofie);
		expect(seqs(thread.get())).toEqual([1]);
		expect(thread.get().outgoing).toMatchObject([{ text: "Mine", sent: { id: id(7003), seq: 3, text: "Mine" } }]);
		expect(thread.get().outgoing[0]?.failed).toBeUndefined();
		// Sent once: nothing sends it again.
		controller.retry(sofie, thread.get().outgoing[0]!.clientMessageId);
		await settle();
		expect(controller.thread(sofie).get().outgoing).toHaveLength(1);
		// It is the message it will be: taken back while it waits, it loses its words where it stands (round 3, F2).
		await controller.remove(sofie, id(7003));
		expect(calls.remove).toHaveBeenCalledWith(id(7003));
		expect(thread.get().outgoing).toMatchObject([{ sent: { id: id(7003), deleted: true } }]);
		expect(seqs(thread.get())).toEqual([1]);
		// The next read brings it, after the message that came before it.
		offline = false;
		await controller.poll();
		expect(seqs(thread.get())).toEqual([1, 2, 3]);
		expect(thread.get().messages[2]).toMatchObject({ deleted: true });
		expect(thread.get().outgoing).toEqual([]);
		// Sent with the chat off screen, it waits the same way and is gone once the chat is read again.
		controller.setOpen(undefined);
		server.kept.messages.push(message(4, me, "Later"));
		controller.thread(sofie).set({
			outgoing: [{ clientMessageId: id(1), text: "Later", createdAt: timestamp, sent: message(4, me, "Later") }],
		});
		controller.setOpen(sofie);
		await settle();
		expect(seqs(thread.get())).toEqual([1, 2, 3, 4]);
		expect(thread.get().outgoing).toEqual([]);
	});

	it("shows on the clock what a missed hint would have brought, with no newer message", async () => {
		// Review of #1638, F4: a message taken back and the other member's look changed nothing the poll looked at.
		const server = chatServer([message(4, sofie, "Theirs"), message(5, me, "Mine")]);
		const { controller, calls } = chats({
			list: vi.fn(async () => [
				summary(sofie, {
					last: server.kept.messages.at(-1) ?? null,
					theirReadSeq: server.kept.theirReadSeq,
					readSeq: 4,
				}),
			]),
			read: server.read,
		});
		server.kept.readSeq = 4;
		controller.setOpen(sofie);
		await controller.refresh();
		await settle();
		expect(controller.thread(sofie).get()).toMatchObject({ theirReadSeq: 0 });
		expect(controller.thread(sofie).get().messages[0]?.text).toBe("Theirs");
		// Sofie takes her message back and looks at mine. The newest message is the same one, and no hint arrives.
		server.takeBack(4);
		server.kept.theirReadSeq = 5;
		vi.mocked(calls.read).mockClear();
		await controller.poll();
		expect(calls.read).toHaveBeenCalledTimes(1);
		expect(controller.thread(sofie).get().messages[0]).toMatchObject({ seq: 4, deleted: true });
		expect(controller.thread(sofie).get().theirReadSeq).toBe(5);
	});

	it("takes the other member's look from the list even when the chat itself cannot be read", async () => {
		let look = 0;
		let offline = false;
		const { controller } = chats({
			list: vi.fn(async () => [summary(sofie, { last: message(5, me, "Mine"), theirReadSeq: look })]),
			read: vi.fn(async (userId: string) => {
				if (offline) throw new Error("Failed to fetch");
				return page(userId, [message(5, me, "Mine")]);
			}),
		});
		controller.setOpen(sofie);
		await settle();
		look = 5;
		offline = true;
		await controller.poll();
		// What is on screen stays, and "Seen" follows the list.
		expect(controller.thread(sofie).get()).toMatchObject({ loaded: true, theirReadSeq: 5, error: undefined });
		expect(seqs(controller.thread(sofie).get())).toEqual([5]);
	});

	it("lets a chat's messages go when it leaves the screen, and reads it whole when it opens again", async () => {
		const server = chatServer([message(1, sofie, "Old words"), message(2, me, "Mine")]);
		const { controller } = chats({ read: server.read });
		controller.setOpen(sofie);
		await settle();
		controller.setDraft(sofie, "Half a thought");
		controller.setOpen(undefined);
		// Its draft stays; its messages do not.
		expect(controller.thread(sofie).get()).toMatchObject({ loaded: false, messages: [], draft: "Half a thought" });
		server.takeBack(1);
		controller.setOpen(sofie);
		// Nothing of what it showed before is drawn while the read is on its way.
		expect(controller.thread(sofie).get()).toMatchObject({ loaded: false, loading: true, messages: [] });
		await settle();
		expect(controller.thread(sofie).get().messages[0]).toMatchObject({ seq: 1, deleted: true });
		expect(controller.thread(sofie).get().draft).toBe("Half a thought");
	});

	it("drops a read that lands after its chat left the screen, and an answer that is no longer the newest", async () => {
		const slow = deferred<MemberChatPage>();
		let reads = 0;
		const { controller } = chats({
			read: vi.fn(async (userId: string) =>
				++reads === 1 ? slow.promise : page(userId, [message(9, sofie, "Newest")]),
			),
		});
		controller.setOpen(sofie);
		await settle();
		// A second read starts and lands first; the first one's answer is older and is not taken.
		await controller.load(sofie);
		slow.resolve(page(sofie, [message(8, sofie, "Older answer")]));
		await settle();
		expect(seqs(controller.thread(sofie).get())).toEqual([9]);
		const late = deferred<MemberChatPage>();
		const closing = chats({ read: vi.fn(async () => late.promise) });
		closing.controller.setOpen(sofie);
		closing.controller.setOpen(undefined);
		late.resolve(page(sofie, [message(1, sofie, "Too late")]));
		await settle();
		expect(closing.controller.thread(sofie).get()).toMatchObject({ loaded: false, messages: [] });
	});

	it("keeps earlier messages that were shown while a read of the chat was on its way", async () => {
		const server = chatServer(run(1, 80));
		const { controller, calls } = chats({ read: server.read });
		controller.setOpen(sofie);
		await settle();
		// A read of the chat starts (from 31) and is held; meanwhile the member shows earlier messages.
		const held = deferred<void>();
		vi.mocked(calls.read).mockImplementationOnce(async (userId: string, before?: number, limit?: number) => {
			await held.promise;
			return server.read(userId, before, limit);
		});
		const reading = controller.load(sofie);
		await controller.loadEarlier(sofie);
		expect(seqs(controller.thread(sofie).get())).toEqual(run(1, 80).map((item) => item.seq));
		held.resolve();
		await reading;
		// The run read from 31 joins the earlier ones: nothing shown is lost, nothing stands twice.
		expect(seqs(controller.thread(sofie).get())).toEqual(run(1, 80).map((item) => item.seq));
		expect(controller.thread(sofie).get().hasMore).toBe(false);
	});

	it("starts over at what was read, earlier messages shown meanwhile too, when the read did not reach them", async () => {
		// Review of #1638 round 2, F1: 51 to 2100 shown; a read reaches back to 101; 1 to 50 are shown meanwhile. Joined,
		// they would be 1…50, 101…2100: a hole. The chat starts at 101 and offers the earlier messages again.
		const server = chatServer(run(1, 2100));
		const { controller, calls } = chats({ read: server.read });
		controller.setOpen(sofie);
		await settle();
		for (let pages = 0; pages < 40; pages++) await controller.loadEarlier(sofie);
		expect(seqs(controller.thread(sofie).get())[0]).toBe(51);
		const held = deferred<void>();
		vi.mocked(calls.read).mockImplementationOnce(async (userId: string, before?: number, limit?: number) => {
			await held.promise;
			return server.read(userId, before, limit);
		});
		const reading = controller.load(sofie);
		await controller.loadEarlier(sofie);
		expect(seqs(controller.thread(sofie).get())[0]).toBe(1);
		held.resolve();
		await reading;
		const thread = controller.thread(sofie).get();
		expect(seqs(thread)).toEqual(run(101, 2100).map((item) => item.seq));
		expect(thread.hasMore).toBe(true);
	});

	it("starts the chat at what was read when more is new than it reads back in one go", async () => {
		// Ten reads reach 60 + 9 × 200 messages back; past that the chat shows less, never a hole.
		const server = chatServer([message(1, sofie, "m1")]);
		const { controller } = chats({ read: server.read });
		controller.setOpen(sofie);
		await settle();
		server.kept.messages.push(...run(2, 2500));
		await controller.load(sofie);
		const thread = controller.thread(sofie).get();
		expect(thread.messages).toHaveLength(11 + 9 * 200);
		expect(seqs(thread).at(-1)).toBe(2500);
		expect(seqs(thread).every((seq, index, all) => index === 0 || seq === all[index - 1]! + 1)).toBe(true);
		expect(thread.hasMore).toBe(true);
	});

	it("reads earlier pages above what is shown", async () => {
		const server = chatServer(run(1, 70));
		const { controller, calls } = chats({ read: server.read });
		controller.setOpen(sofie);
		await settle();
		expect(controller.thread(sofie).get().hasMore).toBe(true);
		await controller.loadEarlier(sofie);
		expect(calls.read).toHaveBeenLastCalledWith(sofie, 21);
		expect(controller.thread(sofie).get()).toMatchObject({ hasMore: false, loadingEarlier: false });
		expect(seqs(controller.thread(sofie).get())).toEqual(run(1, 70).map((item) => item.seq));
		// Nothing earlier: no more reads.
		await controller.loadEarlier(sofie);
		expect(calls.read).toHaveBeenCalledTimes(2);
	});

	it("takes a message back, and says so when it could not", async () => {
		const taken = {
			id: id(7004),
			seq: 4,
			authorUserId: me,
			createdAt: "2026-11-10T09:00:00Z",
			deleted: true as const,
		};
		let fail = false;
		const { controller, state } = chats({
			list: vi.fn(async () => [summary(sofie, { last: message(4, me, "Oops") })]),
			read: vi.fn(async (userId: string) => page(userId, [message(4, me, "Oops")])),
			remove: vi.fn(async () => {
				if (fail) throw new Error("offline");
				return taken;
			}),
		});
		await controller.refresh();
		controller.setOpen(sofie);
		await settle();
		await controller.remove(sofie, id(7004));
		expect(controller.thread(sofie).get().messages).toEqual([taken]);
		expect(state.summaries?.[sofie]?.last).toEqual(taken);
		fail = true;
		await controller.remove(sofie, id(7004));
		expect(controller.thread(sofie).get().notice).toBe("Could not delete the message. Try again.");
	});

	it("puts a message taken back nowhere above the chat when the answer comes after it was opened again", async () => {
		// Review of #1638 round 2, F2: message 1 is taken back, the chat is opened again at 51 to 100, then the answer
		// comes. With 1 put above 51, "Show earlier messages" would ask before 1 and never show 2 to 50.
		const server = chatServer(run(1, 100, me));
		const answer = deferred<MemberMessage>();
		const { controller } = chats({ read: server.read, remove: vi.fn(async () => answer.promise) });
		controller.setOpen(sofie);
		await settle();
		await controller.loadEarlier(sofie);
		expect(seqs(controller.thread(sofie).get())).toEqual(run(1, 100).map((item) => item.seq));
		const removing = controller.remove(sofie, id(7001));
		controller.setOpen(undefined);
		controller.setOpen(sofie);
		await settle();
		server.takeBack(1);
		answer.resolve(server.kept.messages[0]!);
		await removing;
		expect(seqs(controller.thread(sofie).get())).toEqual(run(51, 100).map((item) => item.seq));
		expect(controller.thread(sofie).get().hasMore).toBe(true);
		await controller.loadEarlier(sofie);
		const thread = controller.thread(sofie).get();
		expect(seqs(thread)).toEqual(run(1, 100).map((item) => item.seq));
		expect(thread.messages[0]).toMatchObject({ seq: 1, deleted: true });
	});

	it("stops asking a cloud that has no member chats, and says why a chat did not open", async () => {
		const missing = new CloudRpcError("qorpera_list_member_chats", { message: "missing", code: "PGRST202" }, 404);
		const none = chats({
			list: vi.fn(async () => {
				throw missing;
			}),
		});
		await none.controller.refresh();
		expect(none.state.unavailable).toBe(true);
		await none.controller.refresh();
		expect(none.calls.list).toHaveBeenCalledTimes(1);
		const refused = chats({
			read: vi.fn(async () => {
				throw new CloudRpcError(
					"qorpera_read_member_chat",
					{ message: "Member chat unavailable", code: "42501" },
					403,
				);
			}),
		});
		refused.controller.setOpen(sofie);
		await settle();
		expect(refused.controller.thread(sofie).get()).toMatchObject({
			loaded: false,
			loading: false,
			error: "This chat is not available.",
		});
		const offline = chats({
			read: vi.fn(async () => {
				throw new Error("Failed to fetch");
			}),
		});
		offline.controller.setOpen(sofie);
		await settle();
		expect(offline.controller.thread(sofie).get().error).toBe("Could not open this chat. Check your connection.");
		// Alone in the company, nothing is asked.
		const alone = chats({}, { available: false });
		await alone.controller.refresh();
		alone.controller.setOpen(sofie);
		expect(alone.controller.send(sofie, "Hi")).toBe(false);
		expect(alone.calls.list).not.toHaveBeenCalled();
		expect(alone.calls.read).not.toHaveBeenCalled();
	});
});

/** A company with Ann, Sofie and Mads whose cloud answers the member chat functions from `answers`. */
function company(
	answers: {
		chats?: MemberChatSummary[];
		pages?: Record<string, MemberChatPage>;
		send?: (text: string) => unknown;
		members?: HostedProfileMember[];
		/** Reads of a chat fail while this says so. */
		offline?: () => boolean;
	} = {},
) {
	const f = fixture();
	const rpc = vi.mocked(f.cloud.rpc);
	const wireMessage = (item: MemberMessage) => ({ ...item });
	/** Each chat as the cloud keeps it: a sent message is in the next read. */
	const kept: Record<string, MemberChatPage> = { ...answers.pages };
	rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
		const other = String(args.p_user_id ?? "");
		if (name === "qorpera_list_member_chats")
			return {
				schema: "qorpera.member-chats/v1",
				chats: (answers.chats ?? [summary(sofie), summary(mads)]).map((chat) => ({ ...chat })),
			};
		if (name === "qorpera_delete_member_message") {
			for (const [userId, chat] of Object.entries(kept)) {
				const found = chat.messages.find((item) => item.id === args.p_message_id);
				if (!found) continue;
				const taken = {
					id: found.id,
					seq: found.seq,
					authorUserId: found.authorUserId,
					createdAt: found.createdAt,
					deleted: true as const,
				};
				kept[userId] = { ...chat, messages: chat.messages.map((item) => (item === found ? taken : item)) };
				return { schema: "qorpera.member-message/v1", userId, message: taken };
			}
			throw new CloudRpcError(name, { message: "Member chat unavailable", code: "42501" }, 403);
		}
		if (name === "qorpera_read_member_chat") {
			if (answers.offline?.()) throw new Error("Failed to fetch");
			// Nothing stands before the pages a test gives.
			const found = (args.p_before_seq === null ? kept[other] : undefined) ?? page(other, []);
			return { schema: "qorpera.member-chat/v1", ...found, messages: found.messages.map(wireMessage) };
		}
		if (name === "qorpera_mark_member_chat_read")
			return { schema: "qorpera.member-chat-read/v1", userId: other, readSeq: args.p_seq };
		if (name === "qorpera_send_member_message") {
			// As the cloud answers: the sender's own message, with the id it was sent with.
			const answer: MemberMessage = {
				...((answers.send?.(String(args.p_text)) ??
					message(900, me, String(args.p_text), new Date().toISOString())) as MemberMessage),
				clientMessageId: String(args.p_client_message_id),
			};
			const chat = kept[other] ?? page(other, []);
			kept[other] = { ...chat, messages: [...chat.messages, answer] };
			return { schema: "qorpera.member-message/v1", userId: other, message: answer };
		}
		throw new Error(`Unexpected RPC ${name}`);
	});
	const controller = new CompanyController(f.api, profileA, me);
	controller.store.set({ loading: false, team: { ...team, members: answers.members ?? people } });
	cleanup.push(() => controller.stop());
	return { f, controller, rpc };
}

function chatView(controller: CompanyController, userId = sofie) {
	const view = new MemberChatView(controller, userId, () => {});
	cleanup.push(() => view.dispose());
	cleanup.push(controller.store.subscribe(() => view.update()));
	document.body.append(view.el);
	return view;
}

const bubbles = (root: ParentNode) =>
	[...root.querySelectorAll("article.message")].map((element) => [
		element.classList.contains("mine") ? "mine" : "theirs",
		element.querySelector(".text")?.textContent,
		element.querySelector(".message-caption")?.textContent ?? "",
	]);

describe("a member's chat on screen", () => {
	it("draws the messages with the times between them, mine on the right, and Seen under my newest", async () => {
		const { controller, rpc } = company({
			pages: {
				[sofie]: page(
					sofie,
					[
						message(1, me, "Morning!", "2026-11-09T09:00:00Z"),
						message(2, sofie, "Hi Ann", "2026-11-09T09:01:00Z"),
						message(3, me, "See https://qorpera.com/x, it is live.", "2026-11-10T08:00:00Z"),
					],
					{ readSeq: 3, theirReadSeq: 3 },
				),
			},
		});
		const view = chatView(controller);
		await settle();
		expect(bubbles(view.el)).toEqual([
			["mine", "Morning!", ""],
			["theirs", "Hi Ann", ""],
			["mine", "See https://qorpera.com/x, it is live.", "Seen"],
		]);
		// Two days: a time before the first message and one before the next day's; none between a minute's two.
		expect(view.el.querySelectorAll("time.conversation-timestamp")).toHaveLength(2);
		// The address is a link without the sentence's comma, opened in a new tab.
		const link = view.el.querySelector<HTMLAnchorElement>(".bubble a");
		expect(link?.href).toBe("https://qorpera.com/x");
		expect(link?.target).toBe("_blank");
		expect(link?.rel).toBe("noopener noreferrer");
		// Their name and face stand in the header (a phone shows it).
		expect(view.el.querySelector(".member-identity h1")?.textContent).toBe("Sofie Lund");
		// Nothing was new to this member: no mark.
		expect(rpc.mock.calls.some((call) => call[0] === "qorpera_mark_member_chat_read")).toBe(false);
		expect(view.el.querySelector(".thread-header")?.classList.contains("is-member")).toBe(true);
	});

	it("has no Seen while the other member has not looked, or once they answered", async () => {
		const unseen = company({
			pages: { [sofie]: page(sofie, [message(3, me, "Hello")], { readSeq: 3, theirReadSeq: 2 }) },
		});
		const first = chatView(unseen.controller);
		await settle();
		expect(bubbles(first.el)).toEqual([["mine", "Hello", ""]]);
		const answered = company({
			pages: {
				[sofie]: page(sofie, [message(3, me, "Hello"), message(4, sofie, "Hi")], { readSeq: 4, theirReadSeq: 4 }),
			},
		});
		const second = chatView(answered.controller);
		await settle();
		expect(bubbles(second.el).map((row) => row[2])).toEqual(["", ""]);
	});

	it("starts with the member's face and one line, and sends with Enter", async () => {
		const { controller, rpc } = company();
		const view = chatView(controller);
		await settle();
		expect(view.el.querySelector(".member-chat-empty strong")?.textContent).toBe("Sofie Lund");
		expect(view.el.querySelector(".member-chat-empty p")?.textContent).toBe("Write the first message to Sofie Lund.");
		const field = view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		const send = view.el.querySelector<HTMLButtonElement>(".composer-send")!;
		expect(send.disabled).toBe(true);
		field.value = "Hello Sofie";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		expect(send.disabled).toBe(false);
		// Shift+Enter is a new line; Enter sends.
		field.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
		);
		expect(rpc.mock.calls.some((call) => call[0] === "qorpera_send_member_message")).toBe(false);
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(field.value).toBe("");
		expect(send.disabled).toBe(true);
		await settle();
		const sent = rpc.mock.calls.find((call) => call[0] === "qorpera_send_member_message");
		expect(sent?.[1]).toMatchObject({ p_profile_id: profileA.profileId, p_user_id: sofie, p_text: "Hello Sofie" });
		expect(bubbles(view.el)).toEqual([["mine", "Hello Sofie", ""]]);
		expect(view.el.querySelector(".member-chat-empty")).toBeNull();
	});

	it("keeps a draft while the member looks elsewhere", async () => {
		const { controller } = company();
		const view = chatView(controller);
		await settle();
		const field = view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		field.value = "Half a thought";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		view.dispose();
		view.el.remove();
		expect(controller.memberChats.open).toBeUndefined();
		const again = chatView(controller);
		expect(again.el.querySelector<HTMLTextAreaElement>(".composer-input")?.value).toBe("Half a thought");
		expect(controller.memberChats.open).toBe(sofie);
	});

	it("shows a message that was not sent with the two ways on", async () => {
		let fail = true;
		const { controller } = company({
			send: (text) => {
				if (fail) throw new Error("Failed to fetch");
				return message(901, me, text, new Date().toISOString());
			},
		});
		const view = chatView(controller);
		await settle();
		controller.memberChats.send(sofie, "Will not go");
		await settle();
		const failed = view.el.querySelector(".message.pending-failed");
		expect(failed?.querySelector(".member-chat-failed span")?.textContent).toBe(
			"Not sent. Check your connection and try again.",
		);
		const buttons = [...(failed?.querySelectorAll("button") ?? [])];
		expect(buttons.map((button) => button.textContent)).toEqual(["Try again", "Delete"]);
		fail = false;
		buttons[0]!.click();
		await settle();
		expect(view.el.querySelector(".message.pending-failed")).toBeNull();
		expect(bubbles(view.el)).toEqual([["mine", "Will not go", ""]]);
	});

	it("takes back a sent message that still waits for the chat's next read", async () => {
		// Review of #1638 round 3, F2: sent, then the read after it fails. The bubble looks sent, so it is the message.
		let offline = false;
		const { controller, rpc } = company({ offline: () => offline });
		const view = chatView(controller);
		await settle();
		offline = true;
		controller.memberChats.send(sofie, "Too fast");
		await settle();
		const sent = view.el.querySelector<HTMLElement>("article.message");
		expect(bubbles(view.el)).toEqual([["mine", "Too fast", ""]]);
		// Sent, not on its way: no faded bubble, and its own id.
		expect(sent?.classList.contains("pending-queued")).toBe(false);
		expect(sent?.dataset.messageId).toBe(id(7900));
		sent!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		const item = [...openMenu()!.el.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
			(entry) => entry.textContent === "Delete message",
		);
		item!.click();
		await settle();
		// It asks first; the answer is yes.
		const confirm = [...document.querySelectorAll<HTMLButtonElement>(".modal-backdrop button")].find(
			(button) => button.textContent === "Delete message",
		);
		confirm!.click();
		await settle();
		expect(
			rpc.mock.calls.filter((call) => call[0] === "qorpera_delete_member_message").map((call) => call[1]),
		).toEqual([{ p_profile_id: profileA.profileId, p_message_id: id(7900) }]);
		expect(bubbles(view.el)).toEqual([["mine", "Message deleted", ""]]);
		// The next read brings it among the messages as it is: once, without words.
		offline = false;
		await controller.memberChats.poll();
		await settle();
		expect(bubbles(view.el)).toEqual([["mine", "Message deleted", ""]]);
		expect(controller.memberChats.thread(sofie).get().outgoing).toEqual([]);
	});

	it("shows when each message was sent on a hover, a sent one and one on its way alike", async () => {
		let offline = false;
		const { controller } = company({
			offline: () => offline,
			pages: { [sofie]: page(sofie, [message(1, sofie, "Theirs", "2026-11-10T08:00:30Z")]) },
		});
		const view = chatView(controller);
		await settle();
		// Not sent: it stays on screen as the member's own, still with its time.
		offline = true;
		controller.memberChats.send(sofie, "Not sent");
		await settle();
		const [theirs, mine] = [...view.el.querySelectorAll<HTMLElement>("article.message")];
		expect(theirs?.dataset.sentAt).toBe("2026-11-10T08:00:30Z");
		expect(theirs?.hasAttribute("title")).toBe(false);
		const outgoing = controller.memberChats.thread(sofie).get().outgoing[0];
		expect(outgoing?.createdAt).toBeTruthy();
		expect(mine?.dataset.sentAt).toBe(outgoing?.createdAt);
	});

	it("draws a message taken back without words, and offers to take back only my own", async () => {
		const { controller } = company({
			pages: {
				[sofie]: page(sofie, [
					{ id: id(7001), seq: 1, authorUserId: sofie, createdAt: "2026-11-10T08:00:00Z", deleted: true },
					message(2, sofie, "Theirs", "2026-11-10T08:00:30Z"),
					message(3, me, "Mine", "2026-11-10T08:01:00Z"),
				]),
			},
		});
		const view = chatView(controller);
		await settle();
		const [gone, theirs, mine] = [...view.el.querySelectorAll<HTMLElement>("article.message")];
		expect(gone?.classList.contains("message-erased")).toBe(true);
		expect(gone?.textContent).toBe("Message deleted");
		const menu = (element: HTMLElement) =>
			element.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
			);
		// Theirs and one taken back keep the browser's own menu.
		expect(menu(theirs!)).toBe(true);
		expect(menu(gone!)).toBe(true);
		expect(openMenu()).toBeUndefined();
		expect(menu(mine!)).toBe(false);
		expect([...openMenu()!.el.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual([
			"Delete message",
		]);
	});

	it("closes the chat of a member who left, and says so", async () => {
		const { controller } = company({ pages: { [sofie]: page(sofie, [message(1, sofie, "Bye")]) } });
		const view = chatView(controller);
		await settle();
		expect(view.el.querySelector<HTMLTextAreaElement>(".composer-input")?.disabled).toBe(false);
		controller.store.set({ team: { ...team, members: [ann, people[2]!] } });
		await settle();
		expect(view.el.querySelector(".thread-status")?.textContent).toBe("This member is no longer in the company.");
		expect(view.el.querySelector<HTMLTextAreaElement>(".composer-input")?.disabled).toBe(true);
		expect(view.el.querySelector<HTMLButtonElement>(".composer-send")?.disabled).toBe(true);
		// What was written stays readable.
		expect(bubbles(view.el)).toEqual([["theirs", "Bye", ""]]);
	});

	it("offers earlier messages while there are any", async () => {
		const { controller, rpc } = company({
			pages: { [sofie]: page(sofie, [message(51, sofie, "m51")], { hasMore: true }) },
		});
		const view = chatView(controller);
		await settle();
		const earlier = view.el.querySelector<HTMLButtonElement>(".thread-earlier-button");
		expect(earlier?.textContent).toBe("Show earlier messages");
		earlier!.click();
		await settle();
		expect(rpc.mock.calls.filter((call) => call[0] === "qorpera_read_member_chat").at(-1)?.[1]).toMatchObject({
			p_before_seq: 51,
		});
	});
});

describe("who is online", () => {
	it("says online for a member in the company now or marked within minutes, else when they last were", () => {
		const now = Date.parse("2026-11-10T12:00:00Z");
		const chatsOf = (lastSeenAt: string | null) => ({ [sofie]: summary(sofie, { lastSeenAt }) });
		expect(memberPresence({ here: [], memberChats: chatsOf("2026-11-10T11:58:00Z") }, sofie, now)).toEqual({
			online: true,
			text: "Online now",
		});
		expect(memberPresence({ here: [], memberChats: chatsOf("2026-11-10T09:00:00Z") }, sofie, now)).toMatchObject({
			online: false,
		});
		expect(memberPresence({ here: [], memberChats: chatsOf(null) }, sofie, now)).toBeNull();
		const here = [{ clientId: id(70), userId: sofie, name: "Sofie", staffAgentId: null }];
		expect(memberPresence({ here, memberChats: chatsOf("2026-11-09T09:00:00Z") }, sofie, now)).toEqual({
			online: true,
			text: "Online now",
		});
	});
});

describe("members as contacts in the rail", () => {
	const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
	const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada" };

	function rail(
		answers: Parameters<typeof company>[0] = {},
		route: Route = { name: "company", profileId: profileA.profileId, section: "home" },
	) {
		const { f, controller, rpc } = company(answers);
		controller.store.set({ staff: [cofounder, ada] });
		const element = h("aside", { class: "rail" });
		document.body.append(h("div", { class: "frame" }, element));
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		const draw = () =>
			renderRail(element, controller, {
				profiles: [profileA],
				user: userA,
				route,
				auth,
				invitations: 0,
				openSettings: () => {},
				openFeedback: () => {},
				openFriends: () => {},
				agentActions: {},
			});
		cleanup.push(controller.store.subscribe(draw));
		draw();
		return { f, controller, rpc, element, draw };
	}
	const rows = (element: HTMLElement) =>
		[...element.querySelectorAll<HTMLAnchorElement>(".rail-members > a")].map((row) => ({
			name: row.querySelector("strong")?.textContent,
			line: row.querySelector("small")?.textContent ?? "",
			count: row.querySelector(".rail-count")?.textContent ?? "",
			online: row.querySelector(".person-online-dot") !== null,
			// An address inside the app: no hover popup shows it (ui/dom.ts).
			href: linkHref(row),
			label: row.getAttribute("aria-label"),
		}));

	it("lists the other members under the Co-Founder once their chats are read", async () => {
		const recently = new Date(Date.now() - 60_000).toISOString();
		const { controller, element } = rail({
			chats: [
				summary(sofie, { unread: 2, lastSeenAt: recently, last: message(5, sofie, "Can we talk prices at 14?") }),
				summary(mads, { last: message(4, me, "Thanks") }),
			],
		});
		// Before the first read: no members, and nobody waits for them.
		expect(element.querySelector(".rail-members")).toBeNull();
		await controller.memberChats.refresh();
		await settle();
		expect(rows(element)).toEqual([
			{
				name: "Sofie Lund",
				line: "Can we talk prices at 14?",
				count: "2",
				online: true,
				href: `#/c/${profileA.profileId}/member/${sofie}`,
				label: "Sofie Lund · Can we talk prices at 14? · Unread: 2",
			},
			{
				name: "Mads Berg",
				line: "",
				count: "",
				online: false,
				href: `#/c/${profileA.profileId}/member/${mads}`,
				label: "Mads Berg",
			},
		]);
		const list = element.querySelector(".rail-scroll")!;
		const order = [...list.children].map((child) => child.className.split(" ")[0]);
		expect(order.indexOf("rail-members")).toBe(order.indexOf("rail-cofounder") + 1);
		// This member is no contact of their own.
		expect(element.querySelector(`[data-member-id="${me}"]`)).toBeNull();
	});

	it("marks the open chat's row, and finds a member by name", async () => {
		const { controller, element, draw } = rail(
			{},
			{ name: "company", profileId: profileA.profileId, section: "member", id: sofie },
		);
		await controller.memberChats.refresh();
		await settle();
		const active = element.querySelector(".rail-members > a.active");
		expect(active?.getAttribute("data-member-id")).toBe(sofie);
		expect(active?.getAttribute("aria-current")).toBe("page");
		const search = element.querySelector<HTMLInputElement>("#rail-search-input")!;
		search.value = "mads";
		draw();
		expect(rows(element).map((row) => row.name)).toEqual(["Mads Berg"]);
	});

	it("draws a bigger team as cards with first names", async () => {
		const more = [4, 5, 6].map((n) => member(id(60 + n), `Person${n} Last${n}`));
		const members = [...people, ...more];
		const { controller, element } = rail({
			members,
			chats: members
				.filter((item) => item.userId !== me)
				.map((item) => summary(item.userId, { unread: item.userId === mads ? 3 : 0 })),
		});
		await controller.memberChats.refresh();
		await settle();
		const group = element.querySelector(".rail-members")!;
		expect(group.classList.contains("is-cards")).toBe(true);
		const cards = [...group.querySelectorAll<HTMLAnchorElement>("a.rail-pin-member")];
		expect(cards.map((card) => card.querySelector(".rail-pin-name")?.textContent)).toEqual([
			"Sofie",
			"Mads",
			"Person4",
			"Person5",
			"Person6",
		]);
		expect(cards[1]?.querySelector(".rail-count")?.textContent).toBe("3");
		expect(cards[1]?.getAttribute("aria-label")).toBe("Mads Berg · Unread: 3");
		expect(group.querySelector(".rail-row-member")).toBeNull();
	});

	it("shows no members alone in the company, or on a cloud without member chats", async () => {
		const alone = rail({ members: [ann] });
		await alone.controller.memberChats.refresh();
		await settle();
		expect(alone.element.querySelector(".rail-members")).toBeNull();
		expect(alone.rpc).not.toHaveBeenCalled();
		const old = rail();
		old.rpc.mockImplementation(async (name: string) => {
			throw new CloudRpcError(name, { message: "missing", code: "PGRST202" }, 404);
		});
		await old.controller.memberChats.refresh();
		await settle();
		expect(old.controller.store.get().memberChatsUnavailable).toBe(true);
		expect(old.element.querySelector(".rail-members")).toBeNull();
	});

	it("reads the chats again when the cloud hints, and when someone joins", async () => {
		vi.useFakeTimers();
		const { f, controller, rpc } = rail();
		await controller.start();
		const lists = () => rpc.mock.calls.filter((call) => call[0] === "qorpera_list_member_chats").length;
		// start() reads the team (the fixture's, with nobody else): nothing to read yet.
		controller.store.set({ team: { ...team, members: people } });
		await controller.memberChats.refresh();
		const before = lists();
		f.hints.get("qorpera_member_messages")?.();
		await vi.advanceTimersByTimeAsync(200);
		expect(lists()).toBe(before + 1);
		vi.spyOn(f.api, "getTeam").mockResolvedValue({ ...team, members: [...people, member(id(66), "New Person")] });
		await controller.refreshTeam();
		await vi.advanceTimersByTimeAsync(0);
		expect(lists()).toBe(before + 2);
	});
});

describe("the app with a member's chat", () => {
	it("opens the chat from its address, marks its contact, and leads a link to oneself home", async () => {
		const address = `#/c/${profileA.profileId}/member/${sofie}`;
		history.replaceState(null, "", `/${address}`);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
		HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
			this.open = true;
		};
		const f = fixture();
		vi.spyOn(f.api, "getTeam").mockResolvedValue({ ...team, members: people });
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
			if (name === "qorpera_list_member_chats")
				return { schema: "qorpera.member-chats/v1", chats: [summary(sofie), summary(mads)] };
			if (name === "qorpera_read_member_chat")
				return {
					schema: "qorpera.member-chat/v1",
					...page(String(args.p_user_id), args.p_user_id === sofie ? [message(1, sofie, "Hello Ann")] : []),
				};
			if (name === "qorpera_mark_member_chat_read")
				return { schema: "qorpera.member-chat-read/v1", userId: args.p_user_id, readSeq: args.p_seq };
			throw new Error("Unexpected RPC");
		});
		const root = document.createElement("div");
		document.body.append(root);
		cleanup.push(mountApplication(root, f.cloud, f.api));
		await vi.waitFor(() =>
			expect(root.querySelector(".member-thread article.message .text")?.textContent).toBe("Hello Ann"),
		);
		// The thread's frame, as an agent's chat has it, and the contact lit in the rail.
		expect(root.querySelector(".frame")?.classList.contains("has-thread")).toBe(true);
		await vi.waitFor(() =>
			expect(root.querySelector(".rail-members > a.active")?.getAttribute("data-member-id")).toBe(sofie),
		);
		// Seen by this member: the cloud is told.
		expect(vi.mocked(f.cloud.rpc).mock.calls.some((call) => call[0] === "qorpera_mark_member_chat_read")).toBe(true);
		// Another contact opens another chat in the same place.
		root.querySelector<HTMLAnchorElement>(`.rail-members > a[data-member-id="${mads}"]`)!.click();
		location.hash = `#/c/${profileA.profileId}/member/${mads}`;
		await vi.waitFor(() => expect(root.querySelector(".member-chat-empty strong")?.textContent).toBe("Mads Berg"));
		expect(root.querySelectorAll(".member-thread")).toHaveLength(1);
		// A link to oneself is no chat: it leads to the company's home.
		location.hash = `#/c/${profileA.profileId}/member/${me}`;
		await vi.waitFor(() => expect(location.hash).toBe(`#/c/${profileA.profileId}`));
		await vi.waitFor(() => expect(root.querySelector(".member-thread")).toBeNull());
	});
});

describe("the member chat's address", () => {
	it("is the company's, with the member's id", () => {
		const route: Route = { name: "company", profileId: profileA.profileId, section: "member", id: sofie };
		expect(parseRoute(`#/c/${profileA.profileId}/member/${sofie}`)).toEqual(route);
		expect(routeHash(route)).toBe(`#/c/${profileA.profileId}/member/${sofie}`);
		// Without a member it is the company's home.
		expect(parseRoute(`#/c/${profileA.profileId}/member`)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "home",
		});
	});
});
