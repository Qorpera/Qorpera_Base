import type { CloudMemberFolderClient, CloudMemberFolderFeedPosition } from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import {
	decodeInterfaceFile,
	INTERFACE_FILE_MAX_BYTES,
	INTERFACE_ORDER_MAX_BYTES,
	type InterfaceFile,
	type InterfaceProblem,
	isInterfaceName,
	parseInterfaceFile,
	parseInterfaceOrderFile,
	parseTableFile,
	parseTableRows,
	TABLE_FILE_MAX_BYTES,
	TABLE_ROWS_MAX_BYTES,
	type TableFile,
	type TableRow,
} from "@qorpera/cloud-client/interfaces";
import { folderSources } from "./interfaces.ts";

/* A folder-v2 company's interfaces and tables, read from its folder (Interfaces step I7; deploy/first-node/
 * RUNTIME-INTERFACES.md §2–§5, §8 and §10). Every `interfaces/<name>/interface.toml` is read with `interfaces/order.md`,
 * and the tables and files the pages' drawn blocks read (app/interfaces.ts, `folderSources`), all with the member's
 * own authority. app/interfaces.ts turns what is read into the Interfaces tab and the pages.
 *
 * Every text is parsed here with the cloud client's parsers each time it is read, never taken from a stored parse
 * (§6.1 rule 1). A page whose text doesn't parse is kept with its problems: a broken page, whose buttons never render.
 *
 * The folder's hint asks the feed what changed, at most once a second, with a one-minute poll behind it, as the Company
 * File page follows it (views/company-folder.ts). Only the files whose paths changed are read again; `resync`, too many
 * changes, or a change to what this member may read reads everything again. A file that is missing, too large or not
 * text is left out, with no error. A read that fails keeps what was read before, and the next sync reads everything
 * again; a first read that fails leaves the tab to the library's definitions. Nothing is ever announced. */

/** A problem with a file, in its parser's words, with the line it is on. */
export interface FolderProblem {
	readonly line: number | null;
	readonly message: string;
}

/** An interface folder's page: its parse, or the problems that keep its text from parsing (a broken page). */
export type FolderPage =
	| { readonly name: string; readonly file: InterfaceFile }
	| { readonly name: string; readonly file: null; readonly problems: readonly FolderProblem[] };

/** A table as its blocks read it: its definition, the rows that fit it and a problem for each row that doesn't
 * (`parseTableRows`). When its definition doesn't parse, or its rows file can't be read at all (a wrong first line),
 * it has no rows and is not `readable`; its problems say why. A table without a rows file yet has no rows (§5). */
export interface FolderTable {
	readonly table: TableFile | null;
	readonly rows: readonly TableRow[];
	readonly problems: readonly FolderProblem[];
	readonly readable: boolean;
}

/** What the company's folder says about its interfaces, as last read. */
export interface InterfaceFolderState {
	/** The interface ids `interfaces/order.md` lists, in its order; none when it doesn't parse. */
	readonly order: readonly string[];
	/** Every interface folder's page, by folder name. */
	readonly pages: readonly FolderPage[];
	/** The tables the pages' drawn blocks and needs name, by table name; a table that isn't there is left out. */
	readonly tables: ReadonlyMap<string, FolderTable>;
	/** The `file:` sources the pages' drawn blocks read, by the path the source names; a file that isn't there is left
	 * out. */
	readonly files: ReadonlyMap<string, string>;
}

/** What this reader needs from the product: the member's folder, its hint, and the company's lifetime. */
export interface InterfaceFolderSource {
	readonly signal: AbortSignal;
	current(): void;
	folder(): Pick<CloudMemberFolderClient, "read" | "list" | "readFile" | "changes">;
	folderHints(onHint: (seq: number) => void): { close(): Promise<void> };
}

const ORDER = "interfaces/order.md";
const pagePath = (name: string) => `interfaces/${name}/interface.toml`;
const tablePath = (name: string) => `tables/${name}/table.toml`;
const rowsPath = (name: string) => `tables/${name}/rows.csv`;
/** A `file:` source reads at most this much (RUNTIME-INTERFACES.md §4). */
const FILE_MAX_BYTES = 256 * 1024;
const LIST_PAGE = 1000;
const MAX_LISTED = 10_000;
/** Files read at once. */
const READS_AT_ONCE = 6;
const POLL_MS = 60_000;
const SYNC_DELAY_MS = 1000;
/** Feed pages one sync follows: past that, reading everything again is cheaper (as views/company-folder.ts). */
const FEED_PAGES = 5;
const FEED_LIMIT = 500;

