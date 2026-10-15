import { isUuid, parseRecord, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { ObjectDependency, ObjectDependencyError } from "../dependency.ts";
import { supabaseRequestHeaders } from "../supabase-headers.ts";
import { nodeRequest, type Transport } from "./https-request.ts";

/** Who a mount reads as. A step 1 operator mount reads as a member or the platform; a machine view (step 2 on) as
 * the core's view actor, whose pass the folder service holds. */
export type FolderActor =
	| { readonly kind: "member"; readonly userId: string }
	| { readonly kind: "platform" }
	| { readonly kind: "view"; readonly viewId: string; readonly pass: string };

/** Who a change set is committed as. A command view's last one says `final` (F3 4b, migration 20260930183000): the core
 * closes the view with it, whether it saved anything or not. */
export type CommitActor = FolderActor | (Extract<FolderActor, { kind: "view" }> & { readonly final: true });

/** The authority an agent's listing names for an entry (C1b-2 `qorpera_folder_read_receipt`). A run box's mount
 * logs it with each read and the run's native host releases it, so the core files the read without checking the path
 * again; a stale or missing one only costs the core that check. Members and the platform get none. */
export interface CoreReceipt {
	readonly resourceId: string;
	readonly resourceRevision: number;
	readonly grantId: string | null;
	readonly grantRevision: number | null;
}

/** An entry as `qorpera_folder_entry_json` gives it (20260928120000). */
export interface CoreEntry {
	readonly path: string;
	readonly kind: "file" | "folder";
	/** The core's version id of the path (a uuid). */
	readonly version: string;
	readonly manifestSha256?: string;
	readonly fileSha256?: string;
	readonly bytes?: number;
	readonly mediaType?: string;
	readonly executable?: boolean;
	readonly updatedAt?: string;
	/** Only in an agent's listing (a run box's view). */
	readonly authority?: CoreReceipt;
}

export interface ListPage {
	readonly asOfSeq: number;
	readonly entries: readonly CoreEntry[];
	readonly next: string | null;
}

/** One change of a change set on the feed (20260928237000). A move's arrival names the version the path had where it
 * came from (`priorVersion`), when the actor may read that path too. */
export interface FeedChange extends CoreEntry {
	readonly op: "write" | "mkdir" | "delete" | "move_out" | "move_in" | "copy";
	readonly priorVersion?: string;
}

export type FeedEvent =
	| { readonly seq: number; readonly kind: "authority" }
	| { readonly seq: number; readonly kind: "change_set"; readonly changes: readonly FeedChange[] };

export interface FeedCursor {
	readonly unitNo: number;
	readonly version: string;
}

export interface FeedPage {
	readonly asOfSeq: number;
	readonly resync: boolean;
	readonly events: readonly FeedEvent[];
	/** Where to continue; null on a resync answer. */
	readonly next: { readonly afterSeq: number; readonly cursor: FeedCursor | null } | null;
	readonly more: boolean;
}

export interface FolderCore {
	/** One page of the actor's whole tree, in the core's key order, after the path `after`. */
	list(environmentId: string, actor: FolderActor, after: string | null, signal?: AbortSignal): Promise<ListPage>;
	feed(
		environmentId: string,
		actor: FolderActor,
		afterSeq: number,
		cursor: FeedCursor | null,
		signal?: AbortSignal,
	): Promise<FeedPage>;
	/** The change number of each company folder named (missing ones are left out). */
	clocks(environmentIds: readonly string[], signal?: AbortSignal): Promise<Map<string, number>>;
	/** The company's storage profile, through the core's download check of one object the actor may read. The check
	 * also refuses a company being deleted, for every actor. */
	objectProfile(environmentId: string, actor: FolderActor, sha256: string, signal?: AbortSignal): Promise<string>;
	/** Extends a machine view's lease (120 s) or learns that it closed (C1b-3a `qorpera_folder_view_renew`). An open
	 * answer says what the view is and which machine it belongs to (F3 4a). `unsavedSince`: since when the view has
	 * had changes not published (an ISO time), or null; a desktop's keeps its seat in use. */
	renewView(viewId: string, pass: string, unsavedSince: string | null, signal?: AbortSignal): Promise<ViewRenewal>;
	/** Opens an upload intent for a manifest (C1D §3.1): which of its objects the actor holds already. */
	openUpload(environmentId: string, actor: FolderActor, manifest: string, signal?: AbortSignal): Promise<UploadOpen>;
	/** The company an intent's object goes to (C1D §3.2's authorization, a plain read): the storage profile, for a view
	 * with no file to learn it from yet. */
	uploadProfile(
		environmentId: string,
		actor: FolderActor,
		intentId: string,
		sha256: string,
		bytes: number,
		signal?: AbortSignal,
	): Promise<string>;
	/** Seals an intent once all its objects are held or put (C1D §3.4). */
	sealUpload(environmentId: string, actor: FolderActor, intentId: string, signal?: AbortSignal): Promise<UploadSeal>;
	/** Extends an open or sealed intent (C1D §3.5); returns its new expiry. */
	renewUpload(environmentId: string, actor: FolderActor, intentId: string, signal?: AbortSignal): Promise<string>;
	/** One change set (core §3). A final one may be empty. */
	commit(
		environmentId: string,
		actor: CommitActor,
		operationKey: string,
		units: readonly unknown[],
		signal?: AbortSignal,
	): Promise<CommitAnswer>;
	/** The files one commit kept as conflict copies on its receipt (P17), by unit and file. */
	conflictCopies(environmentId: string, commitId: string, signal?: AbortSignal): Promise<readonly ConflictCopy[]>;
	/** Releases a view's reads (core §6, at most 10,000): the core files them in the view's read set, and in its run's
	 * when it acts for one. The same id with the same reads replays; with other reads it is refused. */
	releaseReads(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		releaseId: string,
		reads: readonly ReleasedRead[],
		signal?: AbortSignal,
	): Promise<ReleaseAnswer>;
	/** Takes the lease on one shared git file for a view creating its lock file `<path>.lock` (5b, core §6): the view
	 * holds it until it renames the lock onto the file (`gitPublish`) or removes it (`gitLeaseRelease`). */
	gitLeaseTake(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		path: string,
		signal?: AbortSignal,
	): Promise<GitLease>;
	/** Ends a lease: with no units it publishes nothing; with deletes of the file and its reflog it publishes those. */
	gitLeaseRelease(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		leaseId: string,
		units: readonly unknown[] | null,
		signal?: AbortSignal,
	): Promise<GitPublish | null>;
	/** Drops every lease the view holds, as at a boundary; answers the files whose leases it dropped. */
	gitLeasesDrop(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		signal?: AbortSignal,
	): Promise<readonly string[]>;
	/** Publishes a lease's file and reflog with the objects they name, whole or not at all; a publish ends the lease. */
	gitPublish(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		leaseId: string,
		operationKey: string,
		units: readonly unknown[],
		signal?: AbortSignal,
	): Promise<GitPublish>;
}

/** One file a commit kept on its receipt: the unit (1-based, as the answer numbers them) and the file in it. */
export interface ConflictCopy {
	readonly unit: number;
	readonly file: number;
	readonly path: string;
	readonly manifestSha256: string;
}

export interface UploadOpen {
	readonly intentId: string;
	/** The objects the actor holds already: it puts only the others. */
	readonly present: readonly string[];
}

export type UploadSeal =
	| {
			readonly state: "sealed";
			readonly file: {
				readonly manifestSha256: string;
				readonly fileSha256: string;
				readonly bytes: number;
				readonly mediaType: string;
				readonly executable: boolean;
			};
	  }
	| { readonly state: "incomplete"; readonly missing: readonly string[] };

export type CommitOutcomeKind = "saved" | "conflict" | "refused" | "denied" | "waiting_for_review";

/** One unit's outcome, in the change set's order. */
export interface CommitOutcome {
	readonly unit: number;
	readonly outcome: CommitOutcomeKind;
	readonly reason: string | null;
	readonly version: string | null;
}

export interface CommitAnswer {
	readonly commitId: string;
	/** Null when nothing saved. */
	readonly seq: number | null;
	readonly units: readonly CommitOutcome[];
}

const OUTCOMES = new Set(["saved", "conflict", "refused", "denied", "waiting_for_review"]);

/** The output hash a view's release names: none (the core wants 64 hex digits; a run's release names the text it
 * showed). */
const NO_OUTPUT = "0".repeat(64);

function hashOf(value: unknown, what: string): string {
	if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) invalidAnswer(what);
	return value;
}

