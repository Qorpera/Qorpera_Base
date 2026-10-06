// A conversation's summary tree (design RUNTIME-AGENT-MEMORY-TREE.md §4, M1b). `node(l, k)` covers messages
// `[k·2^l, (k+1)·2^l)` and is shown as `start+size`. Its line is stored in block `t<l/4>/<8 digits>.jsonl` under the
// tree root, one JSON object per line, which M1a's SQL checks (`qorpera_memory_block_line`,
// `qorpera_memory_block_parse` in 20260930111000_memory_tree_files.sql). The rules here mirror those checks, so a
// line the runtime builds is one the commit accepts.
// - A line's text has its control characters turned into spaces and is stored as UTF-8, not `\u`-escaped: only `"`
//   and `\` take two bytes, so a text of at most NODE bytes stores within 2 × NODE, under LINE_BYTES.
// - A free node needs no model call: a rendered event of at most NODE bytes, or two children joined by a space within
//   NODE. Every other line is the compactor's (§7).

/** Target size of one line in bytes (§5.1). */
export const NODE = 512;
/** The run's own conversation in the view (§5.1). */
export const VIEW = 96_000;
/** All branches together (§5.5). */
export const BRANCHES = 24_000;
/** The least a branch gets (§5.5). */
export const BRANCH_MIN = 600;
/** The view may pass VIEW by this much while lines are missing (§5.4). */
export const OVERFLOW = 1.25;
/** Attempts to bring a compactor line under NODE (§7.2). */
export const TRIES = 3;
/** The most a line's text takes as stored in its block, JSON escaping included (§4.2). */
export const LINE_BYTES = 2_048;
/** What a line that is not built yet shows (§5.4). */
export const PLACEHOLDER = "(not summarized yet: zoom it)";

/** One stored line of a block (§4.2). Level-0 lines carry their event's transcript `seq` and `event_hash`. */
export interface MemoryTreeLine {
	readonly l: number;
	readonly k: number;
	readonly seq?: number;
	readonly hash?: string;
	readonly free: boolean;
	/** Only on a compactor line: how many attempts it took (1 to TRIES). */
	readonly tries?: number;
	readonly text: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const HASH = /^[0-9a-f]{64}$/;

/**
 * A text as a line stores it: every control character, newlines included, as a space (§4.1). A lone surrogate, which
 * is not UTF-8, becomes U+FFFD.
 */
export function memoryLineText(text: string): string {
	return text.replace(LONE_SURROGATE, "\ufffd").replace(CONTROL, " ");
}

/** The bytes a line's text takes in its block: UTF-8, with `"` and `\` escaped (§4.2). */
export function memoryLineStoredBytes(text: string): number {
	let escaped = 0;
	for (const character of text) if (character === '"' || character === "\\") escaped += 1;
	return Buffer.byteLength(text) + escaped;
}

/** `node(l, k)`'s address as the view shows it: `start+size`. */
export function memoryNodeAddress(l: number, k: number): string {
	const size = 2 ** l;
	return `${k * size}+${size}`;
}

/** The block that holds `node(l, k)`, relative to the tree root: tier `l/4`, block `k >> (4t + 4 − l)` (§4.2). */
export function memoryBlockPath(l: number, k: number): string {
	const tier = Math.floor(l / 4);
	const block = Math.floor(k / 2 ** (4 * tier + 4 - l));
	return `t${tier}/${String(block).padStart(8, "0")}.jsonl`;
}

/** A level-0 node with no model call: the rendered event when it is at most NODE bytes (§4.1). */
export function memoryFreeLeaf(rendered: string): string | null {
	return Buffer.byteLength(rendered) <= NODE ? memoryLineText(rendered) : null;
}

/** A node above level 0 with no model call: its children joined by a space, when that is at most NODE bytes. */
export function memoryFreeParent(a: string, b: string): string | null {
	const joined = `${a} ${b}`;
	return Buffer.byteLength(joined) <= NODE ? joined : null;
}

function wholeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Why a line could not be stored, or null when M1a's checks accept it. */
export function memoryLineProblem(line: MemoryTreeLine): string | null {
	if (!wholeNumber(line.l) || line.l > 59) return "l is a level from 0 to 59";
	if (!wholeNumber(line.k)) return "k is a whole number";
	if (line.l === 0 && (!wholeNumber(line.seq) || typeof line.hash !== "string" || !HASH.test(line.hash)))
		return "a level-0 line names its event's seq and hash";
	if (line.l > 0 && (line.seq !== undefined || line.hash !== undefined)) return "only a level-0 line names an event";
	if (line.free ? line.tries !== undefined : !(wholeNumber(line.tries) && line.tries >= 1 && line.tries <= TRIES))
		return "tries is 1 to 3 exactly when the line is not free";
	if (line.text !== memoryLineText(line.text)) return "a line's text has no control characters";
	if (memoryLineStoredBytes(line.text) > LINE_BYTES) return "a line's text is at most 2,048 bytes as stored";
	return null;
}

/** One line as its block stores it, keys in the order §4.2 shows. */
export function memoryLineJson(line: MemoryTreeLine): string {
	const problem = memoryLineProblem(line);
	if (problem) throw new Error(`Invalid memory tree line ${memoryNodeAddress(line.l, line.k)}: ${problem}`);
	return JSON.stringify({
		l: line.l,
		k: line.k,
		...(line.l === 0 ? { seq: line.seq, hash: line.hash } : {}),
		free: line.free,
		text: line.text,
		...(line.free ? {} : { tries: line.tries }),
	});
}

/**
 * A block's text: its lines ordered by `(l, k)`, one per line, each ending in a newline. They must all belong to one
 * block, with no address twice.
 */
export function memoryBlockText(lines: readonly MemoryTreeLine[]): string {
	if (lines.length < 1 || lines.length > 30) throw new Error("A memory tree block holds 1 to 30 lines");
	const path = memoryBlockPath(lines[0].l, lines[0].k);
	const sorted = [...lines].sort((a, b) => a.l - b.l || a.k - b.k);
	for (const [index, line] of sorted.entries()) {
		if (memoryBlockPath(line.l, line.k) !== path) throw new Error("Memory tree lines from two blocks");
		if (index > 0 && sorted[index - 1].l === line.l && sorted[index - 1].k === line.k)
			throw new Error("A memory tree block holds each line once");
	}
	return sorted.map((line) => `${memoryLineJson(line)}\n`).join("");
}
