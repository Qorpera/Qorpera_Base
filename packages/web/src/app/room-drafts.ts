import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import { type MessageQuote, sameQuotes } from "../cloud/quotes.ts";
import type { RealtimePhase } from "../cloud/realtime.ts";
import {
	DraftQuotesError,
	ROOM_DRAFT_BYTES,
	type RoomDraft,
	type RoomDraftSubscription,
	type RoomDraftWrite,
} from "../cloud/room-drafts.ts";
import { mergeQuoted } from "./quotes.ts";
import { Store } from "./state.ts";
import { applyEdit, diffText, type TextEdit, transform } from "./text-merge.ts";

/* Shared drafts in the browser. Every room this member opens shows the other
 * members' unsent messages; the member's own draft is written to the cloud as
 * they type, and any of them may open another's draft and write in it. Each
 * draft this browser edits has one DraftSync, which writes only from the
 * revision it last saw and, when someone else wrote first, merges its own
 * change into theirs and writes again. */

/** A change keeps showing as typing for this long. */
export const DRAFT_TYPING_MS = 4000;
/** Keystrokes within this long go to the cloud as one write. */
const WRITE_DELAY_MS = 300;
/** Unanswered writes are tried again after 0.5, 1, 2, 4, then every 8 seconds. */
const RETRY_MAX_MS = 8000;
/** How often a room re-reads its drafts: while live updates run, and while they do not. */
const LIVE_POLL_MS = 30_000;
const FALLBACK_POLL_MS = 4000;
/** How long a room stays subscribed after its last view closed, for a quick return. */
const LINGER_MS = 60_000;
/** A room that refused this member is asked again after this long (a refreshed token, a room made active again). */
const REFUSED_RETRY_MS = 60_000;

