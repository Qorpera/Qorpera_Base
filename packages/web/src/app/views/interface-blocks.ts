import { interfaceCell, interfaceSeries } from "@qorpera/cloud-client/interface-query";
import {
	type InterfaceBlock,
	type InterfaceQuery,
	interfaceInstant,
	type TableColumn,
	type TableFile,
	type TableRow,
	type TableValue,
} from "@qorpera/cloud-client/interfaces";
import { fmtTime, h } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationDay, presentationLocale, t, timeZoneOption } from "../../ui/preferences.ts";
import { isFolderSource } from "../interface-sources.ts";
import type { InterfaceRow } from "../interfaces.ts";

/* The `text`, `numbers` and `calendar` blocks (RUNTIME-INTERFACES.md §3.2; "Built: folder pages" in §10), and the
 * words the folder sources' columns and values are drawn in. views/interface.ts reads the rows; this module turns
 * them into what a block shows, and draws it in the block's frame. */

const DAY = 86_400_000;

// ---- words ---------------------------------------------------------------------------

/** The folder sources' column names in the member's language, or undefined for one this module doesn't name
 * (views/interface.ts names the live state's). */
export function folderColumnLabel(source: string, column: string): string | undefined {
	if (!isFolderSource(source)) return undefined;
	if (source === "agents" && column === "id") return t("Agent");
	const label: Record<string, () => string> = {
		agent: () => t("Agent"),
		title: () => t("Title"),
		from: () => t("From"),
		due: () => t("Due"),
		kind: () => t("Kind"),
		name: () => t("Name"),
		role: () => t("Role"),
		figure: () => t("Figure"),
		colour: () => t("Colour"),
		status: () => t("Status"),
		section: () => t("Section"),
		agents: () => t("Agents"),
		people: () => t("People"),
		requested_by: () => t("Requested by"),
		updated: () => t("Updated"),
		when: () => t("When"),
		next: () => t("Next run"),
		service: () => t("Service"),
		account: () => t("Account"),
		organization: () => t("Organization"),
		person: () => t("Person"),
		about: () => t("About"),
		emblem: () => t("Emblem"),
		text: () => t("Text"),
	};
	return Object.hasOwn(label, column) ? label[column]?.() : undefined;
}

/** A folder source's status in the member's language; undefined for any other cell. */
export function folderCellLabel(source: string, column: string, value: TableValue | undefined): string | undefined {
	if (typeof value !== "string" || column !== "status" || !isFolderSource(source)) return undefined;
	const label: Record<string, () => string> = {
		active: () => t("Active"),
		archived: () => t("Archived"),
		paused: () => t("Paused"),
		concluded: () => t("Concluded"),
		open: () => t("To do"),
		blocked: () => t("Blocked"),
		done: () => t("Done"),
		cancelled: () => t("Cancelled"),
		accepted: () => t("Accepted"),
		returned: () => t("Returned"),
		declined: () => t("Declined"),
		connected: () => t("Connected"),
		broken: () => t("Broken"),
		pending: () => t("Pending"),
		needs_person: () => t("Needs a person"),
		off: () => t("Off"),
	};
	return Object.hasOwn(label, value) ? label[value]?.() : undefined;
}

// ---- what the blocks show ----------------------------------------------------------------

/** A numbers block's tile: its row (which `opens` opens), its label, its value, its change, its target and its trend
 * (the values over the trend's weeks, oldest first). */
export interface NumberTile {
	readonly item: InterfaceRow;
	readonly label: string | null;
	readonly value: string;
	readonly change: string | null;
	readonly target: string | null;
	readonly trend: readonly number[];
}

/** A calendar day's things, each with its time of day (none for a date), what it is and the agent it is about. */
export interface CalendarItem {
	readonly key: string;
	readonly time: string | null;
	readonly title: string;
	readonly kind: string;
	readonly agent: string | null;
	readonly href: string | null;
}

