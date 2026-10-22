import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import { type Cloud, CloudRpcError, describeError } from "../cloud/client.ts";
import {
	DIGITAL_POST_INDEX_MAX_BYTES,
	DIGITAL_POST_INDEX_PATH,
	DIGITAL_POST_LETTER_MAX_BYTES,
	type DigitalPostConnection,
	type DigitalPostLetter,
	type DigitalPostLetterText,
	parseDigitalPostLetters,
	parseDigitalPostLetterText,
	readDigitalPost,
} from "../cloud/digital-post.ts";
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
import { t } from "../ui/preferences.ts";
import { type CompanyController, needsModelAccount } from "./company.ts";
import type { QuotedText } from "./quotes.ts";

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
 * of its newest page keeps them, until the thread is closed, and reads back to them when more than a page came since.
 *
 * The company's Digital Post (deploy/first-node/RUNTIME-DIGITAL-POST.md) is read with the addresses: the connection's
 * state, and, once there is one, the letters the folder's index lists (digital-post/letters.json, read again only when
 * its version changed). A letter a page has open is read from its `letter.md`, again on the page's 20-second read. Both
 * are files of the company folder, read with the member's own access. */

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

/** A letter's `letter.md` as the Mailbox reads it. */
export type DigitalPostLetterRead =
	| { readonly status: "ready"; readonly letter: DigitalPostLetterText }
	| { readonly status: "gone" }
	/** Longer than the Mailbox shows: it opens from its folder. */
	| { readonly status: "large" }
	| { readonly status: "error"; readonly error: string };

/** The company's Digital Post, as the Mailbox shows it. */
export interface DigitalPostState {
	/** The connection's state; unset until read, and on a cloud without the call. */
	readonly connection?: DigitalPostConnection;
	/** The letters the folder holds, newest first. */
	readonly letters: readonly DigitalPostLetter[];
	/** The open letters' texts, by folder. A letter not here is still being read. */
	readonly open: Readonly<Record<string, DigitalPostLetterRead>>;
}

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
	/** Unset until the controller first reads it. */
	readonly digitalPost?: DigitalPostState;
}

const NO_DIGITAL_POST: DigitalPostState = { letters: [], open: {} };

/** The company's Digital Post as last read: none before the first read. */
export function digitalPostOf(mail: MailState | undefined): DigitalPostState {
	return mail?.digitalPost ?? NO_DIGITAL_POST;
}

/** Whether the company has mail to show: an email address, or Digital Post connected or holding letters. */
export function mailShown(mail: MailState | undefined): boolean {
	if (!mail) return false;
	const post = digitalPostOf(mail);
	return mail.addresses.length > 0 || post.connection?.connected === true || post.letters.length > 0;
}

/** The member's own folder client: the company's Digital Post letters are files of its folder. */
export type MailFolder = (signal: AbortSignal) => Pick<CloudMemberFolderClient, "read" | "readFile">;

export function mailListKey(request: MailListRequest): string {
	return JSON.stringify([request.address ?? null, request.state ?? null, request.direction ?? null]);
}

const COMPANY_POLL_MS = 60_000;
const PAGE_POLL_MS = 20_000;

