/* An interface page (`#/c/{id}/i/{name}`): the company's definition, or the library's until its folder is read
 * (app/interfaces.ts), drawn from the fixed blocks with the company's live state and its tables. Every value is read
 * with the member's own authority through the store the rest of the app reads; the file only arranges blocks and
 * names sources. Text from a file is set as text, never markup. A page whose text doesn't parse shows its problems
 * and nothing else. */

import {
	compareInterfaceValues,
	fillInterfaceText,
	interfaceCell,
	interfaceLookupIndex,
	plainText,
	queryInterfaceRows,
} from "@qorpera/cloud-client/interface-query";
import {
	INTERFACE_OUTSIDE_VALUES_MAX,
	INTERFACE_QUOTE_SOURCES,
	type InterfaceBlock,
	type InterfaceBoardPart,
	type InterfaceFile,
	type InterfaceQuery,
	interfaceOutsideColumns,
	type TableFile,
	type TableRow,
	type TableValue,
	tableRowKey,
} from "@qorpera/cloud-client/interfaces";
import { describeError } from "../../cloud/client.ts";
import { WebCompanyFolderRejectedError } from "../../cloud/company-folder-writes.ts";
import { type MessageQuote, QUOTE_MAX_CHARACTERS, quoteRefFits } from "../../cloud/quotes.ts";
import type { HostedProfileRole, HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { boardDrag } from "../../ui/board-drag.ts";
import { button, fmtTime, h, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { isPhoneLayout } from "../../ui/layout.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationLocale, presentationTimeZone, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { type BoardLane, boardLanes } from "../interface-board.ts";
import { type ClaimVerb, claimFailure, claimTableCell, type InterfaceWrites } from "../interface-claims.ts";
import type { FolderProblem } from "../interface-folder.ts";
import {
	blockButtons,
	companyInterface,
	companyInterfaces,
	type DrawnButton,
	drawnParts,
	type InterfaceRow,
	idColumn,
	interfaceRows,
	interfaceSource,
	interfaceViews,
	isLiveSource,
	memberMayWriteRows,
	QUOTE_RECORD_COLUMNS,
	rowHasCard,
	tableDefinition,
	type ViewBlock,
	viewBlocks,
} from "../interfaces.ts";
import type { QuotedText } from "../quotes.ts";
import {
	type BlockExtra,
	type CalendarSource,
	calendarColumn,
	calendarDays,
	calendarQuery,
	drawExtraBlock,
	folderCellLabel,
	folderColumnLabel,
	numberTiles,
} from "./interface-blocks.ts";
import { roleLabel } from "./team.ts";

/** What each container last showed, and the element that shows it. The page area is shared with every other
 * page, so a redraw is skipped only while that element is still the one on screen. */
const shownIn = new WeakMap<HTMLElement, { key: string; element: Element }>();

/** Draws `build()` unless the same key is on screen. Every control names itself with `data-focus-key`, so the
 * one that had keyboard focus (and an input's caret) has it again after the redraw; `moveFocus` names another. A
 * page redrawn in the same view keeps its scroll position (`data-scroll-key`). */
function show(container: HTMLElement, key: string, build: () => HTMLElement, moveFocus?: string): void {
	const shown = shownIn.get(container);
	if (shown?.key === key && container.firstElementChild === shown.element && shown.element.isConnected) return;
	const active = document.activeElement;
	const focusKey =
		moveFocus ?? (active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : undefined);
	const caret =
		active instanceof HTMLInputElement ? ([active.selectionStart, active.selectionEnd] as const) : undefined;
	const scrolled =
		shown && container.firstElementChild === shown.element
			? shown.element.querySelector<HTMLElement>("[data-scroll-key]")
			: null;
	const element = build();
	replace(container, element);
	shownIn.set(container, { key, element });
	const scroller = element.querySelector<HTMLElement>("[data-scroll-key]");
	if (scrolled && scroller && scroller.dataset.scrollKey === scrolled.dataset.scrollKey)
		scroller.scrollTop = scrolled.scrollTop;
	if (focusKey === undefined) return;
	const again = [...element.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
		(candidate) => candidate.dataset.focusKey === focusKey,
	);
	again?.focus({ preventScroll: true });
	if (again instanceof HTMLInputElement && caret && again === document.activeElement)
		again.setSelectionRange(caret[0], caret[1]);
}

/** What the member chose on a page: its view, the row each opened block shows, and each table's sort and filter.
 * It lasts while the app is open, per member, company and interface. */
interface PageState {
	view: string | null;
	open: Record<string, string>;
	sort: Record<string, { readonly column: string; readonly descending: boolean }>;
	filter: Record<string, string>;
	error: string | null;
	/** Whether the error has been drawn once: later redraws keep it on the page without announcing it again. */
	errorShown: boolean;
	/** How many errors this page has had, so the same words failing again are drawn and announced again. */
	errors: number;
	/** The message buttons whose thread is still opening: they stay disabled through redraws. */
	pending: string[];
	/** The board cards whose take or release is on its way, by card, with their holder cell as it was (as JSON). A card
	 * stays where it was, saving, until its save lands and the board shows the change (or a little after the save). */
	claiming: Record<string, { readonly was: string; readonly landed: boolean }>;
	/** A refused save's problems, listed under the error. */
	errorProblems: string[];
	/** A control the next draw focuses: the tab an arrow key chose, the Back button or the row a detail closed to. */
	focus: string | null;
}
const pages = new Map<string, PageState>();
function pageState(key: string): PageState {
	let state = pages.get(key);
	if (!state) {
		state = {
			view: null,
			open: {},
			sort: {},
			filter: {},
			error: null,
			errorShown: false,
			errors: 0,
			pending: [],
			claiming: {},
			errorProblems: [],
			focus: null,
		};
		pages.set(key, state);
	}
	return state;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** An id an element can carry, from any text. */
function domId(...parts: string[]): string {
	return `iface-${parts.join("-").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** The platform's column names, in the member's language. A table's own columns are the company's words. */
function columnLabel(source: string, column: string): string {
	const folder = folderColumnLabel(source, column);
	if (folder !== undefined) return folder;
	if (isLiveSource(source)) {
		const label: Record<string, () => string> = {
			agent: () => t("Agent"),
			what: () => t("What"),
			since: () => t("Since"),
			kind: () => t("Kind"),
			title: () => t("Title"),
			from: () => t("From"),
			due: () => t("Due"),
			...(source === "members"
				? {
						id: () => t("Member"),
						name: () => t("Name"),
						picture: () => t("Picture"),
						role: () => t("Role"),
						here: () => t("Here now"),
					}
				: {}),
		};
		const known = label[column];
		if (known) return known();
	}
	const words = column.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What waits, in the member's language. */
function kindLabel(kind: string): string {
	const label: Record<string, () => string> = {
		review: () => t("Approval"),
		run: () => t("Unfinished run"),
		mention: () => t("Mention"),
		question: () => t("Question"),
		mail: () => t("Email"),
		task: () => t("Task"),
		offer: () => t("Offer"),
	};
	return label[kind]?.() ?? kind;
}

/** `writes` lets a board take and release cards (step I9a); without it the page draws no take or release. */
export function renderInterface(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	writes?: InterfaceWrites,
): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const locale = presentationLocale();
	if (state.loading && !state.staff.length) {
		show(container, JSON.stringify(["loading", profileId, locale]), () =>
			h("section", { class: "page interface-waiting" }, spinner(t("Opening company"))),
		);
		return;
	}
	if (state.error && !state.staff.length) {
		show(container, JSON.stringify(["error", profileId, locale, state.error]), () =>
			h(
				"section",
				{ class: "page interface-waiting" },
				notice(
					"danger",
					state.error ?? "",
					button(t("Retry company"), () => void company.refreshAll(), { small: true }),
				),
			),
		);
		return;
	}
	const entry = companyInterface(company, name);
	if (!entry) {
		show(container, JSON.stringify(["missing", profileId, locale, name]), () =>
			h(
				"section",
				{ class: "page interface-missing" },
				h("p", null, t("This page isn't available here yet.")),
				h("a", { href: `#/c/${profileId}` }, t("Back to the company")),
			),
		);
		return;
	}
	if (entry.file === null) {
		renderBrokenInterface(container, company, name, entry.problems);
		return;
	}
	// Every redraw the page asks for (a tab, a sort, an opened row, a message that failed after the file changed)
	// finds the definition again, so a page never draws a definition the company has since changed or broken.
	renderInterfaceFile(
		container,
		company,
		name,
		entry.file,
		() => renderInterface(container, company, name, writes),
		writes,
	);
}

