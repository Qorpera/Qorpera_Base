// The fold (design RUNTIME-AGENT-MEMORY-TREE.md §5.2, §5.4). A view is a list of parts that tile `[0, T)`, oldest
// first, and is a pure function of `T` and the lines built when it is composed, so no view state is stored anywhere.
// - The fold replays the conversation's growth: each message joins as its level-0 part, and while the parts pass the
//   budget, the pair whose parent is built and that lies furthest from the end, in its own size, merges into it.
//   So a level-`l` line changes about once per `2^l` messages, and a view starts as the last run's did (the cache).
// - A part that is not built shows a placeholder, and counts as one. When merges are blocked by lines not built yet,
//   the view may pass its budget by OVERFLOW; past that, the oldest pairs merge into placeholder parents. Text is
//   never cut.
// The same fold serves a conversation (§5.3), a branch (§5.5) and a run's own earlier steps (§5.7).

import { escapeCloudNativeContextJson } from "../cloud-native-company-context.ts";
import { memoryNodeAddress, OVERFLOW, PLACEHOLDER } from "./tree.ts";

/** One part of a view: `node(l, k)`, with its line, or null while it is not built. */
export interface MemoryTreePart {
	readonly l: number;
	readonly k: number;
	readonly text: string | null;
}

/** A conversation's built lines: `node(l, k)`'s text, or undefined when it is not built. */
export type MemoryTreeBuilt = (l: number, k: number) => string | undefined;

/** A part as a view shows it, `start+size|text`, with a placeholder for a line that is not built. */
export function memoryPartRow(part: MemoryTreePart): string {
	return `${memoryNodeAddress(part.l, part.k)}|${part.text ?? PLACEHOLDER}`;
}

/**
 * What a row costs where it is sent, in UTF-8 bytes: a JSON string escaped as the prompt is, and a separator, as the
 * user message carries a branch's lines. In the developer message a row is escaped and ends in a newline, which costs
 * no more, so one measure bounds both (§5.3, §5.5).
 */
export function memoryRowBytes(row: string): number {
	return Buffer.byteLength(escapeCloudNativeContextJson(JSON.stringify(row))) + 1;
}

/** What a part costs in a view: its row's memoryRowBytes. */
export function memoryPartBytes(part: MemoryTreePart): number {
	return memoryRowBytes(memoryPartRow(part));
}

function part(built: MemoryTreeBuilt, l: number, k: number): MemoryTreePart {
	return { l, k, text: built(l, k) ?? null };
}

/** Whether parts `a` and `b` are the two children of one parent. */
function siblings(a: MemoryTreePart, b: MemoryTreePart): boolean {
	return a.l === b.l && a.k % 2 === 0 && b.k === a.k + 1;
}

interface Link {
	part: MemoryTreePart;
	prev: Link | null;
	next: Link | null;
}

/** Replaces `a` and the part after it with their parent, and returns the parent's link. */
function merge(a: Link, built: MemoryTreeBuilt): Link {
	const b = a.next as Link;
	const merged: Link = { part: part(built, a.part.l + 1, a.part.k / 2), prev: a.prev, next: b.next };
	if (merged.prev) merged.prev.next = merged;
	if (merged.next) merged.next.prev = merged;
	return merged;
}

function parts(first: Link | null): MemoryTreePart[] {
	const out: MemoryTreePart[] = [];
	for (let link = first; link; link = link.next) out.push(link.part);
	return out;
}

/**
 * `fold(T, built, budget)` (§5.2): the parts that tile `[0, T)` within `budget` bytes, or over it when the merges it
 * needs wait for lines not built yet (§5.4). It costs `O(T · levels)`.
 */
