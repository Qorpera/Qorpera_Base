import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { companyStatePath } from "@qorpera/cloud-client/company-state-files";
import { memberFolderStructured } from "../member-folder-commits.ts";
import {
	COMMAND_ENDED,
	type CommitActor,
	type CommitAnswer,
	type CommitOutcome,
	type ConflictCopy,
	CoreRefusal,
	type FeedCursor,
	type FolderActor,
	type FolderCore,
	type GitLease,
	type GitPublish,
	type GitVersions,
	MEMBER_HELD_READS,
	READ_UNREADABLE,
	type ReleasedRead,
} from "./core.ts";
import {
	type GitUnit,
	gitBatches,
	gitDir,
	gitFolders,
	gitGuarded,
	gitLockTarget,
	gitPackedRefsTarget,
	gitPublishedObject,
	gitReflog,
	gitRefused,
	gitSharedPath,
} from "./git.ts";
import { type StoredForm, storedForm } from "./git-objects.ts";
import type { CoreAccess, Grant, MountGrants, ViewIdentity } from "./mounts.ts";
import { NOTICES_KEPT, noticeOf, pageOfNotices } from "./notices.ts";
import { type NasObjects, ObjectIntegrityError, ObjectUnavailableError } from "./objects.ts";
import {
	CHUNK_BYTES,
	type ChunkRef,
	type Content,
	type FileRef,
	type PendingFile,
	PendingView,
	PublishFirst,
} from "./pending.ts";
import { type BoundaryPlan, type CommitUnit, planBoundary, type SecretCheck } from "./plan.ts";
import {
	type BridgeInfo,
	type ChunkPart,
	ErrorCode,
	type Hello,
	LIST_PAGE,
	type LinkRequest,
	MAX_PAYLOAD,
	type Notice,
	type NoticesAnswer,
	type NoticesRequest,
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
import { CARRIES, SecretRefusal, type SecretSet } from "./secret-scan.ts";
import { type FolderStaging, mediaTypeOf, type Upload } from "./staging.ts";
import { nameOf, type TreeEntry, ViewTree } from "./view-tree.ts";
import {
	type Before,
	type Changed,
	type CommandWindow,
	CommandWindows,
	type CreditedUnit,
	CreditTags,
} from "./windows.ts";

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
	/** The machines the run before this one vouched for when it stopped cleanly (its note, `clean-stop.ts`): none of
	 * them holds a read an earlier run served and never released. Every other machine may (a run that crashed, or
	 * stopped without a clean stop, leaves no note, and then this is empty), so it is lost until the executor says it
	 * restarted (`restarted`). Without it (tests), no machine is lost at the start. */
	readonly vouched?: readonly string[];
}

/** More changed paths than this in one push, or a message too large for one frame: the machine is told to drop
 * everything instead. */
const RESYNC_OVER = 5_000;

/** A name no folder holds (the Company File refuses a control character). Told below a folder, it drops the machine's
 * listing of the folder and keeps the folder's own entry: what a view's own new folder going live is told as. */
export const LISTING_ONLY = "\u0001";
/** Replaced versions of one path kept readable for files opened before (an engineering bound on memory: a file
 * opened that many versions ago reads ESTALE). They go when the path leaves the view. */
const SUPERSEDED_PER_PATH = 16;
/** The machine's folder program treats 45 s without a frame as a dead link. */
const HEARTBEAT_MS = 15_000;
/** A core view's lease is 120 s; it is renewed every 40 s while a machine is connected (C1b-3a). */
const RENEW_MS = 40_000;
const LEASE_MS = 120_000;
/** A closed desktop keeps its pending state for a successor hello, never for serving the old holder. A test machine's
 * view closed other than by its final stays as long, with nothing, so its machine's boundaries list it closed. */
const CLOSED_GRACE_MS = 60_000;
const VIEW_ENDED = "Folder view has ended";
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
/** The log a coding view's reads are recorded in as they are served (F3 5c): no machine's log, whose ids are uuids. */
const SERVED = "served";
/** Reads a coding view keeps as released, so a read served again is not released again (the machine's read set keeps
 * it); past this many it forgets them all, and releases a read again the next time it is served. */
const SERVED_RELEASED_KEPT = 100_000;
/** Times a coding machine's boundary releases the reads of all its views before it answers. A view may be served more
 * while the others' releases are out, so each round is followed by another until none has a read left; a machine that
 * reads on through every round has its boundary answered as having no answer yet. */
const MACHINE_RELEASE_ROUNDS = 8;
const STOPPING = "The folder service is stopping; try again";

