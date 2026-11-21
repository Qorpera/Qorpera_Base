import { isAscii } from "node:buffer";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { CoreReceipt } from "./core.ts";
import { ObjectIntegrityError, ObjectMissingError } from "./objects.ts";
import type { SearchCursor, SearchRequest } from "./protocol.ts";
import { compilePattern, foldText } from "./regex.ts";
import { byteOrder, type TreeEntry, type ViewTree } from "./view-tree.ts";

/**
 * A run's search over its own view (F3 `company_search`; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Server-side
 * search"). The founder's "Light threads" decision (2 October 2026) gives a chat turn no shell: an agent searches the
 * company folder here, on its node, with the view its run opened, so a folder shared with only some agents is
 * searched exactly for them.
 *
 * Text (or, version 2, a regular expression: regex.ts) in the lines of text files, or in the names of files, folders
 * and links, in the order a machine lists them; version 2 also finds names by glob alone, counts each file's matching
 * lines instead of showing them (`filesOnly`), and shows lines around each hit (`context`). A link is found by its name
 * only, never by its target, and never walked through (protocol 4; below it the search leaves links out).
 * One call is one page of the search: it answers when its hits fill the answer, when it has drawn on as many paths as
 * one answer carries, or after about two seconds of work, with where to go on. There is no end the search stops at.
 * The node's event loop serves every machine on the node, so a page gives it a turn every few milliseconds, and no
 * step of a page (a glob, a line, a regular expression) costs more than linear time.
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
/** The JSON a version 1 page's hits may take: its runtime showed them in one tool result of 8 KiB. */
const HITS_BYTES = 6 * 1024;
/** What a version 2 page's hits may show, measured as the run shows them (each line's path, number and text, context
 * lines too; each file's path and count): about one tool result of 32 KiB, less its envelope and escaping. */
export const SHOWN_BYTES = 26 * 1024;
/** A hit's text, and a context line's: the line around its first match, or a context line's start. */
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
/** A regular expression reads smaller pieces: V8's linear engine runs a piece in one step, about 20 ms a MiB. It sees
 * whole lines only, so it never judges `$`, `^` or `\b` at a stretch's end: a line of more than LONGEST_LINE bytes (its
 * newline not counted) is not searched by it, however the pieces fall, and the page counts such lines (`longLines`),
 * so the run says so. */
const REGEX_PIECE_BYTES = 256 * 1024;
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
	/** Version 2 with `context`: the lines just before the hit (none shown before, none another hit's), and those just
	 * after it up to the next hit, each cut to its first 200 characters; `from` is the byte the first line before starts
	 * at, where to go on from to show this hit with them. */
	readonly before?: readonly string[];
	readonly after?: readonly string[];
	readonly from?: number;
}

/** Version 2 with `filesOnly`: a file with a match, and how many of its lines match, from where this page began in it;
 * `partial`: the page ended inside the file, and the next page counts on from there. A page that began inside a file
 * gives it an entry at its end even with no match there (count 0), so the run can close the count it carried. */
export interface SearchFile {
	readonly path: string;
	readonly version: string;
	readonly count: number;
	readonly partial?: true;
}

export interface SearchRead {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	readonly version: string;
	readonly authority?: CoreReceipt;
}

