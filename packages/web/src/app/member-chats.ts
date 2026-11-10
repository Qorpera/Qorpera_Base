import { CloudRpcError } from "../cloud/client.ts";
import {
	MEMBER_CHAT_PAGE,
	MEMBER_CHAT_READ_MAX,
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
 * member: unread, last online, the newest message) is the company's state, read on every hint and on the clock. A
 * message shows at once and is sent behind it; one that could not be sent stays, to be sent again or dropped.
 *
 * The messages a chat shows are always one whole run of it, from the oldest one shown to its newest, and every read
 * brings that whole run again (on a hint, on the clock, after a send): a message taken back, however old, loses its
 * words, and no hole ever stands between two messages. Nothing but a read puts a message among them: a sent message
 * waits after them until a read brings it, and one taken back changes only where it already stands. A chat off screen
 * keeps its draft and what is still to send, not its messages: it is read whole when it opens again. */

/** A message this browser wrote: on its way, refused, or sent and not yet in a read of the chat. */
export interface OutgoingMemberMessage {
	readonly clientMessageId: string;
	readonly text: string;
	readonly createdAt: string;
	/** Why it was not sent. It stays until it is sent again or dropped. */
	readonly failed?: string;
	/** Sent: the place the cloud gave it. It stands here, after the chat's messages, until a read of the chat reaches
	 * that place: the messages themselves only ever come from a read, so nothing is put among them by guess. */
	readonly seq?: number;
}

export interface MemberChatThread {
	/** Oldest first: one whole run of the chat, up to its newest message. */
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

/** How many reads one refresh of a chat may take to reach the oldest message shown (2,000 messages). Past that the
 * chat starts at what was read: it shows less, never a hole. */
const RUN_READS = 10;

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