/** A file as last read: its text at a version, or null when it isn't there, is too large or isn't text. */
type Read = { readonly version: string; readonly text: string } | null;

/** Markdown text, strictly UTF-8 (a byte order mark is dropped), or null. */
function markdownText(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function problemsOf(problems: readonly InterfaceProblem[]): FolderProblem[] {
	return problems.map(({ line, message }) => ({ line, message }));
}

/** Runs `work` over `items`, a few at a time. */
async function each<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await work(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, worker));
}

export class CompanyInterfaceFolder {
	readonly #source: InterfaceFolderSource;
	readonly #publish: (state: InterfaceFolderState | undefined) => void;
	readonly #stop = new AbortController();
	#client?: Pick<CloudMemberFolderClient, "read" | "list" | "readFile" | "changes">;
	#hints?: { close(): Promise<void> };
	#poll?: ReturnType<typeof setInterval>;
	#syncTimer?: ReturnType<typeof setTimeout>;
	#busy = false;
	#disposed = false;
	/** Where the feed is followed from: everything up to it has been read. Null until everything is read once. */
	#position: CloudMemberFolderFeedPosition | null = null;
	/** The oldest seq this pass's reads were answered at: a read of everything is followed from there. */
	#oldest: number | undefined;
	/** A read failed: the next sync reads everything again rather than follow the feed. */
	#stale = false;
	/** Reads that failed in this pass. */
	#failed = 0;
	/** The interface folders' names, sorted. */
	#names: string[] = [];
	/** Every file read, by its path's key. */
	readonly #reads = new Map<string, Read>();
	/** Each page text's parse, kept while its read is: a pass parses a text once. */
	readonly #parses = new WeakMap<NonNullable<Read>, FolderPage>();
	/** The versions last published; nothing is published while they stay the same. */
	#shown: string | undefined;

	constructor(source: InterfaceFolderSource, publish: (state: InterfaceFolderState | undefined) => void) {
		this.#source = source;
		this.#publish = publish;
		source.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	/** Reads the company's interfaces, then follows the folder: its hint once a read has landed, and the slow poll,
	 * which also tries a failed first read again. */
	async open(): Promise<void> {
		if (this.#disposed) return;
		try {
			this.#client = this.#source.folder();
		} catch {
			return;
		}
		this.#poll ??= setInterval(() => this.#schedule(), POLL_MS);
		await this.#run(() => this.#reload());
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stop.abort();
		clearInterval(this.#poll);
		clearTimeout(this.#syncTimer);
		void this.#hints?.close();
	}

	// ---- lifetime -------------------------------------------------------------

	#signal(): AbortSignal {
		return AbortSignal.any([this.#stop.signal, this.#source.signal]);
	}

	#live(): void {
		this.#stop.signal.throwIfAborted();
		this.#source.current();
	}

	/** One pass at a time. A pass that fails leaves what was published; the next hint or poll tries again. */
	async #run(pass: () => Promise<void>): Promise<void> {
		if (this.#busy || this.#disposed) return;
		this.#busy = true;
		try {
			this.#live();
			await pass();
			this.#live();
			this.#show();
			this.#follow();
		} catch {
			/* Nothing is announced: the tab keeps what it shows. */
		} finally {
			this.#busy = false;
		}
	}

	/** Joins the folder's hint, once. */
	#follow(): void {
		if (this.#hints) return;
		try {
			this.#hints = this.#source.folderHints(() => this.#schedule());
		} catch {
			/* The hint is a nudge; the slow poll keeps the interfaces current without it. */
		}
	}

	#schedule(): void {
		if (this.#disposed || this.#syncTimer) return;
		this.#syncTimer = setTimeout(() => {
			this.#syncTimer = undefined;
			if (this.#busy) {
				this.#schedule();
				return;
			}
			void this.#run(() => this.#sync());
		}, SYNC_DELAY_MS);
	}

	// ---- reading ----------------------------------------------------------------

	/** A file's last read: undefined when it hasn't been read. */
	#readOf(path: string): Read | undefined {
		return this.#reads.get(companyPathKey(path));
	}

	/** Reads a file's text when its version changed since the last read. A file that is missing, larger than `max` or
	 * not text reads as null. A read that fails keeps the last one and marks the pass, unless `strict`. */
	async #read(path: string, max: number, decode: (bytes: Uint8Array) => string | null, strict = false): Promise<void> {
		const key = companyPathKey(path);
		try {
			const read = await this.#client!.read(path, this.#signal());
			this.#live();
			this.#oldest = Math.min(this.#oldest ?? read.asOfSeq, read.asOfSeq);
			const file = read.entry?.kind === "file" ? read.entry.file : null;
			if (!read.entry || !file || file.bytes > max) {
				this.#reads.set(key, null);
				return;
			}
			if (this.#reads.get(key)?.version === read.entry.version) return;
			const bytes = await this.#client!.readFile(file, this.#signal(), max);
			this.#live();
			const text = decode(bytes);
			this.#reads.set(key, text === null ? null : { version: read.entry.version, text });
		} catch (error) {
			this.#live();
			if (strict) throw error;
			this.#failed += 1;
			this.#stale = true;
		}
	}

	/** The interface folders' names, every page of the listing. */
	async #listInterfaces(): Promise<string[]> {
		const names: string[] = [];
		let after: string | null = null;
		let listed = 0;
		for (;;) {
			const page = await this.#client!.list("interfaces", after, LIST_PAGE, this.#signal());
			this.#live();
			this.#oldest = Math.min(this.#oldest ?? page.asOfSeq, page.asOfSeq);
			for (const entry of page.entries) {
				const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
				if (entry.kind === "folder" && isInterfaceName(name)) names.push(name);
			}
			listed += page.entries.length;
			if (page.next === null || listed >= MAX_LISTED) return names.sort();
			after = page.next;
		}
	}

