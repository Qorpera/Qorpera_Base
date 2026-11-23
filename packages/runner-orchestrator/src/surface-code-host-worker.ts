import { createHash } from "node:crypto";
import {
	type CloudCodingRepository,
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	isUuid,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
} from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import {
	CODE_AREA_IN_QORPERA_REF,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	keptRepositoryOf,
	withJob,
} from "./code-host-jobs.ts";
import { type CodeSiteTreeFile, CodeSiteTreeInvalid, readSurfaceSiteTree } from "./code-host-sites.ts";
import { composePreviewTree, type RebaseSessionChangesResult } from "./code-host-surfaces.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CODE_SITE_EXTENSIONS, CODE_SITE_PATH, codeSiteManifest, codeSiteTreeProblem } from "./code-site.ts";
import { CODE_SITE_LIST_BYTES, CODE_SITE_LIST_FILES, type CodeSiteTreeRead } from "./code-site-uploads.ts";
import {
	type CompleteSurfaceMergeInput,
	type CompleteSurfacePreviewInput,
	type CompleteSurfacePublishInput,
	parseClaimedSurfaceJobs,
} from "./orchestrator.ts";
import {
	createSurfaceExecutionHandlers,
	parseSurfaceRepositoryKey,
	prepareSurfaceRepository,
	type SurfaceExecutionControlPlane,
	undoSurfaceCodeRepoChange,
} from "./surface-execution-bridge.ts";
import type {
	ClaimedSurfaceMergeJob,
	ClaimedSurfacePreviewJob,
	ClaimedSurfacePublishJob,
} from "./surface-worker-loop.ts";

export const SURFACE_CODE_HOST_RPCS = [
	"qorpera_surface_claim_pending_jobs_for_lane",
	"qorpera_surface_complete_preview",
	"qorpera_surface_complete_merge",
	"qorpera_surface_complete_publish",
	"qorpera_surface_renew_lease",
	"qorpera_surface_update_rebased_changes",
	"qorpera_surface_site_version_begin",
	"qorpera_surface_site_version_list",
	"qorpera_surface_site_version_put",
	"qorpera_surface_site_version_finish",
] as const;

export type SurfaceCodeHostRpc = (typeof SURFACE_CODE_HOST_RPCS)[number];

