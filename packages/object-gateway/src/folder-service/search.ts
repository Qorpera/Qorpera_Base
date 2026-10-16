import { setImmediate as nextTurn } from "node:timers/promises";
import type { CoreReceipt } from "./core.ts";
import { ObjectIntegrityError, ObjectMissingError } from "./objects.ts";
import type { SearchCursor, SearchRequest } from "./protocol.ts";
import { byteOrder, type TreeEntry, type ViewTree } from "./view-tree.ts";

/**
 * A run's search over its own view (F3 `company_search`; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Server-side
 * search"). The founder's "Light threads" decision (2 October 2026) gives a chat turn no shell: an agent searches the
 * company folder here, on its node, with the view its run opened, so a folder shared with only some agents is
 * searched exactly for them.
 *
 * Literal text in the lines of text files, or in the names of files, folders and links, in the order a machine lists
 * them. A link is found by its name only, never by its target, and never walked through (protocol 4; below it the
 * search leaves links out).
 * One call is one page of the search: it answers when its hits fill the answer, when it has drawn on as many paths as
 * one answer carries, or after about two seconds of work, with where to go on. There is no end the search stops at.
 * The node's event loop serves every machine on the node, so a page gives it a turn every few milliseconds, and no
 * step of a page (a glob, a line) costs more than linear time.
 *
 * Every path an answer drew on is in its `reads`, with its receipt: each folder whose names were looked through, each
 * file whose bytes were read (binary ones too: that they are binary was read from them), and each entry whose name is
 * a hit. A folder shown only because it holds readable paths (no version of its own) is never a name hit. The run
 * releases them with the run actor under the hash of the text it shows, before the model sees it. `next` names a path
 * the page did not draw on: a client never shows it (the run seals it).
 */

/** About how long one call works before it answers with where to go on. */
export const SEARCH_SLICE_MS = 2_000;
/** How long a page works before it gives the node's event loop a turn. */
const TURN_MS = 10;
/** The JSON its hits may take: the run shows them in one tool result of 8 KiB. */
const HITS_BYTES = 6 * 1024;
/** A hit's text: the line around its first match. */
const HIT_CHARS = 200;
/** Paths one answer draws on at most, by count and by their encoded size: the answer always fits one frame (2 MiB),
 * however long the paths. */
const READS_PER_ANSWER = 4_000;
const READS_BYTES = 1024 * 1024;
/** A file with a NUL byte in its first this many bytes is binary: it is not searched. */
const BINARY_PROBE = 8 * 1024;
/** Bytes read from a file at a time. A line longer than LONGEST_LINE is searched as it comes, a stretch at a time,
 * keeping the query's length of its end so a match across two stretches is found; its number stays one line. */
const PIECE_BYTES = 4 * 1024 * 1024;
const LONGEST_LINE = 1024 * 1024;
/** Files whose first piece is asked for ahead of the one being searched. */
const AHEAD = 8;

export interface SearchHit {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	/** The line's number, from 1; 0 for a name. */
	readonly line: number;
	/** The line around its match; empty for a name (the path is the hit). */
	readonly text: string;
	/** The version searched, and the byte its line starts at (0 for a name): where to go on from this hit, should the
	 * run show only the hits before it. */
	readonly version: string;
	readonly offset: number;
	/** A link's target, as written (a name hit on a link). */
	readonly target?: string;
}

export interface SearchRead {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	readonly version: string;
	readonly authority?: CoreReceipt;
}

export interface SearchAnswer {
	readonly hits: readonly SearchHit[];
	/** Files whose text this call searched (in full or from where the last call left them). */
	readonly searched: number;
	/** Binary files passed over. */
	readonly binary: number;
	/** Files passed over because their bytes are missing from the storage server or fail their check (logged). */
	readonly unreadable: number;
	readonly reads: readonly SearchRead[];
	readonly next: SearchCursor | null;
}

export interface SearchSource {
	readonly tree: ViewTree;
	/** Links are found (protocol 4); otherwise they are left out. */
	readonly links?: boolean;
	/** Up to `length` bytes of a file's version from `offset`. */
	read(entry: TreeEntry, offset: number, length: number): Promise<Buffer>;
	readonly now: () => number;
	/** Throws once the view may no longer be served (closed, or past its confirmed lease): checked at every turn. */
	readonly serving?: () => void;
	readonly log?: (line: string) => void;
	readonly sliceMs?: number;
	/** Bytes read at a time, and the length past which a line is searched in stretches (tests make them small). */
	readonly pieceBytes?: number;
	readonly longestLine?: number;
}

