import { CloudRpcError } from "../cloud/client.ts";
import {
	MEMBER_MESSAGE_MAX_BYTES,
	type MemberChatCalls,
	type MemberChatPage,
	type MemberChatSummary,
	type MemberMessage,
} from "../cloud/member-chats.ts";
import { t } from "../ui/preferences.ts";
import { Store } from "./state.ts";

/* A member's chats with the other members of the company (Jonas, 10 Nov 2026: "a contact for the members I work with
 * that's a direct way to message and communicate with my friends im building with"). The list (one entry per other
 * member: unread, last online, the newest message) is the company's state, read on every hint; each chat's messages
 * are read when it opens and again on each hint while it is open. A message shows at once and is sent behind it; one
 * that could not be sent stays, to be sent again or dropped. */

/** A message this browser wrote that the cloud has not answered yet, or refused. */
export interface OutgoingMemberMessage {
	readonly clientMessageId: string;
	readonly text: string;
	readonly createdAt: string;
	/** Why it was not sent. It stays until it is sent again or dropped. */
	readonly failed?: string;
}

export interface MemberChatThread {
	/** Oldest first. */
	readonly messages: readonly MemberMessage[];
	/** There are messages before the first one here. */
	readonly hasMore: boolean;
	/** The chat was read at least once. */
	readonly loaded: boolean;
	readonly loading: boolean;
	readonly loadingEarlier: boolean;
	readonly error?: string;
	/** The newest message this member has seen, and the newest the other member has. */
	readonly readSeq: number;
	readonly theirReadSeq: number;
	readonly outgoing: readonly OutgoingMemberMessage[];
	readonly draft: string;
	/** Why the last send or take-back did not go through, until the next one. */
	readonly notice?: string;
}

export interface MemberChatsHost {
	readonly userId: string;
	calls(): MemberChatCalls;
	/** This member is in the company with someone to write to, and the company is open here. */
	available(): boolean;
	/** Whether someone is looking at this tab. */
	visible(): boolean;
	summaries(): Readonly<Record<string, MemberChatSummary>> | undefined;
	setSummaries(next: Readonly<Record<string, MemberChatSummary>>): void;
	/** The cloud has no member chats (before migration 20260930715000): the rail shows none. */
	setUnavailable(): void;
}

const EMPTY: MemberChatThread = {
	messages: [],
	hasMore: false,
	loaded: false,
	loading: false,
	loadingEarlier: false,
	readSeq: 0,
	theirReadSeq: 0,
	outgoing: [],
	draft: "",
};

/** The chat with a page of its newest messages read in: what was loaded before it stays when the page reaches it.
 * A page that does not reach it (more new messages than one page) starts the chat over at the page: nothing is shown
 * with a hole in it. */
export function withNewestPage(
	thread: Pick<MemberChatThread, "messages" | "hasMore">,
	page: Pick<MemberChatPage, "messages" | "hasMore">,
): Pick<MemberChatThread, "messages" | "hasMore"> {
	const first = page.messages[0]?.seq;
	if (first === undefined) return { messages: [], hasMore: false };
	const reaches = thread.messages.some((message) => message.seq >= first);
	const older = reaches ? thread.messages.filter((message) => message.seq < first) : [];
	return { messages: [...older, ...page.messages], hasMore: older.length ? thread.hasMore : page.hasMore };
}

/** The messages with one more in its place, or in place of the copy already there. */
function withMessage(messages: readonly MemberMessage[], message: MemberMessage): MemberMessage[] {
	const rest = messages.filter((item) => item.id !== message.id);
	const at = rest.findIndex((item) => item.seq > message.seq);
	return at < 0 ? [...rest, message] : [...rest.slice(0, at), message, ...rest.slice(at)];
}

function sendProblem(error: unknown): string {
	if (error instanceof CloudRpcError && error.denied) return t("You can no longer write to this member.");
	return t("Not sent. Check your connection and try again.");
}