/** Each definition as JSON, made once: a page is drawn again whenever anything it is drawn from changes. */
const definitions = new WeakMap<InterfaceFile, string>();
function definitionKey(file: InterfaceFile): string {
	let key = definitions.get(file);
	if (key === undefined) {
		key = JSON.stringify(file);
		definitions.set(file, key);
	}
	return key;
}

/** A parser's problems, each with its line, in its own words under the client's. */
function problemList(problems: readonly FolderProblem[]): HTMLElement {
	return h(
		"ul",
		{ class: "interface-problems" },
		...problems.map(({ line, message }) =>
			h("li", null, line === null ? message : t("Line {line}: {problem}", { line, problem: message })),
		),
	);
}

/** A page whose text doesn't parse (RUNTIME-INTERFACES.md §10, I7): its name and its problems, and nothing drawn from
 * it, so none of its buttons. */
function renderBrokenInterface(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	problems: readonly FolderProblem[],
): void {
	const profileId = company.profile.profileId;
	// An error from before the text broke (a message that failed) belongs to a page that is gone: it isn't shown
	// when the page parses again.
	const page = pageState(`${company.userId}/${profileId}/${name}`);
	page.error = null;
	page.errorShown = false;
	show(container, JSON.stringify(["broken", profileId, presentationLocale(), name, problems]), () =>
		h(
			"section",
			{ class: "interface interface-broken", "data-interface": name, "data-profile": profileId },
			h(
				"header",
				{ class: "interface-head" },
				interfaceEmblem(null, null, 30),
				h("div", { class: "interface-title" }, h("h1", null, name)),
			),
			h(
				"div",
				{ class: "interface-page" },
				h(
					"section",
					{ class: "interface-block interface-width-full interface-problem" },
					h("p", null, t("This page has a problem.")),
					problemList(problems),
				),
			),
		),
	);
}

/** One block as drawn: the rows it shows, in its query's order, and for a `detail` block the row it has open. */
interface DrawnBlock {
	readonly block: InterfaceBlock;
	readonly source: string;
	readonly key: string;
	readonly rows: readonly InterfaceRow[];
	/** The detail this block opens, when that detail is drawn in this view. */
	readonly opens: string | null;
	readonly open?: InterfaceRow;
	/** A cell's value as text, by what its source's column holds: an agent's or a member's name for an id. */
	readonly nameOf: (column: string, value: unknown) => string;
	/** False for a table that can't be read at all: the block shows only its problems. */
	readonly readable: boolean;
	/** The source's own problems: a table's rows that don't fit its definition, or why it can't be read. */
	readonly problems: readonly FolderProblem[];
	/** A board's parts drawn and its lanes. */
	readonly board?: { readonly parts: readonly DrawnPart[]; readonly lanes: readonly BoardLane[] };
	/** A numbers block's tiles or a calendar's days (views/interface-blocks.ts). */
	readonly extra?: BlockExtra;
	/** A calendar's sources as drawn, each with its rows. */
	readonly calendar?: readonly CalendarSource[];
}

/** One board part as drawn: its table's rows, as the block's query keeps them, and what the member may do with them. */
interface DrawnPart {
	/** Its place among the block's parts. */
	readonly index: number;
	readonly part: InterfaceBoardPart;
	readonly source: string;
	/** Its table's folder name, for a part from a table. */
	readonly table: string | null;
	readonly definition: TableFile | null;
	readonly rows: readonly InterfaceRow[];
	/** The detail its cards open, when that detail is drawn in this view. */
	readonly opens: string | null;
	readonly nameOf: (column: string, value: unknown) => string;
	readonly readable: boolean;
	readonly problems: readonly FolderProblem[];
	/** Whether the member may change its table's rows (`[write] members`). */
	readonly mayWrite: boolean;
}

/** A card's name on the page: its part and its row. */
const cardKey = (part: DrawnPart, item: InterfaceRow) => `${part.index}:${item.key}`;

/** A card's holder cell as JSON, as a claim remembers it. */
const holderCell = (part: DrawnPart, item: InterfaceRow) =>
	JSON.stringify(part.definition?.holder ? (item.row[part.definition.holder] ?? null) : null);

/** Draws an interface definition. `renderInterface` finds the definition, and finds it again for every redraw the
 * page asks for (`redraw`); tests pass one directly, and redraw that one. */
