import { createHash } from "node:crypto";
import {
	type CloudCodingRepository,
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	isUuid,
	PRODUCT_CATALOG_PATH,
	PRODUCT_SPECS_PATH,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
	sharedProductAssetCandidates,
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
import {
	type CodeSiteTreeFile,
	CodeSiteTreeInvalid,
	readCodeSiteTree,
	readSurfacePreviewPlan,
	readSurfaceSiteTree,
} from "./code-host-sites.ts";
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
import {
	previewSiteProblemDetail,
	type SurfacePreviewPlan,
	type SurfacePreviewRecipe,
} from "./surface-preview-runner.ts";
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
	"qorpera_surface_shared_product_folder_roots",
	"qorpera_surface_request_build",
] as const;

export type SurfaceCodeHostRpc = (typeof SURFACE_CODE_HOST_RPCS)[number];

export interface SurfaceCodeHostControl {
	call(method: SurfaceCodeHostRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface SurfaceCodeHostWorkerOptions {
	readonly control: SurfaceCodeHostControl;
	readonly hosts: Pick<CodeHostJobs, "run">;
	readonly readTree?: CodeSiteTreeRead;
	readonly readBuiltTree?: CodeSiteTreeRead;
	readonly readPlan?: SurfacePreviewPlanRead;
	readonly batchLimit?: number;
	readonly companyConcurrency?: number;
	readonly uploadConcurrency?: number;
	readonly leaseRenewIntervalMs?: number;
	readonly leaseExtendSeconds?: number;
	readonly completionRetryDelaysMs?: readonly number[];
	readonly yieldRetryDelaysMs?: readonly number[];
	readonly report?: (event: Record<string, unknown>) => void;
}

export type SurfacePreviewPlanRead = (
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string },
) => Promise<SurfacePreviewPlan>;

type SurfaceBuildAnswer =
	| { readonly state: "built"; readonly buildId: string; readonly builtTreeSha: string }
	| { readonly state: "waiting" | "failed" };

type ReadSite = {
	readonly treeSha: string;
	readonly files: readonly CodeSiteTreeFile[];
	readonly sharedAssets: Readonly<Record<string, string>>;
};

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

function surfaceFailureDetail(error: unknown, builtFolder: string | null, fallback: string): string {
	if (error instanceof CodeSiteTreeInvalid) return previewSiteProblemDetail(error.problem, builtFolder);
	return error instanceof Error ? error.message.slice(0, 1000) : fallback;
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

// WHY: Reads optional company identity token and primary product files in a single fast shell exec (avoiding serial LXD execs when code_host views only mount code/).
async function readSharedIdentityAssets(
	codeHostJob: CodeHostJob,
	signal: AbortSignal,
	productFolderRoots?: readonly string[],
): Promise<Readonly<Record<string, string>>> {
	const cssFull = `${codeHostJob.layout.companyRoot}/${IDENTITY_TOKENS_CSS_PATH}`;
	const jsonFull = `${codeHostJob.layout.companyRoot}/${IDENTITY_TOKENS_JSON_PATH}`;
	const { specsPaths, catalogPaths } = sharedProductAssetCandidates(productFolderRoots);
	const specsFull = specsPaths[0] ? `${codeHostJob.layout.companyRoot}/${specsPaths[0]}` : "";
	const catalogFull = catalogPaths[0] ? `${codeHostJob.layout.companyRoot}/${catalogPaths[0]}` : "";
	let result: { status: number | null; stdout: Buffer };
	try {
		result = await codeHostJob.shell.run(
			{
				argv: [
					"/bin/sh",
					"-c",
					'emit() { if [ -n "$2" ] && [ -f "$2" ] && [ -s "$2" ]; then b=$(head -c "$3" -- "$2" | wc -c | tr -d " "); printf "%s %s\\n" "$1" "$b"; head -c "$b" -- "$2"; fi; }; if [ -f "$1" ] && [ -s "$1" ]; then emit CSS "$1" "$5"; elif [ -f "$2" ] && [ -s "$2" ]; then emit JSON "$2" "$5"; fi; emit SPECS "$3" "$5"; emit CATALOG "$4" "$5"',
					"_",
					cssFull,
					jsonFull,
					specsFull,
					catalogFull,
					String(MAX_SHARED_ASSET_READ_BYTES),
				],
				cwd: "/",
				env: { PATH: "/usr/bin:/bin" },
				maximumOutputBytes: MAX_SHARED_ASSET_READ_BYTES * 3 + 2048,
			},
			signal,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		return {};
	}
	if (result.status !== 0 || result.stdout.byteLength === 0) return {};
	const mounted: Record<string, string> = {};
	let offset = 0;
	while (offset < result.stdout.byteLength) {
		const nl = result.stdout.indexOf(0x0a, offset);
		if (nl < 0) break;
		const header = result.stdout.subarray(offset, nl).toString("latin1");
		const space = header.indexOf(" ");
		if (space < 1) break;
		const kind = header.slice(0, space);
		const byteLen = Number.parseInt(header.slice(space + 1), 10);
		if (!Number.isSafeInteger(byteLen) || byteLen < 0) break;
		const start = nl + 1;
		const end = start + byteLen;
		if (end > result.stdout.byteLength) break;
		const body = result.stdout.subarray(start, end).toString("utf8");
		offset = end;
		if (!body) continue;
		if (kind === "CSS") {
			mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = body;
			mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = body;
		} else if (kind === "JSON") {
			const compiled = compileIdentityTokensCss(body);
			mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_JSON_PATH}`] = body;
			mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = compiled;
			mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = compiled;
		} else if (kind === "SPECS") {
			mounted[`${SURFACE_SHARED_DIR}/${PRODUCT_SPECS_PATH}`] = body;
		} else if (kind === "CATALOG") {
			mounted[`${SURFACE_SHARED_DIR}/${PRODUCT_CATALOG_PATH}`] = body;
		}
	}
	return mounted;
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
	readonly #readBuiltTree: CodeSiteTreeRead;
	readonly #readPlan: SurfacePreviewPlanRead;
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
		this.#readBuiltTree = options.readBuiltTree ?? readCodeSiteTree;
		this.#readPlan = options.readPlan ?? readSurfacePreviewPlan;
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
		const onParentAbort = (): void => leaseAbort.abort(parentSignal.reason);
		if (parentSignal.aborted) onParentAbort();
		else parentSignal.addEventListener("abort", onParentAbort, { once: true });
		const combined = leaseAbort.signal;
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
				parentSignal.removeEventListener("abort", onParentAbort);
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

	async #resolveProductFolderRoots(profileId: string, signal: AbortSignal): Promise<readonly string[]> {
		try {
			const raw = await this.#control.call(
				"qorpera_surface_shared_product_folder_roots",
				{ p_profile_id: profileId },
				signal,
			);
			return Array.isArray(raw)
				? raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				: [];
		} catch (error) {
			if (signal.aborted) throw error;
			return [];
		}
	}

	async #requestBuild(
		input: {
			readonly kind: "preview" | "publish";
			readonly id: string;
			readonly leaseToken: string;
			readonly commitSha: string;
			readonly treeSha: string;
			readonly recipe: SurfacePreviewRecipe;
			readonly staleBuiltTree: string | null;
		},
		signal: AbortSignal,
	): Promise<SurfaceBuildAnswer> {
		const raw = await this.#control.call(
			"qorpera_surface_request_build",
			{
				p_kind: input.kind,
				p_id: input.id,
				p_lease_token: input.leaseToken,
				p_commit_sha: input.commitSha,
				p_tree_sha: input.treeSha,
				p_recipe: {
					run: input.recipe.run,
					cwd: input.recipe.cwd,
					folder: input.recipe.folder,
					timeoutSeconds: input.recipe.timeoutSeconds,
				},
				p_stale_built_tree: input.staleBuiltTree,
			},
			signal,
		);
		const answer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const buildId = typeof answer.buildId === "string" && isUuid(answer.buildId) ? answer.buildId : null;
		if (answer.state === "failed") return { state: "failed" };
		if (buildId === null) throw new Error("Surface build request returned an invalid answer");
		if (answer.state === "built" && typeof answer.builtTreeSha === "string" && GIT_SHA.test(answer.builtTreeSha))
			return { state: "built", buildId, builtTreeSha: answer.builtTreeSha };
		if (answer.state === "waiting") return { state: "waiting" };
		throw new Error("Surface build request returned an invalid answer");
	}

	async #readBuiltSite(
		at: { readonly profileId: string; readonly environmentId: string },
		repository: CloudCodingRepository,
		builtTreeSha: string,
		productFolderRoots: readonly string[],
		signal: AbortSignal,
	): Promise<{ readonly yielded: true } | { readonly yielded: false; readonly site: ReadSite | null }> {
		const ran = await this.#runYieldable<ReadSite | null>(at.profileId, at.environmentId, signal, async (job) => {
			let files: readonly CodeSiteTreeFile[];
			try {
				files = (await this.#readBuiltTree(job, { repository, tree: builtTreeSha })).files;
			} catch (error) {
				if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_SITE_TREE_UNKNOWN") return null;
				throw error;
			}
			return {
				treeSha: builtTreeSha,
				files,
				sharedAssets: await readSharedIdentityAssets(job, job.signal, productFolderRoots),
			};
		});
		return ran.yielded ? { yielded: true } : { yielded: false, site: ran.value };
	}

	async #builtSite(
		input: {
			readonly kind: "preview" | "publish";
			readonly id: string;
			readonly leaseToken: string;
			readonly profileId: string;
			readonly environmentId: string;
			readonly repository: CloudCodingRepository;
			readonly commitSha: string;
			readonly treeSha: string;
			readonly recipe: SurfacePreviewRecipe;
			readonly productFolderRoots: readonly string[];
		},
		signal: AbortSignal,
	): Promise<"parked" | "yielded" | ReadSite> {
		let stale: string | null = null;
		for (let ask = 0; ask < 2; ask += 1) {
			const answer = await this.#requestBuild({ ...input, staleBuiltTree: stale }, signal);
			if (answer.state !== "built") return "parked";
			const read = await this.#readBuiltSite(
				input,
				input.repository,
				answer.builtTreeSha,
				input.productFolderRoots,
				signal,
			);
			if (read.yielded) return "yielded";
			if (read.site !== null) return read.site;
			stale = answer.builtTreeSha;
		}
		throw new Error("The built site is not in the repository");
	}

	async #runPreview(preview: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<boolean> {
		const controlPlane = createControlPlaneBridge(this.#control);
		const leaseField = preview.leaseToken !== undefined ? { leaseToken: preview.leaseToken } : {};
		const fail = async (errorDetail: string): Promise<true> => {
			await controlPlane.completeSurfacePreview(
				{ previewId: preview.previewId, status: "failed", errorDetail, ...leaseField },
				signal,
			);
			return true;
		};
		if (!preview.environmentId) return await fail("Preview job is missing environmentId");
		const environmentId = preview.environmentId;
		const repository = parseSurfaceRepositoryKey(preview.repositoryKey);
		if (!repository)
			return await fail(
				preview.repositoryKey
					? `Invalid surface repositoryKey "${preview.repositoryKey}"`
					: "Surface job is missing repositoryKey",
			);

		// WHY: Preview HTTP uploads must stay outside hosts.run so slow network I/O never blocks company merges or coding turns.
		const baseSha = preview.baseSha && preview.baseSha !== ZERO_SHA ? preview.baseSha : undefined;
		type PreparedPreview =
			| {
					readonly status: "conflicted";
					readonly lastCleanTreeSha: string;
					readonly changeIds: readonly string[];
					readonly paths: readonly string[];
			  }
			| { readonly status: "invalid"; readonly detail: string }
			| {
					readonly status: "build";
					readonly compositeCommitSha: string;
					readonly compositeTreeSha: string;
					readonly recipe: SurfacePreviewRecipe;
			  }
			| {
					readonly status: "ready";
					readonly compositeCommitSha: string;
					readonly compositeTreeSha: string;
					readonly files: readonly CodeSiteTreeFile[];
					readonly sharedAssets: Readonly<Record<string, string>>;
			  };

		const productFolderRoots = await this.#resolveProductFolderRoots(preview.profileId, signal);
		let prepared: PreparedPreview;
		try {
			const ran = await this.#runYieldable<PreparedPreview>(
				preview.profileId,
				environmentId,
				signal,
				async (codeHostJob) => {
					await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
					const composed = await composePreviewTree(codeHostJob, {
						repository,
						...(baseSha ? { baseSha } : {}),
						...(preview.reconciledCommitSha ? { reconciledCommitSha: preview.reconciledCommitSha } : {}),
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
					const plan = await this.#readPlan(codeHostJob, { repository, tree: composed.compositeTreeSha });
					if (plan.kind === "invalid") return { status: "invalid", detail: plan.detail };
					if (plan.kind === "build")
						return {
							status: "build",
							compositeCommitSha: composed.compositeCommitSha,
							compositeTreeSha: composed.compositeTreeSha,
							recipe: plan.recipe,
						};
					const treeData = await this.#readTree(codeHostJob, {
						repository,
						tree: composed.compositeTreeSha,
					});
					const sharedAssets = await readSharedIdentityAssets(codeHostJob, codeHostJob.signal, productFolderRoots);
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
			return await fail(surfaceFailureDetail(error, null, "Surface preview build failed"));
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
		if (prepared.status === "invalid") return await fail(prepared.detail);

		let site: ReadSite;
		if (prepared.status === "build") {
			if (!preview.leaseToken) return await fail("Preview job is missing its lease");
			let built: "parked" | "yielded" | ReadSite;
			try {
				built = await this.#builtSite(
					{
						kind: "preview",
						id: preview.previewId,
						leaseToken: preview.leaseToken,
						profileId: preview.profileId,
						environmentId,
						repository,
						commitSha: prepared.compositeCommitSha,
						treeSha: prepared.compositeTreeSha,
						recipe: prepared.recipe,
						productFolderRoots,
					},
					signal,
				);
			} catch (error) {
				if (signal.aborted) throw error;
				return await fail(surfaceFailureDetail(error, prepared.recipe.folder, "Surface preview build failed"));
			}
			if (built === "parked") return true;
			if (built === "yielded") return false;
			site = built;
		} else {
			site = { treeSha: prepared.compositeTreeSha, files: prepared.files, sharedAssets: prepared.sharedAssets };
		}

		try {
			const uploaded = await uploadPreparedSiteTree(
				this.#control,
				{
					surfaceId: preview.surfaceId,
					mainSha: prepared.compositeCommitSha,
					treeSha: site.treeSha,
					title: `Preview ${preview.shortHostId}`,
					promoteLive: false,
					files: site.files,
					sharedAssets: site.sharedAssets,
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
			return await fail(
				surfaceFailureDetail(
					error,
					prepared.status === "build" ? prepared.recipe.folder : null,
					"Surface preview upload failed",
				),
			);
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

		type PreparedPublish =
			| { readonly status: "invalid"; readonly detail: string }
			| {
					readonly status: "build";
					readonly headSha: string;
					readonly treeSha: string;
					readonly recipe: SurfacePreviewRecipe;
			  }
			| {
					readonly status: "ready";
					readonly headSha: string;
					readonly treeSha: string;
					readonly files: readonly CodeSiteTreeFile[];
					readonly sharedAssets: Readonly<Record<string, string>>;
			  };

		const environmentId = pub.environmentId;
		const failPublish = async (errorDetail: string): Promise<true> => {
			await controlPlane.completeSurfacePublish(
				{ jobId: pub.jobId, status: "failed", errorDetail, ...leaseField },
				signal,
			);
			return true;
		};
		const productFolderRoots = await this.#resolveProductFolderRoots(pub.profileId, signal);
		let prepared: PreparedPublish;
		try {
			const ran = await this.#runYieldable<PreparedPublish>(
				pub.profileId,
				environmentId,
				signal,
				async (codeHostJob) => {
					await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
					const resolved = await resolveMainHeadAndTree(codeHostJob, repository, explicitHeadSha);
					const plan = await this.#readPlan(codeHostJob, { repository, tree: resolved.treeSha });
					if (plan.kind === "invalid") return { status: "invalid", detail: plan.detail };
					if (plan.kind === "build")
						return { status: "build", headSha: resolved.headSha, treeSha: resolved.treeSha, recipe: plan.recipe };
					const treeData = await this.#readTree(codeHostJob, { repository, tree: resolved.treeSha });
					const sharedAssets = await readSharedIdentityAssets(codeHostJob, codeHostJob.signal, productFolderRoots);
					return {
						status: "ready",
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
			return await failPublish(surfaceFailureDetail(error, null, "Surface publish read failed"));
		}
		if (prepared.status === "invalid") return await failPublish(prepared.detail);

		let site: ReadSite;
		if (prepared.status === "build") {
			if (!pub.leaseToken) return await failPublish("Publish job is missing its lease");
			let built: "parked" | "yielded" | ReadSite;
			try {
				built = await this.#builtSite(
					{
						kind: "publish",
						id: pub.jobId,
						leaseToken: pub.leaseToken,
						profileId: pub.profileId,
						environmentId,
						repository,
						commitSha: prepared.headSha,
						treeSha: prepared.treeSha,
						recipe: prepared.recipe,
						productFolderRoots,
					},
					signal,
				);
			} catch (error) {
				if (signal.aborted) throw error;
				return await failPublish(
					surfaceFailureDetail(error, prepared.recipe.folder, "Surface publish build failed"),
				);
			}
			if (built === "parked") return true;
			if (built === "yielded") return false;
			site = built;
		} else {
			site = { treeSha: prepared.treeSha, files: prepared.files, sharedAssets: prepared.sharedAssets };
		}

		try {
			await uploadPreparedSiteTree(
				this.#control,
				{
					surfaceId: pub.surfaceId,
					mainSha: prepared.headSha,
					treeSha: site.treeSha,
					title: null,
					promoteLive: true,
					files: site.files,
					sharedAssets: site.sharedAssets,
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
			return await failPublish(
				surfaceFailureDetail(
					error,
					prepared.status === "build" ? prepared.recipe.folder : null,
					"Surface publish upload failed",
				),
			);
		}
	}
}
