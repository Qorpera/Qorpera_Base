import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { cloudFileBytesSha256 } from "./cloud-file-bytes.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

/*
 * A member's view of a folder-v2 company's folder (folder core C4, P27a and P27b;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §2). Reads go to the member functions over PostgREST with the
 * member's own token; bytes come from the object gateway's member folder route, one manifest or chunk at a time, each
 * checked against its hash. Every answer is parsed with closed key sets, the shapes test 834 pins on the real SQL.
 * A member's change set goes to the object gateway's member commit route (P34a, §5), which stages it and commits it as
 * the member; a change under human-tasks/ waits for P31. Browser-safe.
 */

const SHA = SHA256_HEX_PATTERN;
const MEDIA = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
/** The manifest's bounds (C1D §2; `qorpera_folder_manifest`): at most 64 chunks of at most 4 MiB each, at most
 * 256 MiB in all, and a manifest of at most 32 KiB. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 64;
const MAX_FILE_BYTES = MAX_CHUNKS * CHUNK_BYTES;
const MAX_MANIFEST_BYTES = 32 * 1024;
/** A full page of 1,000 entries or changes with long paths fits. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export class CloudMemberFolderError extends Error {
	/** The HTTP status that refused the call, or null when no answer did. A change set answered 409 (a lock conflict)
	 * is sent again with the same operation key; 423 means the company is paused or being deleted. */
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.status = status;
	}
}

/** The database or the gateway refused this member (401 or 403): not an outage. */
export class CloudMemberFolderAccessDenied extends CloudMemberFolderError {}

function refusal(status: number, what: string): CloudMemberFolderError {
	return status === 401 || status === 403
		? new CloudMemberFolderAccessDenied(`${what} access is refused (${status})`, status)
		: new CloudMemberFolderError(`${what} is unavailable (${status})`, status);
}

function invalid(what: string): never {
	throw new CloudMemberFolderError(`Invalid company folder ${what}`);
}

/** Exactly `required`, plus any of `optional`. */
function closed(value: unknown, required: readonly string[], optional: readonly string[], what: string) {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(what);
	const keys = Object.keys(value);
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		keys.some((key) => !required.includes(key) && !optional.includes(key))
	)
		invalid(what);
	return value as Record<string, unknown>;
}

/** A seq: 0 only where the folder may have none yet (asOfSeq, a feed position); a commit's is at least 1. */
function seq(value: unknown, what: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(what);
	return value as number;
}

function idOf(value: unknown, what: string): string {
	if (!isUuid(value)) invalid(what);
	return value;
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\0-\x1f\x7f]/.test(value))
		invalid(what);
	return value;
}

function instant(value: unknown, what: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(what);
	return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) invalid(what);
	return value as T;
}

export interface CloudMemberFolderFile {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
}

const FILE_KEYS = ["manifestSha256", "fileSha256", "bytes", "mediaType", "executable"] as const;

/** The content fields of an entry or a version, all or none. */
function file(value: Record<string, unknown>, required: boolean, what: string): CloudMemberFolderFile | null {
	const present = FILE_KEYS.filter((key) => Object.hasOwn(value, key));
	if (present.length === 0 && !required) return null;
	if (present.length !== FILE_KEYS.length) invalid(what);
	if (
		typeof value.manifestSha256 !== "string" ||
		!SHA.test(value.manifestSha256) ||
		typeof value.fileSha256 !== "string" ||
		!SHA.test(value.fileSha256) ||
		!Number.isSafeInteger(value.bytes) ||
		(value.bytes as number) < 0 ||
		(value.bytes as number) > MAX_FILE_BYTES ||
		typeof value.mediaType !== "string" ||
		!MEDIA.test(value.mediaType) ||
		typeof value.executable !== "boolean"
	)
		invalid(what);
	return {
		manifestSha256: value.manifestSha256,
		fileSha256: value.fileSha256,
		bytes: value.bytes as number,
		mediaType: value.mediaType,
		executable: value.executable,
	};
}

export interface CloudMemberFolderEntry {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly version: string;
	readonly seq: number;
	readonly updatedAt: string;
	readonly file: CloudMemberFolderFile | null;
}

export function parseCloudMemberFolderEntry(value: unknown): CloudMemberFolderEntry {
	const entry = closed(value, ["path", "kind", "version", "seq", "updatedAt"], FILE_KEYS, "entry");
	const kind = oneOf(entry.kind, ["file", "folder"] as const, "entry");
	const content = file(entry, kind === "file", "entry");
	if (kind === "folder" && content !== null) invalid("entry");
	return {
		path: text(entry.path, "entry"),
		kind,
		version: idOf(entry.version, "entry"),
		seq: seq(entry.seq, "entry", 1),
		updatedAt: instant(entry.updatedAt, "entry"),
		file: content,
	};
}

