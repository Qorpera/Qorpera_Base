import { type Cloud, CloudRpcError, describeError } from "../cloud/client.ts";
import {
	MAIL_PAGE_SIZE,
	type MailAddress,
	type MailCursor,
	type MailDirection,
	type MailMessage,
	type MailMessageCursor,
	type MailThread,
	type MailThreadState,
	type MailThreadSummary,
	type MailWaitingItem,
	markMailThreadRead,
	readMailAddresses,
	readMailThread,
	readMailThreads,
	readMailWaiting,
} from "../cloud/mail.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { ActionReviewAnswer } from "../cloud/review-rules.ts";
import { type CompanyController, needsModelAccount } from "./company.ts";

/* The company's mail as this member reads it (Interfaces step I5c; the member mail read of step I5a, cloud/mail.ts),
 * for the Mailbox page and the `mail` and `mail_addresses` sources (RUNTIME-INTERFACES.md §4).
 *
 * The addresses and the sends that wait for a person are read when the company opens, again every minute while the
 * app is in front, and when it comes back to the front: the addresses say whether the company's mail is on (the `mail`
 * need), and the waiting sends are the Mailbox's badge. A page that draws mail says which lists and threads it shows
 * (`watch`), each time it draws; they are read once, and while that page stays on screen and the app is in front,
 * every 20 seconds and on coming back to the front, each list (its first page, and the older pages it shows) and each
 * open thread are read again.
 * The web has no change signal for mail or for a send's review card, so this poll is what keeps the page fresh.
 *
 * A thread opened is marked read once its read lands, and its list's unread mark goes when that mark lands. A thread
 * the cloud no longer has (22023) is gone. A read that fails keeps what was read before, and says so where nothing
 * was. A thread's older messages are read a page at a time when the member asks (`olderMessages`); the 20-second read
 * of its newest page keeps them, until the thread is closed, and reads back to them when more than a page came since. */

/** The lists a page can ask for: the threads call's own filters. */
export interface MailListRequest {
	readonly address?: string;
	readonly state?: MailThreadState;
	readonly direction?: MailDirection;
}

export interface MailList {
	readonly request: MailListRequest;
	/** Newest first, each thread once. */
	readonly threads: readonly MailThreadSummary[];
	/** Where older threads start; none once the last page is read. */
	readonly next?: MailCursor;
	/** How many pages are read: each read of the list reads as many again. */
	readonly pages: number;
	readonly status: "ready" | "error";
	readonly error?: string;
	readonly older: "idle" | "loading" | "error";
}

export type MailThreadRead =
	| {
			readonly status: "ready";
			/** Every message read, oldest first: the newest page, and the older pages the member asked for before it. Its
			 * `more` and `nextBefore` are the oldest page's. */
			readonly thread: MailThread;
			/** How many pages are read: a fresh newest page keeps the older ones and their cursor. */
			readonly pages: number;
			readonly older: "idle" | "loading" | "error";
	  }
	| { readonly status: "gone" }
	| { readonly status: "error"; readonly error: string };

export interface MailAnswer {
	readonly pending: boolean;
	readonly answered?: ActionReviewAnswer;
	readonly error?: string;
	/** The answer was refused for want of the member's model account, which the agent's thread lets them choose. */
	readonly needsAccount?: boolean;
}

/** The member's model accounts, as a conversation's thread reads them (views/session-execution.ts). */
export type MailAccounts = Pick<WebNativeSubscription, "listConnections" | "selectSessionAccount">;

export interface MailState {
	/** The company's addresses; none while its mail is off. */
	readonly addresses: readonly MailAddress[];
	readonly waiting: readonly MailWaitingItem[];
	/** By `mailListKey`. A list not here is still being read. */
	readonly lists: Readonly<Record<string, MailList>>;
	/** By thread id. A thread not here is still being read. */
	readonly threads: Readonly<Record<string, MailThreadRead>>;
	/** A waiting send's answer on its way, given or refused, by review id. */
	readonly answers: Readonly<Record<string, MailAnswer>>;
}

export function mailListKey(request: MailListRequest): string {
	return JSON.stringify([request.address ?? null, request.state ?? null, request.direction ?? null]);
}

const COMPANY_POLL_MS = 60_000;
const PAGE_POLL_MS = 20_000;

const EMPTY: MailState = { addresses: [], waiting: [], lists: {}, threads: {}, answers: {} };

const readers = new WeakMap<CompanyController, CompanyMail>();

/** A message's place in its thread, as the thread call names it. */
const messageKey = (message: MailMessage) => `${message.kind}:${message.id}`;

