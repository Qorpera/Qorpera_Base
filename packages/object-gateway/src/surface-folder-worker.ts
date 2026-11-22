import { createHash, randomUUID } from "node:crypto";
import {
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	normalizeStudioFolderRoot,
	parseStudioPatchOps,
	resolveStudioFolderPath,
	type StudioPatchOp,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	mapBounded,
	PLATFORM_ACTOR,
	PLATFORM_STAGE_CONCURRENCY,
	type PlatformFileReference,
	PlatformFolderWriter,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_SNAPSHOT_BYTES = 96 * 1024;
const DISALLOWED_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CAS_CONFLICT_REASONS = new Set(["conflict", "version_mismatch", "stale_version", "exists", "not_found"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

interface ClaimedFolderApprovedChange {
	readonly changeId: string;
	readonly kind: string;
	readonly title: string;
	readonly summary: string;
	readonly patchManifest: unknown;
	readonly affectedPaths: readonly string[];
}

interface ClaimedFolderMergeJob {
	readonly jobId: string;
	readonly kind: "land_change" | "undo_change";
	readonly surfaceId: string;
	readonly profileId: string;
	readonly environmentId: string | null;
	readonly leaseToken: string | null;
	readonly folderRoot: string | null;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly preMergeSnapshot: Readonly<Record<string, unknown>> | null;
	readonly approvedChanges: readonly ClaimedFolderApprovedChange[];
}

interface ClaimedFolderPublishJob {
	readonly jobId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly environmentId: string | null;
	readonly leaseToken: string | null;
}

interface FolderFileState {
	readonly content: string | null;
	readonly version: string | null;
	readonly isDirectory: boolean;
	readonly fileRef: PlatformFileReference | null;
}

interface FolderEntryMeta {
	readonly found: boolean;
	readonly version: string | null;
	readonly isDirectory: boolean;
	readonly manifestSha256: string | null;
	readonly fileSha256: string | null;
	readonly bytes: number;
	readonly fileRef: PlatformFileReference | null;
}

function knownExistingDirs(entries: ReadonlyMap<string, FolderFileState>): Set<string> {
	const dirs = new Set<string>();
	for (const [path, state] of entries) {
		if (state.version === null) continue;
		const parts = path.split("/");
		const limit = state.isDirectory ? parts.length : parts.length - 1;
		for (let i = 1; i <= limit; i += 1) {
			dirs.add(parts.slice(0, i).join("/"));
		}
	}
	return dirs;
}

interface FolderUndoSnapshot {
	readonly snapshotId: string;
	readonly folderRoot: string;
	readonly changeIds: readonly string[];
	readonly filesBefore: Readonly<Record<string, string | null>>;
	readonly versionsAfter?: Readonly<Record<string, string | null>>;
	readonly afterContentSha256?: Readonly<Record<string, string | null>>;
}

export interface SurfaceFolderWorkerOptions {
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly readFallback?: (profileId: string, sha256: string) => Promise<Uint8Array>;
	readonly leaseRenewIntervalMs?: number;
	readonly leaseExtendSeconds?: number;
	readonly jobTimeoutMs?: number;
	readonly completionRetryDelaysMs?: readonly number[];
	readonly onEvent?: (event: Record<string, unknown>) => void;
}

const DEFAULT_JOB_TIMEOUT_MS = 45_000;
const DEFAULT_COMPLETION_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014"]);

function isDefiniteCommitRejection(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (error instanceof ObjectDependencyError) {
		return error.status >= 400 && error.status < 500 && error.status !== 429 && !error.lockConflict;
	}
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !TRANSIENT_SQLSTATES.has(code)) {
		return true;
	}
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

function isLockConflictRollback(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (error instanceof ObjectDependencyError && error.lockConflict) return true;
	const code = (error as { code?: unknown }).code;
	return code === "40001" || code === "40P01" || code === "55P03";
}

function errorTextWithCause(error: unknown): string {
	if (!error) return "";
	const parts: string[] = [];
	let cur: unknown = error;
	for (let depth = 0; depth < 3 && cur !== undefined && cur !== null; depth += 1) {
		parts.push(cur instanceof Error ? cur.message : String(cur));
		cur = cur instanceof Error ? cur.cause : undefined;
	}
	return parts.join(" ");
}

function isExplicitNotRunningError(error: unknown): boolean {
	if (!error) return false;
	const text = errorTextWithCause(error);
	if (/surface job is not running/i.test(text)) return true;
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	return code === "55000" && /not running/i.test(text);
}

function isOpaqueStateConflict423(error: unknown): boolean {
	// WHY: SupabaseMemberCompanyAuthority maps all SQLSTATE 55000 responses to HTTP 423 ObjectDependencyError without the PostgREST message body.
	return error instanceof ObjectDependencyError && error.status === 423;
}

// WHY: Bound object-store and replication calls that do not accept an AbortSignal so per-job timeouts always release the worker.
function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		work.catch(() => undefined);
		return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			work.catch(() => undefined);
			reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

type CommittedRpcResult<T> =
	| { readonly outcome: "confirmed"; readonly value: T }
	| { readonly outcome: "already_completed" }
	| { readonly outcome: "unconfirmed_423" };

async function retryCommittedRpc<T>(
	fn: (attemptSignal: AbortSignal) => Promise<T>,
	shutdownSignal: AbortSignal | undefined,
	delaysMs: readonly number[],
	options?: { readonly treatNotRunningAsDoneOnRetry?: boolean },
): Promise<CommittedRpcResult<T>> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
		try {
			const value = await withAbortScopes([], fn, 15_000);
			return { outcome: "confirmed", value };
		} catch (error) {
			if (attempt > 0 && options?.treatNotRunningAsDoneOnRetry) {
				if (isExplicitNotRunningError(error)) {
					return { outcome: "already_completed" };
				}
				if (isOpaqueStateConflict423(error)) {
					return { outcome: "unconfirmed_423" };
				}
			}
			lastError = error;
			const delayMs = delaysMs[attempt];
			if (delayMs === undefined || shutdownSignal?.aborted) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delayMs);
				timer.unref?.();
			});
		}
	}
	throw lastError;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function mediaTypeForPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".css")) return "text/css";
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".md")) return "text/markdown";
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
	if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
	if (lower.endsWith(".ts")) return "text/typescript";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "text/yaml";
	return "text/plain";
}