export function renderInterfaceFile(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	file: InterfaceFile,
	again?: () => void,
	writes?: InterfaceWrites,
): void {
	const redraw = again ?? (() => renderInterfaceFile(container, company, name, file, undefined, writes));
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const locale = presentationLocale();
	const page = pageState(`${company.userId}/${profileId}/${name}`);
	const views = interfaceViews(file)
		.map((view) => ({ name: view.name, blocks: viewBlocks(view, company) }))
		.filter((view) => view.blocks.length > 0);
	const viewIndex = Math.max(
		0,
		views.findIndex((candidate) => candidate.name === page.view),
	);
	const view = views[viewIndex];
	if (!view) return;
	const now = Date.now();
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const clock = { now, startOfToday: today.getTime() };
	const memberName = (id: string) => state.team?.members.find((member) => member.userId === id)?.displayName;
	/** A cell as text: an agent's or a member's name for an id its source's column holds (§5), else its value. */
	const namesFor =
		(source: string) =>
		(column: string, value: unknown): string => {
			const ids = idColumn(company, source, column);
			if (ids === "agent" && typeof value === "string") return company.staffById(value)?.displayName ?? value;
			if (ids === "member" && typeof value === "string") return memberName(value) ?? value;
			if (ids === "agents" && Array.isArray(value))
				return value.map((id: string) => company.staffById(id)?.displayName ?? id).join(", ");
			if (ids === "members" && Array.isArray(value))
				return value.map((id: string) => memberName(id) ?? id).join(", ");
			return plainText(value as never);
		};
	/** A table block's lookup columns (§3.2) on each row: for the row's id (its `id`, or its table's one key), the
	 * other table's rows whose `match` column holds it, as the names of what they `show`, or how many there are. A
	 * lookup whose table can't be read is empty. A column the source has itself is never looked up. */
	const withLookups = (block: InterfaceBlock, source: string, rows: InterfaceRow[]): InterfaceRow[] => {
		const own = interfaceSource(company, source)?.columns ?? [];
		const lookups = Object.entries(block.lookups).filter(([column]) => !own.includes(column));
		if (block.kind !== "table" || lookups.length === 0) return rows;
		const key = tableDefinition(company, source)?.key;
		const single = key?.length === 1 ? key[0] : undefined;
		const idOf = (row: TableRow) => {
			const id = interfaceCell(row, "id") ?? (single === undefined ? undefined : interfaceCell(row, single));
			return typeof id === "string" ? id : null;
		};
		const found = lookups.map(([column, lookup]) => {
			const read = interfaceSource(company, lookup.from);
			const index = read?.readable
				? interfaceLookupIndex(
						lookup,
						(interfaceRows(company, lookup.from) ?? []).map(({ row }) => row),
					)
				: null;
			const names = namesFor(lookup.from);
			const listsAgents = lookup.show !== null && idColumn(company, lookup.from, lookup.show) === "agents";
			const shown = (value: string) =>
				lookup.show === null ? value : names(lookup.show, listsAgents ? [value] : value);
			return { column, index, shown };
		});
		return rows.map((item) => {
			const id = idOf(item.row);
			const looked: Record<string, TableValue> = {};
			for (const { column, index, shown } of found) {
				const value = index === null || id === null ? null : index(id);
				looked[column] = Array.isArray(value) ? value.map(shown) : value;
			}
			return { ...item, row: { ...item.row, ...looked } };
		});
	};
	const sourceRows = (
		source: string,
		narrow: ViewBlock["narrow"],
		query: InterfaceQuery,
		block: InterfaceBlock | null = null,
	) => {
		const time = interfaceSource(company, source)?.time ?? null;
		// A view built from another narrows the rows first; the block's own query then filters, orders and limits them.
		let rows = interfaceRows(company, source) ?? [];
		for (const where of narrow) {
			const kept = new Set(
				queryInterfaceRows(
					rows.map((row) => row.row),
					{ where, since: null, order: null, limit: null, latestBy: null },
					{ time, clock },
				),
			);
			rows = rows.filter((row) => kept.has(row.row));
		}
		// Lookup columns are columns like the others: the query can filter and order by them.
		if (block !== null) rows = withLookups(block, source, rows);
		const byRow = new Map<TableRow, InterfaceRow>(rows.map((row) => [row.row, row]));
		return queryInterfaceRows(
			rows.map((row) => row.row),
			query,
			{ time, clock },
		).flatMap((row) => byRow.get(row) ?? []);
	};
	const details = new Set(
		view.blocks.flatMap(({ block }) => (block.kind === "detail" && block.id !== null ? [block.id] : [])),
	);
	const nameOf = namesFor("");
	// A board's lanes are the company's members now; a holder who left is named where presence still knows them.
	const people = {
		viewer: company.userId,
		members: (state.team?.members ?? []).map((member) => ({
			id: member.userId,
			name: member.displayName || member.email,
		})),
		formerName: (id: string) => state.here?.find((present) => present.userId === id)?.name || undefined,
	};
	const boardOf = ({ block, narrow }: ViewBlock): DrawnBlock["board"] => {
		const parts = drawnParts(block, company, narrow).map(({ part, index }): DrawnPart => {
			const read = interfaceSource(company, part.from);
			const definition = tableDefinition(company, part.from);
			return {
				index,
				part,
				source: part.from,
				table: part.from.startsWith("table:") ? part.from.slice("table:".length) : null,
				definition,
				rows: sourceRows(part.from, narrow, block.query),
				opens: part.opens !== null && details.has(part.opens) ? part.opens : null,
				nameOf: namesFor(part.from),
				readable: read?.readable ?? true,
				problems: read?.problems ?? [],
				mayWrite: definition !== null && memberMayWriteRows(company, definition),
			};
		});
		const lanes = boardLanes(
			block,
			parts.map(({ definition, rows }) => ({ table: definition, rows })),
			people,
		);
		return { parts, lanes };
	};
	/** A calendar's sources: those it can read that have every column its view narrows by (§3.2, proposed). */
	const calendarOf = ({ block, narrow }: ViewBlock): CalendarSource[] =>
		block.from.flatMap((from) => {
			const read = interfaceSource(company, from);
			if (!read || !narrow.every((where) => Object.keys(where).every((column) => read.columns.includes(column))))
				return [];
			const definition = tableDefinition(company, from);
			const kind = from === "routines" ? t("Routine") : from === "human_tasks" ? t("Task") : definition?.name;
			return [
				{
					source: from,
					rows: sourceRows(from, narrow, calendarQuery(block, read.columns)),
					column: calendarColumn(read.time, definition),
					kind: kind ?? from,
					agent: read.columns.find((column) => idColumn(company, from, column) === "agent") ?? null,
					definition,
				},
			];
		});
	const blocks: DrawnBlock[] = view.blocks.map((shown, index) => {
		const { block } = shown;
		const key = block.id ?? `${view.name}#${index}`;
		const source = block.from[0] ?? "";
		const board = block.kind === "board" ? boardOf(shown) : undefined;
		const calendar = block.kind === "calendar" ? calendarOf(shown) : undefined;
		const rows = board || calendar ? [] : sourceRows(source, shown.narrow, block.query, block);
		const read = interfaceSource(company, source);
		// A calendar can be read while one of its sources can; it lists every source's problems.
		const reads = calendar ? calendar.map((part) => interfaceSource(company, part.source)) : [read];
		// A numbers block's tiles are its query's rows; their change and trend come from every row its query keeps.
		const all = { ...block.query, order: null, limit: null, latestBy: null };
		const extra: BlockExtra | undefined =
			block.kind === "numbers"
				? {
						kind: "numbers",
						tiles: numberTiles(block, rows, sourceRows(source, shown.narrow, all), {
							time: read?.time ?? null,
							definition: tableDefinition(company, source),
							nameOf: namesFor(source),
							now: clock.now,
						}),
					}
				: calendar
					? { kind: "calendar", days: calendarDays(block, calendar, clock.now) }
					: undefined;
		const drawn = {
			block,
			source,
			key,
			rows,
			// A row opens only into a detail drawn here; otherwise it keeps its own link.
			opens: block.opens !== null && details.has(block.opens) ? block.opens : null,
			nameOf: namesFor(source),
			readable: reads.length === 0 || reads.some((candidate) => candidate?.readable ?? true),
			problems: reads.flatMap((candidate) => candidate?.problems ?? []),
			...(board ? { board } : {}),
			...(extra ? { extra } : {}),
			...(calendar ? { calendar } : {}),
		};
		if (block.kind !== "detail" || block.id === null) return drawn;
		const opened = page.open[block.id];
		const open = opened === undefined ? undefined : rows.find((row) => row.key === opened);
		return { ...drawn, ...(open ? { open } : {}) };
	});
	// A part-width block whose neighbours have no source today stands alone, so it takes the whole row.
	const widths = blocks.map(({ block }, index) => {
		if (block.width === "full") return "full";
		const partner = (at: number) => blocks[at] !== undefined && blocks[at]?.block.width !== "full";
		return partner(index - 1) || partner(index + 1) ? block.width : "full";
	});
	// The agents a page names, draws or offers a button for (a button may name one by id), by how they look and
	// whether they still work here, and the members it names.
	const buttonAgents = file.buttons.flatMap((button) =>
		[button.to, button.target?.startsWith("agent:") ? button.target.slice("agent:".length) : null].filter(
			(id): id is string => id !== null && !id.startsWith("{") && id !== "co-founder",
		),
	);
	const drawnSources = blocks.flatMap(
		({ source, rows, board, calendar }): { source: string; rows: readonly InterfaceRow[] }[] =>
			board ? [...board.parts] : calendar ? [...calendar] : [{ source, rows }],
	);
	const named = (want: "agent" | "member") =>
		drawnSources.flatMap(({ source, rows }) =>
			rows.flatMap(({ row }) =>
				Object.entries(row).flatMap(([column, value]): string[] => {
					const ids = idColumn(company, source, column);
					if (ids === "agents" && want === "agent" && Array.isArray(value)) return [...value];
					if (ids === "members" && want === "member" && Array.isArray(value)) return [...value];
					return ids === want && typeof value === "string" ? [value] : [];
				}),
			),
		);
	const agentLooks = [...new Set([...buttonAgents, ...named("agent")])].map((id) => {
		const agent = company.staffById(id);
		return [id, agent?.displayName, agent?.appearance, agent?.employmentStatus];
	});
	const memberNames = [...new Set(named("member"))].map((id) => [id, memberName(id)]);
	const live = state.realtime === "connected";
	const canWrite = state.team?.capabilities.write === true;
	const listed = companyInterfaces(company).map((entry) => entry.name);
	const cofounder = company.cofounderId();
	const moveFocus = page.focus ?? undefined;
	page.focus = null;
	// A card whose save landed is drawn where it was until the board shows the change; then it is drawn as it is.
	const cards = new Map(
		blocks.flatMap(({ board }) =>
			(board?.parts ?? []).flatMap((part) => part.rows.map((item) => [cardKey(part, item), holderCell(part, item)])),
		),
	);
	page.claiming = Object.fromEntries(
		Object.entries(page.claiming).filter(([card, claim]) => !claim.landed || cards.get(card) === claim.was),
	);
	const hasOpen = blocks.some((drawn) => drawn.open !== undefined);
	// The whole definition, so a change to anything drawn from it (a table's columns, a list's line, a button's
	// text) draws the page again with the handlers of the new one, even when the rows and titles stay the same.
	const key = JSON.stringify([
		profileId,
		company.userId,
		locale,
		presentationTimeZone(),
		clock.startOfToday,
		name,
		definitionKey(file),
		live ? "live" : [state.realtime, state.realtimeError ?? ""],
		views.map((candidate) => candidate.name),
		view.name,
		page.open,
		page.sort,
		page.filter,
		page.error,
		page.errorProblems,
		page.errors,
		page.pending,
		page.claiming,
		canWrite,
		listed,
		cofounder,
		widths,
		agentLooks,
		memberNames,
		// Each block's source as drawn beside its rows: whether it can be read (a table that recovers with no rows
		// still draws again) and what its columns hold, which a table's definition says outside the page's.
		blocks.map(({ block, source, rows, open, readable, problems, board, extra }) => [
			block.title,
			rows,
			extra ?? null,
			open?.key ?? null,
			readable,
			problems,
			(interfaceSource(company, source)?.columns ?? []).map((column) => idColumn(company, source, column)),
			// A board's parts as drawn, the same way, with what the member may do; its lanes by their cards.
			board?.parts.map((part) => [
				part.index,
				part.rows,
				part.readable,
				part.problems,
				part.opens,
				part.mayWrite,
				part.definition?.holder ?? null,
				(interfaceSource(company, part.source)?.columns ?? []).map((column) =>
					idColumn(company, part.source, column),
				),
			]) ?? null,
			board?.lanes.map((lane) => [lane.id, lane.title, lane.cards.map((card) => [card.part, card.item.key])]) ??
				null,
		]),
	]);
	const context: BlockContext = {
		company,
		file,
		profileId,
		figureOf: (agentId, size = 30) => agentFigure(company.staffById(agentId), nameOf("agent", agentId), { size }),
		page,
		redraw,
		canWrite,
		...(writes ? { writes } : {}),
		stillShown: () => {
			const shown = container.firstElementChild;
			return shown instanceof HTMLElement && shown.dataset.interface === name && shown.dataset.profile === profileId;
		},
	};
	const errorFirst = page.error !== null && !page.errorShown;
	show(
		container,
		key,
		() => {
			// A refused save says what failed, and lists why under it.
			const error =
				page.error === null
					? null
					: page.errorProblems.length
						? notice(
								"danger",
								h("p", null, page.error),
								h(
									"ul",
									{ class: "interface-problems" },
									...page.errorProblems.map((problem) => h("li", null, problem)),
								),
							)
						: notice("danger", page.error);
			// The error is announced once; it stays on the page through later redraws without being read again.
			if (error && !errorFirst) error.removeAttribute("role");
			const tabbed = views.length > 1;
			return h(
				"section",
				{ class: "interface", "data-interface": name, "data-profile": profileId },
				h(
					"header",
					{ class: "interface-head" },
					interfaceEmblem(file.emblem, file.colour, 30),
					h(
						"div",
						{ class: "interface-title" },
						h("h1", null, file.name),
						file.about ? h("small", null, file.about) : null,
					),
					h(
						"span",
						{ class: `interface-live${live ? "" : " is-degraded"}`, role: "status" },
						h("span", { class: "interface-live-dot", "aria-hidden": "true" }),
						live ? t("Live") : state.realtime === "connecting" ? t("connecting") : t("live updates degraded"),
					),
				),
				tabbed ? viewTabs(views, viewIndex, page, redraw) : null,
				error,
				h(
					"div",
					{
						class: `interface-page${hasOpen ? " has-open" : ""}`,
						id: "interface-view-panel",
						// A live redraw of this view keeps where the member scrolled it (show).
						"data-scroll-key": JSON.stringify([profileId, name, view.name]),
						...(tabbed ? { role: "tabpanel", "aria-labelledby": `interface-view-${viewIndex}` } : {}),
					},
					...blocks.map((drawn, index) =>
						drawBlock({ ...drawn, block: { ...drawn.block, width: widths[index] ?? "full" } }, context),
					),
				),
			);
		},
		moveFocus,
	);
	if (errorFirst) page.errorShown = true;
}

