import {
	normalizeStudioFolderRoot,
	resolveStudioFolderPath,
	type StudioBinaryRef,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfacePreviewConflict,
} from "@qorpera/contracts";

export type { StudioBinaryRef, StudioPatchChange, StudioPatchOp };

export type StudioPreviewComposition =
	| {
			readonly status: "ready";
			readonly files: Readonly<Record<string, string>>;
			readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
			readonly appliedChangeIds: readonly string[];
	  }
	| {
			readonly status: "conflicted";
			readonly files: Readonly<Record<string, string>>;
			readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
			readonly appliedChangeIds: readonly string[];
			readonly conflictReport: SurfacePreviewConflict;
	  };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeJsonObject(
	base: Record<string, unknown>,
	patch: Readonly<Record<string, unknown>>,
	touchedKeys: Set<string>,
	prefix: string,
): { readonly merged: Record<string, unknown>; readonly conflicts: string[] } {
	const merged: Record<string, unknown> = { ...base };
	const conflicts: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		const keyPath = prefix ? `${prefix}.${key}` : key;
		if (isPlainObject(value) && isPlainObject(merged[key])) {
			const nested = mergeJsonObject(merged[key] as Record<string, unknown>, value, touchedKeys, keyPath);
			merged[key] = nested.merged;
			conflicts.push(...nested.conflicts);
		} else {
			if (touchedKeys.has(keyPath)) {
				conflicts.push(keyPath);
			} else {
				touchedKeys.add(keyPath);
			}
			merged[key] = value;
		}
	}
	return { merged, conflicts };
}

// WHY: Composes non-code Studio folder_patch ChangeUnits deterministically in memory for sub-10ms live toggling without git builds.
export function composeStudioPreview(
	baseFiles: Readonly<Record<string, string>>,
	orderedChanges: readonly StudioPatchChange[],
	folderRoot?: string | null,
	baseBinaries: Readonly<Record<string, StudioBinaryRef>> = {},
): StudioPreviewComposition {
	let normalizedRoot: string | null = null;
	let invalidRoot = false;
	if (folderRoot !== undefined && folderRoot !== null && folderRoot.trim().length > 0) {
		try {
			normalizedRoot = normalizeStudioFolderRoot(folderRoot);
		} catch {
			invalidRoot = true;
		}
	}
	const working: Record<string, string> = { ...baseFiles };
	const binaries: Record<string, StudioBinaryRef> = { ...baseBinaries };
	const touchedWholeFiles = new Map<string, string>();
	const touchedJsonKeys = new Map<string, Set<string>>();
	const appliedChangeIds: string[] = [];

	for (const change of orderedChanges) {
		const snapshot: Record<string, string> = { ...working };
		const binarySnapshot: Record<string, StudioBinaryRef> = { ...binaries };
		const conflictPaths: string[] = [];
		const conflictOwners = new Set<string>();

		for (const op of change.ops) {
			let path: string;
			if (invalidRoot) {
				conflictPaths.push(op.path);
				continue;
			}
			if (normalizedRoot) {
				try {
					path = resolveStudioFolderPath(normalizedRoot, op.path);
				} catch {
					conflictPaths.push(op.path);
					continue;
				}
			} else {
				path = op.path;
			}
			if (op.op === "write_text" || op.op === "delete" || op.op === "write_file") {
				const priorOwner = touchedWholeFiles.get(path);
				if (priorOwner && priorOwner !== change.changeId) {
					conflictPaths.push(path);
					conflictOwners.add(priorOwner);
					continue;
				}
				if (touchedJsonKeys.has(path)) {
					conflictPaths.push(path);
					continue;
				}
				touchedWholeFiles.set(path, change.changeId);
				delete working[path];
				delete binaries[path];
				if (op.op === "write_text") working[path] = op.content;
				else if (op.op === "write_file") binaries[path] = op.file;
				continue;
			}

			const wholeOwner = touchedWholeFiles.get(path);
			if (wholeOwner && wholeOwner !== change.changeId) {
				conflictPaths.push(path);
				conflictOwners.add(wholeOwner);
				continue;
			}
			if (Object.hasOwn(binaries, path)) {
				conflictPaths.push(path);
				continue;
			}
			let currentObj: Record<string, unknown> = {};
			if (typeof working[path] === "string") {
				try {
					const parsed: unknown = JSON.parse(working[path] as string);
					if (isPlainObject(parsed)) currentObj = parsed;
				} catch {
					conflictPaths.push(path);
					continue;
				}
			}
			const keysForFile = touchedJsonKeys.get(path) ?? new Set<string>();
			const { merged, conflicts } = mergeJsonObject(currentObj, op.patch, keysForFile, "");
			if (conflicts.length > 0) {
				conflictPaths.push(path);
				continue;
			}
			touchedJsonKeys.set(path, keysForFile);
			working[path] = `${JSON.stringify(merged, null, 2)}\n`;
		}

		if (conflictPaths.length > 0) {
			const conflictIds = [...new Set([...appliedChangeIds, ...conflictOwners, change.changeId])];
			return {
				status: "conflicted",
				files: snapshot,
				binaries: binarySnapshot,
				appliedChangeIds,
				conflictReport: {
					changeIds: conflictIds,
					paths: [...new Set(conflictPaths)],
				},
			};
		}
		appliedChangeIds.push(change.changeId);
	}

	return {
		status: "ready",
		files: working,
		binaries,
		appliedChangeIds,
	};
}