/** Depth-first order of two paths: name by name, a folder before what it holds. */
export function treeOrder(a: string, b: string): number {
	const x = a.split("/");
	const y = b.split("/");
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const order = byteOrder(x[i]!, y[i]!);
		if (order !== 0) return order;
	}
	return x.length - y.length;
}

/** A compiled glob: its '/'-separated parts, each a name pattern (code points) or `**` (any number of folders). A
 * glob without '/' is matched against a path's name alone. */
export interface Glob {
	readonly parts: readonly (readonly string[] | "**")[];
	readonly nameOnly: boolean;
}

export function compileGlob(glob: string): Glob {
	return {
		parts: glob.split("/").map((part) => (part === "**" ? "**" : Array.from(part))),
		nameOnly: !glob.includes("/"),
	};
}

/** One name against one pattern: `*` any run of characters (a `**` inside a name is the same), `?` any one, the rest
 * literal. The two-pointer walk with one place to go back to: at most name × pattern steps, never exponential. */
function nameMatches(pattern: readonly string[], name: readonly string[]): boolean {
	let p = 0;
	let n = 0;
	let star = -1;
	let mark = 0;
	while (n < name.length) {
		if (p < pattern.length && pattern[p] !== "*" && (pattern[p] === "?" || pattern[p] === name[n])) {
			p++;
			n++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			mark = n;
		} else if (star >= 0) {
			p = star + 1;
			n = ++mark;
		} else return false;
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}

/** A path (relative to the search) against a glob: the same walk over the path's names, `**` standing for any run of
 * them. */
export function globMatches(glob: Glob, path: string): boolean {
	const names = path.split("/");
	if (glob.nameOnly) return nameMatches(glob.parts[0] as readonly string[], Array.from(names[names.length - 1]!));
	let p = 0;
	let n = 0;
	let star = -1;
	let mark = 0;
	while (n < names.length) {
		const part = glob.parts[p];
		if (part !== undefined && part !== "**" && nameMatches(part, Array.from(names[n]!))) {
			p++;
			n++;
		} else if (part === "**") {
			star = p++;
			mark = n;
		} else if (star >= 0) {
			p = star + 1;
			n = ++mark;
		} else return false;
	}
	while (p < glob.parts.length && glob.parts[p] === "**") p++;
	return p === glob.parts.length;
}

/** One page of the search. Throws what reading a file threw, except a file whose bytes are missing or fail their
 * check, which is passed over (not read) and logged. */
export async function searchView(source: SearchSource, request: SearchRequest): Promise<SearchAnswer> {
	const deadline = source.now() + (source.sliceMs ?? SEARCH_SLICE_MS);
	const pieceBytes = source.pieceBytes ?? PIECE_BYTES;
	const longestLine = source.longestLine ?? LONGEST_LINE;
	const hits: SearchHit[] = [];
	const reads: SearchRead[] = [];
	let hitBytes = 0;
	let readBytes = 0;
	let searched = 0;
	let binary = 0;
	let unreadable = 0;
	let examined = 0;
	let turnAt = performance.now();
	/** Gives the event loop a turn once this page has worked TURN_MS, and stops if the view may no longer be served. */
	const turn = async (): Promise<void> => {
		if (performance.now() - turnAt < TURN_MS) return;
		await nextTurn();
		turnAt = performance.now();
		source.serving?.();
	};
	const glob = request.glob === null ? undefined : compileGlob(request.glob);
	const fold = (text: string): string => (request.caseSensitive ? text : text.toLowerCase());
	const query = fold(request.query);
	/** Bytes of the query's longest UTF-8 form, kept of a long line's end so a match across two stretches is found. */
	const overlap = Buffer.byteLength(request.query) * 3 + 4;
	const matchesGlob = (entry: TreeEntry): boolean => {
		if (!glob) return true;
		if (entry.path === request.path) return globMatches(glob, entry.path.slice(entry.path.lastIndexOf("/") + 1));
		return globMatches(glob, request.path === "" ? entry.path : entry.path.slice(request.path.length + 1));
	};
	const read = (entry: TreeEntry): void => {
		if (entry.version === "") return; // the root, or a folder shown only because it holds readable paths
		const drawn: SearchRead = {
			path: entry.path,
			kind: entry.kind,
			version: entry.version,
			...(entry.authority === undefined ? {} : { authority: entry.authority }),
		};
		reads.push(drawn);
		readBytes += Buffer.byteLength(JSON.stringify(drawn));
	};
	/** Adds a hit, or says the answer is full. */
	const hit = (entry: TreeEntry, line: number, text: string, offset = 0): boolean => {
		const shown: SearchHit = {
			path: entry.path,
			kind: entry.kind,
			line,
			text,
			version: entry.version,
			offset,
			...(entry.kind === "symlink" ? { target: entry.target } : {}),
		};
		const bytes = Buffer.byteLength(JSON.stringify(shown));
		if (hits.length > 0 && hitBytes + bytes > HITS_BYTES) return false;
		hits.push(shown);
		hitBytes += bytes;
		return true;
	};
	/** A page, only while the view may still be served: a view that closed, or whose lease lapsed, while the page's last
	 * read was awaited gets no hits. */
	const answer = (next: SearchCursor | null): SearchAnswer => {
		source.serving?.();
		return { hits, searched, binary, unreadable, reads, next };
	};
	const at = (entry: TreeEntry, offset = 0, line = 0): SearchCursor => ({
		path: entry.path,
		version: entry.version,
		offset,
		line,
	});

	// The walk, from where the last call left it (straight there, not past what came before), with the next files'
	// first pieces asked for ahead.
	const after = request.after;
	const walk = source.tree.walk(request.path, after?.path);
	const ahead: TreeEntry[] = [];
	let exhausted = false;
	const text = (entry: TreeEntry): boolean =>
		!request.namesOnly && entry.kind === "file" && entry.bytes > 0 && matchesGlob(entry);
	const pull = (): TreeEntry | undefined => {
		while (!exhausted && ahead.length <= AHEAD) {
			const next = walk.next();
			if (next.done) {
				exhausted = true;
				break;
			}
			const entry = next.value;
			ahead.push(entry);
			// Only to warm the node's memory: what this read brings is read again, checked, when its turn comes.
			if (text(entry) && !(after && entry.path === after.path))
				void source.read(entry, 0, pieceBytes).catch(() => undefined);
		}
		return ahead.shift();
	};

	for (let entry = pull(); entry; entry = pull()) {
		await turn();
		// A link below protocol 4 is not there: never drawn on, nor where a page goes on from.
		if (entry.kind === "symlink" && !source.links) continue;
		// A page ends once it has moved the search on: never before its first entry.
		if (examined > 0 && (reads.length >= READS_PER_ANSWER || readBytes >= READS_BYTES || source.now() >= deadline))
			return answer(at(entry));
		examined++;
		if (entry.kind === "folder") {
			// Its names are looked through (to walk it, and for name hits beneath it).
			read(entry);
			// A folder with a version of its own is a name hit (its read is the one above).
			if (request.namesOnly && entry.path !== request.path && entry.version !== "" && matchesGlob(entry)) {
				const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
				if (fold(name).includes(query) && !hit(entry, 0, "")) return answer(at(entry));
			}
			continue;
		}
		if (request.namesOnly) {
			const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			if (matchesGlob(entry) && fold(name).includes(query)) {
				if (!hit(entry, 0, "")) return answer(at(entry));
				// The name is shown: the entry is read.
				read(entry);
			}
			continue;
		}
		if (!text(entry)) continue;
		const resume = after && entry.path === after.path && entry.version === after.version ? after : undefined;
		/** The next byte to read; the number of whole lines before the line in hand, and where that line starts. */
		let offset = resume?.offset ?? 0;
		let line = resume?.line ?? 0;
		let lineStart = offset;
		/** The line in hand: its bytes not yet searched (all of it, or for a long line the stretch's end kept for a
		 * match across stretches), and whether it is long (searched in stretches) or already has its hit. */
		let carry: Buffer = Buffer.alloc(0);
		let long = false;
		let lineHit = false;
		let started = false;
		let skipped = false;
		/** Searches a stretch of the line in hand; false when the answer is full (the page ends at this line). */
		const stretch = (bytes: Buffer): boolean => {
			if (lineHit || bytes.byteLength === 0) return true;
			const textLine = bytes.toString("utf8");
			const found = fold(textLine).indexOf(query);
			if (found < 0) return true;
			lineHit = true;
			return hit(entry, line + 1, around(textLine, found, request.caseSensitive), lineStart);
		};
		for (;;) {
			let piece: Buffer;
			try {
				piece = await source.read(entry, offset, pieceBytes);
				// The view may have closed, or its lease lapsed, while the read was awaited.
				source.serving?.();
			} catch (error) {
				if (error instanceof ObjectIntegrityError || error instanceof ObjectMissingError) {
					source.log?.(`folder-service: search passed over ${entry.path} (${entry.version}): ${error.message}`);
					unreadable++;
					skipped = true;
					break;
				}
				throw error;
			}
			if (!started) {
				started = true;
				read(entry);
				if (offset === 0 && piece.subarray(0, BINARY_PROBE).includes(0)) {
					binary++;
					skipped = true;
					break;
				}
			}
			const end = offset + piece.byteLength;
			const last = end >= entry.bytes || piece.byteLength === 0;
			const bytes = carry.byteLength === 0 ? piece : Buffer.concat([carry, piece]);
			// `bytes` starts `carry` bytes before `offset`; its whole lines end at its last newline.
			const base = offset - carry.byteLength;
			const cut = bytes.lastIndexOf(0x0a) + 1;
			// Most stretches hold no match: those only count their lines.
			const whole = bytes.subarray(0, cut);
			if (cut > 0 && !lineHit && !long && !fold(whole.toString("utf8")).includes(query)) {
				let newline = whole.indexOf(0x0a);
				while (newline >= 0) {
					line++;
					newline = whole.indexOf(0x0a, newline + 1);
				}
				lineStart = base + cut;
			} else {
				let start = 0;
				for (let stop = bytes.indexOf(0x0a); stop >= 0 && stop < cut; stop = bytes.indexOf(0x0a, start)) {
					if (!stretch(bytes.subarray(start, stop))) return answer(at(entry, lineStart, line));
					line++;
					lineStart = base + stop + 1;
					long = false;
					lineHit = false;
					start = stop + 1;
				}
			}
			const rest = bytes.subarray(cut);
			if (last) {
				// The last line, with no newline after it.
				if (rest.byteLength > 0) {
					if (!stretch(rest)) return answer(at(entry, lineStart, line));
					line++;
				}
				break;
			}
			if (rest.byteLength >= longestLine) {
				// A long line: searched as it comes up to its last whole character, keeping its end (with a character
				// the piece cut in two) for a match across stretches.
				const whole = wholeUtf8(rest);
				if (!stretch(rest.subarray(0, whole))) return answer(at(entry, lineStart, line));
				long = true;
				let keep = Math.max(0, whole - overlap);
				while (keep < whole && (rest[keep]! & 0xc0) === 0x80) keep++;
				carry = rest.subarray(keep);
			} else carry = rest;
			offset = end;
			await turn();
			// Out of time, between lines only: a long line in hand is finished first, so no hit is shown twice.
			if (!long && cut > 0 && source.now() >= deadline) return answer(at(entry, lineStart, line));
		}
		if (!skipped) searched++;
	}
	return answer(null);
}

/** The length of `bytes` up to the end of its last whole UTF-8 character: a character cut at the end is left out. */
function wholeUtf8(bytes: Buffer): number {
	let start = bytes.byteLength;
	while (start > 0 && bytes.byteLength - start < 3 && (bytes[start - 1]! & 0xc0) === 0x80) start--;
	if (start === 0) return bytes.byteLength;
	const lead = bytes[start - 1]!;
	const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return bytes.byteLength - (start - 1) >= size ? bytes.byteLength : start - 1;
}

/** A line as a hit shows it: around its first match, at most HIT_CHARS long, control characters as spaces. `found` is
 * the match's index in the folded line, placed back on the line's own characters. */
function around(line: string, found: number, caseSensitive: boolean): string {
	const chars = Array.from(line.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " "));
	if (chars.length <= HIT_CHARS) return chars.join("");
	let at = 0;
	for (let folded = 0; at < chars.length && folded < found; at++)
		folded += caseSensitive ? chars[at]!.length : chars[at]!.toLowerCase().length;
	const start = Math.max(0, Math.min(at - HIT_CHARS / 4, chars.length - HIT_CHARS));
	return `${start > 0 ? "…" : ""}${chars.slice(start, start + HIT_CHARS).join("")}${start + HIT_CHARS < chars.length ? "…" : ""}`;
}