export interface CloudMemberFolderRead {
	readonly asOfSeq: number;
	readonly entry: CloudMemberFolderEntry | null;
}

export function parseCloudMemberFolderRead(value: unknown): CloudMemberFolderRead {
	// The SQL always sends `entry`: null when not found.
	const read = closed(value, ["schema", "asOfSeq", "found", "entry"], [], "read");
	if (
		read.schema !== "qorpera.folder-read/v1" ||
		typeof read.found !== "boolean" ||
		read.found !== (read.entry !== null)
	)
		invalid("read");
	return { asOfSeq: seq(read.asOfSeq, "read"), entry: read.found ? parseCloudMemberFolderEntry(read.entry) : null };
}

export interface CloudMemberFolderListPage {
	readonly asOfSeq: number;
	readonly entries: readonly CloudMemberFolderEntry[];
	/** The path to pass as `after` for the next page; null on the last. */
	readonly next: string | null;
}

export function parseCloudMemberFolderList(value: unknown, limit: number): CloudMemberFolderListPage {
	const page = closed(value, ["schema", "asOfSeq", "entries", "next"], [], "listing");
	if (page.schema !== "qorpera.folder-list/v1" || !Array.isArray(page.entries) || page.entries.length > limit)
		invalid("listing");
	const entries = page.entries.map(parseCloudMemberFolderEntry);
	const next = page.next === null ? null : text(page.next, "listing");
	if ((next !== null) !== (entries.length === limit) || (next !== null && next !== entries.at(-1)?.path))
		invalid("listing");
	return { asOfSeq: seq(page.asOfSeq, "listing"), entries, next };
}

export type CloudMemberFolderBy =
	| { readonly kind: "member"; readonly userId: string }
	| { readonly kind: "agent"; readonly staffAgentId: string }
	| { readonly kind: "platform" };

export function parseCloudMemberFolderBy(value: unknown): CloudMemberFolderBy {
	const by = closed(value, ["kind"], ["userId", "staffAgentId"], "author");
	if (by.kind === "member" && Object.keys(by).length === 2)
		return { kind: "member", userId: idOf(by.userId, "author") };
	if (by.kind === "agent" && Object.keys(by).length === 2)
		return { kind: "agent", staffAgentId: idOf(by.staffAgentId, "author") };
	if (by.kind === "platform" && Object.keys(by).length === 1) return { kind: "platform" };
	invalid("author");
}

const OPS = ["write", "mkdir", "delete", "move_out", "move_in", "copy"] as const;
export type CloudMemberFolderOp = (typeof OPS)[number];

export interface CloudMemberFolderVersion {
	readonly version: string;
	readonly seq: number;
	readonly op: CloudMemberFolderOp;
	readonly kind: "file" | "folder";
	readonly path: string;
	readonly at: string;
	readonly by: CloudMemberFolderBy;
	/** Where a `move_in` came from, when the member may read it. */
	readonly from: string | null;
	/** Where a `move_out` went, when the member may read it. */
	readonly to: string | null;
	readonly file: CloudMemberFolderFile | null;
}

export interface CloudMemberFolderPathHistory {
	readonly asOfSeq: number;
	readonly items: readonly CloudMemberFolderVersion[];
	/** A version of this path to pass as `before` for an older page; null on the last. */
	readonly next: string | null;
}

export function parseCloudMemberFolderPathHistory(value: unknown, limit: number): CloudMemberFolderPathHistory {
	const page = closed(value, ["schema", "asOfSeq", "items", "next"], [], "path history");
	if (page.schema !== "qorpera.folder-path-history/v1" || !Array.isArray(page.items) || page.items.length > limit)
		invalid("path history");
	const items = page.items.map((input): CloudMemberFolderVersion => {
		const item = closed(
			input,
			["version", "seq", "op", "kind", "path", "at", "by"],
			[...FILE_KEYS, "from", "to"],
			"version",
		);
		const op = oneOf(item.op, OPS, "version");
		const kind = oneOf(item.kind, ["file", "folder"] as const, "version");
		if (("from" in item && op !== "move_in") || ("to" in item && op !== "move_out")) invalid("version");
		const content = file(item, false, "version");
		if (kind === "folder" && content !== null) invalid("version");
		return {
			version: idOf(item.version, "version"),
			seq: seq(item.seq, "version", 1),
			op,
			kind,
			path: text(item.path, "version"),
			at: instant(item.at, "version"),
			by: parseCloudMemberFolderBy(item.by),
			from: "from" in item ? text(item.from, "version") : null,
			to: "to" in item ? text(item.to, "version") : null,
			file: content,
		};
	});
	const next = page.next === null ? null : idOf(page.next, "path history");
	if ((next !== null) !== (items.length === limit) || (next !== null && next !== items.at(-1)?.version))
		invalid("path history");
	return { asOfSeq: seq(page.asOfSeq, "path history"), items, next };
}