export interface CalendarDay {
	readonly day: string;
	readonly label: string;
	readonly items: readonly CalendarItem[];
}

/** What a numbers or calendar block shows beyond its rows. */
export type BlockExtra =
	| { readonly kind: "numbers"; readonly tiles: readonly NumberTile[] }
	| { readonly kind: "calendar"; readonly days: readonly CalendarDay[] };

/** A row's instant in the time column, or -Infinity, as `latest_by` orders rows. */
function instantOf(row: TableRow, time: string | null): number {
	const value = time === null ? undefined : interfaceCell(row, time);
	return (typeof value === "string" ? interfaceInstant(value) : null) ?? Number.NEGATIVE_INFINITY;
}

/** Rows oldest first by the time column, rows with none first, and in their own order where times tie. */
function byTime(rows: readonly InterfaceRow[], time: string | null): InterfaceRow[] {
	return rows
		.map((item, index) => ({ item, index, at: instantOf(item.row, time) }))
		.sort((a, b) => a.at - b.at || a.index - b.index)
		.map(({ item }) => item);
}

/** A number in its unit: `€`, `$` or a currency code as money, `%`, `minutes` and `hours` as units, `kr` and any other
 * unit after the number, `count` as a plain number. */
function formatNumber(value: number, unit: string | null, signed = false): string {
	const sign: Intl.NumberFormatOptions = signed ? { signDisplay: "exceptZero" } : {};
	const currency = unit === "€" ? "EUR" : unit === "$" ? "USD" : unit && /^[A-Z]{3}$/.test(unit) ? unit : null;
	const style: Intl.NumberFormatOptions = currency
		? { style: "currency", currency, currencyDisplay: "narrowSymbol" }
		: unit === "%"
			? { style: "unit", unit: "percent" }
			: unit === "minutes" || unit === "hours"
				? { style: "unit", unit: unit === "minutes" ? "minute" : "hour", unitDisplay: "short" }
				: {};
	const text = new Intl.NumberFormat(presentationLocale(), {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
		...style,
		...sign,
	}).format(value);
	return Object.keys(style).length === 0 && unit && unit !== "count" ? `${text} ${unit}` : text;
}

/** The unit a tile's numbers are in: its row's `unit` (the numbers table's), else what its value column's type says. */
function unitOf(row: TableRow, column: TableColumn | undefined): string | null {
	const unit = interfaceCell(row, "unit");
	if (typeof unit === "string" && unit) return unit;
	if (column?.type === "money") return column.currency;
	return column?.type === "percent" ? "%" : null;
}

/** When a tile's change is since: a `date` cell (`2026-09-01`) as that day, the same in every time zone, as a calendar
 * draws one; a `time` cell as the app shows times. */