/** The page's views as tabs. A view changes the blocks shown and closes what was open; the route stays. */
function viewTabs(
	views: readonly { readonly name: string }[],
	current: number,
	page: PageState,
	redraw: () => void,
): HTMLElement {
	const choose = (index: number, byKey = false) => {
		const name = views[index]?.name;
		if (name === undefined || index === current) return;
		page.view = name;
		page.open = {};
		page.error = null;
		page.errorProblems = [];
		// A key moves focus with the choice; a click leaves it where the pointer put it.
		if (byKey) page.focus = `view:${index}`;
		redraw();
	};
	const tabs = views.map((view, index) =>
		h(
			"button",
			{
				type: "button",
				role: "tab",
				id: `interface-view-${index}`,
				class: "interface-view",
				"aria-selected": String(index === current),
				"aria-controls": index === current ? "interface-view-panel" : null,
				tabindex: index === current ? "0" : "-1",
				"data-focus-key": `view:${index}`,
				onclick: () => choose(index),
			},
			view.name,
		),
	);
	const list = h("nav", { class: "interface-views", role: "tablist", "aria-label": t("Views") }, ...tabs);
	list.addEventListener("keydown", (event) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? views.length - 1
					: step
						? (current + step + views.length) % views.length
						: -1;
		if (next < 0) return;
		event.preventDefault();
		choose(next, true);
	});
	return list;
}

interface BlockContext {
	readonly company: CompanyController;
	readonly file: InterfaceFile;
	readonly profileId: string;
	readonly figureOf: (agentId: string, size?: number) => HTMLElement;
	readonly page: PageState;
	readonly redraw: () => void;
	/** Whether the member may write: answering a card and posting a message need it. */
	readonly canWrite: boolean;
	/** Where a board's take and release write; without it, a board draws neither. */
	readonly writes?: InterfaceWrites;
	/** Whether this page is still the one on screen, for work that finishes after a click. */
	readonly stillShown: () => boolean;
}

function drawBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	if (drawn.block.kind === "table") return tableBlock(drawn, context);
	if (drawn.block.kind === "detail") return detailBlock(drawn, context);
	if (drawn.block.kind === "board") return boardBlock(drawn, context);
	const kind = drawn.block.kind;
	if (kind === "text" || kind === "numbers" || kind === "calendar") {
		const { block, key, opens } = drawn;
		return drawExtraBlock(drawn, {
			frame: (extra, ...children) => blockFrame(block, key, extra, block.title, ...children),
			note: sourceNote(drawn),
			readable: drawn.readable,
			figureOf: context.figureOf,
			opens,
			opened: opens === null ? undefined : context.page.open[opens],
			open: (item) => {
				if (opens !== null) openRow(context, opens, item);
			},
		});
	}
	return listBlock(drawn, context);
}

