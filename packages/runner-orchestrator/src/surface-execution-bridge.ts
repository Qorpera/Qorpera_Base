import { createHash } from "node:crypto";
import {
	type CloudCodingRepository,
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	isUuid,
	parseCloudCodingRepository,
	parseStudioPatchOps,
	SHARED_COMPANY_ASSET_PATHS,
	type StudioPatchOp,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
	type SurfaceSessionState,
} from "@qorpera/contracts";
import { type CodeHostJob, CodeHostRefusal, undoCodeChange } from "./code-host-jobs.ts";
import {
	type CodeHostChangeRange,
	type EnsureSurfaceStarterRepositoryResult,
	ensureSurfaceStarterRepository,
	type RebaseSessionChangesResult,
} from "./code-host-surfaces.ts";
import type {
	CompleteSurfaceMergeInput,
	CompleteSurfacePreviewInput,
	CompleteSurfacePublishInput,
} from "./orchestrator.ts";
import { approveAndSyncSurfaceChanges } from "./surface-change-dispatcher.ts";
import { buildCompositeSurfacePreview } from "./surface-preview-runner.ts";
import type {
	ClaimedSurfaceMergeJob,
	ClaimedSurfacePreviewJob,
	ClaimedSurfacePublishJob,
	SurfaceWorkerLoopPorts,
} from "./surface-worker-loop.ts";

const ZERO_SHA = "0".repeat(40);
const DISALLOWED_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface SurfaceExecutionControlPlane {
	completeSurfacePreview(input: CompleteSurfacePreviewInput, signal?: AbortSignal): Promise<unknown>;
	completeSurfaceMerge(input: CompleteSurfaceMergeInput, signal?: AbortSignal): Promise<unknown>;
	completeSurfacePublish(input: CompleteSurfacePublishInput, signal?: AbortSignal): Promise<unknown>;
}

export interface SurfaceCompanyFolderVersionedFile {
	readonly content: string | null;
	readonly version: string | null;
}

export interface SurfaceCompanyFolderCommitOperation {
	readonly path: string;
	readonly expectedVersion: string | null;
	readonly content: string | null;
}

export type SurfaceCompanyFolderCommitResult =
	| { readonly status: "saved" }
	| { readonly status: "conflict"; readonly conflictPaths: readonly string[] };

export interface SurfaceCompanyFolderPort {
	readFiles(
		input: { readonly profileId: string; readonly folderRoot: string; readonly paths: readonly string[] },
		signal: AbortSignal,
	): Promise<Readonly<Record<string, string | null>>>;
	readFilesWithVersions?(
		input: { readonly profileId: string; readonly folderRoot: string; readonly paths: readonly string[] },
		signal: AbortSignal,
	): Promise<Readonly<Record<string, SurfaceCompanyFolderVersionedFile>>>;
	commitFiles?(
		input: {
			readonly profileId: string;
			readonly folderRoot: string;
			readonly operations: readonly SurfaceCompanyFolderCommitOperation[];
		},
		signal: AbortSignal,
	): Promise<SurfaceCompanyFolderCommitResult>;
	writeFile?(
		input: { readonly profileId: string; readonly path: string; readonly content: string },
		signal: AbortSignal,
	): Promise<void>;
	deleteFile?(input: { readonly profileId: string; readonly path: string }, signal: AbortSignal): Promise<void>;
}

export interface SurfaceFolderUndoSnapshot {
	readonly snapshotId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly folderRoot: string;
	readonly changeIds: readonly string[];
	readonly filesBefore: Readonly<Record<string, string | null>>;
}

export interface SurfaceFolderSnapshotPort {
	saveSnapshot(snapshot: SurfaceFolderUndoSnapshot, signal: AbortSignal): Promise<void>;
	loadSnapshot(
		input: {
			readonly profileId: string;
			readonly surfaceId: string;
			readonly changeId: string;
			readonly snapshotId?: string | null;
		},
		signal: AbortSignal,
	): Promise<SurfaceFolderUndoSnapshot | null>;
}

export type SurfaceCodeRepoUndoOutcome =
	| { readonly status: "landed"; readonly mainBefore: string; readonly mainAfter: string }
	| { readonly status: "conflicted"; readonly conflictPaths: readonly string[]; readonly errorDetail?: string }
	| { readonly status: "failed"; readonly errorDetail: string };

