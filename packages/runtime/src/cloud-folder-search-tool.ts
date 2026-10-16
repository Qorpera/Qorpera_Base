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
} from "./cloud-native-tool-boundary.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

/**
 * `company_search` (F3; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Server-side search"). The founder's "Light
 * threads" decision (2 October 2026) gives a chat turn no shell: the agent searches the company folder on its node's
 * folder service, with the view its run opened, so a folder shared with only some agents is searched exactly for them.
 *
 * The native host opens the run's view once (`qorpera_folder_run_view_open`) and keeps one connection to the node
 * through its slot's relay socket for the run; the node lists the view once and keeps it current. Each call is one
 * page of the search, with a cursor to go on. Before the model sees a page, everything it drew on (each folder looked
 * through, each file read) is released with the run actor under the hash of the exact text shown, and the answer
 * cites the release.
 */

/** The node's folder protocol (packages/object-gateway/src/folder-service/protocol.ts): a u32 big-endian length of
 * the type byte and the payload, the type byte, then JSON. At 4 the node finds links by name, with their targets
 * (deploy/first-node/RUNTIME-FOLDER-LINKS.md). */
const PROTOCOL = 4;
const KIND = { hello: 0x48, helloOk: 0x68, search: 0x53, found: 0x73, error: 0x65 } as const;
const MAX_PAYLOAD = 2 * 1024 * 1024;
/** How long the node may take to answer a hello (it lists the whole view the first time, which a large folder takes a
 * while for, and throws away if the caller leaves) and a page (about 2 s of work). The end of the run's tool session
 * cuts either short. */
const HELLO_MS = 600_000;
const PAGE_MS = 60_000;
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
/** A link's target, in UTF-8 bytes (the core's limit). */
const MAX_TARGET = 4095;

/** Where a search goes on (the node's `SearchCursor`). */
interface SearchCursor {
	readonly path: string;
	readonly version: string;
	readonly offset: number;
	readonly line: number;
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
}

interface SearchPage {
	readonly hits: readonly SearchHit[];
	readonly searched: number;
	readonly binary: number;
	readonly reads: readonly CloudCompanyFolderRelease[];
	readonly next: SearchCursor | null;
}

interface Frame {
	readonly kind: number;
	readonly body: Record<string, unknown>;
}

/** The node answered with one of its error codes. */
class FolderLinkError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "FolderLinkError";
		this.code = code;
	}
}

