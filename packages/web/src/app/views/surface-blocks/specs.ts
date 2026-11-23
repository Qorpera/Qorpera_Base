import type { SurfaceSpecListBlock, SurfaceTableBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { COLOR_VALUE } from "./colours.ts";
import {
	formatScalar,
	isPlainRecord,
	lookupPath,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sameValue,
	sectionHead,
	sourceFile,
} from "./context.ts";

export interface SpecTable {
	readonly title: string;
	readonly columns: readonly string[];
	readonly labels?: readonly string[];
	readonly rows: readonly Record<string, string>[];
}

export interface SpecEntry {
	readonly key: string;
	readonly value: string;
	readonly prev?: string;
	readonly changed: boolean;
}

export const COLOR_GROUPS = new Set(["colors", "color", "palette", "swatches", "colorways"]);
export const TYPE_GROUPS = new Set(["font", "fonts", "typography", "type", "typeface"]);
export const MODEL_GROUPS = new Set(["model", "3d", "geometry"]);
export const VENDOR_GROUPS = new Set(["vendors", "suppliers"]);
const MAX_INITIAL_TABLE_ROWS = 100;
const EMPTY_ROWS = [0, 1, 2];

export function collectSpecs(
	obj: Record<string, unknown>,
	baseObj: Record<string, unknown> | undefined,
	prefix: readonly string[],
	entries: SpecEntry[],
	tables: SpecTable[],
): void {
	for (const [key, value] of Object.entries(obj)) {
		const segments = [...prefix, key];
		const lower = key.toLowerCase();
		if (
			prefix.length === 0 &&
			(COLOR_GROUPS.has(lower) || TYPE_GROUPS.has(lower) || MODEL_GROUPS.has(lower) || VENDOR_GROUPS.has(lower))
		)
			continue;
		if (typeof value === "string" && COLOR_VALUE.test(value.trim())) continue;
		if (Array.isArray(value) && value.length > 0 && value.every(isPlainRecord)) {
			tables.push(tableOf(readableName(key), value));
			continue;
		}
		if (isPlainRecord(value)) {
			collectSpecs(value, baseObj, segments, entries, tables);
			continue;
		}
		const prev = lookupPath(baseObj, segments);
		const changed = !sameValue(prev, value);
		entries.push({
			key: segments.map(readableName).join(" · "),
			value: formatScalar(value),
			...(changed && prev !== undefined ? { prev: formatScalar(prev) } : {}),
			changed,
		});
	}
}

function tableOf(
	title: string,
	rows: readonly Record<string, unknown>[],
	columns?: readonly { readonly key: string; readonly label: string }[],
): SpecTable {
	const keys: string[] = columns ? columns.map((column) => column.key) : [];
	if (!columns) for (const row of rows) for (const col of Object.keys(row)) if (!keys.includes(col)) keys.push(col);
	return {
		title,
		columns: keys,
		...(columns ? { labels: columns.map((column) => column.label) } : {}),
		rows: rows.map((row) => Object.fromEntries(keys.map((col) => [col, formatScalar(row[col])]))),
	};
}

export function renderSpecEntries(entries: readonly SpecEntry[]): HTMLElement {
	return h(
		"dl",
		{ class: "studio-kv" },
		entries.flatMap((entry) => [
			h("dt", { class: entry.changed ? "is-changed" : "" }, entry.key),
			entry.changed && entry.prev !== undefined
				? h(
						"dd",
						{ class: "is-changed studio-diff-dd" },
						h("span", { class: "studio-diff-prev" }, entry.prev),
						h("span", { class: "studio-diff-arrow", "aria-hidden": "true" }, "→"),
						h("span", { class: "studio-diff-next" }, entry.value),
					)
				: h("dd", { class: entry.changed ? "is-changed" : "" }, entry.value),
		]),
	);
}

function renderSpecRow(columns: readonly string[], row: Readonly<Record<string, string>>): HTMLElement {
	return h(
		"tr",
		null,
		columns.map((col) => h("td", null, row[col] ?? "–")),
	);
}

export function renderSpecTable(table: SpecTable, signal: AbortSignal): HTMLElement {
	const truncated = table.rows.length > MAX_INITIAL_TABLE_ROWS;
	const initialRows = truncated ? table.rows.slice(0, MAX_INITIAL_TABLE_ROWS) : table.rows;
	const tbody = h(
		"tbody",
		null,
		initialRows.map((row) => renderSpecRow(table.columns, row)),
	);
	const moreBtn = truncated
		? h(
				"button",
				{ type: "button", class: "btn btn-small studio-more-btn" },
				t("Show all {count} rows", { count: table.rows.length }),
			)
		: null;
	if (moreBtn) {
		moreBtn.addEventListener(
			"click",
			() => {
				const frag = document.createDocumentFragment();
				for (let i = MAX_INITIAL_TABLE_ROWS; i < table.rows.length; i++) {
					frag.append(renderSpecRow(table.columns, table.rows[i]!));
				}
				tbody.append(frag);
				moreBtn.remove();
			},
			{ once: true, signal },
		);
	}
	return h(
		"div",
		{ class: "studio-table-wrap" },
		table.title ? h("h3", { class: "studio-subhead" }, table.title) : null,
		h(
			"table",
			{ class: "studio-table" },
			h(
				"thead",
				null,
				h(
					"tr",
					null,
					table.columns.map((col, index) => h("th", null, table.labels?.[index] ?? readableName(col))),
				),
			),
			tbody,
		),
		moreBtn,
	);
}

export function renderSpecTables(tables: readonly SpecTable[], signal: AbortSignal): HTMLElement[] {
	return tables.map((table) => renderSpecTable(table, signal));
}

function paleBar(): HTMLElement {
	return h("span", { class: "studio-pale-bar" });
}

function headingOf(heading: string | undefined, source: SurfaceSpecListBlock["from"], ctx: SurfaceBlockContext) {
	if (heading) return ctx.words(heading);
	const file = sourceFile(source);
	return file ? readableName(file) : "";
}

function fileTag(source: SurfaceSpecListBlock["from"], ctx: SurfaceBlockContext): HTMLElement | null {
	const file = sourceFile(source);
	const path = file ? ctx.companyPath(file) : undefined;
	return path ? h("code", { class: "studio-file-tag" }, path) : null;
}

export function prepareSpecList(block: SurfaceSpecListBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const entries: SpecEntry[] = [];
	const tables: SpecTable[] = [];
	if (isPlainRecord(read.value)) {
		collectSpecs(read.value, isPlainRecord(read.base) ? read.base : undefined, [], entries, tables);
	}
	const filled = entries.length > 0 || tables.length > 0;
	const heading = headingOf(block.heading, block.from, ctx);
	return {
		filled,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{
							class: `studio-section${filled && read.changed ? " is-changed" : ""}`,
							"data-block": "spec_list",
						},
						heading ? sectionHead(heading, filled && read.changed, fileTag(block.from, ctx)) : null,
						filled
							? [entries.length ? renderSpecEntries(entries) : null, ...renderSpecTables(tables, ctx.signal)]
							: h(
									"dl",
									{ class: "studio-kv is-empty", "aria-hidden": "true" },
									EMPTY_ROWS.flatMap(() => [h("dt", null, paleBar()), h("dd", null, paleBar())]),
								),
					),
			},
		],
	};
}

