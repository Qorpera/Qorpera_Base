import { createHash } from "node:crypto";
import { composeStudioPreview, type StudioPreviewReconciliation } from "@qorpera/cloud-client/surface-studio-patches";
import {
	folderKey,
	normalizeStudioFolderRoot,
	parseStudioPatchOps,
	parseSurfaceReconciliation,
	resolveStudioFolderPath,
	type StudioPatchChange,
	type StudioPatchOp,
} from "@qorpera/contracts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import type { SurfaceFolderTextReader } from "./cloud-surface-session-runner.ts";

const MAX_OVERLAY_BASE_FILES = 48;
const MAX_OVERLAY_BASE_FILE_BYTES = 128 * 1024;
const MAX_OVERLAY_BASE_TOTAL_CHARS = 512_000;

export interface SurfacePreviewBaseChange {
	readonly changeId: string;
	readonly title: string;
	readonly summary: string;
	readonly kind: string;
	readonly parentSha: string | null;
	readonly headSha: string | null;
	readonly affectedPaths: readonly string[];
	readonly previewBaseChangeIds: readonly string[];
	readonly patchManifest: readonly StudioPatchOp[] | null;
	readonly baseFiles: Readonly<Record<string, string | null>> | null;
	readonly truncated?: boolean;
}

export interface SurfaceOmittedBaseChange {
	readonly changeId: string;
	readonly title: string;
	readonly summary: string;
	readonly kind: string;
	readonly status: string;
	readonly parentSha: string | null;
	readonly headSha: string | null;
	readonly affectedPaths: readonly string[];
	readonly patchManifest: readonly StudioPatchOp[] | null;
}

export interface SurfacePreviewContext {
	readonly previewBaseChanges: readonly SurfacePreviewBaseChange[];
	readonly previewReconciliations: readonly StudioPreviewReconciliation[];
}

export type CloudFolderPreviewOverlayLookup =
	| {
			readonly kind: "file";
			readonly path: string;
			readonly content: string;
			readonly bytes: Uint8Array;
			readonly sha256: string;
	  }
	| {
			readonly kind: "folder";
			readonly path: string;
	  }
	| {
			readonly kind: "deleted";
			readonly path: string;
	  };

export interface CloudFolderPreviewOverlayList {
	readonly files: readonly { readonly path: string; readonly bytes: number }[];
	readonly folders: readonly string[];
	readonly deletedKeys: ReadonlySet<string>;
}

export interface CloudFolderPreviewOverlayStatus {
	readonly status: "ready" | "conflicted";
	readonly skippedPaths: readonly string[];
}

export interface CloudFolderPreviewOverlay {
	readonly folderRoot: string;
	isUnderRoot(companyPath: string): boolean;
	mayAffectList(parentPath: string, recursive: boolean): boolean;
	prepare(signal: AbortSignal): Promise<CloudFolderPreviewOverlayStatus>;
	lookup(companyPath: string, signal: AbortSignal): Promise<CloudFolderPreviewOverlayLookup | null>;
	listUnder(parentPath: string, recursive: boolean, signal: AbortSignal): Promise<CloudFolderPreviewOverlayList>;
	wrapTextReader(base: SurfaceFolderTextReader): SurfaceFolderTextReader;
}

function parseOptionalBaseFileMap(raw: unknown): Readonly<Record<string, string | null>> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const out: Record<string, string | null> = {};
	let count = 0;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!key.trim()) continue;
		if (value === null || typeof value === "string") {
			out[key] = value;
			count += 1;
		}
	}
	return count > 0 ? out : null;
}

function parseOptionalManifest(raw: unknown, label: string): readonly StudioPatchOp[] | null {
	if (!Array.isArray(raw)) return null;
	try {
		const ops = parseStudioPatchOps(raw, label);
		return ops.length > 0 ? ops : null;
	} catch {
		return null;
	}
}

function parseNonEmptyStrings(raw: unknown, limit: number): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed) continue;
		out.push(trimmed);
		if (out.length >= limit) break;
	}
	return out;
}

