import { CoreRefusal, type FeedCursor, type FolderActor, type FolderCore } from "./core.ts";
import type { Grant, MountGrants } from "./mounts.ts";
import { type NasObjects, ObjectIntegrityError } from "./objects.ts";
import { ErrorCode, type Hello, LIST_PAGE, ProtocolError, type ReadRequest, type WireEntry } from "./protocol.ts";
import { type TreeEntry, ViewTree } from "./view-tree.ts";

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
	/** How often the folder clocks are read. A change shows on machines within about this plus one feed call. */
	readonly pollMs?: number;
	/** How often each view is listed again in full: grant expiry is on no feed (proposal P4 in the design note). */
	readonly reloadMs?: number;
	/** How long a superseded version stays readable through an open file. */
	readonly supersededMs?: number;
	/** How long a view with no connection is kept before its tree is dropped. */
	readonly idleMs?: number;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

/** More changed paths than this in one push: the machine is told to drop everything instead. */
const RESYNC_OVER = 5_000;
/** The machine's folder program treats 45 s without a frame as a dead link. */
const HEARTBEAT_MS = 15_000;

class View {
	readonly key: string;
	readonly environmentId: string;
	readonly actor: FolderActor;
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
	/** Versions replaced on the feed, readable for a while by files opened before. */
	readonly superseded = new Map<string, { entry: TreeEntry; until: number }>();

	constructor(grant: Grant) {
		this.key = grant.key;
		this.environmentId = grant.environmentId;
		this.actor = grant.actor;
	}
}

/** A machine's open view, as one connection holds it. */
export interface ViewHandle {
	readonly asOfSeq: number;
	list(path: string, after: string | undefined): Promise<{ entries: readonly WireEntry[]; next: string | null }>;
	read(request: ReadRequest): Promise<Buffer>;
	subscribe(sink: FeedSink): void;
	release(): void;
}

/** The node's folder service: one tree per view, built from the core and kept current from its feed; listings from
 * that tree; bytes from the storage server's share. It keeps nothing but memory. */
export class FolderService {
	readonly #core: FolderCore;
	readonly #objects: NasObjects;
	readonly #grants: MountGrants;
	readonly #pollMs: number;
	readonly #reloadMs: number;
	readonly #supersededMs: number;
	readonly #idleMs: number;
	readonly #now: () => number;
	readonly #log: (line: string) => void;
	readonly #views = new Map<string, View>();
	readonly #profiles = new Map<string, string>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#heartbeat: ReturnType<typeof setInterval> | undefined;
	#polling = false;

	constructor(options: FolderServiceOptions) {
		this.#core = options.core;
		this.#objects = options.objects;
		this.#grants = options.grants;
		this.#pollMs = options.pollMs ?? 500;
		this.#reloadMs = options.reloadMs ?? 10 * 60_000;
		this.#supersededMs = options.supersededMs ?? 60_000;
		this.#idleMs = options.idleMs ?? 60_000;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
	}

	start(): void {
		this.#timer ??= setInterval(() => void this.poll(), this.#pollMs);
		this.#heartbeat ??= setInterval(() => this.heartbeat(), HEARTBEAT_MS);
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#timer = undefined;
		this.#heartbeat = undefined;
	}

