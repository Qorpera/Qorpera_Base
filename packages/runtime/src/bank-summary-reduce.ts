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

/** At most `NAME_MAX` UTF-16 code units, as the web counts them, never splitting a character. */
function clipName(value: string): string {
	let clipped = "";
	for (const character of value) {
		if (clipped.length + character.length > NAME_MAX) break;
		clipped += character;
	}
	return clipped.trim();
}

/** Who was paid or who paid, as the page names them: the bank's name for them, else the transfer's text, trimmed. */
function party(transaction: EnableBankingTransaction): string {
	const raw = (transaction.counterparty ?? transaction.text ?? "").replace(/\s+/g, " ").trim();
	if (!raw) return transaction.amount >= 0 ? "Unnamed payment in" : "Unnamed payment";
	// A name the bank shouts is made readable first, then bounded: changing case can change a name's length.
	const readable =
		raw === raw.toUpperCase() && /[A-ZÆØÅ]/.test(raw)
			? raw
					.toLowerCase()
					.replace(/(^|[\s/-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase())
			: raw;
	return clipName(readable) || (transaction.amount >= 0 ? "Unnamed payment in" : "Unnamed payment");
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
	if (median <= 1.5) return { rhythm: "daily", next: ahead(1), perMonth: 365 / 12 };
	if (median <= 9) return { rhythm: "weekly", next: ahead(7), perMonth: 52 / 12 };
	if (median <= 40) return { rhythm: "monthly", next: ahead(Math.round(median)), perMonth: 1 };
	if (median <= 100) return { rhythm: "quarterly", next: ahead(91), perMonth: 1 / 3 };
	if (median <= 400) return { rhythm: "yearly", next: ahead(365), perMonth: 1 / 12 };
	return { rhythm: "now-and-then", next: null, perMonth: 0 };
}

const BOOKED = ["ITBD", "CLBD", "XPCD", "OPBD", "PRCD"];
/** Available balances that describe now: an opening one (OPAV) is the day's start, before its holds and payments. */
const AVAILABLE = ["ITAV", "XPCD", "CLAV"];

/** An account's saldo today: its newest booked DKK balance dated today or before (a later day first, then the types'
 * order), plus what was booked after it: after its day for a closing or interim balance, from its day on for an
 * opening one. A balance dated ahead isn't today's. Null when the account gives none. */
function saldoToday(
	account: BankSummaryAccount,
	booked: readonly EnableBankingTransaction[],
	today: string,
): number | null {
	const newest = account.balances
		.filter((balance) => balance.currency === "DKK" && BOOKED.includes(balance.type))
		.filter((balance) => balance.referenceDate === null || balance.referenceDate <= today)
		.map((balance) => ({ balance, day: balance.referenceDate ?? today }))
		.sort((a, b) => b.day.localeCompare(a.day) || BOOKED.indexOf(a.balance.type) - BOOKED.indexOf(b.balance.type))[0];
	if (!newest) return null;
	const opening = newest.balance.type === "OPBD";
	const after = booked
		.filter((transaction) => (opening ? transaction.date >= newest.day : transaction.date > newest.day))
		.reduce((sum, each) => sum + each.amount, 0);
	return newest.balance.amount + after;
}

/** An account's available balance today, only from a snapshot of today (or undated): an older one can't be moved
 * forward, since a card hold that settled since then is in both its reservation and the booked movements. */
function disponibelToday(account: BankSummaryAccount, today: string): number | null {
	const current = account.balances
		.filter((balance) => balance.currency === "DKK" && AVAILABLE.includes(balance.type))
		.filter((balance) => balance.referenceDate === null || balance.referenceDate === today)
		.sort((a, b) => AVAILABLE.indexOf(a.type) - AVAILABLE.indexOf(b.type))[0];
	return current ? current.amount : null;
}

export function reduceBankSummary(input: BankSummaryInput): BankSummaryFile {
	const now = input.now.getTime();
	const today = dayTime(iso(now));
	const bookedOf = (account: BankSummaryAccount) =>
		account.transactions.filter(
			(transaction) =>
				transaction.status === "BOOK" && transaction.currency === "DKK" && dayTime(transaction.date) <= today,
		);
	// Each account on its own: its saldo today, and what is disponibel (its saldo when the bank gives no available
	// balance); then the accounts together.
	let saldoTotal = 0;
	let disponibelTotal = 0;
	for (const account of input.accounts) {
		const accountBooked = bookedOf(account);
		const accountSaldo = saldoToday(account, accountBooked, iso(today)) ?? 0;
		saldoTotal += accountSaldo;
		disponibelTotal += disponibelToday(account, iso(today)) ?? accountSaldo;
	}
	const saldo = kr(saldoTotal);
	const disponibel = kr(disponibelTotal);
	const booked = input.accounts.flatMap(bookedOf);

	// The saldo each day, back from today's: a day's saldo is today's less what moved after it.
	const moved = new Map<number, number>();
	for (const transaction of booked)
		moved.set(dayTime(transaction.date), (moved.get(dayTime(transaction.date)) ?? 0) + transaction.amount);
	// From the day before the first transaction, whose saldo is known too.
	const earliest = Math.max(today - (HISTORY_DAYS - 1) * DAY, Math.min(today, ...moved.keys()) - DAY);
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
			// Payments on the same day count as one: the rhythm is read across days, the typical amount is a day's.
			const byDay = new Map<number, number>();
			entry.days.forEach((time, index) => {
				byDay.set(time, (byDay.get(time) ?? 0) + (entry.amounts[index] ?? 0));
			});
			const days = [...byDay.keys()].sort((a, b) => a - b);
			const rhythm = rhythmOf(days, today);
			const sums = [...byDay.values()].sort((a, b) => a - b);
			const typical = sums[Math.floor(sums.length / 2)] ?? 0;
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
	// The three calendar months before this one, a month with nothing coming in counting as nothing, as far back as the
	// bank's history reaches.
	const firstMonth = booked.reduce(
		(first, each) => (monthOf(each.date) < first ? monthOf(each.date) : first),
		thisMonth,
	);
	const recent = [1, 2, 3]
		.map((back) => {
			const start = new Date(`${thisMonth}-01T00:00:00Z`);
			start.setUTCMonth(start.getUTCMonth() - back);
			return start.toISOString().slice(0, 7);
		})
		.filter((month) => month >= firstMonth);
	const weeklyIn = recent.length
		? recent.reduce((sum, month) => sum + (byMonth.get(month)?.in ?? 0), 0) / recent.length / (52 / 12)
		: 0;
	const expected: { date: string; saldo: number }[] = [];
	let ahead = saldo;
	for (let week = 1; week <= 6 && history.length > 1; week++) {
		const from = today + (week - 1) * 7 * DAY;
		const to = today + week * 7 * DAY;
		ahead += weeklyIn;
		// The first week takes what falls due today too; each later week what falls due after the week before it.
		const after = week === 1 ? today - DAY : from;
		for (const entry of repeatingEntries) {
			const step =
				entry.rhythm === "daily"
					? 1
					: entry.rhythm === "weekly"
						? 7
						: entry.rhythm === "monthly"
							? 30
							: entry.rhythm === "quarterly"
								? 91
								: 365;
			for (let due = dayTime(entry.next ?? ""); due <= to; due += step * DAY)
				if (due > after) ahead -= entry.typical;
		}
		expected.push({ date: iso(to), saldo: kr(ahead) });
	}

	return {
		schema: BANK_SUMMARY_SCHEMA,
		bank: clipName(input.bank) || "Bank",
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