export function prepareTable(block: SurfaceTableBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const rows = Array.isArray(read.value) ? read.value.filter(isPlainRecord) : [];
	const columns = block.columns?.map((column) => ({ key: column.key, label: ctx.words(column.label) }));
	const table = rows.length ? tableOf("", rows, columns) : undefined;
	const heading = headingOf(block.heading, block.from, ctx);
	const changed = table !== undefined && read.changed;
	return {
		filled: table !== undefined,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: `studio-section${changed ? " is-changed" : ""}`, "data-block": "table" },
						heading ? sectionHead(heading, changed) : null,
						table
							? renderSpecTable(table, ctx.signal)
							: h(
									"div",
									{ class: "studio-table-wrap" },
									h(
										"table",
										{ class: "studio-table is-empty", "aria-hidden": "true" },
										columns
											? h(
													"thead",
													null,
													h(
														"tr",
														null,
														columns.map((column) => h("th", null, column.label)),
													),
												)
											: null,
										h(
											"tbody",
											null,
											EMPTY_ROWS.map(() =>
												h(
													"tr",
													null,
													(columns ?? EMPTY_ROWS).map(() => h("td", null, paleBar())),
												),
											),
										),
									),
								),
						block.caption ? h("p", { class: "studio-caption" }, ctx.words(block.caption)) : null,
					),
			},
		],
	};
}
