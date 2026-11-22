import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { isUuid, type JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderAuthority,
	type CloudCompanyFolderClient,
	CloudCompanyFolderError,
	type CloudCompanyFolderRelease,
	type CloudCompanyFolderRunView,
} from "./cloud-company-folder-client.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

/**
 * `company_search` (F3; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Server-side search"). The founder's "Light
 * threads" decision (2 October 2026) gives a chat turn no shell: the agent searches the company folder on its node's
 * folder service, with the view its run opened, so a folder shared with only some agents is searched exactly for them.
 *
 * The native host opens the run's view once (`qorpera_folder_run_view_open`) and keeps one connection to the node
 * through its slot's relay socket for the run; the node lists the view once and keeps it current. Each call asks the
 * node for pages of the search, one after another, until it has about a result's worth to show, the search ends, or
 * about 10 s passed, and gives a cursor to go on when there is more (keyholes S4). Before the model sees the answer,
 * everything it drew on (each folder looked through, each file read) is released with the run actor under the hash of
 * the exact text shown, and the answer cites the release.
 *
 * The node says in its hello's answer which search it speaks (`search`): version 2 (keyholes S4) takes a regular
 * expression, context lines, files only and a find by glob alone, and answers larger pages; a node that says nothing
 * speaks version 1, and is asked only what version 1 takes.
 */

/** The node's folder protocol (packages/object-gateway/src/folder-service/protocol.ts): a u32 big-endian length of
 * the type byte and the payload, the type byte, then JSON. At 4 the node finds links by name, with their targets
 * (deploy/first-node/RUNTIME-FOLDER-LINKS.md). */
const PROTOCOL = 4;
const KIND = { hello: 0x48, helloOk: 0x68, search: 0x53, found: 0x73, error: 0x65 } as const;
const MAX_PAYLOAD = 2 * 1024 * 1024;
/** How long the node may take to answer a hello (it lists the whole view the first time, which a large folder takes a
 * while for, and throws away if the caller leaves) and a page (about 2 s of work, after any wait for its turn on the
 * node). The end of the run's tool session cuts either short. */
const HELLO_MS = 600_000;
const PAGE_MS = 60_000;
/** One call asks for at most this many pages, and none once this long has passed since it began or once what it has
 * shows this many bytes (a page of a version 2 node shows about 26 KiB, of a version 1 node about 4 KiB). */
const CALL_PAGES = 6;
const CALL_MS = 10_000;
const CALL_FILL = 20 * 1024;
/** Codes the node answers one request with, leaving the connection usable. */
const REQUEST_ERRORS = ["NOT_FOUND", "BAD_REQUEST", "UNAVAILABLE", "DENIED"];
/** What the core records in one release; more reads go in several, all with the answer's hash. */
const MAX_RELEASED = 10_000;
/** A read whose receipt the node did not have: the core checks such a path again at release. */
const NO_RECEIPT: CloudCompanyFolderAuthority = {
	resourceId: "00000000-0000-0000-0000-000000000000",
	resourceRevision: 0,
	grantId: null,
	grantRevision: null,
};
const MAX_QUERY = 256;
/** Lines of context around a hit, at most (the node's MAX_SEARCH_CONTEXT). */
const MAX_CONTEXT = 5;
/** A link's target, in UTF-8 bytes (the core's limit). */
const MAX_TARGET = 4095;

/** Where a search goes on (the node's `SearchCursor`). */
interface SearchCursor {
	readonly path: string;
	readonly version: string;
	readonly offset: number;
	readonly line: number;
}

/** What the node's hello said of its search; version 1 when it said nothing. */
interface SearchSupport {
	readonly version: number;
	readonly regex: boolean;
}

/** A search as the tool asks it; shaped for the node's version when sent. */
interface SearchAsk {
	readonly query: string | null;
	readonly regex: boolean;
	readonly path: string;
	readonly glob: string | null;
	readonly namesOnly: boolean;
	readonly filesOnly: boolean;
	readonly caseSensitive: boolean;
	readonly context: number;
	readonly after: SearchCursor | null;
}

interface SearchHit {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	readonly line: number;
	readonly text: string;
	readonly version: string;
	readonly offset: number;
	/** A link's target, as written (a link is found by its name only). */
	readonly target?: string;
	/** Context (version 2): the lines just before and after the hit, and the byte the first line before starts at. */
	readonly before?: readonly string[];
	readonly after?: readonly string[];
	readonly from?: number;
}

/** A file a files-only search counted: its matching lines, from where its page began in it; `partial` when the
 * count goes on in the next page. A page that began inside the file ends its count, 0 when nothing more matched. */
interface SearchFile {
	readonly path: string;
	readonly version: string;
	readonly count: number;
	readonly partial?: true;
}

interface SearchPage {
	readonly hits: readonly SearchHit[];
	readonly files?: readonly SearchFile[];
	readonly searched: number;
	readonly binary: number;
	/** Lines over 1 MiB a regular expression did not search. */
	readonly longLines?: number;
	readonly reads: readonly CloudCompanyFolderRelease[];
	readonly next: SearchCursor | null;
	/** The runtime's, never the node's: files an earlier answer showed part of that this one could not go on in. */
	readonly restarted?: readonly SearchRestart[];
}

/** A file an earlier answer ended inside, that the search could not go on in at the version that answer showed: it
 * changed meanwhile (the node searched its new version from its start), or it is not there to search any more (gone,
 * emptied, or no longer the run's to read). */
interface SearchRestart {
	readonly path: string;
	/** The node read another version of it. */
	readonly changed: boolean;
}

interface Frame {
	readonly kind: number;
	readonly body: Record<string, unknown>;
}

/** The node answered with one of its error codes; `detail` is its own message when it is one of the search's coded
 * ones (`REGEX_…: …`, `SEARCH_…: …`), which say what to change. */
class FolderLinkError extends Error {
	readonly code: string;
	readonly detail: string | undefined;
	constructor(code: string, message: string, detail?: string) {
		super(message);
		this.name = "FolderLinkError";
		this.code = code;
		this.detail = detail;
	}
}