export function parseSurfacePreviewContext(raw: unknown): SurfacePreviewContext {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { previewBaseChanges: [], previewReconciliations: [] };
	}
	const rec = raw as Record<string, unknown>;
	const previewBaseChanges: SurfacePreviewBaseChange[] = [];
	if (Array.isArray(rec.previewBaseChanges)) {
		for (const entry of rec.previewBaseChanges) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const item = entry as Record<string, unknown>;
			const changeId = typeof item.changeId === "string" ? item.changeId.trim() : "";
			if (!changeId) continue;
			previewBaseChanges.push({
				changeId,
				title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : changeId,
				summary: typeof item.summary === "string" ? item.summary.trim() : "",
				kind: typeof item.kind === "string" ? item.kind : "folder_patch",
				parentSha: typeof item.parentSha === "string" ? item.parentSha : null,
				headSha: typeof item.headSha === "string" ? item.headSha : null,
				affectedPaths: parseNonEmptyStrings(item.affectedPaths, 200),
				previewBaseChangeIds: parseNonEmptyStrings(item.previewBaseChangeIds, 64),
				patchManifest: parseOptionalManifest(item.patchManifest, "previewBaseChange.patchManifest"),
				baseFiles: parseOptionalBaseFileMap(item.baseFiles),
				...(item.truncated === true ? { truncated: true } : {}),
			});
		}
	}
	const previewReconciliations: StudioPreviewReconciliation[] = [];
	if (Array.isArray(rec.previewReconciliations)) {
		for (const entry of rec.previewReconciliations) {
			try {
				const parsed = parseSurfaceReconciliation(entry, "previewReconciliation");
				previewReconciliations.push(parsed);
			} catch {}
		}
	}
	return { previewBaseChanges, previewReconciliations };
}

export function parseSurfaceOmittedBaseChanges(raw: unknown): SurfaceOmittedBaseChange[] {
	if (!Array.isArray(raw)) return [];
	const out: SurfaceOmittedBaseChange[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		const changeId = typeof item.changeId === "string" ? item.changeId.trim() : "";
		if (!changeId) continue;
		out.push({
			changeId,
			title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : changeId,
			summary: typeof item.summary === "string" ? item.summary.trim() : "",
			kind: typeof item.kind === "string" ? item.kind : "folder_patch",
			status: typeof item.status === "string" ? item.status : "staged",
			parentSha: typeof item.parentSha === "string" ? item.parentSha : null,
			headSha: typeof item.headSha === "string" ? item.headSha : null,
			affectedPaths: parseNonEmptyStrings(item.affectedPaths, 200),
			patchManifest: parseOptionalManifest(item.patchManifest, "omittedBaseChange.patchManifest"),
		});
	}
	return out;
}

interface OverlaySnapshot {
	readonly status: "ready" | "conflicted";
	readonly entries: ReadonlyMap<string, CloudFolderPreviewOverlayLookup>;
	readonly virtualFolders: ReadonlyMap<string, string>;
	readonly skippedPaths: readonly string[];
}

function collectTouchedPaths(
	folderRoot: string,
	changes: readonly StudioPatchChange[],
	reconciliations: readonly StudioPreviewReconciliation[],
): { readonly paths: readonly string[]; readonly deletedPaths: ReadonlySet<string> } {
	const byKey = new Map<string, string>();
	const deletedPaths = new Set<string>();
	const visitOps = (ops: readonly StudioPatchOp[]) => {
		for (const op of ops) {
			let resolved: string;
			try {
				resolved = resolveStudioFolderPath(folderRoot, op.path);
			} catch {
				continue;
			}
			const key = folderKey(resolved);
			if (!byKey.has(key)) byKey.set(key, resolved);
			if (op.op === "delete") deletedPaths.add(key);
		}
	};
	for (const change of changes) visitOps(change.ops);
	for (const rec of reconciliations) {
		if (rec.status === "ready" && rec.patchManifest) visitOps(rec.patchManifest);
	}
	return { paths: [...byKey.values()], deletedPaths };
}

