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
	type InterfaceFile,
	type InterfaceQuery,
	interfaceOutsideColumns,
	type TableRow,
	type TableValue,
} from "@qorpera/cloud-client/interfaces";
import { describeError } from "../../cloud/client.ts";
import { type MessageQuote, QUOTE_MAX_CHARACTERS, quoteRefFits } from "../../cloud/quotes.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, fmtTime, h, notice, replace, spinner } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { isPhoneLayout } from "../../ui/layout.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationLocale, presentationTimeZone, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { DATA_PAGE } from "../data-page.ts";
import type { InterfaceWrites } from "../interface-claims.ts";
import type { FolderProblem } from "../interface-folder.ts";
import { isAccountMail } from "../interface-mail.ts";
import {
	blockButtons,
	companyInterface,
	companyInterfaces,
	type DrawnButton,
	type InterfaceRow,
	idColumn,
	interfaceRows,
	interfaceSource,
	interfaceViews,
	isLiveSource,
	leaverName,
	namesLeaver,
	QUOTE_RECORD_COLUMNS,
	rowHasCard,
	tableDefinition,
	type ViewBlock,
	viewBlocks,
} from "../interfaces.ts";
import type { QuotedText } from "../quotes.ts";
import { renderBank } from "./bank.ts";
import { renderData } from "./data.ts";
import { textBlock } from "./interface-blocks.ts";
import { renderMailbox } from "./mailbox.ts";
import { renderMembers } from "./members.ts";

/** Marks an element as holding words from outside the company (§4): a quiet tint, and a title that says so. */
function outside<T extends HTMLElement>(element: T): T {
	element.classList.add("interface-outside");
	element.title = t("From outside the company");
	return element;
}

/** A list line's words, and whether they came from outside. */
interface ListText {
	readonly text: string;
	readonly outside: boolean;
}

/** What each container last showed, and the element that shows it. The page area is shared with every other
 * page, so a redraw is skipped only while that element is still the one on screen. */
const shownIn = new WeakMap<HTMLElement, { key: string; element: Element }>();

/** A block's title (`blockFrame`). It takes the focus from a control that went when the page has none left (`show`),
 * so it can be focused, though not tabbed to. */
const BLOCK_TITLE = ".interface-block > h2";

/** Draws `build()` unless the same key is on screen. Every control names itself with `data-focus-key`, so the
 * one that had keyboard focus (and a text field's caret) has it again after the redraw; `moveFocus` names another. In a
 * redraw of the same view, a focused control that is gone hands the focus on: to the first of its `data-focus-then`
 * keys (a JSON list) still drawn, else to the nearest control after it that is still there, else before it, else to
 * its block's title (a page left with no control). Whatever scrolls names itself with `data-scroll-key` and is
 * where the member left it after the redraw; the first on the page is the page's own, and names its view. */
export function show(container: HTMLElement, key: string, build: () => HTMLElement, moveFocus?: string): void {
	const shown = shownIn.get(container);
	if (shown?.key === key && container.firstElementChild === shown.element && shown.element.isConnected) return;
	const active = document.activeElement;
	const focused = active instanceof HTMLElement && container.contains(active) ? active : null;
	const focusKey = focused?.dataset.focusKey;
	const caret =
		active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
			? ([active.selectionStart, active.selectionEnd] as const)
			: undefined;
	const scrollers = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-scroll-key]")];
	// Read while that page is still on screen: once it has left, a browser says each is at its top.
	const scrolled =
		shown && container.firstElementChild === shown.element
			? scrollers(shown.element).map((each) => [each.dataset.scrollKey, each.scrollTop] as const)
			: [];
	const element = build();
	const drawn = scrollers(element);
	const sameView = scrolled[0] !== undefined && drawn[0]?.dataset.scrollKey === scrolled[0][0];
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
	again?.focus({ preventScroll: true });
	// The caret goes back only into the field that had it.
	const same = again?.dataset.focusKey === focusKey;
	const field = again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement ? again : undefined;
	if (field && same && caret && field === document.activeElement) field.setSelectionRange(caret[0], caret[1]);
	// Last, so that the focus and the caret move nothing after it.
	for (const each of drawn) {
		const was = scrolled.find(([named]) => named === each.dataset.scrollKey);
		if (was) each.scrollTop = was[1];
	}
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
	if (isLiveSource(source)) {
		const label: Record<string, () => string> = {
			agent: () => t("Agent"),
			what: () => t("What"),
			since: () => t("Since"),
			kind: () => t("Kind"),
			title: () => t("Title"),
			from: () => t("From"),
			due: () => t("Due"),
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
	};
	return label[kind]?.() ?? kind;
}

