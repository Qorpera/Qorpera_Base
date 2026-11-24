import {
	composeReconciledFolderChanges,
	mergeJsonThreeWay,
	mergeStudioTextContent,
	normalizeStudioFolderRoot,
	resolveStudioFolderPath,
	type StudioBinaryRef,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfacePreviewConflict,
	type SurfaceReconciliation,
} from "@qorpera/contracts";

export type { StudioBinaryRef, StudioPatchChange, StudioPatchOp };

export type StudioPreviewReconciliation = Pick<
	SurfaceReconciliation,
	"id" | "status" | "selectedChangeIds" | "patchManifest" | "errorDetail"
> & {
	readonly conflictPaths?: readonly string[];
};

export interface ComposeStudioPreviewOptions {
	readonly reconciliations?: readonly StudioPreviewReconciliation[];
}

export type StudioPreviewComposition =
	| {
			readonly status: "ready";
			readonly files: Readonly<Record<string, string>>;
			readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
			readonly appliedChangeIds: readonly string[];
			readonly reconciled?: boolean;
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

function sameChangeIdSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const setA = new Set(a);
	if (setA.size !== b.length) return false;
	for (const id of b) {
		if (!setA.has(id)) return false;
	}
	return true;
}

export function findMatchingStudioReconciliation<T extends StudioPreviewReconciliation>(
	reconciliations: readonly T[] | undefined,
	changeIds: readonly string[],
): T | null {
	if (!reconciliations || reconciliations.length === 0 || changeIds.length === 0) return null;
	const uniqueIds = [...new Set(changeIds)];
	for (const rec of reconciliations) {
		if (sameChangeIdSet(rec.selectedChangeIds, uniqueIds)) return rec;
	}
	return null;
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

function applyJsonPatchUnchecked(
	base: Record<string, unknown>,
	patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		if (value === null) {
			delete merged[key];
		} else if (isPlainObject(value) && isPlainObject(merged[key])) {
			merged[key] = applyJsonPatchUnchecked(merged[key] as Record<string, unknown>, value);
		} else {
			merged[key] = structuredClone(value);
		}
	}
	return merged;
}

function resolveChangeBaseFile(
	change: StudioPatchChange,
	path: string,
	rawPath: string,
	baseFiles: Readonly<Record<string, string>>,
): string | null {
	if (change.baseFiles) {
		if (Object.hasOwn(change.baseFiles, path)) return change.baseFiles[path] ?? null;
		if (Object.hasOwn(change.baseFiles, rawPath)) return change.baseFiles[rawPath] ?? null;
	}
	return Object.hasOwn(baseFiles, path) ? (baseFiles[path] ?? null) : null;
}

function applyReconciledSubset(
	orderedChanges: readonly StudioPatchChange[],
	reconciliations: readonly StudioPreviewReconciliation[] | undefined,
	normalizedRoot: string | null,
): {
	readonly changes: readonly { readonly change: StudioPatchChange; readonly memberIds: readonly string[] }[];
	readonly usedReconciliation: boolean;
} {
	if (!reconciliations || reconciliations.length === 0 || orderedChanges.length === 0) {
		return {
			changes: orderedChanges.map((change) => ({ change, memberIds: [change.changeId] })),
			usedReconciliation: false,
		};
	}
	const activeSet = new Set(orderedChanges.map((change) => change.changeId));
	const readyMatches = reconciliations
		.filter(
			(rec) =>
				rec.status === "ready" &&
				Array.isArray(rec.patchManifest) &&
				rec.patchManifest.length > 0 &&
				rec.selectedChangeIds.length > 0 &&
				rec.selectedChangeIds.every((id) => activeSet.has(id)),
		)
		.sort((a, b) => b.selectedChangeIds.length - a.selectedChangeIds.length);

	for (const chosen of readyMatches) {
		if (!chosen.patchManifest) continue;
		const covered = new Set(chosen.selectedChangeIds);
		let lastCoveredIndex = -1;
		const coveredOrderedChanges: StudioPatchChange[] = [];
		for (let index = 0; index < orderedChanges.length; index += 1) {
			const item = orderedChanges[index]!;
			if (covered.has(item.changeId)) {
				lastCoveredIndex = index;
				coveredOrderedChanges.push(item);
			}
		}
		const composed = composeReconciledFolderChanges(coveredOrderedChanges, chosen.patchManifest, {
			folderRoot: normalizedRoot,
			conflictPaths: chosen.conflictPaths,
		});
		if (!composed.ok) continue;

		const preservedById = new Map(composed.preservedChanges.map((entry) => [entry.changeId, entry]));
		const coveredOrderedIds = coveredOrderedChanges.map((entry) => entry.changeId);
		const out: { readonly change: StudioPatchChange; readonly memberIds: readonly string[] }[] = [];
		for (let index = 0; index < orderedChanges.length; index += 1) {
			const item = orderedChanges[index]!;
			if (covered.has(item.changeId)) {
				const preserved = preservedById.get(item.changeId);
				if (preserved) {
					out.push({ change: preserved, memberIds: [item.changeId] });
				}
				if (index === lastCoveredIndex) {
					out.push({
						change: { changeId: `reconciled:${chosen.id}`, ops: composed.reconciledOps },
						memberIds: coveredOrderedIds,
					});
				}
				continue;
			}
			out.push({ change: item, memberIds: [item.changeId] });
		}
		return { changes: out, usedReconciliation: true };
	}

	return {
		changes: orderedChanges.map((change) => ({ change, memberIds: [change.changeId] })),
		usedReconciliation: false,
	};
}