function sinceLabel(when: string, now: number): string {
	if (when.length !== 10) return fmtTime(when);
	const at = interfaceInstant(when);
	if (at === null) return "";
	const thisYear = when.slice(0, 4) === presentationDay(new Date(now), timeZoneOption().timeZone).slice(0, 4);
	return new Date(at).toLocaleDateString(presentationLocale(), {
		...(thisYear ? {} : { year: "numeric" }),
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

/** A numbers block's tiles (§3.2, proposed). Its tiles are the rows its query keeps: with `latest_by`, the newest row
 * of each group; without, the newest row of all, as one group. A tile's change is its value less the value of the row
 * before it in its group by the time column (the source's, else `trend.over`); its trend is its group's values over
 * the last `trend.weeks` weeks. `rows` are the query's rows and `all` the rows its `where` and `since` keep. */
export function numberTiles(
	block: InterfaceBlock,
	rows: readonly InterfaceRow[],
	all: readonly InterfaceRow[],
	options: {
		readonly time: string | null;
		readonly definition: TableFile | null;
		readonly nameOf: (column: string, value: unknown) => string;
		readonly now: number;
	},
): NumberTile[] {
	const latestBy = block.query.latestBy;
	const time = options.time ?? block.trend?.over ?? null;
	const valueColumn = block.value ?? "";
	const column = options.definition?.columns.find((candidate) => candidate.name === valueColumn);
	const groupKey = (row: TableRow) => (latestBy === null ? "" : JSON.stringify(interfaceCell(row, latestBy) ?? null));
	const groups = new Map<string, InterfaceRow[]>();
	for (const item of byTime(all, time)) {
		const key = groupKey(item.row);
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	const tiles = latestBy === null ? byTime(all, time).slice(-1) : rows;
	return tiles.map((item) => {
		const unit = unitOf(item.row, column);
		const group = groups.get(groupKey(item.row)) ?? [item];
		const at = group.findIndex((other) => other.key === item.key);
		const value = interfaceCell(item.row, valueColumn);
		const before = at > 0 ? group[at - 1] : undefined;
		const was = before ? interfaceCell(before.row, valueColumn) : undefined;
		let change: string | null = null;
		if (before && typeof value === "number" && typeof was === "number") {
			const delta = Math.round((value - was) * 1e8) / 1e8;
			const when = time === null ? null : interfaceCell(before.row, time);
			const since = typeof when === "string" ? sinceLabel(when, options.now) : "";
			change =
				delta === 0
					? since
						? t("No change since {time}", { time: since })
						: t("No change")
					: since
						? t("{change} since {time}", { change: formatNumber(delta, unit, true), time: since })
						: formatNumber(delta, unit, true);
		}
		const target = block.target === null ? undefined : interfaceCell(item.row, block.target);
		let trend: number[] = [];
		if (block.trend !== null) {
			const from = options.now - block.trend.weeks * 7 * DAY;
			trend = interfaceSeries(
				group.slice(0, at + 1).map((member) => member.row),
				{ x: block.trend.over, y: valueColumn, by: null, every: null, total: null },
			)
				.filter((point) => (interfaceInstant(point.x) ?? Number.NEGATIVE_INFINITY) >= from)
				.map((point) => point.value);
		}
		return {
			item,
			label: latestBy === null ? null : options.nameOf(latestBy, interfaceCell(item.row, latestBy) ?? null),
			value: typeof value === "number" ? formatNumber(value, unit) : options.nameOf(valueColumn, value ?? null),
			change,
			target: typeof target === "number" ? t("Target {value}", { value: formatNumber(target, unit) }) : null,
			trend,
		};
	});
}

/** A calendar source's query: the block's `where` on the columns the source has, and its `since`; a calendar orders
 * by time and shows every day it covers, so it has no `order`, `limit` or `latest_by` (§3.2, proposed). */
export function calendarQuery(block: InterfaceBlock, columns: readonly string[]): InterfaceQuery {
	const where = Object.entries(block.query.where ?? {}).filter(([column]) => columns.includes(column));
	return {
		where: where.length ? Object.fromEntries(where) : null,
		since: block.query.since,
		order: null,
		limit: null,
		latestBy: null,
	};
}

/** The column a calendar reads a source's dates from: a routine's next run, a human task's due time, a table's time
 * column or else its first time or date column, and any other source's own time column. */
export function calendarColumn(time: string | null, definition: TableFile | null): string | null {
	if (definition === null) return time;
	return definition.time ?? definition.columns.find((c) => c.type === "time" || c.type === "date")?.name ?? null;
}

/** One source a calendar reads: its rows, its date column, what its things are called and its agent column. */
export interface CalendarSource {
	readonly source: string;
	readonly rows: readonly InterfaceRow[];
	readonly column: string | null;
	readonly kind: string;
	readonly agent: string | null;
	readonly definition: TableFile | null;
}

/** What a calendar thing is called: its `title`, else its `name`, else its table's first text column. */
function titleOf(row: TableRow, definition: TableFile | null): string {
	for (const column of ["title", "name", definition?.columns.find((c) => c.type === "text")?.name ?? ""]) {
		const value = interfaceCell(row, column);
		if (typeof value === "string" && value) return value;
	}
	return "";
}

/** The day `n` days after a calendar day. */
function dayAfter(day: string, n: number): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + n)).toISOString().slice(0, 10);
}

/** A calendar's days (§3.2, proposed): from today, `days` days (14 when the block doesn't say), in the member's time
 * zone, each with the things due on it from every source it reads, a date before the times of its day. A human task
 * counts while it is open or returned; a day with nothing is left out. */
export function calendarDays(block: InterfaceBlock, sources: readonly CalendarSource[], now: number): CalendarDay[] {
	const zone = timeZoneOption();
	const locale = presentationLocale();
	const today = presentationDay(new Date(now), zone.timeZone);
	const tomorrow = dayAfter(today, 1);
	const last = dayAfter(today, (block.days ?? 14) - 1);
	const days = new Map<string, { at: number; order: number; item: CalendarItem }[]>();
	let order = 0;
	for (const { source, rows, column, kind, agent, definition } of sources) {
		if (column === null) continue;
		for (const { row, key, href } of rows) {
			const value = interfaceCell(row, column);
			if (typeof value !== "string") continue;
			if (source === "human_tasks" && row.status !== "open" && row.status !== "returned") continue;
			const at = interfaceInstant(value);
			if (at === null) continue;
			const dated = value.length === 10;
			const day = dated ? value : presentationDay(new Date(at), zone.timeZone);
			if (day < today || day > last) continue;
			const who = agent === null ? undefined : interfaceCell(row, agent);
			const item: CalendarItem = {
				key: `${source}:${key}`,
				time: dated
					? null
					: new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...zone }),
				title: titleOf(row, definition),
				kind,
				agent: typeof who === "string" ? who : null,
				href: href ?? null,
			};
			days.set(day, [...(days.get(day) ?? []), { at: dated ? Number.NEGATIVE_INFINITY : at, order: order++, item }]);
		}
	}
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
	return [...days.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([day, items]) => ({
			day,
			label: day === today ? t("Today") : day === tomorrow ? t("Tomorrow") : weekday.format(Date.parse(day)),
			items: items.sort((a, b) => a.at - b.at || a.order - b.order).map(({ item }) => item),
		}));
}