export function parseUploadOpen(value: unknown): UploadOpen {
	const answer = answerRecord(value, "upload");
	if (answer.schema !== "qorpera.folder-upload/v1" || !isUuid(answer.intentId) || !Array.isArray(answer.present))
		invalidAnswer("upload");
	return { intentId: answer.intentId as string, present: answer.present.map((h) => hashOf(h, "present object")) };
}

export function parseUploadSeal(value: unknown): UploadSeal {
	const answer = answerRecord(value, "seal");
	if (answer.schema !== "qorpera.folder-seal/v1") invalidAnswer("seal");
	if (answer.state === "incomplete" && Array.isArray(answer.missing))
		return { state: "incomplete", missing: answer.missing.map((h) => hashOf(h, "missing object")) };
	if (answer.state !== "sealed") invalidAnswer("seal state");
	const f = answerRecord(answer.file, "sealed file");
	if (
		typeof f.mediaType !== "string" ||
		typeof f.executable !== "boolean" ||
		typeof f.bytes !== "number" ||
		!Number.isSafeInteger(f.bytes) ||
		f.bytes < 0
	)
		invalidAnswer("sealed file");
	return {
		state: "sealed",
		file: {
			manifestSha256: hashOf(f.manifestSha256, "sealed manifest"),
			fileSha256: hashOf(f.fileSha256, "sealed file hash"),
			bytes: f.bytes,
			mediaType: f.mediaType,
			executable: f.executable,
		},
	};
}