export interface CloudMemberFolderChangeSet {
	readonly seq: number;
	readonly at: string;
	readonly by: CloudMemberFolderBy;
	/** At most 20 paths in it the member may read. */
	readonly paths: readonly {
		readonly path: string;
		readonly op: CloudMemberFolderOp;
		readonly kind: "file" | "folder";
		readonly version: string;
	}[];
	/** It has others the member may read, or more than one call examined. */
	readonly more: boolean;
}

export interface CloudMemberFolderHistory {
	readonly asOfSeq: number;
	readonly items: readonly CloudMemberFolderChangeSet[];
	/** A seq to pass as `before` for an older page; null on the last. */
	readonly next: number | null;
}

export function parseCloudMemberFolderHistory(value: unknown, limit = 50): CloudMemberFolderHistory {
	const page = closed(value, ["schema", "asOfSeq", "items", "next"], [], "history");
	if (page.schema !== "qorpera.folder-history/v1" || !Array.isArray(page.items) || page.items.length > limit)
		invalid("history");
	const items = page.items.map((input): CloudMemberFolderChangeSet => {
		const item = closed(input, ["seq", "at", "by", "paths", "more"], [], "change set");
		if (
			!Array.isArray(item.paths) ||
			item.paths.length < 1 ||
			item.paths.length > 20 ||
			typeof item.more !== "boolean"
		)
			invalid("change set");
		return {
			seq: seq(item.seq, "change set", 1),
			at: instant(item.at, "change set"),
			by: parseCloudMemberFolderBy(item.by),
			paths: item.paths.map((pathInput) => {
				const path = closed(pathInput, ["path", "op", "kind", "version"], [], "change set");
				return {
					path: text(path.path, "change set"),
					op: oneOf(path.op, OPS, "change set"),
					kind: oneOf(path.kind, ["file", "folder"] as const, "change set"),
					version: idOf(path.version, "change set"),
				};
			}),
			more: item.more,
		};
	});
	if (items.some((item, index) => index > 0 && item.seq >= items[index - 1]!.seq)) invalid("history");
	const next = page.next === null ? null : seq(page.next, "history");
	if (next !== null && items.length > 0 && next > items.at(-1)!.seq) invalid("history");
	return { asOfSeq: seq(page.asOfSeq, "history"), items, next };
}

export interface CloudMemberFolderFeedPosition {
	readonly afterSeq: number;
	readonly cursor: { readonly unitNo: number; readonly version: string } | null;
}

export interface CloudMemberFolderChange {
	readonly unitNo: number;
	readonly op: CloudMemberFolderOp;
	readonly kind: "file" | "folder";
	readonly path: string;
	readonly version: string;
	readonly priorVersion: string | null;
	readonly updatedAt: string | null;
	readonly file: CloudMemberFolderFile | null;
}

export type CloudMemberFolderEvent =
	| {
			readonly kind: "change_set";
			readonly seq: number;
			readonly commitId: string;
			readonly at: string;
			readonly by: CloudMemberFolderBy;
			readonly changes: readonly CloudMemberFolderChange[];
	  }
	| { readonly kind: "authority"; readonly seq: number };

export interface CloudMemberFolderChangesPage {
	readonly asOfSeq: number;
	/** The position can't be continued: read again from the top. */
	readonly resync: boolean;
	readonly events: readonly CloudMemberFolderEvent[];
	/** Where to continue; null with `resync`. */
	readonly next: CloudMemberFolderFeedPosition | null;
	readonly more: boolean;
}

function position(value: unknown): CloudMemberFolderFeedPosition {
	const next = closed(value, ["afterSeq", "cursor"], [], "feed position");
	if (next.cursor === null) return { afterSeq: seq(next.afterSeq, "feed position"), cursor: null };
	const cursor = closed(next.cursor, ["unitNo", "version"], [], "feed position");
	if (!Number.isSafeInteger(cursor.unitNo) || (cursor.unitNo as number) < 1) invalid("feed position");
	return {
		afterSeq: seq(next.afterSeq, "feed position"),
		cursor: { unitNo: cursor.unitNo as number, version: idOf(cursor.version, "feed position") },
	};
}