function deepMergeJson(base: unknown, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const target: Record<string, unknown> =
		base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (DISALLOWED_JSON_KEYS.has(key)) continue;
		if (value === null) {
			delete target[key];
		} else if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			target[key] &&
			typeof target[key] === "object" &&
			!Array.isArray(target[key])
		) {
			target[key] = deepMergeJson(target[key], value as Record<string, unknown>);
		} else {
			target[key] = structuredClone(value);
		}
	}
	return target;
}

function parentDirectoriesOf(paths: Iterable<string>): string[] {
	const dirs = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i += 1) {
			dirs.add(parts.slice(0, i).join("/"));
		}
	}
	return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function extractStudioOps(manifest: unknown): StudioPatchOp[] {
	if (Array.isArray(manifest)) {
		return parseStudioPatchOps(manifest);
	}
	if (manifest && typeof manifest === "object" && Array.isArray((manifest as { ops?: unknown }).ops)) {
		return parseStudioPatchOps((manifest as { ops: unknown[] }).ops);
	}
	throw new Error("Folder change patch manifest is missing valid ops");
}

function parseClaimedFolderMerge(value: unknown): ClaimedFolderMergeJob | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const rec = value as Record<string, unknown>;
	if (
		typeof rec.jobId !== "string" ||
		!UUID.test(rec.jobId) ||
		(rec.kind !== "land_change" && rec.kind !== "undo_change") ||
		typeof rec.surfaceId !== "string" ||
		!UUID.test(rec.surfaceId) ||
		typeof rec.profileId !== "string" ||
		!UUID.test(rec.profileId)
	) {
		return null;
	}
	const approvedChanges: ClaimedFolderApprovedChange[] = Array.isArray(rec.approvedChanges)
		? rec.approvedChanges
				.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
				.filter((item) => typeof item.changeId === "string" && UUID.test(item.changeId))
				.map((item) => ({
					changeId: item.changeId as string,
					kind: typeof item.kind === "string" ? item.kind : "folder_patch",
					title: typeof item.title === "string" ? item.title : "",
					summary: typeof item.summary === "string" ? item.summary : "",
					patchManifest: item.patchManifest ?? null,
					affectedPaths: Array.isArray(item.affectedPaths)
						? item.affectedPaths.filter((p): p is string => typeof p === "string")
						: [],
				}))
		: [];
	return {
		jobId: rec.jobId,
		kind: rec.kind,
		surfaceId: rec.surfaceId,
		profileId: rec.profileId,
		environmentId: typeof rec.environmentId === "string" && UUID.test(rec.environmentId) ? rec.environmentId : null,
		leaseToken: typeof rec.leaseToken === "string" && UUID.test(rec.leaseToken) ? rec.leaseToken : null,
		folderRoot: typeof rec.folderRoot === "string" ? rec.folderRoot : null,
		payload:
			rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)
				? (rec.payload as Record<string, unknown>)
				: {},
		preMergeSnapshot:
			rec.preMergeSnapshot && typeof rec.preMergeSnapshot === "object" && !Array.isArray(rec.preMergeSnapshot)
				? (rec.preMergeSnapshot as Record<string, unknown>)
				: null,
		approvedChanges,
	};
}

function parseClaimedFolderPublish(value: unknown): ClaimedFolderPublishJob | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const rec = value as Record<string, unknown>;
	if (
		typeof rec.jobId !== "string" ||
		!UUID.test(rec.jobId) ||
		typeof rec.surfaceId !== "string" ||
		!UUID.test(rec.surfaceId) ||
		typeof rec.profileId !== "string" ||
		!UUID.test(rec.profileId)
	) {
		return null;
	}
	return {
		jobId: rec.jobId,
		surfaceId: rec.surfaceId,
		profileId: rec.profileId,
		environmentId: typeof rec.environmentId === "string" && UUID.test(rec.environmentId) ? rec.environmentId : null,
		leaseToken: typeof rec.leaseToken === "string" && UUID.test(rec.leaseToken) ? rec.leaseToken : null,
	};
}