export class MemberChats {
	readonly #host: MemberChatsHost;
	readonly #threads = new Map<string, Store<MemberChatThread>>();
	/** The newest read of each chat: an older answer never replaces a newer one. */
	readonly #reads = new Map<string, number>();
	/** Each chat's sends go one after the other, so they land in the order written. */
	readonly #sending = new Map<string, Promise<unknown>>();
	#listReads = 0;
	#open: string | undefined;
	#stopped = false;
	#hintTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(host: MemberChatsHost) {
		this.#host = host;
	}

	/** One chat's messages, draft and sends. Kept while the company is open, so a draft survives a look elsewhere. */
	thread(userId: string): Store<MemberChatThread> {
		const key = userId.toLowerCase();
		let store = this.#threads.get(key);
		if (!store) {
			store = new Store<MemberChatThread>(EMPTY);
			this.#threads.set(key, store);
		}
		return store;
	}

	/** The chat on screen, if any: it is read now, kept up to date, and marked read while someone looks. */
	setOpen(userId: string | undefined): void {
		const next = userId?.toLowerCase();
		if (next === this.#open) return;
		this.#open = next;
		if (next) void this.load(next);
	}

	get open(): string | undefined {
		return this.#open;
	}

	/** Messages waiting for this member, over all chats. */
	unread(): number {
		return Object.values(this.#host.summaries() ?? {}).reduce((sum, chat) => sum + chat.unread, 0);
	}

	/** The cloud said a chat of this member's changed: the list, and the open chat, are read again. Hints about one
	 * change arrive together (the message, then the read mark it moved). */
	hinted(): void {
		if (this.#stopped || this.#hintTimer) return;
		this.#hintTimer = setTimeout(() => {
			this.#hintTimer = undefined;
			void this.refresh();
			if (this.#open) void this.load(this.#open);
		}, 150);
	}

	/** Reads the list again. */
	async refresh(): Promise<void> {
		if (this.#stopped || !this.#host.available()) return;
		const version = ++this.#listReads;
		try {
			const chats = await this.#host.calls().list();
			if (this.#stopped || version !== this.#listReads) return;
			const next: Record<string, MemberChatSummary> = {};
			for (const chat of chats) {
				// The chat on screen, in front of someone, is read: its count never flashes up between the hint and the mark.
				const seen = chat.userId === this.#open && this.#host.visible() && this.thread(chat.userId).get().loaded;
				next[chat.userId] = seen ? { ...chat, unread: 0 } : chat;
			}
			this.#host.setSummaries(next);
			// A message that came while the open chat's own read was missed (no hint): read it now.
			const open = this.#open ? next[this.#open] : undefined;
			if (open?.last && this.#open) {
				const thread = this.thread(this.#open).get();
				const newest = thread.messages[thread.messages.length - 1];
				if (thread.loaded && !thread.loading && (!newest || newest.seq < open.last.seq)) void this.load(this.#open);
			}
		} catch (error) {
			if (this.#stopped || version !== this.#listReads) return;
			if (error instanceof CloudRpcError && error.missing) this.#host.setUnavailable();
		}
	}

	/** Reads the chat's newest messages and both read marks. */
	async load(userId: string): Promise<void> {
		const key = userId.toLowerCase();
		if (this.#stopped || !this.#host.available()) return;
		const store = this.thread(key);
		const version = (this.#reads.get(key) ?? 0) + 1;
		this.#reads.set(key, version);
		if (!store.get().loaded) store.set({ loading: true, error: undefined });
		try {
			const page = await this.#host.calls().read(key);
			if (this.#stopped || this.#reads.get(key) !== version) return;
			store.set((thread) => ({
				...withNewestPage(thread, page),
				loaded: true,
				loading: false,
				error: undefined,
				readSeq: Math.max(thread.readSeq, page.readSeq),
				theirReadSeq: Math.max(thread.theirReadSeq, page.theirReadSeq),
			}));
			this.seen();
		} catch (error) {
			if (this.#stopped || this.#reads.get(key) !== version) return;
			if (error instanceof CloudRpcError && error.missing) this.#host.setUnavailable();
			// A chat already on screen keeps what it shows; the next hint or the clock reads again.
			store.set((thread) => ({
				loading: false,
				error: thread.loaded
					? undefined
					: error instanceof CloudRpcError && error.denied
						? t("This chat is not available.")
						: t("Could not open this chat. Check your connection."),
			}));
		}
	}

	/** Reads the page before the oldest message shown. */
	async loadEarlier(userId: string): Promise<void> {
		const key = userId.toLowerCase();
		const store = this.thread(key);
		const thread = store.get();
		const first = thread.messages[0];
		if (this.#stopped || !this.#host.available() || !first || !thread.hasMore || thread.loadingEarlier) return;
		store.set({ loadingEarlier: true });
		try {
			const page = await this.#host.calls().read(key, first.seq);
			if (this.#stopped) return;
			store.set((now) => {
				// The chat started over meanwhile (a newer read did not reach these): this page no longer joins it.
				if (now.messages[0]?.seq !== first.seq) return { loadingEarlier: false };
				return { messages: [...page.messages, ...now.messages], hasMore: page.hasMore, loadingEarlier: false };
			});
		} catch {
			if (!this.#stopped) store.set({ loadingEarlier: false });
		}
	}

	setDraft(userId: string, draft: string): void {
		const store = this.thread(userId);
		if (store.get().draft !== draft) store.set({ draft });
	}

	/** Sends the words to the member. The message shows at once; false when there was nothing to send. */
	send(userId: string, text: string): boolean {
		const key = userId.toLowerCase();
		const body = text.trim();
		if (this.#stopped || !body || !this.#host.available()) return false;
		const store = this.thread(key);
		if (new TextEncoder().encode(body).length > MEMBER_MESSAGE_MAX_BYTES) {
			store.set({ notice: t("This message is too long to send. Send it in parts.") });
			return false;
		}
		const outgoing: OutgoingMemberMessage = {
			clientMessageId: crypto.randomUUID(),
			text: body,
			createdAt: new Date().toISOString(),
		};
		store.set((thread) => ({ outgoing: [...thread.outgoing, outgoing], draft: "", notice: undefined }));
		this.#deliver(key, outgoing.clientMessageId);
		return true;
	}

	/** Tries a message that was not sent once more: the same message, so one that did arrive is not sent twice. */
	retry(userId: string, clientMessageId: string): void {
		const key = userId.toLowerCase();
		const store = this.thread(key);
		if (
			this.#stopped ||
			!store.get().outgoing.some((item) => item.clientMessageId === clientMessageId && item.failed)
		)
			return;
		store.set((thread) => ({
			outgoing: thread.outgoing.map((item) =>
				item.clientMessageId === clientMessageId
					? { clientMessageId, text: item.text, createdAt: item.createdAt }
					: item,
			),
		}));
		this.#deliver(key, clientMessageId);
	}

	/** Drops a message that was not sent. */
	discard(userId: string, clientMessageId: string): void {
		this.thread(userId).set((thread) => ({
			outgoing: thread.outgoing.filter((item) => item.clientMessageId !== clientMessageId || !item.failed),
		}));
	}

	#deliver(key: string, clientMessageId: string): void {
		const store = this.thread(key);
		const run = async () => {
			const outgoing = store.get().outgoing.find((item) => item.clientMessageId === clientMessageId);
			if (this.#stopped || !outgoing || outgoing.failed) return;
			try {
				const message = await this.#host.calls().send(key, clientMessageId, outgoing.text);
				if (this.#stopped) return;
				store.set((thread) => ({
					outgoing: thread.outgoing.filter((item) => item.clientMessageId !== clientMessageId),
					messages: withMessage(thread.messages, message),
					// A member's own message moves their read mark to it, as the cloud does.
					readSeq: Math.max(thread.readSeq, message.seq),
				}));
				this.#summarize(key, (chat) => ({
					...chat,
					last: !chat.last || chat.last.seq <= message.seq ? message : chat.last,
					unread: 0,
					readSeq: Math.max(chat.readSeq, message.seq),
				}));
			} catch (error) {
				if (this.#stopped) return;
				store.set((thread) => ({
					outgoing: thread.outgoing.map((item) =>
						item.clientMessageId === clientMessageId ? { ...item, failed: sendProblem(error) } : item,
					),
				}));
			}
		};
		const queued = (this.#sending.get(key) ?? Promise.resolve()).then(run, run);
		this.#sending.set(key, queued);
	}

	/** Takes back a message of this member's own: its words go for both. */
	async remove(userId: string, messageId: string): Promise<void> {
		const key = userId.toLowerCase();
		const store = this.thread(key);
		if (this.#stopped || !this.#host.available()) return;
		try {
			const message = await this.#host.calls().remove(messageId);
			if (this.#stopped) return;
			store.set((thread) => ({ messages: withMessage(thread.messages, message), notice: undefined }));
			this.#summarize(key, (chat) => (chat.last?.id === message.id ? { ...chat, last: message } : chat));
		} catch {
			if (!this.#stopped) store.set({ notice: t("Could not delete the message. Try again.") });
		}
	}

	/** The open chat is in front of someone: what it shows is read. The rail's count goes at once; the cloud is told,
	 * and the other member then sees "Seen". */
	seen(): void {
		const key = this.#open;
		if (this.#stopped || !key || !this.#host.visible() || !this.#host.available()) return;
		const store = this.thread(key);
		const thread = store.get();
		const newest = thread.messages[thread.messages.length - 1];
		if (!thread.loaded || !newest) return;
		if (this.#host.summaries()?.[key]?.unread) this.#summarize(key, (chat) => ({ ...chat, unread: 0 }));
		if (newest.seq <= thread.readSeq) return;
		store.set({ readSeq: newest.seq });
		void this.#host
			.calls()
			.markRead(key, newest.seq)
			.then(
				(readSeq) => {
					if (!this.#stopped) store.set((now) => ({ readSeq: Math.max(now.readSeq, readSeq) }));
				},
				() => {
					// Not marked: the mark steps back, so the next look tries again, and the list says what is so.
					if (this.#stopped) return;
					store.set((now) => (now.readSeq === newest.seq ? { readSeq: thread.readSeq } : {}));
					void this.refresh();
				},
			);
	}

	#summarize(key: string, change: (chat: MemberChatSummary) => MemberChatSummary): void {
		const summaries = this.#host.summaries();
		const chat = summaries?.[key];
		if (!summaries || !chat) return;
		this.#host.setSummaries({ ...summaries, [key]: change(chat) });
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		clearTimeout(this.#hintTimer);
		queueMicrotask(() => {
			for (const store of this.#threads.values()) store.dispose();
		});
	}
}