export function parseCloudMemberFolderChanges(value: unknown): CloudMemberFolderChangesPage {
	const page = closed(value, ["schema", "asOfSeq", "resync", "events", "next", "more"], [], "feed");
	if (
		page.schema !== "qorpera.folder-feed/v1" ||
		typeof page.resync !== "boolean" ||
		typeof page.more !== "boolean" ||
		!Array.isArray(page.events) ||
		page.events.length > 1000 ||
		page.resync !== (page.next === null) ||
		(page.resync && (page.events.length > 0 || page.more))
	)
		invalid("feed");
	const events = page.events.map((input): CloudMemberFolderEvent => {
		if (input && typeof input === "object" && (input as Record<string, unknown>).kind === "authority") {
			const event = closed(input, ["kind", "seq"], [], "feed event");
			return { kind: "authority", seq: seq(event.seq, "feed event", 1) };
		}
		const event = closed(input, ["kind", "seq", "commitId", "at", "by", "changes"], [], "feed event");
		if (event.kind !== "change_set" || !Array.isArray(event.changes) || event.changes.length > 1000)
			invalid("feed event");
		return {
			kind: "change_set",
			seq: seq(event.seq, "feed event", 1),
			commitId: idOf(event.commitId, "feed event"),
			at: instant(event.at, "feed event"),
			by: parseCloudMemberFolderBy(event.by),
			changes: event.changes.map((changeInput): CloudMemberFolderChange => {
				const change = closed(
					changeInput,
					["unitNo", "op", "kind", "path", "version"],
					[...FILE_KEYS, "priorVersion", "updatedAt"],
					"feed change",
				);
				if (!Number.isSafeInteger(change.unitNo) || (change.unitNo as number) < 1) invalid("feed change");
				const kind = oneOf(change.kind, ["file", "folder"] as const, "feed change");
				const content = file(change, false, "feed change");
				if (kind === "folder" && content !== null) invalid("feed change");
				return {
					unitNo: change.unitNo as number,
					op: oneOf(change.op, OPS, "feed change"),
					kind,
					path: text(change.path, "feed change"),
					version: idOf(change.version, "feed change"),
					priorVersion: "priorVersion" in change ? idOf(change.priorVersion, "feed change") : null,
					updatedAt: "updatedAt" in change ? instant(change.updatedAt, "feed change") : null,
					file: content,
				};
			}),
		};
	});
	return {
		asOfSeq: seq(page.asOfSeq, "feed"),
		resync: page.resync,
		events,
		next: page.next === null ? null : position(page.next),
		more: page.more,
	};
}

function origin(value: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new CloudMemberFolderError("Invalid company folder endpoint");
	return url.origin;
}

function path(value: string): string {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).length > 4096)
		throw new CloudMemberFolderError("Invalid company folder path");
	return value;
}

/** A member's client for one folder-v2 environment. */
/** The live agents' and group chats' files a member may read (P34a, `qorpera_member_company_state_folders`). A
 * folder is its file's parent. */
export interface CloudMemberCompanyStateFolders {
	readonly agents: readonly { readonly staffAgentId: string; readonly file: string }[];
	readonly groups: readonly { readonly roomId: string; readonly file: string }[];
}

export function parseCloudMemberCompanyStateFolders(value: unknown): CloudMemberCompanyStateFolders {
	const input = closed(value, ["schema", "agents", "groups"], [], "state folders");
	if (
		input.schema !== "qorpera.member-company-state-folders/v1" ||
		!Array.isArray(input.agents) ||
		!Array.isArray(input.groups)
	)
		invalid("state folders");
	return {
		agents: input.agents.map((item) => {
			const row = closed(item, ["staffAgentId", "file"], [], "agent folder");
			return { staffAgentId: idOf(row.staffAgentId, "agent folder"), file: text(row.file, "agent folder") };
		}),
		groups: input.groups.map((item) => {
			const row = closed(item, ["roomId", "file"], [], "group chat folder");
			return { roomId: idOf(row.roomId, "group chat folder"), file: text(row.file, "group chat folder") };
		}),
	};
}

/** One unit of a member's change set, as the member commit route takes it (P34a). Text is UTF-8, at most 64 KiB a
 * file and 512 KiB a change set; the route stages it and gives every state file its parse. */