	/** The chat on screen, if any: it is read now, kept up to date, and marked read while someone looks. The chat that
	 * leaves the screen keeps its draft and what is still to send, and lets its messages go: what it shows when it
	 * opens again is read then, so nothing taken back meanwhile is ever shown. */
	setOpen(userId: string | undefined): void {
		const next = userId?.toLowerCase();
		if (next === this.#open) return;
		const previous = this.#open;
		this.#open = next;
		if (previous) {
			// A read of it still on its way is not waited for.
			this.#reads.set(previous, (this.#reads.get(previous) ?? 0) + 1);
			this.thread(previous).set({
				messages: [],
				hasMore: false,
				loaded: false,
				loading: false,
				loadingEarlier: false,
				error: undefined,
			});
		}
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
			void this.poll();
		}, 150);
	}

	/** The clock's read, and a hint's: the list, and the open chat whole. A hint can be missed (and a browser that
	 * listens the old way gets none), so whatever a hint would have brought (a new message, one taken back, the other
	 * member's look) shows no later than the next turn of the clock. */
	async poll(): Promise<void> {
		await Promise.all([this.refresh(), this.#open ? this.load(this.#open) : undefined]);
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
			// The list's read marks are newer than a chat's own, or as new: "Seen" follows them without a read of the chat.
			for (const chat of chats) {
				const store = this.#threads.get(chat.userId);
				const thread = store?.get();
				if (store && thread && (chat.readSeq > thread.readSeq || chat.theirReadSeq > thread.theirReadSeq))
					store.set({
						readSeq: Math.max(thread.readSeq, chat.readSeq),
						theirReadSeq: Math.max(thread.theirReadSeq, chat.theirReadSeq),
					});
			}
		} catch (error) {
			if (this.#stopped || version !== this.#listReads) return;
			if (error instanceof CloudRpcError && error.missing) this.#host.setUnavailable();
		}
	}

	/** One whole run of the chat, read now: its newest messages back to `floor`, the oldest message shown, or its
	 * newest page when nothing is shown yet. The first read asks for what is shown and a little more; when more than
	 * that is new it reads on backwards until it reaches `floor`, so the run has no hole. */
	async #run(key: string, shown: number, floor: number | undefined): Promise<MemberChatPage> {
		const calls = this.#host.calls();
		const newest = await calls.read(
			key,
			undefined,
			floor === undefined ? MEMBER_CHAT_PAGE : Math.min(MEMBER_CHAT_READ_MAX, shown + 10),
		);
		let messages = newest.messages;
		let hasMore = newest.hasMore;
		for (let reads = 1; floor !== undefined && hasMore && reads < RUN_READS; reads++) {
			const first = messages[0];
			if (!first || first.seq <= floor) break;
			const earlier = await calls.read(key, first.seq, MEMBER_CHAT_READ_MAX);
			messages = [...earlier.messages, ...messages];
			hasMore = earlier.hasMore && earlier.messages.length > 0;
		}
		// No further back than what was shown: the chat keeps its place, and "Show earlier messages" its meaning.
		const run = floor === undefined ? messages : messages.filter((message) => message.seq >= floor);
		return { ...newest, messages: run, hasMore: hasMore || run.length < messages.length };
	}

	/** Reads the chat again, whole: every message it shows (or its newest page, when it shows none yet) and both read
	 * marks. What it showed is replaced, never added to. */
	async load(userId: string): Promise<void> {
		const key = userId.toLowerCase();
		if (this.#stopped || !this.#host.available()) return;
		const store = this.thread(key);
		const version = (this.#reads.get(key) ?? 0) + 1;
		this.#reads.set(key, version);
		const before = store.get();
		if (!before.loaded) store.set({ loading: true, error: undefined });
		const floor = before.loaded ? before.messages[0]?.seq : undefined;
		try {
			const run = await this.#run(key, before.messages.length, floor);
			if (this.#stopped || this.#reads.get(key) !== version) return;
			store.set((thread) => {
				// Earlier messages read in meanwhile ("Show earlier messages") end right where this run starts, when it
				// starts at the oldest message that was shown: then they stay. A run that did not reach that far back
				// (more was new than it reads in one go) starts the chat over: joined, the two would leave a hole.
				const reaches = floor !== undefined && run.messages[0]?.seq === floor;
				const earlier = reaches ? thread.messages.filter((message) => message.seq < floor) : [];
				const newest = run.messages[run.messages.length - 1]?.seq ?? 0;
				return {
					messages: [...earlier, ...run.messages],
					hasMore: earlier.length ? thread.hasMore : run.hasMore,
					loaded: true,
					loading: false,
					error: undefined,
					readSeq: Math.max(thread.readSeq, run.readSeq),
					theirReadSeq: Math.max(thread.theirReadSeq, run.theirReadSeq),
					// A sent message whose place this run reaches is among the messages now (or stands before the
					// oldest one shown): it no longer waits after them.
					outgoing: thread.outgoing.filter((item) => item.seq === undefined || item.seq > newest),
				};
			});
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
				// The chat left the screen or starts elsewhere now: this page no longer joins it.
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
			if (this.#stopped || !outgoing || outgoing.failed || outgoing.seq !== undefined) return;
			try {
				const message = await this.#host.calls().send(key, clientMessageId, outgoing.text);
				if (this.#stopped) return;
				// Sent. It keeps its place after the chat's messages until a read brings it among them.
				store.set((thread) => ({
					outgoing: thread.outgoing.map((item) =>
						item.clientMessageId === clientMessageId ? { ...item, seq: message.seq } : item,
					),
				}));
				// The chat is read whole again: the message takes its place among the others, after whatever came since
				// the last read. A chat off screen is read when it opens.
				if (this.#open === key) void this.load(key);
				this.#summarize(key, (chat) => ({
					...chat,
					last: !chat.last || chat.last.seq <= message.seq ? message : chat.last,
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
			// Only where it stands among the messages shown: an answer that comes after the chat was opened again
			// further down puts nothing above them.
			store.set((thread) => ({
				messages: thread.messages.map((item) => (item.id === message.id ? message : item)),
				notice: undefined,
			}));
			this.#summarize(key, (chat) => (chat.last?.id === message.id ? { ...chat, last: message } : chat));
		} catch {
			if (!this.#stopped) store.set({ notice: t("Could not delete the message. Try again.") });
		}
	}

	/** The open chat is in front of someone: what it shows is read. The rail's count goes at once; the cloud is told,
	 * and the other member then sees "Seen". Only the other member's messages need a mark: this member's own are never
	 * unread to them, and writing moves no mark. */
	seen(): void {
		const key = this.#open;
		if (this.#stopped || !key || !this.#host.visible() || !this.#host.available()) return;
		const store = this.thread(key);
		const thread = store.get();
		const newest = thread.messages[thread.messages.length - 1];
		if (!thread.loaded || !newest) return;
		if (this.#host.summaries()?.[key]?.unread) this.#summarize(key, (chat) => ({ ...chat, unread: 0 }));
		const me = this.#host.userId;
		if (!thread.messages.some((message) => message.authorUserId !== me && message.seq > thread.readSeq)) return;
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
