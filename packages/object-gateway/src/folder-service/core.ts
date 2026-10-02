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
}

export interface ListPage {
	readonly asOfSeq: number;
	readonly entries: readonly CoreEntry[];
	readonly next: string | null;
}

/** One change of a change set on the feed (20260928237000). */
export interface FeedChange extends CoreEntry {
	readonly op: "write" | "mkdir" | "delete" | "move_out" | "move_in" | "copy";
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
	/** Extends a machine view's lease (120 s) or learns that it closed (C1b-3a `qorpera_folder_view_renew`). */
	renewView(viewId: string, pass: string, signal?: AbortSignal): Promise<ViewRenewal>;
}

export type ViewRenewal =
	| { readonly state: "open"; readonly leaseUntil: string }
	| { readonly state: "closed"; readonly reason: "closed" | "superseded" | "ended" | "expired" };

export function parseViewRenewal(value: unknown): ViewRenewal {
	const answer = answerRecord(value, "view renewal");
	if (answer.schema !== "qorpera.folder-view-renew/v1") invalidAnswer("view renewal");
	if (answer.state === "open" && typeof answer.leaseUntil === "string" && !Number.isNaN(Date.parse(answer.leaseUntil)))
		return { state: "open", leaseUntil: answer.leaseUntil };
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

/** The core refused: `denied` (42501, the actor may not read this any more), `stopped` (55000, the company is paused
 * or being deleted), `invalid` (the request or the company does not fit: 22023, 0A000, P0002). The database
 * answered, so the dependency circuit stays closed. */
export class CoreRefusal extends ObjectDependencyError {
	readonly reason: "denied" | "stopped" | "invalid";
	constructor(reason: "denied" | "stopped" | "invalid") {
		super(reason === "denied" ? 403 : reason === "stopped" ? 423 : 400);
		this.name = "CoreRefusal";
		this.message = `Folder core refused: ${reason}`;
		this.reason = reason;
	}
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

function seqOf(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidAnswer(what);
	return value;
}

/** An entry or a feed change, checked field by field; unknown fields (receipts, seq, priorVersion) are dropped. A
 * removal on the feed names no content. */
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
	} = { path: e.path, kind: e.kind, version: versionOf(e.version) };
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
				return { ...entry, op: change.op as FeedChange["op"] };
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

/** The folder core over PostgREST, with the service credential. Reads only: list, feed, the clock, and the
 * download check for the storage profile. */
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

	async renewView(viewId: string, pass: string, signal?: AbortSignal): Promise<ViewRenewal> {
		// Nothing is unsaved in a read-only view: p_unsaved_since stays null.
		return parseViewRenewal(
			await this.#rpc(
				"qorpera_folder_view_renew",
				{ p_view_id: viewId, p_pass: pass, p_unsaved_since: null },
				signal,
			),
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
				const code = value && typeof value === "object" && "code" in value ? value.code : undefined;
				if (code === "42501") throw new CoreRefusal("denied");
				if (code === "55000") throw new CoreRefusal("stopped");
				if (code === "22023" || code === "0A000" || code === "P0002") throw new CoreRefusal("invalid");
				throw new ObjectDependencyError(response.status >= 500 || response.status === 0 ? 503 : response.status);
			}
			if (value === undefined) invalidAnswer("JSON");
			return value;
		}, caller);
	}
}