export type CloudMemberFolderUnit =
	| { readonly op: "write"; readonly path: string; readonly text: string; readonly expectedVersion?: string }
	| { readonly op: "mkdir"; readonly path: string }
	| {
			readonly op: "new_folder";
			readonly path: string;
			readonly contents: readonly (
				| { readonly path: string; readonly kind: "folder" }
				| { readonly path: string; readonly kind: "file"; readonly text: string }
			)[];
	  }
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion?: string; readonly asOfSeq?: number }
	| {
			readonly op: "move";
			readonly from: string;
			readonly to: string;
			readonly expectedVersion?: string;
			readonly asOfSeq?: number;
	  };

export type CloudMemberFolderOutcome = "saved" | "conflict" | "refused" | "denied" | "waiting_for_review";
const OUTCOMES: readonly CloudMemberFolderOutcome[] = ["saved", "conflict", "refused", "denied", "waiting_for_review"];

/** A refusal's problems: a state file's parser codes, or the hook's rule codes, each `{line, key, code, message}`. */
export interface CloudMemberFolderProblem {
	readonly line: number | null;
	readonly key: string | null;
	readonly code: string;
	readonly message: string;
}

export interface CloudMemberFolderUnitResult {
	readonly unit: number;
	readonly op: CloudMemberFolderUnit["op"];
	readonly path: string;
	readonly to: string | null;
	readonly version: string | null;
	readonly outcome: CloudMemberFolderOutcome;
	readonly reason: string | null;
	readonly problems: readonly CloudMemberFolderProblem[];
}

/** The core's answer to a change set (`qorpera.folder-commit/v1`): each unit saved or not on its own; `seq` null when
 * none was saved. */
export interface CloudMemberFolderCommit {
	readonly commitId: string;
	readonly seq: number | null;
	readonly replay: boolean;
	readonly units: readonly CloudMemberFolderUnitResult[];
}

function problems(value: unknown): CloudMemberFolderProblem[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 51) invalid("commit problems");
	// The commit strips nulls from each outcome: a problem without a line or key comes back without those keys.
	return value.map((item) => {
		const problem = closed(item, ["code", "message"], ["line", "key"], "commit problem");
		const line = problem.line ?? null;
		const key = problem.key ?? null;
		if (
			(line !== null && (!Number.isSafeInteger(line) || (line as number) < 1)) ||
			(key !== null && typeof key !== "string") ||
			typeof problem.code !== "string" ||
			typeof problem.message !== "string"
		)
			invalid("commit problem");
		return { line: line as number | null, key: key as string | null, code: problem.code, message: problem.message };
	});
}

export function parseCloudMemberFolderCommit(
	value: unknown,
	units: readonly CloudMemberFolderUnit[],
): CloudMemberFolderCommit {
	const input = closed(value, ["schema", "commitId", "seq", "replay", "units"], [], "commit");
	if (
		input.schema !== "qorpera.folder-commit/v1" ||
		typeof input.replay !== "boolean" ||
		!Array.isArray(input.units) ||
		input.units.length !== units.length
	)
		invalid("commit");
	const results = input.units.map((item, index): CloudMemberFolderUnitResult => {
		const unit = closed(
			item,
			["unit", "op", "path", "outcome"],
			["to", "version", "reason", "problems"],
			"commit unit",
		);
		if (
			unit.unit !== index + 1 ||
			unit.op !== units[index]?.op ||
			typeof unit.path !== "string" ||
			!OUTCOMES.includes(unit.outcome as CloudMemberFolderOutcome) ||
			(unit.to !== undefined && typeof unit.to !== "string") ||
			(unit.reason !== undefined && typeof unit.reason !== "string") ||
			(unit.outcome === "saved") !== (unit.reason === undefined)
		)
			invalid("commit unit");
		return {
			unit: index + 1,
			op: unit.op as CloudMemberFolderUnit["op"],
			path: unit.path,
			to: (unit.to as string | undefined) ?? null,
			version: unit.version === undefined ? null : idOf(unit.version, "commit unit version"),
			outcome: unit.outcome as CloudMemberFolderOutcome,
			reason: (unit.reason as string | undefined) ?? null,
			problems: problems(unit.problems),
		};
	});
	const committed = input.seq === null ? null : seq(input.seq, "commit seq", 1);
	if ((committed === null) !== results.every((unit) => unit.outcome !== "saved")) invalid("commit");
	return { commitId: idOf(input.commitId, "commit id"), seq: committed, replay: input.replay, units: results };
}