/** One connection to the node's folder service, through the slot's relay; any fault ends it. */
class FolderLink {
	readonly #socket: Socket;
	#buffer: Buffer = Buffer.alloc(0);
	readonly #frames: Frame[] = [];
	#waiting: ((frame: Frame | undefined) => void) | undefined;
	#closed = false;

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (data: Buffer) => {
			this.#buffer = this.#buffer.byteLength === 0 ? data : Buffer.concat([this.#buffer, data]);
			while (this.#buffer.byteLength >= 5) {
				const length = this.#buffer.readUInt32BE(0);
				if (length === 0 || length - 1 > MAX_PAYLOAD) return this.close();
				if (this.#buffer.byteLength < 4 + length) break;
				const kind = this.#buffer[4]!;
				let body: Record<string, unknown>;
				try {
					const value: unknown = JSON.parse(this.#buffer.subarray(5, 4 + length).toString("utf8"));
					if (!value || typeof value !== "object" || Array.isArray(value)) return this.close();
					body = value as Record<string, unknown>;
				} catch {
					return this.close();
				}
				this.#buffer = this.#buffer.subarray(4 + length);
				if (this.#waiting) this.#waiting({ kind, body });
				else this.#frames.push({ kind, body });
			}
		});
		socket.on("error", () => this.close());
		socket.on("close", () => this.close());
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
		if (answer?.kind === KIND.helloOk) return link;
		link.close();
		throw answerError(answer);
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(kind: number, value: unknown): void {
		const payload = Buffer.from(JSON.stringify(value));
		const head = Buffer.allocUnsafe(5);
		head.writeUInt32BE(payload.byteLength + 1, 0);
		head[4] = kind;
		this.#socket.write(Buffer.concat([head, payload]));
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
		this.#socket.destroy();
		this.#waiting?.(undefined);
	}
}

function answerError(frame: Frame | undefined): FolderLinkError {
	if (frame?.kind === KIND.error && typeof frame.body.code === "string")
		return new FolderLinkError(frame.body.code.slice(0, 40), "The node refused");
	return new FolderLinkError("UNAVAILABLE", "The node did not answer");
}

/** The run's search: its view and its connection, opened when first needed and again after either ended. */
export class CloudFolderSearch {
	readonly #socketPath: string;
	readonly #folder: CloudCompanyFolderClient;
	readonly #environmentId: string;
	#view: CloudCompanyFolderRunView | undefined;
	#link: FolderLink | undefined;
	#closed = false;
	/** Pages go one at a time: the node answers a connection's requests in turn, and one view serves the run. */
	#turn: Promise<unknown> = Promise.resolve();
	/** Where each page said to go on, and the search it belongs to, kept here: the model holds only an opaque token, so
	 * it never reads (or forges) a path the page did not show. Kept for the run. */
	readonly #cursors = new Map<string, { readonly cursor: SearchCursor; readonly search: string }>();

	constructor(options: { socketPath: string; folder: CloudCompanyFolderClient; environmentId: string }) {
		this.#socketPath = options.socketPath;
		this.#folder = options.folder;
		this.#environmentId = options.environmentId;
	}

	/** One page, after any page asked for before it. */
	page(request: Record<string, unknown>, signal: AbortSignal): Promise<SearchPage> {
		const page = this.#turn.then(() => this.#page(request, signal));
		this.#turn = page.catch(() => undefined);
		return page;
	}

	/** A view the node no longer serves (closed or superseded) is opened again once. A page that did not come back
	 * ends the connection, so a late answer never reaches the next request. */
	async #page(request: Record<string, unknown>, signal: AbortSignal): Promise<SearchPage> {
		// A call cancelled while it waited its turn sends nothing.
		signal.throwIfAborted();
		for (let attempt = 0; ; attempt++) {
			try {
				const link = await this.#connect(signal);
				link.send(KIND.search, request);
				const answer = await link.next(PAGE_MS, signal);
				if (answer?.kind === KIND.found) return parsePage(answer.body);
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

	/** A token for where a page of `search` said to go on. */
	seal(cursor: SearchCursor, search: string): string {
		const token = randomBytes(12).toString("base64url");
		this.#cursors.set(token, { cursor, search });
		return token;
	}

	/** Where a token said to go on, if this run gave it for this same search. */
	open(token: string, search: string): SearchCursor | "other" | undefined {
		const sealed = this.#cursors.get(token);
		if (!sealed) return undefined;
		return sealed.search === search ? sealed.cursor : "other";
	}

	close(): void {
		this.#closed = true;
		this.#link?.close();
	}
}

function parsePage(body: Record<string, unknown>): SearchPage {
	const bad = (): never => {
		throw new FolderLinkError("UNAVAILABLE", "The node answered something else");
	};
	const count = (value: unknown): number =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad();
	const text = (value: unknown, max: number): string =>
		typeof value === "string" && value.length <= max ? value : bad();
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
	return { hits, searched: count(body.searched), binary: count(body.binary), reads, next };
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

/** Where to go on to show a hit that did not fit: from its line (or, for a name, the entry itself). */
function resumeAt(hit: SearchHit): SearchCursor {
	return hit.line === 0
		? { path: hit.path, version: hit.version, offset: 0, line: 0 }
		: { path: hit.path, version: hit.version, offset: hit.offset, line: hit.line - 1 };
}

/** The text the model is shown of one page, fitted to one tool result: hits that do not fit go to the next page, and
 * the first hit is always shown (its line cut, and at worst its path, if that is what fits). `seal` turns where to go
 * on into the token the model passes back. */
export function folderSearchText(page: SearchPage, seal: (cursor: SearchCursor) => string): string {
	// A link shows what it names, quoted as JSON: its target is kept exactly, spaces and line breaks too.
	const shownHit = (h: SearchHit, text = h.kind === "symlink" ? JSON.stringify(h.target) : h.text): string =>
		h.kind === "symlink"
			? `${h.path} -> ${text}`
			: h.line === 0
				? `${h.path}${h.kind === "folder" ? "/" : ""}`
				: `${h.path}:${h.line}: ${text}`;
	// Laid out with a stand-in token of a real token's length (16 characters, nothing to escape), and sealed once.
	const lay = (shown: number, first?: string, token = "x".repeat(16)) => {
		const lines = page.hits.slice(0, shown).map((h, i) => (i === 0 && first !== undefined ? first : shownHit(h)));
		const cut = shown < page.hits.length;
		const next = cut ? resumeAt(page.hits[shown]!) : page.next;
		// A page cut short counts nothing: the next page searches its files again.
		const counts = cut
			? "Part of a page"
			: `${page.searched} file${page.searched === 1 ? "" : "s"} searched` +
				(page.binary > 0 ? `, ${page.binary} binary passed over` : "");
		const more = next ? `. More: call again with cursor ${token}` : ". Nothing more.";
		return { text: `${lines.length === 0 ? "No matches here." : lines.join("\n")}\n\n${counts}${more}`, next };
	};
	const sealed = (shown: number, first?: string): string => {
		const { text, next } = lay(shown, first);
		return next ? lay(shown, first, seal(next)).text : text;
	};
	let shown = page.hits.length;
	while (shown > 1 && !fitsOneResult(lay(shown).text)) shown--;
	if (shown === 0 || fitsOneResult(lay(shown).text)) return sealed(shown);
	// One hit that does not fit whole: its line (or a link's target) shorter and shorter, then its path.
	const hit = page.hits[0]!;
	const link = hit.kind === "symlink";
	const chars = Array.from(link ? (hit.target ?? "") : hit.text);
	for (let keep = chars.length; keep >= 0; keep = keep === 0 ? -1 : Math.floor(keep / 2)) {
		const kept = chars.slice(0, keep).join("");
		const cut = keep < chars.length;
		const first = shownHit(
			hit,
			link ? `${JSON.stringify(kept)}${cut ? "… (target cut)" : ""}` : `${kept}${cut ? "…" : ""}`,
		);
		if (fitsOneResult(lay(1, first).text)) return sealed(1, first);
	}
	const path = Array.from(hit.path);
	for (let keep = path.length; keep > 0; keep = Math.floor(keep / 2)) {
		const first = `${path.slice(0, keep).join("")}… (path cut)`;
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

const ARGUMENTS = ["query", "path", "glob", "names_only", "case_sensitive", "cursor"];

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

const CURSOR_TOKEN = /^[A-Za-z0-9_-]{16}$/;

/** `company_search`, for a folder-v2 run whose host has the node's folder search. */
export function cloudFolderSearchTool(options: {
	search: CloudFolderSearch;
	folder: CloudCompanyFolderClient;
	runId: string;
}): CloudNativeTool {
	const { search, folder, runId } = options;
	return {
		name: "company_search",
		description:
			"Search the company folder: the lines of its text files that contain your query, or with names_only the names of " +
			"its files, folders and links. Only what you may read is searched. Literal text, not case-sensitive unless you " +
			'say. Each call answers one page, path:line: text (a link as path -> "what it names"; a link is never searched ' +
			"through); when there is more, it gives a cursor to call again with. " +
			"Read a file with company_read; work on files (spreadsheets, documents, scripts) on the company's computer.",
		source: "company_file",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1, maxLength: MAX_QUERY, description: "The text to find." },
				path: {
					type: "string",
					description: "A folder (or one file) to search, company-relative; the whole folder by default.",
				},
				glob: {
					type: "string",
					maxLength: MAX_QUERY,
					description:
						"Only paths like this: * and ? within a name, ** across folders, e.g. *.md or docs/**/*.csv.",
				},
				names_only: { type: "boolean", description: "Search names of files and folders instead of their text." },
				case_sensitive: { type: "boolean" },
				cursor: { type: "string", description: "Where the last page said to go on." },
			},
		},
		parseArguments(value) {
			const input = closedArguments(value);
			const query = searchText(input.query, "query");
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
			for (const flag of ["names_only", "case_sensitive"] as const)
				if (input[flag] !== undefined && typeof input[flag] !== "boolean")
					throw new CloudToolArgumentRefusal(`${flag} must be true or false`);
			if (input.cursor !== undefined && (typeof input.cursor !== "string" || !CURSOR_TOKEN.test(input.cursor)))
				throw new CloudToolArgumentRefusal("cursor must be the token a page of this search gave");
			const cursor = input.cursor === undefined ? null : input.cursor;
			return {
				query,
				path,
				glob,
				names_only: input.names_only === true,
				case_sensitive: input.case_sensitive === true,
				cursor,
			};
		},
		async execute(value, context): Promise<CloudToolContent> {
			const input = value as {
				query: string;
				path: string;
				glob: string | null;
				names_only: boolean;
				case_sensitive: boolean;
				cursor: string | null;
			};
			// A cursor goes on only with the search that gave it.
			const asked = JSON.stringify([input.query, input.path, input.glob, input.names_only, input.case_sensitive]);
			const after = input.cursor === null ? null : search.open(input.cursor, asked);
			if (after === undefined)
				throw new CloudToolRefusal(
					"CURSOR_UNKNOWN: that cursor is not one this run's search gave (cursors last for the run); search again",
				);
			if (after === "other")
				throw new CloudToolRefusal(
					"CURSOR_OTHER_SEARCH: that cursor belongs to another search; repeat that search's query, path, glob and flags with it, or search without a cursor",
				);
			let page: SearchPage;
			try {
				page = await search.page(
					{
						query: input.query,
						path: input.path,
						glob: input.glob,
						namesOnly: input.names_only,
						caseSensitive: input.case_sensitive,
						after,
					},
					context.signal,
				);
			} catch (error) {
				if (!(error instanceof FolderLinkError) && !(error instanceof CloudCompanyFolderError)) throw error;
				const code = error instanceof FolderLinkError ? error.code : "";
				if (code === "NOT_FOUND") throw new CloudToolRefusal("NOT_FOUND: no such path in the folder you may read");
				if (code === "BAD_REQUEST")
					throw new CloudToolRefusal("BAD_REQUEST: the folder search refused the request");
				throw new CloudToolRefusal(
					"COMPANY_FOLDER_UNAVAILABLE: the folder could not be searched now; try again, or read with company_read",
				);
			}
			const text = folderSearchText(page, (cursor) => search.seal(cursor, asked));
			// Released before the model sees the page, under the hash of exactly this text; cited by its first release.
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
						"READ_REVOKED: something this page drew on may no longer be read by you, so it is not shown; search again",
					);
				if (error instanceof CloudCompanyFolderError)
					throw new CloudToolRefusal(
						`COMPANY_FOLDER_UNAVAILABLE: what this page read could not be recorded (${error.failure}), so it is not shown; try again`,
					);
				throw error;
			}
			return { kind: "text", value: text, ...(companyReadId ? { companyReadId } : {}) };
		},
	};
}