export interface SearchAnswer {
	readonly hits: readonly SearchHit[];
	/** Version 2 only: the files a `filesOnly` page counted (empty otherwise). */
	readonly files?: readonly SearchFile[];
	/** Files whose text this call searched (in full or from where the last call left them). */
	readonly searched: number;
	/** Binary files passed over. */
	readonly binary: number;
	/** Files passed over because their bytes are missing from the storage server or fail their check (logged). */
	readonly unreadable: number;
	/** Version 2 only: lines over LONGEST_LINE a regular expression did not search (REGEX_PIECE_BYTES). */
	readonly longLines?: number;
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

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const SURROGATE = /[\uD800-\uDFFF]/;

function isAsciiString(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
	return true;
}

/** Depth-first order of two paths: name by name, a folder before what it holds. */
export function treeOrder(a: string, b: string): number {
	if (a === b) return 0;
	let ai = 0;
	let bi = 0;
	for (;;) {
		const aSlash = a.indexOf("/", ai);
		const bSlash = b.indexOf("/", bi);
		const aEnd = aSlash < 0 ? a.length : aSlash;
		const bEnd = bSlash < 0 ? b.length : bSlash;
		const order = byteOrder(a.slice(ai, aEnd), b.slice(bi, bEnd));
		if (order !== 0) return order;
		if (aSlash < 0 || bSlash < 0) return aSlash < 0 ? (bSlash < 0 ? 0 : -1) : 1;
		ai = aSlash + 1;
		bi = bSlash + 1;
	}
}

/** A compiled glob: its '/'-separated parts, each a name pattern (code points) or `**` (any number of folders). A
 * glob without '/' is matched against a path's name alone. */
export interface Glob {
	readonly parts: readonly (readonly string[] | "**")[];
	readonly nameOnly: boolean;
	readonly simpleName?:
		| { readonly kind: "exact"; readonly value: string }
		| { readonly kind: "affix"; readonly prefix: string; readonly suffix: string };
}

export function compileGlob(glob: string): Glob {
	const nameOnly = !glob.includes("/");
	let simpleName: Glob["simpleName"];
	if (nameOnly && !glob.includes("?") && !SURROGATE.test(glob)) {
		const firstStar = glob.indexOf("*");
		if (firstStar < 0) {
			simpleName = { kind: "exact", value: glob };
		} else {
			let starEnd = firstStar;
			while (starEnd < glob.length && glob[starEnd] === "*") starEnd++;
			if (glob.indexOf("*", starEnd) < 0) {
				simpleName = { kind: "affix", prefix: glob.slice(0, firstStar), suffix: glob.slice(starEnd) };
			}
		}
	}
	return {
		parts: glob.split("/").map((part) => (part === "**" ? "**" : Array.from(part))),
		nameOnly,
		...(simpleName === undefined ? {} : { simpleName }),
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
	if (glob.nameOnly) {
		const slash = path.lastIndexOf("/");
		const name = slash < 0 ? path : path.slice(slash + 1);
		if (glob.simpleName) {
			if (glob.simpleName.kind === "exact") return name === glob.simpleName.value;
			const { prefix, suffix } = glob.simpleName;
			return name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix);
		}
		return nameMatches(glob.parts[0] as readonly string[], Array.from(name));
	}
	const names = path.split("/");
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

/** What a hit shows, as the run lays it out (`path:line: text`, a context line `path-line- text`, a name as its path,
 * a link as `path -> "target"`, a file as `path: count`), in bytes: the measure of a version 2 page. */
function shownLine(path: string, line: number, text: string): number {
	return Buffer.byteLength(path) + String(line).length + Buffer.byteLength(text) + 4;
}

/** A line of a file in hand, as a context line shows it: its first HIT_CHARS characters, control characters as
 * spaces. */
function contextText(bytes: Buffer): string {
	const chars = Array.from(
		bytes
			.subarray(0, wholeUtf8(bytes.subarray(0, HIT_CHARS * 4 + 4)))
			.toString("utf8")
			.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " "),
	);
	return chars.length <= HIT_CHARS ? chars.join("") : `${chars.slice(0, HIT_CHARS).join("")}…`;
}

/** A line not yet shown, kept as context for the next hit: its text and the byte it starts at. */
interface ContextLine {
	readonly text: string;
	readonly start: number;
}

/** One page of the search. Throws what reading a file threw, except a file whose bytes are missing or fail their
 * check, which is passed over (not read) and logged; a pattern that is not one this search runs is a
 * SearchPatternError (regex.ts). */
export async function searchView(source: SearchSource, request: SearchRequest): Promise<SearchAnswer> {
	// Version 1 has none of version 2's parts, whatever else the request holds.
	const v2 = request.version === 2;
	const regex = v2 && request.regex;
	const filesOnly = v2 && request.filesOnly;
	const context = v2 ? request.context : 0;
	const deadline = source.now() + (source.sliceMs ?? SEARCH_SLICE_MS);
	const pieceBytes = source.pieceBytes ?? (regex ? REGEX_PIECE_BYTES : PIECE_BYTES);
	const longestLine = source.longestLine ?? LONGEST_LINE;
	const hits: SearchHit[] = [];
	const files: SearchFile[] = [];
	const reads: SearchRead[] = [];
	let hitBytes = 0;
	let readBytes = 0;
	let searched = 0;
	let binary = 0;
	let unreadable = 0;
	let longLines = 0;
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
	const fold = (text: string): string => (request.caseSensitive ? text : foldText(text));
	/** Where the first match in folded text starts, or -1; a find (no query) matches every name. */
	const query = request.query;
	let find: (folded: string) => number = () => 0;
	if (query !== null && regex) {
		const pattern = compilePattern(query, request.caseSensitive);
		find = (folded) => pattern.exec(folded)?.index ?? -1;
	} else if (query !== null) {
		const folded = fold(query);
		find = (text) => text.indexOf(folded);
	}
	// WHY: skip decoding/lowercasing non-matching 4 MiB chunks under --jitless via native Buffer.indexOf or pure-literal ASCII /i regex.
	const queryBytes =
		!regex &&
		request.caseSensitive &&
		query !== null &&
		query.length > 0 &&
		!query.includes("\uFFFD") &&
		!SURROGATE.test(query)
			? Buffer.from(query, "utf8")
			: undefined;
	const asciiCaseInsensitive =
		!regex && !request.caseSensitive && query !== null && query.length > 0 && isAsciiString(query)
			? new RegExp(query.replace(REGEX_META, "\\$&"), "i")
			: undefined;
	const chunkHasMatch = (chunk: Buffer): boolean => {
		if (queryBytes !== undefined) return chunk.indexOf(queryBytes) >= 0;
		if (asciiCaseInsensitive !== undefined && isAscii(chunk))
			return asciiCaseInsensitive.test(chunk.toString("latin1"));
		return find(fold(chunk.toString("utf8"))) >= 0;
	};
	/** Bytes of a long line's end kept for a match across two stretches: the query's longest UTF-8 form (a regular
	 * expression searches no long line). */
	const overlap = Buffer.byteLength(query ?? "") * 3 + 4;
	const budget = v2 ? SHOWN_BYTES : HITS_BYTES;
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
	const hit = (shown: SearchHit): boolean => {
		const bytes = v2
			? shown.line === 0
				? Buffer.byteLength(shown.path) +
					(shown.target === undefined ? 2 : Buffer.byteLength(JSON.stringify(shown.target)) + 6)
				: shownLine(shown.path, shown.line, shown.text) +
					// With context, its lines before, and a `--` between hits whose lines do not join.
					(shown.before === undefined
						? 0
						: shown.before.reduce((sum, text) => sum + shownLine(shown.path, shown.line, text), 3))
			: Buffer.byteLength(JSON.stringify(shown));
		if (hits.length > 0 && hitBytes + bytes > budget) return false;
		hits.push(shown);
		hitBytes += bytes;
		return true;
	};
	const nameHit = (entry: TreeEntry): boolean =>
		hit({
			path: entry.path,
			kind: entry.kind,
			line: 0,
			text: "",
			version: entry.version,
			offset: 0,
			...(entry.kind === "symlink" ? { target: entry.target } : {}),
		});
	const nameFound = (entry: TreeEntry, globMatched: boolean): boolean =>
		globMatched && find(fold(entry.path.slice(entry.path.lastIndexOf("/") + 1))) >= 0;
	/** A page, only while the view may still be served: a view that closed, or whose lease lapsed, while the page's last
	 * read was awaited gets no hits. */
	const answer = (next: SearchCursor | null): SearchAnswer => {
		source.serving?.();
		return v2
			? { hits, files, searched, binary, unreadable, longLines, reads, next }
			: { hits, searched, binary, unreadable, reads, next };
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
	const ahead: { readonly entry: TreeEntry; readonly globMatched: boolean; readonly isText: boolean }[] = [];
	let exhausted = false;
	const pull = () => {
		while (!exhausted && ahead.length <= AHEAD) {
			const next = walk.next();
			if (next.done) {
				exhausted = true;
				break;
			}
			const entry = next.value;
			const globMatched = matchesGlob(entry);
			const isText = !request.namesOnly && entry.kind === "file" && entry.bytes > 0 && globMatched;
			ahead.push({ entry, globMatched, isText });
			// Only to warm the node's memory: what this read brings is read again, checked, when its turn comes.
			if (isText && !(after && entry.path === after.path))
				void source.read(entry, 0, pieceBytes).catch(() => undefined);
		}
		return ahead.shift();
	};

	for (let item = pull(); item; item = pull()) {
		const { entry, globMatched, isText } = item;
		await turn();
		// A link below protocol 4 is not there: never drawn on, nor where a page goes on from.
		if (entry.kind === "symlink" && !source.links) continue;
		// A page ends once it has moved the search on: never before its first entry. A files-only page ends before a
		// file whose line it might not have room for.
		if (
			examined > 0 &&
			(reads.length >= READS_PER_ANSWER ||
				readBytes >= READS_BYTES ||
				source.now() >= deadline ||
				(filesOnly && isText && hitBytes + shownLine(entry.path, 0, "") + 8 > budget))
		)
			return answer(at(entry));
		examined++;
		if (entry.kind === "folder") {
			// Its names are looked through (to walk it, and for name hits beneath it).
			read(entry);
			// A folder with a version of its own is a name hit (its read is the one above).
			if (request.namesOnly && entry.path !== request.path && entry.version !== "" && nameFound(entry, globMatched))
				if (!nameHit(entry)) return answer(at(entry));
			continue;
		}
		if (request.namesOnly) {
			if (nameFound(entry, globMatched)) {
				if (!nameHit(entry)) return answer(at(entry));
				// The name is shown: the entry is read.
				read(entry);
			}
			continue;
		}
		if (!isText) continue;
		const resume = after && entry.path === after.path && entry.version === after.version ? after : undefined;
		/** The next byte to read; the number of whole lines before the line in hand, and where that line starts. */
		let offset = resume?.offset ?? 0;
		let line = resume?.line ?? 0;
		let lineStart = offset;
		/** Where a page that ends inside this file must go on from to have moved the search on: past the byte it began
		 * at in it, when the file is the page's first entry. A page out of time goes on reading until it may stop there
		 * with the lines before the next hit kept (`here`). */
		const floor = examined === 1 ? offset : -1;
		/** Files only: the page began inside this file, so its count goes on one a page before it gave. */
		const continued = resume !== undefined && (resume.offset > 0 || resume.line > 0);
		/** The line in hand: its bytes not yet searched (all of it, or for a long line the stretch's end kept for a
		 * match across stretches), and whether it is long (searched in stretches) or already has its hit. */
		let carry: Buffer = Buffer.alloc(0);
		let long = false;
		let lineHit = false;
		/** The line in hand is too long for a regular expression: read to its end, not searched (and counted). */
		let unsearched = false;
		/** A pattern's line, whole in hand: one longer than LONGEST_LINE is not searched. */
		const tooLong = (lineBytes: Buffer): void => {
			if (!regex || unsearched || lineBytes.byteLength <= longestLine) return;
			unsearched = true;
			longLines++;
		};
		/** A long line's start, as a context line shows it. */
		let head = "";
		let started = false;
		let skipped = false;
		/** Files only: lines with a match, from where this page began in the file. */
		let count = 0;
		/** Context: the lines not yet shown just before the line in hand (at most `context`), and the last hit while it
		 * still takes lines after it. */
		let ring: ContextLine[] = [];
		let open: { readonly path: string; readonly after: string[] } | undefined;
		let wanted = 0;
		/** Where to go on from to search the line in hand with the lines before it a hit would show: never at or before
		 * the floor (a page that ends at a hit has a hit before it, after which those lines start). */
		const here = (): SearchCursor => {
			const first = ring[0];
			return first ? at(entry, first.start, line - ring.length) : at(entry, lineStart, line);
		};
		/** A page that ends inside the file: a files-only page says what it counted so far. */
		const cut = (cursor: SearchCursor): SearchAnswer => {
			if (count > 0) files.push({ path: entry.path, version: entry.version, count, partial: true });
			return answer(cursor);
		};
		/** A line of the file ended that is not a hit: a line after the last hit, or one to show before the next. */
		const ended = (textOf: () => string): void => {
			if (context === 0) return;
			if (open && wanted > 0) {
				const shown = textOf();
				open.after.push(shown);
				hitBytes += shownLine(open.path, line + 1, shown);
				wanted--;
				return;
			}
			ring.push({ text: textOf(), start: lineStart });
			if (ring.length > context) ring.shift();
		};
		/** Searches a stretch of the line in hand; false when the answer is full (the page ends at this line). */
		const stretch = (bytes: Buffer): boolean => {
			// An empty line holds no text, but a pattern may match it (`^$`).
			if (lineHit || unsearched || (bytes.byteLength === 0 && !regex)) return true;
			const textLine = bytes.toString("utf8");
			const found = find(fold(textLine));
			if (found < 0) return true;
			lineHit = true;
			if (filesOnly) {
				count++;
				return true;
			}
			const shown: SearchHit = {
				path: entry.path,
				kind: entry.kind,
				line: line + 1,
				text: around(textLine, found, request.caseSensitive),
				version: entry.version,
				offset: lineStart,
				...(context > 0
					? { before: ring.map((r) => r.text), after: [] as string[], from: ring[0]?.start ?? lineStart }
					: {}),
			};
			if (!hit(shown)) return false;
			if (context > 0) {
				ring = [];
				open = { path: entry.path, after: shown.after as string[] };
				wanted = context;
			}
			return true;
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
			const cutAt = bytes.lastIndexOf(0x0a) + 1;
			// Most stretches hold no match: those only count their lines (and keep their last lines as context).
			const whole = bytes.subarray(0, cutAt);
			if (cutAt > 0 && !lineHit && !long && wanted === 0 && !chunkHasMatch(whole)) {
				// A pattern's line too long to search is counted here too, though nothing in it matched.
				let from = 0;
				for (let newline = whole.indexOf(0x0a); newline >= 0; newline = whole.indexOf(0x0a, from)) {
					if (regex && newline - from > longestLine) longLines++;
					line++;
					from = newline + 1;
				}
				if (context > 0) {
					const tail: ContextLine[] = [];
					for (let stop = cutAt - 1; tail.length < context && stop >= 0; ) {
						const begin = stop === 0 ? 0 : whole.lastIndexOf(0x0a, stop - 1) + 1;
						tail.unshift({ text: contextText(whole.subarray(begin, stop)), start: base + begin });
						stop = begin - 1;
					}
					ring = [...ring, ...tail].slice(-context);
				}
				lineStart = base + cutAt;
			} else {
				let start = 0;
				for (let stop = bytes.indexOf(0x0a); stop >= 0 && stop < cutAt; stop = bytes.indexOf(0x0a, start)) {
					const lineBytes = bytes.subarray(start, stop);
					tooLong(lineBytes);
					if (!stretch(lineBytes)) return cut(here());
					if (!lineHit) ended(() => (long ? head : contextText(lineBytes)));
					line++;
					lineStart = base + stop + 1;
					long = false;
					lineHit = false;
					unsearched = false;
					start = stop + 1;
					// Many lines with a match in one stretch (a count, or context) take their turns too.
					if (performance.now() - turnAt >= TURN_MS) await turn();
				}
			}
			const rest = bytes.subarray(cutAt);
			if (last) {
				// The last line, with no newline after it.
				if (rest.byteLength > 0) {
					tooLong(rest);
					if (!stretch(rest)) return cut(here());
					if (!lineHit) ended(() => (long ? head : contextText(rest)));
					line++;
				}
				break;
			}
			// A long line, with no newline yet: for text more than LONGEST_LINE - 1 bytes of it, for a pattern more than
			// LONGEST_LINE (it is then too long, whatever follows).
			if (rest.byteLength >= longestLine + (regex ? 1 : 0)) {
				// Searched as it comes up to its last whole character, keeping its end (with a character the piece cut in
				// two) for a match across stretches; a pattern's, read to its end unsearched.
				const whole = wholeUtf8(rest);
				if (!long && context > 0) head = contextText(rest.subarray(0, whole));
				long = true;
				if (regex) {
					tooLong(rest);
					carry = Buffer.alloc(0);
				} else {
					if (!stretch(rest.subarray(0, whole))) return cut(here());
					let keep = Math.max(0, whole - overlap);
					while (keep < whole && (rest[keep]! & 0xc0) === 0x80) keep++;
					carry = rest.subarray(keep);
				}
			} else carry = rest;
			offset = end;
			await turn();
			// Out of time, between lines only: a long line in hand is finished first, so no hit is shown twice, and so are
			// the lines after the last hit; and only once going on from the lines before the next hit moves the search on.
			if (!long && cutAt > 0 && wanted === 0 && (ring[0]?.start ?? lineStart) > floor && source.now() >= deadline)
				return cut(here());
		}
		if (count > 0 || (filesOnly && continued && !skipped)) {
			files.push({ path: entry.path, version: entry.version, count });
			hitBytes += shownLine(entry.path, count, "");
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
