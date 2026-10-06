import { randomUUID, timingSafeEqual } from "node:crypto";
import { companyStatePath } from "@qorpera/cloud-client/company-state-files";
import { memberFolderStructured } from "../member-folder-commits.ts";
import {
	type CommitAnswer,
	type ConflictCopy,
	CoreRefusal,
	type FeedCursor,
	type FolderActor,
	type FolderCore,
} from "./core.ts";
import type { Grant, MountGrants } from "./mounts.ts";
import { type NasObjects, ObjectIntegrityError, ObjectUnavailableError } from "./objects.ts";
import { CHUNK_BYTES, type ChunkRef, type FileRef, type PendingFile, PendingView, PublishFirst } from "./pending.ts";
import { type BoundaryPlan, type CommitUnit, planBoundary } from "./plan.ts";
import {
	type BridgeInfo,
	type ChunkPart,
	ErrorCode,
	type Hello,
	LIST_PAGE,
	MAX_PAYLOAD,
	type OpenRequest,
	ProtocolError,
	type ReadRequest,
	type RenameRequest,
	type SearchRequest,
	type WireEntry,
} from "./protocol.ts";
import { type SearchAnswer, searchView } from "./search.ts";
import { type FolderStaging, mediaTypeOf, type Upload } from "./staging.ts";
import { nameOf, type TreeEntry, ViewTree } from "./view-tree.ts";

/** What a machine's feed connection is sent. */
export interface ChangeMessage {
	readonly seq: number;
	readonly resync: boolean;
	readonly paths: readonly string[];
}

export interface FeedSink {
	change(message: ChangeMessage): void;
	/** The view is closed: tell the machine and end the connection. */
	closed(code: ErrorCode, message: string): void;
}

export interface FolderServiceOptions {
	readonly core: FolderCore;
	readonly objects: NasObjects;
	readonly grants: MountGrants;
	/** Writes through the mount (F3 step 3): without it every view is read-only. */
	readonly staging?: FolderStaging;
	/** How often the folder clocks are read. A change shows on machines within about this plus one feed call. */
	readonly pollMs?: number;
	/** How often each view is listed again in full: grant expiry is on no feed (proposal P4 in the design note). */
	readonly reloadMs?: number;
	/** How long a view with no connection is kept before its tree is dropped. */
	readonly idleMs?: number;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

/** More changed paths than this in one push, or a message too large for one frame: the machine is told to drop
 * everything instead. */
const RESYNC_OVER = 5_000;
/** Replaced versions of one path kept readable for files opened before (an engineering bound on memory: a file
 * opened that many versions ago reads ESTALE). They go when the path leaves the view. */
const SUPERSEDED_PER_PATH = 16;
/** The machine's folder program treats 45 s without a frame as a dead link. */
const HEARTBEAT_MS = 15_000;
/** A core view's lease is 120 s; it is renewed every 40 s while a machine is connected (C1b-3a). */
const RENEW_MS = 40_000;
const LEASE_MS = 120_000;
/** A chunk's own intent lasts 15 minutes and a file's sealed one an hour; each is renewed after 10 while its file is
 * pending (C1D §3.5). */
const INTENT_RENEW_MS = 10 * 60_000;
/** Files staged at once at a boundary (step 0: 12 small files a second to the NAS one at a time, 67 with eight). */
const STAGING_PARALLEL = 8;

/** One changed path's outcome at a boundary (RUNTIME-FOLDER-WRITES.md, "Outcomes and the report"). */
export interface ReportEntry {
	readonly path: string;
	readonly outcome: "saved" | "conflict" | "refused" | "denied" | "waiting_for_review" | "not_applied" | "waiting";
	readonly reason?: string;
	/** A conflict's receipt: the change set that keeps this view's version (P17). */
	readonly receipt?: string;
	/** The change is still pending in this view. */
	readonly kept?: boolean;
}

export interface Report {
	/** The change set's id, when one was committed. */
	readonly commitId: string | null;
	readonly seq: number | null;
	readonly paths: readonly ReportEntry[];
}

/** A chunk being streamed from a machine to the gateway. */
interface ChunkUpload {
	readonly sha256: string;
	readonly bytes: number;
	next: number;
	readonly upload: Upload | undefined;
}

/** An intent that roots bytes of a file the view holds pending (C1D §3.5): a chunk's own, or the file's sealed one. It
 * is renewed while those bytes are still needed (by the file as it is, by what an abandoned handle would restore, or by
 * a boundary not settled yet); one the core lets lapse is replaced (a chunk is held again from the share, a file is
 * staged again at the next boundary). */
interface HeldIntent {
	renewed: number;
	readonly node: PendingFile;
	readonly chunk?: { readonly sha256: string; readonly bytes: number };
	readonly staged?: FileRef;
}

/** A boundary the core answered, while the view waits for the feed to bring its change set: until then the view keeps
 * its pending changes as they were, and nothing changes (BUSY). */
interface Settlement {
	readonly plan: BoundaryPlan;
	readonly made: ReadonlyMap<string, string>;
	readonly answer: CommitAnswer;
	readonly keep: ReadonlySet<string>;
	readonly saved: ReadonlySet<string>;
}

class View {
	readonly key: string;
	readonly environmentId: string;
	/** An operator mount's actor; a core view's is built from its lease (`actor`), so no copy of its pass is kept. */
	readonly #operator: FolderActor | undefined;
	readonly passSha256: Buffer;
	/** A core view's id and pass, for renewals; dropped when the view closes. */
	lease: Grant["lease"];
	/** Until when the core confirmed a core view's lease (ms). Past it, nothing is served until a renewal succeeds. */
	leaseUntil: number | undefined;
	/** The pass was checked: an operator mount's by its configured hash, a core view's by the core (first listing and
	 * renewal). Until then another pass may replace the view; after, it is refused. */
	confirmed: boolean;
	tree: ViewTree | undefined;
	seq = 0;
	cursor: FeedCursor | null = null;
	loading: Promise<void> | undefined;
	/** One feed advance or reload at a time, and at most one more waiting. */
	work: Promise<void> = Promise.resolve();
	queued = false;
	lastError: string | undefined;
	readonly sinks = new Set<FeedSink>();
	connections = 0;
	idleSince: number | undefined;
	loadedAt = 0;
	closed: string | undefined;
	/** Versions replaced on the feed, still readable by files opened before; newest last. */
	readonly superseded = new Map<string, TreeEntry[]>();
	/** The view may write (step 3: an operator mount configured so). */
	readonly write: boolean;
	readonly quietMs: number | undefined;
	/** Its pending changes, once listed (a writable view only). */
	pending: PendingView | undefined;
	quiet: ReturnType<typeof setTimeout> | undefined;
	/** One boundary at a time. */
	publishing: Promise<Report> = Promise.resolve({ commitId: null, seq: null, paths: [] });
	/** A boundary whose commit got no answer: asked again, unchanged, before the next one. */
	unanswered:
		| {
				readonly key: string;
				readonly units: readonly CommitUnit[];
				readonly plan: BoundaryPlan;
				readonly made: ReadonlyMap<string, string>;
		  }
		| undefined;
	/** A boundary answered but not settled yet (the feed has not brought its change set). */
	unsettled: Settlement | undefined;
	/** What this view's saves published, by path, newest last (as many as the readable versions kept per path): the
	 * version a save made while pending (the one the machine's version map holds after it) and the version its change
	 * set gave the path. */
	readonly published = new Map<string, { readonly made: string; readonly live: string }[]>();
	readonly uploads = new Map<string, ChunkUpload>();
	/** The intents that root the bytes of its pending files, by id. */
	readonly intents = new Map<string, HeldIntent>();
	/** The write handles open on the view. The machine's program pools its connections, so any of them may use a
	 * handle; they are abandoned when the view's last connection ends. */
	readonly handles = new Set<number>();