/** A member's change set's operation key: what makes a retry of the same change set a replay, never a second change. */
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export class CloudMemberFolderClient {
	readonly #environmentId: string;
	readonly #controlOrigin: string;
	readonly #objectOrigin: string;
	readonly #publishableKey: string;
	readonly #accessToken: (signal: AbortSignal) => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: {
		environmentId: string;
		supabaseUrl: string;
		objectGatewayUrl: string;
		publishableKey: string;
		accessToken: (signal: AbortSignal) => Promise<string>;
		fetch?: typeof fetch;
		timeoutMs?: number;
	}) {
		if (
			!isUuid(options.environmentId) ||
			!options.publishableKey ||
			options.publishableKey.length > 8192 ||
			/[\0\r\n]/.test(options.publishableKey)
		)
			throw new CloudMemberFolderError("Invalid company folder configuration");
		this.#environmentId = options.environmentId;
		this.#controlOrigin = origin(options.supabaseUrl);
		this.#objectOrigin = origin(options.objectGatewayUrl);
		this.#publishableKey = options.publishableKey;
		this.#accessToken = options.accessToken;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000)
			throw new CloudMemberFolderError("Invalid company folder deadline");
	}

	read(pathValue: string, signal: AbortSignal): Promise<CloudMemberFolderRead> {
		return this.#call("qorpera_member_folder_read", { p_path: path(pathValue) }, signal).then(
			parseCloudMemberFolderRead,
		);
	}

	/** One folder's entries in folder-key order; `parent` null for the top. */
	list(
		parent: string | null,
		after: string | null,
		limit: number,
		signal: AbortSignal,
	): Promise<CloudMemberFolderListPage> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new CloudMemberFolderError("Invalid company folder listing");
		return this.#call(
			"qorpera_member_folder_list",
			{
				p_parent: parent === null ? null : path(parent),
				p_after: after === null ? null : path(after),
				p_limit: limit,
			},
			signal,
		).then((value) => parseCloudMemberFolderList(value, limit));
	}

	/** A path's versions, newest first. */
	pathHistory(
		pathValue: string,
		before: string | null,
		limit: number,
		signal: AbortSignal,
	): Promise<CloudMemberFolderPathHistory> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== null && !isUuid(before)))
			throw new CloudMemberFolderError("Invalid company folder history request");
		return this.#call(
			"qorpera_member_folder_path_history",
			{ p_path: path(pathValue), p_before: before, p_limit: limit },
			signal,
		).then((value) => parseCloudMemberFolderPathHistory(value, limit));
	}

	/** The live agents' and group chats' files the member may read (P34a). */
	stateFolders(signal: AbortSignal): Promise<CloudMemberCompanyStateFolders> {
		return this.#call("qorpera_member_company_state_folders", {}, signal).then(parseCloudMemberCompanyStateFolders);
	}

	/** Commits `units` as the member through the object gateway (P34a): each unit saved, refused or in conflict on its
	 * own. Send the same `operationKey` again to retry the same change set. A change under human-tasks/ is refused
	 * (access denied) until P31. */
	commit(
		operationKey: string,
		units: readonly CloudMemberFolderUnit[],
		signal: AbortSignal,
	): Promise<CloudMemberFolderCommit> {
		if (!OPERATION_KEY.test(operationKey) || !Array.isArray(units) || units.length < 1 || units.length > 16)
			throw new CloudMemberFolderError("Invalid company folder change set");
		const body = JSON.stringify({ schema: "qorpera.member-folder-commit/v1", operationKey, units });
		return withCloudDeadline(
			async (requestSignal) => {
				const token = await this.#token(requestSignal);
				const init: RequestInit & Pick<Request, "cache"> = {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body,
					signal: requestSignal,
					redirect: "error",
					cache: "no-store",
				};
				const response = await this.#fetch(
					`${this.#objectOrigin}/v1/member-folder-commits/${this.#environmentId}`,
					init,
				);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw refusal(response.status, "Company folder change");
				}
				const bytes = await readBoundedCloudResponse(response, MAX_ANSWER_BYTES, requestSignal);
				let value: unknown;
				try {
					value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				} catch {
					invalid("commit");
				}
				return parseCloudMemberFolderCommit(value, units);
			},
			this.#timeoutMs,
			signal,
		);
	}

	/** The change sets, newest first. */
	history(before: number | null, limit: number, signal: AbortSignal): Promise<CloudMemberFolderHistory> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 50 ||
			(before !== null && (!Number.isSafeInteger(before) || before < 1))
		)
			throw new CloudMemberFolderError("Invalid company folder history request");
		return this.#call("qorpera_member_folder_history", { p_before: before, p_limit: limit }, signal).then((value) =>
			parseCloudMemberFolderHistory(value, limit),
		);
	}

	/** The feed from a position: what changed, to refresh what is on screen after a hint. */
	changes(
		from: CloudMemberFolderFeedPosition,
		limit: number,
		signal: AbortSignal,
	): Promise<CloudMemberFolderChangesPage> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 1000 ||
			!Number.isSafeInteger(from.afterSeq) ||
			from.afterSeq < 0
		)
			throw new CloudMemberFolderError("Invalid company folder feed position");
		return this.#call(
			"qorpera_member_folder_changes",
			{ p_after_seq: from.afterSeq, p_limit: limit, p_cursor: from.cursor },
			signal,
		).then(parseCloudMemberFolderChanges);
	}

	/** A file's bytes: its manifest, then its chunks, each checked against its hash, and the whole against the file's. */
	readFile(reference: CloudMemberFolderFile, signal: AbortSignal, maximumBytes = MAX_FILE_BYTES): Promise<Uint8Array> {
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_FILE_BYTES)
			throw new CloudMemberFolderError("Invalid company folder read limit");
		if (reference.bytes > maximumBytes)
			throw new CloudMemberFolderError("Company folder file exceeds this viewer's limit");
		return withCloudDeadline(
			async (requestSignal) => {
				const manifestBytes = await this.#object(reference.manifestSha256, MAX_MANIFEST_BYTES, requestSignal);
				let manifestValue: unknown;
				try {
					manifestValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
				} catch {
					invalid("manifest");
				}
				const manifest = closed(
					manifestValue,
					["schema", "fileSha256", "bytes", "mediaType", "executable", "chunks"],
					[],
					"manifest",
				);
				if (
					manifest.schema !== "qorpera.cloud-file-manifest/v2" ||
					manifest.fileSha256 !== reference.fileSha256 ||
					manifest.bytes !== reference.bytes ||
					manifest.mediaType !== reference.mediaType ||
					manifest.executable !== reference.executable ||
					!Array.isArray(manifest.chunks) ||
					manifest.chunks.length > MAX_CHUNKS
				)
					invalid("manifest");
				const chunks = (manifest.chunks as unknown[]).map((input) => {
					const chunk = closed(input, ["sha256", "bytes"], [], "manifest");
					if (
						typeof chunk.sha256 !== "string" ||
						!SHA.test(chunk.sha256) ||
						!Number.isSafeInteger(chunk.bytes) ||
						(chunk.bytes as number) < 1 ||
						(chunk.bytes as number) > CHUNK_BYTES
					)
						invalid("manifest");
					return { sha256: chunk.sha256, bytes: chunk.bytes as number };
				});
				if (chunks.reduce((total, chunk) => total + chunk.bytes, 0) !== reference.bytes) invalid("manifest");
				const bytes = new Uint8Array(reference.bytes);
				let offset = 0;
				for (const chunk of chunks) {
					const part = await this.#object(chunk.sha256, chunk.bytes, requestSignal);
					if (part.byteLength !== chunk.bytes) invalid("chunk");
					bytes.set(part, offset);
					offset += part.byteLength;
				}
				// The chunks are the manifest's; the manifest's fileSha256 is only its writer's word.
				if ((await cloudFileBytesSha256(bytes)) !== reference.fileSha256)
					throw new CloudMemberFolderError("Company folder bytes do not match their entry");
				requestSignal.throwIfAborted();
				return bytes;
			},
			this.#timeoutMs,
			signal,
		);
	}

	async #token(signal: AbortSignal): Promise<string> {
		let token: string;
		try {
			token = await this.#accessToken(signal);
		} catch {
			throw new CloudMemberFolderError("Member sign-in is unavailable");
		}
		signal.throwIfAborted();
		if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
			throw new CloudMemberFolderError("Member sign-in is unavailable");
		return token;
	}

	#call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return withCloudDeadline(
			async (requestSignal) => {
				const token = await this.#token(requestSignal);
				const init: RequestInit & Pick<Request, "cache"> = {
					method: "POST",
					headers: {
						apikey: this.#publishableKey,
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ p_environment_id: this.#environmentId, ...args }),
					signal: requestSignal,
					redirect: "error",
					cache: "no-store",
				};
				const response = await this.#fetch(`${this.#controlOrigin}/rest/v1/rpc/${name}`, init);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw refusal(response.status, "Company folder");
				}
				const bytes = await readBoundedCloudResponse(response, MAX_ANSWER_BYTES, requestSignal);
				try {
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				} catch {
					invalid("answer");
				}
			},
			this.#timeoutMs,
			signal,
		);
	}

	/** One object through the member folder route, checked against its hash. */
	async #object(sha256: string, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
		const token = await this.#token(signal);
		const init: RequestInit & Pick<Request, "cache"> = {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
			signal,
			redirect: "error",
			cache: "no-store",
		};
		const response = await this.#fetch(
			`${this.#objectOrigin}/v1/member-folder-objects/${this.#environmentId}/${sha256}`,
			init,
		);
		if (response.status !== 200 || response.headers.get("x-qorpera-access-mode") !== "live-path-authority") {
			void response.body?.cancel().catch(() => undefined);
			throw refusal(response.status, "Company folder bytes");
		}
		const bytes = await readBoundedCloudResponse(response, maximum, signal);
		const declared = response.headers.get("content-length");
		if ((declared !== null && Number(declared) !== bytes.length) || (await cloudFileBytesSha256(bytes)) !== sha256)
			throw new CloudMemberFolderError("Company folder object failed integrity verification");
		return bytes;
	}
}