function blockFrame(
	block: InterfaceBlock,
	key: string,
	extra: string,
	title: string | null,
	...children: (Node | null)[]
): HTMLElement {
	return h(
		"section",
		{ class: `interface-block interface-width-${block.width}${extra}` },
		title ? h("h2", { id: domId("title", key) }, title) : null,
		...children,
	);
}

/** Opens a row in the detail `target` names, or closes it. On a phone the detail is the next screen, so focus
 * goes to its Back button; closing it gives focus back to the row it was opened from. */
function openRow(context: BlockContext, target: string, item: InterfaceRow | null): void {
	const open = { ...context.page.open };
	const was = open[target];
	if (item) {
		open[target] = item.key;
		if (isPhoneLayout()) context.page.focus = `back:${target}`;
	} else {
		delete open[target];
		if (was !== undefined) context.page.focus = `open:${target}:${was}`;
	}
	context.page.open = open;
	context.page.error = null;
	context.page.errorProblems = [];
	context.redraw();
}

/** A cell as text: an agent's name, a time in the member's zone, yes or no, what waits, a member's role. A member's
 * picture is drawn, never written (`memberPicture`). */
function cellText(drawn: DrawnBlock, column: string, value: TableValue | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? t("Yes") : t("No");
	if (typeof value === "string" && INSTANT.test(value)) return fmtTime(value) || value;
	if (drawn.source === "waiting" && column === "kind" && typeof value === "string") return kindLabel(value);
	const label = folderCellLabel(drawn.source, column, value);
	if (label !== undefined) return label;
	if (drawn.source === "members" && column === "picture") return "";
	if (drawn.source === "members" && column === "role" && typeof value === "string") {
		const role = roleLabel(value as HostedProfileRole);
		return role.charAt(0).toLocaleUpperCase(presentationLocale()) + role.slice(1);
	}
	return drawn.nameOf(column, value);
}

/** A member's picture, for the `members` source's `picture` column (their account id). */
function memberPicture(drawn: DrawnBlock, column: string, row: TableRow): HTMLElement | null {
	const id = row[column];
	if (drawn.source !== "members" || column !== "picture" || typeof id !== "string") return null;
	return personAvatar(typeof row.name === "string" ? row.name : "", id);
}

/** A source's own problems at the top of its block: the rows of a table that don't fit its definition are left out
 * and listed here, and a table that can't be read at all shows only this (with no list when its read failed). A
 * folder source's bad files are listed the same way. */
function sourceNote(drawn: DrawnBlock): HTMLElement | null {
	if (drawn.readable && !drawn.problems.length) return null;
	const unread = drawn.source.startsWith("table:")
		? t("This table can't be read.")
		: t("This can't be read right now.");
	return h(
		"div",
		{ class: "interface-note" },
		h("p", null, drawn.readable ? t("Some rows can't be shown.") : unread),
		drawn.problems.length ? problemList(drawn.problems) : null,
	);
}

function listBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, rows, key, opens, nameOf } = drawn;
	const cards = block.layout === "cards";
	const buttons = blockButtons(context.file, block);
	const opened = opens === null ? undefined : context.page.open[opens];
	const items = rows.map((item) => {
		const { row, href, live } = item;
		const agentId = block.figure ? row[block.figure] : undefined;
		const line = fillInterfaceText(block.line ?? "{title}", row, nameOf);
		const sub = block.sub ? fillInterfaceText(block.sub, row, nameOf) : "";
		const status = block.status ? cellText(drawn, block.status, row[block.status]) : "";
		const byAgent = typeof agentId === "string" && block.figure === "agent";
		const lineId = domId("line", key, item.key);
		const body = [
			typeof agentId === "string" ? h("span", { class: "interface-item-figure" }, context.figureOf(agentId)) : null,
			h(
				"span",
				{ class: "interface-item-copy" },
				h("strong", { id: lineId }, byAgent ? nameOf("agent", agentId) : line),
				byAgent ? h("small", null, line) : sub ? h("small", null, sub) : null,
			),
			status ? h("span", { class: "interface-item-status" }, status) : null,
			live ? h("span", { class: "interface-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : null,
		];
		const isOpen = opened !== undefined && item.key === opened;
		const main =
			opens !== null
				? h(
						"button",
						{
							type: "button",
							class: `interface-item${isOpen ? " is-open" : ""}`,
							"aria-current": isOpen ? "true" : null,
							"data-focus-key": `open:${opens}:${item.key}`,
							onclick: () => openRow(context, opens, item),
						},
						...body,
					)
				: href
					? h("a", { class: "interface-item", href, "data-focus-key": `item:${key}:${item.key}` }, ...body)
					: h("div", { class: "interface-item" }, ...body);
		const actions = rowButtons(buttons, item, drawn, context, lineId);
		return h("li", null, actions ? h("div", { class: "interface-item-row" }, main, actions) : main);
	});
	return blockFrame(
		block,
		key,
		cards ? " interface-cards" : "",
		block.title,
		sourceNote(drawn),
		items.length
			? h("ul", { class: "interface-list" }, ...items)
			: drawn.readable
				? h("p", { class: "interface-empty" }, t("Nothing here right now."))
				: null,
	);
}

function tableBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, key, source, opens } = drawn;
	const buttons = blockButtons(context.file, block);
	const columns = block.columns.length
		? block.columns
		: Object.keys(drawn.rows[0]?.row ?? {}).filter((column) => column !== "id");
	const sort = context.page.sort[key];
	const filter = context.page.filter[key] ?? "";
	const needle = filter.trim().toLocaleLowerCase();
	const text = (row: TableRow, column: string) => cellText(drawn, column, interfaceCell(row, column));
	const shown = drawn.rows.filter(
		({ row }) => !needle || columns.some((column) => text(row, column).toLocaleLowerCase().includes(needle)),
	);
	if (sort) {
		// A column of ids sorts by the names shown, what waits by its label, a member's role by its word, yes/no by its
		// word, a lookup's list by its names; numbers and times by their value. Empty cells come last, as values sort.
		const byText =
			idColumn(context.company, source, sort.column) !== null ||
			(source === "waiting" && sort.column === "kind") ||
			(source === "members" && sort.column === "role") ||
			drawn.rows.some(({ row }) => typeof row[sort.column] === "boolean" || Array.isArray(row[sort.column]));
		const locale = presentationLocale();
		const byWords = (a: string, b: string) => (a === b ? 0 : !a ? 1 : !b ? -1 : a.localeCompare(b, locale));
		shown.sort((a, b) => {
			const order = byText
				? byWords(text(a.row, sort.column), text(b.row, sort.column))
				: compareInterfaceValues(interfaceCell(a.row, sort.column), interfaceCell(b.row, sort.column));
			return sort.descending ? -order : order;
		});
	}
	const opened = opens === null ? undefined : context.page.open[opens];
	const header = h(
		"tr",
		null,
		...columns.map((column) => {
			const sorted = sort?.column === column ? (sort.descending ? "descending" : "ascending") : "none";
			return h(
				"th",
				{ scope: "col", "aria-sort": sorted },
				h(
					"button",
					{
						type: "button",
						class: "interface-sort",
						"data-focus-key": `sort:${key}:${column}`,
						onclick: () => {
							context.page.sort = {
								...context.page.sort,
								[key]: { column, descending: sort?.column === column ? !sort.descending : false },
							};
							context.redraw();
						},
					},
					columnLabel(source, column),
					sorted === "none" ? null : h("span", { "aria-hidden": "true" }, sorted === "ascending" ? " ↑" : " ↓"),
				),
			);
		}),
		buttons.length ? h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, t("Actions"))) : null,
	);
	const body = shown.map((item) => {
		const isOpen = opened !== undefined && item.key === opened;
		const lineId = domId("line", key, item.key);
		const cells = columns.map((column, index) => {
			const value = text(item.row, column);
			if (index === 0 && opens !== null)
				return h(
					"td",
					{ id: lineId },
					h(
						"button",
						{
							type: "button",
							class: "interface-row-open",
							"aria-current": isOpen ? "true" : null,
							"data-focus-key": `open:${opens}:${item.key}`,
							onclick: () => openRow(context, opens, item),
						},
						value || t("Open"),
					),
				);
			return h("td", index === 0 ? { id: lineId } : null, memberPicture(drawn, column, item.row) ?? value);
		});
		const actions = rowButtons(buttons, item, drawn, context, lineId);
		return h("tr", { class: isOpen ? "is-open" : null }, ...cells, actions ? h("td", null, actions) : null);
	});
	const filterField = h("input", {
		type: "search",
		class: "interface-filter",
		value: filter,
		placeholder: t("Filter"),
		"aria-label": block.title ? t("Filter {title}", { title: block.title }) : t("Filter"),
		"data-focus-key": `filter:${key}`,
	});
	const applyFilter = () => {
		context.page.filter = { ...context.page.filter, [key]: filterField.value };
		context.redraw();
	};
	// A letter being composed (a dead key, an input method) is not cut off by a redraw; it filters once composed.
	filterField.addEventListener("input", (event) => {
		if (!(event as InputEvent).isComposing) applyFilter();
	});
	filterField.addEventListener("compositionend", applyFilter);
	const listing = shown.length
		? h(
				"div",
				{ class: "interface-table-scroll" },
				h(
					"table",
					{
						class: "interface-table",
						...(block.title ? { "aria-labelledby": domId("title", key) } : { "aria-label": context.file.name }),
					},
					h("thead", null, header),
					h("tbody", null, ...body),
				),
			)
		: h("p", { class: "interface-empty" }, drawn.rows.length ? t("No rows match.") : t("Nothing here right now."));
	return blockFrame(
		block,
		key,
		" interface-table-block",
		block.title,
		sourceNote(drawn),
		drawn.rows.length ? filterField : null,
		// A table that can't be read shows only its problems.
		drawn.readable ? listing : null,
	);
}

function detailBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, open, key, source, nameOf } = drawn;
	const target = block.id ?? "";
	if (!open)
		return blockFrame(
			block,
			key,
			" interface-detail is-empty",
			block.title === null ? null : fillInterfaceText(block.title, {}, nameOf),
			h("p", { class: "interface-empty" }, t("Choose one to see it here.")),
		);
	const fields = block.fields.length
		? block.fields
		: Object.keys(open.row).filter((column) => column !== "text" && column !== "id");
	const text = interfaceCell(open.row, "text");
	const lineId = domId("line", key, open.key);
	const actions = rowButtons(blockButtons(context.file, block), open, drawn, context, lineId);
	return blockFrame(
		block,
		key,
		" interface-detail is-open",
		block.title === null ? null : fillInterfaceText(block.title, open.row, nameOf),
		h(
			"button",
			{
				type: "button",
				class: "interface-back",
				"data-focus-key": `back:${target}`,
				onclick: () => openRow(context, target, null),
			},
			t("Back"),
		),
		h(
			"dl",
			{ class: "interface-fields", id: lineId },
			...fields.flatMap((column) => [
				h("dt", null, columnLabel(source, column)),
				h("dd", null, cellText(drawn, column, interfaceCell(open.row, column))),
			]),
		),
		typeof text === "string" && text ? h("div", { class: "interface-detail-text" }, markdown(text)) : null,
		actions,
	);
}

/** A board part as a block of its own, for what is drawn per part: its source's note and its cards' buttons. */
function partBlock(drawn: DrawnBlock, part: DrawnPart): DrawnBlock {
	return {
		block: drawn.block,
		source: part.source,
		key: `${drawn.key}:${part.index}`,
		rows: part.rows,
		opens: part.opens,
		nameOf: part.nameOf,
		readable: part.readable,
		problems: part.problems,
	};
}

/** Where a board's cards may move to: the member's own lane and the open pile, when the board has them. */
interface BoardPlaces {
	readonly own: BoardLane | undefined;
	readonly pile: BoardLane | undefined;
}

/** A board (§3.2): its lanes side by side (stacked on a phone), each with its cards, part by part. A card in the open
 * pile can be taken and one in the member's own lane released, with its button or by dragging it to the other; the card
 * stays where it is, saving, until the save has landed. */
function boardBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, key } = drawn;
	const { parts, lanes } = drawn.board ?? { parts: [], lanes: [] };
	const places = { own: lanes.find((lane) => lane.own), pile: lanes.find((lane) => lane.kind === "open") };
	const several = parts.length > 1;
	const notes = parts.flatMap((part) => {
		const note = sourceNote(partBlock(drawn, part));
		if (!note) return [];
		if (several && part.part.title) note.prepend(h("strong", null, part.part.title));
		return [note];
	});
	return blockFrame(
		block,
		key,
		" interface-board-block",
		block.title,
		...notes,
		lanes.length
			? h(
					"div",
					{ class: "interface-board" },
					...lanes.map((lane) => boardLane(drawn, lane, parts, places, context)),
				)
			: h("p", { class: "interface-empty" }, t("Nothing here right now.")),
	);
}

/** One lane: its title and its cards, under each part's title when the board has several. An empty lane keeps its
 * title and says so quietly. */
function boardLane(
	drawn: DrawnBlock,
	lane: BoardLane,
	parts: readonly DrawnPart[],
	places: BoardPlaces,
	context: BlockContext,
): HTMLElement {
	const titleId = domId("lane", drawn.key, lane.id);
	const groups = parts.flatMap((part, place) => {
		const items = lane.cards.filter((card) => card.part === place).map((card) => card.item);
		if (!items.length) return [];
		return [
			parts.length > 1 && part.part.title ? h("h4", { class: "interface-lane-part" }, part.part.title) : null,
			h(
				"ul",
				{ class: "interface-lane-cards" },
				...items.map((item) => boardCard(drawn, part, item, lane, places, context)),
			),
		];
	});
	return h(
		"section",
		{
			class: `interface-lane interface-lane-${lane.kind}${lane.own ? " is-own" : ""}`,
			"data-drop-lane": lane.id,
			"aria-labelledby": titleId,
		},
		h(
			"h3",
			{ class: "interface-lane-title" },
			h("span", { id: titleId }, lane.title),
			h("span", { class: "interface-lane-count", "aria-hidden": "true" }, String(lane.cards.length)),
		),
		...groups,
		lane.cards.length ? null : h("p", { class: "interface-empty" }, t("Nothing here.")),
	);
}

const emptyCell = (value: TableValue | undefined) =>
	value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** A card's line or note, or null when every column it names is empty ("Supervised by {supervisor}" with no
 * supervisor says nothing). */
function cardText(template: string | null, part: DrawnPart, row: TableRow): string | null {
	if (template === null) return null;
	const named = [...template.matchAll(TEMPLATE_COLUMN)].map((match) => match[1] ?? "");
	if (named.length && named.every((column) => emptyCell(interfaceCell(row, column)))) return null;
	return fillInterfaceText(template, row, part.nameOf).trim() || null;
}

/** One card: its title, line, figures and note from its part's `card`, opening its part's detail when it has one, with
 * its Take or Release and the block's own buttons. */