/** One connection to the node's folder service, through the slot's relay; any fault ends it. */
class FolderLink {
	readonly #socket: Socket;
	readonly #chunks: Buffer[] = [];
	#head = 0;
	#offset = 0;
	#bufferedBytes = 0;
	readonly #frames: Frame[] = [];
	#waiting: ((frame: Frame | undefined) => void) | undefined;
	#closed = false;
	/** Which search the node speaks, from its hello's answer. */
	search: SearchSupport = { version: 1, regex: false };

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (data: Buffer) => {
			if (this.#closed || data.byteLength === 0) return;
			this.#chunks.push(data);
			this.#bufferedBytes += data.byteLength;
			while (this.#bufferedBytes >= 5) {
				const length = this.#peekLength();
				if (length === 0 || length - 1 > MAX_PAYLOAD) return this.close();
				if (this.#bufferedBytes < 4 + length) break;
				const frame = this.#consumeFrame(length);
				let body: Record<string, unknown>;
				try {
					const value: unknown = JSON.parse(frame.payload.toString("utf8"));
					if (!value || typeof value !== "object" || Array.isArray(value)) return this.close();
					body = value as Record<string, unknown>;
				} catch {
					return this.close();
				}
				if (this.#waiting) this.#waiting({ kind: frame.kind, body });
				else this.#frames.push({ kind: frame.kind, body });
			}
		});
		socket.on("error", () => this.close());
		socket.on("close", () => this.close());
	}

	#peekLength(): number {
		const first = this.#chunks[this.#head]!;
		if (first.byteLength - this.#offset >= 4) return first.readUInt32BE(this.#offset);
		let value = 0;
		let index = this.#head;
		let at = this.#offset;
		for (let i = 0; i < 4; i++) {
			const chunk = this.#chunks[index]!;
			value = (value * 256 + chunk[at]!) >>> 0;
			at += 1;
			if (at === chunk.byteLength) {
				index += 1;
				at = 0;
			}
		}
		return value;
	}

	#consumeFrame(length: number): { kind: number; payload: Buffer } {
		const total = 4 + length;
		const first = this.#chunks[this.#head]!;
		if (first.byteLength - this.#offset >= total) {
			const kind = first[this.#offset + 4]!;
			const payload = first.subarray(this.#offset + 5, this.#offset + total);
			this.#offset += total;
			this.#bufferedBytes -= total;
			if (this.#offset === first.byteLength) {
				this.#head += 1;
				this.#offset = 0;
				if (this.#head === this.#chunks.length) {
					this.#chunks.length = 0;
					this.#head = 0;
				}
			}
			return { kind, payload };
		}
		const assembled = Buffer.allocUnsafe(total);
		let written = 0;
		while (written < total) {
			const chunk = this.#chunks[this.#head]!;
			const available = chunk.byteLength - this.#offset;
			const take = Math.min(available, total - written);
			chunk.copy(assembled, written, this.#offset, this.#offset + take);
			written += take;
			this.#offset += take;
			this.#bufferedBytes -= take;
			if (this.#offset === chunk.byteLength) {
				this.#head += 1;
				this.#offset = 0;
			}
		}
		if (this.#head === this.#chunks.length) {
			this.#chunks.length = 0;
			this.#head = 0;
		} else if (this.#head > 32) {
			this.#chunks.splice(0, this.#head);
			this.#head = 0;
		}
		return { kind: assembled[4]!, payload: assembled.subarray(5) };
	}

	/** Connects through the relay and presents the run's view. Throws the node's refusal as a FolderLinkError. */
	static async open(
		path: string,
		view: { environmentId: string } & CloudCompanyFolderRunView,
		signal: AbortSignal,
	): Promise<FolderLink> {
		const socket = connect(path);
		const opened = await new Promise<boolean>((resolve) => {
			const done = (value: boolean): void => {
				signal.removeEventListener("abort", aborted);
				resolve(value);
			};
			const aborted = (): void => done(false);
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) done(false);
		});
		if (!opened) {
			socket.destroy();
			throw new FolderLinkError("UNAVAILABLE", "The folder relay is not there");
		}
		const link = new FolderLink(socket);
		link.send(KIND.hello, {
			protocol: PROTOCOL,
			environmentId: view.environmentId,
			viewId: view.viewId,
			pass: view.pass,
			role: "io",
		});
		const answer = await link.next(HELLO_MS, signal);
		if (answer?.kind === KIND.helloOk) {
			const said = answer.body.search as Record<string, unknown> | undefined;
			if (said && typeof said === "object" && Number.isSafeInteger(said.version) && (said.version as number) >= 2)
				link.search = { version: said.version as number, regex: said.regex === true };
			return link;
		}
		link.close();
		throw answerError(answer);
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(kind: number, value: unknown): void {
		const json = JSON.stringify(value);
		const payloadBytes = Buffer.byteLength(json);
		const frame = Buffer.allocUnsafe(5 + payloadBytes);
		frame.writeUInt32BE(payloadBytes + 1, 0);
		frame[4] = kind;
		frame.write(json, 5, payloadBytes, "utf8");
		this.#socket.write(frame);
	}

	/** The next frame, or undefined once closed, aborted or past `ms`. */
	next(ms: number, signal: AbortSignal): Promise<Frame | undefined> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		if (this.#closed || signal.aborted) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(undefined), ms);
			const abort = (): void => finish(undefined);
			const finish = (value: Frame | undefined): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.#waiting = undefined;
				resolve(value);
			};
			signal.addEventListener("abort", abort, { once: true });
			this.#waiting = finish;
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#chunks.length = 0;
		this.#head = 0;
		this.#offset = 0;
		this.#bufferedBytes = 0;
		this.#socket.destroy();
		this.#waiting?.(undefined);
	}
}

const CODED = /^(?:REGEX|SEARCH)_[A-Z_]{2,30}: [\x20-\x7e]{1,240}$/;

function answerError(frame: Frame | undefined): FolderLinkError {
	if (frame?.kind === KIND.error && typeof frame.body.code === "string") {
		const message = frame.body.message;
		return new FolderLinkError(
			frame.body.code.slice(0, 40),
			"The node refused",
			typeof message === "string" && CODED.test(message) ? message : undefined,
		);
	}
	return new FolderLinkError("UNAVAILABLE", "The node did not answer");
}

/** A search shaped for the node: version 2's request when the node speaks it, else version 1's, which takes text or
 * names only. */
function shaped(ask: SearchAsk, support: SearchSupport): Record<string, unknown> {
	if (support.version >= 2) {
		if (ask.regex && !support.regex)
			throw new FolderLinkError(
				"BAD_REQUEST",
				"No regular expressions here",
				"REGEX_OFF: this node's folder search runs no regular expressions yet; search for text",
			);
		return {
			version: 2,
			query: ask.query,
			regex: ask.regex,
			path: ask.path,
			glob: ask.glob,
			namesOnly: ask.namesOnly,
			filesOnly: ask.filesOnly,
			caseSensitive: ask.caseSensitive,
			context: ask.context,
			after: ask.after,
		};
	}
	if (ask.query === null || ask.regex || ask.filesOnly || ask.context > 0)
		throw new FolderLinkError(
			"BAD_REQUEST",
			"An older node",
			"SEARCH_NOT_HERE_YET: this node's folder search takes text and names_only only, until its update; search without regex, files_only, context or a glob alone",
		);
	return {
		query: ask.query,
		path: ask.path,
		glob: ask.glob,
		namesOnly: ask.namesOnly,
		caseSensitive: ask.caseSensitive,
		after: ask.after,
	};
}

/** The run's search: its view and its connection, opened when first needed and again after either ended. */
export class CloudFolderSearch {
	readonly #socketPath: string;
	readonly #folder: CloudCompanyFolderClient;
	readonly #environmentId: string;
	readonly #now: () => number;
	#view: CloudCompanyFolderRunView | undefined;
	#link: FolderLink | undefined;
	#closed = false;
	/** Calls go one at a time: the node answers a connection's requests in turn, and one view serves the run. */
	#turn: Promise<unknown> = Promise.resolve();
	/** Where each answer said to go on, the search it belongs to, a file count it showed as going on, and whether an
	 * answer showed part of the file the cursor is inside (`shown`), kept here: the model holds only an opaque token, so
	 * it never reads (or forges) a path the answer did not show. Kept for the run. */
	readonly #cursors = new Map<
		string,
		{
			readonly cursor: SearchCursor;
			readonly search: string;
			readonly carried?: SearchFile;
			readonly shown?: true;
		}
	>();

	constructor(options: {
		socketPath: string;
		folder: CloudCompanyFolderClient;
		environmentId: string;
		now?: () => number;
	}) {
		this.#socketPath = options.socketPath;
		this.#folder = options.folder;
		this.#environmentId = options.environmentId;
		this.#now = options.now ?? Date.now;
	}

	/** One call's search, after any call asked for before it: its pages, one after another, as one answer. `shown`: an
	 * earlier answer showed part of the file `ask.after` is inside. */
	search(ask: SearchAsk, signal: AbortSignal, shown = false): Promise<SearchPage> {
		const call = this.#turn.then(() => this.#search(ask, signal, shown));
		this.#turn = call.catch(() => undefined);
		return call;
	}

	/** Pages until the answer has about a result's worth (CALL_FILL), the search ends, CALL_PAGES were asked or CALL_MS
	 * passed. A later page that fails ends the call with what came before it, and its cursor where that page began. */
	async #search(ask: SearchAsk, signal: AbortSignal, shown: boolean): Promise<SearchPage> {
		// A call cancelled while it waited its turn sends nothing.
		signal.throwIfAborted();
		const started = this.#now();
		let answer = await this.#page(ask, signal);
		// The file the call's cursor is inside, of which an earlier answer showed part: the node goes on in it only at
		// that version, and says nothing when it did not, so the answer does. A cursor inside a file is no proof the model
		// saw any of it (the search may have run out of time there before a hit, or the fitting left out its first hit):
		// then there is nothing to take back, and nothing is said (release review r2 of #1731).
		const earlier = shown && ask.after && (ask.after.offset > 0 || ask.after.line > 0) ? ask.after : undefined;
		if (earlier && !wentOn(earlier, answer)) answer = { ...answer, restarted: [restartOf(earlier, answer)] };
		for (
			let pages = 1;
			answer.next && pages < CALL_PAGES && shownBytes(answer) < CALL_FILL && this.#now() - started < CALL_MS;
			pages++
		) {
			let page: SearchPage;
			try {
				page = await this.#page({ ...ask, after: answer.next }, signal);
			} catch (error) {
				if (signal.aborted || !(error instanceof FolderLinkError || error instanceof CloudCompanyFolderError))
					throw error;
				// The search's own path is gone (deleted, or no longer the run's to read) since the call's first page:
				// everything the answer had is from under it, so none of it is shown or released, and the call answers as
				// its first page would have (review r9 of #1698).
				if (error instanceof FolderLinkError && error.code === "NOT_FOUND") throw error;
				break;
			}
			// The file this answer ended inside changed or went away before the next page: what the answer showed of its
			// old version is left out, and not released, so one answer never shows two versions of a file (the node
			// searched the new one from its start). When an earlier answer showed part of it too, the answer says so.
			const at = answer.next as SearchCursor;
			if (!wentOn(at, page)) {
				answer = without(answer, at);
				if (earlier && earlier.path === at.path && earlier.version === at.version)
					answer = { ...answer, restarted: [...(answer.restarted ?? []), restartOf(at, page)] };
			}
			answer = mergePages(answer, page);
		}
		return answer;
	}

	/** A view the node no longer serves (closed or superseded) is opened again once. A page that did not come back
	 * ends the connection, so a late answer never reaches the next request. */
	async #page(ask: SearchAsk, signal: AbortSignal): Promise<SearchPage> {
		for (let attempt = 0; ; attempt++) {
			try {
				const link = await this.#connect(signal);
				link.send(KIND.search, shaped(ask, link.search));
				const answer = await link.next(PAGE_MS, signal);
				if (answer?.kind === KIND.found) return parsePage(answer.body, link.search.version >= 2);
				const error = answerError(answer);
				// Only the node's own answer to this request leaves the connection usable; anything else ends it.
				if (answer?.kind !== KIND.error || !REQUEST_ERRORS.includes(error.code)) link.close();
				throw error;
			} catch (error) {
				if (error instanceof FolderLinkError && error.code === "VIEW_CLOSED" && attempt === 0) {
					this.#view = undefined;
					this.#link?.close();
					this.#link = undefined;
					continue;
				}
				throw error;
			}
		}
	}

