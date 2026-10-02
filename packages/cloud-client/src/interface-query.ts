/** Reading rows for an interface block (RUNTIME-INTERFACES.md §3.1): the small query language of `where`, `since`,
 * `order`, `limit` and `latest_by`, the time buckets of a chart, lookups between tables, and filling `{column}`
 * texts. Pure functions over rows the caller has already read with the viewer's own authority. Browser-safe. */

import {
	type InterfaceLookup,
	type InterfaceQuery,
	interfaceInstant,
	type TableRow,
	type TableValue,
} from "./interfaces.ts";

/** The viewer's clock: now, and the start of their today (in their own time zone), both epoch milliseconds. */
export interface InterfaceClock {
	readonly now: number;
	readonly startOfToday: number;
}

const DAY = 86_400_000;

/** When `since` starts: "today", or "-<n>d", "-<n>w", "-<n>m" back from now (months by the calendar, in UTC). */
export function interfaceSinceStart(since: string, clock: InterfaceClock): number | null {
	if (since === "today") return clock.startOfToday;
	const m = /^-([1-9][0-9]{0,2})([dwm])$/.exec(since);
	if (!m) return null;
	const n = Number(m[1]);
	if (m[2] === "d") return clock.now - n * DAY;
	if (m[2] === "w") return clock.now - n * 7 * DAY;
	const date = new Date(clock.now);
	date.setUTCMonth(date.getUTCMonth() - n);
	return date.getTime();
}

function matches(value: TableValue | undefined, wanted: unknown): boolean {
	const wants = Array.isArray(wanted) ? wanted : [wanted];
	if (Array.isArray(value)) return value.some((item) => wants.includes(item));
	return wants.includes(value ?? null);
}

/** Orders two values: missing last, numbers and times by size, text by code point (the same everywhere). */
export function compareInterfaceValues(a: TableValue | undefined, b: TableValue | undefined): number {
	const an = a === null || a === undefined;
	const bn = b === null || b === undefined;
	if (an || bn) return an === bn ? 0 : an ? 1 : -1;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
	const as = Array.isArray(a) ? a.join(" ") : String(a);
	const bs = Array.isArray(b) ? b.join(" ") : String(b);
	const at = interfaceInstant(as);
	const bt = interfaceInstant(bs);
	if (at !== null && bt !== null) return at - bt;
	return as < bs ? -1 : as > bs ? 1 : 0;
}

function instantOf(row: TableRow, column: string | null): number | null {
	if (!column) return null;
	const value = row[column];
	return typeof value === "string" ? interfaceInstant(value) : null;
}

/** Applies a block's query to rows in their stored order. `time` is the source's time column, used by `since` and
 * `latest_by`; without one, `since` keeps nothing and `latest_by` keeps the last row of each group. */
export function queryInterfaceRows(
	rows: readonly TableRow[],
	query: InterfaceQuery,
	options: { readonly time: string | null; readonly clock: InterfaceClock },
): TableRow[] {
	let out = rows.filter((row) =>
		Object.entries(query.where ?? {}).every(([column, wanted]) => matches(row[column], wanted)),
	);
	if (query.since) {
		const start = interfaceSinceStart(query.since, options.clock);
		out = start === null ? [] : out.filter((row) => (instantOf(row, options.time) ?? -Infinity) >= start);
	}
	if (query.latestBy) {
		const column = query.latestBy;
		const latest = new Map<string, { row: TableRow; at: number; index: number }>();
		out.forEach((row, index) => {
			const key = JSON.stringify(row[column] ?? null);
			const at = instantOf(row, options.time) ?? -Infinity;
			const seen = latest.get(key);
			if (!seen || at > seen.at || (at === seen.at && index > seen.index)) latest.set(key, { row, at, index });
		});
		out = [...latest.values()].sort((a, b) => a.index - b.index).map((entry) => entry.row);
	}
	if (query.order) {
		const { column, descending } = query.order;
		out = out
			.map((row, index) => ({ row, index }))
			.sort((a, b) => {
				const c = compareInterfaceValues(a.row[column], b.row[column]);
				const missingA = a.row[column] === null || a.row[column] === undefined;
				const missingB = b.row[column] === null || b.row[column] === undefined;
				if (missingA !== missingB) return missingA ? 1 : -1;
				return (descending ? -c : c) || a.index - b.index;
			})
			.map((entry) => entry.row);
	}
	return query.limit ? out.slice(0, query.limit) : out;
}

