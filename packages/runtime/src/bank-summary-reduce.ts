import type { EnableBankingBalance, EnableBankingTransaction } from "./cloud-connector-enable-banking.ts";

/**
 * Reduces a company's bank data to the bank summary its Bank page draws (`qorpera.bank-summary/v1`, the web's
 * packages/web/src/app/bank-summary.ts, which parses it strictly). The broker fetches, this reduces, and only the
 * reduction leaves the broker: no account's full number, no transaction id, no text the member didn't see at the bank
 * beyond who was paid. The result fits the web's bounds (400 saldo points, 36 months, 24 categories of at most 60
 * items, names of at most 80 characters).
 *
 * Categories come from who was paid and repeating payments, not from a model: money in by who paid, money out by a
 * short list of words (salaries, rent, taxes, utilities, subscriptions, fees) and by rhythm, the rest as Other. An agent
 * or the member can refine them later; this is the floor the page always has.
 */

export const BANK_SUMMARY_SCHEMA = "qorpera.bank-summary/v1";

export type BankRhythm =
	| "once"
	| "daily"
	| "weekdays"
	| "weekly"
	| "monthly"
	| "quarterly"
	| "yearly"
	| "each-payout"
	| "now-and-then";

export interface BankSummaryAccount {
	readonly balances: readonly EnableBankingBalance[];
	readonly transactions: readonly EnableBankingTransaction[];
}

export interface BankSummaryInput {
	readonly bank: string;
	/** Now, as the broker sees it. */
	readonly now: Date;
	/** The day the consent ended, or null while it lasts. */
	readonly pausedSince: string | null;
	readonly payTo: { readonly reg: string; readonly account: string } | null;
	readonly accounts: readonly BankSummaryAccount[];
}

type Item = { name: string; rhythm: BankRhythm; next: string | null; amount: number };
type Category = { name: string; total: number; items: Item[] };

export interface BankSummaryFile {
	schema: typeof BANK_SUMMARY_SCHEMA;
	bank: string;
	updatedAt: string;
	pausedSince: string | null;
	saldo: number;
	disponibel: number;
	reserveret: number;
	payTo: { reg: string; account: string } | null;
	history: { date: string; saldo: number }[];
	expected: { date: string; saldo: number }[];
	months: { month: string; in: number; out: number }[];
	moneyIn: { month: string; categories: Category[] };
	moneyOut: {
		month: string;
		repeating: number | null;
		categories: Category[];
		later: { name: string; date: string; amount: number }[];
	};
}

const DAY = 86_400_000;
const HISTORY_DAYS = 365;
const MONTHS = 12;
const CATEGORY_MAX = 8;
const ITEM_MAX = 60;
const NAME_MAX = 80;

const kr = (value: number) => Math.round(value * 100) / 100;
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const dayTime = (value: string) => Date.parse(`${value}T00:00:00Z`);