function wellFormed(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** Where this browser's text stands: in the cloud, not yet (tried again), too long to share, holding more quotes than
 * a message can, or holding a quote the cloud would not keep. */
export type DraftStatus = "saved" | "retrying" | "too-long" | "quote-limit" | "refused";

/** The cloud will not take the text as it is: it waits for the member to change it. */
const givenUp = (status: DraftStatus) => status === "too-long" || status === "quote-limit" || status === "refused";

export interface DraftHost {
	/** The text this browser shows for the draft. */
	text(): string;
	/** That text's quotes of outside content (app/quotes.ts); none when left out. */
	quotes?(): readonly MessageQuote[];
	/** Where the editor's caret stands in that text, when it has one. */
	caret(): number | undefined;
	/** Show the merged text and its quotes; `edit` turned the shown text into it. */
	show(text: string, edit: TextEdit, quotes: readonly MessageQuote[]): void;
	/** The draft is not there to edit any more. */
	gone(): void;
	/** The member is composing a letter (an input method); the text must not change under it. */
	busy?(): boolean;
	/** The text is written, is not reaching the cloud (tried again), or the cloud will not take it as it is. */
	status?(status: DraftStatus): void;
	/** A quote shown here gave way in a merge: the draft quotes the same words from another email (app/quotes.ts,
	 * mergeQuoted). */
	dropped?(): void;
}

/** A draft as the cloud confirmed it: its text and the quotes that text holds. */
export interface ConfirmedDraft {
	revision: number;
	body: string;
	quotes: readonly MessageQuote[];
}

export class DraftSync {
	readonly roomId: string;
	readonly ownerUserId: string;
	readonly #write: (base: number, body: string, quotes: readonly MessageQuote[]) => Promise<RoomDraftWrite>;
	readonly #written: (draft: RoomDraft) => void;
	#host: DraftHost;
	/** The draft as the cloud last confirmed it; every change of this browser is diffed from it. */
	#server: ConfirmedDraft;
	#writing = false;
	/** The newest draft the cloud announced while this browser could not merge it (writing, composing). */
	#newest: RoomDraft | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#failures = 0;
	#status: DraftStatus = "saved";
	#stopped = false;
	#settled: (() => void)[] = [];
	/** Its panel closed; it stops once what was typed there is written, unless it is opened again. */
	leaving = false;

	constructor(
		roomId: string,
		ownerUserId: string,
		start: { revision: number; body: string; quotes?: readonly MessageQuote[] },
		host: DraftHost,
		write: (base: number, body: string, quotes: readonly MessageQuote[]) => Promise<RoomDraftWrite>,
		written: (draft: RoomDraft) => void,
	) {
		this.roomId = roomId;
		this.ownerUserId = ownerUserId;
		this.#server = { revision: start.revision, body: start.body, quotes: start.quotes ?? [] };
		this.#host = host;
		this.#write = write;
		this.#written = written;
	}

	get revision(): number {
		return this.#server.revision;
	}

	/** The draft as the cloud last confirmed it. */
	get confirmed(): ConfirmedDraft {
		return { ...this.#server };
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	get status(): DraftStatus {
		return this.#status;
	}

	/** The last write did not reach the cloud; it is being tried again. */
	get failing(): boolean {
		return this.#status === "retrying";
	}

	/** Nothing of this browser's is on its way or waiting to go. */
	get settled(): boolean {
		return !this.#writing && !this.#timer && !this.#newest && this.#confirmed();
	}

	/** The text shown where this draft is edited now. */
	text(): string {
		return this.#host.text();
	}

	/** That text's quotes. */
	quotes(): readonly MessageQuote[] {
		return this.#host.quotes?.() ?? [];
	}

	/** The text shown here, and its quotes, are what the cloud last confirmed. */
	#confirmed(): boolean {
		return wellFormed(this.#host.text()) === this.#server.body && sameQuotes(this.quotes(), this.#server.quotes);
	}

	/** Edit the draft somewhere else from now on (the same draft opened again). */
	rehost(host: DraftHost): void {
		this.#host = host;
		this.leaving = false;
		host.status?.(this.#status);
	}

	/** The member changed the text here, or finished composing a letter. */
	changed(): void {
		// Words that arrived while the member composed a letter join now.
		this.#mergeHeld();
		this.#schedule(WRITE_DELAY_MS);
	}

	/** The cloud's draft moved: a live change, or a listing. */
	remote(draft: RoomDraft): void {
		if (this.#stopped || draft.revision <= this.#server.revision) return;
		if (this.#writing || this.#host.busy?.()) {
			if (!this.#newest || draft.revision > this.#newest.revision) this.#newest = draft;
			return;
		}
		this.#merge(draft);
	}

	/** Resolves once this browser's changes are written, or the draft is gone, or the cloud will not take the text. */
	flushed(): Promise<void> {
		if (this.#stopped || givenUp(this.#status) || this.settled) return Promise.resolve();
		return new Promise((resolve) => this.#settled.push(resolve));
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		for (const resolve of this.#settled.splice(0)) resolve();
	}

	#mergeHeld(): void {
		const newest = this.#newest;
		if (!newest || this.#writing || this.#host.busy?.()) return;
		this.#newest = undefined;
		if (newest.revision > this.#server.revision) this.#merge(newest);
	}

	/** Take the cloud's draft as the base and replay this browser's own change on it. Each quote merges as one piece
	 * (app/quotes.ts, mergeQuoted): kept, removed or replaced whole, never cut into bare words. */
	#merge(draft: { revision: number; body: string; quotes?: readonly MessageQuote[] }): void {
		const shown = this.#host.text();
		const mine = this.quotes();
		const merged = mergeQuoted(
			{ text: this.#server.body, quotes: this.#server.quotes },
			{ text: shown, quotes: mine },
			{ text: draft.body, quotes: draft.quotes ?? [] },
			this.#host.caret(),
		);
		this.#server = { revision: draft.revision, body: draft.body, quotes: draft.quotes ?? [] };
		if (!merged) {
			// No placeholder letter is free for every quote (thousands of private-use letters in the drafts): rather
			// than merge letter by letter, which can cut a quote, the text shown here stays as it is and replaces the
			// cloud's at the next write.
			this.#schedule(0);
			return;
		}
		if (merged.text !== shown || !sameQuotes(merged.quotes, mine))
			this.#host.show(merged.text, merged.edit, merged.quotes);
		if (merged.dropped) this.#host.dropped?.();
		if (!this.#confirmed()) this.#schedule(0);
	}

	#schedule(delay: number): void {
		if (this.#stopped || this.#writing || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush();
		}, delay);
	}

	#resolveSettled(): void {
		if (this.settled) for (const resolve of this.#settled.splice(0)) resolve();
	}

	#setStatus(status: DraftStatus): void {
		if (status === this.#status) return;
		this.#status = status;
		this.#host.status?.(status);
		// A text the cloud will not take is given up until the member changes it.
		if (givenUp(status)) for (const resolve of this.#settled.splice(0)) resolve();
	}

	async #flush(): Promise<void> {
		// A letter being composed is written once it is done (changed).
		if (this.#stopped || this.#writing || this.#host.busy?.()) return;
		this.#mergeHeld();
		const body = wellFormed(this.#host.text());
		const quotes = this.quotes();
		if (this.#confirmed()) {
			this.#setStatus("saved");
			this.#resolveSettled();
			return;
		}
		// The cloud takes as much as a message holds; a longer text waits for the member to shorten it.
		if (new TextEncoder().encode(body).length > ROOM_DRAFT_BYTES) {
			this.#setStatus("too-long");
			return;
		}
		this.#writing = true;
		let result: RoomDraftWrite | undefined;
		let refused: DraftStatus | undefined;
		try {
			result = await this.#write(this.#server.revision, body, quotes);
			this.#failures = 0;
		} catch (error) {
			// Refused or missing on this cloud: the draft is not this member's to write.
			if (error instanceof CloudRpcError && (error.denied || error.missing)) result = { status: "gone" };
			// The text itself was refused: trying it again cannot help. With quotes, it was the quotes the cloud would
			// not keep (a mail thread it no longer shows, say).
			else if (error instanceof CloudRpcError && error.code === "22023") refused = quotes.length ? "refused" : "too-long";
			// Quotes this browser can't send as they are (more than a message carries) fail the same way every time.
			else if (error instanceof DraftQuotesError) refused = error.tooMany ? "quote-limit" : "refused";
			else this.#failures += 1;
		} finally {
			this.#writing = false;
		}
		if (this.#stopped) return;
		if (refused) {
			this.#setStatus(refused);
			return;
		}
		this.#setStatus(result ? "saved" : "retrying");
		if (!result) {
			// Unanswered: the text stays here and goes again, for as long as it takes.
			this.#schedule(Math.min(RETRY_MAX_MS, 500 * 2 ** (this.#failures - 1)));
			return;
		}
		if (result.status === "gone") {
			this.stop();
			this.#host.gone();
			return;
		}
		this.#written(result.draft);
		let head = this.#newest;
		this.#newest = undefined;
		if (result.status === "ok") {
			this.#server = {
				revision: result.draft.revision,
				body: result.draft.body,
				quotes: result.draft.quotes ?? [],
			};
			if (head && head.revision <= this.#server.revision) head = undefined;
		} else if (!head || result.draft.revision >= head.revision) head = result.draft;
		if (head) {
			if (this.#host.busy?.()) {
				// Merged, and written, once the member's letter is done (changed).
				this.#newest = head;
				return;
			}
			// A stale answer is the cloud's draft now, even at a revision this browser thought it had passed.
			this.#merge(head);
		}
		if (!this.#confirmed()) this.#schedule(WRITE_DELAY_MS);
		else this.#resolveSettled();
	}
}

export interface RoomDraftsState {
	/** Every draft of the room this member may see, the own one included. */
	drafts: readonly RoomDraft[];
	/** When each owner's draft last changed while this browser watched, and by whom. */
	activity: Readonly<Record<string, { editorUserId: string; at: number }>>;
	phase: RealtimePhase;
	/** The room shares no drafts with this member (refused, or not on this cloud). */
	unavailable: boolean;
}

/** One room's drafts: live changes, a listing now and then, and the syncs of the
 * drafts this browser edits there. */
export class RoomDraftRoom {
	readonly roomId: string;
	readonly store = new Store<RoomDraftsState>({ drafts: [], activity: {}, phase: "stopped", unavailable: false });
	readonly #api: CloudApi;
	readonly #signal: AbortSignal;
	readonly #missing: () => void;
	readonly syncs = new Map<string, DraftSync>();
	#subscription: RoomDraftSubscription | undefined;
	#closing: Promise<void> | undefined;
	#refs = 0;
	#linger: ReturnType<typeof setTimeout> | undefined;
	#poll: ReturnType<typeof setTimeout> | undefined;
	#listing = 0;
	/** Counts every draft change taken in; a listing drops only drafts untouched since it was asked for. */
	#changes = 0;
	readonly #touched = new Map<string, number>();
	/** The newest version of each owner's draft taken in, kept after the draft leaves the list,
	 * so a late, older announcement never brings back what was already replaced. */
	readonly #seen = new Map<string, { revision: number; at: number }>();
	/** When a refused room may be asked again; never, when the cloud has no shared drafts. */
	#retryAt = 0;

	constructor(api: CloudApi, roomId: string, signal: AbortSignal, missing: () => void) {
		this.#api = api;
		this.roomId = roomId;
		this.#signal = signal;
		this.#missing = missing;
		signal.addEventListener("abort", () => this.#close(), { once: true });
	}

	draft(ownerUserId: string): RoomDraft | undefined {
		return this.store.get().drafts.find((draft) => draft.ownerUserId === ownerUserId);
	}

	/** A view shows this room; the returned function says it stopped. */
	watch(): () => void {
		this.#refs += 1;
		clearTimeout(this.#linger);
		this.#linger = undefined;
		void this.#open();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#refs -= 1;
			if (this.#refs === 0) this.#linger = setTimeout(() => this.#close(), LINGER_MS);
		};
	}

	/** The room shares drafts with this member now. A refused room is asked again after a while. */
	usable(): boolean {
		const state = this.store.get();
		if (state.unavailable && Number.isFinite(this.#retryAt) && Date.now() >= this.#retryAt)
			this.store.set({ unavailable: false });
		return !this.store.get().unavailable;
	}

	/** A draft as the cloud now has it: shown, and handed to the sync editing it.
	 * `live`: a change announced as it happened; `listing`: read back; `own`: this browser wrote it. */
	apply(draft: RoomDraft, source: "live" | "listing" | "own"): void {
		if (this.#signal.aborted) return;
		// Newer: a later revision, or a draft started again after the old one was cleared away.
		const seen = this.#seen.get(draft.ownerUserId);
		const at = Date.parse(draft.updatedAt);
		if (seen && draft.revision <= seen.revision && at <= seen.at) return;
		this.#seen.set(draft.ownerUserId, { revision: draft.revision, at });
		this.#touched.set(draft.ownerUserId, ++this.#changes);
		const current = this.draft(draft.ownerUserId);
		const changed = current ? current.body !== draft.body : Boolean(draft.body);
		// Someone is typing: a live change, or a listing that moved a draft already shown.
		// This browser's own writes are not news to it.
		const typing = changed && source !== "own" && (source === "live" || current !== undefined);
		this.store.set((state) => ({
			drafts: [...state.drafts.filter((item) => item.ownerUserId !== draft.ownerUserId), draft],
			activity: typing
				? { ...state.activity, [draft.ownerUserId]: { editorUserId: draft.editorUserId, at: Date.now() } }
				: state.activity,
		}));
		if (source !== "own") this.syncs.get(draft.ownerUserId)?.remote(draft);
	}

	async refresh(): Promise<void> {
		if (this.#signal.aborted || this.store.get().unavailable) return;
		const listing = ++this.#listing;
		const asked = this.#changes;
		try {
			const drafts = await this.#api.listRoomDrafts(this.roomId);
			if (this.#signal.aborted || listing !== this.#listing) return;
			for (const draft of drafts) this.apply(draft, "listing");
			// Drafts the listing no longer carries (sent, abandoned, their owner left) leave the room,
			// unless they changed after the listing was asked for (a first write racing it).
			const listed = new Set(drafts.map((draft) => draft.ownerUserId));
			const keep = (draft: RoomDraft) =>
				listed.has(draft.ownerUserId) || (this.#touched.get(draft.ownerUserId) ?? 0) > asked;
			if (!this.store.get().drafts.every(keep)) this.store.set((state) => ({ drafts: state.drafts.filter(keep) }));
		} catch (error) {
			if (this.#signal.aborted) return;
			if (error instanceof CloudRpcError && (error.missing || error.denied)) {
				this.#retryAt = error.missing ? Number.POSITIVE_INFINITY : Date.now() + REFUSED_RETRY_MS;
				this.store.set({ unavailable: true });
				if (error.missing) this.#missing();
				this.#close();
			}
		}
	}

	async #open(): Promise<void> {
		if (this.#subscription || this.#signal.aborted || this.store.get().unavailable) return;
		// Supabase hands out one channel per topic: wait for a closing one to be gone.
		await this.#closing;
		if (this.#subscription || this.#signal.aborted || this.#refs === 0) return;
		this.#subscription = this.#api.subscribeRoomDrafts(
			this.roomId,
			(draft) => this.apply(draft, "live"),
			(phase) => {
				if (this.#signal.aborted) return;
				const was = this.store.get().phase;
				this.store.set({ phase });
				// Changes made before the topic joined are read once it has.
				if (phase === "connected" && was !== "connected") void this.refresh();
				this.#schedulePoll();
			},
		);
		void this.refresh();
		this.#schedulePoll();
	}

	#schedulePoll(): void {
		clearTimeout(this.#poll);
		if (!this.#subscription || this.#signal.aborted) return;
		this.#poll = setTimeout(
			() => {
				if (typeof document === "undefined" || !document.hidden) void this.refresh();
				this.#schedulePoll();
			},
			this.store.get().phase === "connected" ? LIVE_POLL_MS : FALLBACK_POLL_MS,
		);
	}

	#close(): void {
		clearTimeout(this.#linger);
		clearTimeout(this.#poll);
		this.#linger = undefined;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		if (subscription) this.#closing = subscription.stop().catch(() => {});
		if (this.#signal.aborted) for (const sync of this.syncs.values()) sync.stop();
		if (!this.#signal.aborted) this.store.set({ phase: "stopped" });
	}
}

/** What a view says about the member's own draft: where it stands, or that a quote gave way in a merge. */
export type OwnDraftNote = { readonly kind: "status"; readonly status: DraftStatus } | { readonly kind: "dropped" };

export interface DraftEditor {
	caret(): number | undefined;
	busy(): boolean;
}

export interface RoomDraftsHooks {
	/** The room behind a conversation, when its drafts are shared: another
	 * member can post there and this member can write. */
	sharedRoom(sessionId: string): string | undefined;
	draft(sessionId: string): string;
	/** The draft's quotes of outside content (app/quotes.ts). */
	quotes(sessionId: string): readonly MessageQuote[];
	setDraft(sessionId: string, text: string, quotes: readonly MessageQuote[]): void;
}

/** The company's shared drafts, for this member. */
export class RoomDrafts {
	readonly #api: CloudApi;
	readonly #userId: string;
	readonly #signal: AbortSignal;
	readonly #hooks: RoomDraftsHooks;
	readonly #rooms = new Map<string, RoomDraftRoom>();
	/** Views keep a member's caret in place when another member's words arrive. */
	readonly #shown = new Map<string, Set<(text: string, edit: TextEdit) => void>>();
	/** Edits other members made to a draft while it was being sent, by conversation. */
	readonly #sending = new Map<string, TextEdit[]>();
	/** The composer of each conversation a view shows: its caret, and whether a letter is being composed. */
	readonly #editors = new Map<string, DraftEditor>();
	/** Views that say what became of the member's own draft: the cloud would not take it, or a quote gave way. */
	readonly #ownNotes = new Map<string, Set<(note: OwnDraftNote) => void>>();
	#missing = false;

	constructor(api: CloudApi, userId: string, signal: AbortSignal, hooks: RoomDraftsHooks) {
		this.#api = api;
		this.#userId = userId;
		this.#signal = signal;
		this.#hooks = hooks;
	}

	get userId(): string {
		return this.#userId;
	}

	/** The conversation's room, when drafts are shared there. */
	room(sessionId: string): RoomDraftRoom | undefined {
		if (this.#missing || this.#signal.aborted) return undefined;
		const roomId = this.#hooks.sharedRoom(sessionId);
		if (!roomId) return undefined;
		let room = this.#rooms.get(roomId);
		if (!room) {
			room = new RoomDraftRoom(this.#api, roomId, this.#signal, () => {
				this.#missing = true;
			});
			this.#rooms.set(roomId, room);
			const own = room;
			// The member's own draft follows the cloud's, even before they type here.
			own.store.subscribe((state) => {
				const draft = state.drafts.find((item) => item.ownerUserId === this.#userId);
				if (draft && !own.syncs.has(this.#userId)) {
					const session = this.#sessionFor(own.roomId);
					if (session) this.#own(session, own)?.remote(draft);
				}
			});
		}
		return room.usable() ? room : undefined;
	}

	/** A view shows the conversation: its room's drafts are followed live. */
	watch(sessionId: string, editor: DraftEditor): (() => void) | undefined {
		const room = this.room(sessionId);
		if (!room) return undefined;
		this.#editors.set(sessionId, editor);
		const release = room.watch();
		return () => {
			if (this.#editors.get(sessionId) === editor) this.#editors.delete(sessionId);
			release();
		};
	}

	/** Called with the new text and the edit that made it, before the conversation's draft changes. */
	onShown(sessionId: string, listener: (text: string, edit: TextEdit) => void): () => void {
		let listeners = this.#shown.get(sessionId);
		if (!listeners) {
			listeners = new Set();
			this.#shown.set(sessionId, listeners);
		}
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Called when the member's own draft here can't be shared as it is, can again, or lost a quote in a merge. */
	onOwnDraft(sessionId: string, listener: (note: OwnDraftNote) => void): () => void {
		let listeners = this.#ownNotes.get(sessionId);
		if (!listeners) {
			listeners = new Set();
			this.#ownNotes.set(sessionId, listeners);
		}
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Where the member's own draft here stands. */
	ownStatus(sessionId: string): DraftStatus {
		const room = this.room(sessionId);
		const sync = room?.syncs.get(this.#userId);
		return sync && !sync.stopped ? sync.status : "saved";
	}

	/** The member typed in their own composer. */
	input(sessionId: string): void {
		const room = this.room(sessionId);
		if (room) this.#own(sessionId, room)?.changed();
	}

	/** The member pressed Send with `text`. Other members' words arriving meanwhile are kept apart. */
	sending(sessionId: string): void {
		if (this.room(sessionId)) this.#sending.set(sessionId, []);
	}

	/** The message went, or did not: what stays in the composer. Words another member added
	 * while it was on its way stay; the member's own sent text goes. */
	sent(sessionId: string, text: string, current: string, delivered: boolean): string {
		const edits = this.#sending.get(sessionId);
		this.#sending.delete(sessionId);
		if (!delivered) return current;
		if (!edits) return current === text ? "" : current;
		let own: TextEdit = diffText(text, "");
		try {
			for (const edit of edits) own = transform(own, edit)[0];
			return applyEdit(current, own);
		} catch {
			return current === text ? "" : current;
		}
	}

	/** After `sent` changed the conversation's draft: write it. */
	settle(sessionId: string): void {
		const room = this.room(sessionId);
		if (room) this.#own(sessionId, room)?.changed();
	}

	/** Open another member's draft to write in it, starting from `text` and its quotes. Nothing here sends it. */
	edit(
		sessionId: string,
		ownerUserId: string,
		host: DraftHost,
	): { sync: DraftSync; text: string; quotes: readonly MessageQuote[] } | undefined {
		const room = this.room(sessionId);
		const draft = room?.draft(ownerUserId);
		if (!room || !draft || ownerUserId === this.#userId) return undefined;
		// Opened again while what was typed the last time is still on its way: carry on with it.
		const current = room.syncs.get(ownerUserId);
		if (current && !current.stopped) {
			const text = current.text();
			const quotes = current.quotes();
			current.rehost(host);
			return { sync: current, text, quotes };
		}
		const sync = new DraftSync(
			room.roomId,
			ownerUserId,
			draft,
			host,
			(base, body, quotes) => this.#api.putRoomDraft(room.roomId, ownerUserId, base, body, quotes),
			(written) => room.apply(written, "own"),
		);
		room.syncs.set(ownerUserId, sync);
		return { sync, text: draft.body, quotes: draft.quotes ?? [] };
	}

	/** Stop editing another member's draft once what was typed there is written. */
	async leave(sync: DraftSync): Promise<void> {
		sync.leaving = true;
		await sync.flushed();
		// Opened again meanwhile: the new panel carries on with it.
		if (!sync.leaving) return;
		sync.stop();
		const room = this.#rooms.get(sync.roomId);
		if (room?.syncs.get(sync.ownerUserId) === sync) room.syncs.delete(sync.ownerUserId);
	}

	#sessionFor(roomId: string): string | undefined {
		for (const sessionId of this.#editors.keys()) if (this.#hooks.sharedRoom(sessionId) === roomId) return sessionId;
		return undefined;
	}

	#own(sessionId: string, room: RoomDraftRoom): DraftSync | undefined {
		const existing = room.syncs.get(this.#userId);
		if (existing && !existing.stopped) return existing;
		// Started again (the draft was gone): from what the cloud last confirmed, never from nothing,
		// which would add the whole composer to it once more. A first start takes the cloud's draft
		// in as a change (a reloaded browser gets it back).
		const sync = new DraftSync(
			room.roomId,
			this.#userId,
			existing?.confirmed ?? { revision: 0, body: "" },
			{
				text: () => this.#hooks.draft(sessionId),
				quotes: () => this.#hooks.quotes(sessionId),
				caret: () => this.#editors.get(sessionId)?.caret(),
				busy: () => this.#editors.get(sessionId)?.busy() ?? false,
				show: (text, edit, quotes) => {
					this.#sending.get(sessionId)?.push(edit);
					for (const listener of this.#shown.get(sessionId) ?? []) listener(text, edit);
					this.#hooks.setDraft(sessionId, text, quotes);
				},
				gone: () => {},
				// A refusal is said beside the member's own composer, not only in a teammate's panel.
				status: (status) => {
					for (const listener of this.#ownNotes.get(sessionId) ?? []) listener({ kind: "status", status });
				},
				dropped: () => {
					for (const listener of this.#ownNotes.get(sessionId) ?? []) listener({ kind: "dropped" });
				},
			},
			(base, body, quotes) => this.#api.putRoomDraft(room.roomId, this.#userId, base, body, quotes),
			(written) => room.apply(written, "own"),
		);
		room.syncs.set(this.#userId, sync);
		const known = room.draft(this.#userId);
		if (known) sync.remote(known);
		return sync;
	}
}
