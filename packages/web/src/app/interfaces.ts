/* Interfaces in the web client (contract, 2026-10-02 interfaces amendment, narrowed by the 2026-10-17 scope amendment;
 * RUNTIME-INTERFACES.md). A company has three pages at most, Mailbox, Members (Interfaces C6a) and Bank. Each is off
 * until an owner or admin switches it on in Settings → Company (app/views/settings-pages.ts; read by
 * app/interface-pages.ts), and the Interfaces tab lists those that are on, in that order. A page is drawn from the
 * definition the web ships (the cloud client's library; Bank's is app/bank-page.ts and views/bank.ts draws it), never
 * from the company's folder: whatever its QorperaOS/interfaces/ holds, Pulse, a page an agent wrote or a file named like
 * one of the three, is never shown, and every other page name, in the tab, a link or a button, is a page that isn't
 * there. */

import { AREAS_TABLE, INTERFACE_LIBRARY } from "@qorpera/cloud-client/interface-library";
import {
	type InterfaceBlock,
	type InterfaceFile,
	type InterfaceQuery,
	interfaceOutsideColumns,
	parseInterfaceFile,
	parseTableFile,
} from "@qorpera/cloud-client/interfaces";
import { INTERFACE_PAGES } from "../cloud/interface-pages.ts";
import { BANK_INTERFACE } from "./bank-page.ts";
import type { CompanyController } from "./company.ts";
import { DATA_INTERFACE, DATA_PAGE } from "./data-page.ts";
import type { FolderProblem, FolderTable } from "./interface-folder.ts";
import { mailSource } from "./interface-mail.ts";
import type { InterfacePagesState } from "./interface-pages.ts";
import { fileSourceText } from "./interface-sources.ts";

/** A page the Interfaces tab lists: its name and the definition the web ships for it. */
export interface CompanyInterface {
	/** The page's name, its route: `#/c/{id}/i/{name}`. */
	readonly name: string;
	readonly file: InterfaceFile;
}

const DRAWN_BLOCKS: ReadonlySet<InterfaceBlock["kind"]> = new Set(["list", "table", "detail", "text"]);
/** The blocks that show the row another block opens (`opens`, §3.2). */
const OPENED_KINDS: ReadonlySet<InterfaceBlock["kind"]> = new Set(["detail"]);
/** The sources this client reads from the company's live state: their columns, and the column `since` and ordering
 * use. */
const LIVE_SOURCES: Readonly<Record<string, { readonly columns: readonly string[]; readonly time: string | null }>> = {
	waiting: { columns: ["id", "kind", "title", "from", "due"], time: "due" },
	members: { columns: ["id", "name", "picture", "role", "here"], time: null },
};
/** A source as a block reads it. */
export interface InterfaceSource {
	readonly columns: readonly string[];
	readonly time: string | null;
	/** False for a table whose definition doesn't parse or whose rows file can't be read at all: it has no rows. */
	readonly readable: boolean;
	/** The source's own problems: a table's rows that don't fit its definition, or why it can't be read. */
	readonly problems: readonly FolderProblem[];
}

/** The sources the shipped pages never draw: Members' cards (Interfaces C6d). A company's folder keeps its cards
 * table and the library still seeds it; the page just doesn't read it. */
const HIDDEN_SOURCES: ReadonlySet<string> = new Set(["table:cards"]);

function withoutHiddenSources(file: InterfaceFile): InterfaceFile {
	const hidden = (source: string) => HIDDEN_SOURCES.has(source);
	return {
		...file,
		views: file.views.map((view) => ({
			...view,
			blocks: view.blocks
				.filter((block) => !block.from.some(hidden))
				.map((block) => {
					const lookups = Object.entries(block.lookups);
					const dropped = new Set(lookups.flatMap(([column, lookup]) => (hidden(lookup.from) ? [column] : [])));
					return {
						...block,
						parts: block.parts.filter((part) => !hidden(part.from)),
						columns: block.columns.filter((column) => !dropped.has(column)),
						lookups: Object.fromEntries(lookups.filter(([column]) => !dropped.has(column))),
					};
				}),
		})),
	};
}

let shipped: readonly CompanyInterface[] | undefined;
/** The definitions the web ships for the three pages, parsed once, without what reads a hidden source; the library's
 * others (Pulse) are not among them. A definition that doesn't parse is a bug in the library; it is left out rather
 * than drawn wrong. */
function shippedInterfaces(): readonly CompanyInterface[] {
	shipped ??= [
		...INTERFACE_LIBRARY,
		{ name: "bank", interface: BANK_INTERFACE },
		{ name: DATA_PAGE, interface: DATA_INTERFACE },
	].flatMap((entry) => {
		// WHY: The cloud still lists the retired Members page; Settings → Team and the rail's People carry what it gave.
		if (entry.name === "members" || !(INTERFACE_PAGES as readonly string[]).includes(entry.name)) return [];
		const parsed = parseInterfaceFile(entry.interface);
		return parsed.ok ? [{ name: entry.name, file: withoutHiddenSources(parsed.file) }] : [];
	});
	return shipped;
}

