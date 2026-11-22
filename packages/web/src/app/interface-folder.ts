import {
	CLOUD_MEMBER_FOLDER_PAGE,
	type CloudMemberFolderClient,
	type CloudMemberFolderFeedPosition,
} from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey, osPath } from "@qorpera/cloud-client/company-state-files";
import {
	decodeInterfaceFile,
	type InterfaceFile,
	type InterfaceProblem,
	parseTableFile,
	parseTableRows,
	TABLE_FILE_MAX_BYTES,
	TABLE_ROWS_MAX_BYTES,
	type TableFile,
	type TableRow,
} from "@qorpera/cloud-client/interfaces";
import { folderSources } from "./interfaces.ts";

/* Every text is parsed here with the cloud client's parsers each time it is read, never taken from a stored parse
 * (§6.1 rule 1).
 *
 * The folder's hint asks the feed what changed, at most once a second, with a one-minute poll behind it, as the Company
 * File page follows it (views/company-folder.ts). Only the files whose paths changed are read again; `resync`, too many
 * changes, or a change to what this member may read reads everything again. A file that is missing, too large or not
 * text is left out, with no error. A read that fails keeps what was read before, and the next sync reads everything
 * again; a first read in which every read failed publishes nothing. Nothing is ever announced. */

/** A problem with a file, in its parser's words, with the line it is on. */
export interface FolderProblem {
	readonly line: number | null;
	readonly message: string;
}

/** A table as its blocks read it: its definition, the rows that fit it and a problem for each row that doesn't
 * (`parseTableRows`). When its definition doesn't parse, or its rows file can't be read at all (a wrong first line),
 * it has no rows and is not `readable`; its problems say why. So it is when one of its files failed to read and was
 * never read before, with no problems: the next sync reads it again. A table without a rows file yet has no rows
 * (§5). */
export interface FolderTable {
	readonly table: TableFile | null;
	readonly rows: readonly TableRow[];
	readonly problems: readonly FolderProblem[];
	readonly readable: boolean;
}

/** What the company's folder says for its shown pages, as last read. */
export interface InterfaceFolderState {
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

const tablePath = (name: string) => osPath(`tables/${name}/table.toml`);
const rowsPath = (name: string) => osPath(`tables/${name}/rows.csv`);
/** A `file:` source reads at most this much (RUNTIME-INTERFACES.md §4). */
const FILE_MAX_BYTES = 256 * 1024;
/** Files read at once. */
const READS_AT_ONCE = 6;
const POLL_MS = 60_000;
const SYNC_DELAY_MS = 1000;
/** Feed pages one sync follows: past that, reading everything again is cheaper (as views/company-folder.ts). */
const FEED_PAGES = 5;
const FEED_LIMIT = CLOUD_MEMBER_FOLDER_PAGE;

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
	readonly #publish: (state: InterfaceFolderState) => void;
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
	/** The shown pages' definitions, whose sources are read. */
	#pages: readonly InterfaceFile[] = [];
	/** Every file read, by its path's key. */
	readonly #reads = new Map<string, Read>();
	/** The versions last published; nothing is published while they stay the same. */
	#shown: string | undefined;

