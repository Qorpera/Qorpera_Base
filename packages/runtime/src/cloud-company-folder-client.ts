import { createHash, randomInt } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import {
	COMPANY_STATE_PARSER_VERSION,
	type CompanyStateProblem,
	companyPathKey,
	companyStatePath,
	parseCompanyStateFile,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudCompanyPathControl,
	CloudCompanyPathNotText,
	type CloudCompanyPathRpc,
} from "./cloud-company-path-gateway.ts";
import { CloudCompanyFolderRpcError } from "./cloud-company-path-refusal.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/*
 * A run's client of the company folder core, for folder-v2 companies (RUNTIME-COMPANY-FOLDER-CORE.md §11 C3; the shape
 * F1 reviewed on #533, 2026-09-29). It reads, lists, commits change sets and records releases over the core's four
 * entry points, as the run: `{kind:'run', runId, jobId, runnerId, assignmentId}` from its binding. It passes no fence
 * and holds no lock between calls: reads and listings take SQL's plain checks, and a commit or a release runs SQL's run
 * check (the stop, the job and the fence at KEY SHARE, the run's principals and its wake).
 *
 * Nothing uses it yet. Its writers go live once core C1c-2b gives a tool call its folder receipt (the gate a commit
 * then carries) and core C1d lets a folder-v2 run move bytes (upload intents, and a byte check that never locks the
 * company row); until then the object store refuses a folder-v2 run's uploads and downloads (C1c-1).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
/** The commit's rule for an operation key (C1B §4: unique within the run). */
const OPERATION_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
/** The core's media type rule for a stored file. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
/** The commit's bound on units in one change set. */
const MAX_UNITS = 1000;
/** One listing page. SQL accepts up to 1000; 200 entries with their receipts stay well inside the control's
 * 256 KiB response bound. */
const LIST_PAGE = 200;
/** A whole listing stops at the core's subtree bound (core §3, units). */
const MAX_LISTED = 50_000;
/** A release names at most this many reads (SQL's bound). */
const MAX_RELEASED = 10_000;
/** Tries of one commit or release that met a retryable error: the same operation key or release id each time. */
const ATTEMPTS = 4;
/** An authority change after the commit decided (QRC01), a deadlock, and a parallel change set that took a new id:
 * each is retried with the same key (F1, #533). A release retries the first two with the same id. */
const COMMIT_RETRY = new Set(["QRC01", "40P01", "23505"]);
const RELEASE_RETRY = new Set(["QRC01", "40P01"]);
/** The recheck's refusals in commit and release: the model saw something it may no longer see. */
const READ_REVOKED = new Set(["A read is no longer readable", "A released read is no longer readable"]);

export interface CloudCompanyFolderRunActor {
	readonly kind: "run";
	readonly runId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
}

/** The authority an entry was read under, as a receipt for a release (C1B §C1b-2 3). The grant is null only on
 * `rules/`, which every agent reads by its scope. */
export interface CloudCompanyFolderAuthority {
	readonly resourceId: string;
	readonly resourceRevision: number;
	readonly grantId: string | null;
	readonly grantRevision: number | null;
}

export interface CloudCompanyFolderFile {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
}

interface CloudCompanyFolderEntryBase {
	readonly path: string;
	readonly version: string;
	/** The change set that last wrote it. */
	readonly seq: number;
	readonly updatedAt: string;
	readonly authority: CloudCompanyFolderAuthority;
}

export type CloudCompanyFolderEntry =
	| (CloudCompanyFolderEntryBase & { readonly kind: "file"; readonly file: CloudCompanyFolderFile })
	| (CloudCompanyFolderEntryBase & { readonly kind: "folder" });

export type CloudCompanyFolderFileEntry = Extract<CloudCompanyFolderEntry, { kind: "file" }>;

export interface CloudCompanyFolderReadResult {
	/** The folder's clock when the read was answered. */
	readonly asOfSeq: number;
	readonly entry: CloudCompanyFolderEntry | null;
}

export interface CloudCompanyFolderPage {
	readonly asOfSeq: number;
	readonly entries: readonly CloudCompanyFolderEntry[];
	/** The last path of a full page, to pass as `after`; null on the last page. */
	readonly next: string | null;
}

/** Where a folder-v2 run's file bytes go and come from. Core C1d provides the one runs use (upload intents, and a
 * byte check that never locks the company row). The client checks what `put` returns against its own hash, and what
 * `get` returns against the entry. */
export interface CloudCompanyFolderBytes {
	put(bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<CloudFileReference>;
	get(file: CloudCompanyFolderFile, signal: AbortSignal): Promise<Uint8Array>;
}

/** A file's content in a change set. Text is stored as UTF-8. */
export type CloudCompanyFolderContent =
	| { readonly text: string; readonly mediaType?: string; readonly executable?: boolean }
	| { readonly bytes: Uint8Array; readonly mediaType: string; readonly executable?: boolean };

export type CloudCompanyFolderNewEntry =
	| { readonly path: string; readonly kind: "file"; readonly content: CloudCompanyFolderContent }
	| { readonly path: string; readonly kind: "folder" };

/** A change set's units (core §3). A write without `expectedVersion` creates the file and is refused if the path
 * exists. A folder's delete or move carries the `asOfSeq` its writer saw the subtree at. */
export type CloudCompanyFolderUnit =
	| {
			readonly op: "write";
			readonly path: string;
			readonly content: CloudCompanyFolderContent;
			readonly expectedVersion?: string;
	  }
	| { readonly op: "mkdir"; readonly path: string }
	| { readonly op: "new_folder"; readonly path: string; readonly contents: readonly CloudCompanyFolderNewEntry[] }
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion: string; readonly asOfSeq?: number }
	| {
			readonly op: "move";
			readonly from: string;
			readonly to: string;
			readonly expectedVersion: string;
			readonly asOfSeq?: number;
	  }
	| { readonly op: "copy"; readonly from: string; readonly to: string; readonly expectedVersion?: string };

export type CloudCompanyFolderOutcome = "saved" | "conflict" | "refused" | "denied" | "waiting_for_review";

export interface CloudCompanyFolderUnitResult {
	readonly unit: number;
	readonly op: CloudCompanyFolderUnit["op"];
	/** The path as stored (a saved move or copy keeps its source here and its target in `to`). */
	readonly path: string;
	readonly to: string | null;
	/** The new version of a saved unit's path, where it has one. */
	readonly version: string | null;
	readonly outcome: CloudCompanyFolderOutcome;
	/** Why a unit was not saved: `version_changed`, `exists`, `missing`, `unseen_change` (a conflict), `denied`,
	 * `review_required`, `review_denied`, `structured_invalid`, `parent_missing`, `too_long` and the others of core §3. */
	readonly reason: string | null;
	/** A structured file's problems, as the shared parser words them. */
	readonly problems: readonly CompanyStateProblem[];
}

export interface CloudCompanyFolderCommitResult {
	readonly commitId: string;
	/** Null when no unit was saved. */
	readonly seq: number | null;
	readonly replay: boolean;
	readonly units: readonly CloudCompanyFolderUnitResult[];
}

/** A read released to the model: its path, the version read, and the receipt it was read under. */
export interface CloudCompanyFolderRelease {
	readonly path: string;
	readonly version: string;
	readonly authority: CloudCompanyFolderAuthority;
	/** Audit data only (contract 9.1): the file's content hash, when a file's content was released. */
	readonly fileSha256?: string;
}

export interface CloudCompanyFolderReleaseResult {
	readonly releaseId: string;
	readonly reads: number;
	readonly replay: boolean;
}

/**
 * Why a folder call did not complete, for the caller to tell the model:
 * - `stopped`: the company's work is stopped (paused or being deleted, 55000);
 * - `unavailable`: the run ended, lost its authority, or the company is not folder-v2 (42501, 0A000);
 * - `read_revoked`: something the model saw may no longer be seen (the recheck's 42501); the change or release was
 *   not recorded, and the caller reports it as denied;
 * - `contended`: the folder kept changing under a retried commit or release.
 * Other SQL errors (22023, 25000) are defects and stay a `CloudCompanyFolderRpcError`.
 */
export type CloudCompanyFolderFailure = "stopped" | "unavailable" | "read_revoked" | "contended";

export class CloudCompanyFolderError extends CloudRuntimeDiagnosticError {
	readonly failure: CloudCompanyFolderFailure;

	constructor(failure: CloudCompanyFolderFailure) {
		super(
			failure === "contended" ? "stale_version" : "authority_unavailable",
			failure === "stopped"
				? "Company work is stopped"
				: failure === "read_revoked"
					? "Company folder read is no longer readable"
					: failure === "contended"
						? "Company folder kept changing"
						: "Company folder is unavailable",
		);
		this.failure = failure;
	}
}

function failure(error: unknown): unknown {
	if (!(error instanceof CloudCompanyFolderRpcError)) return error;
	if (error.code === "55000") return new CloudCompanyFolderError("stopped");
	if (error.code === "42501")
		return new CloudCompanyFolderError(READ_REVOKED.has(error.detail) ? "read_revoked" : "unavailable");
	if (error.code === "0A000") return new CloudCompanyFolderError("unavailable");
	return error;
}

function invalid(): never {
	throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder response is invalid");
}

function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
	)
		invalid();
	return value as Record<string, unknown>;
}

