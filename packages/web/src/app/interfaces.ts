/* Interfaces in the web client (contract, 2026-10-02 interfaces amendment, narrowed by the 2026-10-17 scope amendment;
 * RUNTIME-INTERFACES.md). A company has two pages at most, Mailbox and Members (Interfaces C6a). Each is off until an
 * owner or admin switches it on in Settings → Company (app/views/settings-pages.ts; read by app/interface-pages.ts), and
 * the Interfaces tab lists those that are on, in that order. A page is drawn from the definition the web ships (the cloud client's library), never from the
 * company's folder: whatever its interfaces/ holds, Pulse, a page an agent wrote or a file named like one of the two,
 * is never shown, and every other page name, in the tab, a link or a button, is a page that isn't there.
 *
 * Only the parts whose source the client can read are drawn: a part without its source is not drawn, and a page with no
 * part to draw is not listed (the client contract's rule against rendering missing machinery). Those sources are the
 * company's members and what waits for this member, read from the company's live state, its mail
 * (app/interface-mail.ts), and its tables and files that hold no outside content, read from its folder
 * (app/interface-folder.ts). */

import { INTERFACE_LIBRARY } from "@qorpera/cloud-client/interface-library";
import {
	type InterfaceBlock,
	type InterfaceBoardPart,
	type InterfaceButton,
	type InterfaceFile,
	type InterfaceQuery,
	interfaceOutsideColumns,
	parseInterfaceFile,
	type TableFile,
	type TableRow,
	tableRowKey,
} from "@qorpera/cloud-client/interfaces";
import type { MemberInterfaceOffer } from "../cloud/interface-offers.ts";
import { INTERFACE_PAGES } from "../cloud/interface-pages.ts";
import { presentationLocale, t } from "../ui/preferences.ts";
import { type CompanyController, isAgentPairSession } from "./company.ts";
import type { FolderProblem, FolderTable } from "./interface-folder.ts";
import { isMailSource, mailSource, mailSourceRows } from "./interface-mail.ts";
import type { InterfacePagesState } from "./interface-pages.ts";
import {
	fileSourceText,
	folderIdColumn,
	folderSourceColumns,
	folderSourceRows,
	isFolderSource,
	rowInstant,
} from "./interface-sources.ts";

/** A page the Interfaces tab lists: its name and the definition the web ships for it. */
export interface CompanyInterface {
	/** The page's name, its route: `#/c/{id}/i/{name}`. */
	readonly name: string;
	readonly file: InterfaceFile;
}

/** One row a block shows, with where it leads. A row from the company's live state leads to the thread it is
 * about; that link is the platform's, never the file's. */
export interface InterfaceRow {
	readonly row: TableRow;
	readonly href?: string;
	/** The row is about something happening right now (an agent writing). */
	readonly live?: boolean;
	/** The row's identity within its source, which an opened row follows through live updates. */
	readonly key: string;
}

/** The blocks this client draws today. A `detail` or `mail` block is drawn only when a drawn block in its view opens
 * it. */
const DRAWN_BLOCKS: ReadonlySet<InterfaceBlock["kind"]> = new Set([
	"list",
	"table",
	"detail",
	"board",
	"mail",
	"text",
	"numbers",
	"calendar",
]);
/** The blocks that show the row another block opens (`opens`, §3.2). */
const OPENED_KINDS: ReadonlySet<InterfaceBlock["kind"]> = new Set(["detail", "mail"]);
/** The sources this client reads from the company's live state: their columns, and the column `since` and ordering
 * use. */
const LIVE_SOURCES: Readonly<Record<string, { readonly columns: readonly string[]; readonly time: string | null }>> = {
	working: { columns: ["agent", "what", "since"], time: "since" },
	waiting: { columns: ["id", "kind", "title", "from", "due"], time: "due" },
	// One row per member (§4): `id` is what a `member` cell holds, the member's account id, which is also what their
	// `picture` is found by.
	members: { columns: ["id", "name", "picture", "role", "here"], time: null },
};
/** Columns that hold an agent's id: drawn as the agent's name. A table's columns say what they hold by their type. */
const AGENT_COLUMNS: ReadonlySet<string> = new Set(["agent", "from", "handled_by", "kept_by"]);

