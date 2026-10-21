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
import type { MemberInterfaceOffer } from "../../cloud/interface-offers.ts";
import type { MemberInterfaceSupervision } from "../../cloud/interface-supervisions.ts";
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
import { CompanyMail, type MailList, type MailListRequest } from "../company-mail.ts";
import { AgentInAreaError, addArea, agentList, setAreaAgents } from "../interface-areas.ts";
import { type BoardLane, boardLanes } from "../interface-board.ts";
import { type ClaimVerb, claimFailure, claimTableCell, type InterfaceWrites } from "../interface-claims.ts";
import type { FolderProblem } from "../interface-folder.ts";
import {
	isAccountMail,
	isMailSource,
	mailList,
	mailRequest,
	mailRows,
	mailSummary,
	openedMailRow,
	rowThread,
} from "../interface-mail.ts";
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
	leaverName,
	memberIds,
	memberMayWriteRows,
	memberOffers,
	namesLeaver,
	offeredRow,
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
import { type ListText, mailListFooter, mailListText, mailThreadParts, outside, unreadMark } from "./interface-mail.ts";
import { renderMailbox } from "./mailbox.ts";
import { roleLabel } from "./team.ts";

/** What each container last showed, and the element that shows it. The page area is shared with every other
 * page, so a redraw is skipped only while that element is still the one on screen. */
const shownIn = new WeakMap<HTMLElement, { key: string; element: Element }>();

/** A block's title (`blockFrame`). It takes the focus from a control that went when the page has none left (`show`),
 * so it can be focused, though not tabbed to. */
const BLOCK_TITLE = ".interface-block > h2";

/** Draws `build()` unless the same key is on screen. Every control names itself with `data-focus-key`, so the
 * one that had keyboard focus (and an input's caret) has it again after the redraw; `moveFocus` names another. In a
 * redraw of the same view, a focused control that is gone hands the focus on: to the first of its `data-focus-then`
 * keys (a JSON list) still drawn, else to the nearest control after it that is still there, else before it, else to
 * its block's title (a page left with no control). A page redrawn in the same view keeps its scroll position
 * (`data-scroll-key`). */
export function show(container: HTMLElement, key: string, build: () => HTMLElement, moveFocus?: string): void {
	const shown = shownIn.get(container);
	if (shown?.key === key && container.firstElementChild === shown.element && shown.element.isConnected) return;
	const active = document.activeElement;
	const focused = active instanceof HTMLElement && container.contains(active) ? active : null;
	const focusKey = focused?.dataset.focusKey;
	const caret =
		active instanceof HTMLInputElement ? ([active.selectionStart, active.selectionEnd] as const) : undefined;
	const scrolled =
		shown && container.firstElementChild === shown.element
			? shown.element.querySelector<HTMLElement>("[data-scroll-key]")
			: null;
	const element = build();
	const scroller = element.querySelector<HTMLElement>("[data-scroll-key]");
	const sameView = scrolled !== null && scroller !== null && scroller.dataset.scrollKey === scrolled.dataset.scrollKey;
	const keyed = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-focus-key]")];
	const controls = new Map<string, HTMLElement>();
	for (const each of keyed(element)) {
		const named = each.dataset.focusKey;
		if (named !== undefined && !controls.has(named)) controls.set(named, each);
	}
	const control = (named: string | undefined) => (named === undefined ? undefined : controls.get(named));
	let again = control(moveFocus) ?? control(focusKey);
	if (!again && focused && focusKey !== undefined && sameView) {
		// Read from the page still on screen, before it goes.
		const then = focused.dataset.focusThen ? (JSON.parse(focused.dataset.focusThen) as string[]) : [];
		const old = keyed(container);
		const at = old.indexOf(focused);
		const near = [...old.slice(at + 1), ...old.slice(0, at).reverse()]
			.filter((each) => !each.matches(BLOCK_TITLE))
			.map((each) => each.dataset.focusKey);
		const block = focused.closest(".interface-block");
		const title = old.find((each) => each.parentElement === block && each.matches(BLOCK_TITLE))?.dataset.focusKey;
		again = [...then, ...near, title].map(control).find((each) => each !== undefined && !each.matches(":disabled"));
	}
	replace(container, element);
	shownIn.set(container, { key, element });
	if (sameView) scroller.scrollTop = scrolled.scrollTop;
	again?.focus({ preventScroll: true });
	// The caret goes back only into the input that had it.
	const same = again?.dataset.focusKey === focusKey;
	if (again instanceof HTMLInputElement && same && caret && again === document.activeElement)
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
	 * stays where it was, saving, until its save lands and the board shows the change (or a little after the save). An
	 * accept keeps the offer it answers: its line stays on the card till then, though the save settled it (step I9c). */
	claiming: Record<
		string,
		{ readonly was: string; readonly landed: boolean; readonly offer?: MemberInterfaceOffer | undefined }
	>;
	/** The board card whose Offer lists the members it may go to (step I9c), by block and card. */
	offering: string | null;
	/** The area cards the member took or accepted here, which ask whether they supervise its agents too (step I9b), by
	 * card. */
	askSupervise: string[];
	/** The area the member is adding, as typed so far, while its form is open (Interfaces C6d). */
	areaDraft: { area: string; about: string } | null;
	/** The area whose Add an agent lists the agents it may add, by its row's key (Interfaces C6d). */
	addingAgents: string | null;
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
			offering: null,
			askSupervise: [],
			areaDraft: null,
			addingAgents: null,
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
			...(source === "mail" || source === "mail_addresses"
				? {
						thread: () => t("Thread"),
						address: () => t("Address"),
						from_name: () => t("From"),
						from_address: () => t("From address"),
						subject: () => t("Subject"),
						last_at: () => t("Last message"),
						state: () => t("State"),
						handled_by: () => t("Handled by"),
						direction: () => t("Direction"),
						unread: () => t("Unread"),
						routine: () => t("Routine"),
						last_7_days: () => t("Last 7 days"),
					}
				: {}),
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
	// The Mailbox draws itself from the company's mail as a mail app does (views/mailbox.ts).
	if (entry.name === "mailbox") {
		renderMailbox(container, company, name, writes?.openSettings ? { openSettings: writes.openSettings } : {});
		return;
	}
	// Every redraw the page asks for (a tab, a sort, an opened row, a message that failed after the page was switched
	// off) finds the page again, so a page switched off is never drawn.
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
	/** A block from `mail`: the list its view reads (undefined while it is being read). */
	readonly mail?: { readonly request: MailListRequest; readonly list: MailList | undefined };
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
	/** A member's name, or how the page names someone who left (Interfaces C6d). */
	const memberName = (id: string) =>
		namesLeaver(company, id)
			? leaverName(company, id)
			: state.team?.members.find((member) => member.userId === id)?.displayName;
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
		// A `mail` block reads the threads its view asks the threads call for, and narrows them here like any rows.
		let rows =
			(source === "mail" ? mailRows(company, mailRequest(narrow, query.where)) : interfaceRows(company, source)) ??
			[];
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
		view.blocks.flatMap(({ block }) =>
			(block.kind === "detail" || block.kind === "mail") && block.id !== null ? [block.id] : [],
		),
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
	const mailOf = (request: MailListRequest) => ({ request, list: mailList(company, request) });
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
			...(source === "mail" && block.kind !== "mail"
				? { mail: mailOf(mailRequest(shown.narrow, block.query.where)) }
				: {}),
			...(extra ? { extra } : {}),
			...(calendar ? { calendar } : {}),
		};
		if ((block.kind !== "detail" && block.kind !== "mail") || block.id === null) return drawn;
		const opened = page.open[block.id];
		// An open thread stays open when its view's list no longer holds it (a send answered under "Waiting for you").
		const open =
			opened === undefined
				? undefined
				: (rows.find((row) => row.key === opened) ??
					(block.kind === "mail" ? openedMailRow(company, opened) : undefined));
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
	// Offers are drawn only where the page can make and answer them, once they are read (step I9c); one from someone
	// who left is not (Interfaces C6d).
	const offers = (writes?.offers && memberOffers(company)) || null;
	// An area's supervision is drawn the same way, once its consents are read (step I9b).
	const supervisions = writes?.offers && state.interfaceOffers ? state.interfaceOffers.supervisions : null;
	const areas = supervisions === null ? null : tableDefinition(company, AREAS_SOURCE);
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
	// An area the member took here asks whether they supervise its agents too while it can (step I9b): while its take
	// lands, and its Supervise is on its way, it waits.
	const reads = { company, supervisions, ...(writes ? { writes } : {}) };
	const asking = new Set(
		blocks.flatMap(({ board }) =>
			(board?.parts ?? []).flatMap((part) =>
				part.rows.flatMap((item) => {
					const card = cardKey(part, item);
					if (!page.askSupervise.includes(card)) return [];
					if (Object.hasOwn(page.claiming, card)) return [card];
					const area = areaSupervision(reads, part.source, item.row);
					if (area === null) return [];
					const asks =
						page.pending.includes(superviseBusy(area)) || asksToSupervise(part, item, area, company.userId);
					return asks ? [card] : [];
				}),
			),
		),
	);
	page.askSupervise = page.askSupervise.filter((card) => asking.has(card));
	const hasOpen = blocks.some((drawn) => drawn.open !== undefined);
	const readsMail = blocks.some(({ source }) => isMailSource(source));
	const mailLists = blocks.flatMap(({ mail }) => (mail ? [mail.request] : []));
	const mailThreads = blocks.flatMap(({ block, open }) => {
		const thread = block.kind === "mail" && open ? rowThread(open.row) : undefined;
		return thread === undefined ? [] : [thread];
	});
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
		page.offering,
		canWrite,
		// The offers, the members they name and may go to, and whether each may be accepted where it is listed.
		offers,
		offers === null
			? null
			: (state.team?.members ?? []).map((member) => [member.userId, member.displayName, member.email, member.role]),
		offers?.map((offer) => {
			const offered = offeredRow(company, offer);
			return offered ? [offered.table, memberMayWriteRows(company, offered.definition)] : null;
		}) ?? null,
		// The live consents, the areas that ask to be supervised, and what decides an area's buttons: its supervisor
		// column and whether the member may change its rows (step I9b).
		supervisions,
		page.askSupervise,
		// Whether an area is being added, and the area whose agents are being chosen with the agents that may be chosen
		// (Interfaces C6d).
		page.areaDraft !== null,
		page.addingAgents,
		page.addingAgents === null ? null : areaAgentChoices(company).map((agent) => [agent.id, agent.displayName]),
		areas && [
			areas.id,
			areas.columns.find((column) => column.name === "supervisor") ?? null,
			memberMayWriteRows(company, areas),
		],
		listed,
		cofounder,
		widths,
		agentLooks,
		memberNames,
		// The company's mail where a block draws it: the lists drawn, each open thread as read with its summary, the
		// answers, the addresses and the waiting sends; not the other lists and threads read before.
		readsMail && state.mail
			? [
					state.mail.addresses,
					state.mail.waiting,
					state.mail.answers,
					mailLists.map((request) => mailList(company, request) ?? null),
					mailThreads.map((thread) => [state.mail?.threads[thread] ?? null, mailSummary(company, thread) ?? null]),
				]
			: null,
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
		offers,
		supervisions,
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
	// The mail this page draws is read, and read again while it stays on screen (app/company-mail.ts).
	if (readsMail) CompanyMail.of(company)?.watch(mailLists, mailThreads, context.stillShown);
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
	/** The company's open offers (step I9c), or null when the page can't make or answer them or they aren't read yet:
	 * then no offer is drawn. */
	readonly offers: readonly MemberInterfaceOffer[] | null;
	/** The company's live supervision consents (step I9b), or null when the page can't change them or they aren't read:
	 * then no area's supervision is drawn. */
	readonly supervisions: readonly MemberInterfaceSupervision[] | null;
	/** Whether this page is still the one on screen, for work that finishes after a click. */
	readonly stillShown: () => boolean;
}

function drawBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	if (drawn.block.kind === "table") return tableBlock(drawn, context);
	if (drawn.block.kind === "detail") return detailBlock(drawn, context);
	if (drawn.block.kind === "mail") return mailBlock(drawn, context);
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
	title: string | HTMLElement | null,
	...children: (Node | null)[]
): HTMLElement {
	return h(
		"section",
		{ class: `interface-block interface-width-${block.width}${extra}` },
		title ? h("h2", { id: domId("title", key), tabindex: "-1", "data-focus-key": `title:${key}` }, title) : null,
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
	if (drawn.source === "mail" && (column === "state" || column === "direction") && typeof value === "string")
		return mailWord(value);
	if (drawn.source === "members" && column === "role" && typeof value === "string") {
		const role = roleLabel(value as HostedProfileRole);
		return role.charAt(0).toLocaleUpperCase(presentationLocale()) + role.slice(1);
	}
	return drawn.nameOf(column, value);
}

/** A thread's state and direction, in the member's language. */
function mailWord(value: string): string {
	const word: Record<string, () => string> = {
		new: () => t("New"),
		handled: () => t("Handled"),
		waiting: () => t("Waiting"),
		received: () => t("Received"),
		sent: () => t("Sent"),
	};
	return word[value]?.() ?? value;
}

/** Whether a template fills in a column that carries outside content in its source (§4): what it shows is marked. */
function fillsOutside(template: string | null, source: string): boolean {
	const columns = interfaceOutsideColumns(source);
	return (
		template !== null &&
		columns.length > 0 &&
		[...template.matchAll(TEMPLATE_COLUMN)].some((match) => columns.includes(match[1] ?? ""))
	);
}

/** A list's words as drawn, with the outside-content mark when they hold any. */
function listWords(tag: "strong" | "small", words: ListText, id?: string): HTMLElement {
	const element = h(tag, id ? { id } : null, words.text);
	return words.outside ? outside(element) : element;
}

/** Words that fill in a template, marked when it fills in a column that carries outside content: a detail's title, a
 * button's label. */
function filledWords(template: string, row: TableRow, drawn: DrawnBlock): string | HTMLElement {
	const text = fillInterfaceText(template, row, drawn.nameOf);
	return text && fillsOutside(template, drawn.source) ? outside(h("span", null, text)) : text;
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
	// A status from a column that carries outside content is marked, as a line is.
	const outsideStatus = block.status !== null && interfaceOutsideColumns(drawn.source).includes(block.status);
	const items = rows.map((item) => {
		const { row, href, live } = item;
		const agentId = block.figure ? row[block.figure] : undefined;
		const template = block.line ?? "{title}";
		// What a line fills in from outside content is marked as such; a mail row says who wrote when it names nobody.
		const filled = {
			line: { text: fillInterfaceText(template, row, nameOf), outside: fillsOutside(template, drawn.source) },
			sub: {
				text: block.sub ? fillInterfaceText(block.sub, row, nameOf) : "",
				outside: fillsOutside(block.sub, drawn.source),
			},
		};
		const { line, sub } =
			drawn.source === "mail" ? mailListText(context.company, row, filled.line, filled.sub) : filled;
		const statusText = block.status ? cellText(drawn, block.status, row[block.status]) : "";
		const status = statusText ? h("span", { class: "interface-item-status" }, statusText) : null;
		const byAgent = typeof agentId === "string" && block.figure === "agent";
		const lineId = domId("line", key, item.key);
		const unread = drawn.source === "mail" && row.unread === true;
		const body = [
			unread ? unreadMark() : null,
			typeof agentId === "string" ? h("span", { class: "interface-item-figure" }, context.figureOf(agentId)) : null,
			h(
				"span",
				{ class: "interface-item-copy" },
				byAgent ? h("strong", { id: lineId }, nameOf("agent", agentId)) : listWords("strong", line, lineId),
				byAgent ? listWords("small", line) : sub.text ? listWords("small", sub) : null,
			),
			status && outsideStatus ? outside(status) : status,
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
		return h(
			"li",
			unread ? { class: "is-unread" } : null,
			actions ? h("div", { class: "interface-item-row" }, main, actions) : main,
		);
	});
	// A mail list says it is being read, or why it can't be, instead of being empty; then whether older mail is there.
	const reading = drawn.mail !== undefined && drawn.mail.list?.status !== "ready";
	return blockFrame(
		block,
		key,
		`${cards ? " interface-cards" : ""}${drawn.source === "mail" ? " interface-mail-list" : ""}`,
		block.title,
		sourceNote(drawn),
		items.length
			? h("ul", { class: "interface-list" }, ...items)
			: drawn.readable && !reading
				? h("p", { class: "interface-empty" }, t("Nothing here right now."))
				: null,
		drawn.mail ? mailListFooter(context.company, drawn.mail.request, drawn.mail.list, key) : null,
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
	const outsideColumns = interfaceOutsideColumns(source);
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
			const cell =
				index === 0 && opens !== null
					? h(
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
						)
					: h("td", index === 0 ? { id: lineId } : null, memberPicture(drawn, column, item.row) ?? value);
			// A cell that shows outside content is marked as such, the one whose button opens the row too.
			return value && outsideColumns.includes(column) ? outside(cell) : cell;
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
	// A mail table says it is being read, or why it can't be, instead of being empty; then whether older mail is there.
	const reading = drawn.mail !== undefined && drawn.mail.list?.status !== "ready";
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
		: drawn.rows.length
			? h("p", { class: "interface-empty" }, t("No rows match."))
			: reading
				? null
				: h("p", { class: "interface-empty" }, t("Nothing here right now."));
	return blockFrame(
		block,
		key,
		" interface-table-block",
		block.title,
		sourceNote(drawn),
		drawn.rows.length ? filterField : null,
		// A table that can't be read shows only its problems.
		drawn.readable ? listing : null,
		drawn.mail ? mailListFooter(context.company, drawn.mail.request, drawn.mail.list, key) : null,
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
	// What the title and fields fill in from outside content is marked as such.
	const outsideColumns = interfaceOutsideColumns(source);
	return blockFrame(
		block,
		key,
		" interface-detail is-open",
		block.title === null ? null : filledWords(block.title, open.row, drawn),
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
			...fields.flatMap((column) => {
				const value = cellText(drawn, column, interfaceCell(open.row, column));
				return [
					h("dt", null, columnLabel(source, column)),
					h("dd", null, value && outsideColumns.includes(column) ? outside(h("span", null, value)) : value),
				];
			}),
		),
		typeof text === "string" && text
			? h("div", { class: "interface-detail-text" }, markdown(text, { links: false }))
			: null,
		detailSupervision(context, drawn, open, lineId),
		detailAgents(context, drawn, open, lineId),
		actions,
	);
}

/** A `mail` block (step I5c): the thread the list opened, drawn by views/interface-mail.ts, with a way back on a
 * phone and the block's message buttons. Its `answer` is drawn on each waiting send, not as a button that leads
 * away. */
function mailBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, open, key, nameOf } = drawn;
	const target = block.id ?? "";
	if (!open)
		return blockFrame(
			block,
			key,
			" interface-detail interface-mail is-empty",
			block.title === null ? null : fillInterfaceText(block.title, {}, nameOf),
			h("p", { class: "interface-empty" }, t("Choose one to see it here.")),
		);
	const lineId = domId("line", key, open.key);
	const buttons = blockButtons(context.file, block);
	const actions = rowButtons(
		buttons.filter((drawnButton) => drawnButton.verb !== "answer"),
		open,
		drawn,
		context,
		lineId,
	);
	return blockFrame(
		block,
		key,
		" interface-detail interface-mail is-open",
		null,
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
		...mailThreadParts({
			company: context.company,
			row: open.row,
			lineId,
			blockKey: key,
			actions,
			answerable: buttons.some((drawnButton) => drawnButton.verb === "answer"),
			canWrite: context.canWrite,
			agentName: (agentId, given) => context.company.staffById(agentId)?.displayName ?? given ?? agentId,
		}),
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

/** Where a board's cards may move to: the member's own lane and the open pile, when the board has them, and the other
 * members' lanes, where a card is offered. */
interface BoardPlaces {
	readonly own: BoardLane | undefined;
	readonly pile: BoardLane | undefined;
	readonly others: readonly BoardLane[];
}

/** A board (§3.2): its lanes side by side (stacked on a phone), each with its cards, part by part. A card in the open
 * pile can be taken and one in the member's own lane released, with its button or by dragging it to the other; the card
 * stays where it is, saving, until the save has landed. Either can be offered to another member, with Offer or by
 * dragging it to their lane, and a card offered to the member accepted (step I9c). */
function boardBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, key } = drawn;
	const { parts, lanes } = drawn.board ?? { parts: [], lanes: [] };
	const places = {
		own: lanes.find((lane) => lane.own),
		pile: lanes.find((lane) => lane.kind === "open"),
		others: lanes.filter((lane) => lane.kind === "member" && !lane.own && lane.member !== null),
	};
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
		...parts.flatMap((part) => areaAdder(drawn, part, context) ?? []),
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
	// Take on a card no one holds, or one whose holder left (Interfaces C6d), Release on the member's own, in any lane of
	// a members board (a Shared card too), where the block lists them and the table lets members write; the platform's
	// own answer is not drawn on a board.
	const verbs = new Set(drawn.block.buttons);
	const holder = part.definition?.holder ?? null;
	const claimable =
		context.writes !== undefined &&
		part.mayWrite &&
		part.table !== null &&
		places.own !== undefined &&
		part.definition?.columns.some((column) => column.name === holder) === true;
	const held = holder === null ? undefined : row[holder];
	const free = emptyCell(held) || namesLeaver(context.company, held);
	const verb: ClaimVerb | null = !claimable
		? null
		: free && verbs.has("take")
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
	// Offer on a card no one holds (or whose holder left) or the member's own, to each other member who may change its
	// table's rows and hasn't been offered it yet, where the block lists offer (step I9c).
	const offers = cardOffers(context, part, item);
	const offerKey = `${drawn.key}|${card}`;
	const candidates =
		claimable && context.offers !== null && verbs.has("offer") && (free || held === context.company.userId)
			? offerCandidates(context, part, offers)
			: [];
	const offerBusy = context.page.pending.includes(`offer:${offerKey}`);
	const offering = candidates.length > 0 && context.page.offering === offerKey;
	const offer =
		candidates.length === 0
			? null
			: h(
					"button",
					{
						type: "button",
						class: "interface-button",
						"data-focus-key": `offer:${offerKey}`,
						"aria-describedby": titleId,
						"aria-expanded": String(offering),
						"aria-disabled": saving || offerBusy ? "true" : null,
						onclick: () => {
							if (saving || offerBusy) return;
							context.page.offering = offering ? null : offerKey;
							context.page.focus = offering ? `offer:${offerKey}` : `offer-to:${offerKey}:0`;
							context.redraw();
						},
					},
					t("Offer…"),
				);
	const buttons = blockButtons(context.file, drawn.block).filter((button) => button.verb !== "answer");
	const actions = rowButtons(buttons, item, partBlock(drawn, part), context, titleId);
	const own = [claim, offer].filter((button) => button !== null);
	if (own.length) actions?.prepend(...own);
	// An area's card says whose yes its supervisor waits for, or asks the member who just took it (step I9b).
	const area = areaSupervision(context, part.source, row);
	const supervision =
		area &&
		cardSupervision(context, part, item, area, {
			titleId,
			where: `supervise:${drawn.key}:${card}`,
			focusNext: [`claim:${drawn.key}:${card}`, ...(opens === null ? [] : [`open:${opens}:${item.key}`])],
		});
	const element = h(
		"li",
		{
			class: `interface-card${isOpen ? " is-open" : ""}${saving ? " is-saving" : ""}`,
			"aria-busy": saving ? "true" : null,
		},
		main,
		offerLines(
			context,
			part,
			item,
			offers,
			titleId,
			{
				claim: `claim:${drawn.key}:${card}`,
				offer: `offer:${offerKey}`,
				open: opens === null ? null : `open:${opens}:${item.key}`,
			},
			claimable ? holder : null,
		),
		supervision,
		actions ?? (own.length ? h("span", { class: "interface-actions" }, ...own) : null),
		offering ? offerPicker(context, part, item, candidates, offerKey, titleId) : null,
		saving ? h("small", { class: "interface-card-saving" }, t("Saving…")) : null,
	);
	// Dragging is the same take or release: from the open pile to the member's own lane, or back; and the same offer, to
	// another member's lane. A Shared card stays in the Shared lane either way, so it has no drag.
	const target =
		lane.kind === "shared" ? undefined : verb === "take" ? places.own : verb === "release" ? places.pile : undefined;
	const offerLanes =
		lane.kind === "shared"
			? []
			: places.others.filter((other) => candidates.some((member) => member.id === other.member));
	const targets = [...(verb !== null && target ? [target.id] : []), ...offerLanes.map((other) => other.id)];
	if (!saving && !offerBusy)
		boardDrag(element, {
			targets,
			drop: (dropped) => {
				const to = offerLanes.find((other) => other.id === dropped)?.member;
				if (to) void offerCard(context, part, item, to, offerKey);
				else if (verb !== null && dropped === target?.id) void claimCard(context, part, item, verb);
			},
		});
	return element;
}

/** A member's name on the page, or how it names someone who left (Interfaces C6d); "A member" while the members are not
 * read. */
function memberLabel(context: BlockContext, id: string): string {
	if (namesLeaver(context.company, id)) return leaverName(context.company, id);
	const member = context.company.store.get().team?.members.find((each) => each.userId === id);
	return member?.displayName || member?.email || t("A member");
}

/** A card's open offers (step I9c): those of its holder cell while the cell is as they read it, and the one an accept
 * on its way answers, which its save settled, till the card moves. */
function cardOffers(context: BlockContext, part: DrawnPart, item: InterfaceRow): MemberInterfaceOffer[] {
	const { definition } = part;
	const holder = definition?.holder ?? null;
	if (context.offers === null || definition === null || holder === null) return [];
	const table = definition.id.toLowerCase();
	const key = tableRowKey(definition, item.row);
	const held = item.row[holder];
	const was = typeof held === "string" && held !== "" ? held : null;
	const listed = context.offers.filter(
		(offer) =>
			offer.state === "open" &&
			offer.table === table &&
			offer.column === holder &&
			offer.key !== null &&
			JSON.stringify(offer.key) === key &&
			offer.was === was,
	);
	const accepting = context.page.claiming[cardKey(part, item)]?.offer;
	return accepting && !listed.some((offer) => offer.id === accepting.id) ? [...listed, accepting] : listed;
}

/** The members a card may be offered to: each other member who may change its table's rows (§5; a viewer may change
 * none), but those it is offered to already. */
function offerCandidates(
	context: BlockContext,
	part: DrawnPart,
	offers: readonly MemberInterfaceOffer[],
): { readonly id: string; readonly name: string }[] {
	const write = part.definition?.write.members;
	return (context.company.store.get().team?.members ?? [])
		.filter(
			(member) =>
				member.userId !== context.company.userId &&
				member.role !== "viewer" &&
				(write === "all" || (write === "owners" && (member.role === "owner" || member.role === "admin"))) &&
				!offers.some((offer) => offer.to === member.userId),
		)
		.map((member) => ({ id: member.userId, name: member.displayName || member.email }));
}

/** A card's open offers as lines, each with what the member may do: withdraw their own, accept (where they may take
 * the card) or decline one to them; or null when it has none. An answer whose line goes hands the focus to the card's
 * own controls: Offer… first after a withdraw, Take or Release first after an accept or decline (`show`). */
function offerLines(
	context: BlockContext,
	part: DrawnPart,
	item: InterfaceRow,
	offers: readonly MemberInterfaceOffer[],
	titleId: string,
	/** The card's own controls, by their focus keys. */
	controls: { readonly claim: string; readonly offer: string; readonly open: string | null },
	/** The cell an accept writes, the holder's, when the member may take the card; else null. */
	accepts: string | null,
): HTMLElement | null {
	if (!offers.length) return null;
	const me = context.company.userId;
	// Nothing is answered while the card saves: a take or accept on its way settles its offers.
	const saving = Object.hasOwn(context.page.claiming, cardKey(part, item));
	const lines = offers.map((offer) => {
		const busy = saving || context.page.pending.includes(`offer:${offer.id}`);
		const answer = (name: string, label: string, then: readonly (string | null)[], act: () => void) =>
			h(
				"button",
				{
					type: "button",
					class: "interface-button",
					"data-focus-key": `${name}:${offer.id}`,
					"data-focus-then": JSON.stringify(then.filter((key) => key !== null)),
					"aria-describedby": titleId,
					"aria-disabled": busy ? "true" : null,
					onclick: () => {
						if (!busy) act();
					},
				},
				label,
			);
		const from = memberLabel(context, offer.from);
		const to = memberLabel(context, offer.to);
		let words = t("{from} offered it to {to}", { from, to });
		const answers: HTMLElement[] = [];
		const afterAnswer = [controls.claim, controls.offer, controls.open];
		if (offer.from === me) {
			words = t("Offered to {name}", { name: to });
			answers.push(
				answer("withdraw", t("Withdraw"), [controls.offer, controls.claim, controls.open], () => {
					void closeOffer(context, offer, "withdraw");
				}),
			);
		} else if (offer.to === me) {
			words = t("{name} offers it to you", { name: from });
			if (accepts !== null) {
				const column = accepts;
				answers.push(
					answer(
						"accept",
						t("Accept"),
						afterAnswer,
						() => void claimCard(context, part, item, "accept", { column, offer }),
					),
				);
			}
			answers.push(answer("decline", t("Not now"), afterAnswer, () => void closeOffer(context, offer, "decline")));
		}
		return h(
			"li",
			{ class: "interface-card-offer" },
			h("span", null, words),
			answers.length ? h("span", { class: "interface-actions" }, ...answers) : null,
		);
	});
	return h("ul", { class: "interface-card-offers" }, ...lines);
}

/** The members a card may go to, each a button that offers it, and Cancel; Escape closes it too. */
function offerPicker(
	context: BlockContext,
	part: DrawnPart,
	item: InterfaceRow,
	candidates: readonly { readonly id: string; readonly name: string }[],
	offerKey: string,
	titleId: string,
): HTMLElement {
	const close = () => {
		context.page.offering = null;
		context.page.focus = `offer:${offerKey}`;
		context.redraw();
	};
	const picker = h(
		"span",
		{ class: "interface-actions interface-offer-picker", role: "group", "aria-label": t("Offer to") },
		h("span", { class: "interface-offer-picker-label", "aria-hidden": "true" }, t("Offer to")),
		...candidates.map((member, index) =>
			h(
				"button",
				{
					type: "button",
					class: "interface-button",
					"data-focus-key": `offer-to:${offerKey}:${index}`,
					// The picker closes as the offer goes; the card's Offer… stays drawn and takes the focus.
					"data-focus-then": JSON.stringify([`offer:${offerKey}`]),
					"aria-describedby": titleId,
					onclick: () => void offerCard(context, part, item, member.id, offerKey),
				},
				member.name,
			),
		),
		h(
			"button",
			{ type: "button", class: "interface-button", "data-focus-key": `offer-to:${offerKey}:cancel`, onclick: close },
			t("Cancel"),
		),
	);
	picker.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		close();
	});
	return picker;
}