export interface SurfaceExecutionBridgePorts {
	readonly controlPlane: SurfaceExecutionControlPlane;
	readonly resolveRepository?: (
		input: { readonly profileId: string; readonly surfaceId: string; readonly repositoryKey: string },
		signal: AbortSignal,
	) => Promise<CloudCodingRepository> | CloudCodingRepository;
	readonly resolveCodeHostJob?: (
		input: { readonly profileId: string; readonly surfaceId: string; readonly repository: CloudCodingRepository },
		signal: AbortSignal,
	) => Promise<CodeHostJob> | CodeHostJob;
	readonly buildAndUploadPreview?: (
		input: {
			readonly previewId: string;
			readonly surfaceId: string;
			readonly profileId: string;
			readonly shortHostId: string;
			readonly repository: CloudCodingRepository;
			readonly compositeCommitSha: string;
			readonly compositeTreeSha: string;
			readonly previewRef: string | null;
			readonly sharedAssets?: Readonly<Record<string, string>>;
		},
		signal: AbortSignal,
	) => Promise<{ readonly siteVersionId: string }>;
	readonly onSessionChangesRebased?: (
		input: {
			readonly jobId: string;
			readonly surfaceId: string;
			readonly sessionId: string | null;
			readonly mainBefore: string;
			readonly mainAfter: string;
			readonly nextSessionState: SurfaceSessionState;
			readonly siblingRebase: RebaseSessionChangesResult | null;
			readonly peerSync: readonly { readonly sessionId: string; readonly result: RebaseSessionChangesResult }[];
		},
		signal: AbortSignal,
	) => Promise<void> | void;
	readonly undoCodeRepoChange?: (
		input: {
			readonly jobId: string;
			readonly surfaceId: string;
			readonly profileId: string;
			readonly changeId: string;
			readonly repository: CloudCodingRepository;
			readonly landedMainBefore: string;
			readonly landedMainAfter: string;
		},
		signal: AbortSignal,
	) => Promise<SurfaceCodeRepoUndoOutcome>;
	readonly folder?: SurfaceCompanyFolderPort;
	readonly folderSnapshots?: SurfaceFolderSnapshotPort;
	readonly runOpsActionJob?: (
		job: ClaimedSurfaceMergeJob,
		signal: AbortSignal,
	) => Promise<
		| { readonly status: "landed"; readonly mainBefore?: string | null; readonly mainAfter?: string | null }
		| { readonly status: "failed"; readonly errorDetail: string }
	>;
	readonly publishSurface?: (
		input: {
			readonly jobId: string;
			readonly surfaceId: string;
			readonly profileId: string;
			readonly repository: CloudCodingRepository | null;
			readonly repositoryKey: string | null;
			readonly siteId: string | null;
			readonly liveHeadSha: string | null;
			readonly payload: Readonly<Record<string, unknown>>;
			readonly sharedAssets?: Readonly<Record<string, string>>;
		},
		signal: AbortSignal,
	) => Promise<{ readonly publishedHeadSha: string | null }>;
}

export type SurfaceExecutionHandlers = Required<
	Pick<SurfaceWorkerLoopPorts, "runPreviewJob" | "runMergeJob" | "runPublishJob">
>;

export type ApplyStudioFolderPatchesResult =
	| {
			readonly status: "ready";
			readonly files: Readonly<Record<string, string | null>>;
			readonly modifiedPaths: readonly string[];
			readonly mainBefore: string;
			readonly mainAfter: string;
	  }
	| {
			readonly status: "conflicted";
			readonly conflictChangeId: string;
			readonly conflictPaths: readonly string[];
			readonly files: Readonly<Record<string, string | null>>;
	  };

function formatErrorDetail(error: unknown, fallback: string): string {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
	const cleaned = raw.replace(/\0/g, "").trim().slice(0, 1000).trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

function formatConflictDetail(paths: readonly string[]): string {
	if (paths.length === 0) return "Change conflicted with concurrent edits";
	const preview = paths.slice(0, 5).join(", ");
	const suffix = paths.length > 5 ? ` (+${paths.length - 5} more)` : "";
	return `Conflicted paths: ${preview}${suffix}`.slice(0, 1000);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashFolderFiles(files: Readonly<Record<string, string | null>>): string {
	const sortedEntries = Object.keys(files)
		.sort()
		.map((path) => [path, files[path] ?? null] as const);
	return createHash("sha256").update(JSON.stringify(sortedEntries)).digest("hex");
}

function hasControlOrWindowsChars(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return value.includes("\\") || value.includes(":");
}

export function parseSurfaceRepositoryKey(
	repositoryKey: string | null | undefined,
	baseBranch = "main",
): CloudCodingRepository | null {
	if (typeof repositoryKey !== "string") return null;
	const trimmed = repositoryKey.trim();
	if (!trimmed || trimmed !== repositoryKey) return null;
	const parts = trimmed.split("/");
	if (parts.length !== 2) return null;
	const [owner, name] = parts;
	if (!owner || !name) return null;
	try {
		return parseCloudCodingRepository({ host: "qorpera", owner, name, baseBranch });
	} catch {
		return null;
	}
}

export function normalizeSurfaceFolderRoot(folderRoot: string | null | undefined): string | null {
	if (typeof folderRoot !== "string") return null;
	const trimmed = folderRoot.trim().replace(/\/+$/, "");
	if (!trimmed || trimmed.startsWith("/") || hasControlOrWindowsChars(trimmed)) return null;
	const segments = trimmed.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		return null;
	}
	return segments.join("/");
}

export function assertSurfaceFolderPatchPath(path: string, folderRoot: string): string {
	const normalizedRoot = normalizeSurfaceFolderRoot(folderRoot);
	if (!normalizedRoot) {
		throw new Error("Surface folderRoot is invalid");
	}
	if (typeof path !== "string" || path !== path.trim() || path.length === 0) {
		throw new Error("Folder patch path is empty");
	}
	if (path.startsWith("/") || path.endsWith("/") || hasControlOrWindowsChars(path)) {
		throw new Error(`Folder patch path escapes surface root: ${path}`);
	}
	const segments = path.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error(`Folder patch path contains invalid traversal: ${path}`);
	}
	const normalizedPath = segments.join("/");
	if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
		throw new Error(`Folder patch path "${normalizedPath}" is outside surface folderRoot "${normalizedRoot}"`);
	}
	return normalizedPath;
}

