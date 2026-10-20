/* The company's bank summary (`bank/summary.json` in the company folder, app/bank-page.ts): what the Bank page shows,
 * written by whatever keeps the company's bank numbers (the bank sync, or an agent from a statement). One JSON file,
 * read with the member's own authority like any page's file, small enough for the folder's checked-file bound.
 *
 * Every amount is in the account's currency, Danish kroner, as a number with at most two decimals. Money that went out
 * is a positive amount in `out` and in the money-out categories. Dates are `YYYY-MM-DD`, months `YYYY-MM`. The file is
 * parsed strictly: a key that isn't listed, a missing key or a value of the wrong kind makes the whole file unreadable,
 * so the page never draws half a summary. */

export const BANK_SUMMARY_SCHEMA = "qorpera.bank-summary/v1";

/** How often a cost or an income comes. */
export const BANK_RHYTHMS = [
	"once",
	"daily",
	"weekdays",
	"weekly",
	"monthly",
	"quarterly",
	"yearly",
	"each-payout",
	"now-and-then",
] as const;
export type BankRhythm = (typeof BANK_RHYTHMS)[number];

export interface BankItem {
	readonly name: string;
	readonly rhythm: BankRhythm;
	/** The next time it comes, or null when it doesn't come again or can't be told. */
	readonly next: string | null;
	readonly amount: number;
}

export interface BankCategory {
	readonly name: string;
	readonly total: number;
	readonly items: readonly BankItem[];
}

export interface BankPoint {
	readonly date: string;
	readonly saldo: number;
}

export interface BankMonth {
	readonly month: string;
	readonly in: number;
	readonly out: number;
}

export interface BankSummary {
	/** The bank's name, as the member knows it. */
	readonly bank: string;
	readonly updatedAt: string;
	/** The day the bank stopped sharing (its consent ran out), or null while it shares. */
	readonly pausedSince: string | null;
	readonly saldo: number;
	readonly disponibel: number;
	readonly reserveret: number;
	/** The account money is put into, or null when it isn't known. */
	readonly payTo: { readonly reg: string; readonly account: string } | null;
	/** The saldo over time, oldest first. */
	readonly history: readonly BankPoint[];
	/** The saldo expected ahead, from the costs and income that repeat, oldest first. */
	readonly expected: readonly BankPoint[];
	/** Money in and out per month, oldest first; the last is the month the categories describe. */
	readonly months: readonly BankMonth[];
	readonly moneyIn: { readonly month: string; readonly categories: readonly BankCategory[] };
	readonly moneyOut: {
		readonly month: string;
		/** What repeats every month, or null when it can't be told yet. */
		readonly repeating: number | null;
		readonly categories: readonly BankCategory[];
		/** Costs that come later but not every month, such as VAT. */
		readonly later: readonly { readonly name: string; readonly date: string; readonly amount: number }[];
	};
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const NAME_MAX = 80;
const LIST_MAX = 400;

class Unreadable extends Error {}

function fail(): never {
	throw new Unreadable();
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) if (!keys.includes(key)) fail();
	for (const key of keys) if (!(key in record)) fail();
	return record;
}

function text(value: unknown, max = NAME_MAX): string {
	if (typeof value !== "string") fail();
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) fail();
	return trimmed;
}

function amount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e12) fail();
	if (Math.round(value * 100) !== Number((value * 100).toFixed(6))) fail();
	return value;
}

function positive(value: unknown): number {
	const parsed = amount(value);
	if (parsed < 0) fail();
	return parsed;
}

function date(value: unknown): string {
	// A day the calendar has: 2026-02-31 doesn't parse back to itself.
	if (typeof value !== "string" || !DATE.test(value)) fail();
	const parsed = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail();
	return value;
}

function list<T>(value: unknown, item: (entry: unknown) => T, max = LIST_MAX): T[] {
	if (!Array.isArray(value) || value.length > max) fail();
	return value.map(item);
}

function points(value: unknown): BankPoint[] {
	const parsed = list(value, (entry) => {
		const point = closed(entry, ["date", "saldo"]);
		return { date: date(point.date), saldo: amount(point.saldo) };
	});
	for (let index = 1; index < parsed.length; index++)
		if ((parsed[index]?.date ?? "") <= (parsed[index - 1]?.date ?? "")) fail();
	return parsed;
}

function categories(value: unknown): BankCategory[] {
	const parsed = list(
		value,
		(entry) => {
			const category = closed(entry, ["name", "total", "items"]);
			return {
				name: text(category.name),
				total: positive(category.total),
				items: list(
					category.items,
					(each) => {
						const item = closed(each, ["name", "rhythm", "next", "amount"]);
						const rhythm = item.rhythm;
						if (typeof rhythm !== "string" || !(BANK_RHYTHMS as readonly string[]).includes(rhythm)) fail();
						return {
							name: text(item.name),
							rhythm: rhythm as BankRhythm,
							next: item.next === null ? null : date(item.next),
							amount: positive(item.amount),
						};
					},
					60,
				),
			};
		},
		24,
	);
	if (new Set(parsed.map((category) => category.name)).size !== parsed.length) fail();
	return parsed;
}

function month(value: unknown): string {
	if (typeof value !== "string" || !MONTH.test(value)) fail();
	return value;
}

/** The summary in `json`, or null when the file isn't one. */
export function parseBankSummary(json: string): BankSummary | null {
	try {
		const input = closed(JSON.parse(json), [
			"schema",
			"bank",
			"updatedAt",
			"pausedSince",
			"saldo",
			"disponibel",
			"reserveret",
			"payTo",
			"history",
			"expected",
			"months",
			"moneyIn",
			"moneyOut",
		]);
		if (input.schema !== BANK_SUMMARY_SCHEMA) return null;
		const updatedAt = input.updatedAt;
		if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) fail();
		let payTo: BankSummary["payTo"] = null;
		if (input.payTo !== null) {
			const account = closed(input.payTo, ["reg", "account"]);
			const reg = text(account.reg, 4);
			const number = text(account.account, 14);
			if (!/^\d{4}$/.test(reg) || !/^\d{1,14}$/.test(number)) fail();
			payTo = { reg, account: number };
		}
		const months = list(
			input.months,
			(entry) => {
				const each = closed(entry, ["month", "in", "out"]);
				return { month: month(each.month), in: positive(each.in), out: positive(each.out) };
			},
			36,
		);
		for (let index = 1; index < months.length; index++)
			if ((months[index]?.month ?? "") <= (months[index - 1]?.month ?? "")) fail();
		const moneyIn = closed(input.moneyIn, ["month", "categories"]);
		const moneyOut = closed(input.moneyOut, ["month", "repeating", "categories", "later"]);
		return {
			bank: text(input.bank),
			updatedAt,
			pausedSince: input.pausedSince === null ? null : date(input.pausedSince),
			saldo: amount(input.saldo),
			disponibel: amount(input.disponibel),
			reserveret: positive(input.reserveret),
			payTo,
			history: points(input.history),
			expected: points(input.expected),
			months,
			moneyIn: { month: month(moneyIn.month), categories: categories(moneyIn.categories) },
			moneyOut: {
				month: month(moneyOut.month),
				repeating: moneyOut.repeating === null ? null : positive(moneyOut.repeating),
				categories: categories(moneyOut.categories),
				later: list(
					moneyOut.later,
					(entry) => {
						const later = closed(entry, ["name", "date", "amount"]);
						return { name: text(later.name), date: date(later.date), amount: positive(later.amount) };
					},
					20,
				),
			},
		};
	} catch (error) {
		if (error instanceof Unreadable || error instanceof SyntaxError) return null;
		throw error;
	}
}