/** The page's error, said once and counted, so the same words failing again are said again. */
function pageError(page: PageState, message: string, problems: readonly string[] = []): void {
	page.error = message;
	page.errorProblems = [...problems];
	page.errorShown = false;
	page.errors += 1;
}

/** Offers a card's holder cell, as the card shows it, to another member (step I9c). A refusal says why. */
async function offerCard(
	context: BlockContext,
	part: DrawnPart,
	item: InterfaceRow,
	to: string,
	offerKey: string,
): Promise<void> {
	const { page, writes } = context;
	const busy = `offer:${offerKey}`;
	const { definition } = part;
	const holder = definition?.holder ?? null;
	if (page.pending.includes(busy) || !writes?.offers || definition === null || holder === null) return;
	page.pending = [...page.pending, busy];
	page.offering = null;
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	const held = item.row[holder];
	try {
		const answer = await writes.offers.offer({
			table: definition.id.toLowerCase(),
			key: JSON.parse(tableRowKey(definition, item.row)) as TableValue[],
			column: holder,
			was: typeof held === "string" && held !== "" ? held : null,
			to,
		});
		// The offer is read again before the answer comes, so its Withdraw is drawn to take the focus.
		if (answer.ok) page.focus = `withdraw:${answer.offer.id}`;
		else pageError(page, answer.message);
	} catch (error) {
		pageError(page, describeError(error));
	}
	page.pending = page.pending.filter((key) => key !== busy);
	if (context.stillShown()) context.redraw();
}