function keyOverlapsAnotherChange(
	touchedKeys: ReadonlyMap<string, string>,
	keyPath: string,
	changeId: string,
): boolean {
	for (const [existingKey, owner] of touchedKeys) {
		if (owner === changeId) continue;
		if (existingKey === keyPath || existingKey.startsWith(`${keyPath}.`) || keyPath.startsWith(`${existingKey}.`)) {
			return true;
		}
	}
	return false;
}

function mergeJsonPatch(
	base: Record<string, unknown>,
	patch: Readonly<Record<string, unknown>>,
	touchedKeys: Map<string, string>,
	changeId: string,
	prefix: string,
): { readonly merged: Record<string, unknown>; readonly conflicts: string[] } {
	const merged: Record<string, unknown> = { ...base };
	const conflicts: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		if (DISALLOWED_JSON_KEYS.has(key)) {
			throw new Error(`Disallowed JSON patch key: ${key}`);
		}
		const keyPath = prefix ? `${prefix}.${key}` : key;
		if (isPlainObject(value) && isPlainObject(merged[key])) {
			const nested = mergeJsonPatch(merged[key] as Record<string, unknown>, value, touchedKeys, changeId, keyPath);
			merged[key] = nested.merged;
			conflicts.push(...nested.conflicts);
		} else {
			if (keyOverlapsAnotherChange(touchedKeys, keyPath, changeId)) {
				conflicts.push(keyPath);
			} else {
				touchedKeys.set(keyPath, changeId);
			}
			merged[key] = structuredClone(value);
		}
	}
	return { merged, conflicts };
}

export function applyStudioFolderPatches(
	baseFiles: Readonly<Record<string, string | null>>,
	changes: readonly { readonly changeId: string; readonly ops: readonly StudioPatchOp[] }[],
	folderRoot: string,
): ApplyStudioFolderPatchesResult {
	const normalizedRoot = normalizeSurfaceFolderRoot(folderRoot);
	if (!normalizedRoot) {
		throw new Error("Surface folderRoot is required for folder_patch landing");
	}
	const working: Record<string, string | null> = { ...baseFiles };
	const touchedWholeFiles = new Map<string, string>();
	const touchedJsonKeys = new Map<string, Map<string, string>>();
	const modifiedPaths = new Set<string>();

	for (const change of changes) {
		const snapshot: Record<string, string | null> = { ...working };
		const nextWholeFiles = new Map(touchedWholeFiles);
		const nextJsonKeys = new Map<string, Map<string, string>>();
		for (const [filePath, keys] of touchedJsonKeys) {
			nextJsonKeys.set(filePath, new Map(keys));
		}
		const conflictPaths: string[] = [];
		const changeModifiedPaths = new Set<string>();

		for (const op of change.ops) {
			const safePath = assertSurfaceFolderPatchPath(op.path, normalizedRoot);
			if (op.op === "write_text" || op.op === "delete") {
				const priorOwner = nextWholeFiles.get(safePath);
				if (priorOwner && priorOwner !== change.changeId) {
					conflictPaths.push(safePath);
					continue;
				}
				const jsonOwners = nextJsonKeys.get(safePath);
				if (jsonOwners && [...jsonOwners.values()].some((owner) => owner !== change.changeId)) {
					conflictPaths.push(safePath);
					continue;
				}
				nextWholeFiles.set(safePath, change.changeId);
				working[safePath] = op.op === "delete" ? null : op.content;
				changeModifiedPaths.add(safePath);
				continue;
			}

			const wholeOwner = nextWholeFiles.get(safePath);
			if (wholeOwner && wholeOwner !== change.changeId) {
				conflictPaths.push(safePath);
				continue;
			}
			let currentObj: Record<string, unknown> = {};
			const existing = working[safePath];
			if (typeof existing === "string") {
				try {
					const parsed: unknown = JSON.parse(existing);
					if (!isPlainObject(parsed)) {
						conflictPaths.push(safePath);
						continue;
					}
					currentObj = parsed;
				} catch {
					conflictPaths.push(safePath);
					continue;
				}
			}
			const keysForFile = nextJsonKeys.get(safePath) ?? new Map<string, string>();
			const { merged, conflicts } = mergeJsonPatch(currentObj, op.patch, keysForFile, change.changeId, "");
			if (conflicts.length > 0) {
				conflictPaths.push(safePath);
				continue;
			}
			nextJsonKeys.set(safePath, keysForFile);
			working[safePath] = `${JSON.stringify(merged, null, 2)}\n`;
			changeModifiedPaths.add(safePath);
		}

		if (conflictPaths.length > 0) {
			return {
				status: "conflicted",
				conflictChangeId: change.changeId,
				conflictPaths: [...new Set(conflictPaths)],
				files: snapshot,
			};
		}

		touchedWholeFiles.clear();
		for (const [k, v] of nextWholeFiles) touchedWholeFiles.set(k, v);
		touchedJsonKeys.clear();
		for (const [k, v] of nextJsonKeys) touchedJsonKeys.set(k, v);
		for (const p of changeModifiedPaths) modifiedPaths.add(p);
	}

	return {
		status: "ready",
		files: working,
		modifiedPaths: [...modifiedPaths],
		mainBefore: hashFolderFiles(baseFiles),
		mainAfter: hashFolderFiles(working),
	};
}

