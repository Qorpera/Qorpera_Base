const MAX_MYERS_EDIT_DISTANCE = 1024;
const DISALLOWED_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type TextMergeResult = { readonly ok: true; readonly content: string } | { readonly ok: false };

export type StudioTextMergeResult = { readonly ok: true; readonly content: string | null } | { readonly ok: false };

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

export function mergeJsonThreeWay(base: string, ours: string, theirs: string): TextMergeResult {
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
		const jsonMerged = mergeJsonThreeWay(base, ours, theirs);
		if (jsonMerged.ok) return jsonMerged;
	}
	return mergeTextThreeWay(base, ours, theirs);
}
