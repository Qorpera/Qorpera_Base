import type { CoreReceipt } from "./core.ts";
import { ObjectIntegrityError } from "./objects.ts";
import type { SearchCursor, SearchRequest } from "./protocol.ts";
import { byteOrder, type TreeEntry, type ViewTree } from "./view-tree.ts";

/**
 * A run's search over its own view (F3 `company_search`; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Server-side
 * search"). The founder's "Light threads" decision (2 October 2026) gives a chat turn no shell: an agent searches the
 * company folder here, on its node, with the view its run opened, so a folder shared with only some agents is
 * searched exactly for them.
 *
 * Literal text in the lines of text files, or in the names of files and folders, in the order a machine lists them.
 * One call is one page of the search: it answers when its hits fill the answer, when it has drawn on as many paths as
 * one answer carries, or after about two seconds of work, with where to go on. There is no end the search stops at.
 *
 * Every path an answer drew on is in its `reads`, with its receipt: each folder whose names were looked through and
 * each file whose bytes were read (binary ones too: that they are binary was read from them). The run releases them
 * with the run actor under the hash of the text it shows, before the model sees it.
 */

/** About how long one call works before it answers with where to go on. */
export const SEARCH_SLICE_MS = 2_000;
/** The JSON its hits may take: the run shows them in one tool result of 8 KiB. */
const HITS_BYTES = 6 * 1024;
/** A hit's text: the line around its first match. */
const HIT_CHARS = 200;
/** Paths one answer draws on at most (each read is about 200 bytes of the answer's frame). */
const READS_PER_ANSWER = 4_000;
/** A file with a NUL byte in its first this many bytes is binary: it is not searched. */
const BINARY_PROBE = 8 * 1024;
/** Bytes read from a file at a time, and the most a line may run before it is cut there. */
const PIECE_BYTES = 4 * 1024 * 1024;
const LONGEST_LINE = 1024 * 1024;
/** Files whose first piece is asked for ahead of the one being searched. */
const AHEAD = 8;

export interface SearchHit {
	readonly path: string;
	/** The line's number, from 1; 0 for a name. */
	readonly line: number;
	readonly text: string;
	/** The version searched, and the byte its line starts at (0 for a name): where to go on from this hit, should the
	 * run show only the hits before it. */
	readonly version: string;
	readonly offset: number;
}

export interface SearchRead {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly version: string;
	readonly authority?: CoreReceipt;
}

export interface SearchAnswer {
	readonly hits: readonly SearchHit[];
	/** Files whose text this call searched (in full or from where the last call left them). */
	readonly searched: number;
	/** Binary files passed over. */
	readonly binary: number;
	readonly reads: readonly SearchRead[];
	readonly next: SearchCursor | null;
}

