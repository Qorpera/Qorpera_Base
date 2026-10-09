import { randomUUID, timingSafeEqual } from "node:crypto";
import { companyStatePath } from "@qorpera/cloud-client/company-state-files";
import { memberFolderStructured } from "../member-folder-commits.ts";
import {
	COMMAND_ENDED,
	type CommitActor,
	type CommitAnswer,
	type ConflictCopy,
	CoreRefusal,
	type FeedCursor,
	type FolderActor,
	type FolderCore,
	MEMBER_HELD_READS,
	type ReleasedRead,
} from "./core.ts";
import type { CoreAccess, Grant, MountGrants } from "./mounts.ts";
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
	type ReadLogEntry,
	type ReadRequest,
	type ReadsAnswer,
	type ReadsRequest,
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
/** Reads in one release: the core's bound (core §6). */
const RELEASE_READS = 10_000;
/** The receipt of a read logged with none: it names no resource, so the core checks the path again and files the
 * receipt it reads now (`qorpera_folder_release_pairs`). */
const NO_RECEIPT = {
	resourceId: "00000000-0000-0000-0000-000000000000",
	resourceRevision: 0,
	grantId: null,
	grantRevision: null,
} as const;

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
	/** A command's final change set closed the view (F3 4b): nothing is kept pending. */
	readonly closed?: true;
	/** The core refused the change set whole, or the release of the view's reads before it, and why (`denied`: 42501;
	 * `unreadable`: 42501, a read being released is no longer readable; `run_ended`: 42501, the run the view acts for
	 * has ended; `stopped`: the pause, 55000; `invalid`: 22023, a change set over 1000 units among others): an answer,
	 * unlike a boundary that got none (F3 4b, 4c). `unproven`: the view's machine cannot show its read log complete, so
	 * this and every later boundary of the view is refused (F3 4c, the log's rule 4). */
	readonly refused?: CoreRefusal["reason"] | "unproven";
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

/** A file a published move took to its path: the version it had where it came from, and the one the move gave it. */
interface MovedVersion {
	readonly prior: string;
	readonly version: string;
}

/** The core's answer to a commit; a change set it refused whole is one too (every unit not applied), with why and the
 * core's message. */
type Answer = CommitAnswer & { readonly refused?: CoreRefusal["reason"]; readonly said?: string | undefined };

/** What a view's last boundary heard (F3 4c): `open`, none yet or a refusal that may lift (the pause, the run check,
 * or a command's save after its command ended, which only its final may make); `answered`; or `refused`. */
type Heard = "open" | "answered" | "refused";

function heardOf(answer: Answer | undefined): Heard {
	if (!answer) return "open";
	if (answer.commitId) return "answered";
	return mayLift(answer.refused) || answer.said === COMMAND_ENDED ? "open" : "refused";
}

/** A refusal a later boundary may get past: the pause, and the run check (once the run's job ends, the view resolves
 * without its run). */
function mayLift(refused: Report["refused"]): boolean {
	return refused === "stopped" || refused === "run_ended";
}

/** A change set refused whole that is not settled: what it carried stays pending, to be published again. A command's
 * (only its final closes its view), and a desktop's refused in a way that may lift (F3 4c). */
function holds(view: View, answer: Answer): boolean {
	return !answer.commitId && (view.access?.command === true || mayLift(answer.refused));
}