/** The private Realtime topic of a folder-v2 company's hint (folder core C4, P30). */
export function cloudMemberFolderHintTopic(environmentId: string): string {
	if (!isUuid(environmentId)) throw new CloudMemberFolderError("Invalid company folder configuration");
	return `qorpera-folder-${environmentId}`;
}

/** A hint's seq, or null for anything that is not exactly `{schema: "qorpera.folder-hint/v1", seq}`. */
export function parseCloudMemberFolderHint(value: unknown): number | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const hint = value as Record<string, unknown>;
	if (Object.keys(hint).length !== 2 || hint.schema !== "qorpera.folder-hint/v1" || !Number.isSafeInteger(hint.seq))
		return null;
	return (hint.seq as number) >= 1 ? (hint.seq as number) : null;
}

/**
 * The members' hint for a folder-v2 company (folder core C4, P30): `onHint(seq)` when the folder's clock reached seq.
 * A nudge only: the caller asks the feed what changed, and keeps a slow poll for hints missed while disconnected. A
 * failed or closed join is tried again after 10 s until `close()` or the signal ends it.
 */
export class CloudMemberFolderHints {
	readonly #client: Pick<SupabaseClient, "channel" | "removeChannel">;
	readonly #topic: string;
	readonly #signal: AbortSignal;
	readonly #onHint: (seq: number) => void;
	readonly #onState?: (connected: boolean) => void;
	#channel: RealtimeChannel | undefined;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	constructor(options: {
		environmentId: string;
		client: Pick<SupabaseClient, "channel" | "removeChannel">;
		signal: AbortSignal;
		onHint(seq: number): void;
		onState?(connected: boolean): void;
	}) {
		this.#topic = cloudMemberFolderHintTopic(options.environmentId);
		this.#client = options.client;
		this.#signal = options.signal;
		this.#onHint = options.onHint;
		this.#onState = options.onState;
		this.#signal.addEventListener("abort", () => void this.close(), { once: true });
		if (!this.#signal.aborted) this.#join();
	}

	#join(): void {
		if (this.#closed || this.#channel) return;
		const channel = this.#client.channel(this.#topic, { config: { private: true } });
		this.#channel = channel;
		channel.on("broadcast", { event: "folder" }, (message: { payload?: unknown }) => {
			if (this.#closed || this.#channel !== channel) return;
			const seq = parseCloudMemberFolderHint(message.payload);
			if (seq !== null) this.#onHint(seq);
		});
		channel.subscribe((status: string) => {
			if (this.#closed || this.#channel !== channel) return;
			if (status === "SUBSCRIBED") this.#onState?.(true);
			else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
				this.#channel = undefined;
				this.#onState?.(false);
				void this.#rejoin(channel);
			}
		});
	}

	/** Joins again once the old channel is gone: the client hands back a channel it still holds for the same topic,
	 * and that one never subscribes again. Until it is removed, removing is tried again every 10 s. */
	async #rejoin(old: RealtimeChannel): Promise<void> {
		const removed = await withCloudDeadline(() => this.#client.removeChannel(old), 2000).catch(() => "error");
		if (this.#closed) return;
		this.#retry = setTimeout(() => (removed === "ok" ? this.#join() : void this.#rejoin(old)), 10_000);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#retry);
		const channel = this.#channel;
		this.#channel = undefined;
		if (channel) await withCloudDeadline(() => this.#client.removeChannel(channel), 2000).catch(() => undefined);
	}
}