function counter(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
	return value as number;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) invalid();
	return value;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function authority(value: unknown): CloudCompanyFolderAuthority {
	const input = record(value, ["resourceId", "resourceRevision", "grantId", "grantRevision"]);
	if ((input.grantId === null) !== (input.grantRevision === null)) invalid();
	return {
		resourceId: uuid(input.resourceId),
		resourceRevision: counter(input.resourceRevision),
		grantId: input.grantId === null ? null : uuid(input.grantId),
		grantRevision: input.grantRevision === null ? null : counter(input.grantRevision),
	};
}

const ENTRY_KEYS = ["path", "kind", "version", "seq", "updatedAt", "authority"] as const;
const FILE_KEYS = ["manifestSha256", "fileSha256", "bytes", "mediaType", "executable"] as const;

function entry(value: unknown): CloudCompanyFolderEntry {
	const kind = (value as { kind?: unknown } | null)?.kind;
	const input = record(value, kind === "file" ? [...ENTRY_KEYS, ...FILE_KEYS] : ENTRY_KEYS);
	if (typeof input.path !== "string" || !input.path || typeof input.updatedAt !== "string") invalid();
	const base = {
		path: input.path,
		version: uuid(input.version),
		seq: counter(input.seq),
		updatedAt: input.updatedAt,
		authority: authority(input.authority),
	};
	if (input.kind === "folder") return { ...base, kind: "folder" };
	if (
		input.kind !== "file" ||
		typeof input.manifestSha256 !== "string" ||
		!SHA.test(input.manifestSha256) ||
		typeof input.fileSha256 !== "string" ||
		!SHA.test(input.fileSha256) ||
		typeof input.mediaType !== "string" ||
		!MEDIA_TYPE.test(input.mediaType) ||
		typeof input.executable !== "boolean"
	)
		invalid();
	return {
		...base,
		kind: "file",
		file: {
			manifestSha256: input.manifestSha256,
			fileSha256: input.fileSha256,
			bytes: counter(input.bytes),
			mediaType: input.mediaType,
			executable: input.executable,
		},
	};
}

