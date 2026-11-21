import type { SurfacePreviewConflict } from "@qorpera/contracts";

export type StudioPatchOp =
	| { readonly op: "write_text"; readonly path: string; readonly content: string }
	| { readonly op: "delete"; readonly path: string }
	| { readonly op: "merge_json"; readonly path: string; readonly patch: Readonly<Record<string, unknown>> };

export interface StudioPatchChange {
	readonly changeId: string;
	readonly ops: readonly StudioPatchOp[];
}

export type StudioPreviewComposition =
	| {
			readonly status: "ready";
			readonly files: Readonly<Record<string, string>>;
			readonly appliedChangeIds: readonly string[];
	  }
	| {
			readonly status: "conflicted";
			readonly files: Readonly<Record<string, string>>;
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
): StudioPreviewComposition {
	const working: Record<string, string> = { ...baseFiles };
	const touchedWholeFiles = new Map<string, string>();
	const touchedJsonKeys = new Map<string, Set<string>>();
	const appliedChangeIds: string[] = [];

	for (const change of orderedChanges) {
		const snapshot: Record<string, string> = { ...working };
		const conflictPaths: string[] = [];
		const conflictOwners = new Set<string>();

		for (const op of change.ops) {
			if (op.op === "write_text" || op.op === "delete") {
				const priorOwner = touchedWholeFiles.get(op.path);
				if (priorOwner && priorOwner !== change.changeId) {
					conflictPaths.push(op.path);
					conflictOwners.add(priorOwner);
					continue;
				}
				if (touchedJsonKeys.has(op.path)) {
					conflictPaths.push(op.path);
					continue;
				}
				touchedWholeFiles.set(op.path, change.changeId);
				if (op.op === "delete") delete working[op.path];
				else working[op.path] = op.content;
				continue;
			}

			const wholeOwner = touchedWholeFiles.get(op.path);
			if (wholeOwner && wholeOwner !== change.changeId) {
				conflictPaths.push(op.path);
				conflictOwners.add(wholeOwner);
				continue;
			}
			let currentObj: Record<string, unknown> = {};
			if (typeof working[op.path] === "string") {
				try {
					const parsed: unknown = JSON.parse(working[op.path] as string);
					if (isPlainObject(parsed)) currentObj = parsed;
				} catch {
					conflictPaths.push(op.path);
					continue;
				}
			}
			const keysForFile = touchedJsonKeys.get(op.path) ?? new Set<string>();
			const { merged, conflicts } = mergeJsonObject(currentObj, op.patch, keysForFile, "");
			if (conflicts.length > 0) {
				conflictPaths.push(op.path);
				continue;
			}
			touchedJsonKeys.set(op.path, keysForFile);
			working[op.path] = `${JSON.stringify(merged, null, 2)}\n`;
		}

		if (conflictPaths.length > 0) {
			const conflictIds = [...new Set([...appliedChangeIds, ...conflictOwners, change.changeId])];
			return {
				status: "conflicted",
				files: snapshot,
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
		appliedChangeIds,
	};
}