function boardCard(
	drawn: DrawnBlock,
	part: DrawnPart,
	item: InterfaceRow,
	lane: BoardLane,
	places: BoardPlaces,
	context: BlockContext,
): HTMLElement {
	const { row } = item;
	const template = part.part.card;
	const card = cardKey(part, item);
	const saving = Object.hasOwn(context.page.claiming, card);
	const titleId = domId("card", drawn.key, card);
	const line = cardText(template.line, part, row);
	const note = cardText(template.note, part, row);
	const figuresValue = template.figures === null ? undefined : interfaceCell(row, template.figures);
	const figures = (Array.isArray(figuresValue) ? figuresValue : [figuresValue]).filter(
		(id): id is string => typeof id === "string" && id !== "",
	);
	const body = [
		h(
			"strong",
			{ class: "interface-card-title", id: titleId },
			fillInterfaceText(template.title, row, part.nameOf) || t("Open"),
		),
		line ? h("span", { class: "interface-card-line" }, line) : null,
		figures.length && template.figures !== null
			? h(
					"span",
					{ class: "interface-card-figures" },
					...figures.map((id) => context.figureOf(id, 22)),
					h("span", { class: "visually-hidden" }, part.nameOf(template.figures, figuresValue)),
				)
			: null,
		note ? h("small", { class: "interface-card-note" }, note) : null,
	];
	const opens = part.opens;
	const isOpen = opens !== null && context.page.open[opens] === item.key;
	const main =
		opens !== null
			? h(
					"button",
					{
						type: "button",
						class: "interface-card-open",
						"aria-current": isOpen ? "true" : null,
						"data-focus-key": `open:${opens}:${item.key}`,
						onclick: () => openRow(context, opens, item),
					},
					...body,
				)
			: h("div", { class: "interface-card-body" }, ...body);
	// Take on a card no one holds, Release on the member's own, in any lane of a members board (a Shared card too),
	// where the block lists them and the table lets members write; offer and answer are not drawn on a board (step I9a).
	const verbs = new Set(drawn.block.buttons);
	const holder = part.definition?.holder ?? null;
	const claimable =
		context.writes !== undefined &&
		part.mayWrite &&
		part.table !== null &&
		places.own !== undefined &&
		part.definition?.columns.some((column) => column.name === holder) === true;
	const held = holder === null ? undefined : row[holder];
	const verb: ClaimVerb | null = !claimable
		? null
		: emptyCell(held) && verbs.has("take")
			? "take"
			: held === context.company.userId && verbs.has("release")
				? "release"
				: null;
	const claim =
		verb === null
			? null
			: h(
					"button",
					{
						type: "button",
						class: "interface-button",
						"data-focus-key": `claim:${drawn.key}:${card}`,
						"aria-describedby": titleId,
						// Not `disabled`: the button keeps focus while the card saves.
						"aria-disabled": saving ? "true" : null,
						onclick: () => void claimCard(context, part, item, verb),
					},
					verb === "take" ? t("Take") : t("Release"),
				);
	const buttons = blockButtons(context.file, drawn.block).filter((button) => button.verb !== "answer");
	const actions = rowButtons(buttons, item, partBlock(drawn, part), context, titleId);
	if (claim) actions?.prepend(claim);
	const element = h(
		"li",
		{
			class: `interface-card${isOpen ? " is-open" : ""}${saving ? " is-saving" : ""}`,
			"aria-busy": saving ? "true" : null,
		},
		main,
		actions ?? (claim ? h("span", { class: "interface-actions" }, claim) : null),
		saving ? h("small", { class: "interface-card-saving" }, t("Saving…")) : null,
	);
	// Dragging is the same take or release: from the open pile to the member's own lane, or back. A Shared card stays in
	// the Shared lane either way, so it has no drag.
	const target =
		lane.kind === "shared" ? undefined : verb === "take" ? places.own : verb === "release" ? places.pile : undefined;
	if (verb !== null && target && !saving)
		boardDrag(element, { targets: [target.id], drop: () => void claimCard(context, part, item, verb) });
	return element;
}

/** How long a card whose save landed may stay where it was, saving, waiting for the board to show it moved. */
const CLAIM_LANDED_WAIT = 10_000;

/** Takes or releases a card (§3.3): writes its holder cell with the version it read. The card stays where it was,
 * saving, until the save has landed and the board shows the change; a card someone else changed meanwhile says so,
 * and a refused save lists why. */
async function claimCard(context: BlockContext, part: DrawnPart, item: InterfaceRow, verb: ClaimVerb): Promise<void> {
	const { page, company, writes } = context;
	const card = cardKey(part, item);
	if (Object.hasOwn(page.claiming, card)) return;
	const was = holderCell(part, item);
	page.claiming = { ...page.claiming, [card]: { was, landed: false } };
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	let wrote = false;
	try {
		if (!writes || part.table === null || part.definition === null) throw new Error(claimFailure(verb));
		wrote = await claimTableCell({
			folder: writes.folder(),
			table: part.table,
			key: tableRowKey(part.definition, item.row),
			verb,
			memberId: company.userId,
			signal: company.signal,
			check: () => {
				company.signal.throwIfAborted();
				writes.current();
			},
		});
	} catch (error) {
		const rejected = error instanceof WebCompanyFolderRejectedError ? error : null;
		// Every read found the cell still free (or still the member's), so the file kept changing elsewhere; a cell that
		// was lost says so itself (ClaimLostError).
		if (rejected?.reason === "version_changed") page.error = t("That changed while you were looking.");
		else if (rejected?.problems.length) {
			page.error = claimFailure(verb);
			page.errorProblems = [...rejected.problems];
		} else page.error = describeError(error);
		page.errorShown = false;
		page.errors += 1;
	}
	const without = () => Object.fromEntries(Object.entries(page.claiming).filter(([other]) => other !== card));
	if (wrote) {
		const landed = { was, landed: true };
		page.claiming = { ...without(), [card]: landed };
		// A feed that is slow to show the change doesn't keep the card saving.
		setTimeout(() => {
			if (page.claiming[card] !== landed) return;
			page.claiming = without();
			if (context.stillShown()) context.redraw();
		}, CLAIM_LANDED_WAIT);
	} else page.claiming = without();
	if (context.stillShown()) context.redraw();
}

/** The agent a value names, if it still works here. */
function activeAgent(context: BlockContext, id: TableValue | undefined): HostedStaffAgent | undefined {
	const agent = typeof id === "string" ? context.company.staffById(id) : undefined;
	return agent?.employmentStatus === "active" ? agent : undefined;
}

/** The agent a `message` button's `to` names for this row: an id, `{column}` or the Co-Founder. */
function messageTarget(context: BlockContext, to: string, row: TableRow): HostedStaffAgent | undefined {
	if (to === "co-founder") return activeAgent(context, context.company.cofounderId());
	const named = to.match(/^\{([a-z][a-z0-9_]*)\}$/);
	return activeAgent(context, named ? interfaceCell(row, named[1] ?? "") : to);
}

/** A row's buttons, or null when it has none to show here. A button is drawn only where the member can use it:
 * answer where a card waits for them, message to an agent that still works here, and both only for a member who
 * may write. `lineId` names the row, so each button says which row it belongs to. */