export function parseCommitAnswer(value: unknown, units: number): CommitAnswer {
	const answer = answerRecord(value, "commit");
	if (answer.schema !== "qorpera.folder-commit/v1" || !isUuid(answer.commitId) || !Array.isArray(answer.units))
		invalidAnswer("commit");
	if (answer.units.length !== units) invalidAnswer("commit units");
	return {
		commitId: answer.commitId as string,
		seq: answer.seq === null || answer.seq === undefined ? null : seqOf(answer.seq, "commit seq"),
		units: answer.units.map((value, index) => {
			const u = answerRecord(value, "commit unit");
			if (u.unit !== index + 1 || typeof u.outcome !== "string" || !OUTCOMES.has(u.outcome))
				invalidAnswer("commit unit");
			if (u.reason !== undefined && typeof u.reason !== "string") invalidAnswer("commit reason");
			return {
				unit: index + 1,
				outcome: u.outcome as CommitOutcomeKind,
				reason: (u.reason as string | undefined) ?? null,
				version: u.version === undefined || u.version === null ? null : versionOf(u.version),
			};
		}),
	};
}

export function parseConflictCopies(value: unknown): ConflictCopy[] {
	if (!Array.isArray(value)) invalidAnswer("conflict copies");
	return value.map((item) => {
		const c = answerRecord(item, "conflict copy");
		const count = (n: unknown): number => {
			if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) invalidAnswer("conflict copy");
			return n;
		};
		if (typeof c.path !== "string") invalidAnswer("conflict copy");
		return {
			unit: count(c.unit),
			file: count(c.file),
			path: c.path,
			manifestSha256: hashOf(c.manifestSha256, "conflict copy manifest"),
		};
	});
}

/** An open view's `kind` (`run_box`, `computer_desktop`, `coding_session`, …) and `machineId`: the machine allocation
 * it was opened on (migration 20260930104000), null for a run box. */
export type ViewRenewal =
	| {
			readonly state: "open";
			readonly leaseUntil: string;
			readonly kind: string;
			readonly machineId: string | null;
	  }
	| { readonly state: "closed"; readonly reason: "closed" | "superseded" | "ended" | "expired" };

export function parseViewRenewal(value: unknown): ViewRenewal {
	const answer = answerRecord(value, "view renewal");
	if (answer.schema !== "qorpera.folder-view-renew/v1") invalidAnswer("view renewal");
	if (
		answer.state === "open" &&
		typeof answer.leaseUntil === "string" &&
		!Number.isNaN(Date.parse(answer.leaseUntil)) &&
		typeof answer.kind === "string" &&
		answer.kind !== "" &&
		(answer.machineId === null || (typeof answer.machineId === "string" && isUuid(answer.machineId)))
	)
		return { state: "open", leaseUntil: answer.leaseUntil, kind: answer.kind, machineId: answer.machineId };
	if (
		answer.state === "closed" &&
		(answer.reason === "closed" ||
			answer.reason === "superseded" ||
			answer.reason === "ended" ||
			answer.reason === "expired")
	)
		return { state: "closed", reason: answer.reason };
	invalidAnswer("view renewal");
}