/** A source as a block reads it. */
export interface InterfaceSource {
	readonly columns: readonly string[];
	readonly time: string | null;
	/** False for a table whose definition doesn't parse or whose rows file can't be read at all: it has no rows. */
	readonly readable: boolean;
	/** The source's own problems: a table's rows that don't fit its definition, or why it can't be read. */
	readonly problems: readonly FolderProblem[];
}

/** The `waiting` kinds whose row has a platform card the member answers in its thread. A mention leads to a
 * conversation, not a card. */
const CARD_KINDS: ReadonlySet<string> = new Set(["review", "question", "mail", "task", "offer", "run"]);
export function rowHasCard(source: string, row: TableRow): boolean {
	return source === "waiting" && typeof row.kind === "string" && CARD_KINDS.has(row.kind);
}

let shipped: readonly CompanyInterface[] | undefined;
/** The definitions the web ships for the two pages, parsed once; the library's others (Pulse) are not among them. A
 * definition that doesn't parse is a bug in the library; it is left out rather than drawn wrong. */
function shippedInterfaces(): readonly CompanyInterface[] {
	shipped ??= INTERFACE_LIBRARY.flatMap((entry) => {
		if (!(INTERFACE_PAGES as readonly string[]).includes(entry.name)) return [];
		const parsed = parseInterfaceFile(entry.interface);
		return parsed.ok ? [{ name: entry.name, file: parsed.file }] : [];
	});
	return shipped;
}

/** The pages `pages` has on, in its order, each with its shipped definition. */
function pagesShown(pages: InterfacePagesState | undefined): CompanyInterface[] {
	return (pages?.pages ?? []).flatMap(({ page, on }) => {
		const entry = on ? shippedInterfaces().find((candidate) => candidate.name === page) : undefined;
		return entry ? [entry] : [];
	});
}

/** The definitions of the pages `pages` has on: what app/interface-folder.ts reads the folder for. */
export function pagesOn(pages: InterfacePagesState | undefined): InterfaceFile[] {
	return pagesShown(pages).map((entry) => entry.file);
}

/** Whether a source's column names are the platform's (the live state's, the mail's and the folder's own files'), so
 * drawn in the member's language. A table's own columns are the company's words. */
export function isLiveSource(source: string): boolean {
	return Object.hasOwn(LIVE_SOURCES, source) || isMailSource(source) || isFolderSource(source);
}

function folderTable(company: CompanyController, source: string): FolderTable | undefined {
	if (!source.startsWith("table:")) return undefined;
	return company.store.get().interfaceFolder?.tables.get(source.slice("table:".length));
}

/** A table source's definition as last read from the folder, or null. */
export function tableDefinition(company: CompanyController, source: string): TableFile | null {
	return folderTable(company, source)?.table ?? null;
}

/** The row an open offer names (step I9c), with its table's folder name and definition, as the folder read has them; or
 * undefined when it names no row of a table read here, or the cell is not what the offer read any more (the save that
 * changed it settles the offer). */
export function offeredRow(
	company: CompanyController,
	offer: MemberInterfaceOffer,
): { readonly table: string; readonly definition: TableFile; readonly row: TableRow } | undefined {
	const { key, column, folder } = offer;
	if (offer.state !== "open" || key === null || column === null || !folder?.startsWith("tables/")) return undefined;
	const table = folder.slice("tables/".length);
	const read = folderTable(company, `table:${table}`);
	const definition = read?.table ?? null;
	if (!read || definition === null || definition.id.toLowerCase() !== offer.table) return undefined;
	const named = JSON.stringify(key);
	const row = read.rows.find((candidate) => tableRowKey(definition, candidate) === named);
	const held = row?.[column] ?? null;
	return row !== undefined && (held === "" ? null : held) === offer.was ? { table, definition, row } : undefined;
}

/** A `file:` source's text, without its settings block. A file whose text is outside content (under `hooks/` or
 * `human-tasks/`, §4) is not read: the blocks can't show it with its outside-content mark yet (the 2026-10-02 interfaces
 * amendment, item 3). */
