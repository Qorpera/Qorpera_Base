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
	codeAreaPath,
	keptRepositoryOf,
	withJob,
} from "./code-host-jobs.ts";
import {
	type CodeSiteTreeFile,
	CodeSiteTreeInvalid,
	exportCodeSiteSource,
	readCodeSiteTree,
	readSurfacePreviewPlan,
	readSurfacePreviewPlanAndTree,
	readSurfaceSiteTree,
} from "./code-host-sites.ts";
import {
	composePreviewTree,
	discardSurfaceSessionWorktree,
	type RebaseSessionChangesResult,
} from "./code-host-surfaces.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CODE_SITE_EXTENSIONS, CODE_SITE_PATH, codeSiteManifest, codeSiteTreeProblem } from "./code-site.ts";
import { CODE_SITE_LIST_BYTES, CODE_SITE_LIST_FILES, type CodeSiteTreeRead } from "./code-site-uploads.ts";
import {
	type BuildAppImageFn,
	buildAppImageWithScript,
	buildNativeAppEnvSpec,
	type NativeEdgeHostingConfig,
	stopHostedAppDeployment,
	triggerBlueGreenAppDeploy,
} from "./native-webapp-deploy.ts";
import {
	type CompleteSurfaceMergeInput,
	type CompleteSurfacePreviewInput,
	type CompleteSurfacePublishInput,
	parseClaimedSurfaceJobs,
} from "./orchestrator.ts";
import {
	checkMissingBlobsOnEdge,
	computeCanonicalSiteManifest,
	isNativeServableSitePath,
	nativeSiteTreeProblem,
	putBlobToEdge,
	type SiteManifestPayload,
	uploadSiteBlobsToEdge,
} from "./site-blob-upload.ts";
import { type PeerOpenSessionInput, syncPeerSurfaceSessions } from "./surface-change-dispatcher.ts";
import {
	createSurfaceExecutionHandlers,
	parseSurfaceRepositoryKey,
	prepareSurfaceRepository,
	type SurfaceExecutionControlPlane,
	undoSurfaceCodeRepoChange,
} from "./surface-execution-bridge.ts";
import {
	previewSiteProblemDetail,
	type SurfaceAppSpec,
	type SurfacePreviewBuiltManifest,
	type SurfacePreviewPlan,
	type SurfacePreviewRecipe,
} from "./surface-preview-runner.ts";
import type {
	ClaimedSurfaceCleanupJob,
	ClaimedSurfaceMergeJob,
	ClaimedSurfacePreviewJob,
	ClaimedSurfacePublishJob,
} from "./surface-worker-loop.ts";

export const SURFACE_CODE_HOST_RPCS = [
	"qorpera_surface_claim_pending_jobs_for_lane",
	"qorpera_surface_complete_preview",
	"qorpera_surface_complete_merge",
	"qorpera_surface_complete_publish",
	"qorpera_surface_complete_cleanup",
	"qorpera_surface_renew_lease",
	"qorpera_surface_update_rebased_changes",
	"qorpera_surface_site_version_begin",
	"qorpera_surface_site_version_list",
	"qorpera_surface_site_version_put",
	"qorpera_surface_site_version_finish",
	"qorpera_surface_site_deployment_register",
	"qorpera_surface_site_deployment_set_upstream",
	"qorpera_surface_stale_app_deployments_due",
	"qorpera_surface_app_deployment_mark_stopped",
	"qorpera_surface_shared_product_folder_roots",
	"qorpera_surface_request_build",
] as const;

export type SurfaceCodeHostRpc = (typeof SURFACE_CODE_HOST_RPCS)[number];