export interface SearchSource {
	readonly tree: ViewTree;
	/** Up to `length` bytes of a file's version from `offset`. */
	read(entry: TreeEntry, offset: number, length: number): Promise<Buffer>;
	readonly now: () => number;
	readonly sliceMs?: number;
	/** Bytes read at a time (tests make it small). */
	readonly pieceBytes?: number;
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

/** A glob as a whole-match pattern: `**` across folders, `*` and `?` within a name, everything else literal. */
export function globPattern(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*" && glob[i + 1] === "*") {
			// `**/` also matches no folder at all.
			if (glob[i + 2] === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "u");
}

/** One page of the search. Throws what reading a file threw, except a file whose bytes fail their check, which is
 * passed over (and not read). */
export async function searchView(source: SearchSource, request: SearchRequest): Promise<SearchAnswer> {
	const deadline = source.now() + (source.sliceMs ?? SEARCH_SLICE_MS);
	const pieceBytes = source.pieceBytes ?? PIECE_BYTES;
	const hits: SearchHit[] = [];
	const reads: SearchRead[] = [];
	let hitBytes = 0;
	let searched = 0;
	let binary = 0;
	const glob = request.glob === null ? undefined : globPattern(request.glob);
	const fold = (text: string): string => (request.caseSensitive ? text : text.toLowerCase());
	const query = fold(request.query);
	const relative = (path: string): string => (request.path === "" ? path : path.slice(request.path.length + 1));
	const matchesGlob = (entry: TreeEntry): boolean => {
		if (!glob) return true;
		const rel =
			entry.path === request.path ? entry.path.slice(entry.path.lastIndexOf("/") + 1) : relative(entry.path);
		return glob.test(request.glob!.includes("/") ? rel : rel.slice(rel.lastIndexOf("/") + 1));
	};
	const read = (entry: TreeEntry): void => {
		if (entry.version === "") return; // the root, or a folder shown only because it holds readable paths
		reads.push({
			path: entry.path,
			kind: entry.kind,
			version: entry.version,
			...(entry.authority === undefined ? {} : { authority: entry.authority }),
		});
	};
	/** Adds a hit, or says the answer is full. */
	const hit = (entry: TreeEntry, line: number, text: string, offset = 0): boolean => {
		const shown = { path: entry.path, line, text, version: entry.version, offset };
		const bytes = Buffer.byteLength(JSON.stringify(shown));
		if (hits.length > 0 && hitBytes + bytes > HITS_BYTES) return false;
		hits.push(shown);
		hitBytes += bytes;
		return true;
	};
	const answer = (next: SearchCursor | null): SearchAnswer => ({ hits, searched, binary, reads, next });
	const at = (entry: TreeEntry, offset = 0, line = 0): SearchCursor => ({
		path: entry.path,
		version: entry.version,
		offset,
		line,
	});

	// The walk, from where the last call left it, with the next files' first pieces asked for ahead.
	const walk = source.tree.walk(request.path);
	const after = request.after;
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
			if (after && treeOrder(entry.path, after.path) < 0) continue;
			ahead.push(entry);
			// Only to warm the node's memory: what this read brings is read again, checked, when its turn comes.
			if (text(entry) && !(after && entry.path === after.path))
				void source.read(entry, 0, pieceBytes).catch(() => undefined);
		}
		return ahead.shift();
	};

	for (let entry = pull(); entry; entry = pull()) {
		if (reads.length >= READS_PER_ANSWER || (source.now() >= deadline && (reads.length > 0 || hits.length > 0)))
			return answer(at(entry));
		if (entry.kind === "folder") {
			// Its names are looked through (to walk it, and for name hits beneath it).
			read(entry);
			if (request.namesOnly && entry.path !== request.path && matchesGlob(entry)) {
				const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
				if (fold(name).includes(query) && !hit(entry, 0, entry.path)) return answer(at(entry));
			}
			continue;
		}
		if (request.namesOnly) {
			const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			if (matchesGlob(entry) && fold(name).includes(query) && !hit(entry, 0, entry.path)) return answer(at(entry));
			continue;
		}
		if (!text(entry)) continue;
		const resume = after && entry.path === after.path && entry.version === after.version ? after : undefined;
		let offset = resume?.offset ?? 0;
		let line = resume?.line ?? 0;
		let carry: Buffer = Buffer.alloc(0);
		let carryStart = offset;
		let started = false;
		let skipped = false;
		for (;;) {
			let piece: Buffer;
			try {
				piece = await source.read(entry, offset, pieceBytes);
			} catch (error) {
				if (error instanceof ObjectIntegrityError) {
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
			// The whole lines in hand; a line longer than LONGEST_LINE is cut there.
			let cut = last ? bytes.byteLength : bytes.lastIndexOf(0x0a) + 1;
			if (cut === 0 && bytes.byteLength >= LONGEST_LINE) cut = bytes.byteLength;
			const lines = bytes.subarray(0, cut);
			carry = bytes.subarray(cut);
			// Most pieces hold no match: those only count their lines.
			if (lines.byteLength > 0 && !fold(lines.toString("utf8")).includes(query)) {
				let newline = lines.indexOf(0x0a);
				while (newline >= 0) {
					line++;
					newline = lines.indexOf(0x0a, newline + 1);
				}
				if (lines[lines.byteLength - 1] !== 0x0a) line++;
			} else {
				let start = 0;
				while (start < lines.byteLength) {
					let stop = lines.indexOf(0x0a, start);
					if (stop < 0) stop = lines.byteLength;
					line++;
					const textLine = lines.subarray(start, stop).toString("utf8");
					const found = fold(textLine).indexOf(query);
					if (found >= 0 && !hit(entry, line, around(textLine, found), carryStart + start))
						return answer(at(entry, carryStart + start, line - 1));
					start = stop + 1;
				}
			}
			carryStart += cut;
			if (last) break;
			offset = end;
			// Out of time, once this piece moved the search on (a line still unfinished is read again next time).
			if (cut > 0 && source.now() >= deadline) return answer(at(entry, carryStart, line));
		}
		if (!skipped) searched++;
	}
	return answer(null);
}

/** A line as a hit shows it: around its first match, at most HIT_CHARS long, control characters as spaces. */
function around(line: string, found: number): string {
	const chars = Array.from(line.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " "));
	if (chars.length <= HIT_CHARS) return chars.join("");
	// `found` counts UTF-16 units; close enough to place the window.
	const start = Math.max(0, Math.min(found - HIT_CHARS / 4, chars.length - HIT_CHARS));
	return `${start > 0 ? "…" : ""}${chars.slice(start, start + HIT_CHARS).join("")}${start + HIT_CHARS < chars.length ? "…" : ""}`;
}