export function renderInterface(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	writes?: InterfaceWrites,
): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const locale = presentationLocale();
	if (state.connectionLost && (!state.team || !state.staff.length)) {
		show(container, JSON.stringify(["reconnecting", profileId, locale]), () =>
			h("section", { class: "page interface-waiting" }, spinner(t("Can't reach Qorpera. Trying again…"))),
		);
		return;
	}
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
		renderMailbox(container, company, name, writes?.mailManage ? { manage: writes.mailManage } : {});
		return;
	}
	// The Members page draws who each agent works for (views/members.ts; Jonas, 9 November 2026).
	if (entry.name === "members") {
		renderMembers(container, company, writes?.openSettings ? { openSettings: writes.openSettings } : {});
		return;
	}
	// The Bank page draws itself from the company's bank summary (views/bank.ts).
	if (entry.name === "bank") {
		renderBank(container, company, writes?.bankConnection ? { connection: writes.bankConnection } : {});
		return;
	}
	const databases = entry.name === DATA_PAGE ? writes?.data?.() : undefined;
	if (databases) {
		renderData(container, company, databases, writes?.dataAsk);
		return;
	}
	// Every redraw the page asks for (a tab, a sort, an opened row, a message that failed after the page was switched
	// off) finds the page again, so a page switched off is never drawn.
	renderInterfaceFile(container, company, name, entry.file, () => renderInterface(container, company, name, writes));
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
}

/** Draws an interface definition. `renderInterface` finds the definition, and finds it again for every redraw the
 * page asks for (`redraw`); tests pass one directly, and redraw that one. */
export function renderInterfaceFile(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	file: InterfaceFile,
	again?: () => void,
): void {
	const redraw = again ?? (() => renderInterfaceFile(container, company, name, file));
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
	const blocks: DrawnBlock[] = view.blocks.map((shown, index) => {
		const { block } = shown;
		const key = block.id ?? `${view.name}#${index}`;
		const source = block.from[0] ?? "";
		const rows = sourceRows(source, shown.narrow, block.query, block);
		const read = interfaceSource(company, source);
		const drawn = {
			block,
			source,
			key,
			rows,
			// A row opens only into a detail drawn here; otherwise it keeps its own link.
			opens: block.opens !== null && details.has(block.opens) ? block.opens : null,
			nameOf: namesFor(source),
			readable: read?.readable ?? true,
			problems: read?.problems ?? [],
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
	const named = (want: "agent" | "member") =>
		blocks.flatMap(({ source, rows }) =>
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
		canWrite,
		listed,
		cofounder,
		widths,
		agentLooks,
		memberNames,
		// Each block's source as drawn beside its rows: whether it can be read (a table that recovers with no rows
		// still draws again) and what its columns hold, which a table's definition says outside the page's.
		blocks.map(({ block, source, rows, open, readable, problems }) => [
			block.title,
			rows,
			open?.key ?? null,
			readable,
			problems,
			(interfaceSource(company, source)?.columns ?? []).map((column) => idColumn(company, source, column)),
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
					interfaceEmblem(file.emblem, 30),
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
	/** Whether this page is still the one on screen, for work that finishes after a click. */
	readonly stillShown: () => boolean;
}

function drawBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	if (drawn.block.kind === "table") return tableBlock(drawn, context);
	if (drawn.block.kind === "detail") return detailBlock(drawn, context);
	if (drawn.block.kind === "text") {
		const { block, key } = drawn;
		return textBlock(drawn, {
			frame: (extra, ...children) => blockFrame(block, key, extra, block.title, ...children),
			note: sourceNote(drawn),
			readable: drawn.readable,
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

function cellText(drawn: DrawnBlock, column: string, value: TableValue | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? t("Yes") : t("No");
	if (typeof value === "string" && INSTANT.test(value)) return fmtTime(value) || value;
	if (drawn.source === "waiting" && column === "kind" && typeof value === "string") return kindLabel(value);
	return drawn.nameOf(column, value);
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
		const line = { text: fillInterfaceText(template, row, nameOf), outside: fillsOutside(template, drawn.source) };
		const sub = {
			text: block.sub ? fillInterfaceText(block.sub, row, nameOf) : "",
			outside: fillsOutside(block.sub, drawn.source),
		};
		const statusText = block.status ? cellText(drawn, block.status, row[block.status]) : "";
		const status = statusText ? h("span", { class: "interface-item-status" }, statusText) : null;
		const byAgent = typeof agentId === "string" && block.figure === "agent";
		const lineId = domId("line", key, item.key);
		const body = [
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
					: h("td", index === 0 ? { id: lineId } : null, value);
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
		actions,
	);
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