/** The core refused: `denied` (42501, the actor may not read this any more), `unreadable` (42501, a read being
 * released is no longer readable: the view's saves wait until its reads are released, which never happens now),
 * `run_ended` (42501, the run the view acts for has ended), `stopped` (55000, the company is paused or being deleted),
 * `invalid` (the request or the company does not fit: 22023, 0A000, P0002). `said` keeps the core's message. The
 * database answered, so the dependency circuit stays closed. */
export class CoreRefusal extends ObjectDependencyError {
	readonly reason: "denied" | "unreadable" | "run_ended" | "stopped" | "invalid";
	readonly said: string | undefined;
	constructor(reason: CoreRefusal["reason"], said?: string) {
		super(reason === "stopped" ? 423 : reason === "invalid" ? 400 : 403);
		this.name = "CoreRefusal";
		this.message = `Folder core refused: ${reason}`;
		this.reason = reason;
		this.said = said;
	}

	/** 42501, for whichever reason: the actor may not do this (any more). */
	get forbidden(): boolean {
		return this.status === 403;
	}
}

/** The core's refusal of a member-held view's release (20260928259230): such a view records no reads. */
export const MEMBER_HELD_READS = "A member-held view records no reads";

/** The core's refusal of a command view's save after its command ended (20260930183000): only the final one saves
 * now, so the view waits for it. */
export const COMMAND_ENDED = "Folder view command has ended";

/** One read a view releases, as `qorpera_folder_record_release` takes it: the path, the version read (null for a
 * folder's listing), and the receipt it was read under. */
export interface ReleasedRead {
	readonly path: string;
	readonly version: string | null;
	readonly authority: CoreReceipt;
}

export interface ReleaseAnswer {
	readonly releaseId: string;
	/** True when the core had filed this release already (the same id and reads). */
	readonly replay: boolean;
}

export function parseReleaseAnswer(value: unknown, releaseId: string, reads: number): ReleaseAnswer {
	const answer = answerRecord(value, "release");
	if (
		answer.schema !== "qorpera.folder-release/v1" ||
		answer.releaseId !== releaseId ||
		answer.reads !== reads ||
		typeof answer.replay !== "boolean"
	)
		invalidAnswer("release");
	return { releaseId, replay: answer.replay };
}

/** The versions a git lease's holder writes over (5b): the file, its reflog and `packed-refs`, each null when no such
 * file is live. */
export interface GitVersions {
	readonly file: string | null;
	readonly reflog: string | null;
	readonly packedRefs: string | null;
}

/** A lease on one shared git file (5b `qorpera_folder_git_lease_take`, core §6's lock protocol): held by this view,
 * busy while another view (or the platform's maintenance) holds it, or refused for the path. */
export type GitLease =
	| { readonly state: "held"; readonly leaseId: string; readonly path: string; readonly versions: GitVersions }
	| { readonly state: "busy"; readonly leaseUntil: string; readonly reason: string | null }
	| { readonly state: "refused"; readonly reason: string };

/** A git publish: one change set, saved whole or not at all. */
export interface GitPublish extends CommitAnswer {
	readonly published: boolean;
}

export function parseGitLease(value: unknown, path: string): GitLease {
	const answer = answerRecord(value, "git lease");
	if (answer.schema !== "qorpera.folder-git-lease/v1") invalidAnswer("git lease");
	if (answer.state === "held") {
		if (typeof answer.leaseId !== "string" || answer.leaseId === "" || answer.path !== path)
			invalidAnswer("git lease");
		const versions = answerRecord(answer.versions, "git lease versions");
		return {
			state: "held",
			leaseId: answer.leaseId,
			path,
			versions: {
				file: liveVersionOf(versions.file),
				reflog: liveVersionOf(versions.reflog),
				packedRefs: liveVersionOf(versions.packedRefs),
			},
		};
	}
	if (answer.state === "busy") {
		const reason = answer.reason ?? null;
		if (typeof answer.leaseUntil !== "string" || (reason !== null && typeof reason !== "string"))
			invalidAnswer("git lease busy");
		return { state: "busy", leaseUntil: answer.leaseUntil, reason };
	}
	if (answer.state === "refused" && typeof answer.reason === "string")
		return { state: "refused", reason: answer.reason };
	invalidAnswer("git lease state");
}