function parseSnapshotRecord(raw: Record<string, unknown>): FolderUndoSnapshot | null {
	const filesBeforeRaw = raw.filesBefore;
	if (!filesBeforeRaw || typeof filesBeforeRaw !== "object" || Array.isArray(filesBeforeRaw)) {
		return null;
	}
	const filesBefore: Record<string, string | null> = {};
	for (const [path, val] of Object.entries(filesBeforeRaw as Record<string, unknown>)) {
		if (val !== null && typeof val !== "string") return null;
		filesBefore[path] = val;
	}
	const versionsAfter: Record<string, string | null> | undefined =
		raw.versionsAfter && typeof raw.versionsAfter === "object" && !Array.isArray(raw.versionsAfter)
			? Object.fromEntries(
					Object.entries(raw.versionsAfter as Record<string, unknown>).map(([k, v]) => [
						k,
						typeof v === "string" ? v : null,
					]),
				)
			: undefined;
	const afterContentSha256: Record<string, string | null> | undefined =
		raw.afterContentSha256 && typeof raw.afterContentSha256 === "object" && !Array.isArray(raw.afterContentSha256)
			? Object.fromEntries(
					Object.entries(raw.afterContentSha256 as Record<string, unknown>).map(([k, v]) => [
						k,
						typeof v === "string" ? v : null,
					]),
				)
			: undefined;
	const changeIds = Array.isArray(raw.changeIds)
		? raw.changeIds.filter((id): id is string => typeof id === "string")
		: [];
	return {
		snapshotId: typeof raw.snapshotId === "string" ? raw.snapshotId : "",
		folderRoot: typeof raw.folderRoot === "string" ? raw.folderRoot : "",
		changeIds,
		filesBefore,
		...(versionsAfter ? { versionsAfter } : {}),
		...(afterContentSha256 ? { afterContentSha256 } : {}),
	};
}

function formatError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
	return raw.replace(/\0/g, "").replace(/\s+/g, " ").trim().slice(0, 1000) || "Folder surface job failed";
}

// WHY: Executes folder-backed Studio & Identity Surface merges, undos, and publishes directly on object-gateway using PlatformFolderWriter CAS commits.
export class SurfaceFolderWorker {
	readonly #options: SurfaceFolderWorkerOptions;
	readonly #folder: PlatformFolderWriter;
	readonly #leaseRenewIntervalMs: number;
	readonly #leaseExtendSeconds: number;
	readonly #jobTimeoutMs: number;
	readonly #completionRetryDelaysMs: readonly number[];