	constructor(grant: Grant) {
		this.key = grant.key;
		this.environmentId = grant.environmentId;
		this.#operator = grant.lease ? undefined : grant.actor;
		this.passSha256 = grant.passSha256;
		this.lease = grant.lease;
		this.leaseUntil = undefined;
		this.confirmed = grant.lease === undefined;
		this.write = grant.write;
		this.quietMs = grant.quietMs;
	}

	/** A core view (a run's own, opened by the core), closed or not; an operator mount's view is not. */
	get core(): boolean {
		return this.#operator === undefined;
	}

	/** Who the core reads as. A core view's actor carries its pass, so it exists only while the view does. */
	get actor(): FolderActor {
		if (this.#operator) return this.#operator;
		if (!this.lease) throw new ProtocolError(ErrorCode.viewClosed, this.closed ?? "The view is closed");
		return { kind: "view", viewId: this.lease.viewId, pass: this.lease.pass };
	}
}

/** A machine's open view, as one connection holds it. */
export interface ViewHandle {
	readonly asOfSeq: number;
	/** The view takes writes (protocol 2). */
	readonly writable: boolean;
	list(path: string, after: string | undefined): Promise<{ entries: readonly WireEntry[]; next: string | null }>;
	read(request: ReadRequest): Promise<Buffer>;
	/** One page of a search over the view (F3 `company_search`). */
	search(request: SearchRequest): Promise<SearchAnswer>;
	subscribe(sink: FeedSink): void;
	release(): void;
	// Writes (RUNTIME-FOLDER-WRITES.md, "Protocol v2").
	open(request: OpenRequest): Promise<{ handle: number; size: number; version: string }>;
	chunk(part: ChunkPart): Promise<void>;
	getChunk(handle: number, index: number): Promise<Buffer>;
	close(handle: number, size: number): Promise<{ version: string }>;
	mkdir(path: string): Promise<void>;
	unlink(path: string, base: string | undefined): Promise<void>;
	rmdir(path: string, base: string | undefined): Promise<void>;
	rename(request: RenameRequest): Promise<void>;
	/** The version the path shows after: the bit makes a new one, which the machine's version map takes. */
	setExecutable(path: string, executable: boolean, base: string | undefined): Promise<{ version: string }>;
	publish(): Promise<Report>;
}

/** The node's folder service: one tree per view, built from the core and kept current from its feed; listings from
 * that tree; bytes from the storage server's share. It keeps nothing but memory. */
export class FolderService {
	readonly #core: FolderCore;
	readonly #objects: NasObjects;
	readonly #grants: MountGrants;
	readonly #staging: FolderStaging | undefined;
	readonly #pollMs: number;
	readonly #reloadMs: number;
	readonly #idleMs: number;
	readonly #now: () => number;
	readonly #log: (line: string) => void;
	readonly #views = new Map<string, View>();
	readonly #profiles = new Map<string, string>();
	readonly #profileLookups = new Map<string, Promise<string>>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#heartbeat: ReturnType<typeof setInterval> | undefined;
	#renewals: ReturnType<typeof setInterval> | undefined;
	#polling = false;

	constructor(options: FolderServiceOptions) {
		this.#core = options.core;
		this.#objects = options.objects;
		this.#grants = options.grants;
		this.#staging = options.staging;
		this.#pollMs = options.pollMs ?? 500;
		this.#reloadMs = options.reloadMs ?? 10 * 60_000;
		this.#idleMs = options.idleMs ?? 60_000;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
	}

	start(): void {
		this.#timer ??= setInterval(() => void this.poll(), this.#pollMs);
		this.#heartbeat ??= setInterval(() => this.heartbeat(), HEARTBEAT_MS);
		this.#renewals ??= setInterval(() => {
			void this.renewLeases();
			void this.renewIntents();
		}, RENEW_MS);
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		if (this.#renewals) clearInterval(this.#renewals);
		this.#timer = undefined;
		this.#heartbeat = undefined;
		this.#renewals = undefined;
	}

	/** Renews the lease of every core view a machine is connected to; a view the core closed is closed on every
	 * connection. A view no machine holds is not renewed: its lease runs out, unless the core closed it first (a run's
	 * end closes its run box). A renewal that cannot reach the core leaves the confirmed lease to run out: past it the
	 * view is not served (UNAVAILABLE) until a renewal succeeds. Exposed for tests. */
	async renewLeases(): Promise<void> {
		await Promise.all(
			[...this.#views.values()]
				.filter((view) => view.lease && view.tree && view.connections > 0 && !view.closed)
				.map(async (view) => {
					try {
						await this.#renew(view);
					} catch (error) {
						this.#log(`folder-service: ${view.key}: lease not renewed now: ${(error as Error).message}`);
					}
				}),
		);
	}

	/** One renewal: the confirmed lease moves on, or the view closes. Throws when the core could not answer. */
	async #renew(view: View): Promise<void> {
		const lease = view.lease;
		if (!lease) return;
		let renewal: Awaited<ReturnType<FolderCore["renewView"]>>;
		const asked = this.#now();
		try {
			renewal = await this.#core.renewView(lease.viewId, lease.pass);
		} catch (error) {
			if (error instanceof CoreRefusal && error.reason === "denied")
				return this.#close(view, "The view was refused");
			throw error;
		}
		if (renewal.state === "closed") return this.#close(view, `The view was ${renewal.reason}`);
		// The core's clock says until when; never trust it for longer than one lease from now.
		view.leaseUntil = Math.min(Date.parse(renewal.leaseUntil), asked + LEASE_MS);
		view.confirmed = true;
	}