	/** Reads everything: the order file, every page, and what their drawn blocks read. The order file and the listing
	 * must be read; a page that can't be read is left out (or keeps its last read), unless none can. */
	async #reload(): Promise<void> {
		this.#oldest = undefined;
		this.#failed = 0;
		// Until this pass lands whole, the next sync reads everything again too.
		this.#stale = true;
		await this.#read(ORDER, INTERFACE_ORDER_MAX_BYTES, decodeInterfaceFile, true);
		const names = await this.#listInterfaces();
		await each(names, (name) => this.#read(pagePath(name), INTERFACE_FILE_MAX_BYTES, decodeInterfaceFile));
		if (names.length > 0 && this.#failed === names.length) throw new Error("No interface could be read");
		this.#names = names;
		await this.#readSources(() => true);
		this.#forget();
		this.#stale = this.#failed > 0;
		this.#position = { afterSeq: this.#oldest ?? 0, cursor: null };
	}

	/** Asks the feed what changed since the last pass, and reads those files again. */
	async #sync(): Promise<void> {
		let position = this.#position;
		if (!position || this.#stale) {
			await this.#reload();
			return;
		}
		const touched = new Set<string>();
		for (let pages = 0; ; pages++) {
			if (pages === FEED_PAGES) {
				await this.#reload();
				return;
			}
			const page = await this.#client!.changes(position, FEED_LIMIT, this.#signal());
			this.#live();
			// `resync`: the position can't be continued. An authority change may change what this member may read
			// anywhere. Either way everything is read again.
			if (page.resync || !page.next || page.events.some((event) => event.kind === "authority")) {
				await this.#reload();
				return;
			}
			for (const event of page.events)
				if (event.kind === "change_set") for (const change of event.changes) touched.add(companyPathKey(change.path));
			position = page.next;
			if (!page.more) break;
		}
		if (touched.size) await this.#refresh([...touched]);
		// Moved on only once the changed files are read: a pass that fails follows the same changes again.
		this.#position = position;
	}