	async #connect(signal: AbortSignal): Promise<FolderLink> {
		if (this.#closed) throw new FolderLinkError("UNAVAILABLE", "The run's search is closed");
		if (this.#link && !this.#link.closed) return this.#link;
		this.#view ??= await this.#folder.openRunView(signal);
		this.#link = await FolderLink.open(
			this.#socketPath,
			{ environmentId: this.#environmentId, ...this.#view },
			signal,
		);
		return this.#link;
	}

	/** A token for where an answer of `search` said to go on, with the count it showed as going on there, and whether
	 * an answer showed part of the file it is inside. */
	seal(cursor: SearchCursor, search: string, carried?: SearchFile, shown = false): string {
		const token = randomBytes(12).toString("base64url");
		this.#cursors.set(token, { cursor, search, ...(carried ? { carried } : {}), ...(shown ? { shown } : {}) });
		return token;
	}

	/** Where a token said to go on, if this run gave it for this same search. */
	open(
		token: string,
		search: string,
	): { readonly cursor: SearchCursor; readonly carried?: SearchFile; readonly shown?: true } | "other" | undefined {
		const sealed = this.#cursors.get(token);
		if (!sealed) return undefined;
		if (sealed.search !== search) return "other";
		return {
			cursor: sealed.cursor,
			...(sealed.carried ? { carried: sealed.carried } : {}),
			...(sealed.shown ? { shown: sealed.shown } : {}),
		};
	}

	close(): void {
		this.#closed = true;
		this.#link?.close();
	}
}

/** Whether a page went on in the file a cursor names at the cursor's version: a node reads (and so names among its
 * reads) every file it searches, the one it goes on in too. */
function wentOn(at: SearchCursor, page: SearchPage): boolean {
	return page.reads.some((read) => read.path === at.path && read.version === at.version);
}

/** An answer without what it showed of one version of a file, and without its read of it. */
function without(page: SearchPage, at: SearchCursor): SearchPage {
	const other = (item: { readonly path: string; readonly version: string | null }) =>
		item.path !== at.path || item.version !== at.version;
	return {
		...page,
		hits: page.hits.filter(other),
		files: (page.files ?? []).filter(other),
		reads: page.reads.filter(other),
	};
}

function restartOf(at: SearchCursor, page: SearchPage): SearchRestart {
	return { path: at.path, changed: page.reads.some((read) => read.path === at.path) };
}

/** Two pages as one answer: a file the first page ended inside, counted on by the second, is one file. */
function mergePages(a: SearchPage, b: SearchPage): SearchPage {
	const files = [...(a.files ?? [])];
	let rest = b.files ?? [];
	const last = files.at(-1);
	const first = rest[0];
	if (last?.partial && first && first.path === last.path && first.version === last.version) {
		files[files.length - 1] = { ...first, count: last.count + first.count };
		rest = rest.slice(1);
	}
	return {
		hits: [...a.hits, ...b.hits],
		files: [...files, ...rest],
		searched: a.searched + b.searched,
		binary: a.binary + b.binary,
		longLines: (a.longLines ?? 0) + (b.longLines ?? 0),
		reads: [...a.reads, ...b.reads],
		next: b.next,
		...(a.restarted || b.restarted ? { restarted: [...(a.restarted ?? []), ...(b.restarted ?? [])] } : {}),
	};
}

function parsePage(body: Record<string, unknown>, v2: boolean): SearchPage {
	const bad = (): never => {
		throw new FolderLinkError("UNAVAILABLE", "The node answered something else");
	};
	const count = (value: unknown): number =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad();
	const text = (value: unknown, max: number): string =>
		typeof value === "string" && value.length <= max ? value : bad();
	const lines = (value: unknown): readonly string[] =>
		Array.isArray(value) && value.length <= MAX_CONTEXT ? value.map((line) => text(line, 4096)) : bad();
	if (!Array.isArray(body.hits) || !Array.isArray(body.reads)) bad();
	const hits = (body.hits as unknown[]).map((item): SearchHit => {
		const h = item as Record<string, unknown>;
		if (!h || typeof h !== "object") bad();
		if (h.kind !== "file" && h.kind !== "folder" && h.kind !== "symlink") bad();
		const found: SearchHit = {
			path: text(h.path, 4096),
			kind: h.kind as SearchHit["kind"],
			line: count(h.line),
			text: text(h.text, 4096),
			version: text(h.version, 64),
			offset: count(h.offset),
		};
		// Context lines come only from a version 2 node, and only with a line.
		if (h.before !== undefined || h.after !== undefined || h.from !== undefined) {
			if (!v2 || found.line === 0 || found.kind !== "file") bad();
			return { ...found, before: lines(h.before), after: lines(h.after), from: count(h.from) };
		}
		if (found.kind !== "symlink") return h.target === undefined ? found : bad();
		// A link is a name hit, with its target as the core keeps it.
		const target = h.target;
		if (
			found.line !== 0 ||
			found.text !== "" ||
			typeof target !== "string" ||
			target === "" ||
			Buffer.byteLength(target) > MAX_TARGET
		)
			bad();
		return { ...found, target: target as string };
	});
	const files = (v2 && Array.isArray(body.files) ? (body.files as unknown[]) : []).map((item): SearchFile => {
		const f = item as Record<string, unknown>;
		// A count goes on only from a match; a count of 0 ends one a page before it gave.
		if (!f || typeof f !== "object" || (f.partial !== undefined && (f.partial !== true || count(f.count) === 0)))
			bad();
		const file = { path: text(f.path, 4096), version: text(f.version, 64), count: count(f.count) };
		return f.partial === true ? { ...file, partial: true } : file;
	});
	const reads = (body.reads as unknown[]).map((item): CloudCompanyFolderRelease => {
		const r = item as Record<string, unknown>;
		if (
			!r ||
			typeof r !== "object" ||
			typeof r.path !== "string" ||
			typeof r.version !== "string" ||
			!isUuid(r.version)
		)
			bad();
		const authority = r.authority as Partial<CloudCompanyFolderAuthority> | undefined;
		const receipt =
			authority &&
			typeof authority.resourceId === "string" &&
			isUuid(authority.resourceId) &&
			Number.isSafeInteger(authority.resourceRevision) &&
			(authority.grantId === null
				? authority.grantRevision === null
				: typeof authority.grantId === "string" &&
					isUuid(authority.grantId) &&
					Number.isSafeInteger(authority.grantRevision))
				? (authority as CloudCompanyFolderAuthority)
				: NO_RECEIPT;
		return { path: r.path as string, version: r.version as string, authority: receipt };
	});
	const next = body.next === null ? null : (cursorOf(body.next) ?? bad());
	return {
		hits,
		files,
		searched: count(body.searched),
		binary: count(body.binary),
		longLines: v2 && body.longLines !== undefined ? count(body.longLines) : 0,
		reads,
		next,
	};
}

function cursorOf(value: unknown): SearchCursor | undefined {
	const c = value as Record<string, unknown> | null;
	if (
		!c ||
		typeof c !== "object" ||
		Object.keys(c).sort().join() !== "line,offset,path,version" ||
		typeof c.path !== "string" ||
		c.path === "" ||
		typeof c.version !== "string" ||
		!/^[0-9a-f-]{0,64}$/.test(c.version) ||
		!Number.isSafeInteger(c.offset) ||
		(c.offset as number) < 0 ||
		!Number.isSafeInteger(c.line) ||
		(c.line as number) < 0
	)
		return undefined;
	return { path: c.path, version: c.version, offset: c.offset as number, line: c.line as number };
}

/** Where to go on to show a hit that did not fit: from its line, or with context from its first line before (or, for
 * a name, the entry itself). */
function resumeAt(hit: SearchHit): SearchCursor {
	if (hit.line === 0) return { path: hit.path, version: hit.version, offset: 0, line: 0 };
	const before = hit.before?.length ?? 0;
	return { path: hit.path, version: hit.version, offset: hit.from ?? hit.offset, line: hit.line - 1 - before };
}

/** One hit or one file of an answer, as its lines, and where to go on to show it when it is left out. */
interface Unit {
	readonly lines: readonly string[];
	readonly resume: SearchCursor;
	/** Its first and last line numbers in its file (a text hit with context), to join it to the next. */
	readonly span?: readonly [string, number, number];
}

/** A link shows what it names, quoted as JSON: its target is kept exactly, spaces and line breaks too. */
function hitLine(h: SearchHit, text = h.kind === "symlink" ? JSON.stringify(h.target) : h.text): string {
	return h.kind === "symlink"
		? `${h.path} -> ${text}`
		: h.line === 0
			? `${h.path}${h.kind === "folder" ? "/" : ""}`
			: `${h.path}:${h.line}: ${text}`;
}

function hitUnit(h: SearchHit, withContext = true): Unit {
	const before = (withContext && h.before) || [];
	const after = (withContext && h.after) || [];
	if (h.line === 0 || (before.length === 0 && after.length === 0 && h.before === undefined))
		return { lines: [hitLine(h)], resume: resumeAt(h) };
	// rg's form: a context line is path-line- text.
	return {
		lines: [
			...before.map((text, i) => `${h.path}-${h.line - before.length + i}- ${text}`),
			hitLine(h),
			...after.map((text, i) => `${h.path}-${h.line + 1 + i}- ${text}`),
		],
		resume: resumeAt(h),
		span: [h.path, h.line - before.length, h.line + after.length],
	};
}

function fileUnit(f: SearchFile): Unit {
	return {
		lines: [`${f.path}: ${f.count}${f.partial ? " so far (the count goes on with the cursor)" : ""}`],
		resume: { path: f.path, version: f.version, offset: 0, line: 0 },
	};
}

/** The lines of units in order; with context, `--` between hits whose lines do not join (rg's form). */
function joined(units: readonly Unit[]): string[] {
	const out: string[] = [];
	let last: readonly [string, number, number] | undefined;
	for (const unit of units) {
		if (unit.span && last && (unit.span[0] !== last[0] || unit.span[1] > last[2] + 1)) out.push("--");
		out.push(...unit.lines);
		last = unit.span;
	}
	return out;
}

function unitsOf(page: SearchPage): Unit[] {
	// A count of 0 that closed nothing shown says nothing.
	return [...page.hits.map((h) => hitUnit(h)), ...(page.files ?? []).filter((f) => f.count > 0).map(fileUnit)];
}

/** An answer that goes on inside the file a count was carried into (the cursor's): the count it showed before is the
 * start of this one, which then shows the file's whole count, or that it still goes on. A file whose version changed
 * since is counted from its start, so the count carried no longer holds. */
function withCarried(page: SearchPage, carried: SearchFile | undefined): SearchPage {
	if (!carried) return page;
	const first = page.files?.[0];
	const same = (f: { path: string; version: string } | null | undefined) =>
		f?.path === carried.path && f.version === carried.version;
	if (same(first) || (page.files?.length === 0 && same(page.next)))
		return mergePages({ hits: [], files: [carried], searched: 0, binary: 0, reads: [], next: null }, page);
	return page;
}

/** The bytes an answer's lines take as shown, before its fitting: what a call measures to ask for another page. */
function shownBytes(page: SearchPage): number {
	return joined(unitsOf(page)).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
}

/** Whether a cursor is inside this version of this file. */
function inFile(file: { readonly path: string; readonly version: string }, cursor: SearchCursor): boolean {
	return cursor.path === file.path && cursor.version === file.version;
}

/** The text the model is shown of one answer, fitted to one tool result: hits (or files) that do not fit go to the
 * next call, and the first is always shown (without its context lines, its line cut, and at worst its path, if that
 * is what fits). `seal` turns where to go on into the token the model passes back, with the file count the answer
 * shows as going on there, and whether the answer shows anything of the file (at that version) the cursor is inside. */
export function folderSearchText(
	page: SearchPage,
	seal: (cursor: SearchCursor, carried?: SearchFile, shown?: boolean) => string,
	countOnly = false,
): string {
	const units = unitsOf(page);
	const longLines = page.longLines ?? 0;
	const restarted = (page.restarted ?? []).map((r) => {
		const chars = Array.from(r.path);
		const path = chars.length > 300 ? `${chars.slice(0, 300).join("")}…` : r.path;
		return r.changed
			? `${path} changed since the last answer: it is searched again from its start.`
			: `${path} is not as the last answer saw it (changed, emptied, gone, or no longer yours to read): what that answer showed of it may not hold.`;
	});
	const notes = restarted.length > 0 ? `${restarted.join("\n")}\n\n` : "";
	const lay = (shown: number, first?: Unit, token = "x".repeat(16)) => {
		const lines = joined(units.slice(0, shown).map((u, i) => (i === 0 && first !== undefined ? first : u)));
		const cut = shown < units.length;
		const next = cut ? units[shown]!.resume : page.next;
		const passed =
			longLines > 0
				? `; ${longLines} line${longLines === 1 ? "" : "s"} over 1 MiB not searched by the pattern (search them as text, or read them)`
				: "";
		const counts = cut
			? `Part of the answer${passed}`
			: `${page.searched} file${page.searched === 1 ? "" : "s"} searched` +
				(page.binary > 0 ? `, ${page.binary} binary passed over` : "") +
				passed;
		const more = next ? `. More: call again with cursor ${token}` : ". Nothing more.";
		let body = lines.length === 0 ? "No matches here." : lines.join("\n");
		if (countOnly && lines.length > 0) {
			const matchingFiles = (page.files ?? []).filter((f) => f.count > 0).slice(0, shown);
			const total = matchingFiles.reduce((sum, f) => sum + f.count, 0);
			const partial = cut || next !== null || matchingFiles.some((f) => f.partial === true);
			const summary = `${total} matching line${total === 1 ? "" : "s"} in ${matchingFiles.length} file${matchingFiles.length === 1 ? "" : "s"}${partial ? " so far" : ""}`;
			body = `${summary}\n${body}`;
		}
		return {
			text: `${body}\n\n${notes}${counts}${more}`,
			next,
		};
	};
	const last = page.files?.at(-1);
	const sealed = (shown: number, first?: Unit): string => {
		const { text, next } = lay(shown, first);
		if (!next) return text;
		// A count shown as going on goes on with the cursor, when the answer showed it (nothing after it was cut).
		const carried = shown === units.length && last?.partial ? last : undefined;
		const showsFile = units.slice(0, shown).some((unit) => inFile(unit.resume, next));
		return lay(shown, first, seal(next, carried, showsFile)).text;
	};
	let shown = units.length;
	while (shown > 1 && !fitsOneResult(lay(shown).text)) shown--;
	if (shown === 0 || fitsOneResult(lay(shown).text)) return sealed(shown);
	// One that does not fit whole: a hit without its context lines, then its line (or a link's target) shorter and
	// shorter, then its path.
	const hit = page.hits[0];
	if (hit && (hit.before?.length || hit.after?.length)) {
		const bare = hitUnit(hit, false);
		if (fitsOneResult(lay(1, bare).text)) return sealed(1, bare);
	}
	const only = (line: string): Unit => ({ lines: [line], resume: units[0]!.resume });
	if (hit) {
		const link = hit.kind === "symlink";
		const chars = Array.from(link ? (hit.target ?? "") : hit.text);
		for (let keep = chars.length; keep >= 0; keep = keep === 0 ? -1 : Math.floor(keep / 2)) {
			const kept = chars.slice(0, keep).join("");
			const cut = keep < chars.length;
			const first = only(
				hitLine(hit, link ? `${JSON.stringify(kept)}${cut ? "… (target cut)" : ""}` : `${kept}${cut ? "…" : ""}`),
			);
			if (fitsOneResult(lay(1, first).text)) return sealed(1, first);
		}
	}
	const path = Array.from(hit?.path ?? page.files?.[0]?.path ?? "");
	for (let keep = path.length; keep > 0; keep = Math.floor(keep / 2)) {
		const first = only(`${path.slice(0, keep).join("")}… (path cut)`);
		if (fitsOneResult(lay(1, first).text)) return sealed(1, first);
	}
	return sealed(0);
}

/** The release ids of one answer: derived from the run, the call and the text shown, so a replay of the same answer
 * reuses them and one that shows something else gets its own. */
function releaseId(runId: string, callId: string, outputSha256: string, part: number): string {
	const hex = createHash("sha256")
		.update(`qorpera.folder-search-release/v1:${runId}:${callId}:${outputSha256}:${part}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const ARGUMENTS = [
	"query",
	"path",
	"glob",
	"exclude_glob",
	"regex",
	"context",
	"files_only",
	"count_only",
	"names_only",
	"case_sensitive",
	"smart_case",
	"whole_word",
	"cursor",
];

function closedArguments(value: JsonValue): Record<string, JsonValue> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal(`company_search takes an object with ${ARGUMENTS.join(", ")}`);
	if (Object.keys(value).some((key) => !ARGUMENTS.includes(key)))
		throw new CloudToolArgumentRefusal(`company_search takes only ${ARGUMENTS.join(", ")}`);
	return value as Record<string, JsonValue>;
}

function searchText(value: JsonValue | undefined, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_QUERY ||
		/[\u0000-\u001f\u007f]/.test(value)
	)
		throw new CloudToolArgumentRefusal(`${label} must be text of 1 to ${MAX_QUERY} characters, on one line`);
	return value;
}

function escapeRegexLiteral(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function formatExcludeGlob(exclude: string): string {
	const parts = exclude
		.split(",")
		.map((part) => part.trim().replace(/^!+/, ""))
		.filter((part) => part.length > 0);
	if (parts.length === 0) throw new CloudToolArgumentRefusal("exclude_glob must name at least one pattern");
	return parts.map((part) => `!${part}`).join(",");
}

function mergeWireGlob(glob: string | null, excludeGlob: string | undefined): string | null {
	if (excludeGlob === undefined) return glob;
	const negated = formatExcludeGlob(excludeGlob);
	const merged = glob === null ? negated : `${glob},${negated}`;
	if (merged.length > MAX_QUERY)
		throw new CloudToolArgumentRefusal(`glob and exclude_glob together must be at most ${MAX_QUERY} characters`);
	return merged;
}

const CURSOR_TOKEN = /^[A-Za-z0-9_-]{16}$/;

type SearchInput = {
	readonly query: string | null;
	readonly path: string;
	readonly glob: string | null;
	readonly exclude_glob?: string;
	readonly regex: boolean;
	readonly context: number;
	readonly files_only: boolean;
	readonly count_only?: true;
	readonly names_only: boolean;
	readonly case_sensitive: boolean;
	readonly smart_case?: true;
	readonly whole_word?: true;
	readonly cursor: string | null;
};

export function cloudFolderSearchTool(options: {
	search: CloudFolderSearch;
	folder: CloudCompanyFolderClient;
	runId: string;
}): CloudNativeTool {
	const { search, folder, runId } = options;
	return {
		name: "company_search",
		description:
			"Search the company folder like rg: the lines of its text files that contain query, as path:line: text. Only " +
			"what you may read is searched.\n" +
			"Literal text, not case-sensitive unless you say (or set smart_case for case-sensitive only when query has " +
			"uppercase); whole_word matches whole words only. With regex, query is a regular expression (linear-time: no " +
			"back-references or lookaround, counts up to 64, inline (?i) and (?m) flags) if the folder's search runs " +
			"them; REGEX_OFF means it does not, so search for text.\n" +
			"context adds up to 5 lines before and after each hit (path-line- text); files_only lists just the matching " +
			"files (path: matching lines); count_only totals matching lines across matching files; exclude_glob (or " +
			"!pattern in glob) skips matching paths. names_only searches the names of files, folders and links instead " +
			'(a link as path -> "what it names"; a link is never searched through); a glob with no query lists every ' +
			"path it matches. One call searches for up to about 10 s and shows up to about 30 KiB; when there is more, " +
			"it gives a cursor to call again with. Read a file with company_read; work on files (spreadsheets, " +
			"documents, scripts) on a machine.",
		source: "company_file",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
					minLength: 1,
					maxLength: MAX_QUERY,
					description: "The text (with regex, the pattern) to find. Leave it out to list paths by glob.",
				},
				path: {
					type: "string",
					description: "A folder (or one file) to search, company-relative; the whole folder by default.",
				},
				glob: {
					type: "string",
					maxLength: MAX_QUERY,
					description:
						"Only paths like this: * and ? within a name, ** across folders, !pattern to exclude, e.g. *.md or docs/**/*.csv.",
				},
				exclude_glob: {
					type: "string",
					minLength: 1,
					maxLength: MAX_QUERY,
					description: "Skip paths matching this glob (comma-separated for several), e.g. *.test.ts,dist/**.",
				},
				regex: { type: "boolean", description: "query is a regular expression." },
				context: {
					type: "integer",
					minimum: 0,
					maximum: MAX_CONTEXT,
					description: "Lines to show before and after each hit.",
				},
				files_only: { type: "boolean", description: "Only the matching files, with how many lines match in each." },
				count_only: { type: "boolean", description: "Return total matching line count and per-file counts." },
				names_only: { type: "boolean", description: "Search names of files and folders instead of their text." },
				case_sensitive: { type: "boolean" },
				smart_case: { type: "boolean", description: "Case-sensitive only when query has uppercase letters." },
				whole_word: { type: "boolean", description: "Match whole words only." },
				cursor: { type: "string", description: "Where the last answer said to go on." },
			},
		},
		parseArguments(value): SearchInput {
			const input = closedArguments(value);
			const query = input.query === undefined ? null : searchText(input.query, "query");
			let path = "";
			if (input.path !== undefined && input.path !== "") {
				try {
					path = parseCloudCompanyPath(input.path);
				} catch {
					throw new CloudToolArgumentRefusal(
						"path must be a company-relative folder or file, like docs or docs/plan.md (no leading or trailing /)",
					);
				}
			}
			const glob = input.glob === undefined ? null : searchText(input.glob, "glob");
			const excludeGlob =
				input.exclude_glob === undefined ? undefined : searchText(input.exclude_glob, "exclude_glob");
			for (const flag of [
				"regex",
				"files_only",
				"count_only",
				"names_only",
				"case_sensitive",
				"smart_case",
				"whole_word",
			] as const)
				if (input[flag] !== undefined && typeof input[flag] !== "boolean")
					throw new CloudToolArgumentRefusal(`${flag} must be true or false`);
			const context = input.context ?? 0;
			if (typeof context !== "number" || !Number.isInteger(context) || context < 0 || context > MAX_CONTEXT)
				throw new CloudToolArgumentRefusal(`context must be a whole number from 0 to ${MAX_CONTEXT}`);
			const regex = input.regex === true;
			const filesOnly = input.files_only === true;
			const countOnly = input.count_only === true;
			const namesOnly = input.names_only === true;
			const smartCase = input.smart_case === true;
			const wholeWord = input.whole_word === true;
			if (query === null && glob === null)
				throw new CloudToolArgumentRefusal("company_search needs a query, a glob, or both");
			if (query === null && (regex || filesOnly || countOnly || context > 0 || wholeWord))
				throw new CloudToolArgumentRefusal("regex, files_only and context need a query; a glob alone lists paths");
			if ((filesOnly || countOnly) && namesOnly)
				throw new CloudToolArgumentRefusal("files_only counts lines of text, not names");
			if (context > 0 && (namesOnly || filesOnly || countOnly))
				throw new CloudToolArgumentRefusal(
					"context shows lines around text hits, not with names_only or files_only",
				);
			if (excludeGlob !== undefined) mergeWireGlob(glob, excludeGlob);
			if (wholeWord && query !== null) {
				const wrapped = regex ? `\\b(?:${query})\\b` : `\\b(?:${escapeRegexLiteral(query)})\\b`;
				if (wrapped.length > MAX_QUERY)
					throw new CloudToolArgumentRefusal(
						`whole_word query must fit within ${MAX_QUERY} characters as a pattern`,
					);
			}
			if (input.cursor !== undefined && (typeof input.cursor !== "string" || !CURSOR_TOKEN.test(input.cursor)))
				throw new CloudToolArgumentRefusal("cursor must be the token an answer of this search gave");
			return {
				query,
				path,
				glob,
				...(excludeGlob === undefined ? {} : { exclude_glob: excludeGlob }),
				regex,
				context,
				files_only: filesOnly,
				...(countOnly ? { count_only: true as const } : {}),
				names_only: namesOnly || query === null,
				case_sensitive: input.case_sensitive === true,
				...(smartCase ? { smart_case: true as const } : {}),
				...(wholeWord ? { whole_word: true as const } : {}),
				cursor: input.cursor === undefined ? null : input.cursor,
			};
		},
		async execute(value, context): Promise<CloudToolContent> {
			const input = value as SearchInput;
			const wireGlob = mergeWireGlob(input.glob, input.exclude_glob);
			const wireRegex = input.regex || input.whole_word === true;
			const wireQuery =
				input.whole_word === true && input.query !== null
					? input.regex
						? `\\b(?:${input.query})\\b`
						: `\\b(?:${escapeRegexLiteral(input.query)})\\b`
					: input.query;
			const wireCaseSensitive =
				input.case_sensitive || (input.smart_case === true && input.query !== null && /\p{Lu}/u.test(input.query));
			const wireFilesOnly = input.files_only || input.count_only === true;
			const asked = JSON.stringify([
				input.query,
				input.path,
				input.glob,
				input.exclude_glob ?? null,
				input.regex,
				input.context,
				input.files_only,
				input.count_only ?? false,
				input.names_only,
				input.case_sensitive,
				input.smart_case ?? false,
				input.whole_word ?? false,
			]);
			const opened = input.cursor === null ? null : search.open(input.cursor, asked);
			if (opened === undefined)
				throw new CloudToolRefusal(
					"CURSOR_UNKNOWN: that cursor is not one this run's search gave (cursors last for the run); search again",
				);
			if (opened === "other")
				throw new CloudToolRefusal(
					"CURSOR_OTHER_SEARCH: that cursor belongs to another search; repeat that search's query, path, glob and flags with it, or search without a cursor",
				);
			let page: SearchPage;
			try {
				page = await search.search(
					{
						query: wireQuery,
						regex: wireRegex,
						path: input.path,
						glob: wireGlob,
						namesOnly: input.names_only,
						filesOnly: wireFilesOnly,
						caseSensitive: wireCaseSensitive,
						context: input.context,
						after: opened?.cursor ?? null,
					},
					context.signal,
					opened?.shown === true,
				);
				page = withCarried(page, opened?.carried);
			} catch (error) {
				if (!(error instanceof FolderLinkError) && !(error instanceof CloudCompanyFolderError)) throw error;
				const code = error instanceof FolderLinkError ? error.code : "";
				const detail = error instanceof FolderLinkError ? error.detail : undefined;
				if (code === "NOT_FOUND") throw new CloudToolRefusal("NOT_FOUND: no such path in the folder you may read");
				if (code === "BAD_REQUEST" && detail) throw new CloudToolRefusal(detail);
				if (code === "BAD_REQUEST")
					throw new CloudToolRefusal("BAD_REQUEST: the folder search refused the request");
				if (code === "UNAVAILABLE" && detail?.startsWith("SEARCH_"))
					throw new CloudToolRefusal(
						"COMPANY_FOLDER_BUSY: the node's folder search is full or busy now; try again in a minute, or read with company_read",
					);
				throw new CloudToolRefusal(
					"COMPANY_FOLDER_UNAVAILABLE: the folder could not be searched now; try again, or read with company_read",
				);
			}
			const text = redactCloudWebhookSecrets(
				folderSearchText(
					page,
					(cursor, carried, shown) =>
						search.seal(
							cursor,
							asked,
							carried,
							shown === true || (opened?.shown === true && inFile(opened.cursor, cursor)),
						),
					input.count_only === true,
				),
			);
			// Released before the model sees the answer, under the hash of exactly this text; cited by its first release.
			let companyReadId: string | undefined;
			const outputSha256 = createHash("sha256").update(text, "utf8").digest("hex");
			try {
				for (let part = 0; part * MAX_RELEASED < page.reads.length; part++) {
					const id = releaseId(runId, context.callId, outputSha256, part);
					await folder.release(
						id,
						page.reads.slice(part * MAX_RELEASED, (part + 1) * MAX_RELEASED),
						outputSha256,
						context.signal,
					);
					companyReadId ??= id;
				}
			} catch (error) {
				if (error instanceof CloudCompanyFolderError && error.failure === "read_revoked")
					throw new CloudToolRefusal(
						"READ_REVOKED: something this answer drew on may no longer be read by you, so it is not shown; search again",
					);
				if (error instanceof CloudCompanyFolderError)
					throw new CloudToolRefusal(
						`COMPANY_FOLDER_UNAVAILABLE: what this answer read could not be recorded (${error.failure}), so it is not shown; try again`,
					);
				throw error;
			}
			return { kind: "text", value: text, ...(companyReadId ? { companyReadId } : {}) };
		},
	};
}
