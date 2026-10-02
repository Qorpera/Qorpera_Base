/* An interface page (`#/c/{id}/i/{name}`): the library's definition drawn from the fixed blocks with the
 * company's live state. Every value is read with the member's own authority through the store the rest of the
 * app reads; the file only arranges blocks and names sources. Text from a file is set as text, never markup. */

import {
	compareInterfaceValues,
	fillInterfaceText,
	interfaceCell,
	plainText,
	queryInterfaceRows,
} from "@qorpera/cloud-client/interface-query";
import type { InterfaceBlock, InterfaceFile, TableRow, TableValue } from "@qorpera/cloud-client/interfaces";
import { agentFigure } from "../../ui/avatar.ts";
import { button, fmtTime, h, notice, replace, spinner } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import {
	blockButtons,
	companyInterface,
	companyInterfaces,
	type DrawnButton,
	type InterfaceRow,
	interfaceRows,
	interfaceSourceTime,
	interfaceViews,
	OUTSIDE_COLUMNS,
	viewBlocks,
} from "../interfaces.ts";

/** What each container last showed, and the element that shows it. The page area is shared with every other
 * page, so a redraw is skipped only while that element is still the one on screen. */
const shownIn = new WeakMap<HTMLElement, { key: string; element: Element }>();

/** Draws `build()` unless the same key is on screen. A control rebuilt in place (a filter field, a tab, a sort
 * button) keeps keyboard focus and the caret through the redraw: it names itself with `data-focus-key`. */
function show(container: HTMLElement, key: string, build: () => HTMLElement, moveFocus?: string): void {
	const shown = shownIn.get(container);
	if (shown?.key === key && container.firstElementChild === shown.element && shown.element.isConnected) return;
	const active = document.activeElement;
	const focusKey =
		moveFocus ?? (active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : undefined);
	const caret =
		active instanceof HTMLInputElement ? ([active.selectionStart, active.selectionEnd] as const) : undefined;
	const element = build();
	replace(container, element);
	shownIn.set(container, { key, element });
	if (focusKey === undefined) return;
	const again = [...element.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
		(candidate) => candidate.dataset.focusKey === focusKey,
	);
	again?.focus({ preventScroll: true });
	if (again instanceof HTMLInputElement && caret) again.setSelectionRange(caret[0], caret[1]);
}

/** What the member chose on a page: its view, the row each opened block shows, and each table's sort and filter.
 * It lasts while the app is open, per company and interface. */
interface PageState {
	view: string | null;
	open: Record<string, string>;
	sort: Record<string, { readonly column: string; readonly descending: boolean }>;
	filter: Record<string, string>;
	error: string | null;
	/** A control the next draw focuses: the tab an arrow key chose. */
	focus: string | null;
}
const pages = new Map<string, PageState>();
function pageState(key: string): PageState {
	let state = pages.get(key);
	if (!state) {
		state = { view: null, open: {}, sort: {}, filter: {}, error: null, focus: null };
		pages.set(key, state);
	}
	return state;
}

/** Columns that hold an agent's id: drawn as the agent's name. */
const AGENT_COLUMNS: ReadonlySet<string> = new Set(["agent", "from", "handled_by", "kept_by"]);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A row's identity within its source, for the row a block has open. */
export function interfaceRowKey(row: TableRow): string {
	for (const column of ["id", "thread", "address", "agent"]) {
		const value = interfaceCell(row, column);
		if (typeof value === "string" && value) return value;
	}
	return JSON.stringify(row);
}

