import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import { withAbortScopes } from "../cloud/abort-scope.ts";
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
	blockMailSender,
	MAIL_PAGE_SIZE,
	type MailAddress,
	type MailBlockedSender,
	type MailCursor,
	type MailDirection,
	type MailMemberSend,
	type MailMemberSent,
	type MailMessage,
	type MailMessageCursor,
	type MailThread,
	type MailThreadAction,
	type MailThreadState,
	type MailThreadSummary,
	type MailThreadView,
	type MailUnsubscribeOutcome,
	type MailWaitingItem,
	markMailThreadRead,
	readMailAddresses,
	readMailBlockedSenders,
	readMailThread,
	readMailThreads,
	readMailWaiting,
	sendMemberMail,
	unblockMailSender,
	unsubscribeMailThread,
	updateMailThreads,
} from "../cloud/mail.ts";
import type { ActionReviewAnswer } from "../cloud/review-rules.ts";
import { type CompanyController, needsModelAccount } from "./company.ts";
import type { QuotedText } from "./quotes.ts";
import { chooseThreadAccount, type TellAccounts, type TellResult, tellAgent } from "./tell-agent.ts";

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
	readonly view?: MailThreadView;
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
export type MailAccounts = TellAccounts;

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
	readonly blockedSenders?: readonly MailBlockedSender[];
	readonly blockedSendersFailed?: boolean;
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
	return request.view === undefined
		? JSON.stringify([request.address ?? null, request.state ?? null, request.direction ?? null])
		: JSON.stringify([request.address ?? null, request.state ?? null, request.direction ?? null, request.view]);
}

const COMPANY_POLL_MS = 60_000;
const PAGE_POLL_MS = 20_000;
const MAX_REFRESH_LIST_PAGES = 10;
const MAX_THREAD_CATCHUP_PAGES = 10;

function compareMailTimestamp(a: string, b: string): number {
	const msDiff = Date.parse(a) - Date.parse(b);
	if (msDiff !== 0 && !Number.isNaN(msDiff)) return msDiff;
	const fracA = /(\.\d+)/.exec(a)?.[1]?.slice(1, 7).padEnd(6, "0") ?? "000000";
	const fracB = /(\.\d+)/.exec(b)?.[1]?.slice(1, 7).padEnd(6, "0") ?? "000000";
	return fracA < fracB ? -1 : fracA > fracB ? 1 : 0;
}

function isAfterMailCursor(item: { lastAt: string; thread: string }, cursor: MailCursor): boolean {
	const cmp = compareMailTimestamp(item.lastAt, cursor.lastAt);
	return cmp < 0 || (cmp === 0 && item.thread < cursor.thread);
}

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

