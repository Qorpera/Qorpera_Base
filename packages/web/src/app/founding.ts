import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError, describeError } from "../cloud/client.ts";
import {
	type CompanyFounding,
	CompanyFoundingApi,
	FOUNDING_NAME_MAX_CHARACTERS,
	FOUNDING_ROLE_MAX_CHARACTERS,
} from "../cloud/company-founding.ts";
import type {
	FoundingField,
	FoundingLive,
	FoundingPresenceHandle,
	FoundingPresenceTab,
} from "../cloud/founding-presence.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import type { HostedFriend } from "../cloud/types.ts";
import { t } from "../ui/preferences.ts";
import { Store } from "./state.ts";
import { ConnectionsView, memberProviderSignIns } from "./views/settings-connections.ts";

/* One founding table, as one member sees it. The server owns every rule; this controller keeps
 * the table fresh while it is open (other founders edit it too) and sends one action at a time. */

/** Another founder's edit shows within this long; the table is short-lived and small. */
const POLL_MS = 2500;
/** While the ChatGPT panel is open, a finished sign-in turns into Ready sooner. */
const CONNECT_POLL_MS = 1500;
/** After the company is made, the table is read a little longer while the Co-Founder's first run is queued, so a
 * first run that fails (or starts) is shown; never past this. */
const FIRST_RUN_WATCH_MS = 120_000;

/** Someone counts as writing for this long after their words last changed. */
export const FOUNDING_WRITING_MS = 4000;
/** Your words and caret go to the others at most this often while you write, */
const LIVE_SEND_MS = 200;
/** and again this often while you stay in the field, for anyone who came since. */
const LIVE_REPEAT_MS = 5000;
/** Someone's words stay in the box this long after they leave the field, until their save shows. */
const LIVE_HOLD_MS = 6000;

/** Someone else at the table now (live presence). */
export interface FounderPresence {
	userId: string;
	/** One of their tabs has the table on screen. */
	here: boolean;
	/** They changed words in a field in the last few seconds. */
	writing: boolean;
}

/** Someone else's words in a field and their caret there, as they write. */
export interface FounderLive {
	userId: string;
	field: FoundingField;
	text: string;
	/** Their caret, while they are in the field. */
	caret: number | null;
	/** Their own words, and they differ from the table's: written and not saved yet (or saved and not read here yet).
	 * A box follows only these. */
	unsaved: boolean;
	/** When their words last changed; the newest writer's words are the ones a box follows. */
	typedAt: number;
}

export type FoundingAction = "name" | "vision" | "role" | "ready" | "invite" | "remove" | "respond" | "start" | "close";

export interface FoundingState {
	table?: CompanyFounding;
	/** The table as last seen before Start: its roles, which Start moves into the company's files. */
	beforeStart?: CompanyFounding;
	loading: boolean;
	/** The last action's failure; it stays until the next action. */
	error?: string;
	/** A read failed; cleared by the next read that works. */
	readError?: string;
	busy?: FoundingAction;
	/** You no longer sit at this table: you declined, left or were removed, or it was closed. */
	gone?: "declined" | "left" | "closed" | "unavailable";
	friendsOpen?: boolean;
	friends?: HostedFriend[];
	friendsError?: string;
	addingFriend?: boolean;
	friendAdded?: string;
	connectOpen?: boolean;
	/** Live presence works at this table: this tab is on its topic. Without it the table only reads itself. */
	live?: boolean;
	/** The others at the table now, in seat order. */
	present?: FounderPresence[];
	/** What the others are writing: one per person and field, newest first. */
	liveText?: FounderLive[];
}

export interface FoundingOptions {
	/** The signed-in account now; a sign-in in progress stops only when this changes, as in Settings. */
	currentUserId: () => string | undefined;
	/** Where you sit changed (joined, left, declined, closed): the hub's lists are out of date. */
	onSeatChanged?: () => void;
	/** The company is made and its Co-Founder's first run is on its way: open the company (once per table page). */
	onCompanyReady?: () => void;
}