/** Whether the member's rail shows a page: unless they hid it, or, on a cloud from before each member's own choice,
 * while the company has it on. */
function pageShown(pages: InterfacePagesState, entry: InterfacePagesState["pages"][number]): boolean {
	return pages.personal ? entry.hidden !== true : entry.on;
}

/** The pages the member's rail shows, in its order, each with its shipped definition. */
function pagesShown(pages: InterfacePagesState | undefined): CompanyInterface[] {
	if (!pages) return [];
	return pages.pages.flatMap((each) => {
		const entry = pageShown(pages, each)
			? shippedInterfaces().find((candidate) => candidate.name === each.page)
			: undefined;
		return entry ? [entry] : [];
	});
}

/** The definitions of the pages `pages` has on: what app/interface-folder.ts reads the folder for. */
export function pagesOn(pages: InterfacePagesState | undefined): InterfaceFile[] {
	return pagesShown(pages).map((entry) => entry.file);
}

let noAreas: FolderTable | undefined;
function folderTable(company: CompanyController, source: string): FolderTable | undefined {
	if (!source.startsWith("table:")) return undefined;
	const name = source.slice("table:".length);
	const folder = company.store.get().interfaceFolder;
	const read = folder?.tables.get(name);
	if (read || !folder || name !== "areas") return read;
	if (noAreas === undefined) {
		const parsed = parseTableFile(AREAS_TABLE);
		noAreas = parsed.ok
			? { table: parsed.file, rows: [], problems: [], readable: true }
			: { table: null, rows: [], problems: [], readable: false };
	}
	return noAreas;
}

/** A `file:` source's text, without its settings block. A file whose text is outside content (under `hooks/` or
 * `QorperaOS/human-tasks/`, §4) is not read: the blocks can't show it with its outside-content mark yet (the 2026-10-02
 * interfaces amendment, item 3). The source names the file's whole path, as `file:QorperaOS/rules/shared-areas.md`. */
function folderText(company: CompanyController, source: string): string | undefined {
	if (!source.startsWith("file:") || interfaceOutsideColumns(source).length > 0) return undefined;
	const path = source.slice("file:".length);
	const text = company.store.get().interfaceFolder?.files.get(path);
	return text === undefined ? undefined : fileSourceText(path, text);
}

export function interfaceSource(company: CompanyController, source: string): InterfaceSource | undefined {
	const live = Object.hasOwn(LIVE_SOURCES, source) ? LIVE_SOURCES[source] : undefined;
	if (live) return { ...live, readable: true, problems: [] };
	const mail = mailSource(company, source);
	if (mail) return { ...mail, readable: true, problems: [] };
	const table = folderTable(company, source);
	if (table)
		return {
			columns: table.table?.columns.map((column) => column.name) ?? [],
			time: table.table?.time ?? null,
			readable: table.readable,
			problems: table.problems,
		};
	if (folderText(company, source) !== undefined)
		return { columns: ["text"], time: null, readable: true, problems: [] };
	return undefined;
}

export function drawableBlock(block: InterfaceBlock, company: CompanyController): boolean {
	if (!DRAWN_BLOCKS.has(block.kind)) return false;
	if (block.kind === "text" && block.text !== null) return true;
	if (block.kind === "text" && block.from.includes("mail")) return false;
	const has = (source: string) => interfaceSource(company, source) !== undefined;
	return block.from.length === 1 && has(block.from[0] ?? "");
}

function blockOpens(block: InterfaceBlock): string[] {
	return (block.kind === "list" || block.kind === "table") && block.opens !== null ? [block.opens] : [];
}

export function folderSources(file: InterfaceFile): {
	readonly tables: string[];
	readonly files: string[];
} {
	const tables = new Set<string>();
	const files = new Set<string>();
	for (const need of file.needs) if (need.startsWith("table:")) tables.add(need.slice("table:".length));
	for (const view of file.views) {
		const opened = new Set(view.blocks.flatMap((block) => blockOpens(block)));
		for (const block of view.blocks) {
			if (!DRAWN_BLOCKS.has(block.kind) || (block.kind === "detail" && !opened.has(block.id ?? ""))) continue;
			const named = [
				...block.from,
				...(block.kind === "table" ? Object.values(block.lookups).map((lookup) => lookup.from) : []),
			];
			for (const source of named) {
				if (source.startsWith("table:")) tables.add(source.slice("table:".length));
				else if (source.startsWith("file:") && interfaceOutsideColumns(source).length === 0)
					files.add(source.slice("file:".length));
			}
		}
	}
	return { tables: [...tables], files: [...files] };
}

/** The column of each quote source's rows that names the record its outside values came from, which a quote of them
 * carries as its `ref`: a mail row's thread (RUNTIME-INTERFACES.md §4; the member mail read's `thread`, step I5a).
 * The columns that carry outside content are the cloud client's (`interfaceOutsideColumns`). */
export const QUOTE_RECORD_COLUMNS: Readonly<Record<string, string>> = {
	mail: "thread",
};