function folderText(company: CompanyController, source: string): string | undefined {
	if (!source.startsWith("file:") || interfaceOutsideColumns(source).length > 0) return undefined;
	const path = source.slice("file:".length);
	const text = company.store.get().interfaceFolder?.files.get(path);
	return text === undefined ? undefined : fileSourceText(path, text);
}

/** A source this client can read, or undefined: the live state's, and a folder-v2 company's tables, files and own
 * files' sources (`vision`, `agents`, ...) once its folder is read. */
export function interfaceSource(company: CompanyController, source: string): InterfaceSource | undefined {
	const live = Object.hasOwn(LIVE_SOURCES, source) ? LIVE_SOURCES[source] : undefined;
	if (live) return { ...live, readable: true, problems: [] };
	const mail = mailSource(company, source);
	if (mail) return { ...mail, readable: true, problems: [] };
	if (isFolderSource(source)) {
		const read = company.store.get().interfaceFolder?.sources.get(source);
		return read && { ...folderSourceColumns(source), readable: read.readable, problems: read.problems };
	}
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

/** What a column's values are the ids of, so a page shows names: the live sources' agent columns, the folder sources'
 * id columns, and a table's `agent`, `member` and `agents` columns (§5: "a stable id; the client shows the name"). */
export function idColumn(
	company: CompanyController,
	source: string,
	column: string,
): "agent" | "member" | "agents" | "members" | null {
	if (isFolderSource(source)) return folderIdColumn(source, column);
	if (source.startsWith("table:")) {
		const type = folderTable(company, source)?.table?.columns.find((candidate) => candidate.name === column)?.type;
		return type === "agent" || type === "member" || type === "agents" ? type : null;
	}
	if (source === "members") return column === "id" ? "member" : null;
	if (source === "mail_addresses") return column === "handled_by" ? "agents" : null;
	return AGENT_COLUMNS.has(column) ? "agent" : null;
}

/** A board's parts this client draws, with their place among the block's parts: those whose table it can read, and
 * that have every column a view built from another narrows by. */
export function drawnParts(
	block: InterfaceBlock,
	company: CompanyController,
	narrow: readonly NonNullable<InterfaceQuery["where"]>[] = [],
): { readonly part: InterfaceBoardPart; readonly index: number }[] {
	return block.parts.flatMap((part, index) => {
		const columns = interfaceSource(company, part.from)?.columns;
		return columns !== undefined &&
			narrow.every((where) => Object.keys(where).every((name) => columns.includes(name)))
			? [{ part, index }]
			: [];
	});
}

/** Whether this client can draw a block: its kind is drawn here and it reads one source the client has; a board, when
 * it can read one of its parts' tables; a text block with its own text, always; a calendar, when it can read one of
 * its sources (§3.2, proposed: it draws from those it can). A `mail` block draws a mail thread, so it reads `mail` and
 * nothing else. A text, numbers or calendar block doesn't read `mail`: a thread has no text, the threads are read a page
 * at a time, so a tile or a day would count only those read so far, and neither marks the outside values it would show
 * (§4). */
export function drawableBlock(block: InterfaceBlock, company: CompanyController): boolean {
	if (block.kind === "board") return drawnParts(block, company).length > 0;
	if (!DRAWN_BLOCKS.has(block.kind)) return false;
	if (block.kind === "text" && block.text !== null) return true;
	if (block.kind === "mail" && block.from[0] !== "mail") return false;
	if ((block.kind === "text" || block.kind === "numbers" || block.kind === "calendar") && block.from.includes("mail"))
		return false;
	const has = (source: string) => interfaceSource(company, source) !== undefined;
	if (block.kind === "calendar") return block.from.some(has);
	return block.from.length === 1 && has(block.from[0] ?? "");
}

/** The details a block opens: a list's, a table's or a numbers block's `opens`, and each board part's. */
function blockOpens(block: InterfaceBlock, parts: readonly InterfaceBoardPart[] = block.parts): string[] {
	if (block.kind === "board") return parts.flatMap((part) => (part.opens === null ? [] : [part.opens]));
	return (block.kind === "list" || block.kind === "table" || block.kind === "numbers") && block.opens !== null
		? [block.opens]
		: [];
}

/** The folder sources a page's drawn blocks could read, which app/interface-folder.ts reads: the tables of its drawn
 * blocks, of its boards' parts, of its tables' lookup columns and of its `needs`, the files of those blocks that hold
 * no outside content, and the folder's own files' sources they name (`sources`: `vision`, `agents`, ...). A detail
 * block counts only where a block in its view opens it, as `viewBlocks` draws it. */
export function folderSources(file: InterfaceFile): {
	readonly tables: string[];
	readonly files: string[];
	readonly sources: string[];
} {
	const tables = new Set<string>();
	const files = new Set<string>();
	const sources = new Set<string>();
	for (const need of file.needs) if (need.startsWith("table:")) tables.add(need.slice("table:".length));
	for (const view of file.views) {
		const opened = new Set(view.blocks.flatMap((block) => blockOpens(block)));
		for (const block of view.blocks) {
			// A `mail` block reads only `mail`, which is not in the folder.
			if (
				!DRAWN_BLOCKS.has(block.kind) ||
				block.kind === "mail" ||
				(block.kind === "detail" && !opened.has(block.id ?? ""))
			)
				continue;
			const named = [
				...block.from,
				...(block.kind === "board" ? block.parts.map((part) => part.from) : []),
				...(block.kind === "table" ? Object.values(block.lookups).map((lookup) => lookup.from) : []),
			];
			for (const source of named) {
				if (source.startsWith("table:")) tables.add(source.slice("table:".length));
				else if (source.startsWith("file:") && interfaceOutsideColumns(source).length === 0)
					files.add(source.slice("file:".length));
				else if (isFolderSource(source)) sources.add(source);
			}
		}
	}
	return { tables: [...tables], files: [...files], sources: [...sources] };
}

/** The column of each quote source's rows that names the record its outside values came from, which a quote of them
 * carries as its `ref`: a mail row's thread (RUNTIME-INTERFACES.md §4; the member mail read's `thread`, step I5a).
 * The columns that carry outside content are the cloud client's (`interfaceOutsideColumns`). */
export const QUOTE_RECORD_COLUMNS: Readonly<Record<string, string>> = {
	mail: "thread",
};

/** A block in a view. A view built from another (`from_view`) shows that view's blocks and narrows each with its
 * own `where`: rows must match both, the view's filter first, then the block's own query. */
export interface ViewBlock {
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

/** The blocks of a view this client draws, in their order: the drawable ones, and a `detail` or `mail` block that one
 * of them (or a board part drawn) opens. A block a view narrows by a column its source doesn't have is left out of that
 * view: it could only ever look empty. A board is left out when none of its parts has the columns. */
export function viewBlocks(view: InterfaceViewShape, company: CompanyController): ViewBlock[] {
	const fits = ({ block, narrow }: ViewBlock) => {
		if (block.kind === "board") return drawnParts(block, company, narrow).length > 0;
		if (!drawableBlock(block, company)) return false;
		// A text block's own text has no rows to narrow; a calendar narrows each source it can.
		if (block.kind === "text" && block.text !== null) return true;
		const has = (source: string) => {
			const columns = interfaceSource(company, source)?.columns;
			return (
				columns !== undefined &&
				narrow.every((where) => Object.keys(where).every((column) => columns.includes(column)))
			);
		};
		return block.kind === "calendar" ? block.from.some(has) : has(block.from[0] ?? "");
	};
	const drawn = view.blocks.filter((shown) => !OPENED_KINDS.has(shown.block.kind) && fits(shown));
	const opened = new Set(
		drawn.flatMap(({ block, narrow }) =>
			blockOpens(
				block,
				drawnParts(block, company, narrow).map(({ part }) => part),
			),
		),
	);
	return view.blocks.filter(
		(shown) =>
			drawn.includes(shown) ||
			(OPENED_KINDS.has(shown.block.kind) && shown.block.id !== null && fits(shown) && opened.has(shown.block.id)),
	);
}

/** A button as this client draws it. */
export type DrawnButton =
	| { readonly verb: "answer"; readonly label: string }
	| { readonly verb: "message"; readonly label: string; readonly to: string; readonly text: string }
	| { readonly verb: "open"; readonly label: string; readonly target: string };

/** The buttons a block shows here. A member draws only what a member can do: `who = "agents"` is left out, and so
 * are the verbs whose machinery this client lacks today (add, set, offer and a file's own take and release buttons
 * write tables; `open file:` needs a file route). A board draws its built-in take, release and offer itself, and an
 * offer's answers on its card; answer on a waiting offer is its Accept and Not now (views/interface.ts, step I9c). */
export function blockButtons(file: InterfaceFile, block: InterfaceBlock): DrawnButton[] {
	return block.buttons.flatMap((name): DrawnButton[] => {
		if (name === "answer") return [{ verb: "answer", label: t("Answer") }];
		const button: InterfaceButton | undefined = file.buttons.find((candidate) => candidate.id === name);
		if (!button || button.who === "agents") return [];
		if (button.verb === "answer") return [{ verb: "answer", label: button.label }];
		if (button.verb === "message" && button.to !== null)
			return [{ verb: "message", label: button.label, to: button.to, text: button.text ?? "" }];
		if (
			button.verb === "open" &&
			button.target !== null &&
			(button.target === "row" || button.target.startsWith("agent:") || button.target.startsWith("interface:"))
		)
			return [{ verb: "open", label: button.label, target: button.target }];
		return [];
	});
}

function needsMet(file: InterfaceFile, company: CompanyController): boolean {
	return file.needs.every((need) => {
		if (need === "team") return (company.store.get().team?.members.length ?? 0) >= 2;
		// A table is there when its folder holds its definition (step I7), or may be when its read failed: the page is
		// listed and its table says it can't be read.
		if (need.startsWith("table:"))
			return company.store.get().interfaceFolder?.tables.has(need.slice("table:".length)) === true;
		// The company has a live mailbox when the member mail read lists an address (step I5c); its answer is empty while
		// the company's mail is off. No member can read the company's connections here yet.
		if (need === "mail") return (company.store.get().mail?.addresses.length ?? 0) > 0;
		return false;
	});
}

/** Owners and admins: who "owners" means in a file, and who is told about the company's interfaces. */
function ownerOrAdmin(company: CompanyController): boolean {
	const role = company.store.get().team?.role;
	return role === "owner" || role === "admin";
}

/** Whether this member may change a table's rows: a member who may write at all, where `[write] members` is `all`,
 * or `owners` and they are an owner or admin (§5; the save check's rule 5). */
export function memberMayWriteRows(company: CompanyController, table: TableFile): boolean {
	if (company.store.get().team?.capabilities.write !== true) return false;
	return table.write.members === "all" || (table.write.members === "owners" && ownerOrAdmin(company));
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

/** The pages the Interfaces tab lists: of Mailbox and Members, those that are on and listed for this member. Until the
 * company's pages are read, and on a cloud that can't say, there are none. */
export function companyInterfaces(company: CompanyController): CompanyInterface[] {
	return pagesShown(company.store.get().interfacePages).filter(({ file }) => listed(file, company));
}

export function companyInterface(company: CompanyController, name: string): CompanyInterface | undefined {
	return companyInterfaces(company).find((entry) => entry.name === name);
}

/** The rows of a source this client reads, or undefined when it can't read it. */
export function interfaceRows(company: CompanyController, source: string): InterfaceRow[] | undefined {
	if (isMailSource(source)) return mailSourceRows(company, source);
	const state = company.store.get();
	if (isFolderSource(source)) return folderSourceRows(company, state.interfaceFolder, source);
	const profileId = company.profile.profileId;
	const agents = state.staff.filter((agent) => agent.employmentStatus === "active");
	const agentHref = (agentId: string) =>
		agentId === company.cofounderId() ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agentId}`;
	// To the second, as every row's time is: the live state's times may carry milliseconds.
	const since = (agentId: string) => rowInstant(company.activityFor(agentId)?.updatedAt);
	// A waiting item is its kind and its run: when one is answered and another comes for the same agent, an open
	// row never turns into the new one.
	const runKey = (kind: string, agentId: string) => `${kind}:${company.activityFor(agentId)?.runId ?? agentId}`;
	if (source === "working") {
		return agents.flatMap((agent) => {
			const now = company.agentState(agent.id);
			if (now !== "working" && now !== "writing") return [];
			// A run with no progress for 15 minutes says so, since its last progress.
			const stalled = company.noProgress(agent.id);
			const what = stalled ? t("No progress") : now === "writing" ? t("Writing") : t("Working");
			return [
				{
					row: { agent: agent.id, what, since: rowInstant(stalled?.since) ?? since(agent.id) },
					href: agentHref(agent.id),
					live: true,
					key: `working:${agent.id}`,
				},
			];
		});
	}
	if (source === "waiting") {
		const rows: InterfaceRow[] = [];
		for (const agent of agents) {
			const now = company.agentState(agent.id);
			if (now === "decision") {
				rows.push({
					row: {
						id: agent.id,
						// An agent waiting on a member's decision: an action or change for review.
						kind: "review",
						title: t("{name} needs you", { name: agent.displayName }),
						from: agent.id,
						due: since(agent.id),
					},
					href: agentHref(agent.id),
					key: runKey("review", agent.id),
				});
			} else if (now === "failed") {
				rows.push({
					row: {
						id: agent.id,
						kind: "run",
						title: t("{name} has a run that did not finish", { name: agent.displayName }),
						from: agent.id,
						due: since(agent.id),
					},
					href: agentHref(agent.id),
					key: runKey("run", agent.id),
				});
			}
		}
		for (const [sessionId, count] of Object.entries(state.mentions ?? {})) {
			const session = state.sessions.find((item) => item.sessionId === sessionId);
			// Only conversations the rail itself offers: open ones, never an agent pair's transcript.
			if (!session || count <= 0 || session.status !== "open" || isAgentPairSession(session)) continue;
			rows.push({
				row: {
					id: sessionId,
					kind: "mention",
					title: t("You were mentioned in {conversation}", { conversation: session.title }),
					from: session.staffAgentId ?? null,
					due: null,
				},
				href: `#/c/${profileId}/chat/${sessionId}`,
				key: `mention:${sessionId}`,
			});
		}
		// A cell another member offers this one (step I9c), answered on the row itself: its offer is the row's id.
		for (const offer of state.interfaceOffers?.offers ?? []) {
			const offered = offer.to === company.userId ? offeredRow(company, offer) : undefined;
			if (!offered) continue;
			const { definition, row } = offered;
			// The row by its first text that isn't empty, else by its key.
			const words = definition.columns
				.map((column) => (column.type === "text" ? row[column.name] : null))
				.find((value): value is string => typeof value === "string" && value !== "");
			const from = state.team?.members.find((member) => member.userId === offer.from);
			rows.push({
				row: {
					id: offer.id,
					kind: "offer",
					title: t("{name} offers you “{row}” in {table}", {
						name: from?.displayName || from?.email || t("A member"),
						row: words ?? (offer.key ?? []).map(String).join(", "),
						table: definition.name || offered.table,
					}),
					from: null,
					// The cloud's time is to the microsecond; a row's is to the second, so `since` and ordering read it.
					due: rowInstant(offer.at),
				},
				key: `offer:${offer.id}`,
			});
		}
		return rows;
	}
	if (source === "members") {
		// Who is here comes from presence, which lists the others; the member looking is here too. Alone, the company
		// joins no presence, and nobody is.
		const here = state.here;
		const collator = new Intl.Collator(presentationLocale(), { sensitivity: "base" });
		return (state.team?.members ?? [])
			.map((member) => ({ member, name: member.displayName || member.email }))
			.sort((a, b) => collator.compare(a.name, b.name) || (a.member.userId < b.member.userId ? -1 : 1))
			.map(({ member, name }) => ({
				row: {
					id: member.userId,
					name,
					picture: member.userId,
					role: member.role,
					here:
						here !== undefined &&
						(member.userId === company.userId || here.some((present) => present.userId === member.userId)),
				},
				key: `members:${member.userId}`,
			}));
	}
	// A table's rows that fit its definition, each known by its key, so an open row stays open while its other
	// columns change.
	const table = folderTable(company, source);
	if (table) {
		const definition = table.table;
		return definition ? table.rows.map((row) => ({ row, key: `${source}:${tableRowKey(definition, row)}` })) : [];
	}
	// A file is one row: its text.
	const text = folderText(company, source);
	if (text !== undefined) return [{ row: { text }, key: source }];
	return undefined;
}
