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

export interface LineageChangeDescriptor {
	readonly id: string;
	readonly status?: string;
	readonly affectedPaths: readonly string[];
	readonly previewBaseChangeIds?: readonly string[];
}

export interface LineageReconciliationTarget {
	readonly kind: "chain" | "missing_base";
	readonly changeIds: readonly string[];
	readonly conflictPaths: readonly string[];
}

function normalizeLineagePath(rawPath: string, normalizedRoot: string | null): string {
	const cleaned = rawPath.trim().replace(/^\/+|\/+$/g, "");
	if (!cleaned) return "";
	if (normalizedRoot && cleaned.startsWith(`${normalizedRoot}/`)) {
		return cleaned.slice(normalizedRoot.length + 1);
	}
	return cleaned;
}

export function detectLineageReconciliationTarget(
	allOpenChanges: readonly LineageChangeDescriptor[],
	selectedChangeIds: readonly string[],
	folderRoot?: string | null,
): LineageReconciliationTarget | null {
	if (selectedChangeIds.length === 0 || allOpenChanges.length === 0) return null;
	const normalizedRoot = folderRoot?.trim().replace(/^\/+|\/+$/g, "") || null;
	const selectedSet = new Set(selectedChangeIds);
	const openById = new Map<string, LineageChangeDescriptor>();
	const pathsById = new Map<string, Set<string>>();
	for (const change of allOpenChanges) {
		openById.set(change.id, change);
		const normalized = new Set<string>();
		for (const p of change.affectedPaths) {
			const clean = normalizeLineagePath(p, normalizedRoot);
			if (clean) normalized.add(clean);
		}
		pathsById.set(change.id, normalized);
	}

	const selectedChanges = allOpenChanges.filter((change) => selectedSet.has(change.id));
	if (selectedChanges.length === 0) return null;

	const ancestorCache = new Map<string, Set<string>>();
	const ancestorsOf = (changeId: string): Set<string> => {
		const cached = ancestorCache.get(changeId);
		if (cached) return cached;
		const visited = new Set<string>();
		const stack = [...(openById.get(changeId)?.previewBaseChangeIds ?? [])];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current === changeId || visited.has(current) || !openById.has(current)) continue;
			visited.add(current);
			for (const parent of openById.get(current)?.previewBaseChangeIds ?? []) {
				if (!visited.has(parent)) stack.push(parent);
			}
		}
		ancestorCache.set(changeId, visited);
		return visited;
	};

	const overlapPaths = (aId: string, bId: string): string[] => {
		const a = pathsById.get(aId);
		const b = pathsById.get(bId);
		if (!a || !b || a.size === 0 || b.size === 0) return [];
		const out: string[] = [];
		for (const path of a) {
			if (b.has(path)) out.push(path);
		}
		return out;
	};

	const chainMemberSet = new Set<string>();
	const chainOverlapPaths = new Set<string>();
	for (const modifier of selectedChanges) {
		const modifierAncestors = ancestorsOf(modifier.id);
		for (const base of selectedChanges) {
			if (base.id === modifier.id) continue;
			const shared = overlapPaths(base.id, modifier.id);
			if (shared.length === 0) continue;
			let matchedDependent = false;
			for (const dep of selectedChanges) {
				if (dep.id === base.id || dep.id === modifier.id) continue;
				const depAncestors = ancestorsOf(dep.id);
				if (!depAncestors.has(base.id) || depAncestors.has(modifier.id)) continue;
				if (modifierAncestors.has(dep.id) && overlapPaths(modifier.id, dep.id).length > 0) continue;
				matchedDependent = true;
				chainMemberSet.add(dep.id);
				for (const anc of depAncestors) {
					if (selectedSet.has(anc)) chainMemberSet.add(anc);
				}
			}
			if (matchedDependent) {
				chainMemberSet.add(base.id);
				chainMemberSet.add(modifier.id);
				for (const anc of ancestorsOf(base.id)) {
					if (selectedSet.has(anc)) chainMemberSet.add(anc);
				}
				for (const anc of modifierAncestors) {
					if (selectedSet.has(anc)) chainMemberSet.add(anc);
				}
				for (const path of shared) chainOverlapPaths.add(path);
			}
		}
	}

	if (chainMemberSet.size >= 3) {
		return {
			kind: "chain",
			changeIds: selectedChanges.filter((c) => chainMemberSet.has(c.id)).map((c) => c.id),
			conflictPaths: [...chainOverlapPaths].sort(),
		};
	}

	const missingBaseTargets = new Set<string>();
	const missingBasePaths = new Set<string>();
	for (const change of selectedChanges) {
		const baseIds = change.previewBaseChangeIds ?? [];
		if (baseIds.length === 0) continue;
		const hasMissingOpenBase = baseIds.some((baseId) => openById.has(baseId) && !selectedSet.has(baseId));
		if (!hasMissingOpenBase) continue;
		missingBaseTargets.add(change.id);
		for (const anc of ancestorsOf(change.id)) {
			if (selectedSet.has(anc)) missingBaseTargets.add(anc);
		}
		for (const path of pathsById.get(change.id) ?? []) missingBasePaths.add(path);
	}

	if (missingBaseTargets.size > 0) {
		return {
			kind: "missing_base",
			changeIds: selectedChanges.filter((c) => missingBaseTargets.has(c.id)).map((c) => c.id),
			conflictPaths: [...missingBasePaths].sort(),
		};
	}

	return null;
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
	const previewBasesById = new Map<string, readonly string[]>();
	for (const change of orderedChanges) {
		if (change.previewBaseChangeIds && change.previewBaseChangeIds.length > 0) {
			previewBasesById.set(change.changeId, change.previewBaseChangeIds);
		}
	}
	const readyMatches = reconciliations
		.filter((rec) => {
			if (
				rec.status !== "ready" ||
				!Array.isArray(rec.patchManifest) ||
				rec.patchManifest.length === 0 ||
				rec.selectedChangeIds.length === 0 ||
				!rec.selectedChangeIds.every((id) => activeSet.has(id))
			) {
				return false;
			}
			const coveredSet = new Set(rec.selectedChangeIds);
			for (const id of rec.selectedChangeIds) {
				const bases = previewBasesById.get(id);
				if (bases?.some((baseId) => activeSet.has(baseId) && !coveredSet.has(baseId))) {
					return false;
				}
			}
			return true;
		})
		.sort((a, b) => b.selectedChangeIds.length - a.selectedChangeIds.length);

	const remainingById = new Map<string, StudioPatchChange | null>(
		orderedChanges.map((change) => [change.changeId, change]),
	);
	const claimedReconciledPaths = new Set<string>();
	const reconciledAtIndex = new Map<
		number,
		{
			readonly id: string;
			readonly coveredOrderedIds: readonly string[];
			readonly reconciledOps: readonly StudioPatchOp[];
		}[]
	>();
	let appliedCount = 0;

	const resolvePath = (rawPath: string): string =>
		normalizedRoot ? resolveStudioFolderPath(normalizedRoot, rawPath) : rawPath.trim().replace(/^\/+|\/+$/g, "");

	for (const chosen of readyMatches) {
		if (!chosen.patchManifest) continue;
		const covered = new Set(chosen.selectedChangeIds);
		let lastCoveredIndex = -1;
		const coveredOrderedIds: string[] = [];
		const coveredRemainingChanges: StudioPatchChange[] = [];
		for (let index = 0; index < orderedChanges.length; index += 1) {
			const item = orderedChanges[index]!;
			if (!covered.has(item.changeId)) continue;
			lastCoveredIndex = index;
			coveredOrderedIds.push(item.changeId);
			const remaining = remainingById.get(item.changeId);
			if (remaining) coveredRemainingChanges.push(remaining);
		}
		if (lastCoveredIndex < 0 || coveredRemainingChanges.length === 0) continue;

		const composed = composeReconciledFolderChanges(coveredRemainingChanges, chosen.patchManifest, {
			folderRoot: normalizedRoot,
			conflictPaths: chosen.conflictPaths,
		});
		if (!composed.ok) continue;

		const reconciledPaths = new Set<string>();
		let invalidPath = false;
		for (const op of composed.reconciledOps) {
			try {
				reconciledPaths.add(resolvePath(op.path));
			} catch {
				invalidPath = true;
				break;
			}
		}
		if (invalidPath || [...reconciledPaths].some((path) => claimedReconciledPaths.has(path))) continue;

		const coveredRemainingPaths = new Set<string>();
		for (const change of coveredRemainingChanges) {
			for (const op of change.ops) {
				try {
					coveredRemainingPaths.add(resolvePath(op.path));
				} catch {}
			}
		}
		if (![...reconciledPaths].some((path) => coveredRemainingPaths.has(path))) continue;

		const preservedById = new Map(composed.preservedChanges.map((item) => [item.changeId, item]));
		for (const change of coveredRemainingChanges) {
			remainingById.set(change.changeId, preservedById.get(change.changeId) ?? null);
		}
		for (const path of reconciledPaths) claimedReconciledPaths.add(path);
		const atIndex = reconciledAtIndex.get(lastCoveredIndex) ?? [];
		atIndex.push({
			id: chosen.id,
			coveredOrderedIds,
			reconciledOps: composed.reconciledOps,
		});
		reconciledAtIndex.set(lastCoveredIndex, atIndex);
		appliedCount += 1;
	}

	if (appliedCount > 0) {
		const out: { readonly change: StudioPatchChange; readonly memberIds: readonly string[] }[] = [];
		for (let index = 0; index < orderedChanges.length; index += 1) {
			const item = orderedChanges[index]!;
			const remaining = remainingById.get(item.changeId);
			if (remaining) {
				out.push({ change: remaining, memberIds: [item.changeId] });
			}
			const reconciled = reconciledAtIndex.get(index);
			if (reconciled) {
				for (const entry of reconciled) {
					out.push({
						change: { changeId: `reconciled:${entry.id}`, ops: entry.reconciledOps },
						memberIds: entry.coveredOrderedIds,
					});
				}
			}
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