	/** Checks a machine's hello and opens (or joins) its view. The first connection of a view lists its tree. */
	async open(hello: Hello, cid: number): Promise<ViewHandle> {
		const grant = await this.#grants.admit(hello, cid);
		let view = this.#views.get(grant.key);
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
			if (view.connections === 0) view.idleSince = this.#now();
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
			list: async (path, after) => this.#list(view, path, after),
			read: async (request) => this.#read(view, request),
			subscribe: (sink) => {
				if (released || view.closed) return sink.closed(ErrorCode.viewClosed, view.closed ?? "Released");
				mine = sink;
				view.sinks.add(sink);
			},
			release,
		};
	}

	/** One round: read the clocks of every company with a live view, move views whose company moved, list again those
	 * due, send heartbeats, and drop views idle for long enough. Exposed for tests. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const now = this.#now();
			for (const [key, view] of this.#views) {
				if (view.idleSince !== undefined && now - view.idleSince >= this.#idleMs) this.#views.delete(key);
				for (const [path, old] of view.superseded) if (old.until <= now) view.superseded.delete(path);
			}
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
				if (now - view.loadedAt >= this.#reloadMs) this.#queue(view, () => this.#reload(view, "scheduled"));
				else if (last !== undefined && last > view.seq) this.#queue(view, () => this.#advance(view));
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
		for (const sink of view.sinks) sink.closed(ErrorCode.viewClosed, reason);
		view.sinks.clear();
		this.#log(`folder-service: ${view.key} closed: ${reason}`);
	}

	async #firstLoad(view: View): Promise<void> {
		try {
			const { tree, seq } = await this.#listAll(view);
			view.tree = tree;
			view.seq = seq;
			view.cursor = null;
			view.loadedAt = this.#now();
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
	 * serves, lists the whole view again. */
	async #advance(view: View): Promise<void> {
		const tree = view.tree;
		if (!tree || view.closed) return;
		const changed: string[] = [];
		for (;;) {
			const page = await this.#core.feed(view.environmentId, view.actor, view.seq, view.cursor);
			if (page.resync) return this.#reload(view, "the feed asked for it", changed);
			for (const event of page.events) {
				if (event.kind === "authority") return this.#reload(view, "access changed", changed);
				for (const change of event.changes) {
					const before = tree.get(change.path);
					changed.push(...tree.apply(change));
					const after = tree.get(change.path);
					if (before?.kind === "file" && before.version !== after?.version)
						view.superseded.set(`${change.path}\0${before.version}`, {
							entry: before,
							until: this.#now() + this.#supersededMs,
						});
				}
			}
			view.seq = page.next.afterSeq;
			view.cursor = page.next.cursor;
			if (!page.more) break;
		}
		this.#push(view, changed);
	}

	/** Lists the view again and tells its machines what differs. Superseded versions are forgotten: access may have
	 * narrowed. */
	async #reload(view: View, why: string, alreadyChanged: readonly string[] = []): Promise<void> {
		const before = view.tree;
		if (!before || view.closed) return;
		const { tree, seq } = await this.#listAll(view);
		// Catch the new tree up to the end of the feed before it replaces the old one. An access change (or a
		// position the core no longer serves) meanwhile makes the next round list again.
		let position: { afterSeq: number; cursor: FeedCursor | null } = { afterSeq: seq, cursor: null };
		let again = false;
		for (;;) {
			const page = await this.#core.feed(view.environmentId, view.actor, position.afterSeq, position.cursor);
			if (page.resync) {
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
		view.superseded.clear();
		const changed = [...alreadyChanged, ...ViewTree.diff(before, tree)];
		this.#log(`folder-service: ${view.key} listed again (${why}): ${tree.size} paths, ${changed.length} changed`);
		this.#push(view, changed);
	}

	#push(view: View, changed: readonly string[]): void {
		if (changed.length === 0) return;
		const paths = [...new Set(changed)];
		const message: ChangeMessage =
			paths.length > RESYNC_OVER
				? { seq: view.seq, resync: true, paths: [] }
				: { seq: view.seq, resync: false, paths };
		for (const sink of view.sinks) sink.change(message);
	}

	#tree(view: View): ViewTree {
		if (view.closed) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
		if (!view.tree) throw new ProtocolError(ErrorCode.unavailable, "The view is not listed yet");
		return view.tree;
	}

	#list(view: View, path: string, after: string | undefined) {
		const result = this.#tree(view).children(path, after, LIST_PAGE);
		if (result === "not_found") throw new ProtocolError(ErrorCode.notFound, "No such folder");
		if (result === "not_a_folder") throw new ProtocolError(ErrorCode.notAFolder, "Not a folder");
		return result;
	}

	async #read(view: View, request: ReadRequest): Promise<Buffer> {
		const current = this.#tree(view).get(request.path);
		let entry: TreeEntry | undefined;
		if (current?.version === request.version) entry = current;
		else entry = view.superseded.get(`${request.path}\0${request.version}`)?.entry;
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
				this.#log(`folder-service: ${view.key}: ${request.path} v${entry.version}: ${error.message}`);
			throw new ProtocolError(ErrorCode.unavailable, "The file's bytes could not be read now");
		}
	}

	/** The company's storage profile, learnt once through the core's download check of an object this view reads. */
	async #profile(view: View, entry: TreeEntry): Promise<string> {
		const known = this.#profiles.get(view.environmentId);
		if (known) return known;
		const profileId = await this.#core.objectProfile(view.environmentId, view.actor, entry.manifestSha256!);
		this.#profiles.set(view.environmentId, profileId);
		return profileId;
	}
}