export class InMemorySurfaceFolderSnapshotStore implements SurfaceFolderSnapshotPort {
	readonly #byKey = new Map<string, SurfaceFolderUndoSnapshot>();

	async saveSnapshot(snapshot: SurfaceFolderUndoSnapshot): Promise<void> {
		const copy = structuredClone(snapshot);
		this.#byKey.set(`${snapshot.profileId}:${snapshot.surfaceId}:sha:${snapshot.snapshotId}`, copy);
		for (const changeId of snapshot.changeIds) {
			this.#byKey.set(`${snapshot.profileId}:${snapshot.surfaceId}:change:${changeId}`, copy);
		}
	}

	async loadSnapshot(input: {
		readonly profileId: string;
		readonly surfaceId: string;
		readonly changeId: string;
		readonly snapshotId?: string | null;
	}): Promise<SurfaceFolderUndoSnapshot | null> {
		if (input.snapshotId) {
			const bySha = this.#byKey.get(`${input.profileId}:${input.surfaceId}:sha:${input.snapshotId}`);
			if (bySha) return structuredClone(bySha);
		}
		const byChange = this.#byKey.get(`${input.profileId}:${input.surfaceId}:change:${input.changeId}`);
		return byChange ? structuredClone(byChange) : null;
	}
}

export async function undoSurfaceCodeRepoChange(
	codeHostJob: CodeHostJob,
	input: {
		readonly jobId: string;
		readonly changeId: string;
		readonly repository: CloudCodingRepository;
		readonly landedMainBefore: string;
		readonly landedMainAfter: string;
		readonly andLater?: boolean;
	},
): Promise<SurfaceCodeRepoUndoOutcome> {
	try {
		const undone = await undoCodeChange(codeHostJob, {
			repository: input.repository,
			requestId: input.jobId,
			change: {
				n: 1,
				mainBefore: input.landedMainBefore,
				mainAfter: input.landedMainAfter,
			},
			andLater: input.andLater ?? false,
			message: `Undo surface change ${input.changeId}`,
		});
		if (undone.state === "nothing") {
			return { status: "landed", mainBefore: undone.mainSha, mainAfter: undone.mainSha };
		}
		return { status: "landed", mainBefore: undone.mainBefore, mainAfter: undone.mainAfter };
	} catch (error) {
		if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_UNDO_CONFLICT") {
			return {
				status: "conflicted",
				conflictPaths: error.paths,
				errorDetail: formatConflictDetail(error.paths),
			};
		}
		return {
			status: "failed",
			errorDetail: formatErrorDetail(error, "Code-repository undo failed"),
		};
	}
}

export async function collectSharedCompanyAssets(
	folder: Pick<SurfaceCompanyFolderPort, "readFiles">,
	profileId: string,
	signal: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
	let raw: Readonly<Record<string, string | null>>;
	try {
		raw = await folder.readFiles({ profileId, folderRoot: "", paths: [...SHARED_COMPANY_ASSET_PATHS] }, signal);
	} catch {
		return {};
	}
	const mounted: Record<string, string> = {};
	for (const assetPath of SHARED_COMPANY_ASSET_PATHS) {
		const content = raw[assetPath];
		if (typeof content !== "string") continue;
		mounted[`${SURFACE_SHARED_DIR}/${assetPath}`] = content;
	}
	const existingCss = raw[IDENTITY_TOKENS_CSS_PATH];
	const tokensJson = raw[IDENTITY_TOKENS_JSON_PATH];
	let resolvedTokensCss: string | null = typeof existingCss === "string" ? existingCss : null;
	if (resolvedTokensCss === null && typeof tokensJson === "string") {
		resolvedTokensCss = compileIdentityTokensCss(tokensJson);
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = resolvedTokensCss;
	}
	if (resolvedTokensCss !== null) {
		mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = resolvedTokensCss;
	}
	return mounted;
}

export async function prepareSurfaceRepository(
	codeHostJob: CodeHostJob,
	input: {
		readonly repository: CloudCodingRepository;
		readonly title?: string;
		readonly slug?: string;
	},
): Promise<EnsureSurfaceStarterRepositoryResult | null> {
	if (input.repository.host !== "qorpera") return null;
	return await ensureSurfaceStarterRepository(codeHostJob, input);
}

function inferSourceKind(job: ClaimedSurfaceMergeJob): "code_repo" | "folder" | "native_ops" {
	if (job.sourceKind) return job.sourceKind;
	if (job.repositoryKey) return "code_repo";
	if (job.folderRoot) return "folder";
	return "native_ops";
}