function problems(value: unknown): CompanyStateProblem[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 51) invalid();
	return value.map((item) => {
		const problem = record(item, ["line", "key", "code", "message"]);
		if (
			(problem.line !== null && (!Number.isSafeInteger(problem.line) || (problem.line as number) < 1)) ||
			(problem.key !== null && typeof problem.key !== "string") ||
			typeof problem.code !== "string" ||
			typeof problem.message !== "string"
		)
			invalid();
		return problem as unknown as CompanyStateProblem;
	});
}

const OUTCOMES: readonly CloudCompanyFolderOutcome[] = ["saved", "conflict", "refused", "denied", "waiting_for_review"];

function unitResult(value: unknown, index: number, sent: CloudCompanyFolderUnit): CloudCompanyFolderUnitResult {
	const input = record(value, ["unit", "op", "path", "outcome"], ["to", "version", "reason", "problems"]);
	if (
		input.unit !== index + 1 ||
		input.op !== sent.op ||
		typeof input.path !== "string" ||
		!OUTCOMES.includes(input.outcome as CloudCompanyFolderOutcome) ||
		(input.to !== undefined && typeof input.to !== "string") ||
		(input.reason !== undefined && typeof input.reason !== "string") ||
		(input.outcome === "saved") !== (input.reason === undefined)
	)
		invalid();
	return {
		unit: index + 1,
		op: sent.op,
		path: input.path,
		to: (input.to as string | undefined) ?? null,
		version: input.version === undefined ? null : uuid(input.version),
		outcome: input.outcome as CloudCompanyFolderOutcome,
		reason: (input.reason as string | undefined) ?? null,
		problems: problems(input.problems),
	};
}