	/** Reads again the files under the paths that changed (a folder's change covers what is in it). */
	async #refresh(touched: readonly string[]): Promise<void> {
		this.#failed = 0;
		const hit = (path: string) => {
			const key = companyPathKey(path);
			return touched.some((changed) => key === changed || key.startsWith(`${changed}/`));
		};
		if (hit(ORDER)) await this.#read(ORDER, INTERFACE_ORDER_MAX_BYTES, decodeInterfaceFile);
		const names = new Set(this.#names);
		for (const changed of touched) {
			const [root, name] = changed.split("/");
			if (root === "interfaces" && name !== undefined && isInterfaceName(name)) names.add(name);
		}
		const pages = [...names].sort();
		await each(
			pages.filter((name) => hit(pagePath(name)) || this.#readOf(pagePath(name)) === undefined),
			(name) => this.#read(pagePath(name), INTERFACE_FILE_MAX_BYTES, decodeInterfaceFile),
		);
		// A folder whose page is gone (deleted, moved away, never written) lists no page; one that failed to read stays.
		this.#names = pages.filter((name) => this.#readOf(pagePath(name)) !== null);
		await this.#readSources(hit);
		this.#forget();
	}

	/** Reads the tables and files the pages' drawn blocks read: those `again` names, and those not read yet. */
	async #readSources(again: (path: string) => boolean): Promise<void> {
		const { tables, files } = this.#sources();
		const reads: [string, number, (bytes: Uint8Array) => string | null][] = [
			...tables.flatMap((name): [string, number, (bytes: Uint8Array) => string | null][] => [
				[tablePath(name), TABLE_FILE_MAX_BYTES, decodeInterfaceFile],
				[rowsPath(name), TABLE_ROWS_MAX_BYTES, decodeInterfaceFile],
			]),
			...files.map((path): [string, number, (bytes: Uint8Array) => string | null] => [path, FILE_MAX_BYTES, markdownText]),
		];
		await each(
			reads.filter(([path]) => again(path) || this.#readOf(path) === undefined),
			([path, max, decode]) => this.#read(path, max, decode),
		);
	}

	/** The pages' texts parsed, by folder name. */
	#pages(): FolderPage[] {
		return this.#names.flatMap((name): FolderPage[] => {
			const read = this.#readOf(pagePath(name));
			if (!read) return [];
			let page = this.#parses.get(read);
			if (!page) {
				const parsed = parseInterfaceFile(read.text);
				page = parsed.ok ? { name, file: parsed.file } : { name, file: null, problems: problemsOf(parsed.problems) };
				this.#parses.set(read, page);
			}
			return [page];
		});
	}

	/** The tables and files the active pages' drawn blocks and needs name. */
	#sources(): { tables: string[]; files: string[] } {
		const tables = new Set<string>();
		const files = new Set<string>();
		for (const page of this.#pages()) {
			if (page.file === null || page.file.status !== "active") continue;
			const sources = folderSources(page.file);
			for (const name of sources.tables) tables.add(name);
			for (const path of sources.files) files.add(path);
		}
		return { tables: [...tables].sort(), files: [...files].sort() };
	}

	/** Drops what no page reads any more. */
	#forget(): void {
		const { tables, files } = this.#sources();
		const kept = new Set(
			[ORDER, ...this.#names.map(pagePath), ...tables.flatMap((name) => [tablePath(name), rowsPath(name)]), ...files].map(
				companyPathKey,
			),
		);
		for (const key of [...this.#reads.keys()]) if (!kept.has(key)) this.#reads.delete(key);
	}

	/** What the folder says, or undefined while it keeps no order file (a company seeded before P16b, of which there
	 * should be none): the Interfaces tab then keeps the library's definitions. */
	#state(): InterfaceFolderState | undefined {
		const order = this.#readOf(ORDER);
		if (!order) return undefined;
		// An order file that doesn't parse lists nothing: every interface follows by name (§8).
		const listed = parseInterfaceOrderFile(order.text);
		const { tables: tableNames, files: filePaths } = this.#sources();
		const tables = new Map<string, FolderTable>();
		for (const name of tableNames) {
			const definition = this.#readOf(tablePath(name));
			if (!definition) continue;
			const parsed = parseTableFile(definition.text);
			if (!parsed.ok) {
				tables.set(name, { table: null, rows: [], problems: problemsOf(parsed.problems), readable: false });
				continue;
			}
			const rows = this.#readOf(rowsPath(name));
			const read = rows ? parseTableRows(parsed.file, rows.text) : { rows: [], problems: [], readable: true };
			tables.set(name, {
				table: parsed.file,
				rows: read.rows,
				problems: problemsOf(read.problems),
				readable: read.readable,
			});
		}
		const files = new Map<string, string>();
		for (const path of filePaths) {
			const read = this.#readOf(path);
			if (read) files.set(path, read.text);
		}
		return { order: listed.ok ? listed.file.ids : [], pages: this.#pages(), tables, files };
	}

	/** Publishes what the folder says when a file it was read from changed. */
	#show(): void {
		const versions = JSON.stringify([
			this.#names,
			[...this.#reads.entries()].map(([key, read]) => [key, read?.version ?? null]).sort(),
		]);
		if (versions === this.#shown) return;
		this.#shown = versions;
		this.#publish(this.#state());
	}
}
