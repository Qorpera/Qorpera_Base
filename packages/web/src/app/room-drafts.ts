import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import type { RealtimePhase } from "../cloud/realtime.ts";
import type { RoomDraft, RoomDraftSubscription, RoomDraftWrite } from "../cloud/room-drafts.ts";
import { Store } from "./state.ts";
import { applyEdit, diffText, mergeText, type TextEdit, transform } from "./text-merge.ts";

/* Shared drafts in the browser. Every room this member opens shows the other
 * members' unsent messages; the member's own draft is written to the cloud as
 * they type, and any of them may open another's draft and write in it. Each
 * draft this browser edits has one DraftSync, which writes only from the
 * revision it last saw and, when someone else wrote first, merges its own
 * change into theirs and writes again. */

/** A change keeps showing as typing for this long. */
export const DRAFT_TYPING_MS = 4000;
/** Keystrokes within this long go to the cloud as one write. */
const WRITE_DELAY_MS = 120;
/** How often a room re-reads its drafts: while live updates run, and while they do not. */
const LIVE_POLL_MS = 30_000;
const FALLBACK_POLL_MS = 4000;
/** How long a room stays subscribed after its last view closed, for a quick return. */
const LINGER_MS = 60_000;

function wellFormed(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

export interface DraftHost {
	/** The text this browser shows for the draft. */
	text(): string;
	/** Where the editor's caret stands in that text, when it has one. */
	caret(): number | undefined;
	/** Show the merged text; `edit` turned the shown text into it. */
	show(text: string, edit: TextEdit): void;
	/** The draft is not there to edit any more. */
	gone(): void;
	/** The member is composing a letter (an input method); the text must not change under it. */
	busy?(): boolean;
}

export class DraftSync {
	readonly roomId: string;
	readonly ownerUserId: string;
	readonly #write: (base: number, body: string) => Promise<RoomDraftWrite>;
	readonly #written: (draft: RoomDraft) => void;
	readonly #host: DraftHost;
	/** The draft as the cloud last confirmed it; every change of this browser is diffed from it. */
	#server: { revision: number; body: string };
	#writing = false;
	/** The newest draft the cloud announced while a write was on its way. */
	#newest: RoomDraft | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#failures = 0;
	#stopped = false;
	#settled: (() => void)[] = [];

	constructor(
		roomId: string,
		ownerUserId: string,
		start: { revision: number; body: string },
		host: DraftHost,
		write: (base: number, body: string) => Promise<RoomDraftWrite>,
		written: (draft: RoomDraft) => void,
	) {
		this.roomId = roomId;
		this.ownerUserId = ownerUserId;
		this.#server = { ...start };
		this.#host = host;
		this.#write = write;
		this.#written = written;
	}

	get revision(): number {
		return this.#server.revision;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/** Nothing of this browser's is on its way or waiting to go. */
	get settled(): boolean {
		return !this.#writing && !this.#timer && wellFormed(this.#host.text()) === this.#server.body;
	}

	/** The member changed the text here. */
	changed(): void {
		// Words that arrived while the member composed a letter join now.
		const newest = this.#newest;
		if (newest && !this.#writing && !this.#host.busy?.()) {
			this.#newest = undefined;
			if (newest.revision > this.#server.revision) this.#merge(newest);
		}
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

	/** Resolves once this browser's changes are written, or given up. */
	flushed(): Promise<void> {
		if (this.#stopped || this.settled) return Promise.resolve();
		return new Promise((resolve) => this.#settled.push(resolve));
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		for (const resolve of this.#settled.splice(0)) resolve();
	}

	#merge(draft: { revision: number; body: string }): void {
		const shown = this.#host.text();
		const { text, edit } = mergeText(this.#server.body, shown, draft.body, this.#host.caret());
		this.#server = { revision: draft.revision, body: draft.body };
		if (text !== shown) this.#host.show(text, edit);
		if (wellFormed(text) !== draft.body) this.#schedule(0);
	}

	#schedule(delay: number): void {
		if (this.#stopped || this.#writing || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush();
		}, delay);
	}

	async #flush(): Promise<void> {
		if (this.#stopped || this.#writing) return;
		const body = wellFormed(this.#host.text());
		if (body === this.#server.body) {
			for (const resolve of this.#settled.splice(0)) resolve();
			return;
		}
		this.#writing = true;
		let result: RoomDraftWrite | undefined;
		try {
			result = await this.#write(this.#server.revision, body);
			this.#failures = 0;
		} catch (error) {
			this.#failures += 1;
			// Refused or missing on this cloud: nothing to retry.
			if (error instanceof CloudRpcError && (error.denied || error.missing)) result = { status: "gone" };
		} finally {
			this.#writing = false;
		}
		if (this.#stopped) return;
		if (!result) {
			// Unanswered: the text stays here, and goes again a little later.
			if (this.#failures > 6) this.stop();
			else this.#schedule(Math.min(8000, 500 * 2 ** this.#failures));
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
		if (result.status === "ok") this.#server = { revision: result.draft.revision, body: result.draft.body };
		else if (!head || result.draft.revision > head.revision) head = result.draft;
		if (head && head.revision > this.#server.revision) {
			if (this.#host.busy?.()) {
				// Merged, and written, once the member's letter is done (changed).
				this.#newest = head;
				return;
			}
			this.#merge(head);
		}
		if (wellFormed(this.#host.text()) !== this.#server.body) this.#schedule(WRITE_DELAY_MS);
		else for (const resolve of this.#settled.splice(0)) resolve();
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

	/** A draft as the cloud now has it: shown, and handed to the sync editing it.
	 * `live`: a change announced as it happened; `listing`: read back; `own`: this browser wrote it. */
	apply(draft: RoomDraft, source: "live" | "listing" | "own"): void {
		if (this.#signal.aborted) return;
		const current = this.draft(draft.ownerUserId);
		if (current && current.revision >= draft.revision) return;
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
		try {
			const drafts = await this.#api.listRoomDrafts(this.roomId);
			if (this.#signal.aborted || listing !== this.#listing) return;
			for (const draft of drafts) this.apply(draft, "listing");
			// Drafts the listing no longer carries (sent, abandoned, their owner left) leave the room.
			const listed = new Set(drafts.map((draft) => draft.ownerUserId));
			if (this.store.get().drafts.some((draft) => !listed.has(draft.ownerUserId)))
				this.store.set((state) => ({ drafts: state.drafts.filter((draft) => listed.has(draft.ownerUserId)) }));
		} catch (error) {
			if (this.#signal.aborted) return;
			if (error instanceof CloudRpcError && (error.missing || error.denied)) {
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

export interface DraftEditor {
	caret(): number | undefined;
	busy(): boolean;
}

export interface RoomDraftsHooks {
	/** The room behind a conversation, when its drafts are shared: another
	 * member can post there and this member can write. */
	sharedRoom(sessionId: string): string | undefined;
	draft(sessionId: string): string;
	setDraft(sessionId: string, text: string): void;
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
		return room.store.get().unavailable ? undefined : room;
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

	/** Open another member's draft to write in it. Nothing here sends it. */
	edit(sessionId: string, ownerUserId: string, host: DraftHost): DraftSync | undefined {
		const room = this.room(sessionId);
		const draft = room?.draft(ownerUserId);
		if (!room || !draft || ownerUserId === this.#userId) return undefined;
		// A sync still writing what was typed the last time finishes on its own (leave).
		const sync = new DraftSync(
			room.roomId,
			ownerUserId,
			draft,
			host,
			(base, body) => this.#api.putRoomDraft(room.roomId, ownerUserId, base, body),
			(written) => room.apply(written, "own"),
		);
		room.syncs.set(ownerUserId, sync);
		return sync;
	}

	/** Stop editing another member's draft once what was typed there is written. */
	async leave(sync: DraftSync): Promise<void> {
		await sync.flushed();
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
		const sync = new DraftSync(
			room.roomId,
			this.#userId,
			{ revision: 0, body: "" },
			{
				text: () => this.#hooks.draft(sessionId),
				caret: () => this.#editors.get(sessionId)?.caret(),
				busy: () => this.#editors.get(sessionId)?.busy() ?? false,
				show: (text, edit) => {
					this.#sending.get(sessionId)?.push(edit);
					for (const listener of this.#shown.get(sessionId) ?? []) listener(text, edit);
					this.#hooks.setDraft(sessionId, text);
				},
				gone: () => {},
			},
			(base, body) => this.#api.putRoomDraft(room.roomId, this.#userId, base, body),
			(written) => room.apply(written, "own"),
		);
		room.syncs.set(this.#userId, sync);
		const known = room.draft(this.#userId);
		if (known) sync.remote(known);
		return sync;
	}
}