export interface SurfaceCodeHostControl {
	call(method: SurfaceCodeHostRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface SurfaceCodeHostWorkerOptions {
	readonly control: SurfaceCodeHostControl;
	readonly hosts: Pick<CodeHostJobs, "run">;
	readonly readTree?: CodeSiteTreeRead;
	readonly batchLimit?: number;
	readonly companyConcurrency?: number;
	readonly uploadConcurrency?: number;
	readonly leaseRenewIntervalMs?: number;
	readonly leaseExtendSeconds?: number;
	readonly completionRetryDelaysMs?: readonly number[];
	readonly yieldRetryDelaysMs?: readonly number[];
	readonly report?: (event: Record<string, unknown>) => void;
}

export interface SurfaceCodeHostPassResult {
	readonly previews: number;
	readonly merges: number;
	readonly publishes: number;
	readonly failed: number;
}

const PUT_RAW_PART_BYTES = 80 * 1024;
const PUT_BATCH_MAX_JSON_BYTES = 112 * 1024;
const PUT_BATCH_MAX_PARTS = 100;
const DEFAULT_UPLOAD_CONCURRENCY = 6;
const DEFAULT_COMPANY_CONCURRENCY = 4;
const MAX_SHARED_ASSET_READ_BYTES = 32 * 1024;
const GIT_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const DEFAULT_COMPLETION_RETRY_DELAYS_MS = [250, 1_000, 2_500, 5_000, 15_000, 30_000] as const;
const DEFAULT_YIELD_RETRY_DELAYS_MS = [150, 400, 1_000] as const;
const WEB_ASSET_EXTENSIONS = new Set(CODE_SITE_EXTENSIONS);
const WEB_ASSET_EXTENSION = /\.([A-Za-z0-9]{1,12})$/;

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

function isAlreadyCompletedJobError(error: unknown): boolean {
	if (!error) return false;
	const text = errorTextWithCause(error);
	if (/surface job is not running/i.test(text)) return true;
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	return code === "55000" && /not running/i.test(text);
}

function isYieldedJobError(error: unknown): boolean {
	return error instanceof CodeHostJobFailure && error.code === "CODE_HOST_JOB_YIELDED";
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function runWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	signal: AbortSignal,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	const limit = Math.max(1, Math.min(concurrency, items.length));
	let nextIndex = 0;
	let firstError: unknown;
	let failed = false;
	const runOne = async (): Promise<void> => {
		while (!failed && !signal.aborted) {
			const index = nextIndex;
			if (index >= items.length) return;
			nextIndex += 1;
			try {
				await worker(items[index]!);
			} catch (error) {
				if (!failed) {
					failed = true;
					firstError = error;
				}
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: limit }, () => runOne()));
	if (failed) throw firstError;
	signal.throwIfAborted();
}

async function retryCommittedCompletion<T>(
	fn: (attemptSignal: AbortSignal) => Promise<T>,
	parentSignal: AbortSignal,
	delaysMs: readonly number[],
	options?: { readonly treatNotRunningAsDoneOnRetry?: boolean },
): Promise<T | undefined> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
		const attemptSignal = AbortSignal.timeout(15_000);
		try {
			return await fn(attemptSignal);
		} catch (error) {
			if (attempt > 0 && options?.treatNotRunningAsDoneOnRetry && isAlreadyCompletedJobError(error)) {
				return undefined;
			}
			lastError = error;
			const delayMs = delaysMs[attempt];
			if (delayMs === undefined || parentSignal.aborted) break;
			await delayWithAbort(delayMs, parentSignal);
		}
	}
	throw lastError;
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function effectiveSiteTreeSha(rawTreeSha: string, manifestSha256: string, hasSharedOverlay: boolean): string {
	if (!hasSharedOverlay) return rawTreeSha;
	return createHash("sha1").update(`${rawTreeSha}\n${manifestSha256}`, "utf8").digest("hex");
}

function isServableSharedPath(cleanPath: string): boolean {
	if (!cleanPath || cleanPath.length > 512 || !CODE_SITE_PATH.test(cleanPath)) return false;
	const extension = WEB_ASSET_EXTENSION.exec(cleanPath)?.[1]?.toLowerCase();
	return Boolean(extension && WEB_ASSET_EXTENSIONS.has(extension));
}

function mergeTreeWithSharedAssets(
	baseFiles: readonly CodeSiteTreeFile[],
	sharedAssets: Readonly<Record<string, string>> | undefined,
): {
	readonly files: CodeSiteTreeFile[];
	readonly manifestSha256: string;
	readonly totalBytes: number;
	readonly hasOverlay: boolean;
} {
	const byPath = new Map<string, CodeSiteTreeFile>();
	for (const file of baseFiles) {
		byPath.set(file.path, file);
	}
	let hasOverlay = false;
	if (sharedAssets) {
		for (const [rawPath, text] of Object.entries(sharedAssets)) {
			const cleanPath = rawPath.replace(/^\/+/, "");
			if (!isServableSharedPath(cleanPath)) continue;
			const content = new TextEncoder().encode(text);
			byPath.set(cleanPath, {
				path: cleanPath,
				bytes: content.byteLength,
				sha256: sha256Hex(content),
				content,
			});
			hasOverlay = true;
		}
	}
	const files = [...byPath.values()].sort((a, b) =>
		Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
	);
	const problem = codeSiteTreeProblem(
		files.map((file) => ({ mode: "100644", type: "blob", path: file.path, bytes: file.bytes })),
	);
	if (problem) throw new CodeSiteTreeInvalid(problem);
	const manifestSha256 = codeSiteManifest(files);
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	return { files, manifestSha256, totalBytes, hasOverlay };
}

// WHY: Reads optional company identity token files in a single fast shell exec (avoiding 8 serial LXD execs when code_host views only mount code/).
async function readSharedIdentityAssets(
	codeHostJob: CodeHostJob,
	signal: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
	const cssFull = `${codeHostJob.layout.companyRoot}/${IDENTITY_TOKENS_CSS_PATH}`;
	const jsonFull = `${codeHostJob.layout.companyRoot}/${IDENTITY_TOKENS_JSON_PATH}`;
	let result: { status: number | null; stdout: Buffer };
	try {
		result = await codeHostJob.shell.run(
			{
				argv: [
					"/bin/sh",
					"-c",
					'if [ -f "$1" ] && [ -s "$1" ]; then printf "CSS\\n"; head -c "$3" -- "$1"; elif [ -f "$2" ] && [ -s "$2" ]; then printf "JSON\\n"; head -c "$3" -- "$2"; fi',
					"_",
					cssFull,
					jsonFull,
					String(MAX_SHARED_ASSET_READ_BYTES),
				],
				cwd: "/",
				env: { PATH: "/usr/bin:/bin" },
				maximumOutputBytes: MAX_SHARED_ASSET_READ_BYTES + 1024,
			},
			signal,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		return {};
	}
	if (result.status !== 0 || result.stdout.byteLength === 0) return {};
	const nl = result.stdout.indexOf(0x0a);
	if (nl < 0) return {};
	const kind = result.stdout.subarray(0, nl).toString("latin1");
	const body = result.stdout.subarray(nl + 1).toString("utf8");
	if (!body) return {};
	const mounted: Record<string, string> = {};
	if (kind === "CSS") {
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = body;
		mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = body;
		return mounted;
	}
	if (kind === "JSON") {
		const compiled = compileIdentityTokensCss(body);
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_JSON_PATH}`] = body;
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = compiled;
		mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = compiled;
		return mounted;
	}
	return {};
}

async function resolveMainHeadAndTree(
	codeHostJob: CodeHostJob,
	repository: CloudCodingRepository,
	explicitHeadSha: string | null,
): Promise<{ readonly headSha: string; readonly treeSha: string }> {
	const kept = keptRepositoryOf(repository);
	return await withJob(codeHostJob, kept, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null) {
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		const targetRef =
			explicitHeadSha && GIT_SHA.test(explicitHeadSha) ? explicitHeadSha : `refs/heads/${kept.baseBranch}`;
		const headSha = (
			await run.gitOk(run.repo, ["rev-parse", "--verify", `${targetRef}^{commit}`], "CODE_HOST_MAIN_MISSING")
		)
			.toString("utf8")
			.trim();
		const treeSha = (
			await run.gitOk(run.repo, ["rev-parse", "--verify", `${headSha}^{tree}`], "CODE_HOST_TREE_MISSING")
		)
			.toString("utf8")
			.trim();
		if (!GIT_SHA.test(headSha) || !GIT_SHA.test(treeSha)) {
			throw new Error("Resolved main commit or tree SHA is invalid");
		}
		return { headSha, treeSha };
	});
}

type SiteUploadPart = {
	readonly path: string;
	readonly part: number;
	readonly of: number;
	readonly contentBase64: string;
};

function buildUploadQueues(files: readonly CodeSiteTreeFile[]): SiteUploadPart[][][] {
	// WHY: Single-part files have disjoint paths and pack into independent parallel batches; each multi-part file gets its own sequential queue so parts arrive in order.
	const queues: SiteUploadPart[][][] = [];
	let singleBatch: SiteUploadPart[] = [];
	let singleBytes = 0;
	const flushSingle = (): void => {
		if (singleBatch.length === 0) return;
		queues.push([singleBatch]);
		singleBatch = [];
		singleBytes = 0;
	};
	for (const file of files) {
		const totalParts = Math.max(1, Math.ceil(file.content.byteLength / PUT_RAW_PART_BYTES));
		if (totalParts === 1) {
			const item: SiteUploadPart = {
				path: file.path,
				part: 0,
				of: 1,
				contentBase64: Buffer.from(file.content).toString("base64"),
			};
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 2;
			if (
				singleBatch.length > 0 &&
				(singleBatch.length >= PUT_BATCH_MAX_PARTS || singleBytes + itemBytes > PUT_BATCH_MAX_JSON_BYTES)
			) {
				flushSingle();
			}
			singleBatch.push(item);
			singleBytes += itemBytes;
			continue;
		}
		const fileBatches: SiteUploadPart[][] = [];
		let curBatch: SiteUploadPart[] = [];
		let curBytes = 0;
		for (let part = 0; part < totalParts; part += 1) {
			const slice = file.content.subarray(
				part * PUT_RAW_PART_BYTES,
				Math.min((part + 1) * PUT_RAW_PART_BYTES, file.content.byteLength),
			);
			const item: SiteUploadPart = {
				path: file.path,
				part,
				of: totalParts,
				contentBase64: Buffer.from(slice).toString("base64"),
			};
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 2;
			if (
				curBatch.length > 0 &&
				(curBatch.length >= PUT_BATCH_MAX_PARTS || curBytes + itemBytes > PUT_BATCH_MAX_JSON_BYTES)
			) {
				fileBatches.push(curBatch);
				curBatch = [];
				curBytes = 0;
			}
			curBatch.push(item);
			curBytes += itemBytes;
		}
		if (curBatch.length > 0) fileBatches.push(curBatch);
		queues.push(fileBatches);
	}
	flushSingle();
	return queues;
}

async function uploadPreparedSiteTree(
	control: SurfaceCodeHostControl,
	input: {
		readonly surfaceId: string;
		readonly mainSha: string;
		readonly treeSha: string;
		readonly title: string | null;
		readonly promoteLive: boolean;
		readonly files: readonly CodeSiteTreeFile[];
		readonly sharedAssets?: Readonly<Record<string, string>>;
		readonly uploadConcurrency: number;
	},
	signal: AbortSignal,
): Promise<{ readonly versionId: string; readonly siteId: string; readonly siteSlug: string }> {
	const merged = mergeTreeWithSharedAssets(input.files, input.sharedAssets);
	if (merged.files.length === 0) {
		throw new Error("Site tree contains no files to upload");
	}
	const uploadTreeSha = effectiveSiteTreeSha(input.treeSha, merged.manifestSha256, merged.hasOverlay);

	const beginRaw = (await control.call(
		"qorpera_surface_site_version_begin",
		{
			p_surface_id: input.surfaceId,
			p_tree: uploadTreeSha,
			p_main_sha: input.mainSha,
			p_manifest_sha256: merged.manifestSha256,
			p_file_count: merged.files.length,
			p_total_bytes: merged.totalBytes,
			p_title: input.title,
		},
		signal,
	)) as {
		state?: unknown;
		code?: unknown;
		versionId?: unknown;
		siteId?: unknown;
		siteSlug?: unknown;
		listed?: unknown;
	} | null;

	if (!beginRaw || typeof beginRaw !== "object") {
		throw new Error("Surface site version begin returned an invalid answer");
	}
	if (beginRaw.state === "refused") {
		throw new Error(`Surface site upload refused: ${String(beginRaw.code ?? "UNKNOWN")}`);
	}
	const versionId = typeof beginRaw.versionId === "string" && isUuid(beginRaw.versionId) ? beginRaw.versionId : null;
	const siteId = typeof beginRaw.siteId === "string" && isUuid(beginRaw.siteId) ? beginRaw.siteId : null;
	const siteSlug = typeof beginRaw.siteSlug === "string" ? beginRaw.siteSlug : "";
	if (!versionId || !siteId) {
		throw new Error("Surface site version begin did not return versionId and siteId");
	}

	if (beginRaw.state === "uploading") {
		if (beginRaw.listed !== true) {
			let batch: { path: string; bytes: number; sha256: string }[] = [];
			let batchBytes = 0;
			const flushList = async (last: boolean): Promise<void> => {
				const listRaw = (await control.call(
					"qorpera_surface_site_version_list",
					{ p_version_id: versionId, p_files: { files: batch, last } },
					signal,
				)) as { state?: unknown; code?: unknown; path?: unknown } | null;
				if (!listRaw || listRaw.state === "refused" || listRaw.state === "lost") {
					throw new Error(
						`Surface site file list rejected: ${String(listRaw?.code ?? listRaw?.state ?? "UNKNOWN")}${listRaw?.path ? ` (${String(listRaw.path)})` : ""}`,
					);
				}
				batch = [];
				batchBytes = 0;
			};

			for (let i = 0; i < merged.files.length; i += 1) {
				const file = merged.files[i]!;
				const entry = { path: file.path, bytes: file.bytes, sha256: file.sha256 };
				const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 2;
				if (
					batch.length > 0 &&
					(batch.length >= CODE_SITE_LIST_FILES || batchBytes + entryBytes > CODE_SITE_LIST_BYTES)
				) {
					await flushList(false);
				}
				batch.push(entry);
				batchBytes += entryBytes;
			}
			await flushList(true);
		}

		const queues = buildUploadQueues(merged.files);
		await runWithConcurrency(queues, input.uploadConcurrency, signal, async (queue) => {
			for (const partsBatch of queue) {
				const putRaw = (await control.call(
					"qorpera_surface_site_version_put",
					{ p_version_id: versionId, p_parts: { parts: partsBatch } },
					signal,
				)) as { state?: unknown; code?: unknown; path?: unknown } | null;
				if (!putRaw || putRaw.state === "refused" || putRaw.state === "lost") {
					throw new Error(
						`Surface site file put rejected: ${String(putRaw?.code ?? putRaw?.state ?? "UNKNOWN")}${putRaw?.path ? ` (${String(putRaw.path)})` : ""}`,
					);
				}
			}
		});

		const finishRaw = (await control.call(
			"qorpera_surface_site_version_finish",
			{ p_version_id: versionId, p_promote_live: input.promoteLive },
			signal,
		)) as { state?: unknown; code?: unknown } | null;
		if (!finishRaw || finishRaw.state === "refused" || finishRaw.state === "lost") {
			throw new Error(`Surface site finish rejected: ${String(finishRaw?.code ?? finishRaw?.state ?? "UNKNOWN")}`);
		}
	} else if (input.promoteLive && beginRaw.state !== "live") {
		const finishRaw = (await control.call(
			"qorpera_surface_site_version_finish",
			{ p_version_id: versionId, p_promote_live: true },
			signal,
		)) as { state?: unknown; code?: unknown } | null;
		if (!finishRaw || finishRaw.state === "refused" || finishRaw.state === "lost") {
			throw new Error(
				`Surface site promotion rejected: ${String(finishRaw?.code ?? finishRaw?.state ?? "UNKNOWN")}`,
			);
		}
	}

	return { versionId, siteId, siteSlug };
}

function createControlPlaneBridge(control: SurfaceCodeHostControl): SurfaceExecutionControlPlane {
	return {
		async completeSurfacePreview(input: CompleteSurfacePreviewInput, signal?: AbortSignal) {
			return await control.call(
				"qorpera_surface_complete_preview",
				{
					p_preview_id: input.previewId,
					p_status: input.status,
					p_composite_tree_sha: input.compositeTreeSha ?? null,
					p_site_version_id: input.siteVersionId ?? null,
					p_conflict_report: input.conflictReport ?? null,
					p_error_detail: input.errorDetail ?? null,
					p_lease_token: input.leaseToken ?? null,
				},
				signal ?? new AbortController().signal,
			);
		},
		async completeSurfaceMerge(input: CompleteSurfaceMergeInput, signal?: AbortSignal) {
			return await control.call(
				"qorpera_surface_complete_merge",
				{
					p_job_id: input.jobId,
					p_status: input.status,
					p_main_before: input.mainBefore ?? null,
					p_main_after: input.mainAfter ?? null,
					p_conflict_change_id: input.conflictChangeId ?? null,
					p_conflict_paths: input.conflictPaths ? [...input.conflictPaths] : null,
					p_error_detail: input.errorDetail ?? null,
					p_pre_merge_snapshot: input.preMergeSnapshot ?? null,
					p_lease_token: input.leaseToken ?? null,
				},
				signal ?? new AbortController().signal,
			);
		},
		async completeSurfacePublish(input: CompleteSurfacePublishInput, signal?: AbortSignal) {
			return await control.call(
				"qorpera_surface_complete_publish",
				{
					p_job_id: input.jobId,
					p_status: input.status,
					p_published_head_sha: input.publishedHeadSha ?? null,
					p_error_detail: input.errorDetail ?? null,
					p_lease_token: input.leaseToken ?? null,
				},
				signal ?? new AbortController().signal,
			);
		},
	};
}

interface ActiveLease {
	readonly signal: AbortSignal;
	stop(): void;
}

// WHY: Executes code_repo Surface previews, selective merges, rebases, undos, and live site publishes on coding-executor where LxdCodeHosts lives.
export class SurfaceCodeHostWorker {
	readonly #control: SurfaceCodeHostControl;
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #readTree: CodeSiteTreeRead;
	readonly #batchLimit: number;
	readonly #companyConcurrency: number;
	readonly #uploadConcurrency: number;
	readonly #leaseRenewIntervalMs: number;
	readonly #leaseExtendSeconds: number;
	readonly #completionRetryDelaysMs: readonly number[];
	readonly #yieldRetryDelaysMs: readonly number[];
	readonly #report: ((event: Record<string, unknown>) => void) | undefined;

	constructor(options: SurfaceCodeHostWorkerOptions) {
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#readTree = options.readTree ?? readSurfaceSiteTree;
		this.#batchLimit = Math.min(Math.max(1, options.batchLimit ?? 8), 64);
		this.#companyConcurrency = Math.min(Math.max(1, options.companyConcurrency ?? DEFAULT_COMPANY_CONCURRENCY), 16);
		this.#uploadConcurrency = Math.min(Math.max(1, options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY), 16);
		this.#leaseRenewIntervalMs = Math.max(50, options.leaseRenewIntervalMs ?? 60_000);
		this.#leaseExtendSeconds = Math.min(Math.max(30, options.leaseExtendSeconds ?? 300), 900);
		this.#completionRetryDelaysMs = options.completionRetryDelaysMs ?? DEFAULT_COMPLETION_RETRY_DELAYS_MS;
		this.#yieldRetryDelaysMs = options.yieldRetryDelaysMs ?? DEFAULT_YIELD_RETRY_DELAYS_MS;
		this.#report = options.report;
	}

	#emit(event: Record<string, unknown>): void {
		try {
			this.#report?.(event);
		} catch {}
	}

	#startLease(kind: "preview" | "job", id: string, leaseToken: string | null, parentSignal: AbortSignal): ActiveLease {
		if (!leaseToken) {
			return { signal: parentSignal, stop() {} };
		}
		const leaseAbort = new AbortController();
		const combined = AbortSignal.any([parentSignal, leaseAbort.signal]);
		let stopped = false;
		let renewing = false;
		const timer = setInterval(() => {
			if (stopped || combined.aborted || renewing) return;
			renewing = true;
			void this.#control
				.call(
					"qorpera_surface_renew_lease",
					{
						p_kind: kind,
						p_id: id,
						p_lease_token: leaseToken,
						p_extend_seconds: this.#leaseExtendSeconds,
					},
					combined,
				)
				.then((result) => {
					if (stopped) return;
					if (
						result &&
						typeof result === "object" &&
						(result as { renewed?: unknown }).renewed === false &&
						!leaseAbort.signal.aborted
					) {
						leaseAbort.abort(new Error(`Surface ${kind} lease lost for ${id}`));
					}
				})
				.catch(() => undefined)
				.finally(() => {
					renewing = false;
				});
		}, this.#leaseRenewIntervalMs);
		timer.unref?.();
		return {
			signal: combined,
			stop() {
				stopped = true;
				clearInterval(timer);
			},
		};
	}

	async pass(signal: AbortSignal): Promise<SurfaceCodeHostPassResult> {
		const raw = await withAbortScope(signal, (scoped) =>
			this.#control.call(
				"qorpera_surface_claim_pending_jobs_for_lane",
				{ p_limit: this.#batchLimit, p_lane: "code_repo" },
				scoped,
			),
		);
		const claimed = parseClaimedSurfaceJobs(raw);
		const merges = claimed.merges ?? [];
		const publishes = claimed.publishes ?? [];
		const previews = claimed.previews ?? [];

		// WHY: Start lease renewal for every claimed item immediately so items queued behind long merges never silently expire before execution.
		const leases = new Map<string, ActiveLease>();
		const leaseKey = (kind: "job" | "preview", id: string) => `${kind}:${id}`;
		for (const merge of merges) {
			leases.set(
				leaseKey("job", merge.jobId),
				this.#startLease("job", merge.jobId, merge.leaseToken ?? null, signal),
			);
		}
		for (const pub of publishes) {
			leases.set(leaseKey("job", pub.jobId), this.#startLease("job", pub.jobId, pub.leaseToken ?? null, signal));
		}
		for (const preview of previews) {
			leases.set(
				leaseKey("preview", preview.previewId),
				this.#startLease("preview", preview.previewId, preview.leaseToken ?? null, signal),
			);
		}

		// WHY: Serialize merges, publishes, and previews within each company while running distinct companies concurrently.
		type CompanyWork = {
			readonly profileId: string;
			readonly merges: ClaimedSurfaceMergeJob[];
			readonly publishes: ClaimedSurfacePublishJob[];
			readonly previews: ClaimedSurfacePreviewJob[];
		};
		const byCompany = new Map<string, CompanyWork>();
		const bucketOf = (profileId: string): CompanyWork => {
			let bucket = byCompany.get(profileId);
			if (!bucket) {
				bucket = { profileId, merges: [], publishes: [], previews: [] };
				byCompany.set(profileId, bucket);
			}
			return bucket;
		};
		for (const merge of merges) bucketOf(merge.profileId).merges.push(merge);
		for (const pub of publishes) bucketOf(pub.profileId).publishes.push(pub);
		for (const preview of previews) bucketOf(preview.profileId).previews.push(preview);

		let previewsDone = 0;
		let mergesDone = 0;
		let publishesDone = 0;
		let failed = 0;

		const runCompany = async (work: CompanyWork): Promise<void> => {
			for (const merge of work.merges) {
				if (signal.aborted) break;
				const lease = leases.get(leaseKey("job", merge.jobId))!;
				try {
					await this.#runMerge(merge, lease.signal);
					mergesDone += 1;
				} catch (error) {
					failed += 1;
					this.#emit({
						event: "surface-code-host-error",
						kind: "merge",
						jobId: merge.jobId,
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					lease.stop();
				}
			}

			for (const pub of work.publishes) {
				if (signal.aborted) break;
				const lease = leases.get(leaseKey("job", pub.jobId))!;
				try {
					const completed = await this.#runPublish(pub, lease.signal);
					if (completed) publishesDone += 1;
				} catch (error) {
					failed += 1;
					this.#emit({
						event: "surface-code-host-error",
						kind: "publish",
						jobId: pub.jobId,
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					lease.stop();
				}
			}

			for (const preview of work.previews) {
				if (signal.aborted) break;
				const lease = leases.get(leaseKey("preview", preview.previewId))!;
				try {
					const completed = await this.#runPreview(preview, lease.signal);
					if (completed) previewsDone += 1;
				} catch (error) {
					failed += 1;
					this.#emit({
						event: "surface-code-host-error",
						kind: "preview",
						previewId: preview.previewId,
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					lease.stop();
				}
			}
		};

		try {
			const companies = [...byCompany.values()];
			await runWithConcurrency(companies, this.#companyConcurrency, signal, runCompany).catch(() => undefined);
		} finally {
			for (const lease of leases.values()) lease.stop();
		}

		return { previews: previewsDone, merges: mergesDone, publishes: publishesDone, failed };
	}

	async #runYieldable<T>(
		profileId: string,
		environmentId: string,
		signal: AbortSignal,
		fn: (codeHostJob: CodeHostJob) => Promise<T>,
	): Promise<{ readonly yielded: false; readonly value: T } | { readonly yielded: true }> {
		for (let attempt = 0; attempt <= this.#yieldRetryDelaysMs.length; attempt += 1) {
			try {
				const value = await this.#hosts.run(
					profileId,
					environmentId,
					signal,
					async (codeHostJob) => await fn(codeHostJob),
					{ yields: true },
				);
				return { yielded: false, value };
			} catch (error) {
				if (!isYieldedJobError(error) || signal.aborted) throw error;
				const waitMs = this.#yieldRetryDelaysMs[attempt];
				if (waitMs === undefined) return { yielded: true };
				await delayWithAbort(waitMs, signal);
				if (signal.aborted) throw error;
			}
		}
		return { yielded: true };
	}

	#handlersForMergeJob(
		codeHostJob: CodeHostJob,
		overrides: {
			readonly controlPlane: SurfaceExecutionControlPlane;
			readonly deferRebase: (update: (rebaseSignal: AbortSignal) => Promise<void>) => void;
		},
	) {
		return createSurfaceExecutionHandlers({
			controlPlane: overrides.controlPlane,
			rethrowOnCodeHostFailure: true,
			resolveCodeHostJob: () => codeHostJob,
			onSessionChangesRebased: async (input) => {
				const applyRebases = async (rebaseSignal: AbortSignal): Promise<void> => {
					if (input.sessionId && input.siblingRebase) {
						await this.#persistRebaseOutcome(input.surfaceId, input.sessionId, input.siblingRebase, rebaseSignal);
					}
					for (const peer of input.peerSync) {
						await this.#persistRebaseOutcome(input.surfaceId, peer.sessionId, peer.result, rebaseSignal);
					}
				};
				overrides.deferRebase(applyRebases);
			},
			undoCodeRepoChange: async (input) =>
				await undoSurfaceCodeRepoChange(codeHostJob, {
					jobId: input.jobId,
					changeId: input.changeId,
					repository: input.repository,
					landedMainBefore: input.landedMainBefore,
					landedMainAfter: input.landedMainAfter,
				}),
		});
	}

	async #persistRebaseOutcome(
		surfaceId: string,
		sessionId: string,
		result: RebaseSessionChangesResult,
		signal: AbortSignal,
	): Promise<void> {
		if (result.status === "deferred") {
			this.#emit({
				event: "surface-code-host-rebase-deferred",
				surfaceId,
				sessionId,
				reason: result.reason,
				...(result.errorCode ? { errorCode: result.errorCode } : {}),
			});
			return;
		}
		if (result.status === "clean") {
			if (result.worktreeSynced === false) {
				this.#emit({
					event: "surface-code-host-rebase-worktree-unsynced",
					surfaceId,
					sessionId,
					branchHeadSha: result.branchHeadSha,
				});
			}
			await this.#control.call(
				"qorpera_surface_update_rebased_changes",
				{
					p_surface_id: surfaceId,
					p_session_id: sessionId,
					p_branch_head_sha: result.branchHeadSha,
					p_rebased_changes: result.rebasedChanges.map((item) => ({
						changeId: item.changeId,
						parentSha: item.parentSha,
						headSha: item.headSha,
					})),
					p_conflicted_change_id: null,
					p_conflict_paths: null,
				},
				signal,
			);
			return;
		}
		// WHY: On conflict, git never moved the session branch ref; pass empty p_rebased_changes so Postgres never stores unreachable dangling commit SHAs.
		await this.#control.call(
			"qorpera_surface_update_rebased_changes",
			{
				p_surface_id: surfaceId,
				p_session_id: sessionId,
				p_branch_head_sha: null,
				p_rebased_changes: [],
				p_conflicted_change_id: result.conflictedChangeId,
				p_conflict_paths: [...result.conflictPaths],
			},
			signal,
		);
	}

	async #runPreview(preview: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<boolean> {
		const controlPlane = createControlPlaneBridge(this.#control);
		const leaseField = preview.leaseToken !== undefined ? { leaseToken: preview.leaseToken } : {};
		if (!preview.environmentId) {
			await controlPlane.completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "failed",
					errorDetail: "Preview job is missing environmentId",
					...leaseField,
				},
				signal,
			);
			return true;
		}
		const repository = parseSurfaceRepositoryKey(preview.repositoryKey);
		if (!repository) {
			await controlPlane.completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "failed",
					errorDetail: preview.repositoryKey
						? `Invalid surface repositoryKey "${preview.repositoryKey}"`
						: "Surface job is missing repositoryKey",
					...leaseField,
				},
				signal,
			);
			return true;
		}

		// WHY: Preview HTTP uploads must stay outside hosts.run so slow network I/O never blocks company merges or coding turns.
		const baseSha = preview.baseSha && preview.baseSha !== ZERO_SHA ? preview.baseSha : undefined;
		type PreparedPreview =
			| {
					readonly status: "conflicted";
					readonly lastCleanTreeSha: string;
					readonly changeIds: readonly string[];
					readonly paths: readonly string[];
			  }
			| {
					readonly status: "ready";
					readonly compositeCommitSha: string;
					readonly compositeTreeSha: string;
					readonly files: readonly CodeSiteTreeFile[];
					readonly sharedAssets: Readonly<Record<string, string>>;
			  };

		let prepared: PreparedPreview;
		try {
			const ran = await this.#runYieldable<PreparedPreview>(
				preview.profileId,
				preview.environmentId,
				signal,
				async (codeHostJob) => {
					await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
					const composed = await composePreviewTree(codeHostJob, {
						repository,
						...(baseSha ? { baseSha } : {}),
						...(preview.exploration ? { exploration: preview.exploration } : {}),
						changes: (preview.changes ?? []).map((change) => ({
							changeId: change.changeId,
							parentSha: change.parentSha,
							headSha: change.headSha,
						})),
					});
					if (composed.status === "conflicted") {
						return {
							status: "conflicted",
							lastCleanTreeSha: composed.lastCleanTreeSha,
							changeIds: [...composed.appliedChangeIds, composed.conflictingChangeId],
							paths: [...composed.conflictPaths],
						};
					}
					const treeData = await this.#readTree(codeHostJob, {
						repository,
						tree: composed.compositeTreeSha,
					});
					const sharedAssets = await readSharedIdentityAssets(codeHostJob, codeHostJob.signal);
					return {
						status: "ready",
						compositeCommitSha: composed.compositeCommitSha,
						compositeTreeSha: composed.compositeTreeSha,
						files: treeData.files,
						sharedAssets,
					};
				},
			);
			if (ran.yielded) {
				this.#emit({
					event: "surface-code-host-yielded",
					kind: "preview",
					previewId: preview.previewId,
					surfaceId: preview.surfaceId,
				});
				return false;
			}
			prepared = ran.value;
		} catch (error) {
			if (signal.aborted) throw error;
			const detail = error instanceof Error ? error.message.slice(0, 1000) : "Surface preview build failed";
			await controlPlane.completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "failed",
					errorDetail: detail,
					...leaseField,
				},
				signal,
			);
			return true;
		}

		if (prepared.status === "conflicted") {
			await controlPlane.completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "conflicted",
					compositeTreeSha: prepared.lastCleanTreeSha,
					conflictReport: { changeIds: [...prepared.changeIds], paths: [...prepared.paths] },
					errorDetail: null,
					...leaseField,
				},
				signal,
			);
			return true;
		}

		try {
			const uploaded = await uploadPreparedSiteTree(
				this.#control,
				{
					surfaceId: preview.surfaceId,
					mainSha: prepared.compositeCommitSha,
					treeSha: prepared.compositeTreeSha,
					title: `Preview ${preview.shortHostId}`,
					promoteLive: false,
					files: prepared.files,
					sharedAssets: prepared.sharedAssets,
					uploadConcurrency: this.#uploadConcurrency,
				},
				signal,
			);
			await controlPlane.completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "ready",
					compositeTreeSha: prepared.compositeTreeSha,
					siteVersionId: uploaded.versionId,
					conflictReport: null,
					errorDetail: null,
					...leaseField,
				},
				signal,
			);
			return true;
		} catch (error) {
			if (signal.aborted) throw error;
			const detail = error instanceof Error ? error.message.slice(0, 1000) : "Surface preview upload failed";
			await controlPlane.completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "failed",
					errorDetail: detail,
					...leaseField,
				},
				signal,
			);
			return true;
		}
	}

	async #runMerge(merge: ClaimedSurfaceMergeJob, signal: AbortSignal): Promise<void> {
		const controlPlane = createControlPlaneBridge(this.#control);
		if (!merge.environmentId) {
			await controlPlane.completeSurfaceMerge(
				{
					jobId: merge.jobId,
					status: "failed",
					errorDetail: "Code merge job is missing environmentId",
					...(merge.leaseToken !== undefined ? { leaseToken: merge.leaseToken } : {}),
				},
				signal,
			);
			return;
		}
		// WHY: Defer rebase and merge completion RPCs until hosts.run publishes the code host view durably so Postgres never marks a merge landed before git refs persist.
		let deferredMergeCompletion: CompleteSurfaceMergeInput | null = null;
		const deferredRebases: ((rebaseSignal: AbortSignal) => Promise<void>)[] = [];
		const bufferedControlPlane: SurfaceExecutionControlPlane = {
			completeSurfacePreview: controlPlane.completeSurfacePreview,
			completeSurfacePublish: controlPlane.completeSurfacePublish,
			async completeSurfaceMerge(input) {
				deferredMergeCompletion = input;
				return { jobId: input.jobId, status: input.status };
			},
		};
		try {
			await this.#hosts.run(merge.profileId, merge.environmentId, signal, async (codeHostJob) => {
				await this.#handlersForMergeJob(codeHostJob, {
					controlPlane: bufferedControlPlane,
					deferRebase: (update) => deferredRebases.push(update),
				}).runMergeJob(merge, codeHostJob.signal);
			});
		} catch (error) {
			await controlPlane.completeSurfaceMerge(
				{
					jobId: merge.jobId,
					status: "failed",
					errorDetail:
						error instanceof Error ? error.message.slice(0, 1000) : "Code host merge view publish failed",
					...(merge.leaseToken !== undefined ? { leaseToken: merge.leaseToken } : {}),
				},
				signal,
			);
			throw error;
		}
		try {
			if (deferredMergeCompletion) {
				const completionPayload = deferredMergeCompletion;
				await retryCommittedCompletion(
					(attemptSignal) => controlPlane.completeSurfaceMerge(completionPayload, attemptSignal),
					signal,
					this.#completionRetryDelaysMs,
					{ treatNotRunningAsDoneOnRetry: true },
				);
			}
		} finally {
			// WHY: Always attempt best-effort persistence of rebased sibling/peer SHAs regardless of completion outcome so git worktrees and database SHAs stay aligned.
			for (const applyRebase of deferredRebases) {
				try {
					await retryCommittedCompletion(
						(attemptSignal) => applyRebase(attemptSignal),
						signal,
						this.#completionRetryDelaysMs,
					);
				} catch (error) {
					this.#report?.({
						event: "surface-code-host-rebase-persist-failed",
						jobId: merge.jobId,
						surfaceId: merge.surfaceId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	}

	async #runPublish(pub: ClaimedSurfacePublishJob, signal: AbortSignal): Promise<boolean> {
		const controlPlane = createControlPlaneBridge(this.#control);
		const leaseField = pub.leaseToken !== undefined ? { leaseToken: pub.leaseToken } : {};
		if (!pub.environmentId) {
			await controlPlane.completeSurfacePublish(
				{
					jobId: pub.jobId,
					status: "failed",
					errorDetail: "Code publish job is missing environmentId",
					...leaseField,
				},
				signal,
			);
			return true;
		}
		const repository = parseSurfaceRepositoryKey(pub.repositoryKey);
		if (!repository) {
			await controlPlane.completeSurfacePublish(
				{
					jobId: pub.jobId,
					status: "failed",
					errorDetail: pub.repositoryKey
						? `Invalid surface repositoryKey "${pub.repositoryKey}"`
						: "Code repository surface publish is missing repository metadata",
					...leaseField,
				},
				signal,
			);
			return true;
		}

		const explicitHeadSha =
			typeof pub.payload.liveHeadSha === "string"
				? pub.payload.liveHeadSha
				: typeof pub.liveHeadSha === "string"
					? pub.liveHeadSha
					: null;

		type PreparedPublish = {
			readonly headSha: string;
			readonly treeSha: string;
			readonly files: readonly CodeSiteTreeFile[];
			readonly sharedAssets: Readonly<Record<string, string>>;
		};

		let prepared: PreparedPublish;
		try {
			const ran = await this.#runYieldable<PreparedPublish>(
				pub.profileId,
				pub.environmentId,
				signal,
				async (codeHostJob) => {
					await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
					const resolved = await resolveMainHeadAndTree(codeHostJob, repository, explicitHeadSha);
					const treeData = await this.#readTree(codeHostJob, { repository, tree: resolved.treeSha });
					const sharedAssets = await readSharedIdentityAssets(codeHostJob, codeHostJob.signal);
					return {
						headSha: resolved.headSha,
						treeSha: resolved.treeSha,
						files: treeData.files,
						sharedAssets,
					};
				},
			);
			if (ran.yielded) {
				this.#emit({
					event: "surface-code-host-yielded",
					kind: "publish",
					jobId: pub.jobId,
					surfaceId: pub.surfaceId,
				});
				return false;
			}
			prepared = ran.value;
		} catch (error) {
			if (signal.aborted) throw error;
			const detail = error instanceof Error ? error.message.slice(0, 1000) : "Surface publish read failed";
			await controlPlane.completeSurfacePublish(
				{
					jobId: pub.jobId,
					status: "failed",
					errorDetail: detail,
					...leaseField,
				},
				signal,
			);
			return true;
		}

		try {
			await uploadPreparedSiteTree(
				this.#control,
				{
					surfaceId: pub.surfaceId,
					mainSha: prepared.headSha,
					treeSha: prepared.treeSha,
					title: null,
					promoteLive: true,
					files: prepared.files,
					sharedAssets: prepared.sharedAssets,
					uploadConcurrency: this.#uploadConcurrency,
				},
				signal,
			);
			await controlPlane.completeSurfacePublish(
				{
					jobId: pub.jobId,
					status: "published",
					publishedHeadSha: prepared.headSha,
					...leaseField,
				},
				signal,
			);
			return true;
		} catch (error) {
			if (signal.aborted) throw error;
			const detail = error instanceof Error ? error.message.slice(0, 1000) : "Surface publish upload failed";
			await controlPlane.completeSurfacePublish(
				{
					jobId: pub.jobId,
					status: "failed",
					errorDetail: detail,
					...leaseField,
				},
				signal,
			);
			return true;
		}
	}
}