const EMPTY: MailState = {
	addresses: [],
	waiting: [],
	lists: {},
	threads: {},
	answers: {},
	digitalPost: NO_DIGITAL_POST,
};

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
	readonly #folder: MailFolder | undefined;
	#state: MailState | undefined;
	/** The version of the letters index last read: it is read again only when it changed. */
	#indexVersion: string | undefined;
	#disposed = false;
	#companyTimer: ReturnType<typeof setInterval> | undefined;
	#pageTimer: ReturnType<typeof setInterval> | undefined;
	#reading = new Set<string>();
	#watched: {
		lists: Map<string, MailListRequest>;
		threads: Set<string>;
		letters: Set<string>;
		shown: () => boolean;
	} = {
		lists: new Map(),
		threads: new Set(),
		letters: new Set(),
		shown: () => false,
	};
	/** The threads marked read while open, so a mark is sent once per opening unless newer mail arrives. */
	#marked = new Set<string>();

	constructor(
		company: CompanyController,
		cloud: Cloud,
		accounts: MailAccounts,
		publish: (state: MailState) => void,
		folder?: MailFolder,
	) {
		this.#company = company;
		this.#cloud = cloud;
		this.#accounts = accounts;
		this.#publish = publish;
		this.#folder = folder;
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
			this.#readDigitalPost(),
		]);
	}

	/** The Digital Post connection, then the letters index when there may be letters. */
	#readDigitalPost(): Promise<void> {
		return this.#once("digital-post", async () => {
			let connection: DigitalPostConnection;
			try {
				connection = await readDigitalPost(this.#cloud, this.#environmentId);
			} catch {
				// A cloud without the call has no Digital Post; another failure keeps what was read.
				return;
			}
			this.#set((state) => ({ ...state, digitalPost: { ...digitalPostOf(state), connection } }));
			if (connection.connected || connection.letters > 0) await this.#readIndex();
		});
	}

	/** The letters the folder's index lists, read again only when its version changed. */
	async #readIndex(): Promise<void> {
		if (!this.#folder || this.#closed) return;
		try {
			const signal = AbortSignal.any([this.#company.signal, AbortSignal.timeout(30_000)]);
			const folder = this.#folder(signal);
			const read = await folder.read(DIGITAL_POST_INDEX_PATH, signal);
			const file = read.entry?.kind === "file" ? read.entry.file : null;
			if (!read.entry || !file || file.bytes > DIGITAL_POST_INDEX_MAX_BYTES) {
				this.#indexVersion = undefined;
				this.#set((state) => ({ ...state, digitalPost: { ...digitalPostOf(state), letters: [] } }));
				return;
			}
			if (read.entry.version === this.#indexVersion) return;
			const bytes = await folder.readFile(file, signal, DIGITAL_POST_INDEX_MAX_BYTES);
			const letters = parseDigitalPostLetters(new TextDecoder().decode(bytes));
			this.#indexVersion = read.entry.version;
			this.#set((state) => ({ ...state, digitalPost: { ...digitalPostOf(state), letters } }));
		} catch {
			// The list keeps what was read before.
		}
	}

	/** An open letter's `letter.md`. */
	#readLetter(folderPath: string): Promise<void> {
		return this.#once(`letter:${folderPath}`, async () => {
			if (!this.#folder) return;
			const put = (read: DigitalPostLetterRead) =>
				this.#set((state) =>
					this.#watched.letters.has(folderPath)
						? {
								...state,
								digitalPost: {
									...digitalPostOf(state),
									open: { ...digitalPostOf(state).open, [folderPath]: read },
								},
							}
						: state,
				);
			try {
				const signal = AbortSignal.any([this.#company.signal, AbortSignal.timeout(30_000)]);
				const folder = this.#folder(signal);
				const read = await folder.read(`${folderPath}/letter.md`, signal);
				const file = read.entry?.kind === "file" ? read.entry.file : null;
				if (!file) {
					put({ status: "gone" });
					return;
				}
				if (file.bytes > DIGITAL_POST_LETTER_MAX_BYTES) {
					put({ status: "large" });
					return;
				}
				const bytes = await folder.readFile(file, signal, DIGITAL_POST_LETTER_MAX_BYTES);
				put({ status: "ready", letter: parseDigitalPostLetterText(new TextDecoder().decode(bytes)) });
			} catch (error) {
				// A letter already shown stays as it was; one never read says why.
				const was = this.#state?.digitalPost?.open[folderPath];
				if (was?.status !== "ready") put({ status: "error", error: describeError(error) });
			}
		});
	}

	/** What a page draws now: its lists, its open threads and its open Digital Post letters (by folder). Called as it
	 * draws; reads start after the draw, and the threads and letters it no longer has open are let go. */
	watch(
		requests: readonly MailListRequest[],
		threads: readonly string[],
		shown: () => boolean,
		letters: readonly string[] = [],
	): void {
		if (this.#closed) return;
		const lists = new Map(requests.map((request) => [mailListKey(request), request]));
		const opened = new Set(threads);
		const openLetters = new Set(letters);
		const freshLetters = [...openLetters].filter((letter) => !this.#watched.letters.has(letter));
		// A list or a thread drawn now, and not on the last draw, is read again (and a thread marked read), even when it
		// was read before: coming back to a view shows its list as it is.
		const was = this.#watched;
		const freshLists = new Set([...lists.keys()].filter((key) => !was.lists.has(key)));
		const fresh = new Set([...opened].filter((thread) => !was.threads.has(thread)));
		for (const thread of this.#marked) if (!opened.has(thread)) this.#marked.delete(thread);
		this.#watched = { lists, threads: opened, letters: openLetters, shown };
		if (!this.#pageTimer && (lists.size > 0 || opened.size > 0 || openLetters.size > 0))
			this.#pageTimer = setInterval(() => {
				if (!this.#watched.shown()) {
					clearInterval(this.#pageTimer);
					this.#pageTimer = undefined;
					this.#watched = { lists: new Map(), threads: new Set(), letters: new Set(), shown: () => false };
					return;
				}
				if (document.visibilityState === "visible") void this.#refreshPage();
			}, PAGE_POLL_MS);
		queueMicrotask(() => {
			const state = this.#state ?? EMPTY;
			for (const [key, request] of lists)
				if (freshLists.has(key) || !state.lists[key]) void this.#readFirst(key, request);
			for (const thread of opened) if (fresh.has(thread) || !state.threads[thread]) void this.#readThread(thread);
			for (const letter of openLetters)
				if (freshLetters.includes(letter) || !digitalPostOf(state).open[letter]) void this.#readLetter(letter);
			// A closed letter's read is let go too.
			if (Object.keys(digitalPostOf(state).open).some((letter) => !openLetters.has(letter)))
				this.#set((now) => ({
					...now,
					digitalPost: {
						...digitalPostOf(now),
						open: Object.fromEntries(
							Object.entries(digitalPostOf(now).open).filter(([letter]) => openLetters.has(letter)),
						),
					},
				}));
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
		const { lists, threads, letters } = this.#watched;
		await Promise.all([...lists].map(([key, request]) => this.#readFirst(key, request)));
		await Promise.all([...threads].map((thread) => this.#readThread(thread)));
		// The letters list follows the page too: a letter written into the folder shows within the page's read.
		const connection = this.#state?.digitalPost?.connection;
		if (connection?.connected || (connection?.letters ?? 0) > 0)
			await this.#once("digital-post-index", () => this.#readIndex());
		await Promise.all([...letters].map((letter) => this.#readLetter(letter)));
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
	async answer(
		thread: string | undefined,
		sessionId: string,
		reviewId: string,
		answer: ActionReviewAnswer,
	): Promise<void> {
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
			if (thread) void this.#readThread(thread);
			return;
		}
		set({ pending: false, answered: answer });
		await Promise.all([
			// A send that starts a new email has no thread to read again (no `inReplyTo`).
			...(thread ? [this.#readThread(thread)] : []),
			this.#refreshCompany(),
			...[...this.#watched.lists].map(([key, request]) => this.#readFirst(key, request)),
		]);
	}

	/** Sends the member's note to an agent as the member's own message, its outside words as quotes (the Mailbox's
	 * "Tell Ida what to answer", "Write an email" and an address's new handler, views/mailbox.ts). It goes from here
	 * only into a conversation with nothing drafted in it, on the account the cloud chooses for that conversation (as an
	 * answer does); otherwise, or when the send doesn't go, the note waits in that conversation's composer, and `href`
	 * is the agent's thread where it waits. Throws when the agent's thread can't be opened or the note can't be added. */
	async tell(agentId: string, note: QuotedText): Promise<{ readonly sent: boolean; readonly href: string }> {
		const company = this.#company;
		const profileId = company.profile.profileId;
		const cofounder = agentId === company.cofounderId();
		const href = cofounder ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agentId}`;
		let sessionId: string;
		if (cofounder) {
			const opened = await company.openCofounderConversation();
			if (!opened.sessionId) throw new Error(opened.reason ?? t("The Co-Founder's thread can't be opened here."));
			sessionId = opened.sessionId;
		} else {
			const agent = company.staffById(agentId);
			if (agent?.employmentStatus !== "active") throw new Error(t("That agent is no longer at work."));
			sessionId = await company.openStaffConversation(agent);
		}
		// What is drafted there decides: the member's own draft as this browser has it and, where drafts are shared,
		// as the room has it now. Only a note into nothing drafted goes from here.
		const room = company.roomDrafts.room(sessionId);
		if (room) await room.refresh();
		if (this.#closed) return { sent: false, href };
		const conversation = () => company.conversation(sessionId, false).get();
		const shared = () => room?.draft(company.userId)?.body ?? "";
		const before = conversation();
		const empty =
			(!room || room.usable()) &&
			!shared().trim() &&
			!(before.draft ?? "").trim() &&
			!before.attachments?.length &&
			!before.sending &&
			!before.retrySend;
		company.addToDraft(sessionId, note);
		// The submission meant: exactly the note. Anything that changes it while the account is chosen (another tab, a
		// merged shared draft, an attachment) leaves it in the composer for the member to send.
		const intended = conversation().draft ?? "";
		if (!empty || this.#closed) return { sent: false, href };
		await this.#chooseAccount(sessionId);
		const now = conversation();
		if (
			this.#closed ||
			now.draft !== intended ||
			now.attachments?.length ||
			now.sending ||
			now.retrySend ||
			![intended, ""].includes(shared())
		)
			return { sent: false, href };
		const sent = await company.sendPrompt(sessionId, intended);
		return { sent, href };
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