/** A report's commit: its id and position, or, for a change set the core refused whole, why. */
function committed(answer: Answer): Pick<Report, "commitId" | "seq" | "refused"> {
	return answer.refused
		? { commitId: null, seq: null, refused: answer.refused }
		: { commitId: answer.commitId, seq: answer.seq };
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

/** The report of a boundary that published and settled nothing: every path it planned stays pending, what it would
 * drop included (the next boundary that settles drops it). */
function held(
	plan: BoundaryPlan,
	outcome: (unit: number) => { readonly outcome: ReportEntry["outcome"]; readonly reason?: string | null | undefined },
): ReportEntry[] {
	return [
		...plan.dropped.map((d): ReportEntry => ({ path: d.path, outcome: "not_applied", reason: d.reason, kept: true })),
		...plan.units.flatMap((u, i) => {
			const { outcome: o, reason } = outcome(i);
			return u.paths.map((path): ReportEntry => ({ path, outcome: o, ...(reason ? { reason } : {}), kept: true }));
		}),
	];
}

/** One read log of a view (F3 4c): its entries up to `taken` are held here, up to `released` the core has them. Those
 * between wait in `unreleased`, oldest first, but for one the log already holds unreleased (`keys`), which is released
 * with it. */
interface ReadLog {
	taken: number;
	released: number;
	readonly unreleased: LoggedRead[];
	readonly keys: Set<string>;
}

/** An entry of a read log the core does not have yet: its number, and the read as the core files it. */
interface LoggedRead {
	readonly seq: number;
	readonly read: ReleasedRead;
	readonly key: string;
}

/** A release asked of the core: its id and reads, and the last entry of each log it releases. */
interface Release {
	readonly id: string;
	readonly reads: readonly ReleasedRead[];
	readonly upTo: ReadonlyMap<ReadLog, number>;
}

function readKey(read: ReleasedRead): string {
	return JSON.stringify([read.path, read.version, read.authority]);
}

/** The paths a boundary leaves waiting (an open file among them), kept pending. */
function waitingOf(plan: BoundaryPlan): ReportEntry[] {
	return plan.waiting.map((w): ReportEntry => ({ path: w.path, outcome: "waiting", reason: w.reason, kept: true }));
}

/** The report of a boundary whose commit got no answer: every path it planned stays pending, to be asked again. */
function notYet(plan: BoundaryPlan): ReportEntry[] {
	return plan.units.flatMap((u) =>
		u.paths.map(
			(path): ReportEntry => ({
				path,
				outcome: "not_applied",
				reason: "the save did not get through yet",
				kept: true,
			}),
		),
	);
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
	/** The view may write (step 3: an operator mount configured so; step 4: a computer desktop). A core view's is set at
	 * its first renewal, from what the core says it is (`access`). */
	write: boolean;
	quietMs: number | undefined;
	/** A core view's kind and machine, as its first renewal said them, and which machines it is served to. */
	identity: { readonly kind: string; readonly machineId: string | null } | undefined;
	access: CoreAccess | undefined;
	/** A machine `access` admits has held it: a command's view is then kept when its last connection leaves. */
	admitted = false;
	/** Since when the view has had changes not published (ms): sent at each renewal, so the core counts a desktop's seat
	 * in use while it has some. */
	unsavedSince: number | undefined;
	/** The core may count it so: a renewal sent a time, and none answered has sent null since. */
	unsavedSent = false;
	/** One renewal at a time, so an early one and a round's never cross. */
	renewing: Promise<void> = Promise.resolve();
	/** Its pending changes, once listed (a writable view only). */
	pending: PendingView | undefined;
	quiet: ReturnType<typeof setTimeout> | undefined;
	/** One boundary at a time. */
	publishing: Promise<Report> = Promise.resolve({ commitId: null, seq: null, paths: [] });
	/** A boundary whose commit got no answer: asked again, unchanged (a final one final), as the actor it was asked as,
	 * before the next one. A view's close keeps it: a final may be what closed the view. */
	unanswered:
		| {
				readonly key: string;
				readonly actor: FolderActor;
				readonly units: readonly CommitUnit[];
				readonly plan: BoundaryPlan;
				readonly made: ReadonlyMap<string, string>;
				readonly final: boolean;
		  }
		| undefined;
	/** A final's commit is being asked: a renewal that closes the view meanwhile keeps it, as for a final with no
	 * answer. */
	askingFinal = false;
	/** A boundary answered but not settled yet (the feed has not brought its change set). */
	unsettled: Settlement | undefined;
	/** What this view's saves and moves published, by path, newest last (as many as the readable versions kept per
	 * path): the version the path showed the machine while pending (a save's own, the one the machine's version map
	 * holds after it; or, for a file this view moved there, the one it had before) and the version the change set gave
	 * the path. */
	readonly published = new Map<string, { readonly made: string; readonly live: string }[]>();
	readonly uploads = new Map<string, ChunkUpload>();
	/** The intents that root the bytes of its pending files, by id. */
	readonly intents = new Map<string, HeldIntent>();
	/** The write handles open on the view. The machine's program pools its connections, so any of them may use a
	 * handle; they are abandoned when the view's last connection ends. */
	readonly handles = new Set<number>();
	/** The reads its machine logged (protocol 3, F3 4c), by log. They are kept with the view only: after it connects
	 * again a machine sends every read it has not heard released, so a view dropped, or a service restarted, may have
	 * some released twice, which files nothing new. */
	readonly logs = new Map<string, ReadLog>();
	/** A release with no answer (or refused): asked again first, the same. */
	releasing: Release | undefined;
	/** Its machine cannot show its read log complete (the log's rule 4): every later boundary is refused. */
	unproven = false;
	/** What its last boundary heard, until a change or a read since. A desktop no machine holds is kept while it is
	 * `open`, and a command's unless it is `refused` (F3 4c). */
	heard: Heard | undefined;

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
		this.identity = undefined;
		this.access = undefined;
		this.unsavedSince = undefined;
	}

	/** A core view (a run's own, opened by the core), closed or not; an operator mount's view is not. */
	get core(): boolean {
		return this.#operator === undefined;
	}

	/** Reads its machine logged wait for a release. */
	get unreleased(): boolean {
		for (const log of this.logs.values()) if (log.unreleased.length > 0) return true;
		return false;
	}

	/** A final of its is out (being asked, or with no answer): it may be what closed the view, which stays for it. */
	get finalOut(): boolean {
		return this.askingFinal || this.unanswered?.final === true;
	}

	/** Who the core reads as. A core view's actor carries its pass, so it exists only while the view does (a boundary
	 * with no answer keeps the one it was asked as, to ask again). */
	get actor(): FolderActor {
		if (this.#operator) return this.#operator;
		if (!this.lease) throw new ProtocolError(ErrorCode.viewClosed, this.closed ?? "The view is closed");
		return { kind: "view", viewId: this.lease.viewId, pass: this.lease.pass };
	}
}

/** A machine's open view, as one connection holds it. */
export interface ViewHandle {
	readonly asOfSeq: number;
	/** The view takes writes (protocol 2; a core view's from protocol 3, whose machine logs its reads). */
	readonly writable: boolean;
	/** A core view: its reads go to read sets. */
	readonly core: boolean;
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
	/** `final`: a command view's last boundary, whose change set closes the view (F3 4b). */
	publish(final?: boolean): Promise<Report>;
	/** Entries of the machine's read log, released before the view's next boundary (protocol 3, F3 4c). */
	reads(request: ReadsRequest): Promise<ReadsAnswer>;
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

	/** Renews the lease of every core view a machine is connected to, and of every command's view kept for its final
	 * boundary; a view the core closed is closed on every connection. Another view no machine holds is not renewed: its
	 * lease runs out, unless the core closed it first (a run's end closes its run box). A renewal that cannot reach the
	 * core leaves the confirmed lease to run out: past it the view is not served (UNAVAILABLE) until a renewal succeeds.
	 * Exposed for tests. */
	async renewLeases(): Promise<void> {
		await Promise.all(
			[...this.#views.values()]
				.filter((view) => view.lease && view.tree && (view.connections > 0 || this.#kept(view)) && !view.closed)
				.map(async (view) => {
					try {
						await this.#renew(view);
					} catch (error) {
						this.#log(`folder-service: ${view.key}: lease not renewed now: ${(error as Error).message}`);
					}
				}),
		);
	}

	/** One renewal, after any running one: the confirmed lease moves on, or the view closes. Throws when the core could
	 * not answer. `lettingGo`: the view is about to be dropped with whatever it has pending, so nothing is unsaved. */
	#renew(view: View, lettingGo = false): Promise<void> {
		const next = view.renewing.catch(() => undefined).then(() => this.#renewNow(view, lettingGo));
		view.renewing = next;
		return next;
	}

	async #renewNow(view: View, lettingGo: boolean): Promise<void> {
		const lease = view.lease;
		if (!lease) return;
		// No seat waits on a command: its view never says it has changes unsaved.
		if (lettingGo || !view.pending?.unsaved || view.access?.command) view.unsavedSince = undefined;
		else view.unsavedSince ??= this.#now();
		const unsaved = view.unsavedSince === undefined ? null : new Date(view.unsavedSince).toISOString();
		if (unsaved !== null) view.unsavedSent = true;
		let renewal: Awaited<ReturnType<FolderCore["renewView"]>>;
		const asked = this.#now();
		try {
			renewal = await this.#core.renewView(lease.viewId, lease.pass, unsaved);
		} catch (error) {
			if (error instanceof CoreRefusal && error.forbidden) return this.#close(view, "The view was refused");
			throw error;
		}
		if (unsaved === null) view.unsavedSent = false;
		// A view closed while the renewal ran (another answer, or no machine holds it) stays closed.
		if (view.closed) return;
		if (renewal.state === "closed") return this.#close(view, `The view was ${renewal.reason}`);
		// The first answer says what the view is, and so how it is served and to which machines; a view never changes
		// kind or machine.
		if (!view.identity) {
			view.identity = { kind: renewal.kind, machineId: renewal.machineId };
			view.access = this.#grants.coreAccess(view.identity);
			view.write = view.access?.write ?? false;
			view.quietMs = view.access?.quietMs;
		} else if (view.identity.kind !== renewal.kind || view.identity.machineId !== renewal.machineId)
			return this.#close(view, "The view's kind or machine changed");
		// The core's clock says until when; never trust it for longer than one lease from now.
		view.leaseUntil = Math.min(Date.parse(renewal.leaseUntil), asked + LEASE_MS);
		view.confirmed = true;
	}

	/** Checks a machine's hello and opens (or joins) its view. The first connection of a view lists its tree. */
	async open(hello: Hello, bridge: BridgeInfo): Promise<ViewHandle> {
		const grant = this.#grants.admit(hello, bridge);
		let view = this.#views.get(grant.key);
		// A view that closed while a final of its was out stays, joined only to ask that final again.
		const asksFinal = view?.closed !== undefined && view.finalOut;
		// Joining an open view (or one kept for its final) takes the pass, and the company folder, it was opened with. A
		// hello the core has not checked yet never locks out another: while it is being checked the other is asked to try
		// again, and an unchecked view is replaced.
		if (
			view &&
			(!view.closed || asksFinal) &&
			(view.environmentId !== grant.environmentId || !timingSafeEqual(view.passSha256, grant.passSha256))
		) {
			if (view.confirmed)
				throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
			if (view.loading) throw new ProtocolError(ErrorCode.unavailable, "The view is being checked; try again");
			view = undefined;
		}
		if (!view || (view.closed && !asksFinal)) {
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
			// A command's view stays, with what it has pending and its lease: the command's last call publishes it, final.
			// So does a desktop's whose last boundary had no answer, or a refusal that may lift: a later publish from its
			// machine publishes it, and nothing else does (F3 4c). A boundary still running decides again as it ends.
			if (this.#kept(view)) {
				if (view.quiet) clearTimeout(view.quiet);
				view.quiet = undefined;
				return;
			}
			view.idleSince = this.#now();
			// A core view no machine holds is dropped (with its pass): its lease is not renewed while idle, so a machine
			// that comes back lists it again and renews at once. What it has pending, and the reads its machine logged, are
			// published first, under the lease it still has (a desktop that ended inside its quiet period); a machine that
			// comes back meanwhile joins it. A command's never publishes unasked. Either way the view is kept or let go
			// once its last boundary has ended (#inTurn).
			if (!view.lease || this.#views.get(view.key) !== view) return;
			if (view.access?.command || ((!view.pending || view.pending.empty) && !view.unreleased)) {
				void this.#inTurn(view, async () => ({ commitId: null, seq: null, paths: [] }));
				return;
			}
			if (view.quiet) clearTimeout(view.quiet);
			view.quiet = undefined;
			void this.#publishLogged(view);
		};
		try {
			view.loading ??= this.#firstLoad(view);
			await view.loading;
			if (view.closed && !view.finalOut) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
			// A core view is served only to the machines its kind and machine name: a desktop to its own company machine.
			if (view.core && !view.access?.admits(bridge))
				throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
			view.admitted = true;
		} catch (error) {
			release();
			throw error;
		}
		return {
			asOfSeq: view.seq,
			writable: view.pending !== undefined,
			core: view.core,
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
			publish: async (final = false) => {
				if (final && !view.access?.command)
					throw new ProtocolError(ErrorCode.badRequest, "Only a command view publishes a final change set");
				return this.#publish(view, final);
			},
			reads: async (request) => this.#takeReads(view, request),
		};
	}

	/** A view a machine it admits has held, open, kept with no connection and renewed (F3 4b, 4c): a command's for its
	 * final boundary, unless its last boundary was refused for good; a desktop's while its last boundary had no answer,
	 * or a refusal that may lift, until a later publish from its machine gets another answer. */
	#kept(view: View): boolean {
		return (
			view.admitted &&
			view.lease !== undefined &&
			!view.closed &&
			this.#views.get(view.key) === view &&
			(view.access?.command === true ? view.heard !== "refused" : view.heard === "open")
		);
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
		if (error instanceof CoreRefusal && error.forbidden) {
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
		this.#forgetReads(view);
		// The pass goes with it: a closed view makes no more calls, but a final with no answer asked again as it was.
		view.lease = undefined;
		this.#forgetClosed(view);
		for (const sink of view.sinks) sink.closed(ErrorCode.viewClosed, reason);
		view.sinks.clear();
		this.#log(`folder-service: ${view.key} closed: ${reason}`);
	}

	/** Forgets a closed view, unless a final of its is out: that final may be what closed it, so the view stays where its
	 * machine finds it again, until it has been idle as long as any other. */
	#forgetClosed(view: View): void {
		if (view.finalOut) {
			if (view.connections === 0) view.idleSince ??= this.#now();
		} else if (this.#views.get(view.key) === view) this.#views.delete(view.key);
	}

	/** A final that did not close its view, which closed otherwise (a renewal heard why): the view goes now, as any
	 * closed one, and the machine hears why it closed. */
	#closedOtherwise(view: View): ProtocolError {
		this.#forgetClosed(view);
		return new ProtocolError(ErrorCode.viewClosed, view.closed ?? "The view is closed");
	}

	/** Drops a core view no machine holds (after its last boundary). A core that may count it as having unsaved changes
	 * hears first that it has none, so a desktop's seat is free now, not when the lease ends (C1B §9). */
	#letGo(view: View): void {
		if (view.connections > 0) return;
		if (!view.unsavedSent || !view.lease) {
			this.#drop(view);
			return;
		}
		void this.#renew(view, true)
			.catch((error: unknown) =>
				this.#log(`folder-service: ${view.key}: lease not renewed now: ${(error as Error).message}`),
			)
			.then(() => {
				if (view.connections === 0) this.#drop(view);
			});
	}

	/** Forgets a core view no machine holds, with its pass and anything its last boundary kept pending. */
	#drop(view: View): void {
		if (view.closed) return;
		if (this.#views.get(view.key) === view) this.#views.delete(view.key);
		view.lease = undefined;
		view.closed = "No machine holds the view";
		view.tree = undefined;
		view.pending?.clear();
		view.intents.clear();
		this.#forgetReads(view);
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = undefined;
	}

	/** A view's reads not released go with it: they reached no save of it. */
	#forgetReads(view: View): void {
		view.logs.clear();
		view.releasing = undefined;
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
			if (error instanceof CoreRefusal && error.forbidden) {
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
	 * "After a save the map holds the version the save made"). Likewise the version a file this view moved showed at its
	 * new path before the move was published: the move gave it a new one. */
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
		return this.#inTurn(view, async () => {
			await this.#trySettle(view);
			return { commitId: null, seq: null, paths: [] };
		});
	}

	/** One step in its turn among the view's boundaries, after any running one. The last of them on a view no machine
	 * holds decides whether it stays kept (#unheld): a boundary still running when its last connection left, or one
	 * that ran after (a change that landed then, and its quiet period), may have heard another answer. */
	#inTurn(view: View, step: () => Promise<Report>): Promise<Report> {
		const next = view.publishing.catch(() => undefined).then(step);
		view.publishing = next;
		const decide = (): void => {
			if (view.publishing === next) this.#unheld(view);
		};
		next.then(decide, decide);
		return next;
	}

	/** A core view no machine holds, with no boundary running: kept (renewed, and not forgotten while idle), or let go. */
	#unheld(view: View): void {
		if (view.connections > 0 || !view.lease || view.closed || this.#views.get(view.key) !== view) return;
		if (this.#kept(view)) view.idleSince = undefined;
		else this.#letGo(view);
	}

	/** A change restarts the quiet period of a mount that publishes on one, and the view's last boundary no longer says
	 * whether it is kept: a boundary carrying the change does. A core view's first change not published renews it at
	 * once, so the core counts a desktop's seat in use from then (C1B §9), not up to a round later; a command's view has
	 * no seat. */
	#touch(view: View): void {
		view.heard = undefined;
		if (view.lease && !view.access?.command && view.unsavedSince === undefined && view.pending?.unsaved) {
			view.unsavedSince = this.#now();
			this.#renew(view).catch((error: unknown) =>
				this.#log(`folder-service: ${view.key}: lease not renewed now: ${(error as Error).message}`),
			);
		}
		if (view.quietMs === undefined) return;
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = setTimeout(() => {
			view.quiet = undefined;
			void this.#publishLogged(view);
		}, view.quietMs);
		view.quiet.unref?.();
	}

	/** A boundary no machine asked for: what it did not save goes to the log, until step 4 routes it to the desktop. */
	async #publishLogged(view: View): Promise<void> {
		try {
			const report = await this.#publish(view);
			for (const entry of report.paths)
				if (entry.outcome !== "saved")
					this.#log(
						`folder-service: ${view.key}: ${entry.path}: ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ""}`,
					);
		} catch (error) {
			this.#log(`folder-service: ${view.key}: publish failed: ${(error as Error).message}`);
		}
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

	/** One boundary, after any running one (RUNTIME-FOLDER-WRITES.md, "A boundary"). `final`: a command's last. */
	#publish(view: View, final = false): Promise<Report> {
		return this.#inTurn(view, () => this.#boundary(view, final));
	}

	async #boundary(view: View, final: boolean): Promise<Report> {
		const pending = view.pending;
		if (final && view.closed) {
			// A final with no answer may be what closed the view: asked again under its key, as it was (the core answers
			// a replay on a closed view, given its pass), its answer is the report.
			const earlier = view.unanswered;
			if (earlier?.final) {
				const answer = await this.#commit(view, earlier.actor, earlier.key, earlier.units, true);
				if (!answer) return { commitId: null, seq: null, paths: notYet(earlier.plan) };
				view.unanswered = undefined;
				if (answer.commitId) return await this.#closedBy(view, earlier.plan, answer, []);
			}
			// Refused, or a final that finds its view closed otherwise: it did not close the view.
			throw this.#closedOtherwise(view);
		}
		// A view kept for its final takes nothing else.
		if (view.closed && view.finalOut) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
		if (!pending || view.closed) return { commitId: null, seq: null, paths: [] };
		return await this.#boundaryOf(view, pending, final);
	}

	/** A command's final boundary (F3 4b, C1B §8) publishes everything its view has pending, or nothing: one change
	 * set, empty when nothing is pending, whose answer closes the view. A path still waiting holds it back (the machine
	 * asks again). Each boundary first releases the reads the view's machine logged (F3 4c), and is refused if they
	 * are refused. `view.heard` keeps what it heard. */
	async #boundaryOf(view: View, pending: PendingView, final: boolean): Promise<Report> {
		const entries: ReportEntry[] = [];
		// An answered boundary the feed has not brought back yet settles first; nothing else is decided until it has.
		if (view.unsettled) {
			await this.#trySettle(view);
			if (view.unsettled)
				throw new ProtocolError(ErrorCode.busy, "The last save has not come back through the feed yet");
		}
		// A view whose machine cannot show its read log complete publishes nothing more, not even a boundary with no
		// answer asked again: what it carries may have been made from a read the core never had (the log's rule 4).
		if (view.unproven) {
			view.heard = "refused";
			const plan = planBoundary(pending, (node) =>
				node.staged?.version === node.version ? node.staged.file : undefined,
			);
			return {
				commitId: null,
				seq: null,
				refused: "unproven",
				paths: [...waitingOf(plan), ...held(plan, () => ({ outcome: "refused", reason: "unproven" }))],
			};
		}
		// A boundary whose answer never came goes first, unchanged (a final one final).
		if (view.unanswered) {
			const earlier = view.unanswered;
			const answer = await this.#commit(view, earlier.actor, earlier.key, earlier.units, earlier.final);
			if (!answer) {
				view.heard = "open";
				return { commitId: null, seq: null, paths: notYet(earlier.plan) };
			}
			view.unanswered = undefined;
			if (earlier.final && answer.commitId) return await this.#closedBy(view, earlier.plan, answer, []);
			// A final refused once a renewal had closed the view meanwhile did not close it.
			if (earlier.final && view.closed) throw this.#closedOtherwise(view);
			// A change set refused whole that holds is not settled: what it carried stays pending, and this boundary plans
			// it again.
			if (!holds(view, answer)) {
				entries.push(...(await this.#settle(view, earlier.plan, earlier.made, answer)));
				if (view.unsettled) {
					view.heard = heardOf(answer);
					return { ...committed(answer), paths: entries };
				}
			}
		}
		await this.#stageAll(view);
		const plan = planBoundary(pending, (node) =>
			node.staged?.version === node.version ? node.staged.file : undefined,
		);
		entries.push(...waitingOf(plan));
		if (final && plan.waiting.length > 0) {
			view.heard = "open";
			return {
				commitId: null,
				seq: null,
				paths: [
					...entries,
					...held(plan, () => ({ outcome: "not_applied", reason: "the final waits until every change can go" })),
				],
			};
		}
		// The reads reach the read sets before anything made from them is published (the log's rule 1).
		const release = await this.#releaseReads(view);
		if (release !== "released") {
			view.heard = release === "unanswered" || mayLift(release) ? "open" : "refused";
			return release === "unanswered"
				? {
						commitId: null,
						seq: null,
						paths: [
							...entries,
							...held(plan, () => ({ outcome: "not_applied", reason: "the save did not get through yet" })),
						],
					}
				: {
						commitId: null,
						seq: null,
						refused: release,
						paths: [...entries, ...held(plan, () => ({ outcome: "refused", reason: release }))],
					};
		}
		const dropped = plan.dropped.map(
			(d): ReportEntry => ({ path: d.path, outcome: "not_applied", reason: d.reason }),
		);
		if (plan.units.length === 0 && !final) {
			if (plan.dropped.length > 0)
				this.#settleNodes(
					view,
					plan.keep,
					plan.dropped.map((d) => d.path),
				);
			view.heard = "answered";
			return { commitId: null, seq: null, paths: [...entries, ...dropped] };
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
		// The actor is read once: a renewal that closes the view between two tries of a final (which closed it) does not
		// stop the next try, which the core answers as a replay. Nor does it drop the view, which stays for the final.
		const actor = view.actor;
		view.askingFinal = final;
		let answer: Answer | undefined;
		try {
			answer = await this.#commit(view, actor, key, units, final);
		} finally {
			view.askingFinal = false;
		}
		view.heard = heardOf(answer);
		if (!answer) {
			view.unanswered = { key, actor, units, plan, made, final };
			return { commitId: null, seq: null, paths: [...entries, ...dropped, ...notYet(plan)] };
		}
		if (final && answer.commitId) return await this.#closedBy(view, plan, answer, [...entries, ...dropped]);
		// A final refused once a renewal had closed the view meanwhile did not close it.
		if (final && view.closed) throw this.#closedOtherwise(view);
		// A change set refused whole that holds is not settled: what it carried stays pending, and the report says why. A
		// command's (its command ended, so only the final saves; or a final the core refused) waits for the final to carry
		// it; a desktop's refused by the pause or the run check, for a later boundary (F3 4c). Any other is let go.
		if (holds(view, answer))
			return {
				...committed(answer),
				paths: [...entries, ...held(plan, (i) => ({ outcome: "refused", reason: answer.units[i]?.reason }))],
			};
		entries.push(...dropped, ...(await this.#settle(view, plan, made, answer)));
		return { ...committed(answer), paths: entries };
	}

	// ---- The read log (protocol 3, F3 4c; RUNTIME-FOLDER-COMPANY-MACHINES.md, "Reads") ----------------------------------

	/** Takes entries of a machine's read log. A log the view does not know starts where the batch does; a known one
	 * takes a batch that starts at or before its next entry (those it took already are skipped) and leaves one with a
	 * gap, which the machine sends again from what the answer says the view took. `lost` makes every later boundary of
	 * the view refused. An operator mount's view keeps no read set: its reads count as released at once. So do those
	 * of a view kept only to ask its final again: the core answers it nothing but that final's replay, so no save comes
	 * of them (a dead program's `publish` hands its log over before it asks). */
	#takeReads(view: View, request: ReadsRequest): ReadsAnswer {
		if (view.closed) {
			if (!view.finalOut) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
			const last = request.reads.at(-1)?.seq ?? 0;
			return { log: request.log, taken: last, released: last };
		}
		if (request.lost) view.unproven = true;
		const first = request.reads[0];
		let log = view.logs.get(request.log);
		if (!log) {
			if (!first) return { log: request.log, taken: 0, released: 0 };
			log = { taken: first.seq - 1, released: first.seq - 1, unreleased: [], keys: new Set() };
			view.logs.set(request.log, log);
		}
		if (first && first.seq <= log.taken + 1)
			for (const entry of request.reads) {
				if (entry.seq <= log.taken) continue;
				log.taken = entry.seq;
				// A boundary since the view's last decides whether it is kept.
				view.heard = undefined;
				if (!view.core) continue;
				const read = this.#releasedRead(view, entry);
				const key = readKey(read);
				if (log.keys.has(key)) continue;
				log.keys.add(key);
				log.unreleased.push({ seq: entry.seq, read, key });
			}
		// Every entry taken was released, or is the same read as one that was.
		if (log.unreleased.length === 0) log.released = log.taken;
		return { log: request.log, taken: log.taken, released: log.released };
	}

	/** A logged read as the core files it, placed when it is taken: its version only when that names bytes the core made
	 * that the view shows the machine (a folder's listing has none, and a file this view saved and has not published is
	 * its own), as #read places it. A version the view can no longer place goes as none. */
	#releasedRead(view: View, entry: ReadLogEntry): ReleasedRead {
		const authority = entry.authority ?? NO_RECEIPT;
		if (entry.version === null) return { path: entry.path, version: null, authority };
		const pending = view.pending?.source(entry.path, entry.version);
		if (pending) return { path: entry.path, version: "live" in pending ? pending.live.version : null, authority };
		const version = this.#base(view, entry.path, entry.version) ?? entry.version;
		const placed =
			view.tree?.get(entry.path)?.version === version ||
			view.superseded.get(entry.path)?.some((old) => old.version === version);
		return { path: entry.path, version: placed ? version : null, authority };
	}

	/** Releases the reads the view's machine logged that the core does not have yet (core §6), the view as the actor, at
	 * most RELEASE_READS at a time. A release with no answer, or refused, is asked again first, the same (the core
	 * replays it). A member-held view's release is refused, as such a view records no reads: they count as released.
	 * The answer: every read released, none yet, or the core's refusal. */
	async #releaseReads(view: View): Promise<"released" | "unanswered" | CoreRefusal["reason"]> {
		if (!view.unreleased) return "released";
		const actor = view.actor;
		if (actor.kind !== "view") return "released";
		for (;;) {
			const release = view.releasing ?? this.#nextRelease(view);
			if (!release) return "released";
			view.releasing = release;
			let answered = false;
			for (let attempt = 0; attempt < 3 && !answered; attempt++) {
				try {
					await this.#core.releaseReads(view.environmentId, actor, release.id, release.reads);
					answered = true;
				} catch (error) {
					if (error instanceof CoreRefusal) {
						if (error.said !== MEMBER_HELD_READS) return error.reason;
						answered = true;
					} else this.#log(`folder-service: ${view.key}: release not answered: ${(error as Error).message}`);
				}
			}
			if (!answered) return "unanswered";
			view.releasing = undefined;
			for (const [log, upTo] of release.upTo) {
				const after = log.unreleased.findIndex((entry) => entry.seq > upTo);
				for (const entry of log.unreleased.splice(0, after === -1 ? log.unreleased.length : after))
					log.keys.delete(entry.key);
				// A read taken since that the log held unreleased was released with it.
				log.released = log.unreleased.length === 0 ? log.taken : Math.max(log.released, upTo);
			}
		}
	}

	/** The next release: the reads not released yet, oldest first, each once, at most RELEASE_READS. */
	#nextRelease(view: View): Release | undefined {
		const reads: ReleasedRead[] = [];
		const keys = new Set<string>();
		const upTo = new Map<ReadLog, number>();
		for (const log of view.logs.values())
			for (const entry of log.unreleased) {
				if (!keys.has(entry.key)) {
					if (reads.length === RELEASE_READS) break;
					keys.add(entry.key);
					reads.push(entry.read);
				}
				upTo.set(log, entry.seq);
			}
		return reads.length === 0 ? undefined : { id: randomUUID(), reads, upTo };
	}

	/** A command's final, answered: the core closed its view with it, so nothing stays pending and nothing settles. */
	async #closedBy(view: View, plan: BoundaryPlan, answer: CommitAnswer, entries: ReportEntry[]): Promise<Report> {
		const { entries: outcomes } = await this.#outcomes(view, plan, answer, true);
		this.#close(view, "The command's final change set was published");
		return { commitId: answer.commitId, seq: answer.seq, paths: [...entries, ...outcomes], closed: true };
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
	 * whole change set is an answer of its own (every unit not applied, and why). `final`: a command view's last. */
	async #commit(
		view: View,
		actor: FolderActor,
		key: string,
		units: readonly CommitUnit[],
		final = false,
	): Promise<Answer | undefined> {
		const as: CommitActor = final && actor.kind === "view" ? { ...actor, final: true } : actor;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.#core.commit(view.environmentId, as, key, units);
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
						refused: error.reason,
						said: error.said,
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
		const { entries, keep, saved } = await this.#outcomes(view, plan, answer);
		const settlement: Settlement = { plan, made, answer, keep, saved };
		view.unsettled = settlement;
		// A round that cannot reach the feed leaves the view unsettled; the next change or boundary tries again.
		for (let attempt = 0; attempt < 3 && view.unsettled === settlement && !view.closed; attempt++)
			await this.#trySettle(view);
		return entries;
	}

	/** What an answered boundary's report says of each path it published, and the paths it keeps pending and saved.
	 * `closing`: the view closes with the boundary (a command's final), and keeps nothing. */
	async #outcomes(
		view: View,
		plan: BoundaryPlan,
		answer: CommitAnswer,
		closing = false,
	): Promise<{ entries: ReportEntry[]; keep: Set<string>; saved: Set<string> }> {
		const entries: ReportEntry[] = [];
		const keep = new Set(plan.keep);
		const saved = new Set<string>();
		const copied = await this.#copied(view, plan, answer);
		plan.units.forEach((planned, i) => {
			const outcome = answer.units[i];
			// A parked unit is a proposal now (P40, C2 §8): the agent's next run reviews it, so the view lets it go and
			// shows the live folder, as for a unit saved.
			const parked = outcome?.outcome === "waiting_for_review" && outcome.reason === "parked";
			const kept = !closing && planned.bytes && outcome?.outcome !== "saved" && !parked && !copied.has(i);
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
		return { entries, keep, saved };
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
		// when one of them was saved. So are the versions a move gave what it moved.
		const written = new Map<string, string>();
		settlement.plan.units.forEach((planned, i) => {
			const outcome = settlement.answer.units[i];
			if (planned.unit.op === "write" && outcome?.outcome === "saved" && outcome.version)
				written.set(planned.unit.path, outcome.version);
		});
		let moved: ReadonlyMap<string, MovedVersion> = new Map();
		const someMoved = settlement.plan.units.some(
			(planned, i) => planned.unit.op === "move" && settlement.answer.units[i]?.outcome === "saved",
		);
		if (someMoved || [...settlement.made.keys()].some((path) => settlement.saved.has(path) && !written.has(path)))
			try {
				const changeSet = await this.#changeSet(view, seq);
				for (const [path, version] of changeSet.writes) if (!written.has(path)) written.set(path, version);
				moved = changeSet.moved;
			} catch (error) {
				this.#log(
					`folder-service: ${view.key}: change set ${seq} could not be read now: ${(error as Error).message}`,
				);
				return;
			}
		if (view.unsettled === settlement) this.#finishSettle(view, settlement, written, moved);
	}

	/** The versions change set `seq` wrote, and those its moves gave (with the version each path had where it came
	 * from), read from the feed just before it: whatever the view's own rounds did since (a full listing included), the
	 * change set says exactly. A feed that no longer serves that position gives none. */
	async #changeSet(
		view: View,
		seq: number,
	): Promise<{ writes: Map<string, string>; moved: Map<string, MovedVersion> }> {
		const writes = new Map<string, string>();
		const moved = new Map<string, MovedVersion>();
		let position: { afterSeq: number; cursor: FeedCursor | null } = { afterSeq: seq - 1, cursor: null };
		for (;;) {
			const page = await this.#core.feed(view.environmentId, view.actor, position.afterSeq, position.cursor);
			if (page.resync || !page.next) return { writes, moved };
			for (const event of page.events) {
				if (event.seq > seq) return { writes, moved };
				if (event.seq === seq && event.kind === "change_set")
					for (const change of event.changes) {
						if (change.op === "write") writes.set(change.path, change.version);
						if (change.op === "move_in" && change.kind === "file" && change.priorVersion)
							moved.set(change.path, { prior: change.priorVersion, version: change.version });
					}
			}
			if (!page.more) return { writes, moved };
			position = page.next;
		}
	}

	#finishSettle(
		view: View,
		settlement: Settlement,
		written: ReadonlyMap<string, string>,
		moved: ReadonlyMap<string, MovedVersion> = new Map(),
	): void {
		view.unsettled = undefined;
		this.#notePublished(view, settlement, written, moved);
		this.#settleNodes(
			view,
			settlement.keep,
			settlement.plan.units.flatMap((u) => u.paths),
			settlement.saved,
		);
	}

	/** The versions this boundary's saves published, for bases and reads naming the versions they made; and the versions
	 * its moves gave the files they moved, for bases and reads naming the version a file showed at its new path while
	 * the move was pending (the one it had before), or a version this view's own save made of it before the move (the
	 * machine's version map takes a save's version along when it renames the file). As many are kept per path as
	 * versions of it stay readable: the current one and the replaced ones. */
	#notePublished(
		view: View,
		settlement: Settlement,
		written: ReadonlyMap<string, string>,
		moved: ReadonlyMap<string, MovedVersion>,
	): void {
		// One per version named at a path: a file moved away and back brings its save's version along again, and the
		// version it has now replaces the one it had when it left.
		const alias = (path: string, made: string, live: string): void => {
			const aliases = (view.published.get(path) ?? []).filter((p) => p.made !== made);
			aliases.push({ made, live });
			if (aliases.length > SUPERSEDED_PER_PATH + 1) aliases.shift();
			view.published.set(path, aliases);
		};
		for (const [path, made] of settlement.made) {
			const live = settlement.saved.has(path) ? written.get(path) : undefined;
			if (live) alias(path, made, live);
		}
		if (moved.size === 0) return;
		// The versions this view's saves made, by the version they published (at any path, before the moves).
		const madeOf = new Map<string, string[]>();
		for (const aliases of view.published.values())
			for (const { made, live } of aliases) {
				const versions = madeOf.get(live);
				if (versions) versions.push(made);
				else madeOf.set(live, [made]);
			}
		for (const [path, { prior, version }] of moved) {
			alias(path, prior, version);
			for (const made of madeOf.get(prior) ?? []) if (made !== prior) alias(path, made, version);
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
		// Nothing left unsaved (a lock or swap file a program still holds is none): the next renewal tells the core so,
		// and the desktop's seat is free again.
		if (!pending.unsaved) view.unsavedSince = undefined;
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