/** Declines an offer made to the member, or withdraws one they made (step I9c). The line goes once the offers are read
 * again, and its button hands the focus on (`show`): on the board to its card's `data-focus-then`, on Pulse to the next
 * control or the block's title. */
async function closeOffer(
	context: BlockContext,
	offer: MemberInterfaceOffer,
	how: "decline" | "withdraw",
): Promise<void> {
	const { page, writes } = context;
	const busy = `offer:${offer.id}`;
	if (page.pending.includes(busy) || !writes?.offers) return;
	page.pending = [...page.pending, busy];
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	try {
		await (how === "decline" ? writes.offers.decline(offer.id) : writes.offers.withdraw(offer.id));
	} catch (error) {
		pageError(page, describeError(error));
	}
	page.pending = page.pending.filter((key) => key !== busy);
	if (context.stillShown()) context.redraw();
}

/** How long a card whose save landed may stay where it was, saving, waiting for the board to show it moved. */
const CLAIM_LANDED_WAIT = 10_000;

/** A failed take, release or accept, or a change of an area (Interfaces C6d), as the page's error: a cell someone else
 * changed says so, and a refused save lists why under `failure`. */
function claimError(page: PageState, error: unknown, failure: string): void {
	const rejected = error instanceof WebCompanyFolderRejectedError ? error : null;
	// Every read found the cell still free (or still the member's, or as the offer read it), so the file kept changing
	// elsewhere; a cell that was lost says so itself (ClaimLostError).
	if (rejected?.reason === "version_changed") pageError(page, t("That changed while you were looking."));
	else if (rejected?.problems.length) pageError(page, failure, rejected.problems);
	else pageError(page, describeError(error));
}