function sameMailCursor(a: MailCursor | undefined, b: MailCursor | null | undefined): boolean {
	if (!a && !b) return true;
	return a !== undefined && b != null && a.lastAt === b.lastAt && a.thread === b.thread;
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
	readonly #stop = new AbortController();
	#state: MailState | undefined;
	/** The version of the letters index last read: it is read again only when it changed. */
	#indexVersion: string | undefined;
	#indexReads = 0;
	#indexApplied = 0;
	#disposed = false;
	#companyTimer: ReturnType<typeof setInterval> | undefined;
	#pageTimer: ReturnType<typeof setInterval> | undefined;
	#reading = new Set<string>();
	#rerun = new Map<string, () => Promise<void>>();
	/** The address reads begun, and the first of them whose answer still counts: one begun before it is let go. */
	#addressReads = 0;
	#addressesSince = 0;
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

	#lastFront: { type: string; at: number } | undefined;

	readonly #onFront = (event: Event) => {
		if (document.visibilityState !== "visible") return;
		const now = Date.now();
		if (this.#lastFront && this.#lastFront.type !== event.type && now - this.#lastFront.at < 250) return;
		this.#lastFront = { type: event.type, at: now };
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

	/** Reads the addresses and Digital Post's state again: an address was made or removed, or Digital Post connected
	 * (the Mailbox's Addresses). */
	reread(): Promise<void> {
		return this.#closed ? Promise.resolve() : this.#refreshCompany();
	}

	/** Reads the addresses with a read begun now, and says whether it was read: after a change to who answers an
	 * address (the Mailbox's Addresses). A read already on its way is from before the change: its answer is let go,
	 * whether this read is read or not. A read that fails keeps the addresses as they were read last. */
	addressesAfresh(): Promise<boolean> {
		return this.#closed ? Promise.resolve(false) : this.#readAddresses(true);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stop.abort();
		clearInterval(this.#companyTimer);
		clearInterval(this.#pageTimer);
		window.removeEventListener("focus", this.#onFront);
		document.removeEventListener("visibilitychange", this.#onFront);
		if (readers.get(this.#company) === this) readers.delete(this.#company);
	}

	#withRpcScope<T>(use: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return withAbortScopes([this.#company.signal, this.#stop.signal], use);
	}

	#withFolderDeadline<T>(use: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return withAbortScopes([this.#company.signal, this.#stop.signal], use, 30_000);
	}

	#set(change: (state: MailState) => MailState): void {
		if (this.#closed) return;
		const had = this.#state !== undefined;
		const prev = this.#state ?? EMPTY;
		const next = change(prev);
		if (had && next === prev) return;
		this.#state = next;
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
			const next = this.#rerun.get(name);
			if (next) {
				this.#rerun.delete(name);
				if (!this.#closed) void next();
			}
		}
	}

	#refreshKey(name: string, run: () => Promise<void>): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#reading.has(name)) {
			this.#rerun.set(name, run);
			return Promise.resolve();
		}
		return run();
	}

	async #fetchAddresses(afterChange = false): Promise<{ read: number; addresses: MailAddress[] } | null> {
		const read = ++this.#addressReads;
		if (afterChange) this.#addressesSince = read;
		try {
			const addresses = await this.#withRpcScope((signal) =>
				readMailAddresses(this.#cloud, this.#environmentId, signal),
			);
			return { read, addresses };
		} catch (error) {
			// A cloud without the member mail read has no mail to show; another failure keeps what was read.
			if (!(error instanceof CloudRpcError && (error.missing || error.denied))) return null;
			return { read, addresses: [] };
		}
	}

	/** Reads the addresses, and says whether they were read. Reads may answer out of turn: one begun before another
	 * whose answer is already in says nothing newer, and is let go. So is one begun before a read asked for after a
	 * change (`afterChange`), from the moment that read begins: what it says is from before the change. */
	async #readAddresses(afterChange = false): Promise<boolean> {
		const result = await this.#fetchAddresses(afterChange);
		if (!result) return false;
		if (result.read < this.#addressesSince) return true;
		this.#addressesSince = result.read;
		this.#set((state) => ({ ...state, addresses: result.addresses }));
		return true;
	}

	async #refreshCompany(): Promise<void> {
		await Promise.all([
			(async () => {
				let addressesResult: { read: number; addresses: MailAddress[] } | null = null;
				let waitingResult: MailWaitingItem[] | undefined;
				await Promise.all([
					this.#once("addresses", async () => {
						addressesResult = await this.#fetchAddresses();
					}),
					this.#once("waiting", async () => {
						try {
							waitingResult = await this.#withRpcScope((signal) =>
								readMailWaiting(this.#cloud, this.#environmentId, signal),
							);
						} catch {
							// The badge keeps its last count.
						}
					}),
				]);
				if (addressesResult === null && waitingResult === undefined) return;
				this.#set((state) => {
					let next = state;
					if (addressesResult !== null && addressesResult.read >= this.#addressesSince) {
						this.#addressesSince = addressesResult.read;
						next = { ...next, addresses: addressesResult.addresses };
					}
					if (waitingResult !== undefined && JSON.stringify(next.waiting) !== JSON.stringify(waitingResult)) {
						next = { ...next, waiting: waitingResult };
					}
					return next;
				});
			})(),
			this.#readDigitalPost(),
		]);
	}

	/** The Digital Post connection, then the letters index when there may be letters. */
	#readDigitalPost(): Promise<void> {
		return this.#once("digital-post", async () => {
			let connection: DigitalPostConnection;
			try {
				connection = await this.#withRpcScope((signal) =>
					readDigitalPost(this.#cloud, this.#environmentId, signal),
				);
			} catch {
				// A cloud without the call has no Digital Post; another failure keeps what was read.
				return;
			}
			this.#set((state) => {
				const current = digitalPostOf(state);
				if (JSON.stringify(current.connection) === JSON.stringify(connection)) return state;
				return { ...state, digitalPost: { ...current, connection } };
			});
			if (connection.connected || connection.letters > 0)
				await this.#once("digital-post-index", () => this.#readIndex());
		});
	}

	/** The letters the folder's index lists, read again only when its version changed. */
	async #readIndex(): Promise<void> {
		if (!this.#folder || this.#closed) return;
		const seq = ++this.#indexReads;
		try {
			await this.#withFolderDeadline(async (signal) => {
				const folder = this.#folder!(signal);
				const read = await folder.read(DIGITAL_POST_INDEX_PATH, signal);
				const file = read.entry?.kind === "file" ? read.entry.file : null;
				if (!read.entry || !file || file.bytes > DIGITAL_POST_INDEX_MAX_BYTES) {
					if (seq < this.#indexApplied) return;
					this.#indexApplied = seq;
					this.#indexVersion = undefined;
					this.#set((state) => {
						const current = digitalPostOf(state);
						if (current.letters.length === 0) return state;
						return { ...state, digitalPost: { ...current, letters: [] } };
					});
					return;
				}
				if (read.entry.version === this.#indexVersion) return;
				const bytes = await folder.readFile(file, signal, DIGITAL_POST_INDEX_MAX_BYTES, { cached: true });
				const letters = parseDigitalPostLetters(new TextDecoder().decode(bytes));
				if (seq < this.#indexApplied) return;
				this.#indexApplied = seq;
				this.#indexVersion = read.entry.version;
				this.#set((state) => ({ ...state, digitalPost: { ...digitalPostOf(state), letters } }));
			});
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
				await this.#withFolderDeadline(async (signal) => {
					const folder = this.#folder!(signal);
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
					const bytes = await folder.readFile(file, signal, DIGITAL_POST_LETTER_MAX_BYTES, { cached: true });
					put({ status: "ready", letter: parseDigitalPostLetterText(new TextDecoder().decode(bytes)) });
				});
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
			if (this.#closed) return;
			const state = this.#state ?? EMPTY;
			const current = this.#watched;
			for (const [key, request] of current.lists)
				if (freshLists.has(key) || !state.lists[key]) void this.#readFirst(key, request);
			for (const thread of current.threads)
				if (fresh.has(thread) || !state.threads[thread]) void this.#readThread(thread);
			for (const letter of current.letters)
				if (freshLetters.includes(letter) || !digitalPostOf(state).open[letter]) void this.#readLetter(letter);
			// A closed letter's read is let go too.
			const currentLetters = current.letters;
			if (Object.keys(digitalPostOf(state).open).some((letter) => !currentLetters.has(letter)))
				this.#set((now) => ({
					...now,
					digitalPost: {
						...digitalPostOf(now),
						open: Object.fromEntries(
							Object.entries(digitalPostOf(now).open).filter(([letter]) => currentLetters.has(letter)),
						),
					},
				}));
			// A closed thread's read is let go: opening it again reads it again anyway.
			const open = current.threads;
			if (Object.keys(state.threads).some((thread) => !open.has(thread)))
				this.#set((now) => ({
					...now,
					threads: Object.fromEntries(Object.entries(now.threads).filter(([thread]) => open.has(thread))),
				}));
		});
	}

	async #refreshPage(): Promise<void> {
		const { lists, threads, letters } = this.#watched;
		// WHY: lists land first so #readFirst can clear #marked and schedule a fresh thread read for newly arrived mail.
		await Promise.all([...lists].map(([key, request]) => this.#readFirst(key, request)));
		// The letters list follows the page too: a letter written into the folder shows within the page's read.
		const connection = this.#state?.digitalPost?.connection;
		await Promise.all([
			...[...threads].map((thread) => this.#readThread(thread)),
			...(connection?.connected || (connection?.letters ?? 0) > 0
				? [this.#once("digital-post-index", () => this.#readIndex())]
				: []),
			...[...letters].map((letter) => this.#readLetter(letter)),
		]);
	}

	/** Reads a list's first page, and as many pages after it as the list shows, each from where the one before ends: a
	 * thread whose newest message went the other way, or whose state changed, leaves a filtered list on screen too. */
	#readFirst(key: string, request: MailListRequest): Promise<void> {
		return this.#once(`list:${key}`, async () => {
			try {
				const drawn = this.#state?.lists[key];
				const target = drawn?.status === "ready" ? Math.max(drawn.pages, 1) : 1;
				// WHY: Cap background list refreshes and break on repeated cursors so deep scrolls do not trigger unbounded serial RPCs every poll.
				const cap = Math.min(target, MAX_REFRESH_LIST_PAGES);
				const read: MailThreadSummary[] = [];
				let pages = 0;
				let next: MailCursor | undefined;
				let completed = false;
				await this.#withRpcScope(async (signal) => {
					let page = await readMailThreads(
						this.#cloud,
						this.#environmentId,
						{ ...request, limit: MAIL_PAGE_SIZE },
						signal,
					);
					read.push(...page.threads);
					pages = 1;
					const seenCursors = new Set<string>();
					while (pages < cap && page.nextBefore) {
						if (this.#closed || !this.#watched.lists.has(key) || signal.aborted) return;
						const cursorKey = `${page.nextBefore.lastAt}\0${page.nextBefore.thread}`;
						if (seenCursors.has(cursorKey)) break;
						seenCursors.add(cursorKey);
						page = await readMailThreads(
							this.#cloud,
							this.#environmentId,
							{ ...request, before: page.nextBefore, limit: MAIL_PAGE_SIZE },
							signal,
						);
						read.push(...page.threads);
						pages += 1;
					}
					next = page.nextBefore;
					completed = true;
				});
				if (!completed || this.#closed) return;
				const opened = this.#watched.threads;
				// Newer mail in a thread the member has open is read with it, and marked read again.
				const arrived = read.filter((item) => item.unread && opened.has(item.thread));
				for (const item of arrived) this.#marked.delete(item.thread);
				this.#set((state) => {
					const was = state.lists[key];
					// Show older landed while these pages were read: the list stays as it is, and its next read reads that
					// page too.
					if (was?.status === "ready" && was.pages > target) return state;
					const seen = new Set<string>();
					const threads: MailThreadSummary[] = [];
					for (const item of read) {
						if (seen.has(item.thread)) continue;
						seen.add(item.thread);
						threads.push(opened.has(item.thread) ? { ...item, unread: false } : item);
					}
					let preserveTail = false;
					if (
						target > cap &&
						pages === cap &&
						next !== undefined &&
						was?.status === "ready" &&
						was.threads.length > 0 &&
						!isAfterMailCursor(was.threads[0]!, next)
					) {
						// WHY: Join deep-scroll tails by cursor order (lastAt desc, thread desc) so threads promoted into the head cannot drop intermediate items.
						preserveTail = true;
						for (const item of was.threads) {
							if (!isAfterMailCursor(item, next) || seen.has(item.thread)) continue;
							seen.add(item.thread);
							threads.push(opened.has(item.thread) ? { ...item, unread: false } : item);
						}
					}
					const finalNext = preserveTail ? was!.next : next;
					const finalPages = preserveTail ? was!.pages : pages;
					const older = was?.older === "loading" ? "loading" : "idle";
					if (
						was?.status === "ready" &&
						was.pages === finalPages &&
						sameMailCursor(was.next, finalNext) &&
						was.older === older &&
						JSON.stringify(was.threads) === JSON.stringify(threads)
					)
						return state;
					const list: MailList = {
						request,
						threads,
						...(finalNext ? { next: finalNext } : {}),
						pages: finalPages,
						status: "ready",
						older,
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
				const page = await this.#withRpcScope((signal) =>
					readMailThreads(
						this.#cloud,
						this.#environmentId,
						{
							...list.request,
							before,
							limit: MAIL_PAGE_SIZE,
						},
						signal,
					),
				);
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
				const page = await this.#withRpcScope((signal) =>
					readMailThread(this.#cloud, this.#environmentId, thread, before, signal),
				);
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
			let read: MailThread | undefined;
			let pages = 1;
			try {
				await this.#withRpcScope(async (signal) => {
					const newest = await readMailThread(this.#cloud, this.#environmentId, thread, undefined, signal);
					// With older pages kept, more than a page of mail may have come since the last read: the pages before the
					// newest are read too, back to the newest message shown, so the kept ones still follow on with none between.
					const shown = this.#state?.threads[thread];
					const upTo = shown?.status === "ready" && shown.pages > 1 ? shown.thread.messages.at(-1) : undefined;
					const upToKey = upTo ? messageKey(upTo) : undefined;
					const matchesUpTo = (messages: readonly MailMessage[]) =>
						upToKey === undefined || messages.some((message) => messageKey(message) === upToKey);
					if (newest.thread === undefined || !newest.nextBefore || matchesUpTo(newest.messages)) {
						read = newest;
						return;
					}
					// WHY: Collect catch-up pages in O(N), bound page depth, and halt on non-advancing cursors to avoid O(P^2) loops.
					const chunks: (readonly MailMessage[])[] = [newest.messages];
					let more = newest.more;
					let nextBefore: MailMessageCursor | undefined = newest.nextBefore;
					const seenCursors = new Set<string>();
					while (nextBefore && pages < MAX_THREAD_CATCHUP_PAGES) {
						if (this.#closed || !this.#watched.threads.has(thread) || signal.aborted) return;
						const cursorKey = `${nextBefore.at}\0${nextBefore.kind}\0${nextBefore.id}`;
						if (seenCursors.has(cursorKey)) break;
						seenCursors.add(cursorKey);
						const page = await readMailThread(this.#cloud, this.#environmentId, thread, nextBefore, signal);
						if (page.thread === undefined) {
							read = page;
							return;
						}
						chunks.push(page.messages);
						more = page.more;
						nextBefore = page.nextBefore;
						pages += 1;
						if (matchesUpTo(page.messages)) break;
					}
					const { nextBefore: _ignored, ...rest } = newest;
					read = {
						...rest,
						messages: chunks.reverse().flat(),
						more,
						...(nextBefore ? { nextBefore } : {}),
					};
				});
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
			if (!read) return;
			const finalRead = read;
			// While the company's mail is off the call answers with no thread.
			if (finalRead.thread === undefined) {
				this.#set((state) => ({ ...state, threads: { ...state.threads, [thread]: { status: "gone" } } }));
				return;
			}
			this.#set((state) => {
				const was = state.threads[thread];
				// Older pages are kept only while the fresh pages reach the newest message they show.
				const last = was?.status === "ready" ? was.thread.messages.at(-1) : undefined;
				const joins =
					last !== undefined && finalRead.messages.some((message) => messageKey(message) === messageKey(last));
				if (was?.status !== "ready" || was.pages < 2 || !joins) {
					const found: MailThreadRead = {
						status: "ready",
						thread: finalRead,
						pages,
						older: was?.status === "ready" && was.older === "loading" ? "loading" : "idle",
					};
					return { ...state, threads: { ...state.threads, [thread]: found } };
				}
				// Older pages were read: they stay before the fresh pages, with the messages newer mail pushed out of them,
				// and so does where the next older page starts.
				const fresh = new Set(finalRead.messages.map(messageKey));
				const kept = was.thread.messages.filter((message) => !fresh.has(messageKey(message)));
				const { nextBefore: _next, ...newest } = finalRead;
				const found: MailThreadRead = {
					...was,
					pages: was.pages + pages - 1,
					thread: {
						...newest,
						messages: [...kept, ...finalRead.messages],
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
			await this.#withRpcScope((signal) => markMailThreadRead(this.#cloud, this.#environmentId, thread, signal));
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
		// While the agent still waits, its answer needs no account, so a choice that fails only leaves the answer to say
		// whether it needed one.
		await chooseThreadAccount(this.#company, this.#accounts, sessionId);
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

	/** Sends the member's own email from one of the company's addresses, with no agent (the Mailbox's "Send",
	 * views/mailbox.ts; cloud/mail.ts `sendMemberMail`), as a new email or as an answer in a thread. It throws what the
	 * cloud refuses, for the window it was written in to say. The lists and the threads a page shows are then read
	 * again, so the email is in Sent and an answer stands in its thread. */
	async send(request: MailMemberSend): Promise<MailMemberSent> {
		const sent = await this.#withRpcScope((signal) =>
			sendMemberMail(this.#cloud, this.#environmentId, request, signal),
		);
		await Promise.all([
			...[...this.#watched.lists].map(([key, listed]) => this.#readFirst(key, listed)),
			...[...this.#watched.threads].map((thread) => this.#readThread(thread)),
		]);
		return sent;
	}

	/** Sends the member's note to an agent as the member's own message, its outside words as quotes (the Mailbox's
	 * answer or new email an agent is asked to write, and an address's new handler, views/mailbox.ts), as an app's
	 * note goes (app/tell-agent.ts): it goes from here only into a conversation with nothing drafted in it; otherwise,
	 * or when the send doesn't go, the note waits in that conversation's composer, and `href` is the agent's thread
	 * where it waits. Throws when the agent's thread can't be opened or the note can't be added. */
	tell(agentId: string, note: QuotedText): Promise<TellResult> {
		return tellAgent(this.#company, this.#accounts, agentId, note, () => this.#closed);
	}

	#refreshWatchedAfterMutation(): Promise<void> {
		return Promise.all([
			...[...this.#watched.lists].map(([key, listed]) =>
				this.#refreshKey(`list:${key}`, () => this.#readFirst(key, listed)),
			),
			...[...this.#watched.threads].map((id) => this.#refreshKey(`thread:${id}`, () => this.#readThread(id))),
		]).then(() => undefined);
	}

	async readBlockedSenders(requeue = false): Promise<readonly MailBlockedSender[]> {
		if (this.#closed) return [];
		const read = () =>
			this.#once("blocked", async () => {
				try {
					const senders = await this.#withRpcScope((signal) =>
						readMailBlockedSenders(this.#cloud, this.#environmentId, signal),
					);
					this.#set((state) =>
						!state.blockedSendersFailed &&
						JSON.stringify(state.blockedSenders ?? null) === JSON.stringify(senders)
							? state
							: { ...state, blockedSenders: senders, blockedSendersFailed: false },
					);
				} catch (error) {
					if (error instanceof CloudRpcError && (error.missing || error.denied)) {
						this.#set((state) =>
							!state.blockedSendersFailed && state.blockedSenders?.length === 0
								? state
								: { ...state, blockedSenders: [], blockedSendersFailed: false },
						);
						return;
					}
					this.#set((state) => (state.blockedSendersFailed ? state : { ...state, blockedSendersFailed: true }));
				}
			});
		await (requeue ? this.#refreshKey("blocked", read) : read());
		return this.#state?.blockedSenders ?? [];
	}

	async updateThreads(threads: readonly string[], action: MailThreadAction): Promise<void> {
		const target = new Set(threads);
		if (target.size === 0 || this.#closed) return;
		const now = new Date().toISOString();
		const priorLists = new Map<string, { readonly item: MailThreadSummary; readonly index: number }[]>();
		const priorThreads = new Map<string, MailThread>();
		const snapshot = this.#state;
		if (snapshot) {
			for (const [key, list] of Object.entries(snapshot.lists)) {
				const captured: { readonly item: MailThreadSummary; readonly index: number }[] = [];
				for (let i = 0; i < list.threads.length; i += 1) {
					const item = list.threads[i]!;
					if (target.has(item.thread)) captured.push({ item, index: i });
				}
				if (captured.length > 0) priorLists.set(key, captured);
			}
			for (const id of target) {
				const read = snapshot.threads[id];
				if (read?.status === "ready") priorThreads.set(id, read.thread);
			}
		}
		const patchSummary = (item: MailThreadSummary): MailThreadSummary => {
			if (!target.has(item.thread)) return item;
			if (action === "star") return { ...item, starred: true };
			if (action === "unstar") {
				const { starred: _starred, ...rest } = item;
				return rest;
			}
			if (action === "trash") return { ...item, trashedAt: now };
			if (action === "restore") {
				const { trashedAt: _trashed, archivedAt: _archived, ...rest } = item;
				return rest;
			}
			if (action === "archive") return { ...item, archivedAt: now };
			const { archivedAt: _archived, ...rest } = item;
			return rest;
		};
		const keepInList = (request: MailListRequest, item: MailThreadSummary): boolean => {
			if (!target.has(item.thread)) return true;
			const view = request.view ?? (request.direction ? "all" : "inbox");
			if (view === "trash") return action === "trash" || action === "star" || action === "unstar";
			if (view === "starred") return action !== "unstar" && action !== "trash";
			if (view === "archived") return action !== "unarchive" && action !== "restore" && action !== "trash";
			if (view === "inbox") return action !== "trash" && action !== "archive";
			return action !== "trash";
		};
		this.#set((state) => {
			const lists = Object.fromEntries(
				Object.entries(state.lists).map(([key, list]) => [
					key,
					{
						...list,
						threads: list.threads.filter((item) => keepInList(list.request, item)).map(patchSummary),
					},
				]),
			);
			const openThreads = Object.fromEntries(
				Object.entries(state.threads).map(([id, read]) => {
					if (!target.has(id) || read.status !== "ready") return [id, read];
					const current = read.thread;
					let updated: MailThread = current;
					if (action === "star") updated = { ...current, starred: true };
					else if (action === "unstar") {
						const { starred: _starred, ...rest } = current;
						updated = rest;
					} else if (action === "trash") updated = { ...current, trashedAt: now };
					else if (action === "restore") {
						const { trashedAt: _trashed, archivedAt: _archived, ...rest } = current;
						updated = rest;
					} else if (action === "archive") updated = { ...current, archivedAt: now };
					else {
						const { archivedAt: _archived, ...rest } = current;
						updated = rest;
					}
					return [id, { ...read, thread: updated }];
				}),
			);
			return { ...state, lists, threads: openThreads };
		});
		try {
			await this.#withRpcScope((signal) =>
				updateMailThreads(this.#cloud, this.#environmentId, [...target], action, signal),
			);
		} catch (error) {
			this.#set((state) => {
				const lists = Object.fromEntries(
					Object.entries(state.lists).map(([key, list]) => {
						const captured = priorLists.get(key);
						if (!captured) return [key, list];
						const byId = new Map(captured.map((entry) => [entry.item.thread, entry.item]));
						const nextThreads = list.threads.map((item) => byId.get(item.thread) ?? item);
						const present = new Set(nextThreads.map((item) => item.thread));
						for (const entry of captured) {
							if (present.has(entry.item.thread)) continue;
							const atIndex = Math.min(entry.index, nextThreads.length);
							nextThreads.splice(atIndex, 0, entry.item);
							present.add(entry.item.thread);
						}
						return [key, { ...list, threads: nextThreads }];
					}),
				);
				const openThreads = Object.fromEntries(
					Object.entries(state.threads).map(([id, read]) => {
						const saved = priorThreads.get(id);
						if (!saved || read.status !== "ready") return [id, read];
						const restored: MailThread = {
							...read.thread,
							...(saved.starred ? { starred: true } : {}),
							...(saved.archivedAt ? { archivedAt: saved.archivedAt } : {}),
							...(saved.trashedAt ? { trashedAt: saved.trashedAt } : {}),
						};
						if (!saved.starred) Reflect.deleteProperty(restored, "starred");
						if (!saved.archivedAt) Reflect.deleteProperty(restored, "archivedAt");
						if (!saved.trashedAt) Reflect.deleteProperty(restored, "trashedAt");
						return [id, { ...read, thread: restored }];
					}),
				);
				return { ...state, lists, threads: openThreads };
			});
			void this.#refreshWatchedAfterMutation();
			throw error;
		}
		await this.#refreshWatchedAfterMutation();
	}

	async unsubscribe(thread: string, deliveryId?: string): Promise<MailUnsubscribeOutcome> {
		const outcome = await this.#withRpcScope((signal) =>
			unsubscribeMailThread(this.#cloud, this.#environmentId, thread, deliveryId, signal),
		);
		await this.#refreshKey(`thread:${thread}`, () => this.#readThread(thread));
		return outcome;
	}

	async blockSender(
		sender: string,
		trashExisting = true,
	): Promise<{
		readonly sender: string;
		readonly trashedCount: number;
		readonly trashedThreads: readonly string[];
		readonly trashedArchivedThreads: readonly string[];
	}> {
		const result = await this.#withRpcScope((signal) =>
			blockMailSender(this.#cloud, this.#environmentId, sender, trashExisting, signal),
		);
		await Promise.all([this.#refreshWatchedAfterMutation(), this.readBlockedSenders(true)]);
		return result;
	}

	async unblockSender(sender: string): Promise<void> {
		await this.#withRpcScope((signal) => unblockMailSender(this.#cloud, this.#environmentId, sender, signal));
		await Promise.all([this.#refreshWatchedAfterMutation(), this.readBlockedSenders(true)]);
	}
}