function mediaTypeFor(path: string): string {
	return path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";
}

/** The entry to release for a read: its path, version and receipt, with the content hash of a file. */
export function cloudCompanyFolderRelease(entry: CloudCompanyFolderEntry): CloudCompanyFolderRelease {
	return entry.kind === "file"
		? { path: entry.path, version: entry.version, authority: entry.authority, fileSha256: entry.file.fileSha256 }
		: { path: entry.path, version: entry.version, authority: entry.authority };
}

export class CloudCompanyFolderClient {
	readonly #binding: CloudNativeToolBinding;
	readonly #identity: CloudNativeToolIdentity;
	readonly #control: CloudCompanyPathControl;
	readonly #bytes: CloudCompanyFolderBytes;
	readonly #actor: CloudCompanyFolderRunActor;

	constructor(options: {
		binding: CloudNativeToolBinding;
		identity: CloudNativeToolIdentity;
		control: CloudCompanyPathControl;
		bytes: CloudCompanyFolderBytes;
	}) {
		this.#binding = parseCloudNativeToolBinding(options.binding);
		if (
			Object.entries(this.#binding).some(
				([key, value]) =>
					key !== "credentialCapsuleId" && options.identity[key as keyof CloudNativeToolIdentity] !== value,
			) ||
			!UUID.test(options.identity.companyId) ||
			!UUID.test(options.identity.environmentId)
		)
			throw new Error("Company folder client does not match the admitted run");
		this.#identity = Object.freeze({ ...options.identity });
		this.#control = options.control;
		this.#bytes = options.bytes;
		this.#actor = Object.freeze({
			kind: "run",
			runId: this.#binding.runId,
			jobId: this.#binding.jobId,
			runnerId: this.#binding.runnerId,
			assignmentId: this.#binding.assignmentId,
		});
	}

	/** The actor every call sends. */
	get actor(): CloudCompanyFolderRunActor {
		return this.#actor;
	}

	#call(method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					method,
					{ p_environment_id: this.#identity.environmentId, p_actor: this.#actor, ...args },
					requestSignal,
				),
			signal,
		);
	}

	async #once(method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		try {
			return await this.#call(method, args, signal);
		} catch (error) {
			throw failure(error);
		}
	}

	/** One commit or release, retried with the same key or id while SQL says to. */
	async #retried(
		method: CloudCompanyPathRpc,
		args: Record<string, unknown>,
		retryable: ReadonlySet<string>,
		signal: AbortSignal,
	): Promise<unknown> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.#call(method, args, signal);
			} catch (error) {
				if (!(error instanceof CloudCompanyFolderRpcError) || !retryable.has(error.code) || signal.aborted)
					throw failure(error);
				if (attempt === ATTEMPTS) throw new CloudCompanyFolderError("contended");
				await new Promise((resolve) => setTimeout(resolve, 20 * attempt + randomInt(20)));
				signal.throwIfAborted();
			}
		}
	}

	async read(path: string, signal: AbortSignal): Promise<CloudCompanyFolderReadResult> {
		const input = record(await this.#once("qorpera_folder_read", { p_path: parseCloudCompanyPath(path) }, signal), [
			"schema",
			"asOfSeq",
			"found",
			"entry",
		]);
		if (input.schema !== "qorpera.folder-read/v1" || typeof input.found !== "boolean") invalid();
		if (!input.found) {
			if (input.entry !== null) invalid();
			return { asOfSeq: counter(input.asOfSeq), entry: null };
		}
		const found = entry(input.entry);
		// The entry is the path's, in its stored spelling: one key, as the folder decides.
		if (companyPathKey(found.path) !== companyPathKey(path)) invalid();
		return { asOfSeq: counter(input.asOfSeq), entry: found };
	}

	/** A file's text, checked against its entry, or null when nothing is at the path. A folder, a file larger than
	 * `maxBytes`, or bytes that are not UTF-8 text are not text here. */
	async readText(
		path: string,
		maxBytes: number,
		signal: AbortSignal,
	): Promise<{ entry: CloudCompanyFolderFileEntry; text: string } | null> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid Company folder text bound");
		const { entry: found } = await this.read(path, signal);
		if (!found) return null;
		if (found.kind !== "file") throw new CloudCompanyPathNotText("Company folder path is a folder");
		if (found.file.bytes > maxBytes)
			throw new CloudCompanyPathNotText("Company folder file is larger than text here");
		const bytes = await this.#bytes.get(found.file, signal);
		if (bytes.byteLength !== found.file.bytes || sha256(bytes) !== found.file.fileSha256)
			throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new CloudCompanyPathNotText("Company folder file is not UTF-8 text");
		}
		return { entry: found, text };
	}

	/** One page of a folder's entries (or, with `recursive`, of its whole subtree), in key order. */
	async list(
		parent: string,
		options: { after?: string; limit?: number; recursive?: boolean },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderPage> {
		const limit = options.limit ?? LIST_PAGE;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_PAGE)
			throw new Error("Invalid Company folder page");
		const input = record(
			await this.#once(
				"qorpera_folder_list",
				{
					p_parent: parseCloudCompanyPath(parent, true),
					p_after: options.after === undefined ? null : parseCloudCompanyPath(options.after),
					p_limit: limit,
					p_recursive: options.recursive ?? false,
				},
				signal,
			),
			["schema", "asOfSeq", "entries", "next"],
		);
		if (
			input.schema !== "qorpera.folder-list/v1" ||
			!Array.isArray(input.entries) ||
			input.entries.length > limit ||
			(input.next !== null && typeof input.next !== "string") ||
			(input.next !== null && input.entries.length !== limit)
		)
			invalid();
		return {
			asOfSeq: counter(input.asOfSeq),
			entries: input.entries.map(entry),
			next: input.next as string | null,
		};
	}

	/** Every entry under a folder, page by page. `asOfSeq` is the first page's: a change after it may be in later
	 * pages, so a subtree delete or move that names it is refused rather than missing it (core §4). */
	async listAll(
		parent: string,
		options: { recursive?: boolean },
		signal: AbortSignal,
	): Promise<{ asOfSeq: number; entries: CloudCompanyFolderEntry[] }> {
		const entries: CloudCompanyFolderEntry[] = [];
		let asOfSeq: number | null = null;
		let after: string | undefined;
		for (;;) {
			const page = await this.list(parent, { after, recursive: options.recursive }, signal);
			asOfSeq ??= page.asOfSeq;
			entries.push(...page.entries);
			if (entries.length > MAX_LISTED) throw new Error("Company folder listing is past the core's subtree bound");
			if (page.next === null) return { asOfSeq, entries };
			after = page.next;
		}
	}

	/** Stages one file's bytes and returns its reference, checked against the bytes. */
	async #stage(
		content: CloudCompanyFolderContent,
		path: string,
		staged: Map<string, CloudFileReference>,
		signal: AbortSignal,
	): Promise<{ file: CloudCompanyFolderFile; bytes: Uint8Array }> {
		const bytes = "text" in content ? new TextEncoder().encode(content.text) : content.bytes;
		const mediaType = content.mediaType ?? mediaTypeFor(path);
		if (!MEDIA_TYPE.test(mediaType)) throw new Error("Invalid Company folder media type");
		const hash = sha256(bytes);
		let reference = staged.get(`${hash}:${mediaType}`);
		if (!reference) {
			reference = await this.#bytes.put(bytes, mediaType, signal);
			if (
				!SHA.test(reference.manifestSha256) ||
				reference.fileSha256 !== hash ||
				reference.bytes !== bytes.byteLength ||
				reference.mediaType !== mediaType
			)
				throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes were stored differently");
			staged.set(`${hash}:${mediaType}`, reference);
		}
		return {
			bytes,
			file: {
				manifestSha256: reference.manifestSha256,
				fileSha256: reference.fileSha256,
				bytes: reference.bytes,
				mediaType,
				executable: content.executable ?? false,
			},
		};
	}

	/** Commits one change set as the run (core §3). Each file's bytes are staged first; every structured file in a
	 * write or a new folder carries its parse from the shared parser, made from the same bytes, or its problems, and
	 * SQL decides each unit (RUNTIME-COMPANY-STATE-FILES.md §8). The operation key comes from the caller's tool call,
	 * so a retry replays the stored outcome. `receiptId` is the tool call's folder receipt (core C1c-2b), which a
	 * model-facing write carries once that exists. */
	async commit(
		operationKey: string,
		units: readonly CloudCompanyFolderUnit[],
		options: { reviewId?: string; receiptId?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult> {
		if (!OPERATION_KEY.test(operationKey)) throw new Error("Invalid Company folder operation key");
		if (units.length < 1 || units.length > MAX_UNITS) throw new Error("Invalid Company folder change set");
		if (
			(options.reviewId !== undefined && !UUID.test(options.reviewId)) ||
			(options.receiptId !== undefined && !UUID.test(options.receiptId))
		)
			throw new Error("Invalid Company folder review or receipt");
		const staged = new Map<string, CloudFileReference>();
		const sent: Record<string, unknown>[] = [];
		for (const unit of units) sent.push(await this.#unit(unit, staged, signal));
		const input = record(
			await this.#retried(
				"qorpera_folder_commit",
				{
					p_operation_key: operationKey,
					p_units: sent,
					...(options.reviewId === undefined ? {} : { p_review_id: options.reviewId }),
					...(options.receiptId === undefined ? {} : { p_receipt_id: options.receiptId }),
				},
				COMMIT_RETRY,
				signal,
			),
			["schema", "commitId", "seq", "replay", "units"],
		);
		if (
			input.schema !== "qorpera.folder-commit/v1" ||
			typeof input.replay !== "boolean" ||
			!Array.isArray(input.units) ||
			input.units.length !== units.length
		)
			invalid();
		const results = input.units.map((value, index) => unitResult(value, index, units[index]!));
		const seq = input.seq === null ? null : counter(input.seq);
		if ((seq === null) !== results.every((unit) => unit.outcome !== "saved")) invalid();
		return { commitId: uuid(input.commitId), seq, replay: input.replay, units: results };
	}

	async #unit(
		unit: CloudCompanyFolderUnit,
		staged: Map<string, CloudFileReference>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const version = (value: string | undefined): Record<string, unknown> => {
			if (value === undefined) return {};
			if (!UUID.test(value)) throw new Error("Invalid Company folder version");
			return { expectedVersion: value };
		};
		const asOf = (value: number | undefined): Record<string, unknown> => {
			if (value === undefined) return {};
			if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Company folder sequence");
			return { asOfSeq: value };
		};
		switch (unit.op) {
			case "write": {
				const path = parseCloudCompanyPath(unit.path);
				const { file, bytes } = await this.#stage(unit.content, path, staged, signal);
				const entry = structured(path, bytes);
				return {
					op: "write",
					path,
					file,
					...version(unit.expectedVersion),
					...(entry ? { structured: [entry] } : {}),
				};
			}
			case "mkdir":
				return { op: "mkdir", path: parseCloudCompanyPath(unit.path) };
			case "new_folder": {
				const path = parseCloudCompanyPath(unit.path);
				const contents: Record<string, unknown>[] = [];
				const entries: Record<string, unknown>[] = [];
				for (const item of unit.contents) {
					const inner = parseCloudCompanyPath(item.path);
					if (item.kind === "folder") {
						contents.push({ path: inner, kind: "folder" });
						continue;
					}
					const { file, bytes } = await this.#stage(item.content, `${path}/${inner}`, staged, signal);
					contents.push({ path: inner, kind: "file", file });
					const entry = structured(`${path}/${inner}`, bytes);
					if (entry) entries.push(entry);
				}
				return { op: "new_folder", path, contents, ...(entries.length ? { structured: entries } : {}) };
			}
			case "delete":
				return {
					op: "delete",
					path: parseCloudCompanyPath(unit.path),
					...version(unit.expectedVersion),
					...asOf(unit.asOfSeq),
				};
			case "move":
				return {
					op: "move",
					from: parseCloudCompanyPath(unit.from),
					to: parseCloudCompanyPath(unit.to),
					...version(unit.expectedVersion),
					...asOf(unit.asOfSeq),
				};
			case "copy":
				return {
					op: "copy",
					from: parseCloudCompanyPath(unit.from),
					to: parseCloudCompanyPath(unit.to),
					...version(unit.expectedVersion),
				};
		}
	}

	/** Records the reads a tool result shows the model, before the result leaves the tool (C1B §C1b-2 3; one release
	 * per tool result, F1 on #533). A listing's entries are reads too: names are content. A release id is used once:
	 * the same reads and output hash replay, anything else is refused, so the caller keeps the id and the output hash
	 * with its tool call. */
	async release(
		releaseId: string,
		reads: readonly CloudCompanyFolderRelease[],
		outputSha256: string,
		signal: AbortSignal,
	): Promise<CloudCompanyFolderReleaseResult> {
		if (!UUID.test(releaseId) || !SHA.test(outputSha256) || reads.length > MAX_RELEASED)
			throw new Error("Invalid Company folder release");
		const sent = reads.map((read) => {
			if (!UUID.test(read.version) || (read.fileSha256 !== undefined && !SHA.test(read.fileSha256)))
				throw new Error("Invalid Company folder release");
			return {
				path: parseCloudCompanyPath(read.path),
				version: read.version,
				authority: {
					resourceId: read.authority.resourceId,
					resourceRevision: read.authority.resourceRevision,
					grantId: read.authority.grantId,
					grantRevision: read.authority.grantRevision,
				},
				...(read.fileSha256 === undefined ? {} : { fileSha256: read.fileSha256 }),
			};
		});
		const input = record(
			await this.#retried(
				"qorpera_folder_record_release",
				{ p_release_id: releaseId, p_reads: sent, p_output_sha256: outputSha256 },
				RELEASE_RETRY,
				signal,
			),
			["schema", "releaseId", "reads", "replay"],
		);
		if (
			input.schema !== "qorpera.folder-release/v1" ||
			input.releaseId !== releaseId ||
			input.reads !== reads.length ||
			typeof input.replay !== "boolean"
		)
			invalid();
		return { releaseId, reads: reads.length, replay: input.replay };
	}
}

/** A structured file's entry for the commit's hook: its parse from the shared parser, made from the bytes being
 * stored, or its problems without the text (RUNTIME-COMPANY-STATE-FILES.md §8). Null for any other path. */
function structured(path: string, bytes: Uint8Array): Record<string, unknown> | null {
	const where = companyStatePath(path);
	if (!where) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return {
			path,
			kind: where.kind,
			problems: [{ line: null, key: null, code: "encoding", message: "the file is not UTF-8 text" }],
		};
	}
	const parsed = parseCompanyStateFile(path, text);
	if (!parsed) return null;
	return parsed.ok
		? { path, kind: where.kind, text, parse: parsed.file, parserVersion: COMPANY_STATE_PARSER_VERSION }
		: { path, kind: where.kind, problems: parsed.problems };
}