/** Takes or releases a card (§3.3), or accepts the offer of it (step I9c): writes its holder cell with the version it
 * read. The card stays where it was, saving, until the save has landed and the board shows the change; a card someone
 * else changed meanwhile says so, and a refused save lists why. A save settles the cell's offers, so they are read
 * again; the offer an accept answers stays on the card meanwhile. */
async function claimCard(
	context: BlockContext,
	part: DrawnPart,
	item: InterfaceRow,
	verb: ClaimVerb,
	accepted?: { readonly column: string; readonly offer: MemberInterfaceOffer },
): Promise<void> {
	const { page, company, writes } = context;
	const card = cardKey(part, item);
	if (Object.hasOwn(page.claiming, card)) return;
	const was = holderCell(part, item);
	const answers = accepted ? { offer: accepted.offer } : {};
	page.claiming = { ...page.claiming, [card]: { was, landed: false, ...answers } };
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
			...(accepted
				? { offer: { column: accepted.column, from: accepted.offer.from, was: accepted.offer.was } }
				: {}),
			memberId: company.userId,
			members: memberIds(company),
			signal: company.signal,
			check: () => {
				company.signal.throwIfAborted();
				writes.current();
			},
		});
	} catch (error) {
		claimError(page, error, claimFailure(verb));
	}
	const without = () => Object.fromEntries(Object.entries(page.claiming).filter(([other]) => other !== card));
	if (wrote) {
		void writes?.offers?.refresh();
		// An area the member takes asks whether they supervise its agents too, once it is theirs (step I9b).
		if (verb !== "release" && areaSupervision(context, part.source, item.row) !== null)
			page.askSupervise = [...page.askSupervise.filter((other) => other !== card), card];
		const landed = { was, landed: true, ...answers };
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
	const label = (text: string) => filledWords(text, item.row, drawn);
	const focus = (index: number) => `action:${drawn.key}:${item.key}:${index}`;
	const describe = { "aria-describedby": lineId };
	const drawnButtons = buttons.flatMap((drawnButton, index): HTMLElement[] => {
		if (drawnButton.verb === "answer") {
			// An offer of a cell is answered on its row (step I9c).
			if (drawn.source === "waiting" && item.row.kind === "offer") return offerAnswers(context, item, lineId);
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
		if (
			!agent ||
			!context.canWrite ||
			!messageText(drawnButton.text, item.row, drawn.source, drawn.nameOf, quotable(context, drawn.source))
		)
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

/** A waiting offer's answers (step I9c): Accept, where the member may change its table's rows, and Not now. */
function offerAnswers(context: BlockContext, item: InterfaceRow, lineId: string): HTMLElement[] {
	const offer = context.offers?.find((candidate) => candidate.id === item.row.id);
	const offered = offer && offeredRow(context.company, offer);
	if (!offer || !offered) return [];
	const busy = context.page.pending.includes(`offer:${offer.id}`);
	const answer = (name: string, label: string, act: () => void) =>
		h(
			"button",
			{
				type: "button",
				class: "interface-button",
				"data-focus-key": `${name}:${offer.id}`,
				"aria-describedby": lineId,
				"aria-disabled": busy ? "true" : null,
				onclick: () => {
					if (!busy) act();
				},
			},
			label,
		);
	return [
		memberMayWriteRows(context.company, offered.definition)
			? answer("accept", t("Accept"), () => void acceptOffer(context, offer, offered.table))
			: null,
		answer("decline", t("Not now"), () => void closeOffer(context, offer, "decline")),
	].filter((each) => each !== null);
}

/** Accepts an offer where it waits (step I9c): saves the member into the cell it names while that is as the offer read
 * it, then reads the offers again, which the save settled. */
async function acceptOffer(context: BlockContext, offer: MemberInterfaceOffer, table: string): Promise<void> {
	const { page, company, writes } = context;
	const busy = `offer:${offer.id}`;
	const { key, column } = offer;
	if (page.pending.includes(busy) || !writes || key === null || column === null) return;
	page.pending = [...page.pending, busy];
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	try {
		await claimTableCell({
			folder: writes.folder(),
			table,
			key: JSON.stringify(key),
			verb: "accept",
			offer: { column, from: offer.from, was: offer.was },
			memberId: company.userId,
			members: memberIds(company),
			signal: company.signal,
			check: () => {
				company.signal.throwIfAborted();
				writes.current();
			},
		});
		await writes.offers?.refresh();
	} catch (error) {
		claimError(page, error, claimFailure("accept"));
	}
	page.pending = page.pending.filter((other) => other !== busy);
	if (context.stillShown()) context.redraw();
}

/** The table the platform reads supervision from (§5.1). */
const AREAS_SOURCE = "table:areas";

/** An area's supervision as drawn (step I9b; RUNTIME-INTERFACES.md §5.1). */
interface AreaSupervision {
	/** The row's key, as `tableRowKey` writes it. */
	readonly key: string;
	/** The member who supervises its agents, or whose yes the `supervisor` cell waits for; or null. */
	readonly supervisor: string | null;
	/** Their live consent; undefined while the cell waits for it, or names no one. */
	readonly live: MemberInterfaceSupervision | undefined;
	/** Whether the member may change the areas' rows, so take or let go of the cell. */
	readonly mayWrite: boolean;
}

/** A row of `QorperaOS/tables/areas`' supervision, where the page can change it: the consents are read and the page
 * writes, and the table keeps `supervisor` as a member cell that needs a yes; else null, and nothing of it is drawn. A
 * live consent counts before the cell, so a consent read since the folder was shows at once: the save that changes the
 * cell makes or ends it. */
function areaSupervision(
	context: Pick<BlockContext, "company" | "supervisions" | "writes">,
	source: string,
	row: TableRow,
): AreaSupervision | null {
	const { company, supervisions } = context;
	if (source !== AREAS_SOURCE || supervisions === null || !context.writes?.offers) return null;
	const definition = tableDefinition(company, source);
	if (!definition?.columns.some((column) => column.name === "supervisor" && column.needsYes)) return null;
	const key = tableRowKey(definition, row);
	const table = definition.id.toLowerCase();
	const live = supervisions.find(
		(each) => each.state === "live" && each.table === table && each.key !== null && JSON.stringify(each.key) === key,
	);
	// A cell that names someone who left counts as empty (Interfaces C6d): their consent ended when they left.
	const cell = row.supervisor;
	return {
		key,
		supervisor: live?.user ?? (typeof cell === "string" && cell !== "" && !namesLeaver(company, cell) ? cell : null),
		live,
		mayWrite: memberMayWriteRows(company, definition),
	};
}

/** Whether an area's card may ask the member to supervise its agents too: it is theirs, no one supervises them, and the
 * member may take the cell. */
function asksToSupervise(part: DrawnPart, item: InterfaceRow, area: AreaSupervision, me: string): boolean {
	const holder = part.definition?.holder ?? null;
	return area.supervisor === null && area.mayWrite && holder !== null && item.row[holder] === me;
}

/** What a member does with an area's supervision: take the empty `supervisor` cell, say yes again where it names them,
 * pause that yes, or let the cell go. */
type SuperviseVerb = "take" | "consent" | "withdraw" | "release";

/** An area's change on its way, by its row: its buttons wait, on its card and in its detail. */
const superviseBusy = (area: AreaSupervision) => `supervise:${area.key}`;

/** One of an area's supervision buttons. `focusNext` names the controls the focus goes to when it goes (`show`). */
function superviseButton(
	context: BlockContext,
	area: AreaSupervision,
	verb: SuperviseVerb,
	label: string,
	place: { readonly where: string; readonly describedBy: string; readonly focusNext: readonly string[] },
	card?: string,
): HTMLElement {
	const busy = context.page.pending.includes(superviseBusy(area));
	return h(
		"button",
		{
			type: "button",
			class: "interface-button",
			"data-focus-key": `${place.where}:${verb}`,
			"data-focus-then": JSON.stringify(place.focusNext),
			"aria-describedby": place.describedBy,
			"aria-disabled": busy ? "true" : null,
			onclick: () => {
				if (!busy) void superviseArea(context, area, verb, card);
			},
		},
		label,
	);
}

/** An area's supervision in words, with its buttons. */
function supervisionLine(words: string, buttons: readonly HTMLElement[]): HTMLElement {
	return h(
		"p",
		{ class: "interface-supervision" },
		h("span", null, words),
		buttons.length ? h("span", { class: "interface-actions" }, ...buttons) : null,
	);
}

/** An area card's supervision line: whose yes its supervisor cell waits for, with Supervise where it is the member's;
 * or, on an area they just took, whether they supervise its agents too, with Supervise and Not now. Null when there is
 * nothing to say. An answer whose line goes hands the focus to the card's own controls. */
function cardSupervision(
	context: BlockContext,
	part: DrawnPart,
	item: InterfaceRow,
	area: AreaSupervision,
	controls: { readonly titleId: string; readonly where: string; readonly focusNext: readonly string[] },
): HTMLElement | null {
	const me = context.company.userId;
	const card = cardKey(part, item);
	const place = { where: controls.where, describedBy: controls.titleId, focusNext: controls.focusNext };
	if (area.supervisor === null) {
		if (!context.page.askSupervise.includes(card) || !asksToSupervise(part, item, area, me)) return null;
		const busy = context.page.pending.includes(superviseBusy(area));
		const notNow = h(
			"button",
			{
				type: "button",
				class: "interface-button",
				"data-focus-key": `${controls.where}:not-now`,
				"data-focus-then": JSON.stringify(controls.focusNext),
				"aria-describedby": controls.titleId,
				"aria-disabled": busy ? "true" : null,
				onclick: () => {
					if (busy) return;
					context.page.askSupervise = context.page.askSupervise.filter((other) => other !== card);
					context.redraw();
				},
			},
			t("Not now"),
		);
		return supervisionLine(t("Supervise its agents too?"), [
			superviseButton(context, area, "take", t("Supervise"), place, card),
			notNow,
		]);
	}
	if (area.live !== undefined) return null;
	if (area.supervisor !== me)
		return supervisionLine(
			t("Waiting for {name}'s yes to supervise its agents.", { name: memberLabel(context, area.supervisor) }),
			[],
		);
	return supervisionLine(
		t("Waiting for your yes to supervise its agents."),
		context.canWrite ? [superviseButton(context, area, "consent", t("Supervise"), place, card)] : [],
	);
}

/** An area's supervision in its detail: Supervise where no one supervises its agents; Pause and Step down for the
 * member who does; Supervise and Step down where the cell waits for the member's yes; and whose yes it waits for
 * otherwise. Each button hands the focus to the one that takes its place. */
function detailSupervision(
	context: BlockContext,
	drawn: DrawnBlock,
	open: InterfaceRow,
	lineId: string,
): HTMLElement | null {
	const area = areaSupervision(context, drawn.source, open.row);
	if (area === null) return null;
	const where = `supervise:${drawn.key}:${open.key}`;
	const control = (verb: SuperviseVerb, label: string, then: readonly SuperviseVerb[]) =>
		superviseButton(context, area, verb, label, {
			where,
			describedBy: lineId,
			focusNext: then.map((each) => `${where}:${each}`),
		});
	const { supervisor, live } = area;
	if (supervisor === null)
		return supervisionLine(
			t("Nobody supervises its agents."),
			area.mayWrite ? [control("take", t("Supervise"), ["withdraw", "release"])] : [],
		);
	if (supervisor !== context.company.userId)
		return live
			? null
			: supervisionLine(
					t("Waiting for {name}'s yes to supervise its agents.", { name: memberLabel(context, supervisor) }),
					[],
				);
	const stepDown = area.mayWrite ? [control("release", t("Step down"), ["take"])] : [];
	if (live)
		return supervisionLine(t("You supervise its agents."), [
			control("withdraw", t("Pause"), ["consent"]),
			...stepDown,
		]);
	return supervisionLine(t("Waiting for your yes to supervise its agents."), [
		...(context.canWrite ? [control("consent", t("Supervise"), ["withdraw"])] : []),
		...stepDown,
	]);
}

/** Changes an area's supervision (step I9b; §5.1). Take and release write the area's `supervisor` cell the way Take and
 * Release write a card's holder, and that save makes or ends the member's consent; Supervise where the cell names them
 * consents again, and Pause ends the consent, the cell staying as it is. The consents are read again before the buttons
 * come back. A card's question goes once it is answered. */
async function superviseArea(
	context: BlockContext,
	area: AreaSupervision,
	verb: SuperviseVerb,
	card?: string,
): Promise<void> {
	const { page, company, writes } = context;
	const busy = superviseBusy(area);
	const offers = writes?.offers;
	if (page.pending.includes(busy) || !writes || !offers) return;
	page.pending = [...page.pending, busy];
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	let done = false;
	try {
		if (verb === "consent") {
			const answer = await offers.consent(JSON.parse(area.key) as TableValue[]);
			if (answer.ok) done = true;
			else pageError(page, answer.message);
		} else if (verb === "withdraw") {
			if (area.live) await offers.withdrawSupervision(area.live.id);
			done = true;
		} else {
			await claimTableCell({
				folder: writes.folder(),
				table: AREAS_SOURCE.slice("table:".length),
				key: area.key,
				verb,
				column: "supervisor",
				memberId: company.userId,
				members: memberIds(company),
				signal: company.signal,
				check: () => {
					company.signal.throwIfAborted();
					writes.current();
				},
			});
			await offers.refresh();
			done = true;
		}
	} catch (error) {
		if (verb === "take" || verb === "release") claimError(page, error, t("The supervisor could not be changed."));
		else pageError(page, describeError(error));
	}
	page.pending = page.pending.filter((other) => other !== busy);
	if (done && card !== undefined) page.askSupervise = page.askSupervise.filter((other) => other !== card);
	if (context.stillShown()) context.redraw();
}

/** The agents a member may add to an area, by name: those that work here and are in no area yet (an agent is in one
 * area only, §5.1). */
function areaAgentChoices(company: CompanyController): HostedStaffAgent[] {
	const placed = new Set((interfaceRows(company, AREAS_SOURCE) ?? []).flatMap(({ row }) => agentList(row.agents)));
	const collator = new Intl.Collator(presentationLocale(), { sensitivity: "base" });
	return company.store
		.get()
		.staff.filter((agent) => agent.employmentStatus === "active" && !placed.has(agent.id))
		.sort((a, b) => collator.compare(a.displayName, b.displayName) || (a.id < b.id ? -1 : 1));
}

/** The areas' part's Add an area (Interfaces C6d): where the member may change the areas' rows, a button that opens a
 * form for the new area's name and what it is about, which adds it as theirs. With no areas yet it says so first. */
function areaAdder(drawn: DrawnBlock, part: DrawnPart, context: BlockContext): HTMLElement | null {
	const { page } = context;
	if (part.source !== AREAS_SOURCE || !part.readable) return null;
	const none = interfaceRows(context.company, AREAS_SOURCE)?.length
		? null
		: h("p", { class: "interface-empty" }, t("No areas yet."));
	if (!context.writes || !part.mayWrite) return none;
	const where = `add-area:${drawn.key}:${part.index}`;
	const draft = page.areaDraft;
	if (draft === null)
		return h(
			"div",
			{ class: "interface-area-add" },
			none,
			h(
				"button",
				{
					type: "button",
					class: "interface-button",
					"data-focus-key": where,
					onclick: () => {
						page.areaDraft = { area: "", about: "" };
						page.focus = `${where}:area`;
						context.redraw();
					},
				},
				t("Add an area"),
			),
		);
	const busy = page.pending.includes(where);
	const close = () => {
		page.areaDraft = null;
		page.focus = where;
		context.redraw();
	};
	// What is typed stays in the page's state, so a redraw while the form is open keeps it.
	const field = (name: "area" | "about", label: string) => {
		const column = part.definition?.columns.find((each) => each.name === name);
		if (column === undefined) return null;
		return h(
			"label",
			{ class: "interface-area-field" },
			h("span", null, label),
			h("input", {
				type: "text",
				value: draft[name],
				maxlength: column.max === null ? null : String(column.max),
				"data-focus-key": `${where}:${name}`,
				oninput: (event: Event) => {
					draft[name] = (event.target as HTMLInputElement).value;
				},
			}),
		);
	};
	return h(
		"form",
		{
			class: "interface-area-form",
			"aria-label": t("Add an area"),
			onsubmit: (event: Event) => {
				event.preventDefault();
				void addAreaRow(context, where);
			},
			onkeydown: (event: KeyboardEvent) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				close();
			},
		},
		field("area", t("Name")),
		field("about", t("About")),
		h(
			"span",
			{ class: "interface-actions" },
			h(
				"button",
				{
					type: "submit",
					class: "interface-button",
					"data-focus-key": `${where}:save`,
					"aria-disabled": busy ? "true" : null,
				},
				busy ? t("Saving…") : t("Save"),
			),
			h(
				"button",
				{ type: "button", class: "interface-button", "data-focus-key": `${where}:cancel`, onclick: close },
				t("Cancel"),
			),
		),
	);
}

/** Adds the area the form holds, as the member's (Interfaces C6d; app/interface-areas.ts writes the areas table first
 * where the folder has none yet). The form closes once it is saved, and the board shows the area once the folder is
 * read again; a refusal says why under the form's words, and the folder is read again. */
async function addAreaRow(context: BlockContext, where: string): Promise<void> {
	const { page, company, writes } = context;
	const draft = page.areaDraft;
	if (draft === null || !writes || page.pending.includes(where)) return;
	const area = draft.area.trim();
	if (!area) {
		pageError(page, t("An area needs a name."));
		page.focus = `${where}:area`;
		context.redraw();
		return;
	}
	page.pending = [...page.pending, where];
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	try {
		await addArea({
			folder: writes.folder(),
			memberId: company.userId,
			members: memberIds(company),
			signal: company.signal,
			check: () => {
				company.signal.throwIfAborted();
				writes.current();
			},
			area,
			about: draft.about,
		});
		page.areaDraft = null;
		page.focus = where;
	} catch (error) {
		claimError(page, error, t("The area could not be added."));
		writes.reread?.();
	}
	page.pending = page.pending.filter((other) => other !== where);
	if (context.stillShown()) context.redraw();
}

/** An area's change of its agents on its way, by its row: its Remove and Add an agent wait. */
const agentsBusy = (area: AreaSupervision) => `agents:${area.key}`;

/** The rules' words (§5.1, rule 9) for the two refusals of an area's new agent, which the page says in its own:
 * the agent is in another area, or someone's yes to supervise the area's agents is live and only they add them. */
const ONE_AREA_ONLY = "an agent is in one area only";
const SUPERVISOR_ADDS = "only the area's supervisor adds its agents";

/** An area's agents in its detail (Interfaces C6d; §5.1), with what the rules let the member do, whatever their role:
 * Remove for each where they may change the areas' rows; Add an agent where they may and no one's yes to supervise the
 * area's agents is live, or it is theirs. While someone else's is, it says that only they add agents. Each Remove
 * hands the focus to the next one, then to Add an agent. Null where the page can't change the area's agents. */
function detailAgents(
	context: BlockContext,
	drawn: DrawnBlock,
	open: InterfaceRow,
	lineId: string,
): HTMLElement | null {
	const { company, page } = context;
	const area = areaSupervision(context, drawn.source, open.row);
	const definition = tableDefinition(company, drawn.source);
	if (area === null || !definition?.columns.some((column) => column.name === "agents" && column.type === "agents"))
		return null;
	const agents = agentList(open.row.agents);
	const where = `agents:${drawn.key}:${open.key}`;
	const add = `${where}:add`;
	const remove = (agent: string) => `${where}:remove:${agent}`;
	const busy = page.pending.includes(agentsBusy(area));
	const control = (label: string, focus: string, then: readonly string[], act: () => void) =>
		h(
			"button",
			{
				type: "button",
				class: "interface-button",
				"data-focus-key": focus,
				"data-focus-then": JSON.stringify(then),
				"aria-describedby": lineId,
				"aria-disabled": busy ? "true" : null,
				onclick: () => {
					if (!busy) act();
				},
			},
			label,
		);
	const removes = area.mayWrite
		? agents.map((agent, index) =>
				control(
					t("Remove {name}", { name: drawn.nameOf("agents", [agent]) }),
					remove(agent),
					[...agents.slice(index + 1), ...agents.slice(0, index).reverse()].map(remove).concat(add),
					() =>
						void changeAreaAgents(
							context,
							area,
							agents,
							agents.filter((other) => other !== agent),
						),
				),
			)
		: [];
	const { live } = area;
	const adds =
		area.mayWrite && (live === undefined || live.user === company.userId)
			? page.addingAgents === area.key
				? [agentPicker(context, area, agents, where, lineId)]
				: [
						control(t("Add an agent"), add, [], () => {
							const first = areaAgentChoices(company)[0];
							page.addingAgents = area.key;
							page.focus = first ? `${where}:choose:${first.id}` : `${where}:choose-cancel`;
							context.redraw();
						}),
					]
			: [];
	const others =
		live !== undefined && live.user !== company.userId
			? h(
					"p",
					null,
					t("Only {name}, who supervises its agents, adds agents.", { name: memberLabel(context, live.user) }),
				)
			: null;
	if (!removes.length && !adds.length && others === null) return null;
	return h(
		"div",
		{ class: "interface-area-agents" },
		others,
		removes.length || adds.length ? h("span", { class: "interface-actions" }, ...removes, ...adds) : null,
	);
}

/** The agents an area may get, each a button that adds it, and Cancel; Escape closes it too. With none left it says
 * so. An added agent's Remove takes the focus once the area shows it. */
function agentPicker(
	context: BlockContext,
	area: AreaSupervision,
	agents: readonly string[],
	where: string,
	lineId: string,
): HTMLElement {
	const { page } = context;
	const close = () => {
		page.addingAgents = null;
		page.focus = `${where}:add`;
		context.redraw();
	};
	const choices = areaAgentChoices(context.company);
	const picker = h(
		"span",
		{ class: "interface-actions interface-offer-picker", role: "group", "aria-label": t("Add an agent") },
		choices.length
			? null
			: h("span", { class: "interface-offer-picker-label" }, t("Every agent is in an area already.")),
		...choices.map((agent) =>
			h(
				"button",
				{
					type: "button",
					class: "interface-button",
					"data-focus-key": `${where}:choose:${agent.id}`,
					"data-focus-then": JSON.stringify([`${where}:remove:${agent.id}`, `${where}:add`]),
					"aria-describedby": lineId,
					onclick: () => void changeAreaAgents(context, area, agents, [...agents, agent.id], agent.id),
				},
				agent.displayName,
			),
		),
		h(
			"button",
			{ type: "button", class: "interface-button", "data-focus-key": `${where}:choose-cancel`, onclick: close },
			t("Cancel"),
		),
	);
	picker.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		close();
	});
	return picker;
}

/** Sets an area's agents, from those its detail showed (Interfaces C6d). An agent another area has by now, or an area
 * whose agents only its supervisor adds by now, is said in plain words; an area that changed meanwhile says that. After
 * any of them the folder and the consents are read again, so the detail shows the area as it is now. */
async function changeAreaAgents(
	context: BlockContext,
	area: AreaSupervision,
	shown: readonly string[],
	agents: readonly string[],
	added?: string,
): Promise<void> {
	const { page, company, writes } = context;
	const busy = agentsBusy(area);
	if (page.pending.includes(busy) || !writes) return;
	page.pending = [...page.pending, busy];
	page.addingAgents = null;
	page.error = null;
	page.errorProblems = [];
	context.redraw();
	try {
		await setAreaAgents({
			folder: writes.folder(),
			memberId: company.userId,
			members: memberIds(company),
			signal: company.signal,
			check: () => {
				company.signal.throwIfAborted();
				writes.current();
			},
			key: area.key,
			shown,
			agents,
		});
	} catch (error) {
		const refused = error instanceof WebCompanyFolderRejectedError ? error.problems : [];
		const elsewhere =
			error instanceof AgentInAreaError
				? error.agent
				: refused.some((problem) => problem.includes(ONE_AREA_ONLY))
					? added
					: undefined;
		if (elsewhere !== undefined)
			pageError(
				page,
				t("{name} is already in another area.", {
					name: company.staffById(elsewhere)?.displayName ?? t("That agent"),
				}),
			);
		else if (refused.some((problem) => problem.includes(SUPERVISOR_ADDS)))
			pageError(page, t("Only the area's supervisor adds its agents now."));
		else claimError(page, error, t("The area's agents could not be changed."));
		writes.reread?.();
		void writes.offers?.refresh();
	}
	page.pending = page.pending.filter((other) => other !== busy);
	if (context.stillShown()) context.redraw();
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

/** Whether the cloud takes a quote of a source's record: of a mail thread, unless it is account mail. */
const quotable = (context: BlockContext, source: string) => (ref: string) =>
	source !== "mail" || !isAccountMail(context.company, ref);

/** The text a `message` button puts in the composer, with its quotes. A value from a column that carries outside
 * content (RUNTIME-INTERFACES.md §4) goes as a quote (contract, the 2026-10-02 amendment "quoted outside content in
 * a member's message"): in «» marks on the same line, with where it came from, so the platform fences those words
 * and the review never reads them as the member's own. An empty value fills in nothing.
 *
 * Undefined when a value from outside content can't travel as a quote: its source is not on the contract's quote
 * list, the row doesn't name the record it came from (a mail row without its thread id), or the cloud takes no quote
 * of that record (`quotable`: account mail). The button is then not drawn for that row (rowButtons): filling the value
 * in as the member's own words is what a quote is there to prevent, and leaving it out would put in less than the
 * button says, with nothing to tell the member. */
export function messageText(
	text: string,
	row: TableRow,
	source: string,
	nameOf: (column: string, value: unknown) => string,
	quotable: (ref: string) => boolean = () => true,
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
			!quotable(ref) ||
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
	const text = messageText(drawnButton.text, row, drawn.source, drawn.nameOf, quotable(context, drawn.source));
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