/** A column name as a heading: `last_7_days` → "Last 7 days". */
function heading(column: string): string {
	const words = column.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export function renderInterface(container: HTMLElement, company: CompanyController, name: string): void {
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
	renderInterfaceFile(container, company, name, entry.file);
}

/** One block as drawn: the rows it shows, in its query's order, and for a `detail` block the row it has open. */
interface DrawnBlock {
	readonly block: InterfaceBlock;
	readonly key: string;
	readonly rows: readonly InterfaceRow[];
	readonly open?: InterfaceRow;
}

/** Draws an interface definition. `renderInterface` finds the definition; tests pass one directly. */
export function renderInterfaceFile(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	file: InterfaceFile,
): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const locale = presentationLocale();
	const page = pageState(`${profileId}/${name}`);
	const redraw = () => renderInterfaceFile(container, company, name, file);
	const views = interfaceViews(file)
		.map((view) => ({ name: view.name, blocks: viewBlocks(view) }))
		.filter((view) => view.blocks.length > 0);
	const view = views.find((candidate) => candidate.name === page.view) ?? views[0];
	if (!view) return;
	const now = Date.now();
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const clock = { now, startOfToday: today.getTime() };
	const sourceRows = (block: InterfaceBlock) => {
		const source = block.from[0] ?? "";
		const rows = interfaceRows(company, source) ?? [];
		// The query decides which rows show and in what order; each row keeps the link it came with.
		const byRow = new Map<TableRow, InterfaceRow>(rows.map((row) => [row.row, row]));
		return queryInterfaceRows(
			rows.map((row) => row.row),
			block.query,
			{ time: interfaceSourceTime(source), clock },
		).flatMap((row) => byRow.get(row) ?? []);
	};
	const blocks: DrawnBlock[] = view.blocks.map((block, index) => {
		const key = block.id ?? `${view.name}#${index}`;
		const rows = sourceRows(block);
		if (block.kind !== "detail" || block.id === null) return { block, key, rows };
		const opened = page.open[block.id];
		const open = opened === undefined ? undefined : rows.find((row) => interfaceRowKey(row.row) === opened);
		return { block, key, rows, ...(open ? { open } : {}) };
	});
	// A part-width block whose neighbours have no source today stands alone, so it takes the whole row.
	const widths = blocks.map(({ block }, index) => {
		if (block.width === "full") return "full";
		const partner = (at: number) => blocks[at] !== undefined && blocks[at]?.block.width !== "full";
		return partner(index - 1) || partner(index + 1) ? block.width : "full";
	});
	const nameOf = (column: string, value: unknown) => {
		if (typeof value === "string" && AGENT_COLUMNS.has(column)) {
			return company.staffById(value)?.displayName ?? plainText(value);
		}
		return plainText(value as never);
	};
	// The agents a page names or draws, by how they look, so a rename or a new figure redraws it.
	const agentLooks = [
		...new Set(
			blocks.flatMap(({ rows }) =>
				rows.flatMap(({ row }) =>
					Object.entries(row).flatMap(([column, value]) =>
						AGENT_COLUMNS.has(column) && typeof value === "string" ? [value] : [],
					),
				),
			),
		),
	].map((id) => {
		const agent = company.staffById(id);
		return [id, agent?.displayName, agent?.appearance];
	});
	const live = state.realtime === "connected";
	const moveFocus = page.focus ?? undefined;
	page.focus = null;
	const hasOpen = blocks.some((drawn) => drawn.open !== undefined);
	const key = JSON.stringify([
		profileId,
		locale,
		name,
		file.name,
		file.about,
		live ? "live" : [state.realtime, state.realtimeError ?? ""],
		views.map((candidate) => candidate.name),
		view.name,
		page.view,
		page.open,
		page.sort,
		page.filter,
		page.error,
		widths,
		agentLooks,
		blocks.map(({ block, rows, open }) => [block.title, rows, open?.row ?? null]),
	]);
	const context: BlockContext = {
		company,
		file,
		profileId,
		nameOf,
		figureOf: (agentId) => agentFigure(company.staffById(agentId), nameOf("agent", agentId), { size: 30 }),
		page,
		redraw,
	};
	show(
		container,
		key,
		() =>
			h(
				"section",
				{ class: "interface", "data-interface": name },
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
				views.length > 1 ? viewTabs(views, view.name, page, redraw) : null,
				page.error ? notice("danger", page.error) : null,
				h(
					"div",
					{ class: `interface-page${hasOpen ? " has-open" : ""}` },
					...blocks.map((drawn, index) =>
						drawBlock({ ...drawn, block: { ...drawn.block, width: widths[index] ?? "full" } }, context),
					),
				),
			),
		moveFocus,
	);
}

