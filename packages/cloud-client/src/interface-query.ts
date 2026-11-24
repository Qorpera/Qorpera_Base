/** Reading rows for an interface block (RUNTIME-INTERFACES.md §3.1): the small query language of `where`, `since`,
 * `order`, `limit` and `latest_by`, the time buckets of a chart, lookups between tables, and filling `{column}`
 * texts. Pure functions over rows the caller has already read with the viewer's own authority. A row's own columns
 * are the only ones read, so a column named like an object's built-ins (`constructor`) is just missing. Browser-safe. */

import { type InterfaceQuery, interfaceInstant, type TableRow, type TableValue } from "./interfaces.ts";

/** The viewer's clock: now, and the start of their today (in their own time zone), both epoch milliseconds. */
export interface InterfaceClock {
	readonly now: number;
	readonly startOfToday: number;
}

const DAY = 86_400_000;

/** A row's own cell, or undefined. */
export function interfaceCell(row: TableRow, column: string): TableValue | undefined {
	return Object.hasOwn(row, column) ? row[column] : undefined;
}

/** When `since` starts: "today", or "-<n>d", "-<n>w", "-<n>m" back from now. Months go by the calendar in UTC, and a
 * day the earlier month doesn't have becomes its last day (31 March less a month is 28 or 29 February). */
export function interfaceSinceStart(since: string, clock: InterfaceClock): number | null {
	if (since === "today") return clock.startOfToday;
	const m = /^-([1-9][0-9]{0,2})([dwm])$/.exec(since);
	if (!m) return null;
	const n = Number(m[1]);
	if (m[2] === "d") return clock.now - n * DAY;
	if (m[2] === "w") return clock.now - n * 7 * DAY;
	const date = new Date(clock.now);
	const months = date.getUTCFullYear() * 12 + date.getUTCMonth() - n;
	const year = Math.floor(months / 12);
	const month = months - year * 12;
	const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return Date.UTC(
		year,
		month,
		Math.min(date.getUTCDate(), last),
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
		date.getUTCMilliseconds(),
	);
}

/** Whether a cell matches a `where` value: equal, one of a list, a member of an agents list, and "yes"/"no" for a
 * yes-no column. */
function matches(value: TableValue | undefined, wanted: unknown): boolean {
	const wants = (Array.isArray(wanted) ? wanted : [wanted]).map((item) =>
		typeof value === "boolean" && (item === "yes" || item === "no") ? item === "yes" : item,
	);
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
	const value = interfaceCell(row, column);
	return typeof value === "string" ? interfaceInstant(value) : null;
}

/** Applies a block's query to rows in their stored order. `time` is the source's time column, used by `since` and
 * `latest_by`; without one, `since` keeps nothing and `latest_by` keeps the last row of each group. */
export function queryInterfaceRows(
	rows: readonly TableRow[],
	query: InterfaceQuery,
	options: { readonly time: string | null; readonly clock: InterfaceClock },
): TableRow[] {
	const where = Object.entries(query.where ?? {});
	let out = rows.filter((row) => where.every(([column, wanted]) => matches(interfaceCell(row, column), wanted)));
	if (query.since) {
		const start = interfaceSinceStart(query.since, options.clock);
		out = start === null ? [] : out.filter((row) => (instantOf(row, options.time) ?? -Infinity) >= start);
	}
	if (query.latestBy) {
		const column = query.latestBy;
		const latest = new Map<string, { row: TableRow; at: number; index: number }>();
		out.forEach((row, index) => {
			const key = JSON.stringify(interfaceCell(row, column) ?? null);
			const at = instantOf(row, options.time) ?? -Infinity;
			const seen = latest.get(key);
			if (!seen || at > seen.at || (at === seen.at && index > seen.index)) latest.set(key, { row, at, index });
		});
		out = [...latest.values()].sort((a, b) => a.index - b.index).map((entry) => entry.row);
	}
	if (query.order) {
		const { column, descending } = query.order;
		out = out
			.map((row, index) => ({ row, index, value: interfaceCell(row, column) }))
			.sort((a, b) => {
				const missingA = a.value === null || a.value === undefined;
				const missingB = b.value === null || b.value === undefined;
				if (missingA !== missingB) return missingA ? 1 : -1;
				const c = compareInterfaceValues(a.value, b.value);
				return (descending ? -c : c) || a.index - b.index;
			})
			.map((entry) => entry.row);
	}
	return query.limit ? out.slice(0, query.limit) : out;
}