/** Fills `{column}` with the row's values as plain text; `show` can turn ids into names. Unknown columns become "". */
export function fillInterfaceText(
	text: string,
	row: TableRow,
	show: (column: string, value: TableValue) => string = (_column, value) => plainText(value),
): string {
	return text.replace(/\{([a-z][a-z0-9_]{0,39})\}/g, (_whole, column: string) => {
		const value = row[column];
		return value === undefined ? "" : show(column, value);
	});
}

export function plainText(value: TableValue | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

/** The bucket a time falls in: a day "2026-10-02", the Monday that starts its week, or a month "2026-10". */
export function interfaceBucket(at: number, every: "day" | "week" | "month"): string {
	const date = new Date(at);
	if (every === "month") return date.toISOString().slice(0, 7);
	if (every === "week") {
		const weekday = (date.getUTCDay() + 6) % 7;
		return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday))
			.toISOString()
			.slice(0, 10);
	}
	return date.toISOString().slice(0, 10);
}

export interface InterfacePoint {
	readonly x: string;
	readonly by: string | null;
	readonly value: number;
}

/** A chart's points: each row's (x, y), or with `every` the sum or count per bucket, per `by` group, oldest first. */
export function interfaceSeries(
	rows: readonly TableRow[],
	chart: {
		readonly x: string;
		readonly y: string | null;
		readonly by: string | null;
		readonly every: "day" | "week" | "month" | null;
		readonly total: "sum" | "count" | null;
	},
): InterfacePoint[] {
	const points = new Map<string, { x: string; by: string | null; value: number; at: number }>();
	const plain: { x: string; by: string | null; value: number; at: number }[] = [];
	for (const row of rows) {
		const raw = row[chart.x];
		const at = typeof raw === "string" ? interfaceInstant(raw) : null;
		if (at === null) continue;
		const by = chart.by ? plainText(row[chart.by]) : null;
		const y = chart.y ? row[chart.y] : null;
		if (!chart.every || !chart.total) {
			if (typeof y === "number") plain.push({ x: String(raw), by, value: y, at });
			continue;
		}
		const x = interfaceBucket(at, chart.every);
		const key = JSON.stringify([x, by]);
		const point = points.get(key) ?? { x, by, value: 0, at: interfaceInstant(x.length === 7 ? `${x}-01` : x) ?? at };
		point.value += chart.total === "count" ? 1 : typeof y === "number" ? y : 0;
		points.set(key, point);
	}
	const all = chart.every && chart.total ? [...points.values()] : plain;
	return all
		.sort((a, b) => a.at - b.at || compareInterfaceValues(a.by, b.by))
		.map(({ x, by, value }) => ({ x, by, value: Math.round(value * 1e8) / 1e8 }));
}

/** A lookup column's value for one row: the `show` values of the rows of the other table whose `match` column holds
 * `id` (a list for an agents column), or how many there are. */
export function interfaceLookup(id: string, lookup: InterfaceLookup, rows: readonly TableRow[]): TableValue {
	const hits = rows.filter((row) => matches(row[lookup.match], id));
	if (lookup.count) return hits.length;
	const shown: string[] = [];
	for (const row of hits) {
		const value = lookup.show ? row[lookup.show] : null;
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== null && item !== undefined && !shown.includes(String(item))) shown.push(String(item));
		}
	}
	return shown;
}