function sameCursor(a: MailMessageCursor | undefined, b: MailMessageCursor): boolean {
	return a?.at === b.at && a.kind === b.kind && a.id === b.id;
}

/** Whether the call reports the thread is not the company's, or not a thread at all. */
function threadGone(error: unknown): boolean {
	return error instanceof CloudRpcError && error.code === "22023";
}

export class CompanyMail {
	/** The reader of a company's mail, while one is open. */
	static of(company: CompanyController): CompanyMail | undefined {
		return readers.get(company);
	}

	readonly #company: CompanyController;
	readonly #cloud: Cloud;
	readonly #accounts: MailAccounts;
	readonly #publish: (state: MailState) => void;
	#state: MailState | undefined;
	#disposed = false;
	#companyTimer: ReturnType<typeof setInterval> | undefined;
	#pageTimer: ReturnType<typeof setInterval> | undefined;
	#reading = new Set<string>();
	#watched: { lists: Map<string, MailListRequest>; threads: Set<string>; shown: () => boolean } = {
		lists: new Map(),
		threads: new Set(),
		shown: () => false,
	};
	/** The threads marked read while open, so a mark is sent once per opening unless newer mail arrives. */
	#marked = new Set<string>();

	constructor(company: CompanyController, cloud: Cloud, accounts: MailAccounts, publish: (state: MailState) => void) {
		this.#company = company;
		this.#cloud = cloud;
		this.#accounts = accounts;
		this.#publish = publish;
		readers.set(company, this);
	}

	get #environmentId(): string {
		return this.#company.profile.environmentId;
	}

	get #closed(): boolean {
		return this.#disposed || this.#company.signal.aborted;
	}

	readonly #onFront = () => {
		if (document.visibilityState !== "visible") return;
		void this.#refreshCompany();
		if (this.#watched.shown()) void this.#refreshPage();
	};

	/** Reads the addresses and the waiting sends, and follows them. */
	async open(): Promise<void> {
		window.addEventListener("focus", this.#onFront);
		document.addEventListener("visibilitychange", this.#onFront);
		this.#companyTimer = setInterval(() => {
			if (document.visibilityState === "visible") void this.#refreshCompany();
		}, COMPANY_POLL_MS);
		await this.#refreshCompany();
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#companyTimer);
		clearInterval(this.#pageTimer);
		window.removeEventListener("focus", this.#onFront);
		document.removeEventListener("visibilitychange", this.#onFront);
		if (readers.get(this.#company) === this) readers.delete(this.#company);
	}

	#set(change: (state: MailState) => MailState): void {
		if (this.#closed) return;
		this.#state = change(this.#state ?? EMPTY);
		this.#publish(this.#state);
	}

	/** Runs one read of `name` at a time. */
	async #once(name: string, read: () => Promise<void>): Promise<void> {
		if (this.#reading.has(name) || this.#closed) return;
		this.#reading.add(name);
		try {
			await read();
		} finally {
			this.#reading.delete(name);
		}
	}

	async #refreshCompany(): Promise<void> {
		await Promise.all([
			this.#once("addresses", async () => {
				try {
					const addresses = await readMailAddresses(this.#cloud, this.#environmentId);
					this.#set((state) => ({ ...state, addresses }));
				} catch (error) {
					// A cloud without the member mail read has no mail to show; another failure keeps what was read.
					if (error instanceof CloudRpcError && (error.missing || error.denied))
						this.#set((state) => ({ ...state, addresses: [] }));
				}
			}),
			this.#once("waiting", async () => {
				try {
					const waiting = await readMailWaiting(this.#cloud, this.#environmentId);
					this.#set((state) => ({ ...state, waiting }));
				} catch {
					// The badge keeps its last count.
				}
			}),
		]);
	}

	/** What a page draws now: its lists and its open threads. Called as it draws; reads start after the draw, and the
	 * threads it no longer has open are let go. */
	watch(requests: readonly MailListRequest[], threads: readonly string[], shown: () => boolean): void {
		if (this.#closed) return;
		const lists = new Map(requests.map((request) => [mailListKey(request), request]));
		const opened = new Set(threads);
		// A list or a thread drawn now, and not on the last draw, is read again (and a thread marked read), even when it
		// was read before: coming back to a view shows its list as it is.
		const was = this.#watched;
		const freshLists = new Set([...lists.keys()].filter((key) => !was.lists.has(key)));
		const fresh = new Set([...opened].filter((thread) => !was.threads.has(thread)));
		for (const thread of this.#marked) if (!opened.has(thread)) this.#marked.delete(thread);
		this.#watched = { lists, threads: opened, shown };
		if (!this.#pageTimer && (lists.size > 0 || opened.size > 0))
			this.#pageTimer = setInterval(() => {
				if (!this.#watched.shown()) {
					clearInterval(this.#pageTimer);
					this.#pageTimer = undefined;
					this.#watched = { lists: new Map(), threads: new Set(), shown: () => false };
					return;
				}
				if (document.visibilityState === "visible") void this.#refreshPage();
			}, PAGE_POLL_MS);
		queueMicrotask(() => {
			const state = this.#state ?? EMPTY;
			for (const [key, request] of lists)
				if (freshLists.has(key) || !state.lists[key]) void this.#readFirst(key, request);
			for (const thread of opened) if (fresh.has(thread) || !state.threads[thread]) void this.#readThread(thread);
			// A closed thread's read is let go: opening it again reads it again anyway.
			const open = this.#watched.threads;
			if (Object.keys(state.threads).some((thread) => !open.has(thread)))
				this.#set((now) => ({
					...now,
					threads: Object.fromEntries(Object.entries(now.threads).filter(([thread]) => open.has(thread))),
				}));
		});
	}

	async #refreshPage(): Promise<void> {
		const { lists, threads } = this.#watched;
		await Promise.all([...lists].map(([key, request]) => this.#readFirst(key, request)));
		await Promise.all([...threads].map((thread) => this.#readThread(thread)));
	}

	/** Reads a list's first page, and as many pages after it as the list shows, each from where the one before ends: a
	 * thread whose newest message went the other way, or whose state changed, leaves a filtered list on screen too. */
	#readFirst(key: string, request: MailListRequest): Promise<void> {
		return this.#once(`list:${key}`, async () => {
			try {
				const drawn = this.#state?.lists[key];
				const shown = drawn?.status === "ready" ? Math.max(drawn.pages, 1) : 1;
				let page = await readMailThreads(this.#cloud, this.#environmentId, { ...request, limit: MAIL_PAGE_SIZE });
				const read = [...page.threads];
				let pages = 1;
				while (pages < shown && page.nextBefore) {
					page = await readMailThreads(this.#cloud, this.#environmentId, {
						...request,
						before: page.nextBefore,
						limit: MAIL_PAGE_SIZE,
					});
					read.push(...page.threads);
					pages += 1;
				}
				const next = page.nextBefore;
				const opened = this.#watched.threads;
				// Newer mail in a thread the member has open is read with it, and marked read again.
				const arrived = read.filter((item) => item.unread && opened.has(item.thread));
				for (const item of arrived) this.#marked.delete(item.thread);
				this.#set((state) => {
					const was = state.lists[key];
					// Show older landed while these pages were read: the list stays as it is, and its next read reads that
					// page too.
					if (was?.status === "ready" && was.pages > shown) return state;
					const seen = new Set<string>();
					const threads: MailThreadSummary[] = [];
					for (const item of read) {
						if (seen.has(item.thread)) continue;
						seen.add(item.thread);
						threads.push(opened.has(item.thread) ? { ...item, unread: false } : item);
					}
					const list: MailList = {
						request,
						threads,
						...(next ? { next } : {}),
						pages,
						status: "ready",
						older: was?.older === "loading" ? "loading" : "idle",
					};
					return { ...state, lists: { ...state.lists, [key]: list } };
				});
				for (const item of arrived) void this.#readThread(item.thread);
			} catch (error) {
				this.#set((state) => {
					const was = state.lists[key];
					// A list already drawn stays as it was; one never read says why.
					if (was?.status === "ready") return state;
					const list: MailList = {
						request,
						threads: [],
						pages: 0,
						status: "error",
						error: describeError(error),
						older: "idle",
					};
					return { ...state, lists: { ...state.lists, [key]: list } };
				});
			}
		});
	}

	/** Reads the next page of a list after the threads it shows. */
	older(key: string): void {
		const list = this.#state?.lists[key];
		const before = list?.next;
		if (!list || !before || list.older === "loading") return;
		const mark = (older: MailList["older"]) =>
			this.#set((state) => {
				const now = state.lists[key];
				return now ? { ...state, lists: { ...state.lists, [key]: { ...now, older } } } : state;
			});
		mark("loading");
		void this.#once(`older:${key}`, async () => {
			try {
				const page = await readMailThreads(this.#cloud, this.#environmentId, {
					...list.request,
					before,
					limit: MAIL_PAGE_SIZE,
				});
				this.#set((state) => {
					const now = state.lists[key];
					if (!now) return state;
					// A first page that landed meanwhile moved where older threads start: this page no longer follows the
					// list, so it is dropped, and Show older reads from there.
					if (now.next?.lastAt !== before.lastAt || now.next.thread !== before.thread)
						return { ...state, lists: { ...state.lists, [key]: { ...now, older: "idle" } } };
					const seen = new Set(now.threads.map((item) => item.thread));
					const added = page.threads.filter((item) => !seen.has(item.thread));
					const { next: _next, ...rest } = now;
					const grown: MailList = {
						...rest,
						threads: [...now.threads, ...added],
						...(page.nextBefore ? { next: page.nextBefore } : {}),
						pages: now.pages + 1,
						older: "idle",
					};
					return { ...state, lists: { ...state.lists, [key]: grown } };
				});
			} catch {
				mark("error");
			}
		});
	}

	/** Reads a list again after its read failed. */
	retry(key: string): void {
		const list = this.#state?.lists[key];
		if (list) void this.#readFirst(key, list.request);
	}

	/** Reads a thread's next page of older messages, before the ones it shows. */
	olderMessages(thread: string): void {
		const read = this.#state?.threads[thread];
		if (read?.status !== "ready") return;
		const before = read.thread.nextBefore;
		if (!before || read.older === "loading") return;
		const mark = (older: "idle" | "loading" | "error") =>
			this.#set((state) => {
				const now = state.threads[thread];
				return now?.status === "ready"
					? { ...state, threads: { ...state.threads, [thread]: { ...now, older } } }
					: state;
			});
		mark("loading");
		void this.#once(`older-messages:${thread}`, async () => {
			try {
				const page = await readMailThread(this.#cloud, this.#environmentId, thread, before);
				this.#set((state) => {
					const now = state.threads[thread];
					if (now?.status !== "ready") return state;
					// A newest page that landed meanwhile moved where older messages start (newer mail pushed it): this page
					// no longer follows the thread, so it is dropped, and Show older messages reads from there.
					if (!sameCursor(now.thread.nextBefore, before))
						return { ...state, threads: { ...state.threads, [thread]: { ...now, older: "idle" } } };
					const shown = new Set(now.thread.messages.map(messageKey));
					const { nextBefore: _next, ...rest } = now.thread;
					const grown: MailThreadRead = {
						...now,
						thread: {
							...rest,
							messages: [
								...page.messages.filter((message) => !shown.has(messageKey(message))),
								...rest.messages,
							],
							more: page.more,
							...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
						},
						pages: now.pages + 1,
						older: "idle",
					};
					return { ...state, threads: { ...state.threads, [thread]: grown } };
				});
			} catch {
				mark("error");
			}
		});
	}

	/** Reads a thread again after its read failed. */
	retryThread(thread: string): void {
		void this.#readThread(thread);
	}

	#readThread(thread: string): Promise<void> {
		return this.#once(`thread:${thread}`, async () => {
			let read: MailThread;
			let pages = 1;
			try {
				read = await readMailThread(this.#cloud, this.#environmentId, thread);
				// With older pages kept, more than a page of mail may have come since the last read: the pages before the
				// newest are read too, back to the newest message shown, so the kept ones still follow on with none between.
				const shown = this.#state?.threads[thread];
				const upTo = shown?.status === "ready" && shown.pages > 1 ? shown.thread.messages.at(-1) : undefined;
				const reaches = (messages: readonly MailMessage[]) =>
					upTo === undefined || messages.some((message) => messageKey(message) === messageKey(upTo));
				while (read.thread !== undefined && read.nextBefore && !reaches(read.messages)) {
					const page = await readMailThread(this.#cloud, this.#environmentId, thread, read.nextBefore);
					if (page.thread === undefined) {
						read = page;
						break;
					}
					const { nextBefore: _before, ...rest } = read;
					read = {
						...rest,
						messages: [...page.messages, ...read.messages],
						more: page.more,
						...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
					};
					pages += 1;
				}
			} catch (error) {
				const gone = threadGone(error);
				this.#set((state) => {
					// A thread drawn stays as it was through a failed read again, unless it is gone.
					if (!gone && state.threads[thread]?.status === "ready") return state;
					const found: MailThreadRead = gone
						? { status: "gone" }
						: { status: "error", error: describeError(error) };
					return { ...state, threads: { ...state.threads, [thread]: found } };
				});
				return;
			}
			// While the company's mail is off the call answers with no thread.
			if (read.thread === undefined) {
				this.#set((state) => ({ ...state, threads: { ...state.threads, [thread]: { status: "gone" } } }));
				return;
			}
			this.#set((state) => {
				const was = state.threads[thread];
				// Older pages are kept only while the fresh pages reach the newest message they show.
				const last = was?.status === "ready" ? was.thread.messages.at(-1) : undefined;
				const joins =
					last !== undefined && read.messages.some((message) => messageKey(message) === messageKey(last));
				if (was?.status !== "ready" || was.pages < 2 || !joins) {
					const found: MailThreadRead = {
						status: "ready",
						thread: read,
						pages,
						older: was?.status === "ready" && was.older === "loading" ? "loading" : "idle",
					};
					return { ...state, threads: { ...state.threads, [thread]: found } };
				}
				// Older pages were read: they stay before the fresh pages, with the messages newer mail pushed out of them,
				// and so does where the next older page starts.
				const fresh = new Set(read.messages.map(messageKey));
				const kept = was.thread.messages.filter((message) => !fresh.has(messageKey(message)));
				const { nextBefore: _next, ...newest } = read;
				const found: MailThreadRead = {
					...was,
					pages: was.pages + pages - 1,
					thread: {
						...newest,
						messages: [...kept, ...read.messages],
						more: was.thread.more,
						...(was.thread.nextBefore ? { nextBefore: was.thread.nextBefore } : {}),
					},
				};
				return { ...state, threads: { ...state.threads, [thread]: found } };
			});
			if (this.#watched.threads.has(thread) && !this.#marked.has(thread)) await this.#markRead(thread);
		});
	}

	async #markRead(thread: string): Promise<void> {
		this.#marked.add(thread);
		try {
			await markMailThreadRead(this.#cloud, this.#environmentId, thread);
		} catch (error) {
			this.#marked.delete(thread);
			if (threadGone(error))
				this.#set((state) => ({ ...state, threads: { ...state.threads, [thread]: { status: "gone" } } }));
			// Otherwise its unread mark stays; the next read of the thread tries again.
			return;
		}
		this.#set((state) => {
			const lists = Object.fromEntries(
				Object.entries(state.lists).map(([key, list]) => [
					key,
					list.threads.some((item) => item.thread === thread && item.unread)
						? {
								...list,
								threads: list.threads.map((item) =>
									item.thread === thread ? { ...item, unread: false } : item,
								),
							}
						: list,
				]),
			);
			return { ...state, lists };
		});
	}

	/** Answers a waiting send through the card of the conversation it was raised in (`company.answerActionReview`,
	 * which says on that conversation why an answer is refused). An answer wakes the agent on the member's model
	 * account once the agent no longer waits for it, so the conversation's account is chosen first, as its thread
	 * chooses it. The thread, its lists and the waiting sends are then read again. */
	async answer(thread: string, sessionId: string, reviewId: string, answer: ActionReviewAnswer): Promise<void> {
		if (this.#state?.answers[reviewId]?.pending) return;
		const set = (given: MailAnswer) =>
			this.#set((state) => ({ ...state, answers: { ...state.answers, [reviewId]: given } }));
		set({ pending: true });
		await this.#chooseAccount(sessionId);
		try {
			await this.#company.answerActionReview(sessionId, reviewId, answer);
		} catch (error) {
			const said = this.#company.conversation(sessionId, false).get().interactionError;
			set({
				pending: false,
				error: said ?? describeError(error),
				...(needsModelAccount(error) ? { needsAccount: true } : {}),
			});
			void this.#readThread(thread);
			return;
		}
		set({ pending: false, answered: answer });
		await Promise.all([
			this.#readThread(thread),
			this.#refreshCompany(),
			...[...this.#watched.lists].map(([key, request]) => this.#readFirst(key, request)),
		]);
	}

	/** Gives the conversation the model account the cloud chooses for it, as its thread does when it opens
	 * (views/session-execution.ts): the conversation's own account, never another one (founder decision 2026-10-04).
	 * A conversation with a message on its way keeps the account that message carries, and one the cloud has no
	 * account for keeps what it has. While the agent still waits, its answer needs no account, so a choice that fails
	 * only leaves the answer to say whether it needed one. */
	async #chooseAccount(sessionId: string): Promise<void> {
		const conversation = this.#company.conversation(sessionId, false).get();
		if (conversation.sending || conversation.retrySend || !this.#accounts.selectSessionAccount) return;
		const signal = this.#company.signal;
		try {
			const connectionId = await this.#accounts.selectSessionAccount(sessionId, signal);
			if (!connectionId) return;
			const observed = await this.#accounts.listConnections(signal);
			const now = this.#company.conversation(sessionId, false).get();
			if (now.sending || now.retrySend) return;
			this.#company.setExecutionSponsor(sessionId, observed, connectionId);
		} catch {
			// The answer still goes.
		}
	}
}