/** A block in a view. A view built from another (`from_view`) shows that view's blocks and narrows each with its
 * own `where`: rows must match both, the view's filter first, then the block's own query. */
interface ViewBlock {
	readonly block: InterfaceBlock;
	/** The `where` of every view this one is built from, each narrowing the next; empty for a view's own blocks. */
	readonly narrow: readonly NonNullable<InterfaceQuery["where"]>[];
}

export interface InterfaceViewShape {
	readonly name: string;
	readonly blocks: readonly ViewBlock[];
}

export function interfaceViews(file: InterfaceFile): InterfaceViewShape[] {
	const resolved: InterfaceViewShape[] = [];
	for (const view of file.views) {
		// The parser lets from_view name only a view above this one, so it has been resolved already.
		const base = view.fromView === null ? undefined : resolved.find((above) => above.name === view.fromView);
		const where = view.where;
		const blocks: ViewBlock[] =
			base === undefined
				? view.blocks.map((block) => ({ block, narrow: [] }))
				: base.blocks.map((shown) => ({
						block: shown.block,
						narrow: where ? [...shown.narrow, where] : shown.narrow,
					}));
		resolved.push({ name: view.name, blocks });
	}
	return resolved;
}

export function viewBlocks(view: InterfaceViewShape, company: CompanyController): ViewBlock[] {
	const fits = ({ block, narrow }: ViewBlock) => {
		if (!drawableBlock(block, company)) return false;
		if (block.kind === "text" && block.text !== null) return true;
		const has = (source: string) => {
			const columns = interfaceSource(company, source)?.columns;
			return (
				columns !== undefined &&
				narrow.every((where) => Object.keys(where).every((column) => columns.includes(column)))
			);
		};
		return has(block.from[0] ?? "");
	};
	const drawn = view.blocks.filter((shown) => !OPENED_KINDS.has(shown.block.kind) && fits(shown));
	const opened = new Set(drawn.flatMap(({ block }) => blockOpens(block)));
	return view.blocks.filter(
		(shown) =>
			drawn.includes(shown) ||
			(OPENED_KINDS.has(shown.block.kind) && shown.block.id !== null && fits(shown) && opened.has(shown.block.id)),
	);
}

function needsMet(file: InterfaceFile, company: CompanyController): boolean {
	return file.needs.every((need) => {
		if (need === "team") return (company.store.get().team?.members.length ?? 0) >= 2;
		// A table is there when its folder holds its definition (step I7), or may be when its read failed: the page is
		// listed and its table says it can't be read.
		if (need.startsWith("table:"))
			return company.store.get().interfaceFolder?.tables.has(need.slice("table:".length)) === true;
		// The Mailbox shows from the start (Jonas, 7 Nov 2026): with no address yet, its page says so and offers one.
		if (need === "mail") return true;
		return false;
	});
}

/** Owners and admins: who "owners" means in a file, and who is told about the company's interfaces. */
function ownerOrAdmin(company: CompanyController): boolean {
	const role = company.store.get().team?.role;
	return role === "owner" || role === "admin";
}

/** Whether `[access] members` lets this member see the page. It only narrows: the data is read with the
 * member's own rights either way. "owners" means owners and admins, as for `edit`. */
function memberMaySee(file: InterfaceFile, company: CompanyController): boolean {
	const access = file.access.members;
	if (access === "all") return true;
	if (access === "owners") return ownerOrAdmin(company);
	return access.includes(company.userId);
}

/** Whether the tab lists a page that is on: this member may see it, its needs are met, and it has a part this client
 * can draw. */
function listed(file: InterfaceFile, company: CompanyController): boolean {
	return (
		memberMaySee(file, company) &&
		needsMet(file, company) &&
		interfaceViews(file).some((view) => viewBlocks(view, company).length > 0)
	);
}

export function companyHasData(company: CompanyController): boolean {
	return (company.store.get().companyData?.databases.length ?? 0) > 0;
}

const pageHere = (company: CompanyController, name: string) => name !== DATA_PAGE || companyHasData(company);

/** The pages the Interfaces tab lists: of Mailbox and Members, those that are on and listed for this member. Until the
 * company's pages are read, and on a cloud that can't say, there are none. */
export function companyInterfaces(company: CompanyController): CompanyInterface[] {
	return pagesShown(company.store.get().interfacePages).filter(
		({ name, file }) => listed(file, company) && pageHere(company, name),
	);
}

/** The pages the member hid from their own rail that would show there again: they may see them and their needs are
 * met. Empty on a cloud from before each member's own choice. */
export function hiddenInterfaces(company: CompanyController): CompanyInterface[] {
	const pages = company.store.get().interfacePages;
	if (!pages?.personal) return [];
	return pages.pages.flatMap(({ page, hidden }) => {
		const entry = hidden ? shippedInterfaces().find((candidate) => candidate.name === page) : undefined;
		return entry && memberMaySee(entry.file, company) && needsMet(entry.file, company) && pageHere(company, page)
			? [entry]
			: [];
	});
}

export function companyInterface(company: CompanyController, name: string): CompanyInterface | undefined {
	return companyInterfaces(company).find((entry) => entry.name === name);
}