// WHY: Composes non-code Studio folder_patch ChangeUnits deterministically in memory for sub-10ms live toggling without git builds.
export function composeStudioPreview(
	baseFiles: Readonly<Record<string, string>>,
	orderedChanges: readonly StudioPatchChange[],
	folderRoot?: string | null,
	baseBinaries: Readonly<Record<string, StudioBinaryRef>> = {},
	options?: ComposeStudioPreviewOptions,
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

	const { changes: effectiveChanges, usedReconciliation } = applyReconciledSubset(
		orderedChanges,
		options?.reconciliations,
		normalizedRoot,
	);

	const working: Record<string, string> = { ...baseFiles };
	const binaries: Record<string, StudioBinaryRef> = { ...baseBinaries };
	const touchedWholeFiles = new Map<string, Set<string>>();
	const touchedJsonKeys = new Map<string, Set<string>>();
	const jsonKeyOwners = new Map<string, Set<string>>();
	const appliedChangeIds: string[] = [];

	const addOwners = (map: Map<string, Set<string>>, path: string, ids: readonly string[]) => {
		let set = map.get(path);
		if (!set) {
			set = new Set<string>();
			map.set(path, set);
		}
		for (const id of ids) set.add(id);
	};

	for (const { change, memberIds } of effectiveChanges) {
		const snapshot: Record<string, string> = { ...working };
		const binarySnapshot: Record<string, StudioBinaryRef> = { ...binaries };
		const conflictPaths: string[] = [];
		const conflictOwners = new Set<string>();
		const memberSet = new Set(memberIds);

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

			if (op.op === "write_file") {
				const priorOwners = touchedWholeFiles.get(path);
				const otherWhole = priorOwners ? [...priorOwners].filter((id) => !memberSet.has(id)) : [];
				if (otherWhole.length > 0) {
					conflictPaths.push(path);
					for (const owner of otherWhole) conflictOwners.add(owner);
					continue;
				}
				if (touchedJsonKeys.has(path)) {
					conflictPaths.push(path);
					for (const owner of jsonKeyOwners.get(path) ?? []) conflictOwners.add(owner);
					continue;
				}
				addOwners(touchedWholeFiles, path, memberIds);
				delete working[path];
				binaries[path] = op.file;
				continue;
			}

			if (op.op === "write_text" || op.op === "delete") {
				const priorOwners = touchedWholeFiles.get(path);
				const otherWhole = priorOwners ? [...priorOwners].filter((id) => !memberSet.has(id)) : [];
				const otherJson = jsonKeyOwners.get(path)
					? [...(jsonKeyOwners.get(path) as Set<string>)].filter((id) => !memberSet.has(id))
					: [];
				const baseText = resolveChangeBaseFile(change, path, op.path, baseFiles);
				const hasBinaryNow = Object.hasOwn(binaries, path);
				const currentText = Object.hasOwn(working, path) ? (working[path] ?? null) : null;
				const nextText = op.op === "write_text" ? op.content : null;

				if (otherWhole.length > 0 || otherJson.length > 0) {
					if (hasBinaryNow) {
						conflictPaths.push(path);
						for (const owner of [...otherWhole, ...otherJson]) conflictOwners.add(owner);
						continue;
					}
					const merged = mergeStudioTextContent(path, baseText, currentText, nextText);
					if (!merged.ok) {
						conflictPaths.push(path);
						for (const owner of [...otherWhole, ...otherJson]) conflictOwners.add(owner);
						continue;
					}
					addOwners(touchedWholeFiles, path, memberIds);
					delete binaries[path];
					if (merged.content === null) delete working[path];
					else working[path] = merged.content;
					continue;
				}

				const explicitBaseDiffers =
					change.baseFiles !== undefined &&
					change.baseFiles !== null &&
					(Object.hasOwn(change.baseFiles, path) || Object.hasOwn(change.baseFiles, op.path)) &&
					baseText !== currentText;
				if (explicitBaseDiffers && !hasBinaryNow) {
					const merged = mergeStudioTextContent(path, baseText, currentText, nextText);
					if (!merged.ok) {
						conflictPaths.push(path);
						continue;
					}
					addOwners(touchedWholeFiles, path, memberIds);
					delete binaries[path];
					if (merged.content === null) delete working[path];
					else working[path] = merged.content;
					continue;
				}

				addOwners(touchedWholeFiles, path, memberIds);
				delete working[path];
				delete binaries[path];
				if (op.op === "write_text") working[path] = op.content;
				continue;
			}

			const priorOwners = touchedWholeFiles.get(path);
			const otherWhole = priorOwners ? [...priorOwners].filter((id) => !memberSet.has(id)) : [];
			if (Object.hasOwn(binaries, path)) {
				conflictPaths.push(path);
				for (const owner of otherWhole) conflictOwners.add(owner);
				continue;
			}
			if (otherWhole.length > 0) {
				const baseText = resolveChangeBaseFile(change, path, op.path, baseFiles);
				const currentText = Object.hasOwn(working, path) ? (working[path] ?? null) : null;
				if (baseText !== null && currentText !== null) {
					try {
						const parsedBase: unknown = baseText.trim().length === 0 ? {} : JSON.parse(baseText);
						if (isPlainObject(parsedBase)) {
							const theirsText = `${JSON.stringify(applyJsonPatchUnchecked(parsedBase, op.patch), null, 2)}\n`;
							const merged = mergeJsonThreeWay(baseText, currentText, theirsText);
							if (merged.ok) {
								addOwners(jsonKeyOwners, path, memberIds);
								working[path] = merged.content;
								continue;
							}
						}
					} catch {}
				}
				conflictPaths.push(path);
				for (const owner of otherWhole) conflictOwners.add(owner);
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
				for (const owner of jsonKeyOwners.get(path) ?? []) conflictOwners.add(owner);
				continue;
			}
			touchedJsonKeys.set(path, keysForFile);
			addOwners(jsonKeyOwners, path, memberIds);
			working[path] = `${JSON.stringify(merged, null, 2)}\n`;
		}

		if (conflictPaths.length > 0) {
			const conflictIds = [...new Set([...conflictOwners, ...memberIds])];
			const allInvolved =
				conflictIds.length >= 2 || conflictOwners.size > 0
					? conflictIds
					: [...new Set([...appliedChangeIds, ...memberIds])];
			return {
				status: "conflicted",
				files: snapshot,
				binaries: binarySnapshot,
				appliedChangeIds,
				conflictReport: {
					changeIds: allInvolved,
					paths: [...new Set(conflictPaths)],
				},
			};
		}
		for (const id of memberIds) {
			if (!appliedChangeIds.includes(id)) appliedChangeIds.push(id);
		}
	}

	return {
		status: "ready",
		files: working,
		binaries,
		appliedChangeIds,
		...(usedReconciliation ? { reconciled: true } : {}),
	};
}
