import { createHash } from "node:crypto";
import {
	type CloudCodingRepository,
	compileIdentityTokensCss,
	IDENTITY_SHARED_ASSET_PATHS,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	isUuid,
	PRODUCT_CATALOG_PATH,
	PRODUCT_SPECS_PATH,
	parseCloudCodingRepository,
	parseStudioPatchOps,
	type StudioPatchOp,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
	type SurfaceSessionState,
	sharedProductAssetCandidates,
} from "@qorpera/contracts";
import { type CodeHostJob, CodeHostJobFailure, CodeHostRefusal, undoCodeChange } from "./code-host-jobs.ts";
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
export const SURFACE_PRE_MERGE_SNAPSHOT_MAX_BYTES = 96 * 1024;
const MAX_SNAPSHOT_VERSION_CHARS = 128;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DEFAULT_COMPLETION_RETRY_DELAYS_MS: readonly number[] = [
	250, 1_000, 2_500, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000,
];

export interface SurfaceExecutionControlPlane {
	completeSurfacePreview(input: CompleteSurfacePreviewInput, signal?: AbortSignal): Promise<unknown>;
	completeSurfaceMerge(input: CompleteSurfaceMergeInput, signal?: AbortSignal): Promise<unknown>;
	completeSurfacePublish(input: CompleteSurfacePublishInput, signal?: AbortSignal): Promise<unknown>;
}

export interface SurfaceCompanyFolderStoredFile {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
}

export type SurfaceFolderFileValue = string | null | { readonly file: SurfaceCompanyFolderStoredFile };

export interface SurfaceCompanyFolderVersionedFile {
	readonly content: string | null;
	readonly version: string | null;
	readonly file?: SurfaceCompanyFolderStoredFile | null;
}

export type SurfaceCompanyFolderCommitOperation =
	| { readonly path: string; readonly expectedVersion: string | null; readonly content: string | null }
	| { readonly path: string; readonly expectedVersion: string | null; readonly file: SurfaceCompanyFolderStoredFile };