export function parseGitPublish(value: unknown, units: number): GitPublish {
	const answer = parseCommitAnswer(value, units);
	const published = answerRecord(value, "git publish").published;
	if (typeof published !== "boolean") invalidAnswer("git publish");
	return { ...answer, published };
}

export function parseDroppedLeases(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) invalidAnswer("dropped git leases");
	return value as string[];
}

/** The core's answer did not have the shape this service knows. Counted as an unavailable dependency. */
export class CoreAnswerError extends ObjectDependencyError {
	constructor(what: string) {
		super(503);
		this.name = "CoreAnswerError";
		this.message = `Folder core answer is invalid: ${what}`;
	}
}

const OPS = new Set(["write", "mkdir", "delete", "move_out", "move_in", "copy"]);

function invalidAnswer(what: string): never {
	throw new CoreAnswerError(what);
}

function answerRecord(value: unknown, what: string): Record<string, unknown> {
	try {
		return parseRecord(value, what);
	} catch {
		invalidAnswer(what);
	}
}

/** A version id, as the core makes them (`gen_random_uuid()`). */
function versionOf(value: unknown): string {
	if (typeof value !== "string" || !isUuid(value)) invalidAnswer("version");
	return value;
}

function liveVersionOf(value: unknown): string | null {
	return value === null || value === undefined ? null : versionOf(value);
}

function seqOf(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidAnswer(what);
	return value;
}

/** A receipt, checked whole: the core gives exactly these four, the grant's two together (a rules path has none). */
function receiptOf(value: unknown): CoreReceipt {
	const r = answerRecord(value, "receipt");
	const keys = Object.keys(r).sort().join();
	const revision = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
	if (
		keys !== "grantId,grantRevision,resourceId,resourceRevision" ||
		!isUuid(r.resourceId) ||
		!revision(r.resourceRevision) ||
		(r.grantId === null ? r.grantRevision !== null : !isUuid(r.grantId) || !revision(r.grantRevision))
	)
		invalidAnswer("receipt");
	return {
		resourceId: r.resourceId as string,
		resourceRevision: r.resourceRevision as number,
		grantId: r.grantId as string | null,
		grantRevision: r.grantRevision as number | null,
	};
}

/** An entry or a feed change, checked field by field; unknown fields (seq, priorVersion) are dropped. A removal on the
 * feed names no content. An agent's listing gives each entry its receipt (null where the path has no resource). */
function entryOf(value: unknown, removal = false): CoreEntry {
	const e = answerRecord(value, "entry");
	if (typeof e.path !== "string" || e.path === "" || (e.kind !== "file" && e.kind !== "folder"))
		invalidAnswer("entry");
	const out: {
		path: string;
		kind: "file" | "folder";
		version: string;
		manifestSha256?: string;
		fileSha256?: string;
		bytes?: number;
		mediaType?: string;
		executable?: boolean;
		updatedAt?: string;
		authority?: CoreReceipt;
	} = { path: e.path, kind: e.kind, version: versionOf(e.version) };
	if (e.authority !== undefined && e.authority !== null) out.authority = receiptOf(e.authority);
	if (e.manifestSha256 !== undefined) {
		if (typeof e.manifestSha256 !== "string" || !SHA256_HEX_PATTERN.test(e.manifestSha256)) invalidAnswer("manifest");
		out.manifestSha256 = e.manifestSha256;
	}
	if (e.fileSha256 !== undefined) {
		if (typeof e.fileSha256 !== "string" || !SHA256_HEX_PATTERN.test(e.fileSha256)) invalidAnswer("file hash");
		out.fileSha256 = e.fileSha256;
	}
	if (e.bytes !== undefined) out.bytes = seqOf(e.bytes, "bytes");
	if (e.mediaType !== undefined) {
		if (typeof e.mediaType !== "string") invalidAnswer("media type");
		out.mediaType = e.mediaType;
	}
	if (e.executable !== undefined) {
		if (typeof e.executable !== "boolean") invalidAnswer("executable");
		out.executable = e.executable;
	}
	if (e.updatedAt !== undefined) {
		if (typeof e.updatedAt !== "string" || Number.isNaN(Date.parse(e.updatedAt))) invalidAnswer("time");
		out.updatedAt = e.updatedAt;
	}
	if (!removal && out.kind === "file" && (out.manifestSha256 === undefined || out.bytes === undefined))
		invalidAnswer("file entry");
	return out;
}