/** The page's views as tabs. A view changes the blocks shown and closes what was open; the route stays. */
function viewTabs(
	views: readonly { readonly name: string }[],
	current: string,
	page: PageState,
	redraw: () => void,
): HTMLElement {
	const choose = (name: string, byKey = false) => {
		if (page.view === name) return;
		page.view = name;
		page.open = {};
		page.error = null;
		// A key moves focus with the choice; a click leaves it where the pointer put it.
		if (byKey) page.focus = `view:${name}`;
		redraw();
	};
	const tabs = views.map((view) =>
		h(
			"button",
			{
				type: "button",
				role: "tab",
				class: "interface-view",
				"aria-selected": String(view.name === current),
				tabindex: view.name === current ? "0" : "-1",
				"data-focus-key": `view:${view.name}`,
				onclick: () => choose(view.name),
			},
			view.name,
		),
	);
	const list = h("nav", { class: "interface-views", role: "tablist", "aria-label": t("Views") }, ...tabs);
	list.addEventListener("keydown", (event) => {
		const at = views.findIndex((view) => view.name === current);
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? views.length - 1
					: step
						? (at + step + views.length) % views.length
						: -1;
		if (next < 0) return;
		event.preventDefault();
		choose(views[next]?.name ?? current, true);
	});
	return list;
}

interface BlockContext {
	readonly company: CompanyController;
	readonly file: InterfaceFile;
	readonly profileId: string;
	readonly nameOf: (column: string, value: unknown) => string;
	readonly figureOf: (agentId: string) => HTMLElement;
	readonly page: PageState;
	readonly redraw: () => void;
}

function drawBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	if (drawn.block.kind === "table") return tableBlock(drawn, context);
	if (drawn.block.kind === "detail") return detailBlock(drawn, context);
	return listBlock(drawn, context);
}

function blockFrame(block: InterfaceBlock, extra: string, ...children: (Node | null)[]): HTMLElement {
	return h(
		"section",
		{ class: `interface-block interface-width-${block.width}${extra}` },
		block.title ? h("h2", null, block.title) : null,
		...children,
	);
}

/** Opens a row in the block `target` names (a `detail`, later a `mail` thread), or closes it. */
function openRow(context: BlockContext, target: string, row: TableRow | null): void {
	const open = { ...context.page.open };
	if (row) open[target] = interfaceRowKey(row);
	else delete open[target];
	context.page.open = open;
	context.page.error = null;
	context.redraw();
}

/** A cell as text: an agent's name, a time in the member's zone, yes or no. */
function cellText(column: string, value: TableValue | undefined, context: BlockContext): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? t("Yes") : t("No");
	if (typeof value === "string" && INSTANT.test(value)) return fmtTime(value) || value;
	return context.nameOf(column, value);
}

function listBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, rows } = drawn;
	const cards = block.layout === "cards";
	const buttons = blockButtons(context.file, block);
	const opened = block.opens === null ? undefined : context.page.open[block.opens];
	const items = rows.map(({ row, href, live }) => {
		const agentId = block.figure ? row[block.figure] : undefined;
		const line = fillInterfaceText(block.line ?? "{title}", row, context.nameOf);
		const sub = block.sub ? fillInterfaceText(block.sub, row, context.nameOf) : "";
		const status = block.status ? context.nameOf(block.status, row[block.status]) : "";
		const byAgent = typeof agentId === "string" && block.figure === "agent";
		const body = [
			typeof agentId === "string" ? h("span", { class: "interface-item-figure" }, context.figureOf(agentId)) : null,
			h(
				"span",
				{ class: "interface-item-copy" },
				h("strong", null, byAgent ? context.nameOf("agent", agentId) : line),
				byAgent ? h("small", null, line) : sub ? h("small", null, sub) : null,
			),
			status ? h("span", { class: "interface-item-status" }, status) : null,
			live ? h("span", { class: "interface-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : null,
		];
		const isOpen = opened !== undefined && interfaceRowKey(row) === opened;
		const opens = block.opens;
		const main =
			opens !== null
				? h(
						"button",
						{
							type: "button",
							class: `interface-item${isOpen ? " is-open" : ""}`,
							"aria-current": isOpen ? "true" : null,
							"data-focus-key": `open:${block.opens}:${interfaceRowKey(row)}`,
							onclick: () => openRow(context, opens, row),
						},
						...body,
					)
				: href
					? h("a", { class: "interface-item", href }, ...body)
					: h("div", { class: "interface-item" }, ...body);
		const actions = rowButtons(buttons, { row, ...(href ? { href } : {}) }, block, context);
		return h("li", null, actions ? h("div", { class: "interface-item-row" }, main, actions) : main);
	});
	return blockFrame(
		block,
		cards ? " interface-cards" : "",
		items.length
			? h("ul", { class: "interface-list" }, ...items)
			: h("p", { class: "interface-empty" }, t("Nothing here right now.")),
	);
}

function tableBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, key } = drawn;
	const buttons = blockButtons(context.file, block);
	const columns = (block.columns.length ? block.columns : Object.keys(drawn.rows[0]?.row ?? {})).filter(
		(column) => !Object.hasOwn(block.lookups, column),
	);
	const sort = context.page.sort[key];
	const filter = context.page.filter[key] ?? "";
	const needle = filter.trim().toLocaleLowerCase();
	const shown = drawn.rows.filter(
		({ row }) =>
			!needle ||
			columns.some((column) =>
				cellText(column, interfaceCell(row, column), context).toLocaleLowerCase().includes(needle),
			),
	);
	if (sort) {
		shown.sort((a, b) => {
			const order = compareInterfaceValues(interfaceCell(a.row, sort.column), interfaceCell(b.row, sort.column));
			return sort.descending ? -order : order;
		});
	}
	const opened = block.opens === null ? undefined : context.page.open[block.opens];
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
					heading(column),
					sorted === "none" ? null : h("span", { "aria-hidden": "true" }, sorted === "ascending" ? " ↑" : " ↓"),
				),
			);
		}),
		buttons.length ? h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, t("Actions"))) : null,
	);
	const opens = block.opens;
	const body = shown.map(({ row, href }) => {
		const isOpen = opened !== undefined && interfaceRowKey(row) === opened;
		const cells = columns.map((column, index) => {
			const text = cellText(column, interfaceCell(row, column), context);
			if (index === 0 && opens !== null)
				return h(
					"td",
					null,
					h(
						"button",
						{
							type: "button",
							class: "interface-row-open",
							"aria-current": isOpen ? "true" : null,
							"data-focus-key": `open:${opens}:${interfaceRowKey(row)}`,
							onclick: () => openRow(context, opens, row),
						},
						text || t("Open"),
					),
				);
			return h("td", null, text);
		});
		const actions = rowButtons(buttons, { row, ...(href ? { href } : {}) }, block, context);
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
	filterField.addEventListener("input", () => {
		context.page.filter = { ...context.page.filter, [key]: filterField.value };
		context.redraw();
	});
	return blockFrame(
		block,
		" interface-table-block",
		drawn.rows.length ? filterField : null,
		shown.length
			? h(
					"div",
					{ class: "interface-table-scroll" },
					h("table", { class: "interface-table" }, h("thead", null, header), h("tbody", null, ...body)),
				)
			: h("p", { class: "interface-empty" }, drawn.rows.length ? t("No rows match.") : t("Nothing here right now.")),
	);
}

function detailBlock(drawn: DrawnBlock, context: BlockContext): HTMLElement {
	const { block, open } = drawn;
	const target = block.id ?? "";
	if (!open)
		return blockFrame(
			block,
			" interface-detail is-empty",
			h("p", { class: "interface-empty" }, t("Choose one to see it here.")),
		);
	const fields = block.fields.length ? block.fields : Object.keys(open.row).filter((column) => column !== "text");
	const text = interfaceCell(open.row, "text");
	const actions = rowButtons(blockButtons(context.file, block), open, block, context);
	return blockFrame(
		block,
		" interface-detail is-open",
		h(
			"button",
			{ type: "button", class: "interface-back", onclick: () => openRow(context, target, null) },
			t("Back"),
		),
		h(
			"dl",
			{ class: "interface-fields" },
			...fields.flatMap((column) => [
				h("dt", null, heading(column)),
				h("dd", null, cellText(column, interfaceCell(open.row, column), context)),
			]),
		),
		typeof text === "string" && text ? h("div", { class: "interface-detail-text" }, markdown(text)) : null,
		actions,
	);
}

/** A row's buttons, or null when it has none to show here. */
function rowButtons(
	buttons: readonly DrawnButton[],
	item: InterfaceRow,
	block: InterfaceBlock,
	context: BlockContext,
): HTMLElement | null {
	const label = (text: string) => fillInterfaceText(text, item.row, context.nameOf);
	const drawn = buttons.flatMap((drawnButton): HTMLElement[] => {
		if (drawnButton.verb === "answer") {
			// The platform's own card waits in its thread; the button takes the member there.
			return item.href ? [h("a", { class: "interface-button", href: item.href }, label(drawnButton.label))] : [];
		}
		if (drawnButton.verb === "open") {
			const href = openTarget(drawnButton.target, item.row, context);
			if (href) return [h("a", { class: "interface-button", href }, label(drawnButton.label))];
			const opens = block.opens;
			if (drawnButton.target === "row" && opens !== null)
				return [button(label(drawnButton.label), () => openRow(context, opens, item.row), { small: true })];
			return [];
		}
		const source = block.from[0] ?? "";
		const action = button(
			label(drawnButton.label),
			() => {
				action.disabled = true;
				void messageAgent(context, drawnButton, item.row, source).catch((error: unknown) => {
					action.disabled = false;
					context.page.error = error instanceof Error ? error.message : String(error);
					context.redraw();
				});
			},
			{ small: true },
		);
		return [action];
	});
	return drawn.length ? h("span", { class: "interface-actions" }, ...drawn) : null;
}

/** Where an `open` button leads: an agent's thread or another interface this member can open. */
function openTarget(target: string, row: TableRow, context: BlockContext): string | null {
	if (target.startsWith("agent:")) {
		const column = target.slice("agent:".length).replace(/^\{|\}$/g, "");
		const agentId = interfaceCell(row, column);
		if (typeof agentId !== "string" || !context.company.staffById(agentId)) return null;
		return agentId === context.company.cofounderId()
			? `#/c/${context.profileId}`
			: `#/c/${context.profileId}/staff/${agentId}`;
	}
	if (target.startsWith("interface:")) {
		const name = target.slice("interface:".length);
		return companyInterfaces(context.company).some((entry) => entry.name === name)
			? `#/c/${context.profileId}/i/${name}`
			: null;
	}
	return null;
}

/** The text a `message` button puts in the composer. A value from a column that carries outside content goes
 * in «guillemets», and a quoted last line says those marks quote outside content: the agent and the reviewer read
 * it as quoted, never as the member's own words. */
export function messageText(
	text: string,
	row: TableRow,
	outside: readonly string[],
	nameOf: (column: string, value: unknown) => string,
): string {
	let quoted = false;
	const filled = fillInterfaceText(text, row, (column, value) => {
		const shown = nameOf(column, value);
		if (!outside.includes(column)) return shown;
		quoted = true;
		return `«${shown}»`;
	});
	return quoted ? `${filled}\n\n> ${t("Text in «» is quoted from outside content, not written by me.")}` : filled;
}

/** A `message` button: opens the agent's thread with the prefilled text in its composer. Nothing is sent until the
 * member sends it. */
async function messageAgent(
	context: BlockContext,
	drawnButton: Extract<DrawnButton, { verb: "message" }>,
	row: TableRow,
	source: string,
): Promise<void> {
	const { company, profileId } = context;
	const cofounderId = company.cofounderId();
	const named = drawnButton.to.match(/^\{([a-z][a-z0-9_]*)\}$/);
	const agentId =
		drawnButton.to === "co-founder" ? cofounderId : named ? interfaceCell(row, named[1] ?? "") : drawnButton.to;
	const agent = typeof agentId === "string" ? company.staffById(agentId) : undefined;
	if (!agent) throw new Error(t("That agent isn't in this company any more."));
	let sessionId: string | undefined;
	if (agent.id === cofounderId) {
		const opened = await company.openCofounderConversation();
		if (!opened.sessionId) throw new Error(opened.reason ?? t("The Co-Founder's thread can't be opened here."));
		sessionId = opened.sessionId;
	} else sessionId = await company.openStaffConversation(agent);
	const text = messageText(drawnButton.text, row, OUTSIDE_COLUMNS[source] ?? [], context.nameOf);
	const conversation = company.conversation(sessionId);
	const draft = conversation.get().draft?.trim();
	conversation.set({ draft: draft ? `${draft}\n\n${text}` : text });
	location.hash = agent.id === cofounderId ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agent.id}`;
}