export type SurfaceCompanyFolderCommitResult =
	| { readonly status: "saved"; readonly versionsAfter?: Readonly<Record<string, string | null>> }
	| { readonly status: "conflict"; readonly conflictPaths: readonly string[] }
	| {
			readonly status: "unverified_files";
			readonly missingPaths: readonly string[];
			readonly mismatchedPaths: readonly string[];
	  };

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
	readonly filesBefore: Readonly<Record<string, SurfaceFolderFileValue>>;
	readonly versionsAfter?: Readonly<Record<string, string | null>>;
	readonly afterContentSha256?: Readonly<Record<string, string | null>>;
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
	readonly resolveProductFolderRoots?: (profileId: string, signal: AbortSignal) => Promise<readonly string[]>;
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
	readonly completionRetryDelaysMs?: readonly number[];
	readonly rethrowOnCodeHostFailure?: boolean;
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
			readonly files: Readonly<Record<string, SurfaceFolderFileValue>>;
			readonly modifiedPaths: readonly string[];
			readonly mainBefore: string;
			readonly mainAfter: string;
	  }
	| {
			readonly status: "conflicted";
			readonly conflictChangeId: string;
			readonly conflictPaths: readonly string[];
			readonly files: Readonly<Record<string, SurfaceFolderFileValue>>;
			readonly errorDetail?: string;
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

function hashFolderFiles(files: Readonly<Record<string, SurfaceFolderFileValue>>): string {
	const sortedEntries = Object.keys(files)
		.sort()
		.map((path) => [path, files[path] ?? null] as const);
	return createHash("sha256").update(JSON.stringify(sortedEntries)).digest("hex");
}

function folderValueDigest(value: SurfaceFolderFileValue): string | null {
	if (value === null) return null;
	if (typeof value === "string") return createHash("sha256").update(value, "utf-8").digest("hex");
	return `file:${value.file.manifestSha256}`;
}

function storedFileValue(file: SurfaceCompanyFolderStoredFile): { readonly file: SurfaceCompanyFolderStoredFile } {
	return {
		file: {
			manifestSha256: file.manifestSha256,
			fileSha256: file.fileSha256,
			bytes: file.bytes,
			mediaType: file.mediaType,
			executable: file.executable,
		},
	};
}

function versionedFileValue(entry: SurfaceCompanyFolderVersionedFile | undefined): SurfaceFolderFileValue {
	if (!entry) return null;
	if (entry.file) return storedFileValue(entry.file);
	return typeof entry.content === "string" ? entry.content : null;
}

function parseStoredFileValue(value: unknown): { readonly file: SurfaceCompanyFolderStoredFile } | null {
	if (!isPlainObject(value) || !isPlainObject(value.file)) return null;
	const file = value.file;
	if (
		typeof file.manifestSha256 !== "string" ||
		!SHA256_HEX.test(file.manifestSha256) ||
		typeof file.fileSha256 !== "string" ||
		!SHA256_HEX.test(file.fileSha256) ||
		typeof file.bytes !== "number" ||
		!Number.isSafeInteger(file.bytes) ||
		file.bytes < 0 ||
		typeof file.mediaType !== "string" ||
		typeof file.executable !== "boolean"
	) {
		return null;
	}
	return storedFileValue({
		manifestSha256: file.manifestSha256,
		fileSha256: file.fileSha256,
		bytes: file.bytes,
		mediaType: file.mediaType,
		executable: file.executable,
	});
}

function unverifiedFilesDetail(missingPaths: readonly string[], mismatchedPaths: readonly string[]): string {
	const problems = [
		...(missingPaths.length > 0 ? [`Stored file not found in the company folder: ${missingPaths.join(", ")}`] : []),
		...(mismatchedPaths.length > 0
			? [`Stored file does not match its reference: ${mismatchedPaths.join(", ")}`]
			: []),
	];
	return formatErrorDetail(problems.join(". "), "Stored file not found in the company folder");
}

function commitOperation(
	path: string,
	expectedVersion: string | null,
	value: SurfaceFolderFileValue,
): SurfaceCompanyFolderCommitOperation {
	if (value !== null && typeof value === "object") return { path, expectedVersion, file: value.file };
	return { path, expectedVersion, content: value };
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
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
	baseFiles: Readonly<Record<string, SurfaceFolderFileValue>>,
	changes: readonly { readonly changeId: string; readonly ops: readonly StudioPatchOp[] }[],
	folderRoot: string,
): ApplyStudioFolderPatchesResult {
	const normalizedRoot = normalizeSurfaceFolderRoot(folderRoot);
	if (!normalizedRoot) {
		throw new Error("Surface folderRoot is required for folder_patch landing");
	}
	const working: Record<string, SurfaceFolderFileValue> = { ...baseFiles };
	const touchedWholeFiles = new Map<string, string>();
	const touchedJsonKeys = new Map<string, Map<string, string>>();
	const modifiedPaths = new Set<string>();

	for (const change of changes) {
		const snapshot: Record<string, SurfaceFolderFileValue> = { ...working };
		const nextWholeFiles = new Map(touchedWholeFiles);
		const nextJsonKeys = new Map<string, Map<string, string>>();
		for (const [filePath, keys] of touchedJsonKeys) {
			nextJsonKeys.set(filePath, new Map(keys));
		}
		const conflictPaths: string[] = [];
		const storedMergePaths: string[] = [];
		const changeModifiedPaths = new Set<string>();

		for (const op of change.ops) {
			const safePath = assertSurfaceFolderPatchPath(op.path, normalizedRoot);
			if (op.op === "write_text" || op.op === "delete" || op.op === "write_file") {
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
				working[safePath] =
					op.op === "delete"
						? null
						: op.op === "write_file"
							? storedFileValue({ ...op.file, executable: false })
							: op.content;
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
			if (existing !== null && typeof existing === "object") {
				conflictPaths.push(safePath);
				storedMergePaths.push(safePath);
				continue;
			}
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
				...(storedMergePaths.length > 0
					? { errorDetail: `merge_json cannot change a stored file: ${[...new Set(storedMergePaths)].join(", ")}` }
					: {}),
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
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await prepareSurfaceRepository(codeHostJob, { repository: input.repository, slug: input.repository.name });
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
			if (attempt === 0 && error instanceof CodeHostJobFailure && error.code === "CODE_HOST_BASE_MOVED") {
				continue;
			}
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
	return { status: "failed", errorDetail: "Code-repository undo failed after concurrent branch update" };
}

export async function collectSharedCompanyAssets(
	folder: Pick<SurfaceCompanyFolderPort, "readFiles">,
	profileId: string,
	signal: AbortSignal,
	productFolderRoots?: readonly string[] | null,
): Promise<Readonly<Record<string, string>>> {
	const { specsPaths, catalogPaths } = sharedProductAssetCandidates(productFolderRoots);
	const requestPaths = [...new Set([...IDENTITY_SHARED_ASSET_PATHS, ...specsPaths, ...catalogPaths])];
	let raw: Readonly<Record<string, string | null>>;
	try {
		raw = await folder.readFiles({ profileId, folderRoot: "", paths: requestPaths }, signal);
	} catch {
		return {};
	}
	const mounted: Record<string, string> = {};
	for (const assetPath of IDENTITY_SHARED_ASSET_PATHS) {
		const content = raw[assetPath];
		if (typeof content !== "string") continue;
		mounted[`${SURFACE_SHARED_DIR}/${assetPath}`] = content;
	}
	for (const specsPath of specsPaths) {
		const content = raw[specsPath];
		if (typeof content === "string") {
			mounted[`${SURFACE_SHARED_DIR}/${PRODUCT_SPECS_PATH}`] = content;
			break;
		}
	}
	for (const catalogPath of catalogPaths) {
		const content = raw[catalogPath];
		if (typeof content === "string") {
			mounted[`${SURFACE_SHARED_DIR}/${PRODUCT_CATALOG_PATH}`] = content;
			break;
		}
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

function parseOptionalNullableStringRecord(value: unknown): Record<string, string | null> | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: Record<string, string | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== null && typeof item !== "string") return undefined;
		out[key] = item;
	}
	return out;
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
	const filesBefore: Record<string, SurfaceFolderFileValue> = {};
	for (const [path, value] of Object.entries(filesRaw as Record<string, unknown>)) {
		if (value === null || typeof value === "string") {
			filesBefore[path] = value;
			continue;
		}
		const stored = parseStoredFileValue(value);
		if (!stored) return null;
		filesBefore[path] = stored;
	}
	const changeIds = Array.isArray(raw.changeIds)
		? raw.changeIds.filter((item): item is string => typeof item === "string")
		: [];
	const versionsAfter = parseOptionalNullableStringRecord(raw.versionsAfter);
	const afterContentSha256 = parseOptionalNullableStringRecord(raw.afterContentSha256);
	return {
		snapshotId: raw.snapshotId,
		surfaceId: typeof raw.surfaceId === "string" ? raw.surfaceId : fallback.surfaceId,
		profileId: typeof raw.profileId === "string" ? raw.profileId : fallback.profileId,
		folderRoot,
		changeIds,
		filesBefore,
		...(versionsAfter !== undefined ? { versionsAfter } : {}),
		...(afterContentSha256 !== undefined ? { afterContentSha256 } : {}),
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
			if ((error instanceof CodeHostJobFailure && error.code === "CODE_HOST_JOB_YIELDED") || signal.aborted) {
				throw error;
			}
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
		const productFolderRoots =
			ports.folder && ports.resolveProductFolderRoots
				? await ports.resolveProductFolderRoots(job.profileId, signal).catch(() => undefined)
				: undefined;
		const sharedAssets = ports.folder
			? await collectSharedCompanyAssets(ports.folder, job.profileId, signal, productFolderRoots)
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
		completeCommittedMerge: (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => Promise<unknown>,
		markCommitted: () => void,
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
		const filesBefore: Record<string, SurfaceFolderFileValue> = {};
		const versionsBefore: Record<string, string | null> = {};
		for (const path of orderedPaths) {
			const entry = versionedMap[path];
			filesBefore[path] = versionedFileValue(entry);
			versionsBefore[path] = entry && typeof entry.version === "string" ? entry.version : null;
		}

		// WHY: If a prior attempt committed files and crashed before reporting completion, reuse its pre-merge snapshot instead of overwriting filesBefore.
		if (ports.folderSnapshots) {
			const existingSnapshot = await ports.folderSnapshots.loadSnapshot(
				{
					profileId: job.profileId,
					surfaceId: job.surfaceId,
					changeId: parsedChanges[0]!.changeId,
				},
				signal,
			);
			if (
				existingSnapshot?.afterContentSha256 &&
				orderedPaths.every(
					(path) =>
						folderValueDigest(filesBefore[path] ?? null) === (existingSnapshot.afterContentSha256![path] ?? null),
				)
			) {
				const changeIds = parsedChanges.map((change) => change.changeId);
				const versionsFitInline = Object.values(versionsBefore).every(
					(value) => value === null || value.length <= MAX_SNAPSHOT_VERSION_CHARS,
				);
				const recoveredSnapshot: SurfaceFolderUndoSnapshot = {
					...existingSnapshot,
					versionsAfter: { ...versionsBefore },
				};
				await ports.folderSnapshots.saveSnapshot(recoveredSnapshot, signal);
				markCommitted();
				await completeCommittedMerge(
					{
						jobId: job.jobId,
						status: "landed",
						mainBefore: existingSnapshot.snapshotId,
						mainAfter: hashFolderFiles(filesBefore),
						preMergeSnapshot: {
							snapshotId: existingSnapshot.snapshotId,
							folderRoot: existingSnapshot.folderRoot,
							changeIds,
							externalSnapshot: true,
							...(versionsFitInline ? { versionsAfter: { ...versionsBefore } } : {}),
							afterContentSha256: existingSnapshot.afterContentSha256,
						},
					},
					signal,
				);
				return;
			}
		}

		const applied = applyStudioFolderPatches(filesBefore, parsedChanges, normalizedRoot);
		if (applied.status === "conflicted") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					conflictChangeId: applied.conflictChangeId,
					conflictPaths: applied.conflictPaths,
					errorDetail: applied.errorDetail ?? formatConflictDetail(applied.conflictPaths),
				},
				signal,
			);
			return;
		}

		const finalFiles: Record<string, SurfaceFolderFileValue> = { ...applied.files };
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

		const changeIds = parsedChanges.map((change) => change.changeId);
		const afterContentSha256: Record<string, string | null> = {};
		const placeholderVersionsAfter: Record<string, string> = {};
		for (const path of orderedPaths) {
			afterContentSha256[path] = folderValueDigest(finalFiles[path] ?? null);
			placeholderVersionsAfter[path] = "v".repeat(MAX_SNAPSHOT_VERSION_CHARS);
		}

		const useExternalSnapshot = ports.folderSnapshots !== undefined;
		const preCommitCandidate: Record<string, unknown> = useExternalSnapshot
			? {
					snapshotId: applied.mainBefore,
					folderRoot: normalizedRoot,
					changeIds,
					externalSnapshot: true,
					versionsAfter: placeholderVersionsAfter,
					afterContentSha256,
				}
			: {
					snapshotId: applied.mainBefore,
					folderRoot: normalizedRoot,
					changeIds,
					filesBefore,
					versionsAfter: placeholderVersionsAfter,
					afterContentSha256,
				};
		// WHY: Reject oversized pre-merge snapshots before mutating files so commitFiles never runs without a durable record.
		if (Buffer.byteLength(JSON.stringify(preCommitCandidate), "utf-8") > SURFACE_PRE_MERGE_SNAPSHOT_MAX_BYTES) {
			throw new Error(
				useExternalSnapshot
					? "Pre-merge folder snapshot metadata exceeds 96 KiB limit"
					: "Pre-merge folder snapshot exceeds 96 KiB inline limit",
			);
		}

		const baseSnapshot: SurfaceFolderUndoSnapshot = {
			snapshotId: applied.mainBefore,
			surfaceId: job.surfaceId,
			profileId: job.profileId,
			folderRoot: normalizedRoot,
			changeIds,
			filesBefore,
			afterContentSha256,
		};
		if (ports.folderSnapshots) {
			await ports.folderSnapshots.saveSnapshot(baseSnapshot, signal);
		}

		const operations: SurfaceCompanyFolderCommitOperation[] = [...pathsToWrite]
			.sort()
			.map((path) => commitOperation(path, versionsBefore[path] ?? null, finalFiles[path] ?? null));

		const commitResult = await ports.folder.commitFiles(
			{ profileId: job.profileId, folderRoot: normalizedRoot, operations },
			signal,
		);
		if (commitResult.status === "unverified_files") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "failed",
					errorDetail: unverifiedFilesDetail(commitResult.missingPaths, commitResult.mismatchedPaths),
				},
				signal,
			);
			return;
		}
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
		markCommitted();

		const versionsAfter: Record<string, string | null> = {};
		if (commitResult.versionsAfter) {
			for (const path of orderedPaths) {
				if (Object.hasOwn(commitResult.versionsAfter, path)) {
					versionsAfter[path] = commitResult.versionsAfter[path] ?? null;
				} else {
					versionsAfter[path] = versionsBefore[path] ?? null;
				}
			}
		} else {
			const postVersioned = await ports.folder.readFilesWithVersions(
				{ profileId: job.profileId, folderRoot: normalizedRoot, paths: orderedPaths },
				signal,
			);
			for (const path of orderedPaths) {
				versionsAfter[path] = postVersioned[path]?.version ?? null;
			}
		}

		const versionsFitInline = Object.values(versionsAfter).every(
			(value) => value === null || value.length <= MAX_SNAPSHOT_VERSION_CHARS,
		);
		const durableSnapshot: SurfaceFolderUndoSnapshot = {
			...baseSnapshot,
			versionsAfter,
		};
		if (ports.folderSnapshots) {
			await ports.folderSnapshots.saveSnapshot(durableSnapshot, signal);
		}

		const preMergeSnapshot: Record<string, unknown> = useExternalSnapshot
			? {
					snapshotId: durableSnapshot.snapshotId,
					folderRoot: durableSnapshot.folderRoot,
					changeIds: [...durableSnapshot.changeIds],
					externalSnapshot: true,
					...(versionsFitInline ? { versionsAfter } : {}),
					afterContentSha256,
				}
			: {
					snapshotId: durableSnapshot.snapshotId,
					folderRoot: durableSnapshot.folderRoot,
					changeIds: [...durableSnapshot.changeIds],
					filesBefore: { ...durableSnapshot.filesBefore },
					...(versionsFitInline ? { versionsAfter } : {}),
					afterContentSha256,
				};

		await completeCommittedMerge(
			{
				jobId: job.jobId,
				status: "landed",
				mainBefore: applied.mainBefore,
				mainAfter,
				preMergeSnapshot,
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
		completeCommittedMerge: (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => Promise<unknown>,
		markCommitted: () => void,
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
		const loadedSnapshot =
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
		if (!loadedSnapshot) {
			throw new Error(`Pre-merge folder snapshot not found for change ${changeId}`);
		}
		const metadataVersionsAfter = parseOptionalNullableStringRecord(job.preMergeSnapshot?.versionsAfter);
		const metadataAfterSha = parseOptionalNullableStringRecord(job.preMergeSnapshot?.afterContentSha256);
		const versionsAfter = loadedSnapshot.versionsAfter ?? metadataVersionsAfter;
		const afterContentSha256 = loadedSnapshot.afterContentSha256 ?? metadataAfterSha;
		if (!versionsAfter && !afterContentSha256) {
			throw new Error(`Pre-merge folder snapshot for change ${changeId} is missing post-commit version guards`);
		}
		const snapshot: SurfaceFolderUndoSnapshot = {
			...loadedSnapshot,
			...(versionsAfter !== undefined ? { versionsAfter } : {}),
			...(afterContentSha256 !== undefined ? { afterContentSha256 } : {}),
		};

		const normalizedRoot = normalizeSurfaceFolderRoot(job.folderRoot ?? snapshot.folderRoot);
		if (!normalizedRoot) {
			throw new Error("Folder undo job has an invalid folderRoot");
		}
		const restoreEntries = Object.entries(snapshot.filesBefore)
			.map(([path, value]) => ({
				path: assertSurfaceFolderPatchPath(path, normalizedRoot),
				value,
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

		// WHY: If a prior undo attempt already restored filesBefore and crashed before reporting completion, report landed idempotently instead of conflicting.
		const alreadyReverted = restoreEntries.every(
			(entry) =>
				folderValueDigest(versionedFileValue(currentVersioned[entry.path])) === folderValueDigest(entry.value),
		);
		if (alreadyReverted) {
			markCommitted();
			await completeCommittedMerge(
				{
					jobId: job.jobId,
					status: "landed",
					mainBefore: landedMainAfter,
					mainAfter: snapshot.snapshotId,
				},
				signal,
			);
			return;
		}

		const conflictPaths: string[] = [];
		for (const entry of restoreEntries) {
			const current = currentVersioned[entry.path];
			const currentVersion = current?.version ?? null;
			if (snapshot.versionsAfter && (snapshot.versionsAfter[entry.path] ?? null) !== currentVersion) {
				conflictPaths.push(entry.path);
				continue;
			}
			if (
				snapshot.afterContentSha256 &&
				(snapshot.afterContentSha256[entry.path] ?? null) !== folderValueDigest(versionedFileValue(current))
			) {
				conflictPaths.push(entry.path);
			}
		}
		if (conflictPaths.length > 0) {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "conflicted",
					conflictChangeId: changeId,
					conflictPaths,
					errorDetail: formatConflictDetail(conflictPaths),
				},
				signal,
			);
			return;
		}

		// WHY: Pin expectedVersion to post-landing versionsAfter so concurrent edits after landing never get overwritten.
		const operations: SurfaceCompanyFolderCommitOperation[] = restoreEntries.map((entry) =>
			commitOperation(
				entry.path,
				snapshot.versionsAfter
					? (snapshot.versionsAfter[entry.path] ?? null)
					: (currentVersioned[entry.path]?.version ?? null),
				entry.value,
			),
		);
		const commitResult = await ports.folder.commitFiles(
			{ profileId: job.profileId, folderRoot: normalizedRoot, operations },
			signal,
		);
		if (commitResult.status === "unverified_files") {
			await completeMerge(
				{
					jobId: job.jobId,
					status: "failed",
					errorDetail: unverifiedFilesDetail(commitResult.missingPaths, commitResult.mismatchedPaths),
				},
				signal,
			);
			return;
		}
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
		markCommitted();
		await completeCommittedMerge(
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
		let committed = false;
		const retryDelays = ports.completionRetryDelaysMs ?? DEFAULT_COMPLETION_RETRY_DELAYS_MS;
		const markCommitted = (): void => {
			committed = true;
		};
		const completeMerge = async (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => {
			reported = true;
			return await ports.controlPlane.completeSurfaceMerge({ ...input, ...leaseField }, callSignal);
		};
		// WHY: Retry transient completion failures after a committed write rather than re-running or marking the landing failed.
		const completeCommittedMerge = async (input: CompleteSurfaceMergeInput, callSignal?: AbortSignal) => {
			reported = true;
			let lastError: unknown;
			for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
				try {
					return await ports.controlPlane.completeSurfaceMerge({ ...input, ...leaseField }, callSignal);
				} catch (error) {
					lastError = error;
					if (attempt === retryDelays.length || callSignal?.aborted) {
						throw error;
					}
					await delayWithAbort(retryDelays[attempt] ?? 0, callSignal ?? signal);
				}
			}
			throw lastError;
		};
		const sourceKind = inferSourceKind(job);
		try {
			if (job.kind === "undo_change") {
				if (sourceKind === "code_repo") {
					await runCodeRepoUndo(job, signal, completeMerge);
					return;
				}
				if (sourceKind === "folder") {
					await runFolderUndo(job, signal, completeMerge, completeCommittedMerge, markCommitted);
					return;
				}
				throw new Error(`Unsupported undo_change sourceKind "${sourceKind}"`);
			}
			if (sourceKind === "code_repo") {
				await runCodeRepoLand(job, signal, completeMerge);
				return;
			}
			if (sourceKind === "folder") {
				await runFolderLand(job, signal, completeMerge, completeCommittedMerge, markCommitted);
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
			if (ports.rethrowOnCodeHostFailure && sourceKind === "code_repo" && !reported && !committed) {
				throw error;
			}
			if (!reported && !committed) {
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
			const productFolderRoots =
				ports.folder && ports.resolveProductFolderRoots
					? await ports.resolveProductFolderRoots(job.profileId, signal).catch(() => undefined)
					: undefined;
			const sharedAssets = ports.folder
				? await collectSharedCompanyAssets(ports.folder, job.profileId, signal, productFolderRoots)
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
			if ((error instanceof CodeHostJobFailure && error.code === "CODE_HOST_JOB_YIELDED") || signal.aborted) {
				throw error;
			}
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