	constructor(source: InterfaceFolderSource, publish: (state: InterfaceFolderState) => void) {
		this.#source = source;
		this.#publish = publish;
		source.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	/** Reads what the shown pages read, then follows the folder: its hint once a read has landed, and the slow poll,
	 * which also tries a failed first read again. */
	async open(): Promise<void> {
		if (this.#disposed) return;
		try {
			this.#client = this.#source.folder();
		} catch {
			return;
		}
		if (!this.#poll) {
			// WHY: Skip periodic folder polls while hidden and trigger a sync once the tab becomes visible.
			this.#poll = setInterval(() => {
				if (typeof document !== "undefined" && document.hidden) return;
				this.#schedule();
			}, POLL_MS);
			if (typeof document !== "undefined")
				document.addEventListener(
					"visibilitychange",
					() => {
						if (!document.hidden) this.#schedule();
					},
					{ signal: this.#stop.signal },
				);
		}
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

	/** Reads what `pages`, the shown pages' definitions, read, in place of what the pages before them read. What is not
	 * read yet is read at the next sync, and what no page reads any more is dropped then. */
	read(pages: readonly InterfaceFile[]): void {
		const before = this.#sourcesKey();
		this.#pages = pages;
		if (this.#sourcesKey() !== before) this.#schedule();
	}

	/** Reads the folder again soon, as its hint would: after a change a page could not make, so it shows what is there
	 * now. */
	sync(): void {
		this.#schedule();
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
		// Before `open`, there is nothing to sync: its first read reads what the pages read then.
		if (this.#disposed || this.#syncTimer || !this.#client) return;
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
	 * not text reads as null. A read that fails keeps the last one and marks the pass. */
	async #read(path: string, max: number, decode: (bytes: Uint8Array) => string | null): Promise<void> {
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
		} catch {
			this.#live();
			this.#failed += 1;
			this.#stale = true;
		}
	}

	/** Reads everything the pages read. A file that can't be read keeps its last read, unless nothing can be. */
	async #reload(): Promise<void> {
		this.#oldest = undefined;
		this.#failed = 0;
		// Until this pass lands whole, the next sync reads everything again too.
		this.#stale = true;
		await this.#readSources(() => true);
		if (this.#failed > 0 && this.#oldest === undefined) throw new Error("Nothing the pages read could be read");
		this.#forget();
		this.#stale = this.#failed > 0;
		// With nothing to read there is no seq to follow from: the next sync reads everything, which is nothing, again.
		this.#position = this.#oldest === undefined ? null : { afterSeq: this.#oldest, cursor: null };
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
				if (event.kind === "change_set")
					for (const change of event.changes) touched.add(companyPathKey(change.path));
			position = page.next;
			if (!page.more) break;
		}
		// Even when nothing changed: what a page reads that isn't read yet is read, and what none reads is dropped.
		await this.#refresh([...touched]);
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
			...files.map((path): [string, number, (bytes: Uint8Array) => string | null] => [
				path,
				FILE_MAX_BYTES,
				markdownText,
			]),
		];
		await each(
			reads.filter(([path]) => again(path) || this.#readOf(path) === undefined),
			([path, max, decode]) => this.#read(path, max, decode),
		);
	}

	#sources(): { tables: string[]; files: string[] } {
		const tables = new Set<string>();
		const files = new Set<string>();
		for (const file of this.#pages) {
			const sources = folderSources(file);
			for (const name of sources.tables) tables.add(name);
			for (const path of sources.files) files.add(path);
		}
		return { tables: [...tables].sort(), files: [...files].sort() };
	}

	/** What the pages read, as one key. */
	#sourcesKey(): string {
		const { tables, files } = this.#sources();
		return JSON.stringify([tables, files]);
	}

	/** Drops what no page reads any more. */
	#forget(): void {
		const { tables, files } = this.#sources();
		const kept = new Set(
			[...tables.flatMap((name) => [tablePath(name), rowsPath(name)]), ...files].map(companyPathKey),
		);
		for (const key of [...this.#reads.keys()]) if (!kept.has(key)) this.#reads.delete(key);
	}

	/** What the folder says for the pages. */
	#state(): InterfaceFolderState {
		const { tables: tableNames, files: filePaths } = this.#sources();
		const tables = new Map<string, FolderTable>();
		// Every file a source names has been tried by now: undefined is a read that failed, which is not a file that
		// isn't there (null). A table whose files could not be read can't be read until the next sync reads them.
		const unread: FolderTable = { table: null, rows: [], problems: [], readable: false };
		for (const name of tableNames) {
			const definition = this.#readOf(tablePath(name));
			if (definition === undefined) tables.set(name, unread);
			if (!definition) continue;
			const rows = this.#readOf(rowsPath(name));
			const parsed = parseTableFile(definition.text);
			if (!parsed.ok) {
				tables.set(name, { table: null, rows: [], problems: problemsOf(parsed.problems), readable: false });
				continue;
			}
			if (rows === undefined) {
				tables.set(name, { ...unread, table: parsed.file });
				continue;
			}
			// A table without its rows file yet has no rows (§5).
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
		return { tables, files };
	}

	/** Publishes what the folder says when a file it was read from, or a folder it listed, changed, or when what the
	 * pages name did. */
	#show(): void {
		const versions = JSON.stringify([
			this.#sourcesKey(),
			[...this.#reads.entries()].map(([key, read]) => [key, read?.version ?? null]).sort(),
		]);
		if (versions === this.#shown) return;
		this.#shown = versions;
		this.#publish(this.#state());
	}
}
