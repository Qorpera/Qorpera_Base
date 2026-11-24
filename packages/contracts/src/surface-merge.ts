import { normalizeStudioFolderRoot, resolveStudioFolderPath, type StudioPatchOp } from "./surfaces.ts";

const MAX_MYERS_EDIT_DISTANCE = 1024;
const DISALLOWED_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type TextMergeResult = { readonly ok: true; readonly content: string } | { readonly ok: false };

export type StudioTextMergeResult = { readonly ok: true; readonly content: string | null } | { readonly ok: false };

export interface ReconciledFolderChangeInput {
	readonly changeId: string;
	readonly ops: readonly StudioPatchOp[];
	readonly baseFiles?: Readonly<Record<string, string | null>> | null;
}

export type ComposeReconciledFolderChangesResult =
	| {
			readonly ok: true;
			readonly preservedChanges: readonly ReconciledFolderChangeInput[];
			readonly reconciledOps: readonly StudioPatchOp[];
	  }
	| {
			readonly ok: false;
			readonly missingPaths: readonly string[];
	  };

interface LineHunk {
	readonly start: number;
	readonly end: number;
	readonly replacement: readonly string[];
}

function splitLinesPreservingNewlines(text: string): string[] {
	if (text.length === 0) return [];
	return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function diffLineHunks(base: readonly string[], target: readonly string[]): LineHunk[] | null {
	let prefix = 0;
	const minLen = Math.min(base.length, target.length);
	while (prefix < minLen && base[prefix] === target[prefix]) prefix += 1;

	let suffix = 0;
	while (suffix < minLen - prefix && base[base.length - 1 - suffix] === target[target.length - 1 - suffix]) {
		suffix += 1;
	}

	const a = base.slice(prefix, base.length - suffix);
	const b = target.slice(prefix, target.length - suffix);
	const n = a.length;
	const m = b.length;

	if (n === 0 && m === 0) return [];
	if (n === 0) return [{ start: prefix, end: prefix, replacement: b }];
	if (m === 0) return [{ start: prefix, end: prefix + n, replacement: [] }];

	const maxD = Math.min(n + m, MAX_MYERS_EDIT_DISTANCE);
	const offset = maxD;
	const v = new Int32Array(2 * maxD + 1);
	const trace: Int32Array[] = [];

	let foundD = -1;
	for (let d = 0; d <= maxD; d += 1) {
		const snapshot = new Int32Array(2 * d + 1);
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
				x = v[offset + k + 1]!;
			} else {
				x = v[offset + k - 1]! + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			snapshot[k + d] = x;
			if (x >= n && y >= m) {
				foundD = d;
				break;
			}
		}
		trace.push(snapshot);
		if (foundD >= 0) break;
	}

	if (foundD < 0) return null;

	type EditOp = { readonly kind: "eq" } | { readonly kind: "del" } | { readonly kind: "ins"; readonly line: string };
	const reversedOps: EditOp[] = [];
	let x = n;
	let y = m;

	for (let d = foundD; d > 0; d -= 1) {
		const prev = trace[d - 1]!;
		const prevOffset = d - 1;
		const k = x - y;
		const goDown = k === -d || (k !== d && prev[prevOffset + k - 1]! < prev[prevOffset + k + 1]!);
		const prevK = goDown ? k + 1 : k - 1;
		const prevX = prev[prevOffset + prevK]!;
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			reversedOps.push({ kind: "eq" });
			x -= 1;
			y -= 1;
		}
		if (goDown) {
			reversedOps.push({ kind: "ins", line: b[prevY]! });
			y = prevY;
		} else {
			reversedOps.push({ kind: "del" });
			x = prevX;
		}
	}
	while (x > 0 && y > 0) {
		reversedOps.push({ kind: "eq" });
		x -= 1;
		y -= 1;
	}

	const hunks: LineHunk[] = [];
	let baseIndex = prefix;
	let hunkStart: number | null = null;
	let hunkEnd = prefix;
	let replacement: string[] = [];

	const flush = () => {
		if (hunkStart === null) return;
		hunks.push({ start: hunkStart, end: hunkEnd, replacement });
		hunkStart = null;
		replacement = [];
	};

	for (let index = reversedOps.length - 1; index >= 0; index -= 1) {
		const op = reversedOps[index]!;
		if (op.kind === "eq") {
			flush();
			baseIndex += 1;
		} else if (op.kind === "del") {
			if (hunkStart === null) hunkStart = baseIndex;
			baseIndex += 1;
			hunkEnd = baseIndex;
		} else {
			if (hunkStart === null) {
				hunkStart = baseIndex;
				hunkEnd = baseIndex;
			}
			replacement.push(op.line);
		}
	}
	flush();
	return hunks;
}