export interface SurfaceCodeHostControl {
	call(method: SurfaceCodeHostRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export type SurfaceNativeEdgeOptions = NativeEdgeHostingConfig;

export type SurfaceAppSourceExport = (
	job: CodeHostJob,
	value: {
		repository: CloudCodingRepository;
		tree: string;
		kind?: "static" | "server" | "hybrid";
		useTreeDirectly?: boolean;
	},
) => Promise<{ sourceDir: string; cleanup?: () => Promise<void> }>;

export interface SurfaceCodeHostWorkerOptions {
	readonly control: SurfaceCodeHostControl;
	readonly hosts: Pick<CodeHostJobs, "run">;
	readonly readTree?: CodeSiteTreeRead;
	readonly readBuiltTree?: CodeSiteTreeRead;
	readonly readPlan?: SurfacePreviewPlanRead;
	readonly exportSource?: SurfaceAppSourceExport;
	readonly serialize?: <T>(repoKey: string, fn: () => Promise<T>) => Promise<T>;
	readonly nativeEdge?: SurfaceNativeEdgeOptions;
	readonly staleSweepIntervalMs?: number;
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
	| {
			readonly state: "built";
			readonly buildId: string;
			readonly builtTreeSha: string | null;
			readonly native?: SurfacePreviewBuiltManifest;
	  }
	| { readonly state: "waiting" | "failed" };

type ReadSite =
	| {
			readonly kind: "files";
			readonly treeSha: string;
			readonly files: readonly CodeSiteTreeFile[];
			readonly sharedAssets: Readonly<Record<string, string>>;
	  }
	| {
			readonly kind: "native_manifest";
			readonly treeSha: string;
			readonly native: SurfacePreviewBuiltManifest;
	  };

export interface SurfaceCodeHostPassResult {
	readonly previews: number;
	readonly merges: number;
	readonly publishes: number;
	readonly cleanups: number;
	readonly failed: number;
}

const PUT_RAW_PART_BYTES = 80 * 1024;
const PUT_BATCH_MAX_JSON_BYTES = 112 * 1024;
const PUT_BATCH_MAX_PARTS = 100;
const DEFAULT_UPLOAD_CONCURRENCY = 6;
const DEFAULT_COMPANY_CONCURRENCY = 4;
const MAX_SHARED_ASSET_READ_BYTES = 32 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
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

function surfaceFailureDetail(
	error: unknown,
	builtFolder: string | null,
	fallback: string,
	options?: { readonly native?: boolean },
): string {
	if (error instanceof CodeSiteTreeInvalid) return previewSiteProblemDetail(error.problem, builtFolder, options);
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
	options: { readonly readOnly?: boolean } = {},
): Promise<{ readonly headSha: string; readonly treeSha: string }> {
	const kept = keptRepositoryOf(repository);
	return await withJob(codeHostJob, kept, async (run) => {
		if (codeHostJob.preparedKeptArea !== run.area) {
			if (!(await run.prepare(undefined, { readOnly: options.readOnly === true })).seeded)
				throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
			if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null) {
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
			}
		}
		const targetRef =
			explicitHeadSha && GIT_SHA.test(explicitHeadSha) ? explicitHeadSha : `refs/heads/${kept.baseBranch}`;
		const lines = (
			await run.gitOk(
				run.repo,
				["rev-parse", `${targetRef}^{commit}`, `${targetRef}^{tree}`],
				"CODE_HOST_MAIN_MISSING",
			)
		)
			.toString("utf8")
			.trim()
			.split("\n");
		const headSha = lines[0]?.trim() ?? "";
		const treeSha = lines[1]?.trim() ?? "";
		if (lines.length !== 2 || !GIT_SHA.test(headSha) || !GIT_SHA.test(treeSha)) {
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

function parseBuiltManifest(answer: Record<string, unknown>): SurfacePreviewBuiltManifest | undefined {
	if (typeof answer.manifestSha256 !== "string" || !SHA256_HEX.test(answer.manifestSha256)) return undefined;
	const rawManifest = answer.manifestJson;
	if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) return undefined;
	const manifestObj = rawManifest as Record<string, unknown>;
	if (!manifestObj.files || typeof manifestObj.files !== "object" || Array.isArray(manifestObj.files))
		return undefined;
	if (
		typeof answer.fileCount !== "number" ||
		!Number.isSafeInteger(answer.fileCount) ||
		answer.fileCount < 1 ||
		typeof answer.totalBytes !== "number" ||
		!Number.isSafeInteger(answer.totalBytes) ||
		answer.totalBytes < 0
	) {
		return undefined;
	}
	return {
		manifestSha256: answer.manifestSha256,
		manifest: rawManifest as SiteManifestPayload,
		fileCount: answer.fileCount,
		totalBytes: answer.totalBytes,
		hasCredentialInputs: answer.hasCredentialInputs === true,
	};
}

function mergeNativeTreeWithSharedAssets(
	baseFiles: readonly CodeSiteTreeFile[],
	sharedAssets: Readonly<Record<string, string>> | undefined,
): CodeSiteTreeFile[] {
	const byPath = new Map<string, CodeSiteTreeFile>();
	for (const file of baseFiles) {
		byPath.set(file.path, file);
	}
	if (sharedAssets) {
		for (const [rawPath, text] of Object.entries(sharedAssets)) {
			const cleanPath = rawPath.replace(/^\/+/, "");
			if (!isNativeServableSitePath(cleanPath)) continue;
			const content = new TextEncoder().encode(text);
			byPath.set(cleanPath, {
				path: cleanPath,
				bytes: content.byteLength,
				sha256: sha256Hex(content),
				content,
			});
		}
	}
	const files = [...byPath.values()].sort((a, b) =>
		Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
	);
	const problem = nativeSiteTreeProblem(files);
	if (problem) throw new CodeSiteTreeInvalid(problem);
	return files;
}

async function overlaySharedAssetsOnNativeManifest(
	native: SurfacePreviewBuiltManifest,
	sharedAssets: Readonly<Record<string, string>>,
	nativeEdge: SurfaceNativeEdgeOptions,
	signal: AbortSignal,
): Promise<SurfacePreviewBuiltManifest> {
	const entries = Object.entries(sharedAssets);
	if (entries.length === 0) return native;
	const byPath = new Map<string, { readonly path: string; readonly bytes: number; readonly sha256: string }>();
	for (const [path, entry] of Object.entries(native.manifest.files)) {
		byPath.set(path, { path, bytes: entry.bytes, sha256: entry.sha256 });
	}
	const newBlobs = new Map<string, Uint8Array>();
	let changed = false;
	for (const [rawPath, text] of entries) {
		const cleanPath = rawPath.replace(/^\/+/, "");
		if (!isNativeServableSitePath(cleanPath)) continue;
		const content = new TextEncoder().encode(text);
		const sha256 = sha256Hex(content);
		const existing = byPath.get(cleanPath);
		if (existing && existing.sha256 === sha256 && existing.bytes === content.byteLength) continue;
		byPath.set(cleanPath, { path: cleanPath, bytes: content.byteLength, sha256 });
		newBlobs.set(sha256, content);
		changed = true;
	}
	if (!changed) return native;
	const merged = [...byPath.values()];
	const problem = nativeSiteTreeProblem(merged);
	if (problem) throw new CodeSiteTreeInvalid(problem);
	const missing = await checkMissingBlobsOnEdge({
		routerInternalUrl: nativeEdge.routerInternalUrl,
		controlToken: nativeEdge.controlToken,
		hashes: [...newBlobs.keys()],
		fetchImpl: nativeEdge.fetchImpl,
		signal,
	});
	for (const sha256 of missing) {
		const content = newBlobs.get(sha256);
		if (!content) continue;
		await putBlobToEdge({
			routerInternalUrl: nativeEdge.routerInternalUrl,
			controlToken: nativeEdge.controlToken,
			sha256,
			content,
			fetchImpl: nativeEdge.fetchImpl,
			signal,
		});
	}
	const recomputed = computeCanonicalSiteManifest(merged, {
		redirects: native.manifest.redirects,
		headers: native.manifest.headers,
		spaFallback: native.manifest.spa_fallback,
		notFoundPage: native.manifest.not_found_page,
	});
	return {
		manifestSha256: recomputed.manifestSha256,
		manifest: recomputed.manifest,
		fileCount: merged.length,
		totalBytes: recomputed.totalBytes,
		hasCredentialInputs: native.hasCredentialInputs,
	};
}

const OCI_DIGEST_REF_PATTERN = /^[^\s\x00-\x1f]+@sha256:[0-9a-f]{64}$/;
const DEFAULT_STALE_APP_SWEEP_INTERVAL_MS = 30_000;

interface SurfaceNativeAppDeploymentInput {
	readonly kind: "server" | "hybrid";
	readonly ociImageRef: string;
	readonly appPort: number;
	readonly healthPath: string;
	readonly idleTimeoutSec: number;
	readonly memoryMb: number;
	readonly vcpuLimit: number;
	readonly upstreamAddr: string | null;
	readonly envSpec: Readonly<Record<string, string>>;
}

async function registerSurfaceNativeDeployment(
	control: SurfaceCodeHostControl,
	input: {
		readonly surfaceId: string;
		readonly treeSha: string;
		readonly mainSha: string;
		readonly title: string | null;
		readonly promoteLive: boolean;
		readonly checkPublicPromote?: boolean;
		readonly native: SurfacePreviewBuiltManifest;
		readonly app?: SurfaceNativeAppDeploymentInput;
	},
	signal: AbortSignal,
): Promise<{
	readonly versionId: string;
	readonly siteId: string;
	readonly siteSlug: string;
	readonly deploymentId: string | null;
	readonly deploymentState: string | null;
}> {
	const args: Record<string, unknown> = {
		p_surface_id: input.surfaceId,
		p_tree_sha: input.treeSha,
		p_main_sha: input.mainSha,
		p_manifest_sha256: input.native.manifestSha256,
		p_manifest_json: input.native.manifest,
		p_file_count: input.native.fileCount,
		p_total_bytes: input.native.totalBytes,
		p_title: input.title,
		p_promote_live: input.promoteLive,
		p_has_credential_inputs: input.native.hasCredentialInputs,
	};
	if (input.checkPublicPromote === true) {
		args.p_check_public_promote = true;
	}
	if (input.app) {
		args.p_kind = input.app.kind;
		args.p_oci_image_ref = input.app.ociImageRef;
		args.p_app_port = input.app.appPort;
		args.p_health_path = input.app.healthPath;
		args.p_idle_timeout_sec = input.app.idleTimeoutSec;
		args.p_memory_mb = input.app.memoryMb;
		args.p_vcpu_limit = input.app.vcpuLimit;
		args.p_upstream_addr = input.app.upstreamAddr;
		args.p_env_spec = input.app.envSpec;
	}
	const raw = (await control.call("qorpera_surface_site_deployment_register", args, signal)) as {
		state?: unknown;
		deploymentState?: unknown;
		code?: unknown;
		versionId?: unknown;
		siteId?: unknown;
		siteSlug?: unknown;
		slug?: unknown;
		deploymentId?: unknown;
	} | null;
	if (!raw || typeof raw !== "object") {
		throw new Error("Surface native site deployment register returned an invalid answer");
	}
	if (raw.state === "refused") {
		throw new Error(`Surface site upload refused: ${String(raw.code ?? "UNKNOWN")}`);
	}
	const versionId = typeof raw.versionId === "string" && isUuid(raw.versionId) ? raw.versionId : null;
	const siteId = typeof raw.siteId === "string" && isUuid(raw.siteId) ? raw.siteId : null;
	const siteSlug = typeof raw.slug === "string" ? raw.slug : typeof raw.siteSlug === "string" ? raw.siteSlug : "";
	const deploymentId = typeof raw.deploymentId === "string" && isUuid(raw.deploymentId) ? raw.deploymentId : null;
	const deploymentState =
		typeof raw.deploymentState === "string" ? raw.deploymentState : typeof raw.state === "string" ? raw.state : null;
	if (!versionId || !siteId) {
		throw new Error("Surface native site deployment register did not return versionId and siteId");
	}
	if (input.app && !deploymentId) {
		throw new Error("Surface native app deployment register did not return deploymentId");
	}
	return { versionId, siteId, siteSlug, deploymentId, deploymentState };
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

const PREVIEW_BUILD_PLAN_TTL_MS = 5 * 60_000;
const PREVIEW_BUILD_PLAN_MAX = 256;
const MAX_PENDING_PEER_SYNCS_PER_COMPANY = 16;

interface PendingPeerSyncTask {
	readonly jobId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly environmentId: string;
	readonly repository: CloudCodingRepository;
	readonly mainAfter: string;
	readonly peerSessions: readonly PeerOpenSessionInput[];
}

function isUnseededAreaRefusal(error: unknown): boolean {
	return (
		error instanceof CodeHostRefusal &&
		(error.code === "CODE_HOST_NOT_SEEDED" || error.code === "CODE_HOST_AREA_NO_BASE")
	);
}

// WHY: Executes code_repo Surface previews, selective merges, rebases, undos, and live site publishes on coding-executor where LxdCodeHosts lives.
export class SurfaceCodeHostWorker {
	readonly #control: SurfaceCodeHostControl;
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #readTree: CodeSiteTreeRead;
	readonly #readBuiltTree: CodeSiteTreeRead;
	readonly #readPlan: SurfacePreviewPlanRead;
	readonly #exportSource: SurfaceAppSourceExport;
	readonly #serialize: (<T>(repoKey: string, fn: () => Promise<T>) => Promise<T>) | undefined;
	readonly #nativeEdge: SurfaceNativeEdgeOptions | undefined;
	readonly #staleSweepIntervalMs: number;
	#lastStaleSweepAt = 0;
	readonly #useCombinedPlanAndTree: boolean;
	readonly #previewBuildPlans = new Map<
		string,
		{
			readonly expiresAt: number;
			readonly compositeCommitSha: string;
			readonly compositeTreeSha: string;
			readonly recipe: SurfacePreviewRecipe;
			readonly app?: SurfaceAppSpec;
		}
	>();
	readonly #batchLimit: number;
	readonly #companyConcurrency: number;
	readonly #uploadConcurrency: number;
	readonly #leaseRenewIntervalMs: number;
	readonly #leaseExtendSeconds: number;
	readonly #completionRetryDelaysMs: readonly number[];
	readonly #yieldRetryDelaysMs: readonly number[];
	readonly #report: ((event: Record<string, unknown>) => void) | undefined;
	readonly #peerSyncQueues = new Map<string, PendingPeerSyncTask[]>();
	readonly #peerSyncRunners = new Map<string, Promise<void>>();
	readonly #peerSyncWaitingCompanies: string[] = [];
	readonly #peerSyncActiveCompanies = new Set<string>();
	readonly #peerSyncSignals = new Map<string, AbortSignal>();

	constructor(options: SurfaceCodeHostWorkerOptions) {
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#readTree = options.readTree ?? readSurfaceSiteTree;
		this.#readBuiltTree = options.readBuiltTree ?? readCodeSiteTree;
		this.#readPlan = options.readPlan ?? readSurfacePreviewPlan;
		this.#exportSource = options.exportSource ?? exportCodeSiteSource;
		this.#serialize = options.serialize;
		this.#nativeEdge = options.nativeEdge;
		this.#staleSweepIntervalMs = Math.max(0, options.staleSweepIntervalMs ?? DEFAULT_STALE_APP_SWEEP_INTERVAL_MS);
		this.#useCombinedPlanAndTree = options.readTree === undefined && options.readPlan === undefined;
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
		const cleanups = claimed.cleanups ?? [];

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
		for (const cleanup of cleanups) {
			leases.set(
				leaseKey("job", cleanup.jobId),
				this.#startLease("job", cleanup.jobId, cleanup.leaseToken ?? null, signal),
			);
		}

		// WHY: Serialize merges, publishes, previews, and cleanups within each company while running distinct companies concurrently.
		type CompanyWork = {
			readonly profileId: string;
			readonly merges: ClaimedSurfaceMergeJob[];
			readonly publishes: ClaimedSurfacePublishJob[];
			readonly previews: ClaimedSurfacePreviewJob[];
			readonly cleanups: ClaimedSurfaceCleanupJob[];
		};
		const byCompany = new Map<string, CompanyWork>();
		const bucketOf = (profileId: string): CompanyWork => {
			let bucket = byCompany.get(profileId);
			if (!bucket) {
				bucket = { profileId, merges: [], publishes: [], previews: [], cleanups: [] };
				byCompany.set(profileId, bucket);
			}
			return bucket;
		};
		for (const merge of merges) bucketOf(merge.profileId).merges.push(merge);
		for (const pub of publishes) bucketOf(pub.profileId).publishes.push(pub);
		for (const preview of previews) bucketOf(preview.profileId).previews.push(preview);
		for (const cleanup of cleanups) bucketOf(cleanup.profileId).cleanups.push(cleanup);

		let previewsDone = 0;
		let mergesDone = 0;
		let publishesDone = 0;
		let cleanupsDone = 0;
		let failed = 0;

		const runCompany = async (work: CompanyWork): Promise<void> => {
			for (const merge of work.merges) {
				if (signal.aborted) break;
				const lease = leases.get(leaseKey("job", merge.jobId))!;
				try {
					await this.#runMerge(merge, lease.signal, signal);
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

			for (const cleanup of work.cleanups) {
				if (signal.aborted) break;
				const lease = leases.get(leaseKey("job", cleanup.jobId))!;
				try {
					const completed = await this.#runCleanup(cleanup, lease.signal);
					if (completed) cleanupsDone += 1;
				} catch (error) {
					failed += 1;
					this.#emit({
						event: "surface-code-host-error",
						kind: "cleanup",
						jobId: cleanup.jobId,
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

		await this.#maybeSweepStaleAppDeployments(signal);

		return {
			previews: previewsDone,
			merges: mergesDone,
			publishes: publishesDone,
			cleanups: cleanupsDone,
			failed,
		};
	}

	async #maybeSweepStaleAppDeployments(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		const appHostInternalUrl = this.#nativeEdge?.appHostInternalUrl;
		const appHostControlToken = this.#nativeEdge?.appHostControlToken;
		if (!appHostInternalUrl || !appHostControlToken) return;
		const now = Date.now();
		if (this.#lastStaleSweepAt > 0 && now - this.#lastStaleSweepAt < this.#staleSweepIntervalMs) return;
		this.#lastStaleSweepAt = now;
		try {
			const raw = await this.#control.call("qorpera_surface_stale_app_deployments_due", { p_limit: 16 }, signal);
			if (!Array.isArray(raw) || raw.length === 0) return;
			for (const entry of raw) {
				if (signal.aborted) return;
				if (!entry || typeof entry !== "object") continue;
				const deploymentId = (entry as { deploymentId?: unknown }).deploymentId;
				const upstreamAddr =
					typeof (entry as { upstreamAddr?: unknown }).upstreamAddr === "string"
						? (entry as { upstreamAddr: string }).upstreamAddr
						: null;
				if (typeof deploymentId !== "string" || !isUuid(deploymentId)) continue;
				try {
					const claim = (await this.#control.call(
						"qorpera_surface_app_deployment_mark_stopped",
						{
							p_deployment_id: deploymentId,
							p_expected_upstream_addr: upstreamAddr,
							p_claim_only: true,
						},
						signal,
					)) as { claimed?: unknown } | null;
					if (!claim || claim.claimed !== true) continue;
					const stopRes = await stopHostedAppDeployment({
						appHostInternalUrl,
						controlToken: appHostControlToken,
						deploymentId,
						expectedUpstreamAddr: upstreamAddr,
						fetchImpl: this.#nativeEdge?.appHostFetchImpl,
						signal,
					});
					if (!stopRes.stopped) continue;
					await this.#control.call(
						"qorpera_surface_app_deployment_mark_stopped",
						{
							p_deployment_id: deploymentId,
							p_expected_upstream_addr: upstreamAddr,
						},
						signal,
					);
				} catch (error) {
					if (signal.aborted) return;
					this.#emit({
						event: "surface-app-deployment-stop-failed",
						deploymentId,
						error: error instanceof Error ? error.message : String(error),
					});
					await this.#control
						.call(
							"qorpera_surface_app_deployment_mark_stopped",
							{
								p_deployment_id: deploymentId,
								p_expected_upstream_addr: upstreamAddr,
								p_stop_failed: true,
							},
							signal,
						)
						.catch(() => undefined);
				}
			}
		} catch (error) {
			if (signal.aborted) return;
			this.#emit({
				event: "surface-app-deployment-sweep-failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #runYieldable<T>(
		profileId: string,
		environmentId: string,
		signal: AbortSignal,
		fn: (codeHostJob: CodeHostJob) => Promise<T>,
		options: { readonly readOnly?: boolean } = {},
	): Promise<{ readonly yielded: false; readonly value: T } | { readonly yielded: true }> {
		for (let attempt = 0; attempt <= this.#yieldRetryDelaysMs.length; attempt += 1) {
			try {
				const value = await this.#hosts.run(
					profileId,
					environmentId,
					signal,
					async (codeHostJob) => await fn(codeHostJob),
					{ yields: true, ...(options.readOnly ? { readOnly: true } : {}) },
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

	#previewPlanKey(
		preview: ClaimedSurfacePreviewJob,
		environmentId: string,
		baseSha: string | undefined,
	): string | null {
		if (!baseSha) return null;
		return JSON.stringify([
			preview.previewId,
			preview.profileId,
			environmentId,
			preview.repositoryKey,
			baseSha,
			preview.reconciledCommitSha ?? null,
			preview.exploration
				? [preview.exploration.sessionId, preview.exploration.baseSha, preview.exploration.headSha]
				: null,
			(preview.changes ?? []).map((change) => [change.changeId, change.parentSha, change.headSha]),
		]);
	}

	#getCachedPreviewPlan(key: string | null) {
		if (!key) return undefined;
		const cached = this.#previewBuildPlans.get(key);
		if (!cached) return undefined;
		if (cached.expiresAt <= Date.now()) {
			this.#previewBuildPlans.delete(key);
			return undefined;
		}
		this.#previewBuildPlans.delete(key);
		this.#previewBuildPlans.set(key, cached);
		return cached;
	}

	#setCachedPreviewPlan(
		key: string | null,
		value: {
			readonly compositeCommitSha: string;
			readonly compositeTreeSha: string;
			readonly recipe: SurfacePreviewRecipe;
			readonly app?: SurfaceAppSpec;
		},
	): void {
		if (!key) return;
		this.#previewBuildPlans.delete(key);
		this.#previewBuildPlans.set(key, { ...value, expiresAt: Date.now() + PREVIEW_BUILD_PLAN_TTL_MS });
		while (this.#previewBuildPlans.size > PREVIEW_BUILD_PLAN_MAX) {
			const oldest = this.#previewBuildPlans.keys().next().value;
			if (oldest === undefined) break;
			this.#previewBuildPlans.delete(oldest);
		}
	}

	#handlersForMergeJob(
		codeHostJob: CodeHostJob,
		overrides: {
			readonly controlPlane: SurfaceExecutionControlPlane;
			readonly deferRebase: (update: (rebaseSignal: AbortSignal) => Promise<void>) => void;
			readonly schedulePeerSync: (task: PendingPeerSyncTask) => void;
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
			schedulePeerSessionSync: (input) => {
				if (!input.environmentId || input.peerSessions.length === 0) return;
				overrides.schedulePeerSync({
					jobId: input.jobId,
					surfaceId: input.surfaceId,
					profileId: input.profileId,
					environmentId: input.environmentId,
					repository: input.repository,
					mainAfter: input.mainAfter,
					peerSessions: input.peerSessions,
				});
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

	async drainBackgroundPeerSyncs(): Promise<void> {
		while (this.#peerSyncRunners.size > 0 || this.#peerSyncWaitingCompanies.length > 0) {
			const running = [...this.#peerSyncRunners.values()];
			if (running.length === 0) break;
			await Promise.allSettled(running);
		}
	}

	// WHY: Run peer session rebases as yieldable, bounded background work after Approve completes so user merges never wait on peer worktrees.
	#enqueueBackgroundPeerSync(task: PendingPeerSyncTask, signal: AbortSignal): void {
		if (signal.aborted || task.peerSessions.length === 0) return;
		let queue = this.#peerSyncQueues.get(task.profileId);
		if (!queue) {
			queue = [];
			this.#peerSyncQueues.set(task.profileId, queue);
		}
		if (queue.length >= MAX_PENDING_PEER_SYNCS_PER_COMPANY) {
			queue.shift();
		}
		queue.push(task);
		this.#peerSyncSignals.set(task.profileId, signal);
		this.#schedulePeerSyncCompany(task.profileId);
	}

	#schedulePeerSyncCompany(profileId: string): void {
		if (this.#peerSyncActiveCompanies.has(profileId)) return;
		if (this.#peerSyncActiveCompanies.size >= this.#companyConcurrency) {
			if (!this.#peerSyncWaitingCompanies.includes(profileId)) {
				this.#peerSyncWaitingCompanies.push(profileId);
			}
			return;
		}
		this.#peerSyncActiveCompanies.add(profileId);
		const runner = this.#drainCompanyPeerSyncQueue(profileId).finally(() => {
			this.#peerSyncActiveCompanies.delete(profileId);
			this.#peerSyncRunners.delete(profileId);
			const remaining = this.#peerSyncQueues.get(profileId);
			if (remaining && remaining.length > 0 && !this.#peerSyncSignals.get(profileId)?.aborted) {
				this.#schedulePeerSyncCompany(profileId);
			} else {
				this.#peerSyncQueues.delete(profileId);
				this.#peerSyncSignals.delete(profileId);
			}
			while (
				this.#peerSyncActiveCompanies.size < this.#companyConcurrency &&
				this.#peerSyncWaitingCompanies.length > 0
			) {
				const nextProfileId = this.#peerSyncWaitingCompanies.shift()!;
				const nextQueue = this.#peerSyncQueues.get(nextProfileId);
				if (nextQueue && nextQueue.length > 0 && !this.#peerSyncSignals.get(nextProfileId)?.aborted) {
					this.#schedulePeerSyncCompany(nextProfileId);
				} else {
					this.#peerSyncQueues.delete(nextProfileId);
					this.#peerSyncSignals.delete(nextProfileId);
				}
			}
		});
		this.#peerSyncRunners.set(profileId, runner);
	}

	async #drainCompanyPeerSyncQueue(profileId: string): Promise<void> {
		while (true) {
			const signal = this.#peerSyncSignals.get(profileId);
			if (!signal || signal.aborted) return;
			const queue = this.#peerSyncQueues.get(profileId);
			const task = queue?.shift();
			if (!task) return;
			for (const peer of task.peerSessions) {
				if (signal.aborted) return;
				try {
					const ran = await this.#runYieldable(task.profileId, task.environmentId, signal, async (codeHostJob) => {
						const synced = await syncPeerSurfaceSessions(codeHostJob, {
							repository: task.repository,
							ontoSha: task.mainAfter,
							peerSessions: [peer],
						});
						return synced[0] ?? null;
					});
					if (ran.yielded) {
						this.#emit({
							event: "surface-code-host-peer-sync-yielded",
							jobId: task.jobId,
							surfaceId: task.surfaceId,
							sessionId: peer.sessionId,
						});
						continue;
					}
					if (!ran.value) continue;
					const peerOutcome = ran.value;
					await retryCommittedCompletion(
						(attemptSignal) =>
							this.#persistRebaseOutcome(
								task.surfaceId,
								peerOutcome.sessionId,
								peerOutcome.result,
								attemptSignal,
							),
						signal,
						this.#completionRetryDelaysMs,
					);
				} catch (error) {
					if (signal.aborted) return;
					this.#emit({
						event: "surface-code-host-rebase-persist-failed",
						jobId: task.jobId,
						surfaceId: task.surfaceId,
						sessionId: peer.sessionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
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
			readonly deferSettle?: boolean;
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
				...(input.deferSettle ? { p_defer_settle: true } : {}),
			},
			signal,
		);
		const answer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const buildId = typeof answer.buildId === "string" && isUuid(answer.buildId) ? answer.buildId : null;
		if (answer.state === "failed") return { state: "failed" };
		if (buildId === null) throw new Error("Surface build request returned an invalid answer");
		if (answer.state === "built") {
			const builtTreeSha =
				typeof answer.builtTreeSha === "string" && GIT_SHA.test(answer.builtTreeSha) ? answer.builtTreeSha : null;
			const native = parseBuiltManifest(answer);
			if (builtTreeSha !== null || native !== undefined) {
				return {
					state: "built",
					buildId,
					builtTreeSha,
					...(native !== undefined ? { native } : {}),
				};
			}
		}
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
		const ran = await this.#runYieldable<ReadSite | null>(
			at.profileId,
			at.environmentId,
			signal,
			async (job) => {
				let files: readonly CodeSiteTreeFile[];
				try {
					files = (await this.#readBuiltTree(job, { repository, tree: builtTreeSha })).files;
				} catch (error) {
					if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_SITE_TREE_UNKNOWN") return null;
					throw error;
				}
				return {
					kind: "files",
					treeSha: builtTreeSha,
					files,
					sharedAssets: await readSharedIdentityAssets(job, job.signal, productFolderRoots),
				};
			},
			{ readOnly: true },
		);
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
			readonly deferSettle?: boolean;
		},
		signal: AbortSignal,
	): Promise<"parked" | "yielded" | ReadSite> {
		let stale: string | null = null;
		for (let ask = 0; ask < 2; ask += 1) {
			const answer = await this.#requestBuild({ ...input, staleBuiltTree: stale }, signal);
			if (answer.state !== "built") return "parked";
			if (answer.native && this.#nativeEdge) {
				const hashes = Object.values(answer.native.manifest.files).map((entry) => entry.sha256);
				const missing = await checkMissingBlobsOnEdge({
					routerInternalUrl: this.#nativeEdge.routerInternalUrl,
					controlToken: this.#nativeEdge.controlToken,
					hashes,
					fetchImpl: this.#nativeEdge.fetchImpl,
					signal,
				});
				if (missing.size > 0) {
					stale = answer.native.manifestSha256;
					continue;
				}
				const sharedRun = await this.#runYieldable(
					input.profileId,
					input.environmentId,
					signal,
					async (job) => await readSharedIdentityAssets(job, job.signal, input.productFolderRoots),
					{ readOnly: true },
				);
				if (sharedRun.yielded) return "yielded";
				const native = await overlaySharedAssetsOnNativeManifest(
					answer.native,
					sharedRun.value,
					this.#nativeEdge,
					signal,
				);
				return { kind: "native_manifest", treeSha: input.treeSha, native };
			}
			if (answer.builtTreeSha === null) {
				throw new Error("The built site requires native edge storage");
			}
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

	async #deployAppSite(
		input: {
			readonly surfaceId: string;
			readonly profileId: string;
			readonly environmentId: string;
			readonly repository: CloudCodingRepository;
			readonly commitSha: string;
			readonly treeSha: string;
			readonly title: string | null;
			readonly promoteLive: boolean;
			readonly app: SurfaceAppSpec;
			readonly staticSite: ReadSite | null;
		},
		signal: AbortSignal,
	): Promise<
		| { readonly yielded: true }
		| {
				readonly yielded: false;
				readonly versionId: string;
				readonly siteId: string;
				readonly siteSlug: string;
				readonly deploymentId: string;
		  }
	> {
		const nativeEdge = this.#nativeEdge;
		const appHostInternalUrl = nativeEdge?.appHostInternalUrl;
		const appHostControlToken = nativeEdge?.appHostControlToken;
		if (!nativeEdge || !appHostInternalUrl || !appHostControlToken) {
			throw new Error("Surface server/hybrid apps require native app-host hosting");
		}

		let native: SurfacePreviewBuiltManifest;
		if (input.app.kind === "hybrid" && input.staticSite?.kind === "native_manifest") {
			native = input.staticSite.native;
		} else if (
			input.app.kind === "hybrid" &&
			input.staticSite?.kind === "files" &&
			input.staticSite.files.length > 0
		) {
			const mergedFiles = mergeNativeTreeWithSharedAssets(input.staticSite.files, input.staticSite.sharedAssets);
			const uploaded = await uploadSiteBlobsToEdge({
				routerInternalUrl: nativeEdge.routerInternalUrl,
				controlToken: nativeEdge.controlToken,
				files: mergedFiles,
				spaFallback: input.app.spaFallback,
				concurrency: this.#uploadConcurrency,
				fetchImpl: nativeEdge.fetchImpl,
				signal,
			});
			native = {
				manifestSha256: uploaded.manifestSha256,
				manifest: uploaded.manifest,
				fileCount: uploaded.fileCount,
				totalBytes: uploaded.totalBytes,
				hasCredentialInputs: uploaded.hasCredentialInputs,
			};
		} else {
			native = {
				manifestSha256: createHash("sha256").update(`${input.app.kind}:${input.treeSha}`, "utf8").digest("hex"),
				manifest: {
					files: {},
					redirects: [],
					headers: [],
					spa_fallback: input.app.spaFallback,
					not_found_page: null,
				},
				fileCount: 0,
				totalBytes: 0,
				hasCredentialInputs: false,
			};
		}

		const repoKey = `${input.environmentId}:${input.repository.owner.toLowerCase()}/${input.repository.name.toLowerCase()}`;
		const buildAndDeploy = async (): Promise<
			| { readonly yielded: true }
			| {
					readonly yielded: false;
					readonly versionId: string;
					readonly siteId: string;
					readonly siteSlug: string;
					readonly deploymentId: string;
			  }
		> => {
			const exported = await this.#runYieldable(
				input.profileId,
				input.environmentId,
				signal,
				(codeHostJob) =>
					this.#exportSource(codeHostJob, {
						repository: input.repository,
						tree: input.commitSha,
						kind: input.app.kind,
						useTreeDirectly: true,
					}),
				{ readOnly: true },
			);
			if (exported.yielded) return { yielded: true };

			let ociImageRef: string;
			try {
				const builderFn: BuildAppImageFn =
					nativeEdge.buildAppImage ??
					((buildInput, buildSignal) =>
						buildAppImageWithScript(
							nativeEdge.builderScriptPath ?? "/usr/local/libexec/qorpera-web-hosting/builder-railpack.sh",
							buildInput,
							buildSignal,
						));
				const built = await builderFn(
					{
						target: {
							companyId: input.profileId,
							environmentId: input.environmentId,
							owner: input.repository.owner,
							name: input.repository.name,
						},
						change: 0,
						tree: input.treeSha,
						sourceDir: exported.value.sourceDir,
						dockerfile: input.app.dockerfile,
						port: input.app.port,
						registryPrefix: nativeEdge.registryPrefix ?? "127.0.0.1:5000/qorpera-apps",
					},
					signal,
				);
				if (!OCI_DIGEST_REF_PATTERN.test(built.ociImageRef)) {
					throw new Error("APP_IMAGE_REF_INVALID");
				}
				ociImageRef = built.ociImageRef;
			} finally {
				await exported.value.cleanup?.().catch(() => undefined);
			}

			const envSpec = buildNativeAppEnvSpec({
				port: input.app.port,
				repositoryOwner: input.repository.owner,
				repositoryName: input.repository.name,
				companyDataUrl: nativeEdge.companyDataUrl,
				objectStorageUrl: nativeEdge.objectStorageUrl,
			});
			const appMeta: Omit<SurfaceNativeAppDeploymentInput, "upstreamAddr"> = {
				kind: input.app.kind,
				ociImageRef,
				appPort: input.app.port,
				healthPath: input.app.healthPath,
				idleTimeoutSec: input.app.idleTimeoutSec,
				memoryMb: input.app.memoryMb,
				vcpuLimit: input.app.vcpuLimit,
				envSpec,
			};

			// WHY: Register non-live first (with public-promote refusals pre-checked) so startup failures never replace live.
			const registered = await registerSurfaceNativeDeployment(
				this.#control,
				{
					surfaceId: input.surfaceId,
					treeSha: input.treeSha,
					mainSha: input.commitSha,
					title: input.title,
					promoteLive: false,
					checkPublicPromote: input.promoteLive,
					native,
					app: { ...appMeta, upstreamAddr: null },
				},
				signal,
			);
			const deploymentId = registered.deploymentId!;
			const deployed = await triggerBlueGreenAppDeploy({
				appHostInternalUrl,
				controlToken: appHostControlToken,
				deploymentId,
				siteId: registered.siteId,
				slug: registered.siteSlug,
				environmentId: input.environmentId,
				ociImageRef,
				healthPath: input.app.healthPath,
				idleTimeoutSec: input.app.idleTimeoutSec,
				memoryMb: input.app.memoryMb,
				vcpuLimit: input.app.vcpuLimit,
				env: envSpec,
				isPreview: !input.promoteLive,
				fetchImpl: nativeEdge.appHostFetchImpl,
				signal,
			});

			const recordUpstreamFallback = async (): Promise<void> => {
				await this.#control
					.call(
						"qorpera_surface_site_deployment_set_upstream",
						{
							p_deployment_id: deploymentId,
							p_upstream_addr: deployed.upstreamAddr,
						},
						AbortSignal.timeout(5_000),
					)
					.catch(() => undefined);
			};

			const rollbackDeployedContainer = async (
				verifyLiveFirst: boolean,
			): Promise<{ readonly promotedLive: boolean; readonly uncertain: boolean }> => {
				if (registered.deploymentState === "live") {
					await recordUpstreamFallback();
					return { promotedLive: false, uncertain: false };
				}
				if (verifyLiveFirst) {
					let claim: { claimed?: unknown; isLive?: unknown } | null = null;
					let claimResolved = false;
					for (let attempt = 0; attempt < 3; attempt += 1) {
						try {
							claim = (await this.#control.call(
								"qorpera_surface_app_deployment_mark_stopped",
								{
									p_deployment_id: deploymentId,
									p_force: true,
									p_claim_only: true,
								},
								AbortSignal.timeout(10_000),
							)) as { claimed?: unknown; isLive?: unknown } | null;
							claimResolved = true;
							break;
						} catch {
							if (attempt < 2) {
								await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
							}
						}
					}
					if (!claimResolved) {
						await recordUpstreamFallback();
						return { promotedLive: false, uncertain: true };
					}
					if (claim?.isLive === true) {
						return { promotedLive: true, uncertain: false };
					}
					if (claim?.claimed !== true) {
						await recordUpstreamFallback();
						return { promotedLive: false, uncertain: false };
					}
				}
				try {
					const stopRes = await stopHostedAppDeployment({
						appHostInternalUrl,
						controlToken: appHostControlToken,
						deploymentId,
						expectedUpstreamAddr: deployed.upstreamAddr,
						fetchImpl: nativeEdge.appHostFetchImpl,
						signal: AbortSignal.timeout(10_000),
					});
					if (stopRes.stopped) {
						await this.#control
							.call(
								"qorpera_surface_app_deployment_mark_stopped",
								{ p_deployment_id: deploymentId, p_force: true },
								AbortSignal.timeout(5_000),
							)
							.catch(() => undefined);
					}
				} catch {
					await recordUpstreamFallback();
				}
				return { promotedLive: false, uncertain: false };
			};