export function createSurfaceFolderPreviewOverlay(options: {
	readonly folderRoot: string;
	readonly previewBaseChanges: readonly SurfacePreviewBaseChange[];
	readonly previewReconciliations?: readonly StudioPreviewReconciliation[];
	readonly liveReader: SurfaceFolderTextReader;
}): CloudFolderPreviewOverlay | null {
	let normalizedRoot: string;
	try {
		normalizedRoot = normalizeStudioFolderRoot(options.folderRoot);
	} catch {
		return null;
	}
	const patchChanges: StudioPatchChange[] = [];
	const truncatedByKey = new Map<string, string>();
	for (const change of options.previewBaseChanges) {
		if (change.kind !== "folder_patch") continue;
		if (!change.patchManifest || change.patchManifest.length === 0) {
			if (change.truncated) {
				for (const rawPath of change.affectedPaths) {
					try {
						const resolved = resolveStudioFolderPath(normalizedRoot, rawPath);
						const key = folderKey(resolved);
						if (!truncatedByKey.has(key)) truncatedByKey.set(key, resolved);
					} catch {}
				}
			}
			continue;
		}
		patchChanges.push({
			changeId: change.changeId,
			ops: change.patchManifest,
			...(change.baseFiles ? { baseFiles: change.baseFiles } : {}),
			...(change.previewBaseChangeIds.length > 0 ? { previewBaseChangeIds: change.previewBaseChangeIds } : {}),
		});
	}
	if (patchChanges.length === 0) return null;

	const reconciliations = options.previewReconciliations ?? [];
	const rootKey = folderKey(normalizedRoot);
	const rootPrefix = `${rootKey}/`;
	const { paths: touchedPaths, deletedPaths } = collectTouchedPaths(normalizedRoot, patchChanges, reconciliations);
	if (touchedPaths.length === 0) return null;

	type BaseReadOutcome =
		| { readonly kind: "text"; readonly fullPath: string; readonly text: string }
		| { readonly kind: "missing"; readonly fullPath: string }
		| { readonly kind: "unreadable"; readonly fullPath: string };

	let snapshotPromise: Promise<OverlaySnapshot> | null = null;
	const loadSnapshot = (signal: AbortSignal): Promise<OverlaySnapshot> => {
		if (snapshotPromise) return snapshotPromise;
		const promise = (async (): Promise<OverlaySnapshot> => {
			const liveBaseFiles: Record<string, string> = {};
			const unreadableByKey = new Map<string, string>(truncatedByKey);
			let totalChars = 0;
			const toRead = touchedPaths.slice(0, MAX_OVERLAY_BASE_FILES);
			for (const overflowPath of touchedPaths.slice(MAX_OVERLAY_BASE_FILES)) {
				const key = folderKey(overflowPath);
				if (!unreadableByKey.has(key)) unreadableByKey.set(key, overflowPath);
			}
			const reads: BaseReadOutcome[] = await Promise.all(
				toRead.map(async (fullPath): Promise<BaseReadOutcome> => {
					if (unreadableByKey.has(folderKey(fullPath))) {
						return { kind: "unreadable", fullPath };
					}
					try {
						const found = await options.liveReader.readText(fullPath, MAX_OVERLAY_BASE_FILE_BYTES, signal);
						if (found === null) return { kind: "missing", fullPath };
						if (found === undefined) return { kind: "unreadable", fullPath };
						const text = typeof found === "string" ? found : found.text;
						return { kind: "text", fullPath, text };
					} catch (error) {
						if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
						return { kind: "unreadable", fullPath };
					}
				}),
			);
			for (const item of reads) {
				if (item.kind === "unreadable") {
					const key = folderKey(item.fullPath);
					if (!unreadableByKey.has(key)) unreadableByKey.set(key, item.fullPath);
					continue;
				}
				if (item.kind === "missing") continue;
				if (totalChars + item.text.length > MAX_OVERLAY_BASE_TOTAL_CHARS) {
					const key = folderKey(item.fullPath);
					if (!unreadableByKey.has(key)) unreadableByKey.set(key, item.fullPath);
					continue;
				}
				liveBaseFiles[item.fullPath] = item.text;
				totalChars += item.text.length;
			}

			const skippedPaths = [...unreadableByKey.values()].sort();
			const isUnreadableOpPath = (rawPath: string): boolean => {
				try {
					return unreadableByKey.has(folderKey(resolveStudioFolderPath(normalizedRoot, rawPath)));
				} catch {
					return false;
				}
			};
			// WHY: Exclude unread or over-cap paths before composing so merge_json never fabricates partial files from an empty base.
			const filteredPatchChanges =
				unreadableByKey.size === 0
					? patchChanges
					: patchChanges
							.map((change) => ({
								...change,
								ops: change.ops.filter((op) => !isUnreadableOpPath(op.path)),
							}))
							.filter((change) => change.ops.length > 0);
			const filteredReconciliations =
				unreadableByKey.size === 0
					? reconciliations
					: reconciliations.map((rec) => ({
							...rec,
							patchManifest: rec.patchManifest?.filter((op) => !isUnreadableOpPath(op.path)) ?? null,
							...(rec.conflictPaths
								? { conflictPaths: rec.conflictPaths.filter((path) => !isUnreadableOpPath(path)) }
								: {}),
						}));

			const composed = composeStudioPreview(
				liveBaseFiles,
				filteredPatchChanges,
				normalizedRoot,
				{},
				{ reconciliations: filteredReconciliations },
			);
			if (composed.status !== "ready") {
				return {
					status: "conflicted",
					entries: new Map(),
					virtualFolders: new Map(),
					skippedPaths,
				};
			}

			const entries = new Map<string, CloudFolderPreviewOverlayLookup>();
			const virtualFolders = new Map<string, string>();
			const registerAncestors = (fullPath: string) => {
				const parts = fullPath.split("/");
				for (let i = 1; i < parts.length; i += 1) {
					const dir = parts.slice(0, i).join("/");
					const dirKey = folderKey(dir);
					if (!virtualFolders.has(dirKey)) virtualFolders.set(dirKey, dir);
				}
			};

			const composedByKey = new Map<string, { readonly path: string; readonly content: string }>();
			for (const [path, content] of Object.entries(composed.files)) {
				composedByKey.set(folderKey(path), { path, content });
			}
			const composedBinaryKeys = new Set<string>(Object.keys(composed.binaries).map((path) => folderKey(path)));
			const liveByKey = new Map<string, string>();
			for (const [path, content] of Object.entries(liveBaseFiles)) {
				liveByKey.set(folderKey(path), content);
			}

			for (const path of touchedPaths) {
				const key = folderKey(path);
				if (unreadableByKey.has(key)) continue;
				const next = composedByKey.get(key);
				const hadLive = liveByKey.has(key);
				if (!next) {
					if (composedBinaryKeys.has(key)) continue;
					if (hadLive || deletedPaths.has(key)) {
						entries.set(key, { kind: "deleted", path });
					}
					continue;
				}
				const bytes = Buffer.from(next.content, "utf8");
				const sha256 = createHash("sha256").update(bytes).digest("hex");
				entries.set(key, {
					kind: "file",
					path: next.path,
					content: next.content,
					bytes,
					sha256,
				});
				registerAncestors(next.path);
			}
			return { status: "ready", entries, virtualFolders, skippedPaths };
		})();
		snapshotPromise = promise;
		void promise.catch(() => {
			if (snapshotPromise === promise) snapshotPromise = null;
		});
		return promise;
	};

	const isUnderRoot = (companyPath: string): boolean => {
		const key = folderKey(companyPath.trim().replace(/^\/+|\/+$/g, ""));
		return key === rootKey || key.startsWith(rootPrefix);
	};

	const mayAffectList = (parentPath: string, _recursive: boolean): boolean => {
		const cleaned = parentPath.trim().replace(/^\/+|\/+$/g, "");
		if (cleaned === "") return true;
		const key = folderKey(cleaned);
		return key === rootKey || key.startsWith(rootPrefix) || rootKey.startsWith(`${key}/`);
	};

	const overlay: CloudFolderPreviewOverlay = {
		folderRoot: normalizedRoot,
		isUnderRoot,
		mayAffectList,
		async prepare(signal) {
			const snapshot = await loadSnapshot(signal);
			return { status: snapshot.status, skippedPaths: snapshot.skippedPaths };
		},
		async lookup(companyPath, signal) {
			const cleaned = companyPath.trim().replace(/^\/+|\/+$/g, "");
			if (!cleaned || !isUnderRoot(cleaned)) return null;
			const snapshot = await loadSnapshot(signal);
			const key = folderKey(cleaned);
			const exact = snapshot.entries.get(key);
			if (exact) return exact;
			const folderPath = snapshot.virtualFolders.get(key);
			if (folderPath) return { kind: "folder", path: folderPath };
			return null;
		},
		async listUnder(parentPath, recursive, signal) {
			if (!mayAffectList(parentPath, recursive)) {
				return { files: [], folders: [], deletedKeys: new Set<string>() };
			}
			const snapshot = await loadSnapshot(signal);
			const cleanedParent = parentPath.trim().replace(/^\/+|\/+$/g, "");
			const parentKey = cleanedParent === "" ? "" : folderKey(cleanedParent);
			const parentPrefix = parentKey === "" ? "" : `${parentKey}/`;
			const parentDepth = cleanedParent === "" ? 0 : cleanedParent.split("/").length;
			const files: { readonly path: string; readonly bytes: number }[] = [];
			const folders: string[] = [];
			const deletedKeys = new Set<string>();

			const matchesScope = (entryPath: string): boolean => {
				const entryKey = folderKey(entryPath);
				if (parentKey !== "" && !entryKey.startsWith(parentPrefix)) return false;
				if (!recursive && entryPath.split("/").length !== parentDepth + 1) return false;
				return true;
			};

			for (const [key, entry] of snapshot.entries) {
				if (!matchesScope(entry.path)) continue;
				if (entry.kind === "deleted") {
					deletedKeys.add(key);
				} else if (entry.kind === "file") {
					files.push({ path: entry.path, bytes: entry.bytes.byteLength });
				}
			}
			for (const folderPath of snapshot.virtualFolders.values()) {
				if (!matchesScope(folderPath)) continue;
				folders.push(folderPath);
			}
			return { files, folders, deletedKeys };
		},
		wrapTextReader(base) {
			return {
				async readText(path, maxBytes, signal) {
					const cleaned = path.trim().replace(/^\/+|\/+$/g, "");
					if (isUnderRoot(cleaned)) {
						const found = await overlay.lookup(cleaned, signal);
						if (found?.kind === "deleted") return null;
						if (found?.kind === "folder") {
							throw new CloudCompanyPathNotText("Company folder path is a folder");
						}
						if (found?.kind === "file") {
							if (found.bytes.byteLength > maxBytes) {
								throw new CloudCompanyPathNotText("Company folder file is larger than text here");
							}
							return { text: found.content };
						}
					}
					return base.readText(path, maxBytes, signal);
				},
			};
		},
	};
	return overlay;
}