/** What the new-company box asked for as it opened a table: the friends list open at once, and the idea, if
 * saving it with the opening failed. Kept in the tab, through a reload, until the table's page has used it:
 * the friends list once, the idea until it is saved. */
export interface FoundingIntent {
	friends?: boolean;
	vision?: string;
}

const intents = new Map<string, FoundingIntent>();
const intentKey = (profileId: string) => `qorpera:founding-intent:${profileId}`;

export function setFoundingIntent(profileId: string, intent: FoundingIntent): void {
	if (!intent.friends && !intent.vision) {
		intents.delete(profileId);
		try {
			sessionStorage.removeItem(intentKey(profileId));
		} catch {
			/* Nothing was kept. */
		}
		return;
	}
	intents.set(profileId, intent);
	try {
		sessionStorage.setItem(intentKey(profileId), JSON.stringify(intent));
	} catch {
		/* This page still has it. */
	}
}

function takeFoundingIntent(profileId: string): FoundingIntent | undefined {
	const kept = intents.get(profileId);
	if (kept) return kept;
	try {
		const saved: unknown = JSON.parse(sessionStorage.getItem(intentKey(profileId)) ?? "null");
		if (!saved || typeof saved !== "object") return undefined;
		const vision = "vision" in saved && typeof saved.vision === "string" ? saved.vision.trim() : "";
		return {
			...("friends" in saved && saved.friends === true ? { friends: true } : {}),
			...(vision ? { vision } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Automatic tries at saving the idea the opening could not; after them it waits in the box as your draft. */
const VISION_TRIES = 3;

/** The hint the Co-Founder's arrival reads once, so it plays from the start (agreed with Interfaces, 4 October 2026):
 * set when this tab's founder presses Start; the arrival removes it and ignores one older than ten minutes. */
export function cofounderArrivalKey(profileId: string): string {
	return `qorpera:cofounder-arrival:${profileId}`;
}

function stale(error: unknown): boolean {
	return error instanceof CloudRpcError && error.code === "PT412";
}

function unavailable(error: unknown): boolean {
	return error instanceof CloudRpcError && error.code === "42501";
}

export class FoundingController {
	readonly store = new Store<FoundingState>({ loading: true });
	readonly profileId: string;
	readonly userId: string;
	readonly #api: CloudApi;
	readonly #founding: CompanyFoundingApi;
	readonly #options: FoundingOptions;
	readonly #lifetime = new AbortController();
	readonly #startKey: string;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** When this table was first read with its company made. */
	#readyAt: number | undefined;
	/** The company was opened from this page already. */
	#opened = false;
	#reading: Promise<void> | undefined;
	#connections: ConnectionsView | undefined;
	#queue: Promise<void> = Promise.resolve();
	/** Moves when an action ends: a read that started before that is out of date. */
	#epoch = 0;
	/** Revisions this tab's own edits produced, each mapped to the revision it was made on. */
	readonly #ownRevisions = new Map<number, number>();
	/** The idea the new-company box could not save as it opened this table: saved on a read, kept until it is. */
	#pendingVision: string | undefined;
	#visionTries = 0;
	#savingVision = false;
	/** The page's check for words in its fields that the table on the server does not have (FoundingView). */
	#unsaved: (() => boolean) | undefined;
	// Live presence: this tab on the table's topic, the other tabs there, and what each of them writes.
	#presence: FoundingPresenceHandle | undefined;
	/** The cloud has no presence for this table, or the table is over: not joined again. */
	#presenceOver = false;
	#tabs: FoundingPresenceTab[] = [];
	/** Each other tab's words, by tab and field: a tab that moves to another field keeps its words in the first
	 * one until they are held long enough. */
	readonly #lives = new Map<
		string,
		{ live: FoundingLive; seenAt: number; typedAt: number; leftAt: number | undefined }
	>();
	#presenceTimer: ReturnType<typeof setTimeout> | undefined;
	/** The field this tab writes in, and what it last sent from it. */
	#myField: FoundingField | null = null;
	#pendingLive: Omit<FoundingLive, "clientId" | "userId"> | undefined;
	#lastLive: Omit<FoundingLive, "clientId" | "userId"> | undefined;
	#lastSentAt = 0;
	#sendTimer: ReturnType<typeof setTimeout> | undefined;
	#repeatTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(api: CloudApi, userId: string, profileId: string, options: FoundingOptions) {
		this.#api = api;
		this.#founding = new CompanyFoundingApi(api.cloud);
		this.userId = userId;
		this.#options = options;
		this.profileId = profileId;
		this.#startKey = `qorpera-web-founding-start/v1/${api.cloud.config.projectUrl}/${userId}/${profileId}`;
		const intent = takeFoundingIntent(profileId);
		this.#pendingVision = intent?.vision?.trim() || undefined;
		// The friends list opens once; the idea stays kept until it is saved.
		setFoundingIntent(profileId, this.#pendingVision ? { vision: this.#pendingVision } : {});
		if (intent?.friends) this.openFriends(true);
		const resume = () => {
			this.#presence?.setState(!document.hidden, this.#myField);
			if (!document.hidden) void this.refresh();
		};
		window.addEventListener("focus", resume, { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", resume, { signal: this.#lifetime.signal });
		void this.refresh();
	}

	get disposed(): boolean {
		return this.#lifetime.signal.aborted;
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.#closeConnections();
		this.#leavePresence();
		this.store.dispose();
	}

	refresh(): Promise<void> {
		if (this.disposed || this.store.get().gone) return Promise.resolve();
		this.#reading ??= this.#read().finally(() => {
			this.#reading = undefined;
		});
		return this.#reading;
	}

	async #read(): Promise<void> {
		clearTimeout(this.#timer);
		const epoch = this.#epoch;
		try {
			const table = await this.#founding.read(this.profileId);
			// An action ended while this read was out; its own answer is newer than this one.
			if (epoch === this.#epoch) this.#show(table);
			if (!this.disposed) this.store.set({ loading: false, readError: undefined });
		} catch (error) {
			if (this.disposed) return;
			if (unavailable(error)) this.#gone(this.store.get().gone ?? "unavailable");
			else this.store.set({ loading: false, readError: describeError(error) });
		}
		this.#schedule();
	}

	#schedule(): void {
		clearTimeout(this.#timer);
		const { table, gone, connectOpen } = this.store.get();
		if (this.disposed || gone) return;
		if (table?.start?.companyReady) {
			this.#readyAt ??= Date.now();
			if (table.start.firstRun !== "queued" || Date.now() - this.#readyAt > FIRST_RUN_WATCH_MS) return;
		}
		// A hidden tab does not ask; coming back (visibilitychange) reads at once.
		this.#timer = setTimeout(
			() => {
				if (document.hidden) this.#schedule();
				else void this.refresh();
			},
			connectOpen ? CONNECT_POLL_MS : POLL_MS,
		);
	}

	#show(table: CompanyFounding): void {
		if (this.disposed) return;
		const current = this.store.get().table;
		// Never step back: a started table stays started, and an older revision of an open table is
		// out of date. (An invitation does not move the revision, so an equal revision still shows.)
		if (current?.phase === "started" && table.phase === "open") return;
		if (current?.phase === "open" && table.phase === "open" && table.revision < current.revision) return;
		const connected = table.seats.some((seat) => seat.userId === this.userId && seat.modelLoginReady);
		// Once your own ChatGPT account is connected, or the table has started, the panel is done.
		const panelDone = (this.store.get().connectOpen && connected) || table.phase === "started";
		this.store.set({
			table,
			loading: false,
			...(table.phase === "open" ? { beforeStart: table } : {}),
			...(panelDone ? { connectOpen: false } : {}),
		});
		if (panelDone) this.#closeConnections();
		if (table.phase === "open") this.#joinPresence();
		else this.#leavePresence();
		this.#showPresence();
		this.#savePendingVision(table);
		// Made, with its Co-Founder's first run queued or under way: the founders go straight to it (Jonas, 4 October
		// 2026). A first run that waits for a login or failed keeps the page, which says why.
		const firstRun = table.start?.firstRun;
		if (
			table.start?.companyReady &&
			!this.#opened &&
			(firstRun === null || firstRun === undefined || firstRun === "queued" || firstRun === "started")
		) {
			this.#opened = true;
			this.#options.onCompanyReady?.();
		}
	}

	/** The idea the opening could not save: written in on a read of the open table, and forgotten once the table
	 * has it (or someone wrote the table's text first). A failed try is tried again on the next read, a few times. */
	#savePendingVision(table: CompanyFounding): void {
		const vision = this.#pendingVision;
		if (vision === undefined || this.#savingVision || table.phase !== "open" || table.me.state !== "joined") return;
		if (table.vision) {
			this.#forgetPendingVision();
			return;
		}
		if (this.#visionTries >= VISION_TRIES) return;
		this.#visionTries++;
		this.#savingVision = true;
		// Written only on a table that still has no text when its turn in the queue comes, so newer text (your
		// own, saved first) always wins; a table that moved meanwhile is read and checked again.
		void this.#act("vision", async (current) => {
			let base = current;
			for (let attempt = 0; ; attempt++) {
				if (base.vision || this.#pendingVision === undefined) return base === current ? null : base;
				try {
					const next = await this.#founding.update(this.profileId, base.revision, base.companyName, vision);
					if (next.revision !== base.revision) this.#ownRevisions.set(next.revision, base.revision);
					return next;
				} catch (error) {
					if (!stale(error) || attempt > 0) throw error;
					base = await this.#founding.read(this.profileId);
				}
			}
		}).then(() => {
			this.#savingVision = false;
			if (!this.disposed && this.store.get().table?.vision) this.#forgetPendingVision();
		});
	}

	#forgetPendingVision(): void {
		this.#pendingVision = undefined;
		setFoundingIntent(this.profileId, {});
	}

	/** The idea the opening could not save yet, shown in the box as your unsaved text. */
	get pendingVision(): string | undefined {
		return this.#pendingVision;
	}

	/** The page tells the table which words in its fields the server does not have yet. */
	watchUnsaved(check: () => boolean): void {
		this.#unsaved = check;
	}

	/** Your text saves queued so far, finished, and every field's words on the table: otherwise (a save that was
	 * refused or failed, in any field) nothing is started or made Ready, and your words stay where they are. */
	async #editsSaved(): Promise<boolean> {
		await this.#queue;
		return !(this.#unsaved?.() ?? false);
	}

	/** Actions run one after another, in the order they were made (a role saved as you click Ready,
	 * then Ready). A changed table is read again and shown, never silently overwritten. */
	#act(action: FoundingAction, run: (table: CompanyFounding) => Promise<CompanyFounding | null>): Promise<boolean> {
		const next = this.#queue.then(() => this.#run(action, run));
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async #run(
		action: FoundingAction,
		run: (table: CompanyFounding) => Promise<CompanyFounding | null>,
	): Promise<boolean> {
		const table = this.store.get().table;
		if (this.disposed || !table || this.store.get().gone) return false;
		this.store.set({ busy: action, error: undefined });
		try {
			const next = await run(table);
			this.#epoch++;
			if (next) this.#show(next);
			return true;
		} catch (error) {
			if (this.disposed) return false;
			this.#epoch++;
			if (stale(error)) {
				// A read already out started before this action and will be dropped: read again after it.
				await this.#reading?.catch(() => undefined);
				await this.refresh();
				this.store.set({ error: t("The table changed while you were editing. Check it and try again.") });
			} else this.store.set({ error: lobbyError(error) });
			return false;
		} finally {
			if (!this.disposed) this.store.set({ busy: undefined });
		}
	}

	/** A text edit applies to the table as it is on the server: on a moved table it is sent again on
	 * that table, with that table's other fields, so nobody else's edit is undone. */
	#edit(
		action: "name" | "vision" | "role",
		run: (table: CompanyFounding) => Promise<CompanyFounding>,
	): Promise<boolean> {
		return this.#act(action, async (table) => {
			let base = table;
			let next: CompanyFounding;
			try {
				next = await run(base);
			} catch (error) {
				if (!stale(error)) throw error;
				base = await this.#founding.read(this.profileId);
				next = await run(base);
			}
			if (next.revision !== base.revision) this.#ownRevisions.set(next.revision, base.revision);
			return next;
		});
	}

	rename(name: string): Promise<boolean> {
		const trimmed = name.trim();
		if (!trimmed) return Promise.resolve(false);
		return this.#edit("name", (table) =>
			trimmed === table.companyName
				? Promise.resolve(table)
				: this.#founding.update(this.profileId, table.revision, trimmed, table.vision),
		);
	}

	describe(vision: string): Promise<boolean> {
		const trimmed = vision.trim();
		return this.#edit("vision", (table) =>
			trimmed === table.vision
				? Promise.resolve(table)
				: this.#founding.update(this.profileId, table.revision, table.companyName, trimmed),
		);
	}

	setRole(role: string): Promise<boolean> {
		const trimmed = role.trim();
		return this.#edit("role", (table) =>
			trimmed === table.seats.find((seat) => seat.userId === this.userId)?.role
				? Promise.resolve(table)
				: this.#founding.setRole(this.profileId, table.revision, trimmed),
		);
	}

	/** Ready (or not) for the table you pressed it on. Your own edits queued before the press (a role
	 * saved as you clicked) may move the revision; anyone else's change makes the server refuse it. */
	async setReady(seenRevision: number, ready: boolean): Promise<void> {
		// Ready means the table as you see it, your own words included: never while one of your saves failed.
		if (ready && !(await this.#editsSaved())) return;
		await this.#act("ready", (table) => {
			let revision = table.revision;
			while (revision !== seenRevision && this.#ownRevisions.has(revision))
				revision = this.#ownRevisions.get(revision)!;
			const expected = revision === seenRevision ? table.revision : seenRevision;
			return this.#founding.setReady(this.profileId, expected, ready);
		});
	}

	/** Alone at the table, Start is one press: Ready on the table as you see it, then Start. */
	async startAlone(seenRevision: number): Promise<void> {
		// The field you left as you pressed saves first; a save clears Ready, so Ready is read after it. If the
		// save failed, nothing happens (Ready and Start check that too).
		if (!(await this.#editsSaved())) return;
		if (!this.store.get().table?.seats.find((seat) => seat.userId === this.userId)?.ready)
			await this.setReady(seenRevision, true);
		if (this.store.get().table?.me.canStart) await this.start();
	}

	async invite(friendUserId: string): Promise<void> {
		await this.#act("invite", () => this.#founding.invite(this.profileId, friendUserId));
	}

	async removeSeat(userId: string): Promise<void> {
		await this.#act("remove", () => this.#founding.remove(this.profileId, userId));
	}

	async leave(): Promise<boolean> {
		const left = await this.#act("remove", async () => {
			await this.#founding.leave(this.profileId, this.userId);
			return null;
		});
		if (left) this.#gone("left");
		return left;
	}

	async respond(accept: boolean): Promise<void> {
		const answered = await this.#act("respond", () => this.#founding.respond(this.profileId, accept));
		if (!answered) return;
		if (accept) this.#options.onSeatChanged?.();
		else this.#gone("declined");
	}

	/** The one who opened the table closes it once they sit there alone (the last member deletes). */
	async close(): Promise<boolean> {
		const closed = await this.#act("close", async () => {
			await this.#api.deleteProfile(this.profileId);
			return null;
		});
		if (closed) this.#gone("closed");
		return closed;
	}

	/** Safe to press twice, from two tabs or after a lost answer: the server keeps the first Start. Never on a
	 * table your last text save did not reach. */
	async start(): Promise<void> {
		if (!(await this.#editsSaved())) return;
		let clientStartId: string = crypto.randomUUID();
		try {
			const saved = sessionStorage.getItem(this.#startKey);
			if (saved && UUID_PATTERN.test(saved)) clientStartId = saved;
			else sessionStorage.setItem(this.#startKey, clientStartId);
		} catch {
			/* A blocked storage API keeps the id for this page only. */
		}
		const started = await this.#act("start", (table) =>
			this.#founding.start(this.profileId, table.revision, clientStartId),
		);
		if (!started) return;
		try {
			sessionStorage.setItem(cofounderArrivalKey(this.profileId), String(Date.now()));
		} catch {
			/* Without storage the arrival finds its moment from the thread itself. */
		}
	}

	dismissError(): void {
		this.store.set({ error: undefined });
	}

	openFriends(open: boolean): void {
		this.store.set({ friendsOpen: open, friendAdded: undefined, friendsError: undefined });
		if (open) void this.#loadFriends();
	}

	async #loadFriends(): Promise<void> {
		try {
			const friends = await this.#api.listFriends();
			if (!this.disposed) this.store.set({ friends, friendsError: undefined });
		} catch (error) {
			if (!this.disposed) this.store.set({ friendsError: describeError(error) });
		}
	}

	/** Not friends yet: a friend request; they can be invited once they accept. */
	async addFriend(email: string): Promise<boolean> {
		const address = email.trim();
		if (!address || this.store.get().addingFriend) return false;
		this.store.set({ addingFriend: true, friendsError: undefined, friendAdded: undefined });
		try {
			await this.#api.sendFriendRequest(address);
			if (this.disposed) return false;
			this.store.set({ friendAdded: address });
			await this.#loadFriends();
			return true;
		} catch (error) {
			if (!this.disposed) this.store.set({ friendsError: describeError(error) });
			return false;
		} finally {
			if (!this.disposed) this.store.set({ addingFriend: false });
		}
	}

	openConnect(open: boolean): void {
		if (!open) this.#closeConnections();
		this.store.set({ connectOpen: open });
		this.#schedule();
	}

	/** Your ChatGPT accounts for this company: the Settings panel, offering ChatGPT only. */
	connections(): ConnectionsView {
		if (this.#connections) return this.#connections;
		const signal = this.#lifetime.signal;
		const userId = this.userId;
		const currentUserId = this.#options.currentUserId;
		// As in Settings, a sign-in belongs to the member, not to this page: it goes on when the table
		// is left and stops only if the account changes.
		const signIn = createWebNativeSubscription(
			this.#api.cloud,
			this.profileId,
			userId,
			new AbortController().signal,
			() => {
				if (currentUserId() !== userId) throw new Error("The account changed.");
			},
		);
		this.#connections = new ConnectionsView(
			createWebNativeSubscription(this.#api.cloud, this.profileId, userId, signal, () => {
				signal.throwIfAborted();
				if (currentUserId() !== userId) throw new Error("The account changed.");
			}),
			signal,
			memberProviderSignIns(userId, this.profileId),
			(input) => signIn.beginProviderLogin(input),
			["openai"],
		);
		return this.#connections;
	}

	#closeConnections(): void {
		this.#connections?.dispose();
		this.#connections = undefined;
	}

	/** On the table's topic while it is open: once, unless the cloud has no presence for it. */
	#joinPresence(): void {
		if (this.#presence || this.#presenceOver || this.disposed) return;
		try {
			this.#presence = this.#api.joinFoundingPresence(this.profileId, {
				tabs: (tabs) => {
					this.#tabs = tabs;
					this.#showPresence();
				},
				live: (live) => this.#takeLive(live),
				health: (health) => {
					if (health === "unavailable") this.#presenceOver = true;
					if (this.disposed) return;
					const live = health === "connected";
					if (this.store.get().live !== live) this.store.set({ live });
				},
			});
		} catch {
			this.#presenceOver = true;
			return;
		}
		this.#presence.setState(!document.hidden, this.#myField);
	}

	/** Off the topic for good: the table started, you left it, or the page closed. */
	#leavePresence(): void {
		this.#presenceOver = true;
		const presence = this.#presence;
		this.#presence = undefined;
		void presence?.stop().catch(() => undefined);
		clearTimeout(this.#presenceTimer);
		clearTimeout(this.#sendTimer);
		clearTimeout(this.#repeatTimer);
		this.#sendTimer = undefined;
		this.#tabs = [];
		this.#lives.clear();
		if (
			!this.disposed &&
			(this.store.get().live || this.store.get().present?.length || this.store.get().liveText?.length)
		)
			this.store.set({ live: false, present: [], liveText: [] });
	}

	/** Another tab's words: only a founder's at this table, in a field they may write in (a role line is its own),
	 * and no longer than the field takes. */
	#takeLive(live: FoundingLive): void {
		if (this.disposed || live.userId === this.userId) return;
		const limit =
			live.field === "name"
				? FOUNDING_NAME_MAX_CHARACTERS
				: live.field === "role"
					? FOUNDING_ROLE_MAX_CHARACTERS
					: Number.POSITIVE_INFINITY;
		if ([...live.text].length > limit) return;
		const seat = this.store.get().table?.seats.find((item) => item.userId === live.userId);
		if (seat?.state !== "joined") return;
		const now = Date.now();
		const key = `${live.clientId}:${live.field}`;
		const prior = this.#lives.get(key);
		// Only changed words count as writing; a caret that moves keeps when they last wrote.
		const typedAt = live.typing ? now : (prior?.typedAt ?? 0);
		this.#lives.set(key, { live, seenAt: now, typedAt, leftAt: prior?.leftAt });
		this.#showPresence();
	}

	/** Who is here and what they write, from the tabs and their words; again when someone stops counting as writing,
	 * or their words have been held long enough after they left the field. */
	#showPresence(): void {
		clearTimeout(this.#presenceTimer);
		if (this.disposed) return;
		const table = this.store.get().table;
		if (!table || table.phase !== "open") return;
		const now = Date.now();
		const seats = new Map(table.seats.map((seat) => [seat.userId, seat]));
		const tabs = new Map(this.#tabs.map((tab) => [tab.clientId, tab]));
		let next = Number.POSITIVE_INFINITY;
		const writers = new Set<string>();
		const texts = new Map<string, FounderLive & { seenAt: number }>();
		for (const [entryKey, entry] of this.#lives) {
			const { live } = entry;
			// A tab that left the field, or the table, keeps its words a while: its save is on its way.
			if (tabs.get(live.clientId)?.field === live.field) entry.leftAt = undefined;
			else entry.leftAt ??= now;
			const writing = now - entry.typedAt < FOUNDING_WRITING_MS;
			const held = entry.leftAt === undefined || now - entry.leftAt < LIVE_HOLD_MS;
			if (seats.get(live.userId)?.state !== "joined" || (!writing && !held)) {
				this.#lives.delete(entryKey);
				continue;
			}
			if (writing) {
				writers.add(live.userId);
				next = Math.min(next, entry.typedAt + FOUNDING_WRITING_MS);
			}
			if (!held) continue;
			if (entry.leftAt !== undefined) next = Math.min(next, entry.leftAt + LIVE_HOLD_MS);
			const saved =
				live.field === "vision"
					? table.vision
					: live.field === "name"
						? table.companyName
						: (seats.get(live.userId)?.role ?? "");
			const key = `${live.userId}:${live.field}`;
			const prior = texts.get(key);
			if (prior && prior.seenAt > entry.seenAt) continue;
			texts.set(key, {
				userId: live.userId,
				field: live.field,
				text: live.text,
				caret: entry.leftAt === undefined ? live.caret : null,
				unsaved: live.own && live.text.trim() !== saved,
				typedAt: entry.typedAt,
				seenAt: entry.seenAt,
			});
		}
		const here = new Set(this.#tabs.filter((tab) => tab.visible).map((tab) => tab.userId));
		const people = new Set([...this.#tabs.map((tab) => tab.userId), ...writers]);
		const present = table.seats
			.filter((seat) => seat.userId !== this.userId && people.has(seat.userId))
			.map((seat) => ({ userId: seat.userId, here: here.has(seat.userId), writing: writers.has(seat.userId) }));
		const liveText = [...texts.values()]
			.sort((a, b) => b.typedAt - a.typedAt || b.seenAt - a.seenAt)
			.map(({ seenAt: _seenAt, ...live }) => live);
		const state = this.store.get();
		if (
			JSON.stringify(present) !== JSON.stringify(state.present ?? []) ||
			JSON.stringify(liveText) !== JSON.stringify(state.liveText ?? [])
		)
			this.store.set({ present, liveText });
		if (Number.isFinite(next))
			this.#presenceTimer = setTimeout(() => this.#showPresence(), Math.max(0, next - now) + 1);
	}

	/** The field you are writing in now, or none: the others see where you are. */
	noteField(field: FoundingField | null): void {
		if (this.#myField === field) return;
		// Your last words go before you leave the field, so the others hold all of them until your save shows.
		const pending = this.#pendingLive;
		if (pending) this.#presence?.sendLive(pending.field, pending.text, pending.caret, pending.typing, pending.own);
		this.#myField = field;
		this.#presence?.setState(!document.hidden, field);
		clearTimeout(this.#sendTimer);
		clearTimeout(this.#repeatTimer);
		this.#sendTimer = undefined;
		this.#pendingLive = undefined;
		this.#lastLive = undefined;
		this.#lastSentAt = 0;
	}

	/** Your words and caret in a field, for the others to follow as you write (a founder's only). `own`: the words
	 * are your edit, not the table's text or another writer's words your field follows. */
	noteLive(field: FoundingField, text: string, caret: number | null, typing: boolean, own: boolean): void {
		if (!this.#presence || this.store.get().table?.me.state !== "joined" || this.#myField !== field) return;
		// A keystroke not sent yet still counts when a caret move replaces it.
		const typed = typing || (this.#pendingLive?.field === field && this.#pendingLive.typing);
		this.#pendingLive = { field, text, caret, typing: typed, own };
		this.#sendLive();
	}

	#sendLive(): void {
		if (this.#sendTimer || !this.#pendingLive) return;
		const wait = this.#lastSentAt + LIVE_SEND_MS - Date.now();
		if (wait > 0) {
			this.#sendTimer = setTimeout(() => {
				this.#sendTimer = undefined;
				this.#sendLive();
			}, wait);
			return;
		}
		const live = this.#pendingLive;
		this.#pendingLive = undefined;
		this.#lastSentAt = Date.now();
		this.#presence?.sendLive(live.field, live.text, live.caret, live.typing, live.own);
		this.#lastLive = { ...live, typing: false };
		clearTimeout(this.#repeatTimer);
		this.#repeatTimer = setTimeout(() => {
			if (!this.#lastLive || this.#myField !== this.#lastLive.field) return;
			this.#pendingLive ??= this.#lastLive;
			this.#sendLive();
		}, LIVE_REPEAT_MS);
	}

	#gone(reason: NonNullable<FoundingState["gone"]>): void {
		clearTimeout(this.#timer);
		this.#closeConnections();
		this.#leavePresence();
		this.store.set({ gone: reason, connectOpen: false, friendsOpen: false, loading: false });
		this.#options.onSeatChanged?.();
	}
}

/** The lobby switched off (the rollback) refuses opening and starting with 0A000: say it as the hub does. */
export function lobbyError(error: unknown): string {
	return error instanceof CloudRpcError && error.code === "0A000"
		? t("Creating a company is paused. Try again later.")
		: describeError(error);
}