export function fold(T: number, built: MemoryTreeBuilt, budget: number): MemoryTreePart[] {
	if (!Number.isSafeInteger(T) || T < 0) throw new Error("A fold covers a whole number of messages");
	// The pairs that can merge now, siblings whose parent is built, by the first part of each, in a queue per level.
	// Within a level the oldest pair is the furthest from the end, and a level's parts appear oldest first, so its pairs
	// become ready and merge in the order of the queue.
	const ready = new Set<Link>();
	const queues: Link[][] = [];
	const heads: number[] = [];
	const check = (link: Link | null) => {
		if (!link || ready.has(link)) return;
		const next = link.next;
		if (!next || !siblings(link.part, next.part) || built(link.part.l + 1, link.part.k / 2) === undefined) return;
		ready.add(link);
		const l = link.part.l;
		if (!queues[l]) {
			queues[l] = [];
			heads[l] = 0;
		}
		queues[l].push(link);
	};
	let first: Link | null = null;
	let last: Link | null = null;
	let size = 0;
	for (let n = 1; n <= T; n += 1) {
		const leaf: Link = { part: part(built, 0, n - 1), prev: last, next: null };
		if (last) last.next = leaf;
		else first = leaf;
		last = leaf;
		size += memoryPartBytes(leaf.part);
		check(leaf.prev);
		while (size > budget && ready.size > 0) {
			// The pair furthest from the end in its own size, `n / 2^l − k`, the oldest first on a tie. Both terms are
			// exact in a double: a division by a power of two and a whole number.
			let best: Link | null = null;
			let distance = Number.NEGATIVE_INFINITY;
			for (let l = 0; l < queues.length; l += 1) {
				const queue = queues[l];
				while (queue && heads[l] < queue.length && !ready.has(queue[heads[l]])) heads[l] += 1;
				if (!queue || heads[l] >= queue.length) continue;
				const link = queue[heads[l]];
				const far = n / 2 ** l - link.part.k;
				if (far > distance || (far === distance && best && link.part.k * 2 ** l < best.part.k * 2 ** best.part.l)) {
					best = link;
					distance = far;
				}
			}
			const a = best as Link;
			const b = a.next as Link;
			const merged = merge(a, built);
			size += memoryPartBytes(merged.part) - memoryPartBytes(a.part) - memoryPartBytes(b.part);
			ready.delete(a);
			ready.delete(b);
			if (first === a) first = merged;
			if (last === b) last = merged;
			check(merged.prev);
			check(merged);
		}
	}
	return parts(first);
}

/**
 * Overflow (§5.4): while the parts pass `limit`, the oldest pair of siblings merges into its parent, a placeholder
 * unless that line is built. Stops when no siblings are left.
 */
export function memoryOverflow(
	view: readonly MemoryTreePart[],
	built: MemoryTreeBuilt,
	limit: number,
): MemoryTreePart[] {
	let size = view.reduce((total, item) => total + memoryPartBytes(item), 0);
	if (size <= limit) return [...view];
	let first: Link | null = null;
	let last: Link | null = null;
	for (const item of view) {
		const link: Link = { part: item, prev: last, next: null };
		if (last) last.next = link;
		else first = link;
		last = link;
	}
	// No siblings lie before the cursor, so after a merge the oldest pair is the parent's, with its part before it or
	// after it, or a later one.
	let cursor = first;
	while (size > limit && cursor) {
		const next = cursor.next;
		if (!next || !siblings(cursor.part, next.part)) {
			cursor = next;
			continue;
		}
		const merged = merge(cursor, built);
		size += memoryPartBytes(merged.part) - memoryPartBytes(cursor.part) - memoryPartBytes(next.part);
		if (first === cursor) first = merged;
		cursor = merged.prev ?? merged;
	}
	return parts(first);
}

/** A view of `[0, T)`: the fold within `budget`, and placeholder parents past `budget × OVERFLOW` (§5.4). */
export function memoryView(T: number, built: MemoryTreeBuilt, budget: number): MemoryTreePart[] {
	return memoryOverflow(fold(T, built, budget), built, Math.floor(budget * OVERFLOW));
}