export function mergeTextThreeWay(base: string, ours: string, theirs: string): TextMergeResult {
	if (ours === theirs) return { ok: true, content: ours };
	if (ours === base) return { ok: true, content: theirs };
	if (theirs === base) return { ok: true, content: ours };

	const baseLines = splitLinesPreservingNewlines(base);
	const oursHunks = diffLineHunks(baseLines, splitLinesPreservingNewlines(ours));
	const theirsHunks = diffLineHunks(baseLines, splitLinesPreservingNewlines(theirs));
	if (!oursHunks || !theirsHunks) return { ok: false };

	const out: string[] = [];
	let cursor = 0;
	let i = 0;
	let j = 0;

	const emitHunk = (hunk: LineHunk) => {
		for (let k = cursor; k < hunk.start; k += 1) out.push(baseLines[k]!);
		for (const line of hunk.replacement) out.push(line);
		cursor = hunk.end;
	};

	while (i < oursHunks.length || j < theirsHunks.length) {
		if (i >= oursHunks.length) {
			emitHunk(theirsHunks[j]!);
			j += 1;
			continue;
		}
		if (j >= theirsHunks.length) {
			emitHunk(oursHunks[i]!);
			i += 1;
			continue;
		}
		const oh = oursHunks[i]!;
		const th = theirsHunks[j]!;
		if (oh.start === th.start && oh.end === th.end && sameStringArray(oh.replacement, th.replacement)) {
			emitHunk(oh);
			i += 1;
			j += 1;
			continue;
		}
		if (oh.end < th.start || (oh.end === th.start && oh.start < oh.end && th.start < th.end)) {
			emitHunk(oh);
			i += 1;
			continue;
		}
		if (th.end < oh.start || (th.end === oh.start && th.start < th.end && oh.start < oh.end)) {
			emitHunk(th);
			j += 1;
			continue;
		}
		return { ok: false };
	}

	for (let k = cursor; k < baseLines.length; k += 1) out.push(baseLines[k]!);
	return { ok: true, content: out.join("") };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== typeof b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (!jsonDeepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (typeof a === "object") {
		const recA = a as Record<string, unknown>;
		const recB = b as Record<string, unknown>;
		const keysA = Object.keys(recA);
		const keysB = Object.keys(recB);
		if (keysA.length !== keysB.length) return false;
		for (const key of keysA) {
			if (!Object.hasOwn(recB, key) || !jsonDeepEqual(recA[key], recB[key])) return false;
		}
		return true;
	}
	return false;
}

function mergeJsonRecordThreeWay(
	base: Record<string, unknown>,
	ours: Record<string, unknown>,
	theirs: Record<string, unknown>,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
	const merged: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
	for (const key of keys) {
		if (DISALLOWED_JSON_KEYS.has(key)) return { ok: false };
		const hasB = Object.hasOwn(base, key);
		const hasO = Object.hasOwn(ours, key);
		const hasT = Object.hasOwn(theirs, key);
		const bVal = hasB ? base[key] : undefined;
		const oVal = hasO ? ours[key] : undefined;
		const tVal = hasT ? theirs[key] : undefined;

		if (hasO === hasT && jsonDeepEqual(oVal, tVal)) {
			if (hasO) merged[key] = structuredClone(oVal);
			continue;
		}
		if (hasO === hasB && jsonDeepEqual(oVal, bVal)) {
			if (hasT) merged[key] = structuredClone(tVal);
			continue;
		}
		if (hasT === hasB && jsonDeepEqual(tVal, bVal)) {
			if (hasO) merged[key] = structuredClone(oVal);
			continue;
		}
		if (hasO && hasT && isPlainRecord(oVal) && isPlainRecord(tVal)) {
			const nested = mergeJsonRecordThreeWay(hasB && isPlainRecord(bVal) ? bVal : {}, oVal, tVal);
			if (!nested.ok) return { ok: false };
			merged[key] = nested.value;
			continue;
		}
		return { ok: false };
	}
	return { ok: true, value: merged };
}

function hasUnsafeOrNonCanonicalJsonNumber(text: string): boolean {
	let i = 0;
	const len = text.length;
	while (i < len) {
		const ch = text[i]!;
		if (ch === '"') {
			i += 1;
			while (i < len) {
				const c = text[i]!;
				if (c === "\\") {
					i += 2;
					continue;
				}
				i += 1;
				if (c === '"') break;
			}
			continue;
		}
		if (ch === "-" || (ch >= "0" && ch <= "9")) {
			const start = i;
			if (ch === "-") i += 1;
			while (i < len && text[i]! >= "0" && text[i]! <= "9") i += 1;
			let isFloat = false;
			if (i < len && text[i] === ".") {
				isFloat = true;
				i += 1;
				while (i < len && text[i]! >= "0" && text[i]! <= "9") i += 1;
			}
			if (i < len && (text[i] === "e" || text[i] === "E")) {
				isFloat = true;
				i += 1;
				if (i < len && (text[i] === "+" || text[i] === "-")) i += 1;
				while (i < len && text[i]! >= "0" && text[i]! <= "9") i += 1;
			}
			const raw = text.slice(start, i);
			if (!isFloat) {
				try {
					const bi = BigInt(raw);
					if (bi < MIN_SAFE_BIGINT || bi > MAX_SAFE_BIGINT) return true;
				} catch {
					return true;
				}
			}
			const num = Number(raw);
			if (!Number.isFinite(num) || JSON.stringify(num) !== raw) return true;
			continue;
		}
		i += 1;
	}
	return false;
}

export function mergeJsonThreeWay(base: string, ours: string, theirs: string): TextMergeResult {
	const lineMerged = mergeTextThreeWay(base, ours, theirs);
	if (lineMerged.ok) {
		try {
			const parsed: unknown = JSON.parse(lineMerged.content);
			if (isPlainRecord(parsed)) return lineMerged;
		} catch {}
	}
	if (
		hasUnsafeOrNonCanonicalJsonNumber(base) ||
		hasUnsafeOrNonCanonicalJsonNumber(ours) ||
		hasUnsafeOrNonCanonicalJsonNumber(theirs)
	) {
		return { ok: false };
	}
	let baseParsed: unknown;
	let oursParsed: unknown;
	let theirsParsed: unknown;
	try {
		baseParsed = base.trim().length === 0 ? {} : JSON.parse(base);
		oursParsed = JSON.parse(ours);
		theirsParsed = JSON.parse(theirs);
	} catch {
		return { ok: false };
	}
	if (!isPlainRecord(baseParsed) || !isPlainRecord(oursParsed) || !isPlainRecord(theirsParsed)) {
		return { ok: false };
	}
	const merged = mergeJsonRecordThreeWay(baseParsed, oursParsed, theirsParsed);
	if (!merged.ok) return { ok: false };
	return { ok: true, content: `${JSON.stringify(merged.value, null, 2)}\n` };
}

export function mergeStudioTextContent(
	path: string,
	base: string | null,
	ours: string | null,
	theirs: string | null,
): StudioTextMergeResult {
	if (ours === theirs) return { ok: true, content: ours };
	if (ours === base) return { ok: true, content: theirs };
	if (theirs === base) return { ok: true, content: ours };
	if (base === null || ours === null || theirs === null) return { ok: false };
	if (path.toLowerCase().endsWith(".json")) {
		const lineMerged = mergeTextThreeWay(base, ours, theirs);
		if (lineMerged.ok) {
			try {
				JSON.parse(lineMerged.content);
				return lineMerged;
			} catch {}
		}
		const jsonMerged = mergeJsonThreeWay(base, ours, theirs);
		if (jsonMerged.ok) return jsonMerged;
		return { ok: false };
	}
	return mergeTextThreeWay(base, ours, theirs);
}

function normalizeReconcilePath(rawPath: string, normalizedRoot: string | null): string {
	const cleaned = rawPath.trim().replace(/^\/+|\/+$/g, "");
	if (!cleaned) return "";
	if (normalizedRoot) {
		try {
			return resolveStudioFolderPath(normalizedRoot, cleaned);
		} catch {
			return cleaned;
		}
	}
	return cleaned;
}

export function composeReconciledFolderChanges(
	coveredChanges: readonly ReconciledFolderChangeInput[],
	reconciledOps: readonly StudioPatchOp[],
	options?: {
		readonly folderRoot?: string | null;
		readonly conflictPaths?: readonly string[] | null;
	},
): ComposeReconciledFolderChangesResult {
	let normalizedRoot: string | null = null;
	if (options?.folderRoot && options.folderRoot.trim().length > 0) {
		try {
			normalizedRoot = normalizeStudioFolderRoot(options.folderRoot);
		} catch {
			normalizedRoot = null;
		}
	}

	const reconciledPaths = new Set<string>();
	for (const op of reconciledOps) {
		const path = normalizeReconcilePath(op.path, normalizedRoot);
		if (path) reconciledPaths.add(path);
	}

	const explicitConflictPaths = [
		...new Set(
			(options?.conflictPaths ?? [])
				.map((path) => normalizeReconcilePath(path, normalizedRoot))
				.filter((path) => path.length > 0),
		),
	];

	let requiredPaths: string[];
	if (explicitConflictPaths.length > 0) {
		requiredPaths = explicitConflictPaths;
	} else {
		const pathTouchCount = new Map<string, number>();
		for (const change of coveredChanges) {
			const seenInChange = new Set<string>();
			for (const op of change.ops) {
				const path = normalizeReconcilePath(op.path, normalizedRoot);
				if (!path || seenInChange.has(path)) continue;
				seenInChange.add(path);
				pathTouchCount.set(path, (pathTouchCount.get(path) ?? 0) + 1);
			}
		}
		const overlapping = [...pathTouchCount.entries()].filter(([, count]) => count >= 2).map(([path]) => path);
		requiredPaths = overlapping.length > 0 ? overlapping : [...pathTouchCount.keys()];
	}

	if (reconciledOps.length === 0) {
		return { ok: false, missingPaths: requiredPaths };
	}

	const missingPaths = requiredPaths.filter((path) => !reconciledPaths.has(path));
	if (missingPaths.length > 0) {
		return { ok: false, missingPaths };
	}

	const preservedChanges: ReconciledFolderChangeInput[] = [];
	for (const change of coveredChanges) {
		const keptOps = change.ops.filter((op) => !reconciledPaths.has(normalizeReconcilePath(op.path, normalizedRoot)));
		if (keptOps.length === 0) continue;
		preservedChanges.push({
			changeId: change.changeId,
			ops: keptOps,
			...(change.baseFiles !== undefined ? { baseFiles: change.baseFiles } : {}),
		});
	}

	return {
		ok: true,
		preservedChanges,
		reconciledOps,
	};
}