// ---- drawing --------------------------------------------------------------------------

/** What the page gives a block this module draws. */
export interface BlockKit {
	/** The block's frame, with its title, and a class for the block. */
	readonly frame: (extra: string, ...children: (Node | null)[]) => HTMLElement;
	/** Its source's problems, or null. */
	readonly note: HTMLElement | null;
	readonly readable: boolean;
	readonly figureOf: (agentId: string, size?: number) => HTMLElement;
	/** The detail a tile opens, when that detail is drawn in this view, and the row open in it. */
	readonly opens: string | null;
	readonly opened: string | undefined;
	readonly open: (item: InterfaceRow) => void;
}

/** A drawn text, numbers or calendar block. */
export interface ExtraDrawn {
	readonly block: InterfaceBlock;
	readonly rows: readonly InterfaceRow[];
	readonly extra?: BlockExtra;
}

const empty = (kit: BlockKit) =>
	kit.readable ? h("p", { class: "interface-empty" }, t("Nothing here right now.")) : null;

export function drawExtraBlock(drawn: ExtraDrawn, kit: BlockKit): HTMLElement {
	if (drawn.block.kind === "text") return textBlock(drawn, kit);
	if (drawn.extra?.kind === "numbers") return numbersBlock(drawn.extra.tiles, drawn.block.trend?.weeks ?? 0, kit);
	return calendarBlock(drawn.extra?.kind === "calendar" ? drawn.extra.days : [], kit);
}

/** A text block: its own text, or its file's (`vision` or `file:`), as markdown with no HTML, no link out of the page
 * and no image fetched: a link is drawn as its text and an image as its alt text. */