			if (input.promoteLive) {
				try {
					const promoted = await registerSurfaceNativeDeployment(
						this.#control,
						{
							surfaceId: input.surfaceId,
							treeSha: input.treeSha,
							mainSha: input.commitSha,
							title: input.title,
							promoteLive: true,
							native,
							app: { ...appMeta, upstreamAddr: deployed.upstreamAddr },
						},
						signal,
					);
					return {
						yielded: false,
						versionId: promoted.versionId,
						siteId: promoted.siteId,
						siteSlug: promoted.siteSlug,
						deploymentId: promoted.deploymentId ?? deploymentId,
					};
				} catch (error) {
					const rollback = await rollbackDeployedContainer(true);
					if (rollback.promotedLive) {
						return {
							yielded: false,
							versionId: registered.versionId,
							siteId: registered.siteId,
							siteSlug: registered.siteSlug,
							deploymentId,
						};
					}
					if (rollback.uncertain) {
						return { yielded: true };
					}
					throw error;
				}
			}

			try {
				await this.#control.call(
					"qorpera_surface_site_deployment_set_upstream",
					{
						p_deployment_id: deploymentId,
						p_upstream_addr: deployed.upstreamAddr,
					},
					signal,
				);
			} catch (error) {
				await rollbackDeployedContainer(false);
				throw error;
			}
			return {
				yielded: false,
				versionId: registered.versionId,
				siteId: registered.siteId,
				siteSlug: registered.siteSlug,
				deploymentId,
			};
		};

		return this.#serialize ? await this.#serialize(repoKey, buildAndDeploy) : await buildAndDeploy();
	}

	async #uploadSite(
		input: {
			readonly surfaceId: string;
			readonly mainSha: string;
			readonly title: string | null;
			readonly promoteLive: boolean;
			readonly site: ReadSite;
		},
		signal: AbortSignal,
	): Promise<{ readonly versionId: string; readonly siteId: string; readonly siteSlug: string }> {
		if (this.#nativeEdge) {
			if (input.site.kind === "native_manifest") {
				return await registerSurfaceNativeDeployment(
					this.#control,
					{
						surfaceId: input.surfaceId,
						treeSha: input.site.treeSha,
						mainSha: input.mainSha,
						title: input.title,
						promoteLive: input.promoteLive,
						native: input.site.native,
					},
					signal,
				);
			}
			const mergedFiles = mergeNativeTreeWithSharedAssets(input.site.files, input.site.sharedAssets);
			const uploaded = await uploadSiteBlobsToEdge({
				routerInternalUrl: this.#nativeEdge.routerInternalUrl,
				controlToken: this.#nativeEdge.controlToken,
				files: mergedFiles,
				concurrency: this.#uploadConcurrency,
				fetchImpl: this.#nativeEdge.fetchImpl,
				signal,
			});
			return await registerSurfaceNativeDeployment(
				this.#control,
				{
					surfaceId: input.surfaceId,
					treeSha: input.site.treeSha,
					mainSha: input.mainSha,
					title: input.title,
					promoteLive: input.promoteLive,
					native: {
						manifestSha256: uploaded.manifestSha256,
						manifest: uploaded.manifest,
						fileCount: uploaded.fileCount,
						totalBytes: uploaded.totalBytes,
						hasCredentialInputs: uploaded.hasCredentialInputs,
					},
				},
				signal,
			);
		}
		if (input.site.kind === "native_manifest") {
			throw new Error("Native site manifest cannot be uploaded without nativeEdge");
		}
		return await uploadPreparedSiteTree(
			this.#control,
			{
				surfaceId: input.surfaceId,
				mainSha: input.mainSha,
				treeSha: input.site.treeSha,
				title: input.title,
				promoteLive: input.promoteLive,
				files: input.site.files,
				sharedAssets: input.site.sharedAssets,
				uploadConcurrency: this.#uploadConcurrency,
			},
			signal,
		);
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
					readonly status: "app";
					readonly compositeCommitSha: string;
					readonly compositeTreeSha: string;
					readonly app: SurfaceAppSpec;
					readonly files?: readonly CodeSiteTreeFile[];
					readonly sharedAssets?: Readonly<Record<string, string>>;
			  }
			| {
					readonly status: "ready";
					readonly compositeCommitSha: string;
					readonly compositeTreeSha: string;
					readonly files: readonly CodeSiteTreeFile[];
					readonly sharedAssets: Readonly<Record<string, string>>;
			  };

		const productFolderRoots = await this.#resolveProductFolderRoots(preview.profileId, signal);
		const planCacheKey = this.#previewPlanKey(preview, environmentId, baseSha);
		const cachedBuildPlan = this.#getCachedPreviewPlan(planCacheKey);
		const area = codeAreaPath(repository);
		const readPlanAndTree = async (
			preparedJob: CodeHostJob,
			compositeCommitSha: string,
			compositeTreeSha: string,
		): Promise<PreparedPreview> => {
			if (this.#useCombinedPlanAndTree) {
				const combined = await readSurfacePreviewPlanAndTree(preparedJob, { repository, tree: compositeTreeSha });
				if (combined.kind === "invalid") return { status: "invalid", detail: combined.detail };
				if (combined.kind === "app") {
					const sharedAssets =
						combined.files && combined.files.length > 0
							? await readSharedIdentityAssets(preparedJob, preparedJob.signal, productFolderRoots)
							: undefined;
					return {
						status: "app",
						compositeCommitSha,
						compositeTreeSha,
						app: combined.app,
						...(combined.files ? { files: combined.files } : {}),
						...(sharedAssets ? { sharedAssets } : {}),
					};
				}
				if (combined.kind === "build") {
					return {
						status: "build",
						compositeCommitSha,
						compositeTreeSha,
						recipe: combined.recipe,
					};
				}
				const sharedAssets = await readSharedIdentityAssets(preparedJob, preparedJob.signal, productFolderRoots);
				return {
					status: "ready",
					compositeCommitSha,
					compositeTreeSha,
					files: combined.files,
					sharedAssets,
				};
			}
			const plan = await this.#readPlan(preparedJob, { repository, tree: compositeTreeSha });
			if (plan.kind === "invalid") return { status: "invalid", detail: plan.detail };
			if (plan.kind === "app") {
				if (plan.app.kind === "hybrid" && plan.app.recipe === null) {
					try {
						const treeData = await this.#readTree(preparedJob, { repository, tree: compositeTreeSha });
						const sharedAssets = await readSharedIdentityAssets(
							preparedJob,
							preparedJob.signal,
							productFolderRoots,
						);
						return {
							status: "app",
							compositeCommitSha,
							compositeTreeSha,
							app: plan.app,
							files: treeData.files,
							sharedAssets,
						};
					} catch (error) {
						if (
							error instanceof CodeSiteTreeInvalid &&
							(error.problem.code === "SITE_FOLDER_MISSING" || error.problem.code === "SITE_NO_INDEX")
						) {
							return { status: "app", compositeCommitSha, compositeTreeSha, app: plan.app, files: [] };
						}
						throw error;
					}
				}
				return { status: "app", compositeCommitSha, compositeTreeSha, app: plan.app };
			}
			if (plan.kind === "build") {
				return {
					status: "build",
					compositeCommitSha,
					compositeTreeSha,
					recipe: plan.recipe,
				};
			}
			const treeData = await this.#readTree(preparedJob, {
				repository,
				tree: compositeTreeSha,
			});
			const sharedAssets = await readSharedIdentityAssets(preparedJob, preparedJob.signal, productFolderRoots);
			return {
				status: "ready",
				compositeCommitSha,
				compositeTreeSha,
				files: treeData.files,
				sharedAssets,
			};
		};
		const composeAndRead = async (codeHostJob: CodeHostJob, seedFirst: boolean): Promise<PreparedPreview> => {
			if (seedFirst) {
				await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
			}
			const composeJob: CodeHostJob = seedFirst ? { ...codeHostJob, preparedKeptArea: area } : codeHostJob;
			const composed = await composePreviewTree(composeJob, {
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
			const preparedJob: CodeHostJob = { ...codeHostJob, preparedKeptArea: area };
			return await readPlanAndTree(preparedJob, composed.compositeCommitSha, composed.compositeTreeSha);
		};
		const canReadOnlyPreview =
			(preview.changes ?? []).length === 0 &&
			(!preview.exploration || preview.exploration.baseSha === preview.exploration.headSha);

		let prepared: PreparedPreview;
		if (cachedBuildPlan) {
			// WHY: Pass 2 after a parked preview build reuses the deterministic Pass 1 compose result instead of re-running all code-host compose execs.
			prepared = cachedBuildPlan.app
				? {
						status: "app",
						compositeCommitSha: cachedBuildPlan.compositeCommitSha,
						compositeTreeSha: cachedBuildPlan.compositeTreeSha,
						app: cachedBuildPlan.app,
					}
				: {
						status: "build",
						compositeCommitSha: cachedBuildPlan.compositeCommitSha,
						compositeTreeSha: cachedBuildPlan.compositeTreeSha,
						recipe: cachedBuildPlan.recipe,
					};
		} else {
			try {
				let ran: { readonly yielded: false; readonly value: PreparedPreview } | { readonly yielded: true };
				try {
					ran = await this.#runYieldable<PreparedPreview>(
						preview.profileId,
						environmentId,
						signal,
						(codeHostJob) => composeAndRead(codeHostJob, false),
						canReadOnlyPreview ? { readOnly: true } : undefined,
					);
				} catch (error) {
					if (!isUnseededAreaRefusal(error) || signal.aborted) throw error;
					ran = await this.#runYieldable<PreparedPreview>(
						preview.profileId,
						environmentId,
						signal,
						(codeHostJob) => composeAndRead(codeHostJob, true),
					);
				}
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
				return await fail(
					surfaceFailureDetail(error, null, "Surface preview build failed", { native: Boolean(this.#nativeEdge) }),
				);
			}
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

		if (prepared.status === "app") {
			let staticSite: ReadSite | null = null;
			if (prepared.app.recipe !== null) {
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
							recipe: prepared.app.recipe,
							productFolderRoots,
							deferSettle: true,
						},
						signal,
					);
				} catch (error) {
					if (planCacheKey) this.#previewBuildPlans.delete(planCacheKey);
					if (signal.aborted) throw error;
					return await fail(
						surfaceFailureDetail(error, prepared.app.recipe.folder, "Surface preview build failed", {
							native: Boolean(this.#nativeEdge),
						}),
					);
				}
				if (built === "parked") {
					this.#setCachedPreviewPlan(planCacheKey, {
						compositeCommitSha: prepared.compositeCommitSha,
						compositeTreeSha: prepared.compositeTreeSha,
						recipe: prepared.app.recipe,
						app: prepared.app,
					});
					return true;
				}
				if (built === "yielded") return false;
				if (planCacheKey) this.#previewBuildPlans.delete(planCacheKey);
				staticSite = built;
			} else if (prepared.files && prepared.files.length > 0) {
				staticSite = {
					kind: "files",
					treeSha: prepared.compositeTreeSha,
					files: prepared.files,
					sharedAssets: prepared.sharedAssets ?? {},
				};
			}

			try {
				const deployed = await this.#deployAppSite(
					{
						surfaceId: preview.surfaceId,
						profileId: preview.profileId,
						environmentId,
						repository,
						commitSha: prepared.compositeCommitSha,
						treeSha: prepared.compositeTreeSha,
						title: `Preview ${preview.shortHostId}`,
						promoteLive: false,
						app: prepared.app,
						staticSite,
					},
					signal,
				);
				if (deployed.yielded) {
					this.#emit({
						event: "surface-code-host-yielded",
						kind: "preview",
						previewId: preview.previewId,
						surfaceId: preview.surfaceId,
					});
					return false;
				}
				await controlPlane.completeSurfacePreview(
					{
						previewId: preview.previewId,
						status: "ready",
						compositeTreeSha: prepared.compositeTreeSha,
						siteVersionId: deployed.versionId,
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
						prepared.app.recipe ? prepared.app.recipe.folder : null,
						"Surface preview app deploy failed",
						{ native: Boolean(this.#nativeEdge) },
					),
				);
			}
		}

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
				if (planCacheKey) this.#previewBuildPlans.delete(planCacheKey);
				if (signal.aborted) throw error;
				return await fail(
					surfaceFailureDetail(error, prepared.recipe.folder, "Surface preview build failed", {
						native: Boolean(this.#nativeEdge),
					}),
				);
			}
			if (built === "parked") {
				this.#setCachedPreviewPlan(planCacheKey, {
					compositeCommitSha: prepared.compositeCommitSha,
					compositeTreeSha: prepared.compositeTreeSha,
					recipe: prepared.recipe,
				});
				return true;
			}
			if (built === "yielded") return false;
			if (planCacheKey) this.#previewBuildPlans.delete(planCacheKey);
			site = built;
		} else {
			site = {
				kind: "files",
				treeSha: prepared.compositeTreeSha,
				files: prepared.files,
				sharedAssets: prepared.sharedAssets,
			};
		}

		try {
			const uploaded = await this.#uploadSite(
				{
					surfaceId: preview.surfaceId,
					mainSha: prepared.compositeCommitSha,
					title: `Preview ${preview.shortHostId}`,
					promoteLive: false,
					site,
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
					{ native: Boolean(this.#nativeEdge) },
				),
			);
		}
	}

	async #runMerge(merge: ClaimedSurfaceMergeJob, signal: AbortSignal, backgroundSignal: AbortSignal): Promise<void> {
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
		const scheduledPeerSyncs: PendingPeerSyncTask[] = [];
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
					schedulePeerSync: (task) => scheduledPeerSyncs.push(task),
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
			// WHY: Always attempt best-effort persistence of rebased sibling SHAs and enqueue background peer rebases so worktrees and database SHAs converge.
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
			for (const task of scheduledPeerSyncs) {
				this.#enqueueBackgroundPeerSync(task, backgroundSignal);
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
			typeof pub.liveHeadSha === "string"
				? pub.liveHeadSha
				: typeof pub.payload.liveHeadSha === "string"
					? pub.payload.liveHeadSha
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
					readonly status: "app";
					readonly headSha: string;
					readonly treeSha: string;
					readonly app: SurfaceAppSpec;
					readonly files?: readonly CodeSiteTreeFile[];
					readonly sharedAssets?: Readonly<Record<string, string>>;
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
		const area = codeAreaPath(repository);
		const readPublish = async (codeHostJob: CodeHostJob, seedFirst: boolean): Promise<PreparedPublish> => {
			if (seedFirst) {
				await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
			}
			const resolveJob: CodeHostJob = seedFirst ? { ...codeHostJob, preparedKeptArea: area } : codeHostJob;
			const resolved = await resolveMainHeadAndTree(resolveJob, repository, explicitHeadSha, {
				readOnly: !seedFirst,
			});
			const preparedJob: CodeHostJob = { ...codeHostJob, preparedKeptArea: area };
			if (this.#useCombinedPlanAndTree) {
				const combined = await readSurfacePreviewPlanAndTree(preparedJob, { repository, tree: resolved.treeSha });
				if (combined.kind === "invalid") return { status: "invalid", detail: combined.detail };
				if (combined.kind === "app") {
					const sharedAssets =
						combined.files && combined.files.length > 0
							? await readSharedIdentityAssets(preparedJob, preparedJob.signal, productFolderRoots)
							: undefined;
					return {
						status: "app",
						headSha: resolved.headSha,
						treeSha: resolved.treeSha,
						app: combined.app,
						...(combined.files ? { files: combined.files } : {}),
						...(sharedAssets ? { sharedAssets } : {}),
					};
				}
				if (combined.kind === "build") {
					return {
						status: "build",
						headSha: resolved.headSha,
						treeSha: resolved.treeSha,
						recipe: combined.recipe,
					};
				}
				const sharedAssets = await readSharedIdentityAssets(preparedJob, preparedJob.signal, productFolderRoots);
				return {
					status: "ready",
					headSha: resolved.headSha,
					treeSha: resolved.treeSha,
					files: combined.files,
					sharedAssets,
				};
			}
			const plan = await this.#readPlan(preparedJob, { repository, tree: resolved.treeSha });
			if (plan.kind === "invalid") return { status: "invalid", detail: plan.detail };
			if (plan.kind === "app") {
				if (plan.app.kind === "hybrid" && plan.app.recipe === null) {
					try {
						const treeData = await this.#readTree(preparedJob, { repository, tree: resolved.treeSha });
						const sharedAssets = await readSharedIdentityAssets(
							preparedJob,
							preparedJob.signal,
							productFolderRoots,
						);
						return {
							status: "app",
							headSha: resolved.headSha,
							treeSha: resolved.treeSha,
							app: plan.app,
							files: treeData.files,
							sharedAssets,
						};
					} catch (error) {
						if (
							error instanceof CodeSiteTreeInvalid &&
							(error.problem.code === "SITE_FOLDER_MISSING" || error.problem.code === "SITE_NO_INDEX")
						) {
							return {
								status: "app",
								headSha: resolved.headSha,
								treeSha: resolved.treeSha,
								app: plan.app,
								files: [],
							};
						}
						throw error;
					}
				}
				return { status: "app", headSha: resolved.headSha, treeSha: resolved.treeSha, app: plan.app };
			}
			if (plan.kind === "build")
				return { status: "build", headSha: resolved.headSha, treeSha: resolved.treeSha, recipe: plan.recipe };
			const treeData = await this.#readTree(preparedJob, { repository, tree: resolved.treeSha });
			const sharedAssets = await readSharedIdentityAssets(preparedJob, preparedJob.signal, productFolderRoots);
			return {
				status: "ready",
				headSha: resolved.headSha,
				treeSha: resolved.treeSha,
				files: treeData.files,
				sharedAssets,
			};
		};
		let prepared: PreparedPublish;
		try {
			let ran: { readonly yielded: false; readonly value: PreparedPublish } | { readonly yielded: true };
			try {
				ran = await this.#runYieldable<PreparedPublish>(
					pub.profileId,
					environmentId,
					signal,
					(codeHostJob) => readPublish(codeHostJob, false),
					{ readOnly: true },
				);
			} catch (error) {
				if (!isUnseededAreaRefusal(error) || signal.aborted) throw error;
				ran = await this.#runYieldable<PreparedPublish>(pub.profileId, environmentId, signal, (codeHostJob) =>
					readPublish(codeHostJob, true),
				);
			}
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
			return await failPublish(
				surfaceFailureDetail(error, null, "Surface publish read failed", { native: Boolean(this.#nativeEdge) }),
			);
		}
		if (prepared.status === "invalid") return await failPublish(prepared.detail);

		if (prepared.status === "app") {
			let staticSite: ReadSite | null = null;
			if (prepared.app.recipe !== null) {
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
							recipe: prepared.app.recipe,
							productFolderRoots,
							deferSettle: true,
						},
						signal,
					);
				} catch (error) {
					if (signal.aborted) throw error;
					return await failPublish(
						surfaceFailureDetail(error, prepared.app.recipe.folder, "Surface publish build failed", {
							native: Boolean(this.#nativeEdge),
						}),
					);
				}
				if (built === "parked") return true;
				if (built === "yielded") return false;
				staticSite = built;
			} else if (prepared.files && prepared.files.length > 0) {
				staticSite = {
					kind: "files",
					treeSha: prepared.treeSha,
					files: prepared.files,
					sharedAssets: prepared.sharedAssets ?? {},
				};
			}

			try {
				const deployed = await this.#deployAppSite(
					{
						surfaceId: pub.surfaceId,
						profileId: pub.profileId,
						environmentId,
						repository,
						commitSha: prepared.headSha,
						treeSha: prepared.treeSha,
						title: null,
						promoteLive: true,
						app: prepared.app,
						staticSite,
					},
					signal,
				);
				if (deployed.yielded) {
					this.#emit({
						event: "surface-code-host-yielded",
						kind: "publish",
						jobId: pub.jobId,
						surfaceId: pub.surfaceId,
					});
					return false;
				}
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
						prepared.app.recipe ? prepared.app.recipe.folder : null,
						"Surface publish app deploy failed",
						{ native: Boolean(this.#nativeEdge) },
					),
				);
			}
		}

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
					surfaceFailureDetail(error, prepared.recipe.folder, "Surface publish build failed", {
						native: Boolean(this.#nativeEdge),
					}),
				);
			}
			if (built === "parked") return true;
			if (built === "yielded") return false;
			site = built;
		} else {
			site = {
				kind: "files",
				treeSha: prepared.treeSha,
				files: prepared.files,
				sharedAssets: prepared.sharedAssets,
			};
		}

		try {
			await this.#uploadSite(
				{
					surfaceId: pub.surfaceId,
					mainSha: prepared.headSha,
					title: null,
					promoteLive: true,
					site,
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
					{ native: Boolean(this.#nativeEdge) },
				),
			);
		}
	}

	async #runCleanup(cleanup: ClaimedSurfaceCleanupJob, signal: AbortSignal): Promise<boolean> {
		const completeCleanup = async (status: "completed" | "failed", errorDetail: string | null): Promise<true> => {
			await retryCommittedCompletion(
				(attemptSignal) =>
					this.#control.call(
						"qorpera_surface_complete_cleanup",
						{
							p_job_id: cleanup.jobId,
							p_status: status,
							p_error_detail: errorDetail,
							p_lease_token: cleanup.leaseToken ?? null,
						},
						attemptSignal,
					),
				signal,
				this.#completionRetryDelaysMs,
				{ treatNotRunningAsDoneOnRetry: true },
			);
			return true;
		};

		if (!cleanup.environmentId) {
			return await completeCleanup("failed", "Code cleanup job is missing environmentId");
		}
		const repository = parseSurfaceRepositoryKey(cleanup.repositoryKey);
		if (!repository) {
			return await completeCleanup(
				"failed",
				cleanup.repositoryKey
					? `Invalid surface repositoryKey "${cleanup.repositoryKey}"`
					: "Code repository surface cleanup is missing repository metadata",
			);
		}
		if (!isUuid(cleanup.workerId)) {
			return await completeCleanup("failed", "Code cleanup job has invalid workerId");
		}

		const environmentId = cleanup.environmentId;
		try {
			// WHY: Remove worktree files in one published code-host job before deleting repo.git/worktrees and the branch ref in a second job.
			const filesRan = await this.#runYieldable(cleanup.profileId, environmentId, signal, async (codeHostJob) =>
				discardSurfaceSessionWorktree(codeHostJob, {
					repository,
					workerId: cleanup.workerId,
					phase: "files",
				}),
			);
			if (filesRan.yielded) {
				this.#emit({
					event: "surface-code-host-yielded",
					kind: "cleanup",
					jobId: cleanup.jobId,
					surfaceId: cleanup.surfaceId,
				});
				return false;
			}
			if (filesRan.value.status === "unseeded") {
				return await completeCleanup("completed", null);
			}

			const gitRan = await this.#runYieldable(cleanup.profileId, environmentId, signal, async (codeHostJob) =>
				discardSurfaceSessionWorktree(codeHostJob, {
					repository,
					workerId: cleanup.workerId,
					phase: "git-folder",
				}),
			);
			if (gitRan.yielded) {
				this.#emit({
					event: "surface-code-host-yielded",
					kind: "cleanup",
					jobId: cleanup.jobId,
					surfaceId: cleanup.surfaceId,
				});
				return false;
			}
			if (gitRan.value.status === "files_still_there") {
				this.#emit({
					event: "surface-code-host-cleanup-deferred",
					jobId: cleanup.jobId,
					surfaceId: cleanup.surfaceId,
					workerId: cleanup.workerId,
				});
				return false;
			}

			return await completeCleanup("completed", null);
		} catch (error) {
			if (signal.aborted) throw error;
			return await completeCleanup("failed", surfaceFailureDetail(error, null, "Surface worktree cleanup failed"));
		}
	}
}