export function parseListPage(value: unknown): ListPage {
	const page = answerRecord(value, "list");
	if (page.schema !== "qorpera.folder-list/v1" || !Array.isArray(page.entries)) invalidAnswer("list");
	if (page.next !== null && page.next !== undefined && typeof page.next !== "string") invalidAnswer("list next");
	return {
		asOfSeq: seqOf(page.asOfSeq, "asOfSeq"),
		entries: page.entries.map((entry) => entryOf(entry)),
		next: typeof page.next === "string" ? page.next : null,
	};
}

export function parseFeedPage(value: unknown): FeedPage {
	const page = answerRecord(value, "feed");
	if (page.schema !== "qorpera.folder-feed/v1" || !Array.isArray(page.events) || typeof page.more !== "boolean")
		invalidAnswer("feed");
	const resync = page.resync === true;
	let next: FeedPage["next"] = null;
	if (!resync) {
		const n = answerRecord(page.next, "feed next");
		let cursor: FeedCursor | null = null;
		if (n.cursor !== null && n.cursor !== undefined) {
			const c = answerRecord(n.cursor, "feed cursor");
			cursor = { unitNo: seqOf(c.unitNo, "cursor unit"), version: versionOf(c.version) };
		}
		next = { afterSeq: seqOf(n.afterSeq, "next afterSeq"), cursor };
	}
	const events: FeedEvent[] = page.events.map((value) => {
		const event = answerRecord(value, "feed event");
		const seq = seqOf(event.seq, "event seq");
		if (event.kind === "authority") return { seq, kind: "authority" };
		if (event.kind !== "change_set" || !Array.isArray(event.changes)) invalidAnswer("event kind");
		return {
			seq,
			kind: "change_set",
			changes: event.changes.map((c) => {
				const change = answerRecord(c, "change");
				if (typeof change.op !== "string" || !OPS.has(change.op)) invalidAnswer("op");
				const removal = change.op === "delete" || change.op === "move_out";
				const entry = entryOf(
					removal ? { path: change.path, kind: change.kind, version: change.version } : c,
					removal,
				);
				const prior = change.op === "move_in" ? change.priorVersion : undefined;
				return {
					...entry,
					op: change.op as FeedChange["op"],
					...(prior !== undefined && prior !== null ? { priorVersion: versionOf(prior) } : {}),
				};
			}),
		};
	});
	return {
		asOfSeq: seqOf(page.asOfSeq, "asOfSeq"),
		resync,
		events,
		next,
		more: page.more,
	};
}

function actorJson(actor: FolderActor): Record<string, string> {
	switch (actor.kind) {
		case "member":
			return { kind: "member", userId: actor.userId };
		case "platform":
			return { kind: "platform" };
		case "view":
			return { kind: "view", viewId: actor.viewId, pass: actor.pass };
	}
}

interface SupabaseFolderCoreOptions {
	readonly projectUrl: string;
	readonly secretKey: string;
	readonly transport?: Transport;
	readonly requestTimeoutMs?: number;
}

/** The folder core over PostgREST, with the service credential: list, feed, the clock, the download check for the
 * storage profile, view renewals, and (step 3) staging and the commit. */
export class SupabaseFolderCore implements FolderCore {
	readonly #url: string;
	readonly #key: string;
	readonly #transport: Transport;
	readonly #api: ObjectDependency;