function parseDurableFolderSnapshot(
	raw: Readonly<Record<string, unknown>> | null | undefined,
	fallback: { readonly surfaceId: string; readonly profileId: string; readonly folderRoot: string | null },
): SurfaceFolderUndoSnapshot | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	if (typeof raw.snapshotId !== "string" || raw.snapshotId.length === 0) return null;
	const folderRoot =
		typeof raw.folderRoot === "string" && raw.folderRoot.length > 0 ? raw.folderRoot : fallback.folderRoot;
	if (!folderRoot) return null;
	const filesRaw = raw.filesBefore;
	if (!filesRaw || typeof filesRaw !== "object" || Array.isArray(filesRaw)) return null;
	const filesBefore: Record<string, string | null> = {};
	for (const [path, value] of Object.entries(filesRaw as Record<string, unknown>)) {
		if (value !== null && typeof value !== "string") return null;
		filesBefore[path] = value;
	}
	const changeIds = Array.isArray(raw.changeIds)
		? raw.changeIds.filter((item): item is string => typeof item === "string")
		: [];
	return {
		snapshotId: raw.snapshotId,
		surfaceId: typeof raw.surfaceId === "string" ? raw.surfaceId : fallback.surfaceId,
		profileId: typeof raw.profileId === "string" ? raw.profileId : fallback.profileId,
		folderRoot,
		changeIds,
		filesBefore,
	};
}

