import { createHash } from "node:crypto";
import { type CloudCodingRepository, isUuid } from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import { type CodeHostJob, keptRepositoryOf, withJob } from "./code-host-jobs.ts";
import { type CodeSiteTreeFile, readCodeSiteTree } from "./code-host-sites.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { codeSiteManifest } from "./code-site.ts";
import { CODE_SITE_LIST_BYTES, CODE_SITE_LIST_FILES, type CodeSiteTreeRead } from "./code-site-uploads.ts";
import {
	type CompleteSurfaceMergeInput,
	type CompleteSurfacePreviewInput,
	type CompleteSurfacePublishInput,
	parseClaimedSurfaceJobs,
} from "./orchestrator.ts";
import {
	createSurfaceExecutionHandlers,
	type SurfaceCompanyFolderPort,
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
	readonly leaseRenewIntervalMs?: number;
	readonly leaseExtendSeconds?: number;
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
const MAX_SHARED_ASSET_READ_BYTES = 32 * 1024;
const GIT_SHA = /^[0-9a-f]{40}$/;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function effectiveSiteTreeSha(rawTreeSha: string, manifestSha256: string, hasSharedOverlay: boolean): string {
	if (!hasSharedOverlay) return rawTreeSha;
	return createHash("sha1").update(`${rawTreeSha}\n${manifestSha256}`, "utf8").digest("hex");
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
			if (!cleanPath || cleanPath.includes("..") || cleanPath.includes("\0")) continue;
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
	const manifestSha256 = codeSiteManifest(files);
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	return { files, manifestSha256, totalBytes, hasOverlay };
}

function createCodeHostSharedFolderReader(codeHostJob: CodeHostJob): Pick<SurfaceCompanyFolderPort, "readFiles"> {
	return {
		async readFiles(input, signal) {
			const out: Record<string, string | null> = {};
			for (const rawPath of input.paths) {
				const cleanPath = rawPath.trim().replace(/^\/+|\/+$/g, "");
				if (
					!cleanPath ||
					cleanPath.includes("\0") ||
					cleanPath.includes("\\") ||
					cleanPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
				) {
					out[rawPath] = null;
					continue;
				}
				const fullPath = `${codeHostJob.layout.companyRoot}/${cleanPath}`;
				try {
					const result = await codeHostJob.shell.run(
						{
							argv: [
								"/bin/sh",
								"-c",
								'if [ -f "$1" ]; then head -c "$2" -- "$1"; fi',
								"_",
								fullPath,
								String(MAX_SHARED_ASSET_READ_BYTES),
							],
							cwd: "/",
							env: { PATH: "/usr/bin:/bin" },
							maximumOutputBytes: MAX_SHARED_ASSET_READ_BYTES + 1024,
						},
						signal,
					);
					if (result.status === 0 && result.stdout.byteLength > 0) {
						out[rawPath] = result.stdout.toString("utf8");
					} else {
						out[rawPath] = null;
					}
				} catch (error) {
					if (signal.aborted) throw error;
					out[rawPath] = null;
				}
			}
			return out;
		},
	};
}

async function resolveMainHeadAndTree(
	codeHostJob: CodeHostJob,
	repository: CloudCodingRepository,
	explicitHeadSha: string | null,
): Promise<{ readonly headSha: string; readonly treeSha: string }> {
	const kept = keptRepositoryOf(repository);
	return await withJob(codeHostJob, kept, async (run) => {
		const targetRef = explicitHeadSha && GIT_SHA.test(explicitHeadSha) ? explicitHeadSha : "refs/heads/main";
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

async function uploadSurfaceSiteTree(
	control: SurfaceCodeHostControl,
	readTree: CodeSiteTreeRead,
	codeHostJob: CodeHostJob,
	input: {
		readonly surfaceId: string;
		readonly repository: CloudCodingRepository;
		readonly mainSha: string;
		readonly treeSha: string;
		readonly title: string | null;
		readonly promoteLive: boolean;
		readonly sharedAssets?: Readonly<Record<string, string>>;
	},
	signal: AbortSignal,
): Promise<{ readonly versionId: string; readonly siteId: string; readonly siteSlug: string }> {
	const treeData = await readTree(codeHostJob, { repository: input.repository, tree: input.treeSha });
	const merged = mergeTreeWithSharedAssets(treeData.files, input.sharedAssets);
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

		let partsBatch: { path: string; part: number; of: number; contentBase64: string }[] = [];
		let partsBytes = 0;
		const flushParts = async (): Promise<void> => {
			if (partsBatch.length === 0) return;
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
			partsBatch = [];
			partsBytes = 0;
		};

		for (const file of merged.files) {
			const totalParts = Math.max(1, Math.ceil(file.content.byteLength / PUT_RAW_PART_BYTES));
			for (let part = 0; part < totalParts; part += 1) {
				const slice = file.content.subarray(
					part * PUT_RAW_PART_BYTES,
					Math.min((part + 1) * PUT_RAW_PART_BYTES, file.content.byteLength),
				);
				const item = {
					path: file.path,
					part,
					of: totalParts,
					contentBase64: Buffer.from(slice).toString("base64"),
				};
				const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 2;
				if (
					partsBatch.length > 0 &&
					(partsBatch.length >= PUT_BATCH_MAX_PARTS || partsBytes + itemBytes > PUT_BATCH_MAX_JSON_BYTES)
				) {
					await flushParts();
				}
				partsBatch.push(item);
				partsBytes += itemBytes;
			}
		}
		await flushParts();

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

// WHY: Executes code_repo Surface previews, selective merges, rebases, undos, and live site publishes on coding-executor where LxdCodeHosts lives.
export class SurfaceCodeHostWorker {
	readonly #control: SurfaceCodeHostControl;
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #readTree: CodeSiteTreeRead;
	readonly #batchLimit: number;
	readonly #leaseRenewIntervalMs: number;
	readonly #leaseExtendSeconds: number;
	readonly #report: ((event: Record<string, unknown>) => void) | undefined;

	constructor(options: SurfaceCodeHostWorkerOptions) {
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#readTree = options.readTree ?? readCodeSiteTree;
		this.#batchLimit = Math.min(Math.max(1, options.batchLimit ?? 8), 64);
		this.#leaseRenewIntervalMs = Math.max(50, options.leaseRenewIntervalMs ?? 60_000);
		this.#leaseExtendSeconds = Math.min(Math.max(30, options.leaseExtendSeconds ?? 300), 900);
		this.#report = options.report;
	}

	#emit(event: Record<string, unknown>): void {
		try {
			this.#report?.(event);
		} catch {}
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
		let previewsDone = 0;
		let mergesDone = 0;
		let publishesDone = 0;
		let failed = 0;

		for (const merge of merges) {
			if (signal.aborted) break;
			try {
				await this.#withLease("job", merge.jobId, merge.leaseToken ?? null, signal, () =>
					this.#runMerge(merge, signal),
				);
				mergesDone += 1;
			} catch (error) {
				failed += 1;
				this.#emit({
					event: "surface-code-host-error",
					kind: "merge",
					jobId: merge.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		for (const pub of publishes) {
			if (signal.aborted) break;
			try {
				await this.#withLease("job", pub.jobId, pub.leaseToken ?? null, signal, () =>
					this.#runPublish(pub, signal),
				);
				publishesDone += 1;
			} catch (error) {
				failed += 1;
				this.#emit({
					event: "surface-code-host-error",
					kind: "publish",
					jobId: pub.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		for (const preview of claimed.previews) {
			if (signal.aborted) break;
			try {
				await this.#withLease("preview", preview.previewId, preview.leaseToken ?? null, signal, () =>
					this.#runPreview(preview, signal),
				);
				previewsDone += 1;
			} catch (error) {
				failed += 1;
				this.#emit({
					event: "surface-code-host-error",
					kind: "preview",
					previewId: preview.previewId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return { previews: previewsDone, merges: mergesDone, publishes: publishesDone, failed };
	}

	async #withLease<T>(
		kind: "preview" | "job",
		id: string,
		leaseToken: string | null,
		signal: AbortSignal,
		work: () => Promise<T>,
	): Promise<T> {
		if (!leaseToken) return await work();
		let renewing = false;
		const timer = setInterval(() => {
			if (signal.aborted || renewing) return;
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

	#handlersForJob(
		codeHostJob: CodeHostJob,
		overrides?: {
			readonly controlPlane?: SurfaceExecutionControlPlane;
			readonly deferRebase?: (update: () => Promise<void>) => void;
		},
	) {
		const controlPlane = overrides?.controlPlane ?? createControlPlaneBridge(this.#control);
		const sharedFolderReader = createCodeHostSharedFolderReader(codeHostJob);
		return createSurfaceExecutionHandlers({
			controlPlane,
			resolveCodeHostJob: () => codeHostJob,
			folder: sharedFolderReader,
			buildAndUploadPreview: async (input, callSignal) => {
				const uploaded = await uploadSurfaceSiteTree(
					this.#control,
					this.#readTree,
					codeHostJob,
					{
						surfaceId: input.surfaceId,
						repository: input.repository,
						mainSha: input.compositeCommitSha,
						treeSha: input.compositeTreeSha,
						title: `Preview ${input.shortHostId}`,
						promoteLive: false,
						...(input.sharedAssets ? { sharedAssets: input.sharedAssets } : {}),
					},
					callSignal,
				);
				return { siteVersionId: uploaded.versionId };
			},
			onSessionChangesRebased: async (input, callSignal) => {
				const applyRebases = async (): Promise<void> => {
					if (input.sessionId && input.siblingRebase) {
						await this.#persistRebaseOutcome(input.surfaceId, input.sessionId, input.siblingRebase, callSignal);
					}
					for (const peer of input.peerSync) {
						await this.#persistRebaseOutcome(input.surfaceId, peer.sessionId, peer.result, callSignal);
					}
				};
				if (overrides?.deferRebase) {
					overrides.deferRebase(applyRebases);
				} else {
					await applyRebases();
				}
			},
			undoCodeRepoChange: async (input) =>
				await undoSurfaceCodeRepoChange(codeHostJob, {
					jobId: input.jobId,
					changeId: input.changeId,
					repository: input.repository,
					landedMainBefore: input.landedMainBefore,
					landedMainAfter: input.landedMainAfter,
				}),
			publishSurface: async (input, callSignal) => {
				if (!input.repository) {
					throw new Error("Code repository surface publish is missing repository metadata");
				}
				const resolved = await resolveMainHeadAndTree(codeHostJob, input.repository, input.liveHeadSha);
				await uploadSurfaceSiteTree(
					this.#control,
					this.#readTree,
					codeHostJob,
					{
						surfaceId: input.surfaceId,
						repository: input.repository,
						mainSha: resolved.headSha,
						treeSha: resolved.treeSha,
						title: null,
						promoteLive: true,
						...(input.sharedAssets ? { sharedAssets: input.sharedAssets } : {}),
					},
					callSignal,
				);
				return { publishedHeadSha: resolved.headSha };
			},
		});
	}

	async #persistRebaseOutcome(
		surfaceId: string,
		sessionId: string,
		result:
			| {
					readonly status: "clean";
					readonly branchHeadSha: string;
					readonly rebasedChanges: readonly {
						readonly changeId: string;
						readonly parentSha: string;
						readonly headSha: string;
					}[];
			  }
			| {
					readonly status: "conflicted";
					readonly conflictedChangeId: string;
					readonly conflictPaths: readonly string[];
					readonly rebasedBeforeConflict: readonly {
						readonly changeId: string;
						readonly parentSha: string;
						readonly headSha: string;
					}[];
			  },
		signal: AbortSignal,
	): Promise<void> {
		if (result.status === "clean") {
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
		await this.#control.call(
			"qorpera_surface_update_rebased_changes",
			{
				p_surface_id: surfaceId,
				p_session_id: sessionId,
				p_branch_head_sha: null,
				p_rebased_changes: result.rebasedBeforeConflict.map((item) => ({
					changeId: item.changeId,
					parentSha: item.parentSha,
					headSha: item.headSha,
				})),
				p_conflicted_change_id: result.conflictedChangeId,
				p_conflict_paths: [...result.conflictPaths],
			},
			signal,
		);
	}

	async #runPreview(preview: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<void> {
		if (!preview.environmentId) {
			await createControlPlaneBridge(this.#control).completeSurfacePreview(
				{
					previewId: preview.previewId,
					status: "failed",
					errorDetail: "Preview job is missing environmentId",
					...(preview.leaseToken !== undefined ? { leaseToken: preview.leaseToken } : {}),
				},
				signal,
			);
			return;
		}
		await this.#hosts.run(
			preview.profileId,
			preview.environmentId,
			signal,
			async (codeHostJob) => {
				await this.#handlersForJob(codeHostJob).runPreviewJob(preview, signal);
			},
			{ yields: true },
		);
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
		const deferredRebases: (() => Promise<void>)[] = [];
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
				await this.#handlersForJob(codeHostJob, {
					controlPlane: bufferedControlPlane,
					deferRebase: (update) => deferredRebases.push(update),
				}).runMergeJob(merge, signal);
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
		for (const applyRebase of deferredRebases) {
			await applyRebase();
		}
		if (deferredMergeCompletion) {
			await controlPlane.completeSurfaceMerge(deferredMergeCompletion, signal);
		}
	}

	async #runPublish(pub: ClaimedSurfacePublishJob, signal: AbortSignal): Promise<void> {
		if (!pub.environmentId) {
			await createControlPlaneBridge(this.#control).completeSurfacePublish(
				{
					jobId: pub.jobId,
					status: "failed",
					errorDetail: "Code publish job is missing environmentId",
					...(pub.leaseToken !== undefined ? { leaseToken: pub.leaseToken } : {}),
				},
				signal,
			);
			return;
		}
		await this.#hosts.run(
			pub.profileId,
			pub.environmentId,
			signal,
			async (codeHostJob) => {
				await this.#handlersForJob(codeHostJob).runPublishJob(pub, signal);
			},
			{ yields: true },
		);
	}
}