	constructor(options: SupabaseFolderCoreOptions) {
		const url = new URL(options.projectUrl);
		if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username)
			throw new Error("Folder core requires an exact HTTPS origin");
		if (!options.secretKey || options.secretKey.length > 8192 || /[\0\r\n]/.test(options.secretKey))
			throw new Error("Folder core credential is invalid");
		this.#url = url.origin;
		this.#key = options.secretKey;
		this.#transport = options.transport ?? nodeRequest;
		this.#api = new ObjectDependency(options.requestTimeoutMs ?? 15_000, 2_000);
	}

	async list(environmentId: string, actor: FolderActor, after: string | null, signal?: AbortSignal) {
		return parseListPage(
			await this.#rpc(
				"qorpera_folder_list",
				{
					p_environment_id: environmentId,
					p_actor: actorJson(actor),
					p_parent: "",
					p_after: after,
					p_limit: 1000,
					p_recursive: true,
				},
				signal,
			),
		);
	}

	async feed(
		environmentId: string,
		actor: FolderActor,
		afterSeq: number,
		cursor: FeedCursor | null,
		signal?: AbortSignal,
	) {
		return parseFeedPage(
			await this.#rpc(
				"qorpera_folder_feed",
				{
					p_environment_id: environmentId,
					p_actor: actorJson(actor),
					p_after_seq: afterSeq,
					p_limit: 1000,
					p_cursor: cursor,
				},
				signal,
			),
		);
	}

	async clocks(environmentIds: readonly string[], signal?: AbortSignal): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		if (environmentIds.length === 0) return out;
		if (environmentIds.some((id) => !isUuid(id))) throw new Error("Folder clock request is invalid");
		const query = `select=environment_id,last_seq&environment_id=in.(${environmentIds.join(",")})`;
		const rows = await this.#request(`/rest/v1/qorpera_folder_clocks?${query}`, { method: "GET" }, signal);
		if (!Array.isArray(rows)) invalidAnswer("clocks");
		for (const row of rows) {
			const r = answerRecord(row, "clock");
			if (typeof r.environment_id !== "string" || !isUuid(r.environment_id)) invalidAnswer("clock id");
			out.set(r.environment_id, seqOf(r.last_seq, "clock seq"));
		}
		return out;
	}

	async objectProfile(environmentId: string, actor: FolderActor, sha256: string, signal?: AbortSignal) {
		const answer = answerRecord(
			await this.#rpc(
				"qorpera_folder_authorize_object_download",
				{ p_environment_id: environmentId, p_actor: actorJson(actor), p_sha256: sha256 },
				signal,
			),
			"download check",
		);
		if (
			answer.schema !== "qorpera.folder-object-download/v1" ||
			typeof answer.profileId !== "string" ||
			!isUuid(answer.profileId)
		)
			invalidAnswer("download check");
		return answer.profileId;
	}

	async renewView(
		viewId: string,
		pass: string,
		unsavedSince: string | null,
		signal?: AbortSignal,
	): Promise<ViewRenewal> {
		return parseViewRenewal(
			await this.#rpc(
				"qorpera_folder_view_renew",
				{ p_view_id: viewId, p_pass: pass, p_unsaved_since: unsavedSince },
				signal,
			),
		);
	}

	async openUpload(environmentId: string, actor: FolderActor, manifest: string, signal?: AbortSignal) {
		return parseUploadOpen(
			await this.#rpc(
				"qorpera_folder_open_upload",
				{ p_environment_id: environmentId, p_actor: actorJson(actor), p_manifest: manifest },
				signal,
			),
		);
	}

	async uploadProfile(
		environmentId: string,
		actor: FolderActor,
		intentId: string,
		sha256: string,
		bytes: number,
		signal?: AbortSignal,
	) {
		const answer = answerRecord(
			await this.#rpc(
				"qorpera_folder_authorize_object_upload",
				{
					p_environment_id: environmentId,
					p_actor: actorJson(actor),
					p_intent: intentId,
					p_sha256: sha256,
					p_bytes: bytes,
				},
				signal,
			),
			"upload check",
		);
		if (answer.schema !== "qorpera.folder-object-upload/v1" || !isUuid(answer.profileId))
			invalidAnswer("upload check");
		return answer.profileId as string;
	}

	async sealUpload(environmentId: string, actor: FolderActor, intentId: string, signal?: AbortSignal) {
		return parseUploadSeal(
			await this.#rpc(
				"qorpera_folder_seal_upload",
				{ p_environment_id: environmentId, p_actor: actorJson(actor), p_intent: intentId },
				signal,
			),
		);
	}

	async renewUpload(environmentId: string, actor: FolderActor, intentId: string, signal?: AbortSignal) {
		const answer = answerRecord(
			await this.#rpc(
				"qorpera_folder_renew_upload",
				{ p_environment_id: environmentId, p_actor: actorJson(actor), p_intent: intentId },
				signal,
			),
			"upload renewal",
		);
		if (
			answer.schema !== "qorpera.folder-upload-renew/v1" ||
			answer.intentId !== intentId ||
			typeof answer.expiresAt !== "string" ||
			Number.isNaN(Date.parse(answer.expiresAt))
		)
			invalidAnswer("upload renewal");
		return answer.expiresAt;
	}

	async commit(
		environmentId: string,
		actor: CommitActor,
		operationKey: string,
		units: readonly unknown[],
		signal?: AbortSignal,
	) {
		return parseCommitAnswer(
			await this.#rpc(
				"qorpera_folder_commit",
				{
					p_environment_id: environmentId,
					p_actor: "final" in actor ? { ...actorJson(actor), final: true } : actorJson(actor),
					p_operation_key: operationKey,
					p_units: units,
				},
				signal,
			),
			units.length,
		);
	}

	async conflictCopies(environmentId: string, commitId: string, signal?: AbortSignal) {
		return parseConflictCopies(
			await this.#rpc(
				"qorpera_folder_conflict_copies_of",
				{ p_environment_id: environmentId, p_commit_id: commitId },
				signal,
			),
		);
	}

	async releaseReads(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		releaseId: string,
		reads: readonly ReleasedRead[],
		signal?: AbortSignal,
	) {
		return parseReleaseAnswer(
			await this.#rpc(
				"qorpera_folder_record_release",
				{
					p_environment_id: environmentId,
					p_actor: actorJson(actor),
					p_release_id: releaseId,
					p_reads: reads,
					p_output_sha256: NO_OUTPUT,
				},
				signal,
			),
			releaseId,
			reads.length,
		);
	}

	async gitLeaseTake(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		path: string,
		signal?: AbortSignal,
	) {
		return parseGitLease(
			await this.#rpc(
				"qorpera_folder_git_lease_take",
				{ p_environment_id: environmentId, p_actor: actorJson(actor), p_path: path },
				signal,
			),
			path,
		);
	}

	async gitLeaseRelease(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		leaseId: string,
		units: readonly unknown[] | null,
		signal?: AbortSignal,
	) {
		const answer = await this.#rpc(
			"qorpera_folder_git_lease_release",
			{ p_environment_id: environmentId, p_actor: actorJson(actor), p_lease_id: leaseId, p_units: units },
			signal,
		);
		return units === null ? null : parseGitPublish(answer, units.length);
	}

	async gitLeasesDrop(environmentId: string, actor: Extract<FolderActor, { kind: "view" }>, signal?: AbortSignal) {
		return parseDroppedLeases(
			await this.#rpc(
				"qorpera_folder_git_leases_drop",
				{ p_environment_id: environmentId, p_actor: actorJson(actor) },
				signal,
			),
		);
	}

	async gitPublish(
		environmentId: string,
		actor: Extract<FolderActor, { kind: "view" }>,
		leaseId: string,
		operationKey: string,
		units: readonly unknown[],
		signal?: AbortSignal,
	) {
		return parseGitPublish(
			await this.#rpc(
				"qorpera_folder_git_publish",
				{
					p_environment_id: environmentId,
					p_actor: actorJson(actor),
					p_lease_id: leaseId,
					p_operation_key: operationKey,
					p_units: units,
				},
				signal,
			),
			units.length,
		);
	}

	async #rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.#request(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) }, signal);
	}

	async #request(
		path: string,
		init: { method: "GET" | "POST"; body?: string },
		caller?: AbortSignal,
	): Promise<unknown> {
		return this.#api.run(async (signal) => {
			const response = await this.#transport(
				new URL(`${this.#url}${path}`),
				{ ...init, headers: { ...supabaseRequestHeaders(this.#key), "content-type": "application/json" } },
				8 * 1024 * 1024,
				caller ? AbortSignal.any([signal, caller]) : signal,
			);
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
			} catch {
				value = undefined;
			}
			if (response.status < 200 || response.status > 299) {
				// PostgREST's error code: the core's refusals are one company's state, not the database's health.
				const error = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
				const said = typeof error.message === "string" ? error.message : undefined;
				if (error.code === "42501")
					throw new CoreRefusal(
						said === "A released read is no longer readable"
							? "unreadable"
							: said === "Run is unavailable"
								? "run_ended"
								: "denied",
						said,
					);
				if (error.code === "55000") throw new CoreRefusal("stopped", said);
				if (error.code === "22023" || error.code === "0A000" || error.code === "P0002")
					throw new CoreRefusal("invalid", said);
				throw new ObjectDependencyError(response.status >= 500 || response.status === 0 ? 503 : response.status);
			}
			if (value === undefined) invalidAnswer("JSON");
			return value;
		}, caller);
	}
}