function textBlock({ block, rows }: ExtraDrawn, kit: BlockKit): HTMLElement {
	const read = rows[0]?.row.text;
	const text = block.text ?? (typeof read === "string" ? read : "");
	const prose = text.trim()
		? markdown(text, { links: false, firstParagraph: block.show === "first-paragraph" })
		: undefined;
	return kit.frame(
		" interface-text",
		kit.note,
		prose?.hasChildNodes() ? prose : block.text === null ? empty(kit) : null,
	);
}

const SVG = "http://www.w3.org/2000/svg";

/** A small trend line: the values oldest first, scaled to the box. */
function trendLine(values: readonly number[], label: string): SVGElement {
	const [width, height, pad] = [120, 32, 2];
	const low = Math.min(...values);
	const span = Math.max(...values) - low || 1;
	const points = values.map((value, index) => {
		const x = pad + (index / Math.max(1, values.length - 1)) * (width - 2 * pad);
		const y = height - pad - ((value - low) / span) * (height - 2 * pad);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("class", "interface-trend");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("preserveAspectRatio", "none");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", label);
	const line = document.createElementNS(SVG, "polyline");
	line.setAttribute("points", points.join(" "));
	line.setAttribute("fill", "none");
	line.setAttribute("stroke", "currentColor");
	line.setAttribute("stroke-width", "1.5");
	line.setAttribute("vector-effect", "non-scaling-stroke");
	svg.append(line);
	return svg;
}

function numbersBlock(tiles: readonly NumberTile[], weeks: number, kit: BlockKit): HTMLElement {
	const shown = tiles.map((tile) => {
		const body = [
			tile.label ? h("span", { class: "interface-number-label" }, tile.label) : null,
			h("strong", { class: "interface-number-value" }, tile.value),
			tile.change ? h("span", { class: "interface-number-change" }, tile.change) : null,
			tile.target ? h("span", { class: "interface-number-target" }, tile.target) : null,
			tile.trend.length >= 2 ? trendLine(tile.trend, t("Trend over {weeks} weeks", { weeks })) : null,
		];
		const isOpen = kit.opened !== undefined && kit.opened === tile.item.key;
		return h(
			"li",
			null,
			kit.opens === null
				? h("div", { class: "interface-number" }, ...body)
				: h(
						"button",
						{
							type: "button",
							class: `interface-number${isOpen ? " is-open" : ""}`,
							"aria-current": isOpen ? "true" : null,
							"data-focus-key": `open:${kit.opens}:${tile.item.key}`,
							onclick: () => kit.open(tile.item),
						},
						...body,
					),
		);
	});
	return kit.frame(
		" interface-numbers",
		kit.note,
		shown.length ? h("ul", { class: "interface-number-tiles" }, ...shown) : empty(kit),
	);
}

function calendarBlock(days: readonly CalendarDay[], kit: BlockKit): HTMLElement {
	const shown = days.map((day) =>
		h(
			"li",
			{ class: "interface-day" },
			h("h3", null, day.label),
			h(
				"ul",
				{ class: "interface-day-items" },
				...day.items.map((item) => {
					const body = [
						item.agent === null
							? null
							: h("span", { class: "interface-item-figure" }, kit.figureOf(item.agent, 22)),
						h(
							"span",
							{ class: "interface-item-copy" },
							h("strong", null, item.title || item.kind),
							h("small", null, item.time ? `${item.time} · ${item.kind}` : item.kind),
						),
					];
					return h(
						"li",
						null,
						item.href
							? h(
									"a",
									{ class: "interface-item", href: item.href, "data-focus-key": `day:${item.key}` },
									...body,
								)
							: h("div", { class: "interface-item" }, ...body),
					);
				}),
			),
		),
	);
	return kit.frame(
		" interface-calendar",
		kit.note,
		shown.length ? h("ul", { class: "interface-days" }, ...shown) : empty(kit),
	);
}