	constructor(options: SurfaceFolderWorkerOptions) {
		this.#options = options;
		this.#folder = new PlatformFolderWriter({
			authority: options.authority,
			store: options.store,
			replication: options.replication,
			...(options.readFallback ? { readFallback: options.readFallback } : {}),
		});
		this.#leaseRenewIntervalMs = Math.max(50, options.leaseRenewIntervalMs ?? 60_000);
		this.#leaseExtendSeconds = Math.min(Math.max(30, options.leaseExtendSeconds ?? 300), 900);
		this.#jobTimeoutMs = Math.max(25, options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
		this.#completionRetryDelaysMs = options.completionRetryDelaysMs ?? DEFAULT_COMPLETION_RETRY_DELAYS_MS;
	}

	#emit(event: Record<string, unknown>): void {
		try {
			this.#options.onEvent?.(event);
		} catch {}
	}

	async processDue(limit = 8, signal?: AbortSignal): Promise<number> {
		// WHY: Combine caller shutdown signal with per-claim and per-job timeouts via withAbortScopes so timeouts always apply even when CLI passes a shutdown signal.
		const callerSignals = signal ? [signal] : [];
		const raw = (await withAbortScopes(
			callerSignals,
			(claimSignal) =>
				this.#options.authority.publisher(
					"qorpera_surface_claim_pending_jobs_for_lane",
					{ p_limit: Math.min(Math.max(1, limit), 64), p_lane: "folder" },
					claimSignal,
				),
			20_000,
		)) as { merges?: unknown; publishes?: unknown } | null;
		const merges = Array.isArray(raw?.merges)
			? raw.merges.map(parseClaimedFolderMerge).filter((j): j is ClaimedFolderMergeJob => j !== null)
			: [];
		const publishes = Array.isArray(raw?.publishes)
			? raw.publishes.map(parseClaimedFolderPublish).filter((j): j is ClaimedFolderPublishJob => j !== null)
			: [];

		const mergesByEnvironment = new Map<string, ClaimedFolderMergeJob[]>();
		for (const merge of merges) {
			const bucketKey = merge.environmentId ?? merge.surfaceId;
			const bucket = mergesByEnvironment.get(bucketKey);
			if (bucket) bucket.push(merge);
			else mergesByEnvironment.set(bucketKey, [merge]);
		}

		let handled = 0;
		if (mergesByEnvironment.size > 0) {
			await mapBounded([...mergesByEnvironment.values()], PLATFORM_STAGE_CONCURRENCY, async (envMerges) => {
				for (const merge of envMerges) {
					if (signal?.aborted) break;
					await withAbortScopes(
						callerSignals,
						(jobSignal) =>
							this.#withJobLease(merge.jobId, merge.leaseToken, jobSignal, () =>
								this.#handleMerge(merge, jobSignal, signal),
							),
						this.#jobTimeoutMs,
					);
					handled += 1;
				}
			});
		}
		if (publishes.length > 0 && !signal?.aborted) {
			await mapBounded(publishes, PLATFORM_STAGE_CONCURRENCY, async (pub) => {
				if (signal?.aborted) return;
				await withAbortScopes(
					callerSignals,
					(jobSignal) =>
						this.#withJobLease(pub.jobId, pub.leaseToken, jobSignal, () =>
							this.#handlePublish(pub, jobSignal, signal),
						),
					this.#jobTimeoutMs,
				);
				handled += 1;
			});
		}
		return handled;
	}

	async #withJobLease<T>(
		jobId: string,
		leaseToken: string | null,
		signal: AbortSignal,
		work: () => Promise<T>,
	): Promise<T> {
		if (!leaseToken) return await work();
		let renewing = false;
		const timer = setInterval(() => {
			if (signal.aborted || renewing) return;
			renewing = true;
			void this.#options.authority
				.publisher(
					"qorpera_surface_renew_lease",
					{
						p_kind: "job",
						p_id: jobId,
						p_lease_token: leaseToken,
						p_extend_seconds: this.#leaseExtendSeconds,
					},
					signal,
				)
				.catch(() => undefined)
				.finally(() => {
					renewing = false;
				});
		}, this.#leaseRenewIntervalMs);
		timer.unref?.();
		try {
			return await work();
		} finally {
			clearInterval(timer);
		}
	}

	async #readFolderMeta(environmentId: string, path: string, signal: AbortSignal): Promise<FolderEntryMeta> {
		const response = (await this.#options.authority.publisher(
			"qorpera_folder_read",
			{ p_environment_id: environmentId, p_actor: PLATFORM_ACTOR, p_path: path },
			signal,
		)) as {
			schema?: unknown;
			found?: unknown;
			entry?: {
				kind?: unknown;
				version?: unknown;
				manifestSha256?: unknown;
				fileSha256?: unknown;
				bytes?: unknown;
				mediaType?: unknown;
				executable?: unknown;
			} | null;
		} | null;
		if (response?.schema !== "qorpera.folder-read/v1") {
			throw new Error(`Invalid folder read response for ${path}`);
		}
		if (!response.found || !response.entry) {
			return {
				found: false,
				version: null,
				isDirectory: false,
				manifestSha256: null,
				fileSha256: null,
				bytes: 0,
				fileRef: null,
			};
		}
		const entry = response.entry;
		const version = typeof entry.version === "string" ? entry.version : null;
		if (entry.kind === "folder" || entry.kind === "dir") {
			return {
				found: true,
				version,
				isDirectory: true,
				manifestSha256: null,
				fileSha256: null,
				bytes: 0,
				fileRef: null,
			};
		}
		if (
			typeof entry.manifestSha256 !== "string" ||
			typeof entry.fileSha256 !== "string" ||
			typeof entry.bytes !== "number"
		) {
			throw new Error(`Invalid folder entry metadata for ${path}`);
		}
		const fileRef: PlatformFileReference | null =
			typeof entry.mediaType === "string" && typeof entry.executable === "boolean"
				? {
						manifestSha256: entry.manifestSha256,
						fileSha256: entry.fileSha256,
						bytes: entry.bytes,
						mediaType: entry.mediaType,
						executable: entry.executable,
					}
				: null;
		return {
			found: true,
			version,
			isDirectory: false,
			manifestSha256: entry.manifestSha256,
			fileSha256: entry.fileSha256,
			bytes: entry.bytes,
			fileRef,
		};
	}

	async #readFolderEntry(environmentId: string, path: string, signal: AbortSignal): Promise<FolderFileState> {
		const meta = await this.#readFolderMeta(environmentId, path, signal);
		if (!meta.found) {
			return { content: null, version: null, isDirectory: false, fileRef: null };
		}
		if (meta.isDirectory) {
			return { content: null, version: meta.version, isDirectory: true, fileRef: null };
		}
		const bytes = await raceSignal(
			this.#folder.read(
				environmentId,
				{
					manifestSha256: meta.manifestSha256 as string,
					fileSha256: meta.fileSha256 as string,
					bytes: meta.bytes,
				},
				MAX_READ_BYTES,
				signal,
			),
			signal,
		);
		return { content: UTF8_DECODER.decode(bytes), version: meta.version, isDirectory: false, fileRef: meta.fileRef };
	}

	async #findMissingDirectories(
		environmentId: string,
		writePaths: readonly string[],
		knownEntries: ReadonlyMap<string, FolderFileState>,
		signal: AbortSignal,
	): Promise<string[]> {
		const existingDirs = knownExistingDirs(knownEntries);
		const candidateDirs = parentDirectoriesOf(writePaths).filter((dir) => !existingDirs.has(dir));
		if (candidateDirs.length === 0) return [];
		const dirStates = await mapBounded(
			candidateDirs,
			PLATFORM_STAGE_CONCURRENCY,
			(dir, _index, stepSignal) => this.#readFolderMeta(environmentId, dir, stepSignal),
			signal,
		);
		const missingDirs: string[] = [];
		for (let i = 0; i < candidateDirs.length; i += 1) {
			const dirState = dirStates[i];
			if (dirState && !dirState.isDirectory && dirState.version === null) {
				missingDirs.push(candidateDirs[i] as string);
			}
		}
		return missingDirs;
	}

	async #handleMerge(
		job: ClaimedFolderMergeJob,
		signal: AbortSignal,
		shutdownSignal: AbortSignal | undefined,
	): Promise<void> {
		let committed = false;
		const markCommitted = () => {
			committed = true;
		};
		try {
			if (!job.environmentId) {
				throw new Error("Surface folder job is missing environmentId");
			}
			if (job.kind === "undo_change") {
				await this.#handleUndo(job, job.environmentId, signal, shutdownSignal, markCommitted);
				return;
			}
			await this.#handleLand(job, job.environmentId, signal, shutdownSignal, markCommitted);
		} catch (error) {
			const errorDetail = formatError(error);
			if (committed) {
				// WHY: Never report status='failed' after PlatformFolderWriter already committed; that would re-queue and corrupt filesBefore undo snapshots.
				this.#emit({
					kind: "surface_folder_merge_completion_failed",
					jobId: job.jobId,
					error: errorDetail,
				});
				return;
			}
			this.#emit({ kind: "surface_folder_merge_failed", jobId: job.jobId, error: errorDetail });
			if (!shutdownSignal?.aborted) {
				await withAbortScopes(
					shutdownSignal ? [shutdownSignal] : [],
					(failSignal) => this.#completeMerge(job, { status: "failed", errorDetail }, failSignal),
					10_000,
				).catch(() => undefined);
			}
		}
	}

	async #handleLand(
		job: ClaimedFolderMergeJob,
		environmentId: string,
		signal: AbortSignal,
		shutdownSignal: AbortSignal | undefined,
		markCommitted: () => void,
	): Promise<void> {
		const folderRoot = normalizeStudioFolderRoot(job.folderRoot);
		if (job.approvedChanges.length === 0) {
			throw new Error("Folder merge job has no approved changes");
		}

		const resolvedOps: { readonly path: string; readonly op: StudioPatchOp }[] = [];
		const touchedPaths = new Set<string>();
		for (const change of job.approvedChanges) {
			const ops = extractStudioOps(change.patchManifest);
			for (const op of ops) {
				const fullPath = resolveStudioFolderPath(folderRoot, op.path);
				resolvedOps.push({ path: fullPath, op });
				touchedPaths.add(fullPath);
			}
		}
		if (touchedPaths.has(IDENTITY_TOKENS_JSON_PATH)) {
			touchedPaths.add(IDENTITY_TOKENS_CSS_PATH);
		}

		const touchedList = [...touchedPaths];
		const readStates = await mapBounded(
			touchedList,
			PLATFORM_STAGE_CONCURRENCY,
			(path, _index, stepSignal) => this.#readFolderEntry(environmentId, path, stepSignal),
			signal,
		);
		const currentByPath = new Map<string, FolderFileState>();
		for (let i = 0; i < touchedList.length; i += 1) {
			currentByPath.set(touchedList[i] as string, readStates[i] as FolderFileState);
		}

		const working = new Map<string, string | null>();
		const filesBefore: Record<string, string | null> = {};
		for (const [path, state] of currentByPath) {
			if (state.isDirectory) {
				throw new Error(`Cannot patch folder path as a file: ${path}`);
			}
			working.set(path, state.content);
			filesBefore[path] = state.content;
		}

		for (const { path, op } of resolvedOps) {
			if (op.op === "write_text") {
				working.set(path, op.content);
			} else if (op.op === "delete") {
				working.set(path, null);
			} else if (op.op === "merge_json") {
				const prior = working.get(path);
				let parsed: unknown = {};
				if (prior !== null && prior !== undefined && prior.trim().length > 0) {
					try {
						parsed = JSON.parse(prior);
					} catch {
						throw new Error(`Existing file is not valid JSON for merge_json: ${path}`);
					}
				}
				const merged = deepMergeJson(parsed, op.patch);
				working.set(path, `${JSON.stringify(merged, null, 2)}\n`);
			}
		}

		if (touchedPaths.has(IDENTITY_TOKENS_JSON_PATH)) {
			const nextTokens = working.get(IDENTITY_TOKENS_JSON_PATH);
			if (typeof nextTokens === "string") {
				const compiledCss = compileIdentityTokensCss(nextTokens);
				if (compiledCss.trim().length > 0) {
					working.set(IDENTITY_TOKENS_CSS_PATH, compiledCss);
				}
			}
		}

		const writesToStage: {
			readonly path: string;
			readonly content: string;
			readonly expectedVersion: string | null;
		}[] = [];
		const reusedWriteUnits: {
			readonly path: string;
			readonly file: PlatformFileReference;
			readonly expectedVersion: string;
		}[] = [];
		const deleteUnits: { readonly path: string; readonly expectedVersion: string }[] = [];
		for (const [path, nextContent] of working) {
			const priorState = currentByPath.get(path);
			if (nextContent === null) {
				if (!priorState || priorState.version === null) continue;
				deleteUnits.push({ path, expectedVersion: priorState.version });
			} else if (
				priorState &&
				priorState.version !== null &&
				priorState.content === nextContent &&
				priorState.fileRef !== null
			) {
				reusedWriteUnits.push({ path, file: priorState.fileRef, expectedVersion: priorState.version });
			} else {
				writesToStage.push({ path, content: nextContent, expectedVersion: priorState?.version ?? null });
			}
		}

		const [missingDirs, stagedFiles] = await Promise.all([
			this.#findMissingDirectories(
				environmentId,
				writesToStage.map((entry) => entry.path),
				currentByPath,
				signal,
			),
			mapBounded(
				writesToStage,
				PLATFORM_STAGE_CONCURRENCY,
				async (entry, _index, stepSignal) =>
					await raceSignal(
						this.#folder.stage(
							environmentId,
							UTF8_ENCODER.encode(entry.content),
							{ mediaType: mediaTypeForPath(entry.path), executable: false },
							stepSignal,
							{ profileId: job.profileId },
						),
						stepSignal,
					),
				signal,
			),
		]);

		const units: Record<string, unknown>[] = [];
		const unitPaths: (string | null)[] = [];
		for (const dir of missingDirs) {
			units.push({ op: "mkdir", path: dir });
			unitPaths.push(null);
		}
		for (const del of deleteUnits) {
			units.push({ op: "delete", path: del.path, expectedVersion: del.expectedVersion });
			unitPaths.push(del.path);
		}
		for (const reused of reusedWriteUnits) {
			units.push({
				op: "write",
				path: reused.path,
				file: reused.file,
				expectedVersion: reused.expectedVersion,
			});
			unitPaths.push(reused.path);
		}
		for (let i = 0; i < writesToStage.length; i += 1) {
			const entry = writesToStage[i]!;
			const file = stagedFiles[i]!;
			units.push({
				op: "write",
				path: entry.path,
				file,
				...(entry.expectedVersion ? { expectedVersion: entry.expectedVersion } : {}),
			});
			unitPaths.push(entry.path);
		}

		if (units.length === 0) {
			await this.#completeMerge(job, { status: "landed", preMergeSnapshot: null }, signal);
			return;
		}

		// WHY: Refuse to start qorpera_folder_commit if the job deadline already fired, then decouple the in-flight commit and operation-key replays from jobSignal so an abort never marks a committed write failed.
		signal.throwIfAborted();
		const commitResult = await this.#commitUnits(
			environmentId,
			`surface-merge:${job.jobId}`,
			units,
			unitPaths,
			shutdownSignal,
			markCommitted,
		);
		if (commitResult.status === "conflict") {
			await withAbortScopes(
				shutdownSignal ? [shutdownSignal] : [],
				(outcomeSignal) =>
					this.#completeMerge(
						job,
						{
							status: "conflicted",
							conflictPaths: commitResult.conflictPaths,
							errorDetail: "One or more files changed while landing this Studio patch",
						},
						outcomeSignal,
					),
				10_000,
			);
			return;
		}
		if (commitResult.status === "failed") {
			await withAbortScopes(
				shutdownSignal ? [shutdownSignal] : [],
				(outcomeSignal) =>
					this.#completeMerge(job, { status: "failed", errorDetail: commitResult.errorDetail }, outcomeSignal),
				10_000,
			);
			return;
		}
		markCommitted();

		const versionsAfter: Record<string, string | null> = {};
		const afterContentSha256: Record<string, string | null> = {};
		for (const [path, content] of working) {
			versionsAfter[path] = commitResult.versionsAfter[path] ?? null;
			afterContentSha256[path] = content === null ? null : sha256Hex(content);
		}

		const changeIds = job.approvedChanges.map((c) => c.changeId);
		const inlineSnapshot: Record<string, unknown> = {
			folderRoot,
			changeIds,
			filesBefore,
			versionsAfter,
			afterContentSha256,
		};
		let preMergeSnapshot: Record<string, unknown> = inlineSnapshot;
		if (Buffer.byteLength(JSON.stringify(inlineSnapshot), "utf8") > MAX_INLINE_SNAPSHOT_BYTES) {
			const snapshotId = randomUUID();
			await retryCommittedRpc(
				(attemptSignal) =>
					this.#options.authority.publisher(
						"qorpera_surface_save_folder_snapshot",
						{
							p_profile_id: job.profileId,
							p_surface_id: job.surfaceId,
							p_snapshot_id: snapshotId,
							p_folder_root: folderRoot,
							p_change_ids: changeIds,
							p_files_before: filesBefore,
							p_versions_after: versionsAfter,
							p_after_content_sha256: afterContentSha256,
						},
						attemptSignal,
					),
				shutdownSignal,
				this.#completionRetryDelaysMs,
			);
			preMergeSnapshot = {
				externalSnapshotId: snapshotId,
				folderRoot,
				changeIds,
			};
		}

		const completion = await retryCommittedRpc(
			(attemptSignal) => this.#completeMerge(job, { status: "landed", preMergeSnapshot }, attemptSignal),
			shutdownSignal,
			this.#completionRetryDelaysMs,
			{ treatNotRunningAsDoneOnRetry: true },
		);
		if (completion.outcome === "unconfirmed_423") {
			this.#emit({
				kind: "surface_folder_merge_completion_unconfirmed",
				jobId: job.jobId,
				surfaceId: job.surfaceId,
				status: 423,
			});
			return;
		}
		this.#emit({
			kind: "surface_folder_merge_landed",
			jobId: job.jobId,
			surfaceId: job.surfaceId,
			paths: [...working.keys()],
		});
	}

	async #handleUndo(
		job: ClaimedFolderMergeJob,
		environmentId: string,
		signal: AbortSignal,
		shutdownSignal: AbortSignal | undefined,
		markCommitted: () => void,
	): Promise<void> {
		let snapshot: FolderUndoSnapshot | null = null;
		const inline = job.preMergeSnapshot;
		const externalSnapshotId =
			inline && typeof inline.externalSnapshotId === "string" ? inline.externalSnapshotId : null;
		const targetChangeId =
			typeof job.payload.changeId === "string" && UUID.test(job.payload.changeId)
				? job.payload.changeId
				: Array.isArray(job.payload.changeIds) &&
						typeof job.payload.changeIds[0] === "string" &&
						UUID.test(job.payload.changeIds[0])
					? job.payload.changeIds[0]
					: null;

		if (inline && !externalSnapshotId) {
			snapshot = parseSnapshotRecord(inline);
		}
		if (!snapshot && (externalSnapshotId || targetChangeId)) {
			const loaded = (await this.#options.authority.publisher(
				"qorpera_surface_load_folder_snapshot",
				{
					p_profile_id: job.profileId,
					p_surface_id: job.surfaceId,
					p_change_id: targetChangeId,
					p_snapshot_id: externalSnapshotId,
				},
				signal,
			)) as Record<string, unknown> | null;
			if (loaded) {
				snapshot = parseSnapshotRecord(loaded);
			}
		}
		if (!snapshot) {
			await this.#completeMerge(
				job,
				{ status: "failed", errorDetail: "Pre-merge folder snapshot not found for rollback" },
				signal,
			);
			return;
		}

		const beforePaths = Object.keys(snapshot.filesBefore);
		const readStates = await mapBounded(
			beforePaths,
			PLATFORM_STAGE_CONCURRENCY,
			(path, _index, stepSignal) => this.#readFolderEntry(environmentId, path, stepSignal),
			signal,
		);
		const currentByPath = new Map<string, FolderFileState>();
		const conflictPaths: string[] = [];
		for (let i = 0; i < beforePaths.length; i += 1) {
			const path = beforePaths[i] as string;
			const current = readStates[i] as FolderFileState;
			currentByPath.set(path, current);
			if (snapshot.versionsAfter && Object.hasOwn(snapshot.versionsAfter, path)) {
				const expectedVersion = snapshot.versionsAfter[path] ?? null;
				if (current.version !== expectedVersion) {
					conflictPaths.push(path);
				}
			} else if (snapshot.afterContentSha256 && Object.hasOwn(snapshot.afterContentSha256, path)) {
				const expectedSha = snapshot.afterContentSha256[path] ?? null;
				const currentSha = current.content === null ? null : sha256Hex(current.content);
				if (currentSha !== expectedSha) {
					conflictPaths.push(path);
				}
			}
		}

		if (conflictPaths.length > 0) {
			await this.#completeMerge(
				job,
				{
					status: "conflicted",
					conflictPaths,
					errorDetail: "Files changed after this Studio patch landed; rollback requires manual review",
				},
				signal,
			);
			return;
		}

		const writesToStage: {
			readonly path: string;
			readonly content: string;
			readonly expectedVersion: string | null;
		}[] = [];
		const reusedWriteUnits: {
			readonly path: string;
			readonly file: PlatformFileReference;
			readonly expectedVersion: string;
		}[] = [];
		const deleteUnits: { readonly path: string; readonly expectedVersion: string }[] = [];
		for (const [path, beforeContent] of Object.entries(snapshot.filesBefore)) {
			const current = currentByPath.get(path);
			if (beforeContent === null) {
				if (!current || current.version === null) continue;
				deleteUnits.push({ path, expectedVersion: current.version });
			} else if (
				current &&
				current.version !== null &&
				current.content === beforeContent &&
				current.fileRef !== null
			) {
				reusedWriteUnits.push({ path, file: current.fileRef, expectedVersion: current.version });
			} else {
				writesToStage.push({ path, content: beforeContent, expectedVersion: current?.version ?? null });
			}
		}

		const [missingDirs, stagedFiles] = await Promise.all([
			this.#findMissingDirectories(
				environmentId,
				writesToStage.map((entry) => entry.path),
				currentByPath,
				signal,
			),
			mapBounded(
				writesToStage,
				PLATFORM_STAGE_CONCURRENCY,
				async (entry, _index, stepSignal) =>
					await raceSignal(
						this.#folder.stage(
							environmentId,
							UTF8_ENCODER.encode(entry.content),
							{ mediaType: mediaTypeForPath(entry.path), executable: false },
							stepSignal,
							{ profileId: job.profileId },
						),
						stepSignal,
					),
				signal,
			),
		]);

		const units: Record<string, unknown>[] = [];
		const unitPaths: (string | null)[] = [];
		for (const dir of missingDirs) {
			units.push({ op: "mkdir", path: dir });
			unitPaths.push(null);
		}
		for (const del of deleteUnits) {
			units.push({ op: "delete", path: del.path, expectedVersion: del.expectedVersion });
			unitPaths.push(del.path);
		}
		for (const reused of reusedWriteUnits) {
			units.push({
				op: "write",
				path: reused.path,
				file: reused.file,
				expectedVersion: reused.expectedVersion,
			});
			unitPaths.push(reused.path);
		}
		for (let i = 0; i < writesToStage.length; i += 1) {
			const entry = writesToStage[i]!;
			const file = stagedFiles[i]!;
			units.push({
				op: "write",
				path: entry.path,
				file,
				...(entry.expectedVersion ? { expectedVersion: entry.expectedVersion } : {}),
			});
			unitPaths.push(entry.path);
		}

		if (units.length === 0) {
			await this.#completeMerge(job, { status: "landed" }, signal);
			return;
		}

		signal.throwIfAborted();
		const commitResult = await this.#commitUnits(
			environmentId,
			`surface-undo:${job.jobId}`,
			units,
			unitPaths,
			shutdownSignal,
			markCommitted,
		);
		if (commitResult.status === "conflict") {
			await withAbortScopes(
				shutdownSignal ? [shutdownSignal] : [],
				(outcomeSignal) =>
					this.#completeMerge(
						job,
						{
							status: "conflicted",
							conflictPaths: commitResult.conflictPaths,
							errorDetail: "Files changed concurrently during Studio rollback",
						},
						outcomeSignal,
					),
				10_000,
			);
			return;
		}
		if (commitResult.status === "failed") {
			await withAbortScopes(
				shutdownSignal ? [shutdownSignal] : [],
				(outcomeSignal) =>
					this.#completeMerge(job, { status: "failed", errorDetail: commitResult.errorDetail }, outcomeSignal),
				10_000,
			);
			return;
		}
		markCommitted();

		const completion = await retryCommittedRpc(
			(attemptSignal) => this.#completeMerge(job, { status: "landed" }, attemptSignal),
			shutdownSignal,
			this.#completionRetryDelaysMs,
			{ treatNotRunningAsDoneOnRetry: true },
		);
		if (completion.outcome === "unconfirmed_423") {
			this.#emit({
				kind: "surface_folder_undo_completion_unconfirmed",
				jobId: job.jobId,
				surfaceId: job.surfaceId,
				status: 423,
			});
			return;
		}
		this.#emit({ kind: "surface_folder_undo_landed", jobId: job.jobId, surfaceId: job.surfaceId });
	}

	async #commitUnits(
		environmentId: string,
		operationKey: string,
		units: readonly Record<string, unknown>[],
		unitPaths: readonly (string | null)[],
		shutdownSignal: AbortSignal | undefined,
		markCommitUncertain: () => void,
	): Promise<
		| { readonly status: "saved"; readonly versionsAfter: Record<string, string | null> }
		| { readonly status: "conflict"; readonly conflictPaths: string[] }
		| { readonly status: "failed"; readonly errorDetail: string }
	> {
		// WHY: qorpera_folder_commit replays idempotently by operationKey, so retry uncertain transport/timeout errors under a fresh 20 s signal while failing immediately on definite 4xx/SQLSTATE rollbacks.
		let raw: { schema?: unknown; units?: unknown } | null = null;
		let sawUncertainError = false;
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#completionRetryDelaysMs.length; attempt += 1) {
			try {
				raw = (await withAbortScopes(
					[],
					(commitSignal) => this.#folder.commit(environmentId, operationKey, units, commitSignal),
					20_000,
				)) as { schema?: unknown; units?: unknown } | null;
				lastError = undefined;
				break;
			} catch (error) {
				if (!sawUncertainError && isDefiniteCommitRejection(error)) {
					return { status: "failed", errorDetail: formatError(error) };
				}
				if (!isLockConflictRollback(error)) {
					sawUncertainError = true;
				}
				lastError = error;
				const delayMs = this.#completionRetryDelaysMs[attempt];
				if (delayMs === undefined || shutdownSignal?.aborted) break;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, delayMs);
					timer.unref?.();
				});
			}
		}
		if (lastError !== undefined) {
			if (sawUncertainError) {
				markCommitUncertain();
			}
			throw lastError;
		}
		if (
			raw?.schema !== "qorpera.folder-commit/v1" ||
			!Array.isArray(raw.units) ||
			raw.units.length !== units.length
		) {
			return { status: "failed", errorDetail: "Unexpected folder commit response" };
		}
		const versionsAfter: Record<string, string | null> = {};
		const conflictPaths: string[] = [];
		const failureReasons: string[] = [];
		for (let i = 0; i < raw.units.length; i += 1) {
			const unit = raw.units[i] as { outcome?: unknown; reason?: unknown; version?: unknown };
			const path = unitPaths[i];
			if (unit?.outcome === "saved") {
				if (path) {
					versionsAfter[path] = typeof unit.version === "string" ? unit.version : null;
				}
				continue;
			}
			const reason = typeof unit?.reason === "string" ? unit.reason : String(unit?.outcome ?? "refused");
			if (CAS_CONFLICT_REASONS.has(reason)) {
				if (path) conflictPaths.push(path);
			} else {
				failureReasons.push(path ? `${path}: ${reason}` : reason);
			}
		}
		if (conflictPaths.length > 0) {
			return { status: "conflict", conflictPaths: [...new Set(conflictPaths)] };
		}
		if (failureReasons.length > 0) {
			return { status: "failed", errorDetail: failureReasons.join("; ").slice(0, 1000) };
		}
		return { status: "saved", versionsAfter };
	}

	async #handlePublish(
		job: ClaimedFolderPublishJob,
		signal: AbortSignal,
		shutdownSignal: AbortSignal | undefined,
	): Promise<void> {
		try {
			await this.#options.authority.publisher(
				"qorpera_surface_complete_publish",
				{
					p_job_id: job.jobId,
					p_status: "published",
					p_published_head_sha: null,
					p_error_detail: null,
					p_lease_token: job.leaseToken,
				},
				signal,
			);
			this.#emit({ kind: "surface_folder_publish_completed", jobId: job.jobId, surfaceId: job.surfaceId });
		} catch (error) {
			const errorDetail = formatError(error);
			this.#emit({ kind: "surface_folder_publish_failed", jobId: job.jobId, error: errorDetail });
			if (!shutdownSignal?.aborted) {
				await withAbortScopes(
					shutdownSignal ? [shutdownSignal] : [],
					(failSignal) =>
						this.#options.authority.publisher(
							"qorpera_surface_complete_publish",
							{
								p_job_id: job.jobId,
								p_status: "failed",
								p_published_head_sha: null,
								p_error_detail: errorDetail,
								p_lease_token: job.leaseToken,
							},
							failSignal,
						),
					10_000,
				).catch(() => undefined);
			}
		}
	}

	async #completeMerge(
		job: ClaimedFolderMergeJob,
		outcome: {
			readonly status: "landed" | "conflicted" | "failed";
			readonly conflictPaths?: readonly string[];
			readonly errorDetail?: string;
			readonly preMergeSnapshot?: Record<string, unknown> | null;
		},
		signal: AbortSignal,
	): Promise<void> {
		await this.#options.authority.publisher(
			"qorpera_surface_complete_merge",
			{
				p_job_id: job.jobId,
				p_status: outcome.status,
				p_main_before: null,
				p_main_after: null,
				p_conflict_change_id: null,
				p_conflict_paths: outcome.conflictPaths ? [...outcome.conflictPaths] : null,
				p_error_detail: outcome.errorDetail ?? null,
				p_pre_merge_snapshot: outcome.preMergeSnapshot ?? null,
				p_lease_token: job.leaseToken,
			},
			signal,
		);
	}
}