	/** Checks a machine's hello and opens (or joins) its view. The first connection of a view lists its tree. */
	async open(hello: Hello, bridge: BridgeInfo): Promise<ViewHandle> {
		const grant = this.#grants.admit(hello, bridge);
		let view = this.#views.get(grant.key);
		// Joining an open view takes the pass, and the company folder, it was opened with. A hello the core has not
		// checked yet never locks out another: while it is being checked the other is asked to try again, and an
		// unchecked view is replaced.
		if (
			view &&
			!view.closed &&
			(view.environmentId !== grant.environmentId || !timingSafeEqual(view.passSha256, grant.passSha256))
		) {
			if (view.confirmed)
				throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
			if (view.loading) throw new ProtocolError(ErrorCode.unavailable, "The view is being checked; try again");
			view = undefined;
		}
		if (!view || view.closed) {
			view = new View(grant);
			this.#views.set(grant.key, view);
		}
		view.connections++;
		view.idleSince = undefined;
		let released = false;
		let mine: FeedSink | undefined;
		const release = (): void => {
			if (released) return;
			released = true;
			if (mine) view.sinks.delete(mine);
			view.connections--;
			if (view.connections > 0) return;
			// No connection is left to finish a file: its program ended (or lost the link), and what it was writing goes.
			for (const handle of view.handles) this.#abandon(view, handle);
			view.handles.clear();
			view.idleSince = this.#now();
			// A core view no machine holds is dropped at once (with its pass): its lease is not renewed while idle, so
			// a machine that comes back lists it again and renews at once.
			if (view.lease && this.#views.get(view.key) === view) {
				this.#views.delete(view.key);
				view.lease = undefined;
				view.closed = "No machine holds the view";
				view.tree = undefined;
			}
		};
		try {
			view.loading ??= this.#firstLoad(view);
			await view.loading;
			if (view.closed) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
		} catch (error) {
			release();
			throw error;
		}
		return {
			asOfSeq: view.seq,
			writable: view.pending !== undefined,
			list: async (path, after) => this.#list(view, path, after),
			read: async (request) => this.#read(view, request),
			search: async (request) => this.#search(view, request),
			subscribe: (sink) => {
				if (released || view.closed) return sink.closed(ErrorCode.viewClosed, view.closed ?? "Released");
				mine = sink;
				view.sinks.add(sink);
			},
			release,
			// Bases are read when the change is made (after any boundary it waited for, which may have published the save
			// a base names).
			open: async (request) => {
				const opened = await this.#change(view, (pending) => {
					const base = this.#base(view, request.path, request.base);
					return pending.openWrite(request.path, {
						create: request.create,
						exclusive: request.exclusive,
						truncate: request.truncate,
						...(base ? { base } : {}),
					});
				});
				view.handles.add(opened.handle);
				return opened;
			},
			chunk: async (part) => {
				if (!view.handles.has(part.handle)) throw new ProtocolError(ErrorCode.badRequest, "No such handle");
				await this.#chunk(view, part);
			},
			getChunk: async (handle, index) => {
				if (!view.handles.has(handle)) throw new ProtocolError(ErrorCode.badRequest, "No such handle");
				return this.#getChunk(view, handle, index);
			},
			close: async (handle, size) => {
				if (!view.handles.has(handle)) throw new ProtocolError(ErrorCode.badRequest, "No such handle");
				// A file whose bytes are still its origin's, closed at another size: cut (on the 4 MiB grid, or to nothing)
				// with no chunk sent. Its bytes become its own from the origin's chunks first, and the close cuts them.
				const origin = view.pending?.originToCopy(handle);
				if (origin && size !== origin.bytes) await this.#beginFromOrigin(view, handle, origin);
				const node = await this.#change(view, (pending) => pending.close(handle, size));
				view.handles.delete(handle);
				for (const key of [...view.uploads.keys()]) if (key.startsWith(`${handle}:`)) view.uploads.delete(key);
				const path = node.open === 0 ? this.#pathOfNode(view, node) : undefined;
				if (path !== undefined) await this.#stage(view, node, path).catch(() => undefined);
				return { version: node.version };
			},
			mkdir: async (path) => this.#change(view, (pending) => pending.mkdir(path)),
			unlink: async (path, base) =>
				this.#change(view, (pending) => pending.unlink(path, this.#base(view, path, base))),
			rmdir: async (path, base) =>
				this.#change(view, (pending) => pending.rmdir(path, this.#base(view, path, base))),
			rename: async (request) =>
				this.#change(view, (pending) => {
					const fromBase = this.#base(view, request.from, request.fromBase);
					const toBase = this.#base(view, request.to, request.toBase);
					pending.rename(request.from, request.to, {
						noReplace: request.noReplace,
						...(fromBase ? { fromBase } : {}),
						...(toBase ? { toBase } : {}),
					});
				}),
			setExecutable: async (path, executable, base) =>
				this.#change(view, (pending) => {
					pending.setExecutable(path, executable, this.#base(view, path, base));
					// The version the path shows now: a save, so the machine's version map takes it.
					return { version: pending.get(path)?.version ?? "" };
				}),
			publish: async () => this.#publish(view),
		};
	}

	/** One round: read the clocks of every company with a live view, move views whose company moved, list again those
	 * due, send heartbeats, and drop views idle for long enough. Exposed for tests. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const now = this.#now();
			for (const [key, view] of this.#views)
				if (view.idleSince !== undefined && now - view.idleSince >= this.#idleMs) this.#views.delete(key);
			const live = [...this.#views.values()].filter((v) => v.tree && !v.closed);
			if (live.length === 0) return;
			let clocks: Map<string, number>;
			try {
				clocks = await this.#core.clocks([...new Set(live.map((v) => v.environmentId))]);
			} catch (error) {
				this.#log(`folder-service: clocks unavailable: ${(error as Error).message}`);
				return;
			}
			for (const view of live) {
				const last = clocks.get(view.environmentId);
				if (now - view.loadedAt >= this.#reloadMs || (last !== undefined && last > view.seq))
					this.#queue(view, () => this.#catchUp(view));
			}
		} finally {
			this.#polling = false;
		}
	}

	/** Sends every feed connection the view's position, so a machine knows its link is alive. */
	heartbeat(): void {
		for (const view of this.#views.values())
			if (view.tree && !view.closed)
				for (const sink of view.sinks) sink.change({ seq: view.seq, resync: false, paths: [] });
	}

	/** A full listing when one is due (decided now, not when queued, so a long one is not run twice), otherwise the
	 * feed. */
	async #catchUp(view: View): Promise<void> {
		if (this.#now() - view.loadedAt >= this.#reloadMs) return this.#reload(view, "scheduled");
		return this.#advance(view);
	}

	/** Waits for the queued work of every view (tests). */
	async settled(): Promise<void> {
		await Promise.all([...this.#views.values()].map((v) => v.work));
	}

	/** Queues a task unless one is already waiting (a waiting advance covers every change up to when it runs). */
	#queue(view: View, task: () => Promise<void>): void {
		if (view.queued) return;
		view.queued = true;
		view.work = view.work
			.then(() => {
				view.queued = false;
				return task();
			})
			.then(
				() => {
					view.lastError = undefined;
				},
				(error: unknown) => this.#failed(view, error),
			);
	}

	#failed(view: View, error: unknown): void {
		// Work that was already running when the view closed or was dropped: nothing to retry.
		if (view.closed) return;
		if (error instanceof CoreRefusal && error.reason === "denied") {
			this.#close(view, "The view's owner may no longer read this folder");
			return;
		}
		const message = (error as Error).message;
		if (message !== view.lastError) this.#log(`folder-service: ${view.key}: ${message}; trying again`);
		view.lastError = message;
	}

	#close(view: View, reason: string): void {
		view.closed = reason;
		view.tree = undefined;
		// What was pending is lost with the view (founder decision 3).
		view.pending?.clear();
		if (view.quiet) clearTimeout(view.quiet);
		for (const upload of view.uploads.values()) upload.upload?.abort();
		view.uploads.clear();
		view.handles.clear();
		view.intents.clear();
		view.unsettled = undefined;
		// The pass goes with it: a closed view makes no more calls.
		view.lease = undefined;
		if (this.#views.get(view.key) === view) this.#views.delete(view.key);
		for (const sink of view.sinks) sink.closed(ErrorCode.viewClosed, reason);
		view.sinks.clear();
		this.#log(`folder-service: ${view.key} closed: ${reason}`);
	}

	async #firstLoad(view: View): Promise<void> {
		try {
			const { tree, seq } = await this.#listAll(view);
			// A core view is served only under a lease the core confirmed: renewed at once, whenever its machine came.
			await this.#renew(view);
			if (view.closed) return;
			view.tree = tree;
			view.seq = seq;
			view.cursor = null;
			view.loadedAt = this.#now();
			view.confirmed = true;
			if (view.write && this.#staging)
				view.pending ??= new PendingView(
					() => view.tree ?? new ViewTree(),
					() => view.seq,
					this.#now,
				);
			this.#log(`folder-service: ${view.key} listed: ${tree.size} paths at change ${seq}`);
		} catch (error) {
			view.loading = undefined;
			if (error instanceof CoreRefusal && error.reason === "denied") {
				this.#close(view, "The view's owner may not read this folder");
				return;
			}
			throw new ProtocolError(ErrorCode.unavailable, "The folder could not be listed now");
		}
		// Catch up from the first page's position: pages listed later are newer, and the feed's changes apply to
		// them again harmlessly.
		this.#queue(view, () => this.#advance(view));
		await view.work;
	}

	/** The view's whole tree, page by page, and the first page's position. */
	async #listAll(view: View): Promise<{ tree: ViewTree; seq: number }> {
		const tree = new ViewTree();
		let after: string | null = null;
		let seq: number | undefined;
		do {
			const page = await this.#core.list(view.environmentId, view.actor, after);
			seq ??= page.asOfSeq;
			for (const entry of page.entries) tree.put(entry);
			after = page.next;
		} while (after !== null);
		return { tree, seq: seq ?? 0 };
	}

	/** Applies the feed from the view's position to its end. An authority change, or a position the core no longer
	 * serves, lists the whole view again. The tree and the position move page by page, so whatever has been applied is
	 * told to the machines even when a later page, or the listing again, fails: their caches never miss a change the
	 * tree already holds. */
	async #advance(view: View): Promise<void> {
		const tree = view.tree;
		if (!tree || view.closed) return;
		const changed: string[] = [];
		let told = false;
		try {
			for (;;) {
				const page = await this.#core.feed(view.environmentId, view.actor, view.seq, view.cursor);
				if (page.resync || !page.next) {
					await this.#reload(view, "the feed asked for it", changed);
					told = true;
					return;
				}
				for (const event of page.events) {
					if (event.kind === "authority") {
						await this.#reload(view, "access changed", changed);
						told = true;
						return;
					}
					// Every file version the change replaces or removes stays readable for files opened before, the
					// descendants of a folder it moves away or deletes included.
					for (const change of event.changes) changed.push(...tree.apply(change, (old) => this.#keep(view, old)));
				}
				view.seq = page.next.afterSeq;
				view.cursor = page.next.cursor;
				if (!page.more) break;
			}
		} finally {
			view.pending?.liveChanged(changed);
			if (!told) this.#push(view, changed);
		}
	}

	/** A base as the machine sent it, except that the version one of this view's saves made, published since, is read
	 * as the version its change set gave the path: the machine's version map holds the first (RUNTIME-FOLDER-WRITES.md,
	 * "After a save the map holds the version the save made"). */
	#base(view: View, path: string, base: string | undefined): string | undefined {
		if (base === undefined) return undefined;
		return view.published.get(path)?.find((p) => p.made === base)?.live ?? base;
	}

	/** Keeps a replaced file version readable for the files opened on it (at most SUPERSEDED_PER_PATH per path). */
	#keep(view: View, old: TreeEntry): void {
		const older = view.superseded.get(old.path) ?? [];
		if (older.some((e) => e.version === old.version)) return;
		older.push(old);
		if (older.length > SUPERSEDED_PER_PATH) older.shift();
		view.superseded.set(old.path, older);
	}

	/** Lists the view again and tells its machines what differs. Until it is done the old tree serves: a path an
	 * access change took away goes when the new tree replaces it. Its replaced versions go at once, and those of every
	 * path the new tree no longer holds go at the end. */
	async #reload(view: View, why: string, alreadyChanged: readonly string[] = []): Promise<void> {
		const before = view.tree;
		if (!before || view.closed) return;
		if (why === "access changed") view.superseded.clear();
		const { tree, seq } = await this.#listAll(view);
		// Catch the new tree up to the end of the feed before it replaces the old one. An access change (or a
		// position the core no longer serves) meanwhile makes the next round list again.
		let position: { afterSeq: number; cursor: FeedCursor | null } = { afterSeq: seq, cursor: null };
		let again = false;
		for (;;) {
			const page = await this.#core.feed(view.environmentId, view.actor, position.afterSeq, position.cursor);
			if (page.resync || !page.next) {
				again = true;
				break;
			}
			for (const event of page.events) {
				if (event.kind === "authority") again = true;
				else for (const change of event.changes) tree.apply(change);
			}
			position = page.next;
			if (!page.more) break;
		}
		view.tree = tree;
		view.seq = position.afterSeq;
		view.cursor = position.cursor;
		view.loadedAt = again ? 0 : this.#now();
		for (const path of view.superseded.keys()) if (!tree.get(path)) view.superseded.delete(path);
		const changed = [...alreadyChanged, ...ViewTree.diff(before, tree)];
		view.pending?.liveChanged(changed);
		this.#log(`folder-service: ${view.key} listed again (${why}): ${tree.size} paths, ${changed.length} changed`);
		this.#push(view, changed);
	}

	#push(view: View, changed: readonly string[]): void {
		if (changed.length === 0) return;
		const paths = [...new Set(changed)];
		let message: ChangeMessage = { seq: view.seq, resync: false, paths };
		if (paths.length > RESYNC_OVER || Buffer.byteLength(JSON.stringify(message)) > MAX_PAYLOAD - 1024)
			message = { seq: view.seq, resync: true, paths: [] };
		for (const sink of view.sinks) {
			try {
				sink.change(message);
			} catch (error) {
				// One machine's broken connection never keeps the others from hearing.
				view.sinks.delete(sink);
				this.#log(`folder-service: ${view.key}: a feed connection failed: ${(error as Error).message}`);
				sink.closed(ErrorCode.unavailable, "The feed connection failed");
			}
		}
	}

	#tree(view: View): ViewTree {
		if (view.closed) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
		if (!view.tree) throw new ProtocolError(ErrorCode.unavailable, "The view is not listed yet");
		if (view.lease && (view.leaseUntil === undefined || this.#now() >= view.leaseUntil))
			throw new ProtocolError(ErrorCode.unavailable, "The view's lease is not confirmed now; try again");
		return view.tree;
	}

	#list(view: View, path: string, after: string | undefined) {
		const tree = this.#tree(view);
		const result = view.pending
			? view.pending.children(path, after, LIST_PAGE)
			: tree.children(path, after, LIST_PAGE);
		if (result === "not_found") throw new ProtocolError(ErrorCode.notFound, "No such folder");
		if (result === "not_a_folder") throw new ProtocolError(ErrorCode.notAFolder, "Not a folder");
		return result;
	}

	async #read(view: View, request: ReadRequest): Promise<Buffer> {
		this.#tree(view);
		const pending = view.pending?.source(request.path, request.version);
		if (pending) {
			try {
				if ("live" in pending)
					return await this.#objects.read(
						await this.#profile(view, pending.live),
						pending.live,
						request.offset,
						request.length,
					);
				const end = Math.min(pending.content.size, request.offset + request.length);
				if (request.offset >= end) return Buffer.alloc(0);
				return await this.#objects.readChunks(
					await this.#uploadProfile(view),
					pending.content.chunks,
					request.offset,
					end - request.offset,
				);
			} catch (error) {
				if (error instanceof ProtocolError) throw error;
				if (error instanceof CoreRefusal) throw new ProtocolError(ErrorCode.denied, "The core refused the read");
				throw new ProtocolError(ErrorCode.unavailable, "The file's bytes could not be read now");
			}
		}
		const current = view.pending ? view.pending.get(request.path) : this.#tree(view).get(request.path);
		// A version this view's own save made, published since, reads as the version that save published: a file the
		// machine still holds open from before the boundary goes on reading the same bytes.
		const version = this.#base(view, request.path, request.version) ?? request.version;
		let entry: TreeEntry | undefined;
		if (current?.version === version) entry = current;
		else entry = view.superseded.get(request.path)?.find((old) => old.version === version);
		if (!entry) {
			if (!current) throw new ProtocolError(ErrorCode.notFound, "No such file");
			if (current.kind === "folder") throw new ProtocolError(ErrorCode.notAFile, "Not a file");
			throw new ProtocolError(ErrorCode.stale, "That version is no longer readable");
		}
		if (entry.kind !== "file") throw new ProtocolError(ErrorCode.notAFile, "Not a file");
		try {
			const profileId = await this.#profile(view, entry);
			return await this.#objects.read(profileId, entry, request.offset, request.length);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			if (error instanceof CoreRefusal) throw new ProtocolError(ErrorCode.denied, "The core refused the read");
			if (error instanceof ObjectIntegrityError)
				this.#log(`folder-service: ${view.key}: ${request.path} version ${entry.version}: ${error.message}`);
			throw new ProtocolError(ErrorCode.unavailable, "The file's bytes could not be read now");
		}
	}

	/** A search over the view's tree as it is now: the files' bytes as reads give them. A path that is not in the view
	 * is NOT_FOUND; a share that cannot be read now fails the whole page (UNAVAILABLE), so no answer leaves a file out
	 * without saying so. */
	async #search(view: View, request: SearchRequest): Promise<SearchAnswer> {
		// A run's own view only (a core view): an operator mount's machine never searches through this service. A core
		// view the core closed answers VIEW_CLOSED (from the tree), so its run opens another.
		if (!view.core) throw new ProtocolError(ErrorCode.badRequest, "Search is for a run's own view");
		const tree = this.#tree(view);
		if (!tree.get(request.path)) throw new ProtocolError(ErrorCode.notFound, "No such path");
		try {
			return await searchView(
				{
					tree,
					read: async (entry, offset, length) =>
						this.#objects.read(await this.#profile(view, entry), entry, offset, length),
					now: this.#now,
					// The view closed or its lease lapsed while the page ran: the page stops (never one slice past it).
					serving: () => void this.#tree(view),
					log: this.#log,
				},
				request,
			);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			if (error instanceof CoreRefusal) throw new ProtocolError(ErrorCode.denied, "The core refused the read");
			if (!(error instanceof ObjectUnavailableError))
				this.#log(`folder-service: ${view.key}: search failed: ${(error as Error).message}`);
			throw new ProtocolError(ErrorCode.unavailable, "The folder could not be searched now; try again");
		}
	}

	// ---- Writes (F3 step 3, RUNTIME-FOLDER-WRITES.md) --------------------------------------------------------------

	/** One change to the view's pending changes. A change that needs what is pending published first publishes it,
	 * then is made again; if it is still blocked then, the machine hears BUSY. */
	async #change<T>(view: View, change: (pending: PendingView) => T): Promise<T> {
		await this.#quiet(view);
		const pending = view.pending;
		if (!pending) throw new ProtocolError(ErrorCode.readOnly, "This view is read-only");
		let answer: T;
		try {
			answer = change(pending);
		} catch (error) {
			if (!(error instanceof PublishFirst)) throw error;
			await this.#publish(view);
			// The boundary must be answered and settled, and no other one running, before the change is made again: until
			// then the view still holds what that boundary published, and settling it would undo the change (BUSY).
			await this.#quiet(view);
			try {
				answer = change(pending);
			} catch (again) {
				if (again instanceof PublishFirst) throw new ProtocolError(ErrorCode.busy, again.message);
				throw again;
			}
		}
		this.#touch(view);
		return answer;
	}

	/** Waits for a running boundary (a change never lands while one is deciding what it publishes), and gets a boundary
	 * whose answer never came through first: until it has one, nothing changes (BUSY), so it settles exactly what it
	 * published. Likewise an answered boundary waits for the feed to bring its change set. */
	async #quiet(view: View): Promise<void> {
		for (;;) {
			const publishing = view.publishing;
			await publishing.catch(() => undefined);
			this.#tree(view);
			if (view.unanswered) {
				await this.#publish(view);
				if (view.unanswered) throw new ProtocolError(ErrorCode.busy, "The last save has not got through yet");
			} else if (view.unsettled) {
				await this.#settleInTurn(view);
				if (view.unsettled)
					throw new ProtocolError(ErrorCode.busy, "The last save has not come back through the feed yet");
			}
			// Waiting may have let another boundary start: the change waits for that one too, so it never lands while a
			// boundary is between deciding what it publishes and settling.
			if (view.publishing === publishing) return;
		}
	}

	/** Tries to settle an answered boundary in its turn among the view's boundaries, never beside one. */
	#settleInTurn(view: View): Promise<Report> {
		const next = view.publishing
			.catch(() => undefined)
			.then(async (): Promise<Report> => {
				await this.#trySettle(view);
				return { commitId: null, seq: null, paths: [] };
			});
		view.publishing = next;
		return next;
	}

	/** A change restarts the quiet period of a mount that publishes on one. */
	#touch(view: View): void {
		if (view.quietMs === undefined) return;
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = setTimeout(() => {
			view.quiet = undefined;
			void this.#publish(view).then(
				(report) => {
					for (const entry of report.paths)
						if (entry.outcome !== "saved")
							this.#log(
								`folder-service: ${view.key}: ${entry.path}: ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ""}`,
							);
				},
				(error: unknown) => this.#log(`folder-service: ${view.key}: publish failed: ${(error as Error).message}`),
			);
		}, view.quietMs);
		view.quiet.unref?.();
	}

	#abandon(view: View, handle: number): void {
		for (const [key, upload] of view.uploads)
			if (key.startsWith(`${handle}:`)) {
				upload.upload?.abort();
				view.uploads.delete(key);
			}
		view.pending?.abandon(handle);
	}

	/** One part of a chunk. The first part opens the chunk's own intent (its bytes are known, its file's are not) and
	 * starts the gateway's put; the last waits for the gateway, then sets the chunk in the file. A chunk the actor
	 * holds already is not sent on. */
	async #chunk(view: View, part: ChunkPart): Promise<void> {
		await this.#quiet(view);
		const pending = view.pending;
		const staging = this.#staging;
		if (!pending || !staging) throw new ProtocolError(ErrorCode.readOnly, "This view is read-only");
		const key = `${part.handle}:${part.index}`;
		let upload = view.uploads.get(key);
		if (part.offset === 0) {
			upload?.upload?.abort();
			pending.file(part.handle);
			// The first chunk changed in a file that still has its origin's bytes: they become its own first.
			const origin = pending.originToCopy(part.handle);
			if (origin) await this.#beginFromOrigin(view, part.handle, origin);
			let started: ChunkUpload | undefined;
			try {
				const intent = await staging.openChunk(view.environmentId, view.actor, part.sha256, part.bytes);
				// The chunk counts as needed (its intent renewed) from here until it is set in the file or its put fails.
				view.intents.set(intent.intentId, {
					renewed: this.#now(),
					node: pending.file(part.handle),
					chunk: { sha256: part.sha256, bytes: part.bytes },
				});
				started = {
					sha256: part.sha256,
					bytes: part.bytes,
					next: 0,
					upload: intent.present
						? undefined
						: staging.upload(view.environmentId, view.actor, intent.intentId, part.sha256, part.bytes),
				};
				view.uploads.set(key, started);
				if (!this.#profiles.has(view.environmentId))
					this.#profiles.set(
						view.environmentId,
						await this.#core.uploadProfile(
							view.environmentId,
							view.actor,
							intent.intentId,
							part.sha256,
							part.bytes,
						),
					);
			} catch (error) {
				// A chunk that could not be started is no longer on its way: the request fails, the connection stays.
				started?.upload?.abort();
				if (started && view.uploads.get(key) === started) view.uploads.delete(key);
				if (error instanceof ProtocolError) throw error;
				if (error instanceof CoreRefusal) throw new ProtocolError(ErrorCode.denied, "The core refused the upload");
				throw new ProtocolError(ErrorCode.unavailable, "The chunk could not be started now");
			}
			upload = started;
		}
		if (!upload || upload.sha256 !== part.sha256 || upload.bytes !== part.bytes || upload.next !== part.offset) {
			upload?.upload?.abort();
			view.uploads.delete(key);
			throw new ProtocolError(ErrorCode.badRequest, "Chunk parts out of order");
		}
		const done = (): void => {
			if (view.uploads.get(key) === upload) view.uploads.delete(key);
		};
		try {
			await upload.upload?.write(part.data);
			upload.next += part.data.byteLength;
			if (upload.next < upload.bytes) return;
			await upload.upload?.end();
			pending.setChunk(part.handle, part.index, { sha256: part.sha256, bytes: part.bytes });
			done();
		} catch (error) {
			done();
			upload.upload?.abort();
			throw error instanceof ProtocolError
				? error
				: new ProtocolError(ErrorCode.unavailable, "The chunk could not be saved now");
		}
		this.#touch(view);
	}

	/** A file whose bytes are still its origin's takes them as its own, before a chunk of it changes or a close cuts it.
	 * Chunks are changed by index on the 4 MiB grid; a file laid out otherwise (fixtures, version 1) is written whole
	 * instead (opened with truncate). */
	async #beginFromOrigin(view: View, handle: number, origin: TreeEntry): Promise<void> {
		let chunks: readonly ChunkRef[];
		try {
			chunks = await this.#objects.manifestChunks(await this.#profile(view, origin), origin);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			if (error instanceof CoreRefusal) throw new ProtocolError(ErrorCode.denied, "The core refused the read");
			throw new ProtocolError(ErrorCode.unavailable, "The file's bytes could not be read now");
		}
		if (chunks.some((c, i) => i < chunks.length - 1 && c.bytes !== CHUNK_BYTES))
			throw new ProtocolError(ErrorCode.notPermitted, "This file is changed whole: open it with truncate");
		view.pending?.beginContent(handle, chunks);
	}

	/** A pending file's chunk back, for a write inside a chunk already sent. */
	async #getChunk(view: View, handle: number, index: number): Promise<Buffer> {
		await view.publishing.catch(() => undefined);
		this.#tree(view);
		const node = view.pending?.file(handle);
		if (!node) throw new ProtocolError(ErrorCode.readOnly, "This view is read-only");
		try {
			if (node.content) {
				const chunk = node.content.chunks[index];
				return chunk
					? await this.#objects.chunk(await this.#uploadProfile(view), chunk.sha256, chunk.bytes)
					: Buffer.alloc(0);
			}
			const origin = node.origin?.entry;
			if (!origin) return Buffer.alloc(0);
			const profile = await this.#profile(view, origin);
			const chunk = (await this.#objects.manifestChunks(profile, origin))[index];
			return chunk ? await this.#objects.chunk(profile, chunk.sha256, chunk.bytes) : Buffer.alloc(0);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			throw new ProtocolError(ErrorCode.unavailable, "The chunk could not be read now");
		}
	}

	/** The media type a file is saved with at `path`: the path's own, if it has a version there (an edit, or a file
	 * renamed over it: "a path that has a version keeps its media type"); otherwise the file's, or one from its name. */
	#mediaType(view: View, node: PendingFile, path: string): string {
		const live = view.tree?.get(path);
		if (live?.kind === "file" && live.mediaType) return live.mediaType;
		return node.mediaType ?? mediaTypeOf(nameOf(path));
	}

	/** Whether a node's staging is for what it is now: its version, at the media type its path gives it. */
	#stagedNow(view: View, node: PendingFile, path: string): boolean {
		return node.staged?.version === node.version && node.staged.file.mediaType === this.#mediaType(view, node, path);
	}

	/** Stages a closed file's current version (its bytes, or its origin's chunks under a new bit) at `path`, once; the
	 * intent it is sealed under is renewed while the file is pending. */
	async #stage(view: View, node: PendingFile, path: string): Promise<FileRef | undefined> {
		const staging = this.#staging;
		const changed = node.content !== undefined || (node.origin && node.executable !== node.origin.entry?.executable);
		if (!staging || node.open > 0 || !changed) return undefined;
		const version = node.version;
		if (this.#stagedNow(view, node, path)) return node.staged?.file;
		// A staging for another version or media type is never used again.
		node.staged = undefined;
		const mediaType = this.#mediaType(view, node, path);
		let content = node.content;
		const origin = node.origin?.entry;
		if (!content && origin)
			content = {
				chunks: await this.#objects.manifestChunks(await this.#profile(view, origin), origin),
				size: origin.bytes,
			};
		if (!content) return undefined;
		// A new file with no bytes needs no profile: nothing is read.
		const profile = origin
			? await this.#profile(view, origin)
			: content.chunks.length > 0
				? await this.#uploadProfile(view)
				: "";
		const staged = await staging.stageFile(
			view.environmentId,
			view.actor,
			profile,
			content,
			mediaType,
			node.executable,
		);
		if (node.version === version) {
			node.staged = { version, file: staged.file };
			view.intents.set(staged.intentId, { renewed: this.#now(), node, staged: staged.file });
		}
		return staged.file;
	}

	/** The path a node is shown at now. */
	#pathOfNode(view: View, node: PendingFile): string | undefined {
		for (const [path, n] of view.pending?.nodes() ?? []) if (n === node) return path;
		return undefined;
	}

	/** One boundary, after any running one (RUNTIME-FOLDER-WRITES.md, "A boundary"). */
	#publish(view: View): Promise<Report> {
		const next = view.publishing.catch(() => undefined).then(() => this.#boundary(view));
		view.publishing = next;
		return next;
	}

	async #boundary(view: View): Promise<Report> {
		const pending = view.pending;
		if (!pending || view.closed) return { commitId: null, seq: null, paths: [] };
		return await this.#boundaryOf(view, pending);
	}

	async #boundaryOf(view: View, pending: PendingView): Promise<Report> {
		const entries: ReportEntry[] = [];
		// An answered boundary the feed has not brought back yet settles first; nothing else is decided until it has.
		if (view.unsettled) {
			await this.#trySettle(view);
			if (view.unsettled)
				throw new ProtocolError(ErrorCode.busy, "The last save has not come back through the feed yet");
		}
		// A boundary whose answer never came goes first, unchanged.
		if (view.unanswered) {
			const earlier = view.unanswered;
			const answer = await this.#commit(view, earlier.key, earlier.units);
			if (!answer)
				return {
					commitId: null,
					seq: null,
					paths: earlier.plan.units.flatMap((u) =>
						u.paths.map((path) => ({
							path,
							outcome: "not_applied" as const,
							reason: "the save did not get through yet",
							kept: true,
						})),
					),
				};
			view.unanswered = undefined;
			entries.push(...(await this.#settle(view, earlier.plan, earlier.made, answer)));
			if (view.unsettled) return { commitId: answer.commitId, seq: answer.seq, paths: entries };
		}
		await this.#stageAll(view);
		const plan = planBoundary(pending, (node) =>
			node.staged?.version === node.version ? node.staged.file : undefined,
		);
		for (const w of plan.waiting) entries.push({ path: w.path, outcome: "waiting", reason: w.reason, kept: true });
		for (const d of plan.dropped) entries.push({ path: d.path, outcome: "not_applied", reason: d.reason });
		if (plan.units.length === 0) {
			if (plan.dropped.length > 0)
				this.#settleNodes(
					view,
					plan.keep,
					plan.dropped.map((d) => d.path),
				);
			return { commitId: null, seq: null, paths: entries };
		}
		const units = await this.#structured(
			view,
			plan.units.map((u) => u.unit),
		);
		const key = `folder-view:${view.key}:${randomUUID()}`;
		// The version each file this boundary publishes bytes for has now, as the machine heard it.
		const made = new Map<string, string>();
		for (const u of plan.units)
			if (u.bytes)
				for (const path of u.paths) {
					const node = pending.nodes().get(path);
					if (node?.kind === "file") made.set(path, node.version);
				}
		const answer = await this.#commit(view, key, units);
		if (!answer) {
			view.unanswered = { key, units, plan, made };
			for (const u of plan.units)
				for (const path of u.paths)
					entries.push({ path, outcome: "not_applied", reason: "the save did not get through yet", kept: true });
			return { commitId: null, seq: null, paths: entries };
		}
		entries.push(...(await this.#settle(view, plan, made, answer)));
		return { commitId: answer.commitId, seq: answer.seq, paths: entries };
	}

	/** Stages every closed, changed file not staged yet, a few at a time. */
	async #stageAll(view: View): Promise<void> {
		const nodes = [...(view.pending?.nodes() ?? [])].filter(
			(entry): entry is [string, PendingFile] =>
				entry[1].kind === "file" && entry[1].open === 0 && !this.#stagedNow(view, entry[1], entry[0]),
		);
		for (let i = 0; i < nodes.length; i += STAGING_PARALLEL)
			await Promise.all(
				nodes.slice(i, i + STAGING_PARALLEL).map(([path, node]) =>
					this.#stage(view, node, path).catch((error: unknown) => {
						this.#log(`folder-service: ${view.key}: a file could not be staged: ${(error as Error).message}`);
					}),
				),
			);
	}

	/** A structured file's parse goes with its unit (core §3 "Before the transaction"), from its staged bytes. */
	async #structured(view: View, units: readonly CommitUnit[]): Promise<CommitUnit[]> {
		const parse = async (path: string, file: FileRef): Promise<Record<string, unknown> | null> => {
			if (!companyStatePath(path)) return null;
			if (file.bytes === 0) return memberFolderStructured(path, "");
			const entry: TreeEntry = {
				path,
				kind: "file",
				version: "",
				bytes: file.bytes,
				executable: file.executable,
				mtimeMs: 0,
				implicit: false,
				manifestSha256: file.manifestSha256,
				fileSha256: file.fileSha256,
				mediaType: file.mediaType,
			};
			let bytes: Buffer;
			try {
				bytes = await this.#objects.read(await this.#uploadProfile(view), entry, 0, file.bytes);
			} catch (error) {
				if (error instanceof ProtocolError) throw error;
				throw new ProtocolError(ErrorCode.unavailable, "A file to publish could not be read back now");
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				text = "";
			}
			return memberFolderStructured(path, text);
		};
		const out: CommitUnit[] = [];
		for (const unit of units) {
			if (unit.op === "write") {
				const structured = await parse(unit.path, unit.file);
				out.push(structured ? { ...unit, structured: [structured] } : unit);
			} else if (unit.op === "new_folder") {
				const parsed: Record<string, unknown>[] = [];
				for (const c of unit.contents)
					if (c.file) {
						const structured = await parse(`${unit.path}/${c.path}`, c.file);
						if (structured) parsed.push(structured);
					}
				out.push(parsed.length > 0 ? { ...unit, structured: parsed } : unit);
			} else out.push(unit);
		}
		return out;
	}

	/** The commit, asked again under the same key while no answer comes. Undefined: no answer yet; a refusal of the
	 * whole change set is an answer of its own (every unit not applied). */
	async #commit(view: View, key: string, units: readonly CommitUnit[]): Promise<CommitAnswer | undefined> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.#core.commit(view.environmentId, view.actor, key, units);
			} catch (error) {
				if (error instanceof CoreRefusal)
					return {
						commitId: "",
						seq: null,
						units: units.map((_, i) => ({
							unit: i + 1,
							outcome: "refused",
							reason: error.reason,
							version: null,
						})),
					};
				this.#log(`folder-service: ${view.key}: commit not answered: ${(error as Error).message}`);
			}
		}
		return undefined;
	}

	/** After an answer: the report, and the view settled once the feed has brought the change set. Until then the view
	 * keeps its pending changes as they were and takes no change (BUSY), so the settling drops nothing made since. It
	 * shows the live folder again but for what the boundary keeps and every unit with new bytes the core neither saved
	 * nor kept as a conflict copy. */
	async #settle(
		view: View,
		plan: BoundaryPlan,
		made: ReadonlyMap<string, string>,
		answer: CommitAnswer,
	): Promise<ReportEntry[]> {
		const entries: ReportEntry[] = [];
		const keep = new Set(plan.keep);
		const saved = new Set<string>();
		const copied = await this.#copied(view, plan, answer);
		plan.units.forEach((planned, i) => {
			const outcome = answer.units[i];
			const kept = planned.bytes && outcome?.outcome !== "saved" && !copied.has(i);
			for (const path of planned.paths) {
				if (kept) keep.add(path);
				if (outcome?.outcome === "saved") saved.add(path);
				entries.push({
					path,
					outcome: outcome?.outcome ?? "not_applied",
					...(outcome?.reason ? { reason: outcome.reason } : {}),
					...(copied.has(i) ? { receipt: answer.commitId } : {}),
					...(kept ? { kept: true } : {}),
				});
			}
		});
		const settlement: Settlement = { plan, made, answer, keep, saved };
		view.unsettled = settlement;
		// A round that cannot reach the feed leaves the view unsettled; the next change or boundary tries again.
		for (let attempt = 0; attempt < 3 && view.unsettled === settlement && !view.closed; attempt++)
			await this.#trySettle(view);
		return entries;
	}

	/** The units whose conflict kept this view's bytes on the receipt: every file of the unit is among the copies the
	 * core kept for the commit (P17 keeps them only when the unit's bytes would have passed). A conflict whose bytes were
	 * not kept stays pending, and the next boundary tries it again. */
	async #copied(view: View, plan: BoundaryPlan, answer: CommitAnswer): Promise<Set<number>> {
		const copied = new Set<number>();
		const conflicts = plan.units.flatMap((planned, i) =>
			answer.units[i]?.outcome === "conflict" && planned.bytes ? [i] : [],
		);
		if (conflicts.length === 0 || !answer.commitId) return copied;
		let copies: readonly ConflictCopy[];
		try {
			copies = await this.#core.conflictCopies(view.environmentId, answer.commitId);
		} catch (error) {
			this.#log(`folder-service: ${view.key}: the receipt's copies could not be read: ${(error as Error).message}`);
			return copied;
		}
		for (const i of conflicts) {
			const unit = plan.units[i]!.unit;
			const files =
				unit.op === "write"
					? [unit.file]
					: unit.op === "new_folder"
						? unit.contents.flatMap((c) => (c.file ? [c.file] : []))
						: [];
			const kept = new Set(copies.filter((c) => c.unit === i + 1).map((c) => c.manifestSha256));
			if (files.every((file) => kept.has(file.manifestSha256))) copied.add(i);
		}
		return copied;
	}

	/** Settles an answered boundary once the view's feed has reached its change set, with the versions its saves
	 * published. Until then the view stays unsettled. */
	async #trySettle(view: View): Promise<void> {
		const settlement = view.unsettled;
		if (!settlement) return;
		const seq = settlement.answer.seq;
		if (seq === null) return this.#finishSettle(view, settlement, new Map());
		if (view.seq < seq) {
			this.#queue(view, () => this.#advance(view));
			await view.work;
			if (view.seq < seq) return;
		}
		// A write's version is in the core's answer; a new folder's files' are only in its change set, which is read
		// when one of them was saved.
		const written = new Map<string, string>();
		settlement.plan.units.forEach((planned, i) => {
			const outcome = settlement.answer.units[i];
			if (planned.unit.op === "write" && outcome?.outcome === "saved" && outcome.version)
				written.set(planned.unit.path, outcome.version);
		});
		if ([...settlement.made.keys()].some((path) => settlement.saved.has(path) && !written.has(path)))
			try {
				for (const [path, version] of await this.#changeSetWrites(view, seq))
					if (!written.has(path)) written.set(path, version);
			} catch (error) {
				this.#log(
					`folder-service: ${view.key}: change set ${seq} could not be read now: ${(error as Error).message}`,
				);
				return;
			}
		if (view.unsettled === settlement) this.#finishSettle(view, settlement, written);
	}

	/** The versions change set `seq` wrote, read from the feed just before it: whatever the view's own rounds did since
	 * (a full listing included), the change set says exactly. A feed that no longer serves that position gives none. */
	async #changeSetWrites(view: View, seq: number): Promise<Map<string, string>> {
		const writes = new Map<string, string>();
		let position: { afterSeq: number; cursor: FeedCursor | null } = { afterSeq: seq - 1, cursor: null };
		for (;;) {
			const page = await this.#core.feed(view.environmentId, view.actor, position.afterSeq, position.cursor);
			if (page.resync || !page.next) return writes;
			for (const event of page.events) {
				if (event.seq > seq) return writes;
				if (event.seq === seq && event.kind === "change_set")
					for (const change of event.changes) if (change.op === "write") writes.set(change.path, change.version);
			}
			if (!page.more) return writes;
			position = page.next;
		}
	}

	#finishSettle(view: View, settlement: Settlement, written: ReadonlyMap<string, string>): void {
		view.unsettled = undefined;
		this.#notePublished(view, settlement, written);
		this.#settleNodes(
			view,
			settlement.keep,
			settlement.plan.units.flatMap((u) => u.paths),
			settlement.saved,
		);
	}

	/** The versions this boundary's saves published, for bases and reads naming the versions they made. As many are
	 * kept per path as versions of it stay readable: the current one and the replaced ones. */
	#notePublished(view: View, settlement: Settlement, written: ReadonlyMap<string, string>): void {
		for (const [path, made] of settlement.made) {
			const live = settlement.saved.has(path) ? written.get(path) : undefined;
			if (!live) continue;
			const aliases = view.published.get(path) ?? [];
			aliases.push({ made, live });
			if (aliases.length > SUPERSEDED_PER_PATH + 1) aliases.shift();
			view.published.set(path, aliases);
		}
	}

	/** Shows the live folder again but for the nodes kept, and tells the machines the paths that change by it. */
	#settleNodes(
		view: View,
		keep: ReadonlySet<string>,
		paths: readonly string[],
		saved: ReadonlySet<string> = new Set(),
	): void {
		const pending = view.pending;
		if (!pending) return;
		// A kept file keeps the new folders above it that did not save, so it stays reachable; a folder that saved is live.
		const keepAll = new Set(keep);
		for (const path of keep)
			for (let p = path; p.includes("/"); p = p.slice(0, p.lastIndexOf("/"))) {
				const parent = p.slice(0, p.lastIndexOf("/"));
				if (!saved.has(parent)) keepAll.add(parent);
			}
		const before = [...pending.nodes().keys()];
		pending.settle(new Set([...keepAll].filter((p) => pending.nodes().has(p))));
		if (pending.empty) view.intents.clear();
		this.#push(view, [...new Set([...paths, ...before])]);
	}

	/** Renews the intents that root the bytes of pending files, each after 10 minutes. One the core lets lapse is
	 * replaced: a chunk is held again under a new intent (put again from the share if the actor no longer holds it), and
	 * a file whose sealed intent lapsed is staged again at the next boundary. A renewal that could not reach the core is
	 * tried again next round. The intents of files no longer pending are let go. Exposed for tests. */
	async renewIntents(): Promise<void> {
		const now = this.#now();
		for (const view of [...this.#views.values()]) {
			const pending = view.pending;
			if (!pending || view.closed) continue;
			const { chunks, files } = this.#neededBytes(view, pending);
			for (const [id, held] of [...view.intents]) {
				const needed = held.chunk
					? chunks.has(held.chunk.sha256)
					: held.staged !== undefined && files.has(held.staged.manifestSha256);
				if (!needed) {
					view.intents.delete(id);
					continue;
				}
				if (now - held.renewed < INTENT_RENEW_MS) continue;
				try {
					await this.#core.renewUpload(view.environmentId, view.actor, id);
					held.renewed = now;
				} catch (error) {
					if (!(error instanceof CoreRefusal)) {
						this.#log(
							`folder-service: ${view.key}: an upload intent was not renewed now: ${(error as Error).message}`,
						);
						continue;
					}
					// The core let it lapse (C1D §3.5).
					view.intents.delete(id);
					if (held.staged && held.node.staged?.file === held.staged) held.node.staged = undefined;
					if (held.chunk) await this.#holdAgain(view, id, held);
				}
			}
		}
	}

	/** The chunks and staged files (by manifest) the view's pending bytes still need: each pending file's as it is and as
	 * an abandoned handle would restore it, chunks on their way to the gateway, and the files of a boundary that has not
	 * settled (asked again, or waiting for the feed). */
	#neededBytes(view: View, pending: PendingView): { chunks: Set<string>; files: Set<string> } {
		const chunks = new Set<string>();
		const files = new Set<string>();
		for (const node of pending.nodes().values()) {
			if (node.kind !== "file") continue;
			for (const state of [node, pending.fixedState(node)]) {
				for (const c of state?.content?.chunks ?? []) chunks.add(c.sha256);
				if (state?.staged) files.add(state.staged.file.manifestSha256);
			}
		}
		for (const upload of view.uploads.values()) chunks.add(upload.sha256);
		const outstanding = [...(view.unanswered?.units ?? []), ...(view.unsettled?.plan.units.map((u) => u.unit) ?? [])];
		for (const unit of outstanding) {
			if (unit.op === "write") files.add(unit.file.manifestSha256);
			if (unit.op === "new_folder") for (const c of unit.contents) if (c.file) files.add(c.file.manifestSha256);
		}
		return { chunks, files };
	}

	/** A pending chunk whose intent lapsed, held again under a new one. Until that works the old entry stays, so the
	 * next round tries again. */
	async #holdAgain(view: View, lapsed: string, held: HeldIntent): Promise<void> {
		const staging = this.#staging;
		const chunk = held.chunk;
		if (!staging || !chunk) return;
		try {
			const id = await staging.holdChunk(
				view.environmentId,
				view.actor,
				await this.#uploadProfile(view),
				chunk.sha256,
				chunk.bytes,
			);
			view.intents.set(id, { renewed: this.#now(), node: held.node, chunk });
		} catch (error) {
			this.#log(
				`folder-service: ${view.key}: a pending chunk could not be held again now: ${(error as Error).message}`,
			);
			view.intents.set(lapsed, held);
		}
	}

	/** The company's storage profile for a view's own uploads, learnt at its first chunk. */
	async #uploadProfile(view: View): Promise<string> {
		const known = this.#profiles.get(view.environmentId);
		if (!known) throw new ProtocolError(ErrorCode.unavailable, "The company's storage is not known yet");
		return known;
	}

	/** The company's storage profile, learnt once through the core's download check of an object this view reads. */
	async #profile(view: View, entry: TreeEntry): Promise<string> {
		const known = this.#profiles.get(view.environmentId);
		if (known) return known;
		// One lookup at a time per company: a search's reads ahead all wait for the same one.
		let pending = this.#profileLookups.get(view.environmentId);
		if (!pending) {
			pending = this.#core
				.objectProfile(view.environmentId, view.actor, entry.manifestSha256!)
				.then((profileId) => {
					this.#profiles.set(view.environmentId, profileId);
					return profileId;
				})
				.finally(() => this.#profileLookups.delete(view.environmentId));
			this.#profileLookups.set(view.environmentId, pending);
		}
		return pending;
	}
}
