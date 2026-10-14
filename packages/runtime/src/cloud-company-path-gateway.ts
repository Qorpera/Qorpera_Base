import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import type { CloudCompanyTreeEntry } from "@qorpera/cloud-client/node/cloud-company-snapshot";
import type { CloudContentAddressedStore, CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import { parseCompanyComputerScreenshotAsset } from "./cloud-company-computer-screenshots.ts";
import { CloudCompanyPathRpcMissing, CloudCompanyPathRpcPrecondition } from "./cloud-company-path-refusal.ts";
import type { CloudNativeFenceRequest } from "./cloud-native-result-fence.ts";
import {
	CLOUD_TOOL_REQUEST_MAX_MS,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import type { CloudNativeFencedResult } from "./cloud-native-tool-boundary.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const FILE_SCHEMA = "qorpera.cloud-file-manifest/v1";
const FILE_MEDIA = "application/vnd.qorpera.file-manifest+json";
const MAX_WRITE_BYTES = 32 * 1024;
/** The plain listing RPC's largest page (SQL: p_limit 1..100). */
const TRUSTED_LIST_PAGE = 100;
/** Fresh starts of a paged trusted listing after the company moved on between pages. */
const TRUSTED_LIST_ATTEMPTS = 4;

export type CloudCompanyPathRpc =
	| "qorpera_manage_agent_routine"
	| "qorpera_decide_agent_routine"
	| "qorpera_manage_agent_sidebar"
	// Workers and durable todos (runtime Step 5).
	| "qorpera_describe_agent_open_work"
	| "qorpera_record_runtime_observation_batch"
	| "qorpera_record_provider_usage_signal"
	| "qorpera_begin_native_company_execution_v2"
	| "qorpera_describe_company_run_context"
	| "qorpera_list_native_connector_tools"
	| "qorpera_assert_native_connector_operation"
	| "qorpera_read_company_run_context"
	// Trusted context assembly (contract 9.1, 15.1): the agent's own memory is
	// composed before the turn without spending model-read observations.
	| "qorpera_read_company_path"
	| "qorpera_list_company_paths"
	| "qorpera_record_native_context_view"
	| "qorpera_fence_native_context"
	| "qorpera_assert_company_path_reads"
	| "qorpera_native_presence_register"
	| "qorpera_company_presence_scope"
	| "qorpera_native_presence_subject"
	| "qorpera_native_presence_forget"
	// Wake bus (runtime Step 3): authorized envelope, coworker delivery and policy guards.
	| "qorpera_read_native_wake"
	| "qorpera_send_coworker_message"
	| "qorpera_runtime_wake_policy"
	| "qorpera_assert_wake_work_allowed"
	| "qorpera_assert_wake_completion"
	// Auto-review (v130): rules, verdicts and approval cards for acting calls.
	| "qorpera_begin_action_review"
	| "qorpera_record_action_review"
	| "qorpera_await_action_review"
	| "qorpera_add_agent_review_rule"
	// Machines agents start (2026-09-28).
	| "qorpera_native_machine_start"
	| "qorpera_native_machine_manage"
	| "qorpera_company_machines_available"
	// The folder core for folder-v2 companies (core C3): reads, listings, change sets and releases.
	| "qorpera_folder_read"
	| "qorpera_folder_list"
	| "qorpera_folder_commit"
	| "qorpera_folder_record_release"
	| "qorpera_folder_run_view_open"
	// Staging a folder-v2 file's bytes (core C1d).
	| "qorpera_folder_open_upload"
	| "qorpera_folder_seal_upload"
	| "qorpera_folder_renew_upload"
	// A folder-v2 run's own todos from the todo index (thin writers W1).
	| "qorpera_folder_agent_todos"
	// An approved call's review of the change set it commits (C2 R1).
	| "qorpera_folder_record_review"
	// A folder-v2 run's own routines from the routine index, and the login a routine save pins (thin writers W4c).
	| "qorpera_folder_agent_routines"
	| "qorpera_prepare_routine_login"
	// A folder-v2 run's workers: their files under the worker tool's request, a todo's workers, and a cancel (F2-5b).
	| "qorpera_folder_worker_commit"
	| "qorpera_folder_agent_workers"
	| "qorpera_folder_cancel_agent_worker"
	// Changes a view saved that wait for review (P40): a run's list, its apply and its close.
	| "qorpera_folder_agent_proposals"
	| "qorpera_folder_apply_proposal"
	| "qorpera_folder_close_proposal"
	// A coding session's archive (C3b).
	| "qorpera_folder_archive_coding_worker"
	// Event wakes (W2): the company's hooks and one event's body.
	| "qorpera_list_agent_event_hooks"
	| "qorpera_read_agent_event"
	// A folder-v2 agent opens, pauses, resumes or removes one of the company's hooks or mailboxes (E3a).
	| "qorpera_folder_manage_hook"
	// Company mail (M2b): an agent's email from a mailbox, queued for the platform's sender; finding received mail.
	| "qorpera_send_agent_mail"
	| "qorpera_find_agent_mail"
	// Company accounts (A1-4): the company's accounts and mailboxes, and the id of the agent's todo by key.
	| "qorpera_find_company_accounts"
	// Summary trees (M1b-3): zoom, and the platform read of the tree blocks a zoom result or a view showed. The primary
	// view, its record and the branches (M1b-4a, M4).
	| "qorpera_memory_zoom"
	| "qorpera_memory_release"
	| "qorpera_memory_view"
	| "qorpera_memory_view_record"
	| "qorpera_memory_branches";

/** Service-only transport. Never exposed as an arbitrary RPC tool. */
export interface CloudCompanyPathControl {
	call(method: CloudCompanyPathRpc, argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** Only a positively identified SQL head conflict permits a rebuilt candidate. */
export class CloudCompanyHeadConflict extends Error {
	constructor() {
		super("Company File head changed");
	}
}

/** A verified file that is not UTF-8 text (or, for a trusted whole-file read,
 * larger than a text write). The bytes are intact; they are just not text here. */
export class CloudCompanyPathNotText extends Error {
	/** The whole file's size, from the entry a trusted whole-file read found; null for a range. */
	readonly bytes: number | null;
	constructor(message = "Company File range is not UTF-8 text", bytes: number | null = null) {
		super(message);
		this.bytes = bytes;
	}
}

export interface CloudCompanyPathResult {
	schema: "qorpera.company-path-result/v1";
	state: "applied" | "proposed";
	operationKey: string;
	path: string;
	version: string | null;
	snapshotId: string | null;
	receiptId: string;
	proposalId: string | null;
}

function closed(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
	)
		throw new Error("Invalid Company File data");
	return value as Record<string, unknown>;
}

function version(value: unknown, nullable = false): string | null {
	if (nullable && value === null) return null;
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid Company File version");
	return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new Error("Invalid Company File bound");
	return value as number;
}

function fileReference(value: unknown): CloudFileReference {
	const file = closed(value, ["manifestSha256", "fileSha256", "bytes", "mediaType"]);
	if (
		typeof file.manifestSha256 !== "string" ||
		!SHA.test(file.manifestSha256) ||
		typeof file.fileSha256 !== "string" ||
		!SHA.test(file.fileSha256) ||
		file.mediaType !== "application/octet-stream"
	)
		throw new Error("Invalid Company File reference");
	return {
		manifestSha256: file.manifestSha256,
		fileSha256: file.fileSha256,
		bytes: integer(file.bytes, 0, 1024 ** 4),
		mediaType: file.mediaType,
	};
}

function entry(value: unknown): CloudCompanyTreeEntry {
	const input = closed(value, ["path", "kind"], ["executable", "file"]);
	const path = parseCloudCompanyPath(input.path);
	if (input.kind === "directory" && Object.keys(input).length === 2) return { path, kind: "directory" };
	if (input.kind !== "file" || typeof input.executable !== "boolean" || Object.keys(input).length !== 4)
		throw new Error("Invalid Company File entry");
	return { kind: "file", path, executable: input.executable, file: fileReference(input.file) };
}

/**
 * Trusted cloud adapter over one live immutable tree. It never materializes a
 * Company File checkout, takes a filesystem path, or returns hidden siblings
 * or object capabilities to a model. It writes no file: the folder core owns every write.
 */
export class CloudCompanyPathGateway {
	readonly #binding: CloudNativeToolBinding;
	readonly #identity: CloudNativeToolIdentity;
	readonly #control: CloudCompanyPathControl;
	readonly #store: CloudContentAddressedStore;
	/** The database has no one-call fence yet (a runtime ahead of 20260929400000). */
	#fenceUnavailable = false;

	constructor(options: {
		binding: CloudNativeToolBinding;
		identity: CloudNativeToolIdentity;
		control: CloudCompanyPathControl;
		store: CloudContentAddressedStore;
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
			throw new Error("Company File gateway does not match the admitted run");
		this.#identity = Object.freeze({ ...options.identity });
		this.#control = options.control;
		this.#store = options.store;
	}

	async #call(
		method: CloudCompanyPathRpc,
		argumentsValue: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown> {
		return await cloudToolRequest(
			(requestSignal) => this.#control.call(method, argumentsValue, requestSignal),
			signal,
			timeoutMs,
		);
	}

	#bound(): { p_environment_id: string; p_binding: CloudNativeToolBinding } {
		return { p_environment_id: this.#identity.environmentId, p_binding: this.#binding };
	}

	/** Required before every model request, including prewarm and compaction. SQL checks
	 * the run's whole read set. The gateway itself names no path any more: a folder-v2
	 * run's reads come from the folder tools, so it sends none. */
	async assertReadableContext(signal: AbortSignal): Promise<void> {
		const checked = await this.#call("qorpera_assert_company_path_reads", { ...this.#bound(), p_paths: [] }, signal);
		if (checked !== null) throw new Error("Invalid Company File context authorization");
	}

	/** Called by the native fence with host-fenced outputs only, before release. */
	async recordContextView(
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	): Promise<void> {
		this.#assertContextReceipt(
			await this.#call(
				"qorpera_record_native_context_view",
				{ ...this.#bound(), p_view: this.#contextView(frame, outputs) },
				signal,
			),
			frame,
		);
	}

	/**
	 * The one database call before a model request (qorpera_fence_native_context,
	 * 20260929400000). In one transaction it makes every check the host made in four
	 * rounds: run authority and the run's read set, again, then records this view
	 * (which checks both itself), then both once more. Returns the run's authority as
	 * the last check read it, or undefined when the database does not have the call
	 * yet; the caller then makes the separate calls, all of them. It sends no path, so
	 * the call can report none kept.
	 */
	async fenceContextView(
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	): Promise<unknown> {
		if (this.#fenceUnavailable) return undefined;
		const view = this.#contextView(frame, outputs);
		let value: unknown;
		try {
			// The run's retry decides how long each attempt waits (CloudNativeToolRun.assertActiveWith).
			value = await this.#call(
				"qorpera_fence_native_context",
				{ ...this.#bound(), p_paths: [], p_view: view },
				signal,
				CLOUD_TOOL_REQUEST_MAX_MS,
			);
		} catch (error) {
			// Nothing ran: PostgREST found no such function.
			if (error instanceof CloudCompanyPathRpcMissing && !signal.aborted) {
				this.#fenceUnavailable = true;
				return undefined;
			}
			throw error;
		}
		const fenced = closed(value, ["schema", "authority", "receipt", "kept"]);
		if (
			fenced.schema !== "qorpera.native-context-fence/v1" ||
			!Array.isArray(fenced.kept) ||
			fenced.kept.length !== 0
		)
			throw new Error("Native context provenance was not confirmed");
		this.#assertContextReceipt(fenced.receipt, frame);
		return fenced.authority;
	}

	#contextView(frame: CloudNativeFenceRequest, outputs: readonly CloudNativeFencedResult[]): Record<string, unknown> {
		return {
			schema: "qorpera.native-context-view/v1",
			requestId: frame.requestId,
			threadId: frame.threadId,
			turnId: frame.turnId || null,
			purpose: frame.purpose,
			outputs: outputs.map((output) => {
				const envelope = JSON.parse(output.output) as {
					status?: string;
					provenance?: { companyReadId?: string; companyId?: string; runId?: string; tool?: string };
					content?: { sha256?: string; text?: string; includedBytes?: number };
				};
				const capture = output.capture ? parseCompanyComputerScreenshotAsset(output.capture) : undefined;
				if (
					output.imageSha256 !== capture?.sha256 ||
					(capture &&
						(envelope.status !== "ok" ||
							envelope.provenance?.tool !== "computer_screenshot" ||
							envelope.provenance?.companyId !== this.#identity.companyId ||
							envelope.provenance?.runId !== this.#identity.runId ||
							typeof envelope.content?.text !== "string" ||
							!isDeepStrictEqual(JSON.parse(envelope.content.text), capture)))
				)
					throw new Error("Native capture provenance changed");
				const readId = envelope.provenance?.companyReadId;
				if (
					readId &&
					(envelope.provenance?.companyId !== this.#identity.companyId ||
						envelope.provenance?.runId !== this.#identity.runId ||
						!UUID.test(readId) ||
						typeof envelope.content?.sha256 !== "string" ||
						!SHA.test(envelope.content.sha256) ||
						typeof envelope.content.text !== "string" ||
						envelope.content.includedBytes !== Buffer.byteLength(envelope.content.text))
				)
					throw new Error("Company File output provenance changed");
				return {
					...(capture ? { capture } : {}),
					callId: output.callId,
					kind: output.kind,
					sha256: createHash("sha256").update(output.output).digest("hex"),
					bytes: Buffer.byteLength(output.output),
					readId: readId ?? null,
					readSha256: readId ? envelope.content!.sha256! : null,
					includedBytes: readId ? envelope.content!.includedBytes! : null,
					includedSha256: readId ? createHash("sha256").update(envelope.content!.text!).digest("hex") : null,
				};
			}),
		};
	}

	#assertContextReceipt(value: unknown, frame: CloudNativeFenceRequest): void {
		const receipt = closed(value, ["schema", "viewId", "requestId", "sha256", "ordinal"]);
		if (
			receipt.schema !== "qorpera.native-context-view-receipt/v1" ||
			receipt.requestId !== frame.requestId ||
			typeof receipt.sha256 !== "string" ||
			!SHA.test(receipt.sha256)
		)
			throw new Error("Native context provenance was not confirmed");
		version(receipt.viewId);
		integer(receipt.ordinal, 1, 2_147_483_647);
	}

	/** Assemble one UTF-8 range of a verified file from its content-addressed chunks. */
	async #fileText(
		file: CloudFileReference,
		manifestSize: number,
		offset: number,
		limit: number,
		signal: AbortSignal,
	): Promise<{ text: string; included: number }> {
		const manifestBytes = await cloudToolRequest(
			() =>
				this.#store.getObject(this.#identity.companyId, {
					sha256: file.manifestSha256,
					bytes: manifestSize,
					mediaType: FILE_MEDIA,
				}),
			signal,
		);
		const manifest = closed(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)), [
			"schema",
			"fileSha256",
			"bytes",
			"mediaType",
			"chunks",
		]);
		if (
			manifest.schema !== FILE_SCHEMA ||
			manifest.fileSha256 !== file.fileSha256 ||
			manifest.bytes !== file.bytes ||
			manifest.mediaType !== file.mediaType ||
			!Array.isArray(manifest.chunks) ||
			manifest.chunks.length > 64
		)
			throw new Error("Company File manifest changed");
		const chunks = manifest.chunks.map((value, index) => {
			const chunk = closed(value, ["sha256", "bytes"]);
			if (typeof chunk.sha256 !== "string" || !SHA.test(chunk.sha256)) throw new Error("Invalid Company File chunk");
			const bytes = integer(chunk.bytes, 1, 4 * 1024 * 1024);
			if (index < (manifest.chunks as unknown[]).length - 1 && bytes !== 4 * 1024 * 1024)
				throw new Error("Invalid Company File chunk sequence");
			return { sha256: chunk.sha256, bytes };
		});
		if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== file.bytes)
			throw new Error("Invalid Company File length");
		let position = 0;
		const end = Math.min(file.bytes, offset + limit);
		const output = Buffer.alloc(end - offset);
		for (const chunk of chunks) {
			if (position < end && position + chunk.bytes > offset) {
				const bytes = await cloudToolRequest(
					() =>
						this.#store.getObject(this.#identity.companyId, { ...chunk, mediaType: "application/octet-stream" }),
					signal,
				);
				output.set(
					bytes.subarray(Math.max(0, offset - position), Math.min(chunk.bytes, end - position)),
					Math.max(0, position - offset),
				);
			}
			position += chunk.bytes;
		}
		// A whole file is also checked against its own digest, so "not text" can only ever
		// mean intact bytes that are not UTF-8, never a manifest naming the wrong chunks.
		if (offset === 0 && end === file.bytes && createHash("sha256").update(output).digest("hex") !== file.fileSha256)
			throw new Error("Company File content does not match its digest");
		// Do not split the last UTF-8 code point. Invalid binary/interior bytes
		// remain unsupported, rather than silently changing the file's text.
		let included = output.length;
		let text: string | undefined;
		for (let trim = 0; trim <= 3 && included >= 0; trim++, included--) {
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(0, included));
				break;
			} catch {
				if (end === file.bytes) break;
			}
		}
		if (text === undefined || (included === 0 && output.length > 0)) throw new CloudCompanyPathNotText();
		return { text, included };
	}

	/** Trusted whole-file read for context assembly and runtime-owned notebooks.
	 * It uses the plain path read (authority and read memory, no model-read
	 * observation, no wake-work gate), so it is not recorded as a model read
	 * and may run before the first acknowledgement. An absent path keeps the
	 * version a deletion left (null if it never existed): recreating it must
	 * name that version. Bounded to MAX_WRITE_BYTES so a notebook file can be
	 * rewritten; a larger or non-text file is CloudCompanyPathNotText, with its size. */
	async readTrusted(
		pathValue: string,
		signal: AbortSignal,
	): Promise<
		| { path: string; version: string; kind: "file" | "directory"; text: string; fileSha256: string | null }
		| { path: string; version: string | null; kind: "absent"; text: ""; fileSha256: null }
	> {
		const path = parseCloudCompanyPath(pathValue);
		const input = closed(await this.#call("qorpera_read_company_path", { ...this.#bound(), p_path: path }, signal), [
			"path",
			"version",
			"entry",
			"manifestBytes",
			"companyId",
		]);
		if (input.path !== path || input.companyId !== this.#identity.companyId)
			throw new Error("Company File read scope changed");
		if (input.entry === null)
			return { path, version: version(input.version, true), kind: "absent", text: "", fileSha256: null };
		const found = entry(input.entry);
		if (found.path !== path || input.version === null) throw new Error("Company File read target changed");
		const current = version(input.version)!;
		if (found.kind !== "file") return { path, version: current, kind: "directory", text: "", fileSha256: null };
		if (found.file.bytes > MAX_WRITE_BYTES)
			throw new CloudCompanyPathNotText("Company File notebook exceeds its bound", found.file.bytes);
		const manifestSize = integer(input.manifestBytes, 1, 8 * 1024 * 1024);
		let read: { text: string; included: number };
		try {
			read = await this.#fileText(found.file, manifestSize, 0, MAX_WRITE_BYTES, signal);
		} catch (error) {
			if (error instanceof CloudCompanyPathNotText)
				throw new CloudCompanyPathNotText(error.message, found.file.bytes);
			throw error;
		}
		if (read.included !== found.file.bytes) throw new CloudCompanyPathNotText(undefined, found.file.bytes);
		return { path, version: current, kind: "file", text: read.text, fileSha256: found.file.fileSha256 };
	}

	/** Trusted directory listing (see readTrusted): every child, page after page
	 * on one snapshot. A write anywhere in the company moves the snapshot and SQL
	 * refuses the next page (PT412); the listing then starts again from the
	 * first page. Empty for an absent directory. */
	async listTrusted(
		pathValue: string,
		signal: AbortSignal,
	): Promise<{ path: string; version: string; kind: "file" | "directory"; bytes: number | null }[]> {
		const path = parseCloudCompanyPath(pathValue, true);
		for (let attempt = 1; ; attempt++) {
			const items: { path: string; version: string; kind: "file" | "directory"; bytes: number | null }[] = [];
			let snapshotId: string | null = null;
			let after: string | null = null;
			try {
				do {
					const page = closed(
						await this.#call(
							"qorpera_list_company_paths",
							{
								...this.#bound(),
								p_path: path,
								p_after: after,
								p_snapshot_id: snapshotId,
								p_limit: TRUSTED_LIST_PAGE,
							},
							signal,
						),
						["snapshotId", "items", "hasMore", "nextAfter"],
					);
					const pinned = version(page.snapshotId)!;
					if (
						(snapshotId !== null && pinned !== snapshotId) ||
						!Array.isArray(page.items) ||
						page.items.length > TRUSTED_LIST_PAGE ||
						typeof page.hasMore !== "boolean"
					)
						throw new Error("Invalid Company File page");
					snapshotId = pinned;
					for (const value of page.items) {
						const item = closed(value, ["path", "version", "kind", "bytes"]);
						const child = parseCloudCompanyPath(item.path);
						const previous = items.at(-1)?.path;
						if (
							child.slice(0, Math.max(0, child.lastIndexOf("/"))) !== path ||
							(previous !== undefined && Buffer.compare(Buffer.from(child), Buffer.from(previous)) <= 0) ||
							(item.kind !== "directory" && item.kind !== "file") ||
							(item.kind === "directory" && item.bytes !== null)
						)
							throw new Error("Company File page includes an invalid child");
						items.push({
							path: child,
							version: version(item.version)!,
							kind: item.kind,
							bytes: item.kind === "file" ? integer(item.bytes, 0, 1024 ** 4) : null,
						});
					}
					// A page that says there is more must name where it ended, so the loop always advances.
					if (page.nextAfter !== (page.hasMore ? (page.items.length ? items.at(-1)!.path : undefined) : null))
						throw new Error("Invalid Company File page cursor");
					after = page.nextAfter as string | null;
				} while (after !== null);
				return items;
			} catch (error) {
				if (
					!(error instanceof CloudCompanyPathRpcPrecondition) ||
					after === null ||
					attempt >= TRUSTED_LIST_ATTEMPTS ||
					signal.aborted
				)
					throw error;
			}
		}
	}
}