export function createSurfaceExecutionHandlers(ports: SurfaceExecutionBridgePorts): SurfaceExecutionHandlers {
	async function resolveRepo(
		profileId: string,
		surfaceId: string,
		repositoryKey: string | null,
		signal: AbortSignal,
	): Promise<CloudCodingRepository> {
		if (!repositoryKey) {
			throw new Error("Surface job is missing repositoryKey");
		}
		if (ports.resolveRepository) {
			return await ports.resolveRepository({ profileId, surfaceId, repositoryKey }, signal);
		}
		const parsed = parseSurfaceRepositoryKey(repositoryKey);
		if (!parsed) {
			throw new Error(`Invalid surface repositoryKey "${repositoryKey}"`);
		}
		return parsed;
	}

	async function runPreviewJob(job: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<void> {
		const leaseField = job.leaseToken !== undefined ? { leaseToken: job.leaseToken } : {};
		let repository: CloudCodingRepository;
		let codeHostJob: CodeHostJob;
		try {
			repository = await resolveRepo(job.profileId, job.surfaceId, job.repositoryKey, signal);
			if (!ports.resolveCodeHostJob) {
				throw new Error("Code-host job resolver is not configured");
			}
			if (!ports.buildAndUploadPreview) {
				throw new Error("Surface preview builder is not configured");
			}
			codeHostJob = await ports.resolveCodeHostJob(
				{ profileId: job.profileId, surfaceId: job.surfaceId, repository },
				signal,
			);
			await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
		} catch (error) {
			await ports.controlPlane.completeSurfacePreview(
				{
					previewId: job.previewId,
					status: "failed",
					errorDetail: formatErrorDetail(error, "Surface preview setup failed"),
					...leaseField,
				},
				signal,
			);
			return;
		}

		const buildAndUploadPreview = ports.buildAndUploadPreview;
		const sharedAssets = ports.folder
			? await collectSharedCompanyAssets(ports.folder, job.profileId, signal)
			: undefined;
		// WHY: qorpera_surface_upsert_preview uses all-zero SHA when live_head_sha is unset; omit so git resolves main.
		const baseSha = job.baseSha && job.baseSha !== ZERO_SHA ? job.baseSha : undefined;
		await buildCompositeSurfacePreview(
			codeHostJob,
			{
				previewId: job.previewId,
				surfaceId: job.surfaceId,
				shortHostId: job.shortHostId,
				repository,
				...(baseSha ? { baseSha } : {}),
				...(job.exploration ? { exploration: job.exploration } : {}),
				changes: (job.changes ?? []).map((change) => ({
					changeId: change.changeId,
					parentSha: change.parentSha,
					headSha: change.headSha,
				})),
			},
			{
				buildAndUploadPreview: (input) =>
					buildAndUploadPreview(
						{
							...input,
							profileId: job.profileId,
							repository,
							...(sharedAssets !== undefined ? { sharedAssets } : {}),
						},
						signal,
					),
				completePreview: async (previewId, completion) => {
					await ports.controlPlane.completeSurfacePreview(
						{
							previewId,
							status: completion.status,
							compositeTreeSha: completion.compositeTreeSha ?? null,
							siteVersionId: completion.siteVersionId ?? null,
							conflictReport: completion.conflictReport ?? null,
							errorDetail: completion.errorDetail ?? null,
							...leaseField,
						},
						signal,
					);
				},
			},
		);
	}

	async function runCodeRepoLand(
		job: ClaimedSurfaceMergeJob,
		signal: AbortSignal,
		completeMerge: (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => Promise<unknown>,
	): Promise<void> {
		const repository = await resolveRepo(job.profileId, job.surfaceId, job.repositoryKey, signal);
		if (!ports.resolveCodeHostJob) {
			throw new Error("Code-host job resolver is not configured");
		}
		const approvedRaw = job.approvedChanges ?? [];
		if (approvedRaw.length === 0) {
			throw new Error("No approved git changes were provided to land");
		}
		const approvedChanges: CodeHostChangeRange[] = approvedRaw.map((change) => {
			if (!change.parentSha || !change.headSha) {
				throw new Error(`Approved change ${change.changeId} is missing git commit range`);
			}
			return {
				changeId: change.changeId,
				parentSha: change.parentSha,
				headSha: change.headSha,
				title: change.title,
				summary: change.summary,
			};
		});
		const siblingRemainingChanges = job.siblingRemainingChanges ?? [];
		if (siblingRemainingChanges.length > 0 && !job.sessionWorkerId) {
			throw new Error("Session workerId is required to rebase remaining sibling changes");
		}
		const codeHostJob = await ports.resolveCodeHostJob(
			{ profileId: job.profileId, surfaceId: job.surfaceId, repository },
			signal,
		);
		await prepareSurfaceRepository(codeHostJob, { repository, slug: repository.name });
		const outcome = await approveAndSyncSurfaceChanges(codeHostJob, {
			surfaceId: job.surfaceId,
			sessionId: job.sessionId ?? job.jobId,
			workerId: job.sessionWorkerId ?? job.sessionId ?? job.jobId,
			repository,
			...(job.expectMainSha ? { expectMainSha: job.expectMainSha } : {}),
			autoPublish: job.autoPublish ?? Boolean(job.payload.autoPublish),
			sessionState: job.sessionState ?? "ready",
			sessionHasActiveChat: job.sessionHasActiveChat ?? false,
			allSessionChangeStatuses:
				job.allSessionChangeStatuses ??
				approvedChanges.map((change) => ({ changeId: change.changeId, status: "merging" as const })),
			approvedChanges,
			siblingRemainingChanges,
			peerSessions: job.peerSessions ?? [],
		});

		if (outcome.status === "conflicted") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					mainBefore: job.expectMainSha ?? null,
					conflictChangeId: outcome.changeId,
					conflictPaths: outcome.conflictPaths,
					errorDetail: formatConflictDetail(outcome.conflictPaths),
				},
				signal,
			);
			return;
		}

		await completeMerge(
			{
				jobId: job.jobId,
				status: "landed",
				mainBefore: outcome.mainBefore,
				mainAfter: outcome.mainAfter,
			},
			signal,
		);
		await ports.onSessionChangesRebased?.(
			{
				jobId: job.jobId,
				surfaceId: job.surfaceId,
				sessionId: job.sessionId,
				mainBefore: outcome.mainBefore,
				mainAfter: outcome.mainAfter,
				nextSessionState: outcome.nextSessionState,
				siblingRebase: outcome.siblingRebase,
				peerSync: outcome.peerSync,
			},
			signal,
		);
	}

	async function runFolderLand(
		job: ClaimedSurfaceMergeJob,
		signal: AbortSignal,
		completeMerge: (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => Promise<unknown>,
	): Promise<void> {
		if (!ports.folder) {
			throw new Error("Company folder port is not configured");
		}
		if (!ports.folder.readFilesWithVersions || !ports.folder.commitFiles) {
			throw new Error("Company folder port must support atomic compare-and-swap commitFiles");
		}
		const normalizedRoot = normalizeSurfaceFolderRoot(job.folderRoot);
		if (!normalizedRoot) {
			throw new Error("Folder surface merge job is missing a valid folderRoot");
		}
		const approvedRaw = job.approvedChanges ?? [];
		if (approvedRaw.length === 0) {
			throw new Error("No approved folder patches were provided to land");
		}

		const parsedChanges: { readonly changeId: string; readonly ops: readonly StudioPatchOp[] }[] = [];
		const targetPaths = new Set<string>();
		for (const change of approvedRaw) {
			if (change.patchManifest === null || change.patchManifest === undefined) {
				throw new Error(`Approved folder change ${change.changeId} has no patchManifest`);
			}
			const ops = parseStudioPatchOps(change.patchManifest, `change[${change.changeId}].patchManifest`);
			if (ops.length === 0) {
				throw new Error(`Approved folder change ${change.changeId} has an empty patchManifest`);
			}
			for (const op of ops) {
				targetPaths.add(assertSurfaceFolderPatchPath(op.path, normalizedRoot));
			}
			parsedChanges.push({ changeId: change.changeId, ops });
		}

		const shouldCompileIdentityCss =
			targetPaths.has(IDENTITY_TOKENS_JSON_PATH) && IDENTITY_TOKENS_CSS_PATH.startsWith(`${normalizedRoot}/`);
		if (shouldCompileIdentityCss) {
			targetPaths.add(IDENTITY_TOKENS_CSS_PATH);
		}
		const orderedPaths = [...targetPaths].sort();
		const versionedMap = await ports.folder.readFilesWithVersions(
			{ profileId: job.profileId, folderRoot: normalizedRoot, paths: orderedPaths },
			signal,
		);
		const filesBefore: Record<string, string | null> = {};
		const versionsBefore: Record<string, string | null> = {};
		for (const path of orderedPaths) {
			const entry = versionedMap[path];
			filesBefore[path] = entry && typeof entry.content === "string" ? entry.content : null;
			versionsBefore[path] = entry && typeof entry.version === "string" ? entry.version : null;
		}

		const applied = applyStudioFolderPatches(filesBefore, parsedChanges, normalizedRoot);
		if (applied.status === "conflicted") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					conflictChangeId: applied.conflictChangeId,
					conflictPaths: applied.conflictPaths,
					errorDetail: formatConflictDetail(applied.conflictPaths),
				},
				signal,
			);
			return;
		}

		const finalFiles: Record<string, string | null> = { ...applied.files };
		const pathsToWrite = new Set<string>(applied.modifiedPaths);
		let mainAfter = applied.mainAfter;
		if (shouldCompileIdentityCss) {
			const nextTokensJson = finalFiles[IDENTITY_TOKENS_JSON_PATH];
			if (typeof nextTokensJson === "string") {
				finalFiles[IDENTITY_TOKENS_CSS_PATH] = compileIdentityTokensCss(nextTokensJson);
				pathsToWrite.add(IDENTITY_TOKENS_CSS_PATH);
				mainAfter = hashFolderFiles(finalFiles);
			}
		}

		const operations: SurfaceCompanyFolderCommitOperation[] = [...pathsToWrite].sort().map((path) => ({
			path,
			expectedVersion: versionsBefore[path] ?? null,
			content: finalFiles[path] ?? null,
		}));

		const commitResult = await ports.folder.commitFiles(
			{ profileId: job.profileId, folderRoot: normalizedRoot, operations },
			signal,
		);
		if (commitResult.status === "conflict") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					mainBefore: applied.mainBefore,
					conflictChangeId: parsedChanges[0]!.changeId,
					conflictPaths: commitResult.conflictPaths,
					errorDetail: formatConflictDetail(commitResult.conflictPaths),
				},
				signal,
			);
			return;
		}

		const durableSnapshot: SurfaceFolderUndoSnapshot = {
			snapshotId: applied.mainBefore,
			surfaceId: job.surfaceId,
			profileId: job.profileId,
			folderRoot: normalizedRoot,
			changeIds: parsedChanges.map((change) => change.changeId),
			filesBefore,
		};
		if (ports.folderSnapshots) {
			await ports.folderSnapshots.saveSnapshot(durableSnapshot, signal);
		}

		await completeMerge(
			{
				jobId: job.jobId,
				status: "landed",
				mainBefore: applied.mainBefore,
				mainAfter,
				preMergeSnapshot: {
					snapshotId: durableSnapshot.snapshotId,
					folderRoot: durableSnapshot.folderRoot,
					changeIds: [...durableSnapshot.changeIds],
					filesBefore: { ...durableSnapshot.filesBefore },
				},
			},
			signal,
		);
	}

	async function runCodeRepoUndo(
		job: ClaimedSurfaceMergeJob,
		signal: AbortSignal,
		completeMerge: (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => Promise<unknown>,
	): Promise<void> {
		if (!ports.undoCodeRepoChange) {
			throw new Error("Code-repository undo handler is not configured");
		}
		const repository = await resolveRepo(job.profileId, job.surfaceId, job.repositoryKey, signal);
		const changeId = typeof job.payload.changeId === "string" ? job.payload.changeId : null;
		const landedMainBefore = typeof job.payload.landedMainBefore === "string" ? job.payload.landedMainBefore : null;
		const landedMainAfter = typeof job.payload.landedMainAfter === "string" ? job.payload.landedMainAfter : null;
		if (!changeId || !isUuid(changeId) || !landedMainBefore || !landedMainAfter) {
			throw new Error("Code-repository undo payload is missing changeId or landed commit range");
		}
		const outcome = await ports.undoCodeRepoChange(
			{
				jobId: job.jobId,
				surfaceId: job.surfaceId,
				profileId: job.profileId,
				changeId,
				repository,
				landedMainBefore,
				landedMainAfter,
			},
			signal,
		);
		if (outcome.status === "landed") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "landed",
					mainBefore: outcome.mainBefore,
					mainAfter: outcome.mainAfter,
				},
				signal,
			);
			return;
		}
		if (outcome.status === "conflicted") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					conflictChangeId: changeId,
					conflictPaths: outcome.conflictPaths,
					errorDetail: outcome.errorDetail ?? formatConflictDetail(outcome.conflictPaths),
				},
				signal,
			);
			return;
		}
		await completeMerge(
			{
				jobId: job.jobId,
				status: "failed",
				errorDetail: formatErrorDetail(outcome.errorDetail, "Code-repository undo failed"),
			},
			signal,
		);
	}

	async function runFolderUndo(
		job: ClaimedSurfaceMergeJob,
		signal: AbortSignal,
		completeMerge: (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => Promise<unknown>,
	): Promise<void> {
		if (!ports.folder) {
			throw new Error("Company folder port is not configured");
		}
		if (!ports.folder.readFilesWithVersions || !ports.folder.commitFiles) {
			throw new Error("Company folder port must support atomic compare-and-swap commitFiles");
		}
		const changeId = typeof job.payload.changeId === "string" ? job.payload.changeId : null;
		if (!changeId || !isUuid(changeId)) {
			throw new Error("Folder undo payload is missing changeId");
		}
		const landedMainBefore = typeof job.payload.landedMainBefore === "string" ? job.payload.landedMainBefore : null;
		const landedMainAfter = typeof job.payload.landedMainAfter === "string" ? job.payload.landedMainAfter : null;
		const snapshot =
			parseDurableFolderSnapshot(job.preMergeSnapshot, {
				surfaceId: job.surfaceId,
				profileId: job.profileId,
				folderRoot: job.folderRoot,
			}) ??
			(ports.folderSnapshots
				? await ports.folderSnapshots.loadSnapshot(
						{
							profileId: job.profileId,
							surfaceId: job.surfaceId,
							changeId,
							snapshotId: landedMainBefore,
						},
						signal,
					)
				: null);
		if (!snapshot) {
			throw new Error(`Pre-merge folder snapshot not found for change ${changeId}`);
		}
		const normalizedRoot = normalizeSurfaceFolderRoot(job.folderRoot ?? snapshot.folderRoot);
		if (!normalizedRoot) {
			throw new Error("Folder undo job has an invalid folderRoot");
		}
		const restoreEntries = Object.entries(snapshot.filesBefore)
			.map(([path, content]) => ({
				path: assertSurfaceFolderPatchPath(path, normalizedRoot),
				content,
			}))
			.sort((left, right) => left.path.localeCompare(right.path));
		const currentVersioned = await ports.folder.readFilesWithVersions(
			{
				profileId: job.profileId,
				folderRoot: normalizedRoot,
				paths: restoreEntries.map((entry) => entry.path),
			},
			signal,
		);
		const operations: SurfaceCompanyFolderCommitOperation[] = restoreEntries.map((entry) => ({
			path: entry.path,
			expectedVersion: currentVersioned[entry.path]?.version ?? null,
			content: entry.content,
		}));
		const commitResult = await ports.folder.commitFiles(
			{ profileId: job.profileId, folderRoot: normalizedRoot, operations },
			signal,
		);
		if (commitResult.status === "conflict") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					conflictChangeId: changeId,
					conflictPaths: commitResult.conflictPaths,
					errorDetail: formatConflictDetail(commitResult.conflictPaths),
				},
				signal,
			);
			return;
		}
		await completeMerge(
			{
				jobId: job.jobId,
				status: "landed",
				mainBefore: landedMainAfter,
				mainAfter: snapshot.snapshotId,
			},
			signal,
		);
	}

	async function runMergeJob(job: ClaimedSurfaceMergeJob, signal: AbortSignal): Promise<void> {
		const leaseField = job.leaseToken !== undefined ? { leaseToken: job.leaseToken } : {};
		let reported = false;
		const completeMerge = async (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => {
			reported = true;
			return await ports.controlPlane.completeSurfaceMerge({ ...input, ...leaseField }, callSignal);
		};
		const sourceKind = inferSourceKind(job);
		try {
			if (job.kind === "undo_change") {
				if (sourceKind === "code_repo") {
					await runCodeRepoUndo(job, signal, completeMerge);
					return;
				}
				if (sourceKind === "folder") {
					await runFolderUndo(job, signal, completeMerge);
					return;
				}
				throw new Error(`Unsupported undo_change sourceKind "${sourceKind}"`);
			}
			if (sourceKind === "code_repo") {
				await runCodeRepoLand(job, signal, completeMerge);
				return;
			}
			if (sourceKind === "folder") {
				await runFolderLand(job, signal, completeMerge);
				return;
			}
			if (!ports.runOpsActionJob) {
				throw new Error("Native ops merge handler is not configured");
			}
			const opsOutcome = await ports.runOpsActionJob(job, signal);
			if (opsOutcome.status === "landed") {
				await completeMerge(
					{
						jobId: job.jobId,
						status: "landed",
						mainBefore: opsOutcome.mainBefore ?? null,
						mainAfter: opsOutcome.mainAfter ?? null,
					},
					signal,
				);
			} else {
				await completeMerge(
					{
						jobId: job.jobId,
						status: "failed",
						errorDetail: formatErrorDetail(opsOutcome.errorDetail, "Native ops action failed"),
					},
					signal,
				);
			}
		} catch (error) {
			if (!reported) {
				await ports.controlPlane.completeSurfaceMerge(
					{
						jobId: job.jobId,
						status: "failed",
						errorDetail: formatErrorDetail(error, "Surface merge execution failed"),
						...leaseField,
					},
					signal,
				);
				return;
			}
			throw error;
		}
	}

	async function runPublishJob(job: ClaimedSurfacePublishJob, signal: AbortSignal): Promise<void> {
		const leaseField = job.leaseToken !== undefined ? { leaseToken: job.leaseToken } : {};
		try {
			const repository = job.repositoryKey
				? await resolveRepo(job.profileId, job.surfaceId, job.repositoryKey, signal)
				: null;
			if (!ports.publishSurface) {
				throw new Error("Surface publish handler is not configured");
			}
			const liveHeadSha = typeof job.payload.liveHeadSha === "string" ? job.payload.liveHeadSha : null;
			const sharedAssets = ports.folder
				? await collectSharedCompanyAssets(ports.folder, job.profileId, signal)
				: undefined;
			const result = await ports.publishSurface(
				{
					jobId: job.jobId,
					surfaceId: job.surfaceId,
					profileId: job.profileId,
					repository,
					repositoryKey: job.repositoryKey,
					siteId: job.siteId,
					liveHeadSha,
					payload: job.payload,
					...(sharedAssets !== undefined ? { sharedAssets } : {}),
				},
				signal,
			);
			await ports.controlPlane.completeSurfacePublish(
				{
					jobId: job.jobId,
					status: "published",
					publishedHeadSha: result.publishedHeadSha ?? liveHeadSha,
					...leaseField,
				},
				signal,
			);
		} catch (error) {
			await ports.controlPlane.completeSurfacePublish(
				{
					jobId: job.jobId,
					status: "failed",
					errorDetail: formatErrorDetail(error, "Surface publish failed"),
					...leaseField,
				},
				signal,
			);
		}
	}

	return { runPreviewJob, runMergeJob, runPublishJob };
}