function rowButtons(
	buttons: readonly DrawnButton[],
	item: InterfaceRow,
	drawn: DrawnBlock,
	context: BlockContext,
	lineId: string,
): HTMLElement | null {
	const label = (text: string) => fillInterfaceText(text, item.row, drawn.nameOf);
	const focus = (index: number) => `action:${drawn.key}:${item.key}:${index}`;
	const describe = { "aria-describedby": lineId };
	const drawnButtons = buttons.flatMap((drawnButton, index): HTMLElement[] => {
		if (drawnButton.verb === "answer") {
			// The platform's own card waits in its thread; the button takes the member there.
			if (!item.href || !context.canWrite || !rowHasCard(drawn.source, item.row)) return [];
			return [
				h(
					"a",
					{ class: "interface-button", href: item.href, "data-focus-key": focus(index), ...describe },
					label(drawnButton.label),
				),
			];
		}
		if (drawnButton.verb === "open") {
			const href = openTarget(drawnButton.target, item.row, context);
			if (href)
				return [
					h(
						"a",
						{ class: "interface-button", href, "data-focus-key": focus(index), ...describe },
						label(drawnButton.label),
					),
				];
			const opens = drawn.opens;
			if (drawnButton.target === "row" && opens !== null)
				return [
					h(
						"button",
						{
							type: "button",
							class: "interface-button",
							"data-focus-key": focus(index),
							...describe,
							onclick: () => openRow(context, opens, item),
						},
						label(drawnButton.label),
					),
				];
			return [];
		}
		const agent = messageTarget(context, drawnButton.to, item.row);
		// A row whose outside values can't travel as quotes gets no button (messageText says why).
		if (!agent || !context.canWrite || !messageText(drawnButton.text, item.row, drawn.source, drawn.nameOf))
			return [];
		const pendingKey = focus(index);
		const pending = () => context.page.pending.includes(pendingKey);
		const action = h(
			"button",
			{
				type: "button",
				class: "interface-button",
				"data-focus-key": pendingKey,
				disabled: pending(),
				...describe,
			},
			label(drawnButton.label),
		);
		action.addEventListener("click", () => {
			// One click puts the text in the composer once, however often the page redraws while the thread opens.
			if (pending()) return;
			action.disabled = true;
			context.page.pending = [...context.page.pending, pendingKey];
			context.page.error = null;
			context.page.errorProblems = [];
			const done = () => {
				context.page.pending = context.page.pending.filter((key) => key !== pendingKey);
			};
			void messageAgent(context, agent, drawnButton, item.row, drawn).then(done, (error: unknown) => {
				done();
				action.disabled = false;
				context.page.error = describeError(error);
				context.page.errorProblems = [];
				context.page.errorShown = false;
				context.page.errors += 1;
				// The member may have gone on to another page; this page draws the error only where it still shows.
				if (context.stillShown()) context.redraw();
			});
		});
		return [action];
	});
	return drawnButtons.length ? h("span", { class: "interface-actions" }, ...drawnButtons) : null;
}

/** Where an `open` button leads: an agent's thread (`agent:{column}` or `agent:<id>`), or another interface this
 * member can open. */
function openTarget(target: string, row: TableRow, context: BlockContext): string | null {
	if (target.startsWith("agent:")) {
		const named = target.slice("agent:".length);
		const column = named.match(/^\{([a-z][a-z0-9_]*)\}$/);
		const agent = activeAgent(context, column ? interfaceCell(row, column[1] ?? "") : named);
		if (!agent) return null;
		return agent.id === context.company.cofounderId()
			? `#/c/${context.profileId}`
			: `#/c/${context.profileId}/staff/${agent.id}`;
	}
	if (target.startsWith("interface:")) {
		const name = target.slice("interface:".length);
		return companyInterfaces(context.company).some((entry) => entry.name === name)
			? `#/c/${context.profileId}/i/${name}`
			: null;
	}
	return null;
}

/** The `{column}` names a button's text fills in, as the cloud client's fill reads them. */
const TEMPLATE_COLUMN = /\{([a-z][a-z0-9_]{0,39})\}/g;

/** An outside value as quoted words: it can't close or open the marks, start a line of its own (a fake quote line,
 * an instruction set apart), or hide text with control or direction characters, and it is cut to the longest a quote
 * may be, between characters, never inside one (an emoji is two UTF-16 units). */
function quotedWords(shown: string): string {
	const flat = shown
		.replace(/«/g, "‹")
		.replace(/»/g, "›")
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...flat];
	return characters.length > QUOTE_MAX_CHARACTERS
		? `${characters
				.slice(0, QUOTE_MAX_CHARACTERS - 1)
				.join("")
				.trimEnd()}…`
		: flat;
}

/** The text a `message` button puts in the composer, with its quotes. A value from a column that carries outside
 * content (RUNTIME-INTERFACES.md §4) goes as a quote (contract, the 2026-10-02 amendment "quoted outside content in
 * a member's message"): in «» marks on the same line, with where it came from, so the platform fences those words
 * and the review never reads them as the member's own. An empty value fills in nothing.
 *
 * Undefined when a value from outside content can't travel as a quote: its source is not on the contract's quote
 * list, or the row doesn't name the record it came from (a mail row without its thread id). The button is then not
 * drawn for that row (rowButtons): filling the value in as the member's own words is what a quote is there to
 * prevent, and leaving it out would put in less than the button says, with nothing to tell the member. */
export function messageText(
	text: string,
	row: TableRow,
	source: string,
	nameOf: (column: string, value: unknown) => string,
): QuotedText | undefined {
	const outside = interfaceOutsideColumns(source);
	const recordColumn = Object.hasOwn(QUOTE_RECORD_COLUMNS, source) ? QUOTE_RECORD_COLUMNS[source] : undefined;
	const ref = recordColumn === undefined ? undefined : interfaceCell(row, recordColumn);
	const quotes: MessageQuote[] = [];
	let filled = "";
	// Characters (code points) of `filled`, which the quotes count in.
	let characters = 0;
	const add = (words: string) => {
		filled += words;
		characters += [...words].length;
	};
	let last = 0;
	for (const match of text.matchAll(TEMPLATE_COLUMN)) {
		add(text.slice(last, match.index));
		last = match.index + match[0].length;
		const column = match[1] ?? "";
		const value = interfaceCell(row, column);
		if (value === undefined) continue;
		if (!outside.includes(column)) {
			add(nameOf(column, value));
			continue;
		}
		const words = quotedWords(nameOf(column, value));
		if (!words) continue;
		if (
			!INTERFACE_QUOTE_SOURCES.includes(source) ||
			typeof ref !== "string" ||
			!quoteRefFits(source, ref) ||
			quotes.length >= INTERFACE_OUTSIDE_VALUES_MAX
		)
			return undefined;
		add("«");
		const start = characters;
		add(words);
		quotes.push({ start, end: characters, source, ref });
		add("»");
	}
	add(text.slice(last));
	return { text: filled, quotes };
}

/** A `message` button: opens the agent's thread with the prefilled text in its composer, its outside values as
 * quotes. Nothing is sent until the member sends it. If the member has moved on by the time the thread is ready,
 * the text still waits in its composer, but the page stays where they are. */
async function messageAgent(
	context: BlockContext,
	agent: HostedStaffAgent,
	drawnButton: Extract<DrawnButton, { verb: "message" }>,
	row: TableRow,
	drawn: DrawnBlock,
): Promise<void> {
	const { company, profileId } = context;
	// The button is drawn only for a row whose values can travel (rowButtons); this holds the line if one can't.
	const text = messageText(drawnButton.text, row, drawn.source, drawn.nameOf);
	if (!text) throw new Error(t("This row's email can't be quoted in a message."));
	const from = location.hash;
	const cofounderId = company.cofounderId();
	let sessionId: string | undefined;
	if (agent.id === cofounderId) {
		const opened = await company.openCofounderConversation();
		if (!opened.sessionId) throw new Error(opened.reason ?? t("The Co-Founder's thread can't be opened here."));
		sessionId = opened.sessionId;
	} else sessionId = await company.openStaffConversation(agent);
	company.addToDraft(sessionId, text);
	if (location.hash === from)
		location.hash = agent.id === cofounderId ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agent.id}`;
}