/** Who was paid or who paid, as the page names them: the bank's name for them, else the transfer's text, trimmed. */
function party(transaction: EnableBankingTransaction): string {
	const raw = (transaction.counterparty ?? transaction.text ?? "").replace(/\s+/g, " ").trim();
	if (!raw) return transaction.amount >= 0 ? "Unnamed payment in" : "Unnamed payment";
	const clipped = [...raw].slice(0, NAME_MAX).join("");
	return clipped === clipped.toUpperCase() && /[A-ZÆØÅ]/.test(clipped)
		? clipped
				.toLowerCase()
				.replace(/(^|[\s/-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase())
		: clipped;
}

/** The key payments to the same receiver share: their name without numbers and punctuation. */
const partyKey = (name: string) =>
	name
		.toLowerCase()
		.replace(/[0-9#*./:-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const OUT_RULES: readonly (readonly [string, RegExp])[] = [
	["Salaries", /\b(løn|loen|lønninger|salary|salaries|payroll|danløn|dataløn|lønsystemer|zenegy|proløn)\b/],
	["Taxes and VAT", /\b(skat|skattestyrelsen|moms|vat|told|a-skat|am-bidrag)\b/],
	["Rent", /\b(husleje|leje|rent|ejendom|ejendomme|lejemål)\b/],
	["Utilities", /\b(el|strøm|ørsted|andel energi|norlys|ewii|vand|varme|fjernvarme|forsyning|electricity)\b/],
	[
		"Subscriptions",
		/\b(microsoft|google|adobe|apple|spotify|dropbox|slack|zoom|github|atlassian|notion|figma|aws|dinero|e-conomic|billy|shopify|telia|telenor|yousee|norlys tele|tdc|nuuday|forsikring|insurance|tryg|topdanmark|codan|alka|if skadeforsikring|koda|gramex|abonnement|subscription)\b/,
	],
	["Card and app fees", /\b(gebyr|gebyrer|fee|fees|nets|sumup|stripe|mobilepay|zettle|klarna)\b/],
];

function outCategory(name: string, rhythm: BankRhythm, monthly: number): string {
	const key = partyKey(name);
	for (const [category, rule] of OUT_RULES) if (rule.test(key)) return category;
	// A small cost that comes every month is most likely a subscription.
	if (rhythm === "monthly" && monthly < 5000) return "Subscriptions";
	return "Other";
}

/** How often payments to one receiver come, from their days (oldest first), and when the next is due. */
function rhythmOf(days: readonly number[], now: number): { rhythm: BankRhythm; next: string | null; perMonth: number } {
	if (days.length < 2) return { rhythm: "once", next: null, perMonth: 0 };
	const gaps = days.slice(1).map((time, index) => (time - (days[index] ?? time)) / DAY);
	const sorted = [...gaps].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const steady =
		gaps.filter((gap) => Math.abs(gap - median) <= Math.max(3, median * 0.25)).length >= gaps.length * 0.6;
	const last = days[days.length - 1] ?? now;
	const ahead = (step: number) => {
		let next = last + step * DAY;
		while (next < now) next += step * DAY;
		return iso(next);
	};
	if (!steady) return { rhythm: "now-and-then", next: null, perMonth: 0 };
	if (median <= 1.5) return { rhythm: "daily", next: null, perMonth: 0 };
	if (median <= 9) return { rhythm: "weekly", next: ahead(7), perMonth: 52 / 12 };
	if (median <= 40) return { rhythm: "monthly", next: ahead(Math.round(median)), perMonth: 1 };
	if (median <= 100) return { rhythm: "quarterly", next: ahead(91), perMonth: 1 / 3 };
	if (median <= 400) return { rhythm: "yearly", next: ahead(365), perMonth: 1 / 12 };
	return { rhythm: "now-and-then", next: null, perMonth: 0 };
}

/** The balance of a type, summed over the accounts, preferring the first type each account has. */
function balanceOf(accounts: readonly BankSummaryAccount[], types: readonly string[]): number | null {
	let total = 0;
	let found = false;
	for (const account of accounts) {
		const balance = types.map((type) => account.balances.find((each) => each.type === type)).find(Boolean);
		if (!balance) continue;
		total += balance.amount;
		found = true;
	}
	return found ? kr(total) : null;
}

export function reduceBankSummary(input: BankSummaryInput): BankSummaryFile {
	const now = input.now.getTime();
	const today = dayTime(iso(now));
	const saldo = balanceOf(input.accounts, ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV", "OPBD"]) ?? 0;
	const disponibel = balanceOf(input.accounts, ["ITAV", "CLAV", "XPCD", "OPAV", "FWAV"]) ?? saldo;
	const booked = input.accounts
		.flatMap((account) => account.transactions)
		.filter((transaction) => transaction.status === "BOOK" && transaction.currency === "DKK")
		.filter((transaction) => dayTime(transaction.date) <= today);

	// The saldo each day, back from today's: a day's saldo is today's less what moved after it.
	const moved = new Map<number, number>();
	for (const transaction of booked)
		moved.set(dayTime(transaction.date), (moved.get(dayTime(transaction.date)) ?? 0) + transaction.amount);
	const earliest = Math.max(today - (HISTORY_DAYS - 1) * DAY, Math.min(today, ...moved.keys()));
	const history: { date: string; saldo: number }[] = [];
	let running = saldo;
	for (let time = today; time >= earliest; time -= DAY) {
		history.push({ date: iso(time), saldo: kr(running) });
		running -= moved.get(time) ?? 0;
	}
	history.reverse();

	// Money in and out per month, the last twelve with any movement.
	const monthOf = (date: string) => date.slice(0, 7);
	const thisMonth = monthOf(iso(today));
	const byMonth = new Map<string, { in: number; out: number }>();
	for (const transaction of booked) {
		const month = byMonth.get(monthOf(transaction.date)) ?? { in: 0, out: 0 };
		if (transaction.amount >= 0) month.in += transaction.amount;
		else month.out -= transaction.amount;
		byMonth.set(monthOf(transaction.date), month);
	}
	const months = [...byMonth.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.slice(-MONTHS)
		.map(([month, total]) => ({ month, in: kr(total.in), out: kr(total.out) }));

	// Payments to and from each party: their rhythm over the history, and what they came to this month.
	type Party = { name: string; days: number[]; amounts: number[]; thisMonth: number; last: number };
	const parties = (incoming: boolean) => {
		const found = new Map<string, Party>();
		for (const transaction of booked) {
			if (transaction.amount >= 0 !== incoming) continue;
			const name = party(transaction);
			const key = partyKey(name) || name;
			const entry = found.get(key) ?? { name, days: [], amounts: [], thisMonth: 0, last: 0 };
			entry.days.push(dayTime(transaction.date));
			entry.amounts.push(Math.abs(transaction.amount));
			entry.last = Math.abs(transaction.amount);
			if (monthOf(transaction.date) === thisMonth) entry.thisMonth += Math.abs(transaction.amount);
			found.set(key, entry);
		}
		return [...found.values()].map((entry) => {
			const days = [...entry.days].sort((a, b) => a - b);
			const rhythm = rhythmOf(days, today);
			const typical = [...entry.amounts].sort((a, b) => a - b)[Math.floor(entry.amounts.length / 2)] ?? 0;
			return { ...entry, ...rhythm, typical };
		});
	};

	const group = (
		list: ReturnType<typeof parties>,
		categoryOf: (entry: ReturnType<typeof parties>[number]) => string,
	): Category[] => {
		const categories = new Map<string, Category>();
		for (const entry of list) {
			if (entry.thisMonth <= 0) continue;
			const name = categoryOf(entry);
			const category = categories.get(name) ?? { name, total: 0, items: [] };
			category.total += entry.thisMonth;
			category.items.push({ name: entry.name, rhythm: entry.rhythm, next: entry.next, amount: kr(entry.thisMonth) });
			categories.set(name, category);
		}
		const sorted = [...categories.values()]
			.map((category) => ({
				...category,
				total: kr(category.total),
				items: category.items.sort((a, b) => b.amount - a.amount).slice(0, ITEM_MAX),
			}))
			.sort((a, b) => b.total - a.total);
		if (sorted.length <= CATEGORY_MAX) return sorted;
		// The smallest fold into Other, so the ring stays readable.
		const kept = sorted.slice(0, CATEGORY_MAX - 1).filter((category) => category.name !== "Other");
		const rest = sorted.filter((category) => !kept.includes(category));
		return [
			...kept,
			{
				name: "Other",
				total: kr(rest.reduce((sum, category) => sum + category.total, 0)),
				items: rest
					.flatMap((category) => category.items)
					.sort((a, b) => b.amount - a.amount)
					.slice(0, ITEM_MAX),
			},
		];
	};

	const incoming = parties(true);
	const outgoing = parties(false);
	const moneyIn = group(incoming, (entry) => entry.name);
	const moneyOutCategories = group(outgoing, (entry) => outCategory(entry.name, entry.rhythm, entry.typical));
	const repeatingEntries = outgoing.filter((entry) => entry.perMonth > 0 && entry.next !== null);
	const repeating = repeatingEntries.length
		? kr(repeatingEntries.reduce((sum, entry) => sum + entry.typical * entry.perMonth, 0))
		: null;
	const later = outgoing
		.filter((entry) => (entry.rhythm === "quarterly" || entry.rhythm === "yearly") && entry.next !== null)
		.filter((entry) => dayTime(entry.next ?? "") <= today + 120 * DAY)
		.sort((a, b) => (a.next ?? "").localeCompare(b.next ?? ""))
		.slice(0, 20)
		.map((entry) => ({ name: entry.name, date: entry.next ?? "", amount: kr(entry.typical) }));

	// What the saldo is expected to be each week for six weeks: what repeats, as it falls due, and the money that
	// usually comes in, spread evenly.
	const fullMonths = months.filter((month) => month.month !== thisMonth).slice(-3);
	const weeklyIn = fullMonths.length
		? fullMonths.reduce((sum, month) => sum + month.in, 0) / fullMonths.length / (52 / 12)
		: 0;
	const expected: { date: string; saldo: number }[] = [];
	let ahead = saldo;
	for (let week = 1; week <= 6 && history.length > 1; week++) {
		const from = today + (week - 1) * 7 * DAY;
		const to = today + week * 7 * DAY;
		ahead += weeklyIn;
		for (const entry of repeatingEntries) {
			const step =
				entry.rhythm === "weekly" ? 7 : entry.rhythm === "monthly" ? 30 : entry.rhythm === "quarterly" ? 91 : 365;
			for (let due = dayTime(entry.next ?? ""); due <= to; due += step * DAY) if (due > from) ahead -= entry.typical;
		}
		expected.push({ date: iso(to), saldo: kr(ahead) });
	}

	return {
		schema: BANK_SUMMARY_SCHEMA,
		bank: [...input.bank].slice(0, NAME_MAX).join("") || "Bank",
		updatedAt: input.now.toISOString(),
		pausedSince: input.pausedSince,
		saldo,
		disponibel,
		reserveret: kr(Math.max(0, saldo - disponibel)),
		payTo: input.payTo,
		history,
		expected,
		months,
		moneyIn: { month: thisMonth, categories: moneyIn },
		moneyOut: { month: thisMonth, repeating, categories: moneyOutCategories, later },
	};
}

/** The registration and account number a Danish IBAN carries (DKkk rrrr aaaaaaaaaa), or null for any other. */
export function danishAccount(iban: string | null): { reg: string; account: string } | null {
	const compact = (iban ?? "").replace(/\s/g, "").toUpperCase();
	const match = /^DK\d{2}(\d{4})(\d{10})$/.exec(compact);
	return match?.[1] && match[2] ? { reg: match[1], account: match[2] } : null;
}