/** One changed path's outcome at a boundary (RUNTIME-FOLDER-WRITES.md, "Outcomes and the report"). */
export interface ReportEntry {
	readonly path: string;
	readonly outcome: "saved" | "conflict" | "refused" | "denied" | "waiting_for_review" | "not_applied" | "waiting";
	readonly reason?: string;
	/** A conflict's receipt: the change set that keeps this view's version (P17). */
	readonly receipt?: string;
	/** The change is still pending in this view. */
	readonly kept?: boolean;
	/** A conflicting link's target, kept on the receipt (protocol 4). */
	readonly target?: string;
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

/** A coding machine's boundary (F3 5c, the plan's "Boundaries"), as the executor asks it over the control socket. */
export interface MachineBoundary {
	readonly machine: string;
	/** What came of releasing every read the machine was served before the answer: `released`, so its output may reach
	 * a model; `unanswered`, none yet; the core's refusal (the plan's rule 4: `unreadable` moves the machine); or
	 * `unproven`, a read it was served went unreleased (by a run before this one too, unless it vouched for the machine),
	 * so the executor restarts it (and says so, `restarted`), or it restarted while the boundary was out. Only `released`
	 * lets output go. */
	readonly reads: Released | "unproven";
	/** Each open view of the machine's boundary, or why it had none. */
	readonly views: readonly MachineViewReport[];
}

export interface MachineViewReport {
	readonly viewId: string;
	readonly report?: Report;
	readonly error?: { readonly code: ErrorCode; readonly message: string };
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
 * (only its final closes its view), and a desktop's refused in a way that may lift (F3 4c). A coding session's too, but
 * at its last boundary, where a refusal that may not lift is final (F3 5c, the plan's rule 4). */
function holds(view: View, answer: Answer, last = false): boolean {
	if (answer.commitId) return false;
	if (view.access?.command === true || mayLift(answer.refused) || answer.said === VIEW_ENDED) return true;
	return view.access?.machine !== undefined && !last;
}

/** A code host's view (F3 5a, 5c): marked served by this service, as a coding session's is. */
function codeHost(view: View): boolean {
	return view.identity?.kind === "code_host" && view.access !== undefined;
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

/** A git lock a view holds (git.ts, §6): the core's lease on the shared file it guards, the versions the lease found,
 * the guarded files git removed under it (`git branch -D`), and those it replaced by a rename (`git reflog expire`
 * renames the log's own lock onto the log), which go when the lock does. `ended`: a publish ended the lease while the
 * lock file stays (`git pack-refs` renames `packed-refs.new` onto `packed-refs`, then removes `packed-refs.lock`). */
interface GitLock {
	readonly leaseId: string;
	readonly versions: GitVersions;
	readonly deleted: Set<string>;
	readonly replaced: Set<string>;
	ended: boolean;
}

/** Rounds of the feed a view reads for a git lease's versions before the machine hears EEXIST (git tries again). */
const GIT_CATCH_UP_ROUNDS = 3;
/** Tries of a git publish with no answer, under one operation key. */
const GIT_PUBLISH_TRIES = 3;
/** The core's word (42501) for a lease that is not this view's any more: it ended, so its units cannot land. */
const GIT_LEASE_GONE = "Folder git lease is unavailable";

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

/** A unit's reason as the report says it: the core's, and for a rule's refusal the code and message of the first
 * problem it names, so a machine's report and an agent's command show why ("structured_rule: layout_authoring (page
 * and table layout authoring is not available)", C6). */
function reasonOf(reason: string, problem: CommitOutcome["problem"]): string {
	return problem ? `${reason}: ${problem.code} (${problem.message})` : reason;
}

/** One read log of a view (F3 4c): its entries up to `taken` are held here, up to `released` the core has them. Those
 * between wait in `unreleased`, oldest first, but for one the log already holds unreleased (`keys`), which is released
 * with it. */
interface ReadLog {
	taken: number;
	released: number;
	readonly unreleased: LoggedRead[];
	readonly keys: Set<string>;
	/** The served log's reads released already (F3 5c): served again, they are not recorded again. */
	readonly done?: Set<string>;
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

/** What releasing a view's reads came to: every read released, none yet, or the core's refusal. */
export type Released = "released" | "unanswered" | CoreRefusal["reason"];

function readKey(read: ReleasedRead): string {
	return JSON.stringify([read.path, read.version, read.authority]);
}

/** The links a unit makes, by path: a `symlink` unit's, or each of a new folder's. */
function linksOf(unit: CommitUnit): Map<string, string> {
	const links = new Map<string, string>();
	if (unit.op === "symlink") links.set(unit.path, unit.target);
	if (unit.op === "new_folder")
		for (const c of unit.contents) if (c.target !== undefined) links.set(`${unit.path}/${c.path}`, c.target);
	return links;
}

/** The paths a boundary leaves waiting (an open file among them), kept pending. */
function waitingOf(plan: BoundaryPlan): ReportEntry[] {
	return plan.waiting.map((w): ReportEntry => ({ path: w.path, outcome: "waiting", reason: w.reason, kept: true }));
}

/** The paths a coding view's boundary refused for its machine's secret values (5j-5), kept pending but at the view's
 * last boundary. */
function refusedOf(plan: BoundaryPlan, last: boolean): ReportEntry[] {
	return plan.refused.map(
		(r): ReportEntry =>
			last
				? { path: r.path, outcome: "refused", reason: r.reason }
				: { path: r.path, outcome: "refused", reason: r.reason, kept: true },
	);
}

/** Why a coding view's changes wait while its machine's secret values have not come (5j-5). */
const SECRETS_WAIT = "waiting for the machine's secret check";

/** The report of a boundary of a coding view whose machine's secret values have not come: every change waits, its
 * names not checked yet, so nothing but the machine's own report names them (#publishLogged). */
function uncheckedOf(plan: BoundaryPlan): ReportEntry[] {
	return [
		...plan.waiting.map(
			(w): ReportEntry => ({ path: w.path, outcome: "not_applied", reason: SECRETS_WAIT, kept: true }),
		),
		...held(plan, () => ({ outcome: "not_applied", reason: SECRETS_WAIT })),
	];
}

/** Whether the git directory `target` is in, or a folder above it, is new in the view (`git init` made it): not in the
 * folder yet. */
function gitDirNew(pending: PendingView, target: string): boolean {
	for (let path = gitDir(target); path.includes("/"); path = path.slice(0, path.lastIndexOf("/"))) {
		const node = pending.nodes().get(path);
		if (node?.kind === "folder" && !node.origin) return true;
	}
	return false;
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
	closedAt: number | undefined;
	/** Transfers fence new requests before waiting for the accepted operations to finish. */
	moving = false;
	movedTo: View | undefined;
	readonly active = new Set<Promise<unknown>>();
	intentWork: Promise<void> = Promise.resolve();
	/** Protocol-3 mounts distinguish disconnected streams from a dead program with an authenticated hello. */
	persistentHandles = false;
	/** Versions replaced on the feed, still readable by files opened before; newest last. */
	readonly superseded = new Map<string, TreeEntry[]>();
	/** The view may write (step 3: an operator mount configured so; step 4: a computer desktop). A core view's is set at
	 * its first renewal, from what the core says it is (`access`). */
	write: boolean;
	quietMs: number | undefined;
	/** What a core view is, as its first renewal said it, and which machines it is served to. */
	identity: ViewIdentity | undefined;
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
	/** A test machine's view (F3 6b): the command windows each pending path was changed in, for its units' credits. */
	readonly credit = new CreditTags();
	quiet: ReturnType<typeof setTimeout> | undefined;
	/** One boundary at a time. */
	publishing: Promise<Report> = Promise.resolve({ commitId: null, seq: null, paths: [] });
	/** Steps on that chain not ended yet (#inTurn): an idle view is not forgotten while it has any; the last decides. */
	steps = 0;
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
	/** The time each file this view saved or moved showed while pending, with the version the change set gave it
	 * (RUNTIME-COMPANY-FOLDER.md §6 "File times"): the view shows that time until another version arrives, so a
	 * publish does not make git's index see the file changed. */
	readonly times = new Map<string, { readonly version: string; readonly mtimeMs: number }>();
	readonly uploads = new Map<string, ChunkUpload>();
	/** The intents that root the bytes of its pending files, by id. */
	readonly intents = new Map<string, HeldIntent>();
	/** The write handles open on the view. The machine's program pools its connections, so any of them may use a
	 * handle. Protocol 3 preserves them across disconnects until authenticated abandonment or view expiry;
	 * legacy connections abandon them when the view's last connection ends. */
	readonly handles = new Set<number>();
	/** The git locks it holds (git.ts), by the shared file each guards. */
	readonly gitLeases = new Map<string, GitLock>();
	/** The shared files whose lock a create is taking now: one at a time, so a second create can never hand back the
	 * lease the first took. */
	readonly gitTaking = new Set<string>();
	/** The core may hold a git lease of this view's that `gitLeases` does not list (a take or a release whose answer
	 * never came): the next final boundary drops the view's leases all the same. */
	gitUnsure = false;
	/** What git publishes made that the feed had not brought back when they were answered: settled at `seq`. */
	readonly gitUnsettled: { readonly seq: number; readonly made: ReadonlyMap<string, string> }[] = [];
	/** The reads its machine logged (protocol 3, F3 4c), by log. They are kept with the view only: after it connects
	 * again a machine sends every read it has not heard released, so a view dropped, or a service restarted, may have
	 * some released twice, which files nothing new. */
	readonly logs = new Map<string, ReadLog>();
	/** A release with no answer (or refused): asked again first, the same. */
	releasing: Release | undefined;
	/** One release at a time: a coding machine's boundary releases every view of the machine, beside their own. */
	releaseTurn: Promise<unknown> = Promise.resolve();
	/** Its machine cannot show its read log complete (the log's rule 4): every later boundary is refused. */
	unproven = false;
	/** What its last boundary heard, until a change or a read since. A desktop no machine holds is kept while it is
	 * `open`, and a command's unless it is `refused` (F3 4c). */
	heard: Heard | undefined;
	/** What came of its boundaries no machine asked for, oldest first (at most NOTICES_KEPT), for the office's folder
	 * helper to ask after (F3 4f-2b-2). `noticed` numbers them from 1, in the series `noticeNonce` names: a view opened
	 * again under the same key is another series. */
	readonly notices: Notice[] = [];
	noticed = 0;
	readonly noticeNonce = randomUUID();

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
	/** Only a core desktop can retain and transfer its overlay to a successor. */
	readonly switchable?: boolean;
	/** A company's code host: it publishes git's session-local files (git.ts `gitRefused`), so its program keeps
	 * none on the machine. */
	readonly codeHost?: boolean;
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
	/** Gives a handle up, as its connection's end does: what it wrote is dropped (a draft leaves nothing). */
	discard(handle: number): Promise<void>;
	mkdir(path: string): Promise<void>;
	unlink(path: string, base: string | undefined): Promise<void>;
	rmdir(path: string, base: string | undefined): Promise<void>;
	rename(request: RenameRequest): Promise<void>;
	/** The version the path shows after: the bit makes a new one, which the machine's version map takes. */
	setExecutable(path: string, executable: boolean, base: string | undefined): Promise<{ version: string }>;
	/** A new link (protocol 4), and its version. */
	symlink(path: string, target: string): Promise<{ version: string }>;
	/** A hard link's new name (protocol 4), and its version. */
	link(request: LinkRequest): Promise<{ version: string }>;
	/** `final`: a command view's last boundary, whose change set closes the view (F3 4b). */
	publish(final?: boolean): Promise<Report>;
	/** Entries of the machine's read log, released before the view's next boundary (protocol 3, F3 4c). */
	reads(request: ReadsRequest): Promise<ReadsAnswer>;
}

/** A `notices` connection (F3 4f-2b-2): the notices of the view its hello names, asked page by page. */
export interface NoticesHandle {
	page(request: NoticesRequest): NoticesAnswer;
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
	/** This run of the service, sent with every renewal (F3 5a): the core marks a coding view served by it, and refuses
	 * it to a later run unless this one stopped cleanly (`stopCleanly`, the plan's rule 4). */
	readonly #serviceId = randomUUID();
	/** A clean stop has begun (`stopCleanly`): nothing more is served, so no read is recorded after the last release. */
	#stopping = false;
	/** Coding machines served a read that went unreleased (#forgetReads), until the executor says the machine restarted
	 * (`restarted`): kept apart from their views, as the machine keeps the read once the view that served it has gone. */
	readonly #lostMachines = new Set<string>();
	/** Whether a machine not vouched for is lost (the `vouched` option given): it may hold a read a run before this one
	 * served and never released. */
	readonly #vouching: boolean;
	/** The machines that hold no read unreleased by a run before this one: those the last clean stop vouched for, and
	 * those the executor said restarted since, until one of them loses a read (#forgetReads). The next run's note. */
	readonly #vouched: Set<string>;
	/** How many times the executor said each coding machine restarted (`restarted`), for every machine said so since the
	 * start (never dropped, so a count is never seen again): a machine boundary a restart crossed may have missed a read
	 * lost before it, which the restart cleared. */
	readonly #restarts = new Map<string, number>();
	/** The command windows open on the test machines (F3 6b), which the executor opens and closes. */
	readonly #windows = new CommandWindows();
	/** Each coding machine's secret values, as its executor last sent them (`secrets`, 5j-5), for this run only. */
	readonly #secrets = new Map<string, SecretSet>();
	/** The values each staged file's bytes were checked against, and as which stored form (git-objects.ts): checked
	 * again as a form that one covers, they are checked for the other values alone. */
	readonly #checked = new WeakMap<FileRef, { readonly secrets: SecretSet; readonly form: StoredForm }>();
	/** Each file the check refused: at which version, under which values, and why; `again` if for the node's load, not
	 * the file's bytes (`SecretRefusal.again`), so the next staging checks it again. */
	readonly #refusals = new WeakMap<
		PendingFile,
		{ readonly version: string; readonly secrets: SecretSet; readonly reason: string; readonly again: boolean }
	>();

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
		this.#vouching = options.vouched !== undefined;
		this.#vouched = new Set(options.vouched);
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

	/** A boundary of a coding machine, which the executor asks over the control socket (F3 5c, the plan's "Boundaries"):
	 * every open view of the machine publishes what it has pending, each after every read the machine was served is
	 * released (#boundaryOf), and the answer comes only after the reads served until then are released too (rule 3).
	 * `final`: the views whose last boundary this is, before the executor closes them; a refusal that may not lift is
	 * final there (rule 4). A view of the machine this service does not hold open has no report, but an error. A test
	 * machine's the same (F3 6b), by its placement's id, but its view's last boundary is a final: the core closes the
	 * view with it. One the core closed otherwise is listed closed while it stays (#close). */
	async boundary(machine: string, final: readonly string[] = []): Promise<MachineBoundary> {
		if (this.#stopping) throw new ProtocolError(ErrorCode.unavailable, STOPPING);
		return this.#machineBoundary(machine, final);
	}

	/** The executor stopped the coding machine and starts it again (F3 5c, the plan's rule 4), which it says over the
	 * control socket before the machine runs again: no program holds what it was served before. A read it lost no longer
	 * makes a view opened from now on unproven, and it is vouched for (#vouched). A view of the machine still open is of
	 * the machine before: if any of them holds a read unreleased, that read is forgotten, as when its view goes
	 * (#forgetReads), and every one of them is unproven. A boundary of the machine still out answers `unproven`
	 * (#machineBoundary). Whether a read the machine was served before may have gone unreleased (F3 5g-5): it was lost,
	 * or not vouched for, or a view of it held one. What the machine kept from before on its disk (a command's output)
	 * then cannot be kept. */
	restarted(machine: string): boolean {
		const views = this.#machineViews(machine);
		const lost = this.#machineLost(machine);
		const unreleased = views.some((view) => view.unreleased);
		this.#restarts.set(machine, (this.#restarts.get(machine) ?? 0) + 1);
		// A test machine's commands ended with it (F3 6b).
		this.#windows.clear(machine);
		// A view of the boot before that the core closed is listed closed no more (#close): an executor that restarted
		// itself meanwhile would take it for the next boot's own (company-machine-host.ts #settle), and restart again.
		for (const view of this.#views.values())
			if (
				view.closed &&
				view.closedAt !== undefined &&
				!view.movedTo &&
				view.access?.testMachine &&
				view.access.machine === machine
			) {
				view.closedAt = undefined;
				this.#forgetClosed(view);
			}
		if (unreleased) {
			this.#log(`folder-service: machine ${machine} restarted with reads unreleased; its views are unproven`);
			for (const view of views) {
				view.unproven = true;
				view.logs.clear();
				view.releasing = undefined;
			}
		}
		this.#lostMachines.delete(machine);
		this.#vouched.add(machine);
		if (lost)
			this.#log(`folder-service: machine ${machine} restarted; its views opened from now on are proven again`);
		return lost || unreleased;
	}

	/** A coding machine's secret values (5j-5; RUNTIME-FOLDER-CODING-MACHINES.md, "Masking"), as keyed hashes
	 * (secret-scan.ts), which its executor sends over the control socket before the machine's sessions run and as
	 * their values change: they replace those it sent before. Each boundary of the machine's views checks what it
	 * publishes against the values held when it began (#planned), and until the first come none of them publishes. The
	 * service never holds a value. How many it holds for the machine. */
	secrets(machine: string, set: SecretSet): number {
		const before = this.#secrets.get(machine);
		// The same values keep the set checked against: what was checked against it needs no check again.
		if (before?.equals(set)) return before.size;
		this.#secrets.set(machine, set);
		// What waited for the first values goes at the next quiet period.
		if (!before) for (const view of this.#machineViews(machine)) this.#resumeQuiet(view);
		return set.size;
	}

	/** The machines this run vouches for (#vouched), for the note its clean stop leaves the next run (`clean-stop.ts`).
	 * A clean stop leaves none lost. */
	vouched(): string[] {
		return [...this.#vouched];
	}

	/** A command started on a test machine (F3 6b, the plan's "Command windows"), which the executor says over the
	 * control socket: what the machine changes from now until the window closes is credited to the command. Said again,
	 * it changes nothing. */
	openWindow(machine: string, window: CommandWindow): void {
		if (this.#stopping) throw new ProtocolError(ErrorCode.unavailable, STOPPING);
		this.#windows.open(machine, window);
	}

	/** The command ended (F3 6b): its window closes, and the machine has a boundary, answered once what it changed until
	 * then was published or refused. A unit the core refuses because the command ended is refused as any other, and
	 * never credited to the starter instead. Said again, it is one more boundary. */
	async closeWindow(machine: string, commandId: string): Promise<MachineBoundary> {
		this.#windows.close(machine, commandId);
		if (this.#stopping) throw new ProtocolError(ErrorCode.unavailable, STOPPING);
		return this.#machineBoundary(machine, []);
	}

	async #machineBoundary(machine: string, final: readonly string[]): Promise<MachineBoundary> {
		const restarts = this.#restarts.get(machine);
		const views = this.#machineViews(machine).flatMap((view) =>
			view.lease ? [{ viewId: view.lease.viewId, view }] : [],
		);
		// A test machine's view whose final may have closed it, with no answer (F3 6b), is closed but kept for that
		// final: named final again, it asks it again.
		for (const viewId of final) {
			const view = this.#views.get(`view:${viewId}`);
			if (view?.closed && view.finalOut && view.access?.testMachine && view.access.machine === machine)
				views.push({ viewId, view });
		}
		const reports = await Promise.all(
			views.map(async ({ viewId, view }): Promise<MachineViewReport> => {
				const last = final.includes(viewId);
				try {
					const report = await this.#inTurn(view, () => {
						if (!last || !view.access?.testMachine) return this.#boundary(view, false, last);
						// A test machine's last boundary is final: the core closes its view with it. What the quiet period
						// would have published goes with it.
						if (view.quiet) clearTimeout(view.quiet);
						view.quiet = undefined;
						this.#windows.clear(machine);
						return this.#boundary(view, true);
					});
					return { viewId, report };
				} catch (error) {
					if (!(error instanceof ProtocolError))
						this.#log(`folder-service: ${view.key}: boundary failed: ${(error as Error).message}`);
					return {
						viewId,
						error:
							error instanceof ProtocolError
								? { code: error.code, message: error.message }
								: { code: ErrorCode.unavailable, message: "The boundary could not be made now" },
					};
				}
			}),
		);
		// A test machine's view the core closed otherwise than by its final is listed closed while it stays (#close), once:
		// one this boundary closed has its report in it already, and is listed closed from the next.
		for (const view of this.#views.values()) {
			const viewId = view.key.slice("view:".length);
			if (
				view.closed &&
				this.#retained(view) &&
				!view.movedTo &&
				view.access?.testMachine &&
				view.access.machine === machine &&
				!reports.some((report) => report.viewId === viewId)
			)
				reports.push({ viewId, error: { code: ErrorCode.viewClosed, message: view.closed } });
		}
		for (const viewId of final)
			if (!reports.some((report) => report.viewId === viewId))
				reports.push({
					viewId,
					error: {
						code: ErrorCode.viewClosed,
						message: "This service holds no open view of the machine by that id",
					},
				});
		// Reads served while the views published: released before the answer, as every one before. A view may be served
		// another once its own release is done while another view's is out, so the machine is released again until, in
		// the same step as the answer, no open view of it (one opened meanwhile included) holds a read unreleased.
		let reads = await this.#releaseMachine(machine);
		for (let round = 1; reads === "released" && this.#machineViews(machine).some((view) => view.unreleased); round++)
			reads = round < MACHINE_RELEASE_ROUNDS ? await this.#releaseMachine(machine) : "unanswered";
		// A machine that lost a read, or that restarted since the boundary began: a view of it may have gone meanwhile with
		// a read unreleased, which the restart cleared, and what the boundary answers for was made before the restart. One
		// not vouched for is lost whether this run holds a view of it or not: a run before may have served it a read.
		const unproven = this.#machineLost(machine) || this.#restarts.get(machine) !== restarts;
		return { machine, reads: unproven ? "unproven" : reads, views: reports };
	}

	/** Stops for good, cleanly (F3 5c, the plan's "The service stops cleanly"): nothing more is served, every coding
	 * machine has a boundary and every code host view publishes, and once each of those views has every read it served
	 * released and nothing left to publish, the core hears this run stopped cleanly and clears `served_by` (5a), so the
	 * next run may serve those views. Otherwise `served_by` stays: the core refuses them to the next run, and the
	 * executor restarts their machines (rule 4). Other views are dropped with what they hold, as before. Whether the core
	 * cleared it: only then may the next run start from the machines this one vouches for (`vouched`). */
	async stopCleanly(): Promise<boolean> {
		this.stop();
		this.#stopping = true;
		const views = [...this.#views.values()];
		for (const view of views) {
			if (view.quiet) clearTimeout(view.quiet);
			view.quiet = undefined;
		}
		await Promise.allSettled(views.flatMap((view) => [...view.active]));
		const machines = new Set<string>();
		for (const view of views) {
			const machine = view.access?.machine;
			if (machine !== undefined && !view.closed) machines.add(machine);
		}
		for (const machine of machines) await this.#machineBoundary(machine, []);
		// A code host's views are marked served too: they publish what they hold (their reads reach no model, 5a).
		await Promise.allSettled(
			views.filter((view) => codeHost(view) && !view.closed).map((view) => this.#publish(view)),
		);
		await Promise.allSettled(views.map((view) => view.renewing));
		// A machine not vouched for stays out of the note, so the next run counts it lost too: its views, unproven for that
		// alone, hold what they could never save, and hold up no clean stop for it once their reads are released.
		const left = [...this.#views.values()].filter((view) => {
			const unvouched = this.#unvouched(view.access?.machine);
			return (
				(view.access?.machine !== undefined || codeHost(view)) &&
				!view.closed &&
				((view.unproven && !unvouched) ||
					view.unreleased ||
					view.unanswered !== undefined ||
					view.unsettled !== undefined ||
					(view.pending?.unsaved === true && !unvouched))
			);
		});
		// A machine that lost a read and has not restarted since: a view of it this run let go may still be open in the
		// core, marked served by this run, and it stays marked, so the next run (which knows nothing of the loss) refuses
		// it too.
		if (left.length > 0 || this.#lostMachines.size > 0) {
			for (const view of left)
				this.#log(`folder-service: ${view.key}: not stopped cleanly: reads unreleased or changes unpublished`);
			for (const machine of this.#lostMachines)
				this.#log(`folder-service: machine ${machine}: not stopped cleanly: a read it was served went unreleased`);
			return false;
		}
		try {
			const cleared = await this.#core.serviceStopped(this.#serviceId);
			this.#log(`folder-service: stopped cleanly; ${cleared} coding views no longer marked served`);
			return true;
		} catch (error) {
			this.#log(`folder-service: the clean stop was not recorded: ${(error as Error).message}`);
			return false;
		}
	}

	/** Renews the lease of every core view a machine is connected to, and of every command's view kept for its final
	 * boundary; a view the core closed is closed on every connection. Another view no machine holds is not renewed: its
	 * lease runs out, unless the core closed it first (a run's end closes its run box). A renewal that cannot reach the
	 * core leaves the confirmed lease to run out: past it the view is not served (UNAVAILABLE) until a renewal succeeds.
	 * Exposed for tests. */
	async renewLeases(): Promise<void> {
		await Promise.all(
			[...this.#views.values()]
				.filter(
					(view) =>
						view.lease && view.tree && (view.connections > 0 || this.#kept(view)) && !view.closed && !view.moving,
				)
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
		// A renewal marks a coding view served by this run: none after a clean stop has begun, so none lands after it.
		if (this.#stopping) throw new ProtocolError(ErrorCode.unavailable, STOPPING);
		// No seat waits on a command: its view never says it has changes unsaved.
		if (lettingGo || !view.pending?.unsaved || view.access?.command) view.unsavedSince = undefined;
		else view.unsavedSince ??= this.#now();
		const unsaved = view.unsavedSince === undefined ? null : new Date(view.unsavedSince).toISOString();
		if (unsaved !== null) view.unsavedSent = true;
		let renewal: Awaited<ReturnType<FolderCore["renewView"]>>;
		const asked = this.#now();
		try {
			renewal = await this.#core.renewView(lease.viewId, lease.pass, unsaved, this.#serviceId);
		} catch (error) {
			if (error instanceof CoreRefusal && error.forbidden) return this.#close(view, "The view was refused");
			throw error;
		}
		if (unsaved === null) view.unsavedSent = false;
		// A view closed while the renewal ran (another answer, or no machine holds it) stays closed.
		if (view.closed) return;
		if (renewal.state === "closed")
			return this.#close(
				view,
				renewal.reason === "service_crashed"
					? "The view was served by a folder service that did not stop cleanly"
					: `The view was ${renewal.reason}`,
			);
		// The first answer says what the view is, and so how it is served and to which machines; a view never changes
		// kind, machine or company.
		const identity: ViewIdentity = {
			kind: renewal.kind,
			machineId: renewal.machineId,
			companyId: renewal.companyId,
			codingMachineId: renewal.codingMachineId,
		};
		if (!view.identity) {
			view.identity = identity;
			view.access = this.#grants.coreAccess(identity);
			view.write = view.access?.write ?? false;
			view.quietMs = view.access?.quietMs;
			// A coding machine served a read this service lost (#forgetReads), or one a run before may have (not vouched
			// for), holds it, its views open or not: a view opened on it cannot show its reads released either, until the
			// executor has restarted it (`restarted`).
			const machine = view.access?.machine;
			if (machine !== undefined && this.#machineLost(machine)) view.unproven = true;
		} else if (
			view.identity.kind !== identity.kind ||
			view.identity.machineId !== identity.machineId ||
			view.identity.companyId !== identity.companyId ||
			view.identity.codingMachineId !== identity.codingMachineId
		)
			return this.#close(view, "The view's kind or machine changed");
		// The core's clock says until when; never trust it for longer than one lease from now.
		view.leaseUntil = Math.min(Date.parse(renewal.leaseUntil), asked + LEASE_MS);
		view.confirmed = true;
	}

	/** Checks a `notices` hello (F3 4f-2b-2): the office's folder helper asks, through the folder program's relay, what
	 * came of the boundaries no machine asked for of a view the service holds. It never opens, holds or keeps a view:
	 * one not held, or whose pass the core has not checked yet, has none to give, and a closed or moved one still has
	 * its own. At each ask the view is checked as a machine joining it is: its pass, its company folder and, for a core
	 * view, this machine. */
	notices(hello: Hello, bridge: BridgeInfo): NoticesHandle {
		if (this.#stopping) throw new ProtocolError(ErrorCode.unavailable, STOPPING);
		const grant = this.#grants.admit(hello, bridge);
		return {
			page: (request) => {
				const view = this.#views.get(grant.key);
				if (!view?.confirmed) return { nonce: null, notices: [], last: 0, more: false };
				if (
					view.environmentId !== grant.environmentId ||
					!timingSafeEqual(view.passSha256, grant.passSha256) ||
					(view.core && !view.access?.admits(bridge))
				)
					throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
				const from = request.nonce === view.noticeNonce ? request.after : 0;
				return pageOfNotices(view.notices, from, view.noticeNonce);
			},
		};
	}

	/** Checks a machine's hello and opens (or joins) its view. The first connection of a view lists its tree. */
	async open(hello: Hello, bridge: BridgeInfo): Promise<ViewHandle> {
		if (this.#stopping) throw new ProtocolError(ErrorCode.unavailable, STOPPING);
		const grant = this.#grants.admit(hello, bridge);
		let view = this.#views.get(grant.key);
		// A view that closed while a final of its was out stays, joined only to ask that final again.
		const asksFinal = view?.closed !== undefined && view.finalOut;
		if (view?.moving) throw new ProtocolError(ErrorCode.busy, "The view is changing; try again");
		if (view?.movedTo || (view?.closed && this.#retained(view)))
			throw new ProtocolError(ErrorCode.viewClosed, "The view was replaced or closed");
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
			// A protocol-3 core mount keeps handles across link loss. Only a program holding the daemon lock may
			// declare them orphaned; a transfer keeps the same handles usable by the mounted program.
			if (view.moving || view.movedTo || this.#retained(view)) return;
			if (!view.persistentHandles) {
				for (const handle of view.handles) this.#abandon(view, handle);
				view.handles.clear();
			}
			// A command's view stays, with what it has pending and its lease: the command's last call publishes it, final.
			// So does a desktop's whose last boundary had no answer, or a refusal that may lift: a later publish from its
			// machine publishes it, and nothing else does (F3 4c). A boundary still running decides again as it ends.
			if (this.#waitsForAnswer(view)) {
				if (view.quiet) clearTimeout(view.quiet);
				view.quiet = undefined;
				return;
			}
			// A view kept only for files its program may still hold open publishes as below: what was closed is saved,
			// the open files wait, and the boundary's end keeps the view for them (#unheld).
			view.idleSince = this.#now();
			// A core view no machine holds is dropped (with its pass): its lease is not renewed while idle, so a machine
			// that comes back lists it again and renews at once. What it has pending, and the reads its machine logged, are
			// published first, under the lease it still has (a desktop that ended inside its quiet period); a machine that
			// comes back meanwhile joins it. A command's publishes only on its quiet period while held, or when asked.
			// Either way the view is kept or let go once its last boundary has ended (#inTurn).
			if (!view.lease || this.#views.get(view.key) !== view) return;
			if (view.quiet) clearTimeout(view.quiet);
			view.quiet = undefined;
			if (view.access?.command || ((!view.pending || view.pending.empty) && !view.unreleased)) {
				void this.#inTurn(view, async () => ({ commitId: null, seq: null, paths: [] }));
				return;
			}
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
			if (view.core && hello.protocol >= 3) view.persistentHandles = true;
			if (hello.previous) await this.#transfer(view, hello, bridge);
			if (hello.abandon) await this.#abandonProgram(view, hello);
		} catch (error) {
			release();
			throw error;
		}
		// A machine below protocol 4 never sees a link: none is listed, read or found, and a name one holds is taken.
		const links = hello.protocol >= 4;
		const hidden = (path: string): void => {
			if (!links && view.pending?.get(path)?.kind === "symlink")
				throw new ProtocolError(ErrorCode.notFound, "No such path");
		};
		const handle: ViewHandle = {
			asOfSeq: view.seq,
			writable: view.pending !== undefined,
			core: view.core,
			switchable: view.identity?.kind === "computer_desktop",
			codeHost: view.identity?.kind === "code_host",
			list: async (path, after) => this.#list(view, path, after, links),
			read: async (request) => this.#read(view, request, links),
			search: async (request) => this.#search(view, request, links),
			subscribe: (sink) => {
				if (released || view.closed || view.moving)
					return sink.closed(ErrorCode.viewClosed, view.closed ?? "Released");
				mine = sink;
				view.sinks.add(sink);
			},
			release,
			// Bases are read when the change is made (after any boundary it waited for, which may have published the save
			// a base names).
			open: async (request) => {
				// What the path showed before the open: an open of a file is a read of it, as a machine's program logs one.
				let shown: TreeEntry | undefined;
				// An open changes the file only when it may make it, or cuts it to nothing; a draft, nothing until its close
				// lands it. Its credits' windows are taken on entry: taking a git lock waits for its lease first.
				const changes = !request.draft && (request.create || request.truncate) ? [request.path] : [];
				const tags = this.#windowsOf(view);
				const open = () =>
					this.#change(
						view,
						changes,
						(pending) => {
							const base = this.#base(view, request.path, request.base);
							shown = pending.get(request.path);
							return pending.openWrite(request.path, {
								create: request.create,
								exclusive: request.exclusive,
								truncate: request.truncate,
								...(base ? { base } : {}),
								...(request.draft ? { draft: true } : {}),
							});
						},
						tags,
					);
				// Creating a git lock file takes the lock (git.ts); a shared git file changes only under its lock.
				const target = gitLockTarget(request.path);
				if (target !== null && request.draft)
					throw new ProtocolError(ErrorCode.badRequest, "A git lock file is taken by creating it, not by a draft");
				// Another create of the lock while one takes it fails as on a disk, and git tries again.
				if (target !== null && request.create && view.gitTaking.has(target))
					throw new ProtocolError(ErrorCode.exists, "Another git command is taking this lock");
				const take = target !== null && request.create && !view.gitLeases.has(target);
				// A lock whose publish ended its lease (`packed-refs.new`'s rename) is git's until git removes it: another
				// create of it fails as on a disk, and git tries again.
				if (target !== null && request.create && view.gitLeases.get(target)?.ended)
					throw new ProtocolError(ErrorCode.exists, "This git lock is held until git removes it");
				if (!take) this.#gitGuard(view, request.path);
				const opened = take ? await this.#gitLock(view, target, open) : await open();
				view.handles.add(opened.handle);
				if (shown?.kind === "file")
					this.#served(view, { path: request.path, version: shown.version, authority: shown.authority });
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
				// A cut is credited to the windows open as the machine closed the file, not as its origin's bytes came.
				const tags = this.#windowsOf(view);
				// A file whose bytes are still its origin's, closed at another size: cut (on the 4 MiB grid, or to nothing)
				// with no chunk sent. Its bytes become its own from the origin's chunks first, and the close cuts them.
				const origin = view.pending?.originToCopy(handle);
				if (origin && size !== origin.bytes) await this.#beginFromOrigin(view, handle, origin);
				const node = await this.#change(
					view,
					// Its writes were credited as their chunks came: the close changes the file itself only when it cuts it, or
					// lands a draft.
					(pending) => {
						const draft = pending.draftPath(handle);
						if (draft !== undefined) return [draft];
						const file = pending.file(handle);
						const cuts = Math.ceil(size / CHUNK_BYTES) < (file.content?.chunks.length ?? 0);
						const cut = cuts ? this.#pathOfNode(view, file) : undefined;
						return cut === undefined ? [] : [cut];
					},
					(pending) => {
						const written = pending.file(handle);
						const held = pending.draftHeld(handle);
						let closed: PendingFile | undefined;
						try {
							closed = pending.close(handle, size);
							// The chunks the close fixed are the file's now, and so are the tags they came under: in the same
							// step, so no change made after it sees the file without them.
							if (tags !== undefined) view.credit.fixed(closed, written);
							return closed;
						} finally {
							// A draft that landed elsewhere, or that its close gave up, let go of the view's own file it held.
							if (tags !== undefined && held !== closed) this.#lost(view, held);
						}
					},
					tags,
				).catch((error: unknown) => {
					// A draft its close could not land was given up: it leaves nothing, as a discard.
					if (view.pending && !view.pending.isOpen(handle)) this.#giveUp(view, handle);
					throw error;
				});
				view.handles.delete(handle);
				for (const key of [...view.uploads.keys()]) if (key.startsWith(`${handle}:`)) view.uploads.delete(key);
				const path = node.open === 0 ? this.#pathOfNode(view, node) : undefined;
				if (path !== undefined) await this.#stage(view, node, path).catch(() => undefined);
				return { version: node.version };
			},
			discard: async (handle) => {
				if (!view.handles.has(handle)) throw new ProtocolError(ErrorCode.badRequest, "No such handle");
				this.#giveUp(view, handle);
			},
			mkdir: async (path) => this.#change(view, [path], (pending) => pending.mkdir(path)),
			unlink: async (path, base) => {
				const target = gitLockTarget(path);
				const lock = target === null ? undefined : view.gitLeases.get(target);
				if (target !== null && lock) return this.#gitUnlock(view, path, target, lock);
				const guard = this.#gitGuard(view, path);
				await this.#change(view, [path], (pending) => {
					hidden(path);
					pending.unlink(path, this.#base(view, path, base));
				});
				guard?.deleted.add(path);
			},
			rmdir: async (path, base) =>
				this.#change(view, [path], (pending) => {
					hidden(path);
					pending.rmdir(path, this.#base(view, path, base));
				}),
			rename: async (request) => {
				// A lock renamed onto its file, or the `packed-refs` `git pack-refs` writes under its lock.
				const target = gitLockTarget(request.from) ?? gitPackedRefsTarget(request.from);
				const lock = target === null ? undefined : view.gitLeases.get(target);
				if (lock && target === request.to) return this.#gitPublish(view, request.from, request.to, lock);
				this.#gitGuard(view, request.from);
				const guard = this.#gitGuard(view, request.to);
				await this.#change(view, { from: request.from, to: request.to }, (pending) => {
					hidden(request.from);
					if (!links && pending.get(request.to)?.kind === "symlink")
						throw new ProtocolError(ErrorCode.exists, "The path exists");
					const fromBase = this.#base(view, request.from, request.fromBase);
					const toBase = this.#base(view, request.to, request.toBase);
					pending.rename(request.from, request.to, {
						noReplace: request.noReplace,
						...(fromBase ? { fromBase } : {}),
						...(toBase ? { toBase } : {}),
					});
				});
				guard?.replaced.add(request.to);
			},
			setExecutable: async (path, executable, base) =>
				this.#change(view, [path], (pending) => {
					hidden(path);
					pending.setExecutable(path, executable, this.#base(view, path, base));
					// The version the path shows now: a save, so the machine's version map takes it.
					return { version: pending.get(path)?.version ?? "" };
				}),
			// The server takes these from a protocol 4 machine only.
			symlink: async (path, target) => {
				this.#gitNoLink(view, path);
				return this.#change(view, [path], (pending) => ({ version: pending.symlink(path, target) }));
			},
			link: async (request) => {
				this.#gitNoLink(view, request.to);
				return this.#change(view, [request.to], (pending) => ({
					version: pending.link(
						request.from,
						request.to,
						this.#base(view, request.from, request.fromBase),
						(path, version) => view.superseded.get(path)?.find((old) => old.version === version),
					),
				}));
			},
			publish: async (final = false) => {
				if (final && !view.access?.command)
					throw new ProtocolError(ErrorCode.badRequest, "Only a command view publishes a final change set");
				// A command that ended inside its quiet period publishes once, final (4b-2): the final takes what the quiet
				// period would have published.
				if (final && view.quiet) {
					clearTimeout(view.quiet);
					view.quiet = undefined;
				}
				return this.#publish(view, final);
			},
			reads: async (request) => this.#takeReads(view, request),
		};
		// Register synchronously, before yielding: a transfer waits for every operation admitted before its fence,
		// including chunk staging and the tail after a boundary. Old pooled connections cannot use moved handles.
		const serve = <T>(operation: () => Promise<T>): Promise<T> => {
			if (released || view.movedTo)
				return Promise.reject(new ProtocolError(ErrorCode.viewClosed, "The connection's view has ended"));
			if (this.#stopping) return Promise.reject(new ProtocolError(ErrorCode.unavailable, STOPPING));
			if (view.moving) return Promise.reject(new ProtocolError(ErrorCode.busy, "The view is changing; try again"));
			const task = Promise.resolve().then(operation);
			view.active.add(task);
			const done = (): void => {
				view.active.delete(task);
			};
			task.then(done, done);
			return task;
		};
		return {
			...handle,
			list: (...args) => serve(() => handle.list(...args)),
			read: (...args) => serve(() => handle.read(...args)),
			search: (...args) => serve(() => handle.search(...args)),
			open: (...args) => serve(() => handle.open(...args)),
			chunk: (...args) => serve(() => handle.chunk(...args)),
			getChunk: (...args) => serve(() => handle.getChunk(...args)),
			close: (...args) => serve(() => handle.close(...args)),
			discard: (...args) => serve(() => handle.discard(...args)),
			mkdir: (...args) => serve(() => handle.mkdir(...args)),
			unlink: (...args) => serve(() => handle.unlink(...args)),
			rmdir: (...args) => serve(() => handle.rmdir(...args)),
			rename: (...args) => serve(() => handle.rename(...args)),
			setExecutable: (...args) => serve(() => handle.setExecutable(...args)),
			symlink: (...args) => serve(() => handle.symlink(...args)),
			link: (...args) => serve(() => handle.link(...args)),
			publish: (...args) => serve(() => handle.publish(...args)),
			reads: (...args) => serve(() => handle.reads(...args)),
		};
	}

	/** Waits only for work admitted before the fence. Timers and new requests do not start work while moving. */
	async #quiesce(view: View): Promise<void> {
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = undefined;
		await Promise.allSettled([...view.active]);
		await Promise.allSettled([view.publishing, view.work, view.renewing, view.intentWork]);
	}

	/** Authenticated same-machine desktop transfer. Both overlays are fenced before the first await; after old IO
	 * finishes, all mutable pending state moves synchronously. The old identity remains a tombstone for lost hellos. */
	async #transfer(target: View, hello: Hello, bridge: BridgeInfo): Promise<void> {
		const previous = hello.previous!;
		const refuse = (): ProtocolError =>
			new ProtocolError(ErrorCode.viewRefused, "The previous view did not match this desktop");
		if (hello.protocol < 3 || target.identity?.kind !== "computer_desktop" || !target.access?.admits(bridge))
			throw refuse();
		let old = this.#views.get(`view:${previous.viewId}`);
		// A restarted service has no pending state to transfer. The target's own pass, company and machine were
		// checked above; the mount replays its durable read journal before any write on this fresh service.
		if (!old) return;
		if (
			!old.confirmed ||
			old.environmentId !== target.environmentId ||
			old.identity?.kind !== "computer_desktop" ||
			old.identity.machineId !== target.identity.machineId ||
			!old.access?.admits(bridge) ||
			!timingSafeEqual(old.passSha256, createHash("sha256").update(previous.pass).digest())
		)
			throw refuse();
		// A checkpoint may have failed after hello, followed by a second file replacement. Follow accepted moves,
		// never an unaccepted intermediate primary file. Each move was authenticated on this same machine.
		while (old.movedTo) old = old.movedTo;
		if (old === target) return;
		if (old.closed && !this.#retained(old))
			throw new ProtocolError(ErrorCode.viewClosed, "The previous view expired");
		if (old.moving || target.moving) throw new ProtocolError(ErrorCode.busy, "The view is changing; try again");
		old.moving = target.moving = true;
		try {
			await Promise.all([this.#quiesce(old), this.#quiesce(target)]);
			this.#tree(target);
			if (
				!target.pending ||
				(target.pending && !target.pending.empty) ||
				target.handles.size > 0 ||
				target.logs.size > 0 ||
				target.unanswered ||
				target.unsettled ||
				target.unproven
			)
				throw new ProtocolError(ErrorCode.busy, "The successor already has independent pending work");
			if (old.closed && !this.#retained(old))
				throw new ProtocolError(ErrorCode.viewClosed, "The previous view expired");
			const pending = old.pending;
			if (!pending) throw refuse();
			pending.rebind(
				() => target.tree ?? new ViewTree(),
				() => target.seq,
			);
			target.pending = pending;
			old.pending = undefined;
			for (const [key, value] of old.superseded) target.superseded.set(key, value);
			// Entries current in the old view may already be superseded in the successor's first listing. Keep their
			// versions too, both for retained read handles and for journal entries not handed over before the switch.
			for (const path of old.tree?.paths() ?? []) {
				const entry = old.tree?.get(path);
				if (entry && entry.kind !== "folder" && target.tree?.get(path)?.version !== entry.version)
					this.#keep(target, entry);
			}
			for (const [key, value] of old.published) target.published.set(key, value);
			for (const [key, value] of old.times) target.times.set(key, value);
			for (const [key, value] of old.uploads) target.uploads.set(key, value);
			for (const [key, value] of old.intents) target.intents.set(key, value);
			for (const [key, value] of old.logs) target.logs.set(key, value);
			for (const handle of old.handles) target.handles.add(handle);
			// Git locks are the old view's leases, which end with it: their lock files go too (git.ts).
			const guarded = [...old.gitLeases.keys()].flatMap((lock) => gitGuarded(lock));
			if (guarded.length > 0) pending.drop(guarded);
			old.gitLeases.clear();
			target.gitUnsettled.push(...old.gitUnsettled.splice(0));
			old.superseded.clear();
			old.published.clear();
			old.times.clear();
			old.uploads.clear();
			old.intents.clear();
			old.logs.clear();
			old.handles.clear();
			target.unanswered = old.unanswered;
			old.unanswered = undefined;
			target.unsettled = old.unsettled;
			old.unsettled = undefined;
			target.unproven = old.unproven;
			target.heard = old.heard;
			target.unsavedSince = old.unsavedSince;
			// A release id belongs to its old view. Entries with no durable acknowledgement stay unreleased and get
			// a new id under the successor; any old release already filed was carried by the core's view-open.
			old.releasing = undefined;
			old.movedTo = target;
			old.closed = "The view was replaced";
			old.closedAt ??= this.#now();
			old.lease = undefined;
			old.tree = undefined;
			for (const sink of old.sinks) sink.closed(ErrorCode.viewClosed, old.closed);
			old.sinks.clear();
			for (const sink of target.sinks) sink.change({ seq: target.seq, resync: true, paths: [] });
		} finally {
			old.moving = target.moving = false;
			this.#resumeQuiet(old);
			this.#resumeQuiet(target);
		}
	}

	/** This request comes only from a program holding the private process-lifetime daemon lock: a publisher, or a mount
	 * as it starts (one systemd restarted after a crash). Authentication above binds it to this exact view, company and
	 * calling machine. Never infer death from disconnected streams. What the dead program closed, and what its open
	 * files go back to, publishes after the quiet period as any change does. */
	async #abandonProgram(view: View, hello: Hello): Promise<void> {
		if (view.finalOut) return;
		if (hello.protocol < 3 || hello.role !== "io" || !view.pending)
			throw new ProtocolError(ErrorCode.badRequest, "This view cannot abandon a mounted program");
		if (view.moving) throw new ProtocolError(ErrorCode.busy, "The view is changing; try again");
		view.moving = true;
		try {
			await this.#quiesce(view);
			for (const handle of view.handles) this.#abandon(view, handle);
			view.handles.clear();
		} finally {
			view.moving = false;
			this.#resumeQuiet(view);
		}
	}

	/** A view a machine it admits has held, open, kept with no connection and renewed (F3 4b, 4c): while it waits for
	 * an answer (#waitsForAnswer), or while its mounted program may still hold files open: a protocol-3 core mount's
	 * handles outlive its streams, until a program holding the mount's daemon lock says that program is gone (a
	 * restarted mount, or the helper's publisher), or the view ends. */
	#kept(view: View): boolean {
		return this.#waitsForAnswer(view) || (this.#keepable(view) && view.persistentHandles && view.handles.size > 0);
	}

	/** Kept for an answer: a command's view for its final boundary, unless its last boundary was refused for good; a
	 * desktop's while its last boundary had no answer, or a refusal that may lift, until a later publish from its
	 * machine gets another answer; a coding session's until the executor closes it, after its final boundary (F3 5c):
	 * its machine's boundaries publish what it holds, and its reads are released with theirs. */
	#waitsForAnswer(view: View): boolean {
		if (!this.#keepable(view)) return false;
		if (view.access?.machine !== undefined) return true;
		return view.access?.command === true ? view.heard !== "refused" : view.heard === "open";
	}

	#keepable(view: View): boolean {
		return view.admitted && view.lease !== undefined && !view.closed && this.#views.get(view.key) === view;
	}

	/** One round: read the clocks of every company with a live view, move views whose company moved, list again those
	 * due, send heartbeats, and drop views idle for long enough. A view with a boundary still running stays: the last
	 * step on its chain keeps it or lets it go (#unheld), which needs it where its machine finds it. Exposed for tests. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const now = this.#now();
			for (const [key, view] of this.#views) {
				if (view.moving || view.steps > 0 || view.active.size > 0) continue;
				if (view.closedAt !== undefined) {
					if (now - view.closedAt >= CLOSED_GRACE_MS) {
						this.#discard(view);
						this.#views.delete(key);
					}
				} else if (view.idleSince !== undefined && now - view.idleSince >= this.#idleMs) {
					this.#views.delete(key);
					this.#forgetReads(view);
				}
			}
			const live = [...this.#views.values()].filter((v) => v.tree && !v.closed && !v.moving);
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
		if (view.queued || view.moving) return;
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

	/** `byFinal`: the view's own final closed it, and its machine heard so in that boundary's report. */
	#close(view: View, reason: string, byFinal = false): void {
		view.closed = reason;
		if (view.identity?.kind === "computer_desktop" && view.admitted) view.closedAt ??= this.#now();
		else {
			this.#discard(view);
			// A test machine's view the core closed otherwise (a narrowing, a refusal) stays a while, so its machine's next
			// boundary lists it closed (VIEW_CLOSED) and the executor restarts the machine then, not once it seems gone.
			if (view.access?.testMachine && view.admitted && !byFinal && !view.finalOut) view.closedAt ??= this.#now();
		}
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = undefined;
		// The pass goes with it: a closed view makes no more calls, but a final with no answer asked again as it was.
		view.lease = undefined;
		this.#forgetClosed(view);
		for (const sink of view.sinks) sink.closed(ErrorCode.viewClosed, reason);
		view.sinks.clear();
		this.#log(`folder-service: ${view.key} closed: ${reason}`);
	}

	/** Forgets a closed view, unless a final of its is out: that final may be what closed it, so the view stays where its
	 * machine finds it again, until it has been idle as long as any other. */
	#retained(view: View): boolean {
		return view.closedAt !== undefined && this.#now() - view.closedAt < CLOSED_GRACE_MS;
	}

	#discard(view: View): void {
		view.tree = undefined;
		view.pending?.clear();
		view.pending = undefined;
		view.credit.clear();
		for (const upload of view.uploads.values()) upload.upload?.abort();
		view.uploads.clear();
		view.handles.clear();
		view.intents.clear();
		view.unsettled = undefined;
		this.#forgetReads(view);
	}

	#forgetClosed(view: View): void {
		if (this.#retained(view)) return;
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
		if (view.connections > 0 || view.moving || this.#retained(view)) return;
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
		if (view.closed || view.moving) return;
		if (this.#views.get(view.key) === view) this.#views.delete(view.key);
		view.lease = undefined;
		view.closed = "No machine holds the view";
		view.tree = undefined;
		view.pending?.clear();
		view.credit.clear();
		view.intents.clear();
		this.#forgetReads(view);
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = undefined;
	}

	/** A view's reads not released go with it: they reached no save of it. A coding view's reached its machine, where
	 * any of its views may save what was made from them: the machine is lost until the executor says it restarted
	 * (`restarted`), even once none of its views is open, so every view of it open now cannot show its reads released,
	 * nor can one opened before the restart (#renewNow), and its boundaries answer `unproven` (F3 5c, the plan's rule
	 * 4). */
	#forgetReads(view: View): void {
		const machine = view.access?.machine;
		if (machine !== undefined && view.unreleased) {
			this.#log(`folder-service: ${view.key}: reads served to machine ${machine} went unreleased`);
			this.#lostMachines.add(machine);
			this.#vouched.delete(machine);
			for (const other of this.#machineViews(machine)) other.unproven = true;
		}
		view.logs.clear();
		view.releasing = undefined;
	}

	/** The machine lost a read (#forgetReads), or is not vouched for (#unvouched): it may hold a read served and never
	 * released, until the executor says it restarted (`restarted`). */
	#machineLost(machine: string): boolean {
		return this.#lostMachines.has(machine) || this.#unvouched(machine);
	}

	/** A run before this one may have served the machine a read it never released (the `vouched` option). */
	#unvouched(machine: string | undefined): boolean {
		return machine !== undefined && this.#vouching && !this.#vouched.has(machine);
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
					view.identity?.kind === "code_host",
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
			const own = this.#ownFolders(view, changed);
			view.pending?.liveChanged(changed);
			this.#gitSettle(view);
			if (!told) this.#push(view, this.#shown(view, changed, own));
		}
	}

	/** A base as the machine sent it, except that the version one of this view's saves made, published since, is read
	 * as the version its change set gave the path: the machine's version map holds the first (RUNTIME-FOLDER-WRITES.md,
	 * "After a save the map holds the version the save made"). Likewise the version a file this view moved showed at its
	 * new path before the move was published: the move gave it a new one; and the version one of the view's own folders
	 * showed while pending, live since (`#liveFolders`). */
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
		this.#gitSettle(view);
		this.#log(`folder-service: ${view.key} listed again (${why}): ${tree.size} paths, ${changed.length} changed`);
		this.#push(view, changed);
	}

	/** The view's own folders among `paths` (those it made or moved, still pending), each with the version it shows. */
	#ownFolders(view: View, paths: Iterable<string>): Map<string, string> {
		const own = new Map<string, string>();
		const nodes = view.pending?.nodes();
		if (nodes)
			for (const path of paths) {
				const node = nodes.get(path);
				if (node?.kind === "folder") own.set(path, node.version);
			}
		return own;
	}

	/** `changed`, with each of the view's own folders (`own`, taken before the change) that still shows as a folder told
	 * as `LISTING_ONLY` below it. Told its path, the kernel would drop the folder's entry, and a program working in it
	 * could not name it again until something looked the path up: `getcwd` fails (ENOENT), so does git in a new
	 * `repo.git` the boundary before its first ref's lease saved (git makes each lock's path absolute by it). What the
	 * folder holds may still change with it (a moved folder listed between the feed's round and the settle, or one
	 * another machine made too, with files in it): the machine lists it again. The folder above still lists the folder
	 * at the version it showed while pending, a base the view reads as the live one (`#liveFolders`). */
	#shown(view: View, changed: readonly string[], own: ReadonlyMap<string, string>): string[] {
		return changed.map((path) =>
			own.has(path) && view.pending?.get(path)?.kind === "folder" ? `${path}/${LISTING_ONLY}` : path,
		);
	}

	/** Notes, for each of the view's own folders (`own`, taken before a settle) that is live now, the version it showed
	 * while pending as the one it has live (#base): the machine's listing of the folder above holds the first (the
	 * machine is never told the folder's path, `#shown`), and an `rmdir` or a move of the folder names it as its base. */
	#liveFolders(view: View, own: ReadonlyMap<string, string>): void {
		for (const [path, made] of own) {
			const live = view.tree?.get(path);
			if (live?.kind === "folder" && live.version !== made && !view.pending?.nodes().has(path))
				this.#alias(view, path, made, live.version);
		}
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

	#list(view: View, path: string, after: string | undefined, links: boolean) {
		const tree = this.#tree(view);
		const result = view.pending
			? view.pending.children(path, after, LIST_PAGE, links)
			: tree.children(path, after, LIST_PAGE, links);
		if (result === "not_found") throw new ProtocolError(ErrorCode.notFound, "No such folder");
		if (result === "not_a_folder") throw new ProtocolError(ErrorCode.notAFolder, "Not a folder");
		// The root's listing is no read, as a machine's log has none (a logged path is never empty).
		if (path !== "") this.#served(view, { path, version: null, authority: tree.get(path)?.authority });
		if (view.times.size === 0) return result;
		return { ...result, entries: result.entries.map((entry) => this.#timed(view, path, entry)) };
	}

	/** `entry`, in the folder `folder`, with the time it showed while this view's save or move was pending, while it
	 * still has the version that published; a time whose version another replaced is forgotten. */
	#timed(view: View, folder: string, entry: WireEntry): WireEntry {
		const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
		const time = view.times.get(path);
		if (time === undefined) return entry;
		if (time.version === entry.version) return { ...entry, mtimeMs: time.mtimeMs };
		view.times.delete(path);
		return entry;
	}

	/** A file's bytes, or a link's target (protocol 4: below it a link is not there). */
	async #read(view: View, request: ReadRequest, links: boolean): Promise<Buffer> {
		this.#tree(view);
		const target = (link: string): Buffer => {
			if (!links) throw new ProtocolError(ErrorCode.notFound, "No such file");
			return Buffer.from(link).subarray(request.offset, request.offset + request.length);
		};
		const pending = view.pending?.source(request.path, request.version);
		const served = (authority: TreeEntry["authority"]): void =>
			this.#served(view, { path: request.path, version: request.version, authority });
		if (pending) {
			if ("target" in pending) return target(pending.target);
			try {
				let bytes: Buffer;
				if ("live" in pending)
					bytes = await this.#objects.read(
						await this.#profile(view, pending.live),
						pending.live,
						request.offset,
						request.length,
					);
				else {
					const end = Math.min(pending.content.size, request.offset + request.length);
					bytes =
						request.offset >= end
							? Buffer.alloc(0)
							: await this.#objects.readChunks(
									await this.#uploadProfile(view),
									pending.content.chunks,
									request.offset,
									end - request.offset,
								);
				}
				served("live" in pending ? pending.live.authority : view.tree?.get(request.path)?.authority);
				return bytes;
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
			if (!current || (!links && current.kind === "symlink"))
				throw new ProtocolError(ErrorCode.notFound, "No such file");
			if (current.kind === "folder") throw new ProtocolError(ErrorCode.notAFile, "Not a file");
			throw new ProtocolError(ErrorCode.stale, "That version is no longer readable");
		}
		if (entry.kind === "symlink") return target(entry.target!);
		if (entry.kind !== "file") throw new ProtocolError(ErrorCode.notAFile, "Not a file");
		try {
			const profileId = await this.#profile(view, entry);
			const bytes = await this.#objects.read(profileId, entry, request.offset, request.length);
			served(entry.authority);
			return bytes;
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
	async #search(view: View, request: SearchRequest, links: boolean): Promise<SearchAnswer> {
		// A run's own view only (a core view): an operator mount's machine never searches through this service. A core
		// view the core closed answers VIEW_CLOSED (from the tree), so its run opens another.
		if (!view.core) throw new ProtocolError(ErrorCode.badRequest, "Search is for a run's own view");
		const tree = this.#tree(view);
		const start = tree.get(request.path);
		if (!start || (!links && start.kind === "symlink")) throw new ProtocolError(ErrorCode.notFound, "No such path");
		try {
			const answer = await searchView(
				{
					tree,
					links,
					read: async (entry, offset, length) =>
						this.#objects.read(await this.#profile(view, entry), entry, offset, length),
					now: this.#now,
					// The view closed or its lease lapsed while the page ran: the page stops (never one slice past it).
					serving: () => void this.#tree(view),
					log: this.#log,
				},
				request,
			);
			for (const read of answer.reads)
				this.#served(view, {
					path: read.path,
					version: read.kind === "folder" ? null : read.version,
					authority: read.authority,
				});
			return answer;
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			if (error instanceof CoreRefusal) throw new ProtocolError(ErrorCode.denied, "The core refused the read");
			if (!(error instanceof ObjectUnavailableError))
				this.#log(`folder-service: ${view.key}: search failed: ${(error as Error).message}`);
			throw new ProtocolError(ErrorCode.unavailable, "The folder could not be searched now; try again");
		}
	}

	// ---- Git on the mount (F3 step 5d, git.ts) ---------------------------------------------------------------------

	/** The lock a change to `path` needs, if it is a shared git file (git.ts): the lock on X guards X, its log and the
	 * locks git writes them through. A shared file changes only under its lock, which another session may hold
	 * (NOT_PERMITTED); a folder is made or removed freely (git makes a ref's folders before it locks it). A
	 * session-local file (but by the code host) or an alternates file is never changed here (git.ts). */
	#gitGuard(view: View, path: string): GitLock | undefined {
		const host = view.identity?.kind === "code_host";
		if (gitRefused(path, host))
			throw new ProtocolError(ErrorCode.notPermitted, "Git keeps this file on the machine, or refuses it");
		if (!gitSharedPath(path, host)) return undefined;
		for (const [target, lock] of view.gitLeases) if (!lock.ended && gitGuarded(target).includes(path)) return lock;
		if (view.pending?.get(path)?.kind === "folder") return undefined;
		throw new ProtocolError(ErrorCode.notPermitted, "Git changes this file only under its lock");
	}

	/** A link's new name is never a shared git file, under its lock or not, nor one git keeps on the machine: git makes
	 * no link in its directory, and a lock's publish carries files only (git.ts). */
	#gitNoLink(view: View, path: string): void {
		const host = view.identity?.kind === "code_host";
		if (gitRefused(path, host) || gitSharedPath(path, host))
			throw new ProtocolError(ErrorCode.notPermitted, "Git keeps no link here");
	}

	/** The view a git lease is taken as: only a machine's view takes one. */
	#gitActor(view: View): Extract<FolderActor, { kind: "view" }> {
		const actor = view.actor;
		if (actor.kind !== "view")
			throw new ProtocolError(ErrorCode.notPermitted, "Only a machine's view takes git locks");
		return actor;
	}

	/** A git lease call that failed, as the machine hears it. */
	#gitError(error: unknown): ProtocolError {
		if (error instanceof ProtocolError) return error;
		if (error instanceof CoreRefusal) return new ProtocolError(ErrorCode.denied, "The core refused the git lock");
		return new ProtocolError(ErrorCode.unavailable, "The git lock could not be reached now");
	}

	/** Takes the lock on the shared file `target` for an exclusive create of its lock file (§6): the core's lease on it,
	 * which one view holds at a time (EEXIST meanwhile, so git waits and tries again). What the view holds of the files
	 * the lease guards goes, and the view reads the feed up to the versions the lease found, so git updates them from
	 * those. */
	async #gitLock<T>(view: View, target: string, create: () => Promise<T>): Promise<T> {
		// A test machine's changes are credited to its commands (F3 6b), and a git publish carries no credits: it takes no
		// git lock, so git there changes no shared git file. It reads them as anywhere.
		if (view.access?.testMachine)
			throw new ProtocolError(ErrorCode.notPermitted, "A test machine takes no git locks");
		const actor = this.#gitActor(view);
		view.gitTaking.add(target);
		try {
			return await this.#gitTake(view, actor, target, create);
		} finally {
			view.gitTaking.delete(target);
		}
	}

	async #gitTake<T>(
		view: View,
		actor: Extract<FolderActor, { kind: "view" }>,
		target: string,
		create: () => Promise<T>,
	): Promise<T> {
		let lease: GitLease;
		try {
			lease = await this.#core.gitLeaseTake(view.environmentId, actor, target);
		} catch (error) {
			if (!(error instanceof CoreRefusal)) view.gitUnsure = true;
			throw this.#gitError(error);
		}
		if (lease.state === "busy") throw new ProtocolError(ErrorCode.exists, "Another session holds this git lock");
		if (lease.state === "refused")
			throw new ProtocolError(ErrorCode.notPermitted, `The core refuses this git lock (${lease.reason})`);
		const lock: GitLock = {
			leaseId: lease.leaseId,
			versions: lease.versions,
			deleted: new Set(),
			replaced: new Set(),
			ended: false,
		};
		view.gitLeases.set(target, lock);
		try {
			const packedRefs = `${gitDir(target)}/packed-refs`;
			const drop = [target, gitReflog(target)];
			if (!view.gitLeases.has(packedRefs)) drop.push(packedRefs);
			view.pending?.drop(drop);
			this.#push(view, drop);
			await this.#gitCatchUp(
				view,
				[
					[target, lock.versions.file],
					[gitReflog(target), lock.versions.reflog],
					[packedRefs, lock.versions.packedRefs],
				],
				target === packedRefs,
			);
			return await create();
		} catch (error) {
			view.gitLeases.delete(target);
			await this.#core.gitLeaseRelease(view.environmentId, actor, lock.leaseId, null).catch(() => {
				view.gitUnsure = true;
			});
			throw error;
		}
	}

	/** Reads the feed until the view shows each path at its version (null: no file), a few rounds; EEXIST if it does
	 * not then, so git tries the lock again. `packing` (`packed-refs`' lock) reads it at least once: git packs the loose
	 * refs the view lists, and a branch another session deleted under this lock before must be gone from it, not packed
	 * back. */
	async #gitCatchUp(view: View, want: readonly (readonly [string, string | null])[], packing = false): Promise<void> {
		for (let round = 0; ; round++) {
			const shown = want.every(([path, version]) => (view.tree?.get(path)?.version ?? null) === version);
			if (shown && (round > 0 || !packing)) return;
			if (round === GIT_CATCH_UP_ROUNDS)
				throw new ProtocolError(ErrorCode.exists, "The view has not caught up with this git lock yet");
			this.#queue(view, () => this.#advance(view));
			await view.work;
		}
	}

	/** Publishes a git lock (§6): renaming `X.lock` onto X saves X over the version the lease found, with the log git
	 * appended for it and every object the view wrote in that git directory (a ref names only objects published with
	 * it or before), in one change set, which ends the lease. A version changed since fails the rename (BUSY) and keeps
	 * the lease: git then removes its lock (#gitUnlock). `packed-refs.new` renamed onto `packed-refs` under its lock
	 * publishes the same way, so a `git pack-refs` that cannot publish stops before it prunes a loose ref. */
	async #gitPublish(view: View, from: string, target: string, lock: GitLock): Promise<void> {
		await this.#quiet(view);
		const pending = view.pending;
		if (!pending) throw new ProtocolError(ErrorCode.readOnly, "This view is read-only");
		await this.#inTurn(view, async () => {
			const answer = await this.#gitPublishNow(view, pending, from, target, lock);
			return { commitId: answer.commitId, seq: answer.seq, paths: [] };
		});
	}

	async #gitPublishNow(
		view: View,
		pending: PendingView,
		from: string,
		target: string,
		lock: GitLock,
	): Promise<GitPublish> {
		const actor = this.#gitActor(view);
		await this.#gitDirFirst(view, pending, target);
		const node = pending.nodes().get(from);
		if (node?.kind !== "file") throw new ProtocolError(ErrorCode.notFound, "The git lock is gone");
		if (node.open > 0) throw new ProtocolError(ErrorCode.busy, "The git lock is still open for writing");
		const reflog = gitReflog(target);
		const log = pending.nodes().get(reflog);
		if (log?.kind === "file" && log.open > 0) throw new ProtocolError(ErrorCode.busy, "The git log is still open");
		// Each unit with the node it publishes and the path that node is at.
		const objects = `${gitDir(target)}/objects/`;
		const files: { path: string; at: string; node: PendingFile; expectedVersion?: string | null }[] = [];
		for (const [path, n] of pending.nodes())
			if (n.kind === "file" && n.open === 0 && path.startsWith(objects) && gitPublishedObject(path))
				files.push({ path, at: path, node: n });
		files.push({ path: target, at: from, node, expectedVersion: lock.versions.file });
		if (log?.kind === "file" && log.content !== undefined)
			files.push({ path: reflog, at: reflog, node: log, expectedVersion: lock.versions.reflog });
		const units: GitUnit[] = [];
		const made: { path: string; at: string; version: string }[] = [];
		for (const file of files) {
			const version = file.node.version;
			const staged = await this.#gitStage(view, file.node, file.path);
			if (!staged) {
				if (file.expectedVersion === undefined) continue;
				throw new ProtocolError(ErrorCode.unavailable, "The git change could not be staged now");
			}
			units.push(
				file.expectedVersion === undefined
					? { op: "write", path: file.path, file: staged }
					: { op: "write", path: file.path, file: staged, expectedVersion: file.expectedVersion },
			);
			made.push({ path: file.path, at: file.at, version });
		}
		await this.#gitReadGate(view);
		// What a change set saved: the live versions of the files made, which show again once the feed has it.
		const saved = (outcomes: CommitAnswer["units"], files: typeof made): Map<string, string> => {
			const settled = new Map<string, string>();
			outcomes.forEach((outcome, i) => {
				const unit = files[i];
				if (!unit || outcome.outcome !== "saved" || !outcome.version) return;
				this.#alias(view, unit.path, unit.version, outcome.version);
				settled.set(unit.at, unit.version);
			});
			return settled;
		};
		// A change set takes at most GIT_UNITS units, the folders made for them among them. A publish that would take more
		// saves its objects first, in plain change sets of the view's (objects take no lease), and carries the ref alone.
		let first = 0;
		if (gitBatches(units).length > 1) {
			first = units.findIndex((unit) => unit.op === "write" && unit.expectedVersion !== undefined);
			let at = 0;
			for (const batch of gitBatches(units.slice(0, first))) {
				const folders = [...new Set(batch.flatMap((unit) => gitFolders(unit.path)))];
				const writes = batch.flatMap((unit): CommitUnit[] =>
					unit.op === "write" ? [{ op: "write", path: unit.path, file: unit.file }] : [],
				);
				const mkdirs = folders.map((path): CommitUnit => ({ op: "mkdir", path }));
				const objects = await this.#commit(view, actor, `folder-view:${view.key}:git:${randomUUID()}`, [
					...mkdirs,
					...writes,
				]);
				if (!objects) throw new ProtocolError(ErrorCode.unavailable, "The git objects could not be saved now");
				if (objects.units.some((outcome) => outcome.outcome !== "saved"))
					throw new ProtocolError(ErrorCode.denied, "The core refused the git objects");
				const settled = saved(objects.units.slice(folders.length), made.slice(at, at + batch.length));
				if (objects.seq !== null) view.gitUnsettled.push({ seq: objects.seq, made: settled });
				at += batch.length;
			}
		}
		const key = `folder-view:${view.key}:git:${randomUUID()}`;
		let answer: GitPublish | undefined;
		for (let attempt = 1; !answer; attempt++)
			try {
				answer = await this.#core.gitPublish(view.environmentId, actor, lock.leaseId, key, units.slice(first));
			} catch (error) {
				if (error instanceof CoreRefusal || attempt === GIT_PUBLISH_TRIES) throw this.#gitError(error);
			}
		if (!answer.published) throw new ProtocolError(ErrorCode.busy, "A git file changed since its lock was taken");
		// `packed-refs.lock` stays until git removes it (#gitUnlock).
		if (from === `${target}.lock`) view.gitLeases.delete(target);
		else lock.ended = true;
		const settled = saved(answer.units, made.slice(first));
		// The lock file is gone at once (git renamed it); what it published shows as the feed brings it. `from` stays in
		// the later settling: a folder made for the ref (`refs/heads/feature/` for `feature/foo`) is live only then.
		const own = this.#ownFolders(view, pending.nodes().keys());
		pending.settlePaths(new Map([[from, node.version]]));
		this.#liveFolders(view, own);
		this.#push(view, [from]);
		if (answer.seq !== null) {
			view.gitUnsettled.push({ seq: answer.seq, made: settled });
			await this.#gitCatchUpTo(view, answer.seq);
		}
		return answer;
	}

	/** A boundary's read gate, before a git change is published: a view whose machine lost its read log publishes
	 * nothing more, and the machine's reads reach the read sets before anything made from them (the log's rule 1), the
	 * reads of every view of the machine, as at an ordinary boundary (#boundaryOf): git on the machine read through
	 * any of them. */
	async #gitReadGate(view: View): Promise<void> {
		const lost = () =>
			new ProtocolError(ErrorCode.denied, "The machine lost its read log, so nothing it makes is published");
		if (view.unproven) throw lost();
		const machine = view.access?.machine;
		const release = machine === undefined ? await this.#releaseReads(view) : await this.#releaseMachine(machine);
		// Another view of the machine went while the release ran, with reads it never released.
		if (view.unproven) throw lost();
		if (release === "unanswered")
			throw new ProtocolError(ErrorCode.busy, "The machine's reads have not got through yet");
		if (release !== "released")
			throw new ProtocolError(ErrorCode.denied, `The core refused the machine's reads (${release})`);
	}

	/** Reads the feed a few rounds until the view has change set `seq`. */
	async #gitCatchUpTo(view: View, seq: number): Promise<void> {
		for (let round = 0; round < GIT_CATCH_UP_ROUNDS && view.seq < seq; round++) {
			this.#queue(view, () => this.#advance(view));
			await view.work;
		}
	}

	/** Settles the git publishes whose change sets the view has now: it shows the live files again. */
	#gitSettle(view: View): void {
		const due = view.gitUnsettled.filter((unsettled) => unsettled.seq <= view.seq);
		if (due.length === 0) return;
		view.gitUnsettled.splice(0, view.gitUnsettled.length, ...view.gitUnsettled.filter((u) => u.seq > view.seq));
		const own = this.#ownFolders(view, view.pending?.nodes().keys() ?? []);
		for (const unsettled of due) view.pending?.settlePaths(unsettled.made);
		this.#liveFolders(view, own);
	}

	/** A git directory `git init` made in the view (the code host's seed), or a folder above it, is saved first by an
	 * ordinary boundary, with what else the view has pending (`HEAD`, `config`): a lease's change set makes only the
	 * folders below its git directory (446300). */
	async #gitDirFirst(view: View, pending: PendingView, target: string): Promise<void> {
		if (!gitDirNew(pending, target)) return;
		await this.#boundary(view, false);
		if (gitDirNew(pending, target))
			throw new ProtocolError(ErrorCode.busy, "The new git directory is not in the folder yet");
	}

	/** Removes a git lock (§6): the lease ends, publishing the guarded files git removed under it (`git branch -D`) and
	 * the log it replaced (`git reflog expire`), or nothing (an update git rolled back, whose line in the log goes too, or
	 * a lock a killed git left; `packed-refs.lock` after its publish ended the lease). A change that no longer matches
	 * the versions the lease found is not published: the machine hears BUSY, and shows the live files again. */
	async #gitUnlock(view: View, path: string, target: string, lock: GitLock): Promise<void> {
		await this.#quiet(view);
		const pending = view.pending;
		if (!pending) throw new ProtocolError(ErrorCode.readOnly, "This view is read-only");
		const node = pending.nodes().get(path);
		if (node?.kind === "file" && node.open > 0)
			throw new ProtocolError(ErrorCode.busy, "The git lock is still open for writing");
		let published = true;
		await this.#inTurn(view, async () => {
			const guarded = gitGuarded(target);
			if (lock.ended) {
				view.gitLeases.delete(target);
				pending.drop(guarded);
				this.#push(view, guarded);
				return { commitId: null, seq: null, paths: [] };
			}
			const actor = this.#gitActor(view);
			const units: GitUnit[] = [];
			const removed: [string, string | null][] = [
				[target, lock.versions.file],
				[gitReflog(target), lock.versions.reflog],
			];
			for (const [file, version] of removed)
				if (version !== null && lock.deleted.has(file) && pending.nodes().get(file)?.kind !== "file")
					units.push({ op: "delete", path: file, expectedVersion: version });
			// A coding view publishes nothing, a git removal neither, before its machine's values came (5j-5). A lease
			// that publishes nothing still ends.
			if (units.length > 0 && this.#secretsOf(view) === null)
				throw new ProtocolError(ErrorCode.busy, "The git change waits for the machine's secret check");
			const reflog = gitReflog(target);
			const log = pending.nodes().get(reflog);
			let made: string | undefined;
			if (lock.replaced.has(reflog) && log?.kind === "file" && log.content !== undefined) {
				if (log.open > 0) throw new ProtocolError(ErrorCode.busy, "The git log is still open");
				made = log.version;
				const staged = await this.#gitStage(view, log, reflog);
				if (!staged) throw new ProtocolError(ErrorCode.unavailable, "The git change could not be staged now");
				units.push({ op: "write", path: reflog, file: staged, expectedVersion: lock.versions.reflog });
			}
			if (units.length > 0) await this.#gitReadGate(view);
			let answer: GitPublish | null = null;
			try {
				answer = await this.#core.gitLeaseRelease(
					view.environmentId,
					actor,
					lock.leaseId,
					units.length > 0 ? units : null,
				);
			} catch (error) {
				// A lease the core no longer holds (the view's leases were dropped) is gone here too, and what was to land
				// under it did not. Any other refusal (units the core does not take) leaves the lease held.
				if (!(error instanceof CoreRefusal && error.said === GIT_LEASE_GONE)) throw this.#gitError(error);
			}
			view.gitLeases.delete(target);
			published = units.length === 0 || answer?.published === true;
			const written = answer?.published ? answer.units.at(-1) : undefined;
			if (made !== undefined && written?.outcome === "saved" && written.version)
				this.#alias(view, reflog, made, written.version);
			if (answer?.published && answer.seq !== null) await this.#gitCatchUpTo(view, answer.seq);
			pending.drop(guarded);
			this.#push(view, guarded);
			return { commitId: answer?.commitId ?? null, seq: answer?.seq ?? null, paths: [] };
		});
		if (!published) throw new ProtocolError(ErrorCode.busy, "A git file changed since its lock was taken");
	}

	/** At a final boundary the view lets go of its git locks: a lock a killed git left goes, with its lease, so other
	 * sessions may take it. (The core drops them when the view ends, too.) */
	async #gitSweep(view: View): Promise<void> {
		if (view.gitLeases.size === 0 && !view.gitUnsure) return;
		try {
			await this.#core.gitLeasesDrop(view.environmentId, this.#gitActor(view));
		} catch (error) {
			this.#log(`folder-service: ${view.key}: its git locks could not be let go now: ${(error as Error).message}`);
			return;
		}
		view.gitUnsure = false;
		const guarded = [...view.gitLeases.keys()].flatMap((target) => gitGuarded(target));
		view.gitLeases.clear();
		view.pending?.drop(guarded);
		this.#push(view, guarded);
	}

	// ---- Writes (F3 step 3, RUNTIME-FOLDER-WRITES.md) --------------------------------------------------------------

	/** One change to the view's pending changes. A change that needs what is pending published first publishes it,
	 * then is made again; if it is still blocked then, the machine hears BUSY. `changed`: what it changes, for a test
	 * machine's credits (F3 6b), read as it is made, which go to `tags`: the command windows open as the machine asked
	 * it, taken before anything is awaited (a request that awaits before its change passes those it took on entry). A
	 * window that closes while the change waits for a boundary keeps it. The change and its tags are made in one
	 * synchronous step, after the last await: no other change sees one without the other. */
	async #change<T>(
		view: View,
		changed: Changed | ((pending: PendingView) => Changed),
		change: (pending: PendingView) => T,
		tags = this.#windowsOf(view),
	): Promise<T> {
		await this.#quiet(view);
		const pending = view.pending;
		if (!pending) throw new ProtocolError(ErrorCode.readOnly, "This view is read-only");
		// What the change may remove and what it changes showed, as they are when it is made.
		const make = (): readonly [T, Before | undefined] => {
			if (tags === undefined) return [change(pending), undefined];
			const seen = view.credit.before(pending, typeof changed === "function" ? changed(pending) : changed);
			return [change(pending), seen];
		};
		let made: readonly [T, Before | undefined];
		try {
			made = make();
		} catch (error) {
			if (!(error instanceof PublishFirst)) throw error;
			await this.#publish(view, false, false, true);
			// The boundary must be answered and settled, and no other one running, before the change is made again: until
			// then the view still holds what that boundary published, and settling it would undo the change (BUSY).
			await this.#quiet(view);
			try {
				made = make();
			} catch (again) {
				if (again instanceof PublishFirst) throw new ProtocolError(ErrorCode.busy, again.message);
				throw again;
			}
		}
		const [answer, seen] = made;
		// A test machine's change is tagged (F3 6b): the removal it recorded, and the node it made, moved or changed.
		if (tags !== undefined && seen !== undefined) view.credit.after(pending, seen, tags);
		this.#touch(view);
		return answer;
	}

	/** What a test machine's change made now is credited to (F3 6b): its open windows' commands, or its starter. None
	 * for any other view. */
	#windowsOf(view: View): readonly string[] | undefined {
		const machine = view.access?.machine;
		return view.access?.testMachine && machine !== undefined ? this.#windows.tags(machine) : undefined;
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
				await this.#publish(view, false, false, true);
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
		view.steps++;
		const decide = (): void => {
			view.steps--;
			if (view.publishing === next) this.#unheld(view);
		};
		next.then(decide, decide);
		return next;
	}

	/** A core view no machine holds, with no boundary running: kept (renewed, and not forgotten while idle), or let go. */
	#unheld(view: View): void {
		if (view.connections > 0 || view.moving || !view.lease || view.closed || this.#views.get(view.key) !== view)
			return;
		if (this.#kept(view)) view.idleSince = undefined;
		else this.#letGo(view);
	}

	/** A change restarts the quiet period of a mount that publishes on one, and the view's last boundary no longer says
	 * whether it is kept: a boundary carrying the change does. A core view's first change not published renews it at
	 * once, so the core counts a desktop's seat in use from then (C1B §9), not up to a round later; a command's view has
	 * no seat. */
	#touch(view: View): void {
		view.heard = undefined;
		if (view.moving || view.closed) return;
		if (view.lease && !view.access?.command && view.unsavedSince === undefined && view.pending?.unsaved) {
			view.unsavedSince = this.#now();
			this.#renew(view).catch((error: unknown) =>
				this.#log(`folder-service: ${view.key}: lease not renewed now: ${(error as Error).message}`),
			);
		}
		this.#resumeQuiet(view);
	}

	#resumeQuiet(view: View): void {
		if (view.closed || view.moving || view.connections === 0 || view.quietMs === undefined || !view.pending?.unsaved)
			return;
		if (view.quiet) clearTimeout(view.quiet);
		view.quiet = undefined;
		// A command's quiet period runs only while its machine holds the view: a change that waited behind a boundary and
		// landed after the last connection left waits, with what else is pending, for the boundary its machine asks.
		if (view.access?.command && view.connections === 0) return;
		view.quiet = setTimeout(() => {
			view.quiet = undefined;
			void this.#publishLogged(view, true);
		}, view.quietMs);
		view.quiet.unref?.();
	}

	/** A boundary no machine asked for: what it did not save goes to the log, and what came of it to the view's notices
	 * (F3 4f-2b-2). `quiet`: one a quiet period asked. */
	async #publishLogged(view: View, quiet = false): Promise<void> {
		try {
			const report = await this.#publish(view, false, quiet, true);
			// A name not checked for the machine's secret values yet is not named (5j-5).
			let unchecked = 0;
			for (const entry of report.paths)
				if (entry.reason === SECRETS_WAIT) unchecked++;
				else if (entry.outcome !== "saved")
					this.#log(
						`folder-service: ${view.key}: ${entry.path}: ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ""}`,
					);
			if (unchecked > 0)
				this.#log(
					`folder-service: ${view.key}: ${unchecked === 1 ? "1 change waits" : `${unchecked} changes wait`} for the machine's secret check`,
				);
		} catch (error) {
			this.#log(`folder-service: ${view.key}: publish failed: ${(error as Error).message}`);
		}
	}

	/** A handle given up (a discard): the file a draft held unpublished, if any, is no longer open, and the quiet period
	 * publishes it. */
	#giveUp(view: View, handle: number): void {
		this.#abandon(view, handle);
		view.handles.delete(handle);
		this.#resumeQuiet(view);
	}

	#abandon(view: View, handle: number): void {
		for (const [key, upload] of view.uploads)
			if (key.startsWith(`${handle}:`)) {
				upload.upload?.abort();
				view.uploads.delete(key);
			}
		// A test machine's file whose last handle this was loses the chunks no close fixed, and their tags (F3 6b); so
		// does the view's own file a draft held, when the draft let go of it last.
		let file: PendingFile | undefined;
		let held: PendingFile | undefined;
		try {
			if (this.#windowsOf(view) !== undefined) {
				file = view.pending?.file(handle);
				held = view.pending?.draftHeld(handle);
			}
		} catch {
			// Closed already: nothing of it is left to abandon.
		}
		view.pending?.abandon(handle);
		this.#lost(view, file);
		this.#lost(view, held);
	}

	/** A file a handle, or a draft's hold, let go of: with none left on it, it is back at the bytes its last close fixed,
	 * and a test machine's chunks no close fixed lose their tags (F3 6b). */
	#lost(view: View, file: PendingFile | undefined): void {
		if (file !== undefined && file.open === 0) view.credit.abandoned(file);
	}

	/** One part of a chunk. The first part opens the chunk's own intent (its bytes are known, its file's are not) and
	 * starts the gateway's put; the last waits for the gateway, then sets the chunk in the file. A chunk the actor
	 * holds already is not sent on. */
	async #chunk(view: View, part: ChunkPart): Promise<void> {
		// Credited as a change is (#change): to the windows open as the machine sent it.
		const tags = this.#windowsOf(view);
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
			// Its tags, in the same step: a close made after it fixes both.
			if (tags !== undefined) view.credit.wrote(pending.file(part.handle), tags);
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
			const origin = node.origin?.entry ?? node.copyOf;
			if (!origin) return Buffer.alloc(0);
			const profile = await this.#profile(view, origin);
			const chunk = (await this.#objects.manifestChunks(profile, origin))[index];
			const bytes = chunk ? await this.#objects.chunk(profile, chunk.sha256, chunk.bytes) : Buffer.alloc(0);
			this.#served(view, { path: origin.path, version: origin.version, authority: origin.authority });
			return bytes;
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

	/** Stages a closed file's current version (its bytes, its origin's chunks under a new bit, or a hard link's copy of
	 * another file's) at `path`, once; the intent it is sealed under is renewed while the file is pending. A coding
	 * view's bytes (5j-5) are checked against its machine's secret values first, and staged only if they carry none: a
	 * staging checked against older values is checked again for the new ones. They are checked as `path` stores them: a
	 * git object's inflated, a pack's as git reads it (git-objects.ts), and a staging checked under another name (git's
	 * temporary one) is checked again as its new name's form. A file refused stays refused at its version, but one
	 * refused only for the node's load (too many packs waiting) is checked again at the next staging. Nothing is staged
	 * while the machine's values have not come. Only the machine's own bytes are checked: a live file's are in the
	 * folder already. */
	async #stage(
		view: View,
		node: PendingFile,
		path: string,
		secrets = this.#secretsOf(view),
	): Promise<FileRef | undefined> {
		const staging = this.#staging;
		const changed = node.content !== undefined || !node.origin || node.executable !== node.origin.entry?.executable;
		if (!staging || node.open > 0 || !changed || secrets === null) return undefined;
		const check = node.content === undefined ? undefined : secrets;
		if (check && this.#refusalOf(node, check, true)) return undefined;
		const version = node.version;
		const form = storedForm(path);
		if (this.#stagedNow(view, node, path)) {
			const file = node.staged?.file;
			const left = check && file && this.#uncheckedOf(file, check, form);
			if (!left) return file;
			const bytes = await this.#bytesOf(view, node);
			try {
				if (bytes) await staging.check(bytes.profile, bytes.content, left, form);
			} catch (error) {
				if (!(error instanceof SecretRefusal)) throw error;
				if (node.version === version) {
					this.#refusals.set(node, { version, secrets: check, reason: error.message, again: error.again });
					node.staged = undefined;
				}
				return undefined;
			}
			this.#checked.set(file, { secrets: check, form });
			this.#passed(node, version, check);
			return file;
		}
		// A staging for another version or media type is never used again.
		node.staged = undefined;
		const mediaType = this.#mediaType(view, node, path);
		const bytes = await this.#bytesOf(view, node);
		if (!bytes) return undefined;
		let staged: { readonly file: FileRef; readonly intentId: string };
		try {
			staged = await staging.stageFile(
				view.environmentId,
				view.actor,
				bytes.profile,
				bytes.content,
				mediaType,
				node.executable,
				check,
				form,
			);
		} catch (error) {
			if (!(error instanceof SecretRefusal) || !check) throw error;
			if (node.version === version)
				this.#refusals.set(node, { version, secrets: check, reason: error.message, again: error.again });
			return undefined;
		}
		if (check) {
			this.#checked.set(staged.file, { secrets: check, form });
			this.#passed(node, version, check);
		}
		if (node.version === version) {
			node.staged = { version, file: staged.file };
			view.intents.set(staged.intentId, { renewed: this.#now(), node, staged: staged.file });
		}
		return staged.file;
	}

	/** A file's bytes as staging reads them (its own, or its origin's or a hard link's copied file's chunks), and the
	 * profile they are read under. */
	async #bytesOf(view: View, node: PendingFile): Promise<{ content: Content; profile: string } | undefined> {
		let content = node.content;
		const origin = node.origin?.entry ?? node.copyOf;
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
		return { content, profile };
	}

	/** The secret values a view's boundary checks what it publishes against (5j-5): a coding session's machine's, as its
	 * executor last sent them; `null` while it sent none, so nothing of the view is staged or published. Any other view
	 * (a test machine's, an office's, the code host's) is not checked: `undefined`. */
	#secretsOf(view: View): SecretSet | null | undefined {
		if (view.identity?.kind !== "coding_session") return undefined;
		const machine = view.access?.machine;
		return machine === undefined ? null : (this.#secrets.get(machine) ?? null);
	}

	/** Why the check refused a file's bytes as they are now, under `secrets`, if it did; with `settled`, only if for the
	 * bytes, not for the node's load. */
	#refusalOf(node: PendingFile, secrets: SecretSet, settled = false): string | undefined {
		const refusal = this.#refusals.get(node);
		if (refusal?.version !== node.version || refusal.secrets !== secrets || (settled && refusal.again))
			return undefined;
		return refusal.reason;
	}

	/** A check of a node's bytes at `version` against `secrets` passed: a refusal of them for the node's load is over. */
	#passed(node: PendingFile, version: string, secrets: SecretSet): void {
		const refusal = this.#refusals.get(node);
		if (refusal?.version === version && refusal.secrets === secrets) this.#refusals.delete(node);
	}

	/** A node's staged file at `path`, if it is for the node's version and, where its bytes are checked, checked
	 * against `secrets` as `path` stores them. */
	#stagedFor(node: PendingFile, secrets: SecretSet | undefined, path: string): FileRef | undefined {
		const file = node.staged?.version === node.version ? node.staged.file : undefined;
		if (!file || !secrets || node.content === undefined) return file;
		return this.#uncheckedOf(file, secrets, storedForm(path)) ? undefined : file;
	}

	/** The values of `secrets` a staged file's bytes still need checking for, as `form`: none (`undefined`) if they
	 * were checked against these values as a form that covers it; only the newer ones if against older values so;
	 * else all. A plain check covers no git form; every form's check scans the bytes as they are too. */
	#uncheckedOf(file: FileRef, secrets: SecretSet, form: StoredForm): SecretSet | undefined {
		const had = this.#checked.get(file);
		const covered = had !== undefined && (form === "plain" || had.form === form);
		if (covered && had.secrets === secrets) return undefined;
		return covered ? secrets.since(had.secrets) : secrets;
	}

	/** What a boundary checks against `secrets` (plan.ts). */
	#checkOf(secrets: SecretSet | undefined): SecretCheck | undefined {
		return (
			secrets && {
				carries: (text) => secrets.carries(text),
				refused: (node) => this.#refusalOf(node, secrets),
			}
		);
	}

	/** Stages a file a git lease publishes (§6). A coding view's is checked as a boundary checks it (5j-5), its name
	 * first: the git change waits for the machine's values, and one that carries a value is refused whole. */
	async #gitStage(view: View, node: PendingFile, path: string): Promise<FileRef | undefined> {
		const secrets = this.#secretsOf(view);
		if (secrets === null)
			throw new ProtocolError(ErrorCode.busy, "The git change waits for the machine's secret check");
		if (secrets?.carries(path))
			throw new ProtocolError(ErrorCode.notPermitted, "The git change carries a secret value");
		const staged = await this.#stage(view, node, path, secrets);
		const refusal = secrets && node.content !== undefined ? this.#refusalOf(node, secrets) : undefined;
		if (refusal)
			throw new ProtocolError(
				ErrorCode.notPermitted,
				refusal === CARRIES
					? "The git change carries a secret value"
					: "The git change could not be checked for secret values",
			);
		return staged;
	}

	/** The path a node is shown at now. */
	#pathOfNode(view: View, node: PendingFile): string | undefined {
		for (const [path, n] of view.pending?.nodes() ?? []) if (n === node) return path;
		return undefined;
	}

	/** One boundary, after any running one (RUNTIME-FOLDER-WRITES.md, "A boundary"). `final`: a command's last. `quiet`:
	 * one a quiet period asked, which publishes nothing on a command's view no machine holds by its turn: the last
	 * connection left while it waited, and what is pending waits for the boundary the command's machine asks. `unasked`:
	 * one no machine asked for (a quiet period's, the last connection's leaving, one a change needs first, or one with
	 * no answer asked again before a change), whose report no machine hears: what came of each change set it asked goes
	 * to the view's notices (F3 4f-2b-2). */
	#publish(view: View, final = false, quiet = false, unasked = false): Promise<Report> {
		return this.#inTurn(view, async () => {
			if (quiet && view.access?.command && view.connections === 0) return { commitId: null, seq: null, paths: [] };
			return await this.#boundary(view, final, final, unasked);
		});
	}

	/** Keeps what came of one change set of a boundary no machine asked for (`unasked`), from its own outcomes only, as
	 * the view's next notice, if it committed or was refused; returns the report. One a machine asked for keeps none. */
	#notice(view: View, unasked: boolean, report: Report): Report {
		const notice = unasked ? noticeOf(report, view.noticed + 1, this.#now()) : undefined;
		if (!notice) return report;
		view.noticed = notice.n;
		view.notices.push(notice);
		if (view.notices.length > NOTICES_KEPT) view.notices.splice(0, view.notices.length - NOTICES_KEPT);
		return report;
	}

	/** `last`: a coding view's final boundary, which the executor asks before it closes the view (F3 5c): a refusal
	 * that may not lift is final there, as a command's final's is. `unasked`: as #publish's. */
	async #boundary(view: View, final: boolean, last = final, unasked = false): Promise<Report> {
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
		if (view.closed) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
		if (!pending) return { commitId: null, seq: null, paths: [] };
		return await this.#boundaryOf(view, pending, final, last, unasked);
	}

	/** The report of a boundary of a view whose machine cannot show its reads complete: it publishes nothing. */
	#unprovenReport(view: View, pending: PendingView): Report {
		view.heard = "refused";
		const secrets = this.#secretsOf(view);
		if (secrets === null)
			return {
				commitId: null,
				seq: null,
				refused: "unproven",
				paths: uncheckedOf(planBoundary(pending, () => undefined)),
			};
		const plan = planBoundary(pending, (node, path) => this.#stagedFor(node, secrets, path), this.#checkOf(secrets));
		return {
			commitId: null,
			seq: null,
			refused: "unproven",
			paths: [
				...waitingOf(plan),
				...refusedOf(plan, false),
				...held(plan, () => ({ outcome: "refused", reason: "unproven" })),
			],
		};
	}

	/** A command's final boundary (F3 4b, C1B §8) publishes everything its view has pending, or nothing: one change
	 * set, empty when nothing is pending, whose answer closes the view. A path still waiting holds it back (the machine
	 * asks again). Each boundary first releases the reads the view's machine logged (F3 4c), and is refused if they
	 * are refused; a coding view's, every read its machine was served under any of its views (F3 5c, the plan's rule
	 * 1). `view.heard` keeps what it heard. `unasked`: as #publish's; a boundary no machine asked for keeps a notice of
	 * each change set it asked (F3 4f-2b-2), each from its own outcomes: the one asked again, then its own. */
	async #boundaryOf(
		view: View,
		pending: PendingView,
		final: boolean,
		last: boolean,
		unasked: boolean,
	): Promise<Report> {
		if (final) await this.#gitSweep(view);
		// An answered boundary the feed has not brought back yet settles first; nothing else is decided until it has.
		if (view.unsettled) {
			await this.#trySettle(view);
			if (view.unsettled)
				throw new ProtocolError(ErrorCode.busy, "The last save has not come back through the feed yet");
		}
		// A view whose machine cannot show its read log complete publishes nothing more, not even a boundary with no
		// answer asked again: what it carries may have been made from a read the core never had (the log's rule 4).
		if (view.unproven) return this.#notice(view, unasked, this.#unprovenReport(view, pending));
		// A boundary whose answer never came goes first, unchanged (a final one final).
		let settled: ReportEntry[] = [];
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
			// it again. Its refusal is its own notice first, with the paths it refused (no commit shows it).
			if (
				answer.said === VIEW_ENDED &&
				earlier.actor.kind === "view" &&
				earlier.actor.viewId === view.lease?.viewId
			) {
				this.#close(view, VIEW_ENDED);
				return this.#notice(view, unasked, {
					...committed(answer),
					paths: held(earlier.plan, () => ({ outcome: "refused", reason: "denied" })),
				});
			}
			if (holds(view, answer, last))
				this.#notice(view, unasked, {
					...committed(answer),
					paths: held(earlier.plan, (i) => ({ outcome: "refused", reason: answer.units[i]?.reason })),
				});
			else {
				settled = await this.#settle(view, earlier.plan, earlier.made, answer);
				if (view.unsettled) {
					view.heard = heardOf(answer);
					return this.#notice(view, unasked, { ...committed(answer), paths: settled });
				}
				// This boundary's report says what the rest did too; the earlier one's notice is its change set or its
				// refusal alone.
				this.#notice(view, unasked, { ...committed(answer), paths: settled });
			}
		}
		const report = this.#notice(view, unasked, await this.#planned(view, pending, final, last));
		return settled.length === 0 ? report : { ...report, paths: [...settled, ...report.paths] };
	}

	/** A boundary's own change set, planned from what is pending now, after any asked again (#boundaryOf). */
	async #planned(view: View, pending: PendingView, final: boolean, last: boolean): Promise<Report> {
		const entries: ReportEntry[] = [];
		// A coding view's boundary checks against the values its machine's executor sent last when it began (5j-5): values
		// sent while it runs are the next boundary's. Until the first come, it publishes nothing.
		const secrets = this.#secretsOf(view);
		if (secrets === null) {
			view.heard = "open";
			return { commitId: null, seq: null, paths: uncheckedOf(planBoundary(pending, () => undefined)) };
		}
		await this.#stageAll(view, secrets);
		const plan = planBoundary(pending, (node, path) => this.#stagedFor(node, secrets, path), this.#checkOf(secrets));
		// A test machine's units are credited from what they publish, as planned (F3 6b). A change undone before it was
		// published, as a move moved back, leaves nothing to publish: its tags go, even when nothing is published.
		const credited = view.credit.credits(plan.units, pending);
		view.credit.prune(pending);
		entries.push(...waitingOf(plan), ...refusedOf(plan, final || last));
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
		// The reads reach the read sets before anything made from them is published (the log's rule 1). One release of the
		// machine's views is enough here, unlike before a machine's boundary is answered: what this commits was planned
		// before it began, so a read served while it runs reached none of it.
		const machine = view.access?.machine;
		const release = machine === undefined ? await this.#releaseReads(view) : await this.#releaseMachine(machine);
		// Another view of the machine went while the release ran, with reads it never released.
		if (view.unproven) return this.#unprovenReport(view, pending);
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
		const structured = await this.#structured(
			view,
			plan.units.map((u) => u.unit),
		);
		// A test machine's units name the commands they are credited to (F3 6b); asked again, they name the same.
		const units = structured.map((unit, i): CreditedUnit => {
			const credits = credited[i];
			return credits ? { ...unit, credits } : unit;
		});
		const key = `folder-view:${view.key}:${randomUUID()}`;
		// The version each file this boundary publishes bytes for has now, as the machine heard it.
		const made = new Map<string, string>();
		for (const u of plan.units)
			if (u.bytes)
				for (const path of u.paths) {
					const node = pending.nodes().get(path);
					if (node?.kind === "file" || node?.kind === "symlink") made.set(path, node.version);
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
		if (answer.said === VIEW_ENDED) this.#close(view, VIEW_ENDED);
		if (holds(view, answer, last))
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
		// A coding machine's log is taken and filed nowhere: this service records what it serves (#served), so a log
		// the machine's root could rewrite counts for nothing, its loss included (F3 5c, the plan's rule 1).
		const coding = view.access?.machine !== undefined;
		if (request.lost && !coding) view.unproven = true;
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
				if (!view.core || coding) continue;
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
		if (pending)
			return { path: entry.path, version: "live" in pending ? (pending.live?.version ?? null) : null, authority };
		const version = this.#base(view, entry.path, entry.version) ?? entry.version;
		const placed =
			view.tree?.get(entry.path)?.version === version ||
			view.superseded.get(entry.path)?.some((old) => old.version === version);
		return { path: entry.path, version: placed ? version : null, authority };
	}

	/** Records a read a coding view serves, in memory, before its answer leaves (F3 5c, the plan's rule 1): released
	 * before the view's next boundary and every boundary of its machine. A read recorded and not released yet, or
	 * released already, is not recorded again. Another view's reads come from its machine's log (#takeReads). */
	#served(view: View, entry: Omit<ReadLogEntry, "seq">): void {
		if (view.access?.machine === undefined) return;
		if (view.closed) throw new ProtocolError(ErrorCode.viewClosed, view.closed);
		let log = view.logs.get(SERVED);
		if (!log) {
			log = { taken: 0, released: 0, unreleased: [], keys: new Set(), done: new Set() };
			view.logs.set(SERVED, log);
		}
		const read = this.#releasedRead(view, { seq: 0, ...entry });
		const key = readKey(read);
		if (log.keys.has(key) || log.done?.has(key)) return;
		log.taken++;
		log.keys.add(key);
		log.unreleased.push({ seq: log.taken, read, key });
		view.heard = undefined;
	}

	/** Releases the reads the view's machine logged that the core does not have yet (core §6), the view as the actor, at
	 * most RELEASE_READS at a time. A release with no answer, or refused, is asked again first, the same (the core
	 * replays it). A member-held view's release is refused, as such a view records no reads: they count as released.
	 * The answer: every read released, none yet, or the core's refusal. One release of a view at a time: a coding
	 * machine's boundary releases every view of its machine (#releaseMachine), beside the view's own boundary. */
	#releaseReads(view: View): Promise<Released> {
		const next = view.releaseTurn.catch(() => undefined).then(() => this.#releaseNow(view));
		view.releaseTurn = next;
		return next;
	}

	async #releaseNow(view: View): Promise<Released> {
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
						if (error.said === VIEW_ENDED) this.#close(view, VIEW_ENDED);
						if (error.said !== MEMBER_HELD_READS) return error.reason;
						answered = true;
					} else this.#log(`folder-service: ${view.key}: release not answered: ${(error as Error).message}`);
				}
			}
			if (!answered) return "unanswered";
			view.releasing = undefined;
			for (const [log, upTo] of release.upTo) {
				const after = log.unreleased.findIndex((entry) => entry.seq > upTo);
				for (const entry of log.unreleased.splice(0, after === -1 ? log.unreleased.length : after)) {
					log.keys.delete(entry.key);
					if (log.done && log.done.size >= SERVED_RELEASED_KEPT) log.done.clear();
					log.done?.add(entry.key);
				}
				// A read taken since that the log held unreleased was released with it.
				log.released = log.unreleased.length === 0 ? log.taken : Math.max(log.released, upTo);
			}
		}
	}

	/** The open views of a coding machine (F3 5c). */
	#machineViews(machine: string): View[] {
		return [...this.#views.values()].filter(
			(view) => !view.closed && view.access?.machine === machine && this.#views.get(view.key) === view,
		);
	}

	/** Releases every read a coding machine was served, under each of its views, at once (the plan's rules 1 and 3):
	 * a refusal of any is the answer (the first, in the views' order), else none yet if any has none. A view that closed
	 * meanwhile releases nothing more: its reads not released made the machine lost (#forgetReads). */
	async #releaseMachine(machine: string): Promise<Released> {
		const answers = await Promise.all(
			this.#machineViews(machine).map((view) =>
				this.#releaseReads(view).catch((error: unknown): Released => {
					if (error instanceof ProtocolError) return "released";
					throw error;
				}),
			),
		);
		return (
			answers.find((answer) => answer !== "released" && answer !== "unanswered") ??
			(answers.includes("unanswered") ? "unanswered" : "released")
		);
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
		this.#close(view, "The command's final change set was published", true);
		return { commitId: answer.commitId, seq: answer.seq, paths: [...entries, ...outcomes], closed: true };
	}

	/** Stages every closed, changed file not staged yet (or, in a coding view, not checked against `secrets` yet), a few
	 * at a time. */
	async #stageAll(view: View, secrets: SecretSet | undefined): Promise<void> {
		const nodes = [...(view.pending?.nodes() ?? [])].filter(
			(entry): entry is [string, PendingFile] =>
				entry[1].kind === "file" &&
				entry[1].open === 0 &&
				!(this.#stagedNow(view, entry[1], entry[0]) && this.#stagedFor(entry[1], secrets, entry[0])) &&
				!(secrets && this.#refusalOf(entry[1], secrets, true)),
		);
		for (let i = 0; i < nodes.length; i += STAGING_PARALLEL)
			await Promise.all(
				nodes.slice(i, i + STAGING_PARALLEL).map(([path, node]) =>
					this.#stage(view, node, path, secrets).catch((error: unknown) => {
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
				if (error instanceof CoreRefusal) {
					// A coding machine's read set holding a read no longer readable moves the machine (F3 5c, the plan's rule
					// 4): `unreadable`, as a release refused for it is. Another view's stays `denied` (4c).
					const reason =
						view.access?.machine !== undefined && error.said === READ_UNREADABLE ? "unreadable" : error.reason;
					return {
						commitId: "",
						seq: null,
						units: units.map((_, i) => ({
							unit: i + 1,
							outcome: "refused",
							reason,
							version: null,
						})),
						refused: reason,
						said: error.said,
					};
				}
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
			// A link the receipt keeps is reported with its target.
			const targets = copied.has(i) ? linksOf(planned.unit) : undefined;
			for (const path of planned.paths) {
				if (kept) keep.add(path);
				if (outcome?.outcome === "saved") saved.add(path);
				const target = targets?.get(path);
				entries.push({
					path,
					outcome: outcome?.outcome ?? "not_applied",
					...(outcome?.reason ? { reason: reasonOf(outcome.reason, outcome.problem) } : {}),
					...(copied.has(i) ? { receipt: answer.commitId } : {}),
					...(target !== undefined ? { target } : {}),
					...(kept ? { kept: true } : {}),
				});
			}
		});
		return { entries, keep, saved };
	}

	/** The units whose conflict kept this view's bytes on the receipt: every file and link of the unit is among the
	 * copies the core kept for the commit (P17 keeps them only when the unit's bytes would have passed). A conflict
	 * whose bytes were not kept stays pending, and the next boundary tries it again. */
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
			const mine = copies.filter((c) => c.unit === i + 1);
			const kept = new Set(mine.flatMap((c) => (c.kind === "file" ? [c.manifestSha256] : [])));
			const keptLinks = new Set(mine.flatMap((c) => (c.kind === "symlink" ? [c.target] : [])));
			if (
				files.every((file) => kept.has(file.manifestSha256)) &&
				[...linksOf(unit).values()].every((target) => keptLinks.has(target))
			)
				copied.add(i);
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
			const op = planned.unit.op;
			if ((op === "write" || op === "symlink") && outcome?.outcome === "saved" && outcome.version)
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
						if (change.op === "move_in" && change.kind !== "folder" && change.priorVersion)
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
		for (const [path, version] of written) view.pending?.publishedAt(path, version);
		for (const [path, { version }] of moved) view.pending?.publishedAt(path, version);
		this.#settleNodes(
			view,
			settlement.keep,
			settlement.plan.units.flatMap((u) => u.paths),
			settlement.saved,
		);
	}

	/** Keeps the time the pending file at `path` shows for the version `live` its publish gave it (`times`). */
	#keepTime(view: View, path: string, live: string): void {
		const node = view.pending?.nodes().get(path);
		if (node?.kind === "file") view.times.set(path, { version: live, mtimeMs: node.mtimeMs });
	}

	/** Notes that the version `made` the machine was shown at `path` while pending was published as `live` (#base). */
	#alias(view: View, path: string, made: string, live: string): void {
		const aliases = (view.published.get(path) ?? []).filter((p) => p.made !== made);
		aliases.push({ made, live });
		if (aliases.length > SUPERSEDED_PER_PATH + 1) aliases.shift();
		view.published.set(path, aliases);
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
		const alias = (path: string, made: string, live: string): void => this.#alias(view, path, made, live);
		for (const [path, made] of settlement.made) {
			const live = settlement.saved.has(path) ? written.get(path) : undefined;
			if (live) {
				alias(path, made, live);
				this.#keepTime(view, path, live);
			}
		}
		for (const [path, { version }] of moved) this.#keepTime(view, path, version);
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
		const own = this.#ownFolders(view, before);
		pending.settle(new Set([...keepAll].filter((p) => pending.nodes().has(p))));
		this.#liveFolders(view, own);
		// What still waits keeps its credits, to go with it when it is published again (F3 6b): a new file or link kept
		// keeps the removal it holds, and so that one's.
		view.credit.prune(pending);
		if (pending.empty && pending.drafts().length === 0) view.intents.clear();
		// Nothing left unsaved (a lock or swap file a program still holds is none): the next renewal tells the core so,
		// and the desktop's seat is free again.
		if (!pending.unsaved) view.unsavedSince = undefined;
		this.#push(view, this.#shown(view, [...new Set([...paths, ...before])], own));
	}

	/** Renews the intents that root the bytes of pending files, each after 10 minutes. One the core lets lapse is
	 * replaced: a chunk is held again under a new intent (put again from the share if the actor no longer holds it), and
	 * a file whose sealed intent lapsed is staged again at the next boundary. A renewal that could not reach the core is
	 * tried again next round. The intents of files no longer pending are let go. Exposed for tests. */
	async renewIntents(): Promise<void> {
		for (const view of [...this.#views.values()]) {
			if (view.moving || view.closed) continue;
			const next = view.intentWork.catch(() => undefined).then(() => this.#renewIntentsFor(view));
			view.intentWork = next;
			await next;
		}
	}

	async #renewIntentsFor(view: View): Promise<void> {
		const now = this.#now();
		const pending = view.pending;
		if (!pending || view.closed || view.moving) return;
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
				// Every file that took that staging (a hard link's new name too) is staged again.
				if (held.staged)
					for (const node of [held.node, ...pending.nodes().values()])
						if (node.kind === "file" && node.staged?.file === held.staged) node.staged = undefined;
				if (held.chunk) await this.#holdAgain(view, id, held);
			}
		}
	}

	/** The chunks and staged files (by manifest) the view's pending bytes still need: each pending file's as it is and as
	 * an abandoned handle would restore it, an open draft's, chunks on their way to the gateway, and the files of a
	 * boundary that has not settled (asked again, or waiting for the feed). */
	#neededBytes(view: View, pending: PendingView): { chunks: Set<string>; files: Set<string> } {
		const chunks = new Set<string>();
		const files = new Set<string>();
		for (const node of [...pending.nodes().values(), ...pending.drafts()]) {
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
