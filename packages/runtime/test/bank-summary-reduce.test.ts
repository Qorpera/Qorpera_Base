import {
	BANK_DAYS_MAX,
	companyDay,
	danishAccount,
	reduceBankDays,
	reduceBankSummary,
} from "@qorpera/runtime/bank-summary-reduce";
import type { EnableBankingTransaction } from "@qorpera/runtime/cloud-connector-enable-banking";
import { describe, expect, it } from "vitest";

/* The bank summary reduction (bank-summary-reduce.ts): what the Bank page draws, from balances and transactions. */

const now = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const date = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
const tx = (
	daysAgo: number,
	amount: number,
	counterparty: string | null,
	extra: Partial<EnableBankingTransaction> = {},
) =>
	({
		reference: null,
		amount,
		currency: "DKK",
		status: "BOOK",
		date: date(daysAgo),
		counterparty,
		text: null,
		...extra,
	}) satisfies EnableBankingTransaction;

/** A café's year: card and MobilePay payouts, salaries and rent monthly, beans weekly, software monthly, VAT
 * quarterly, one grinder. */
function year(): EnableBankingTransaction[] {
	const list: EnableBankingTransaction[] = [];
	for (let ago = 0; ago < 365; ago++) {
		if (ago % 7 < 5) list.push(tx(ago, 3100, "NETS DANMARK A/S"));
		list.push(tx(ago, 1350, "MobilePay"));
	}
	for (let ago = 11; ago < 365; ago += 30) list.push(tx(ago, -64000, "Dataløn"));
	for (let ago = 19; ago < 365; ago += 30) list.push(tx(ago, -18500, "Husleje Jægersborggade"));
	for (let ago = 3; ago < 365; ago += 7) list.push(tx(ago, -6150, "Bean supplier ApS"));
	for (let ago = 13; ago < 365; ago += 30) list.push(tx(ago, -420, "Office software"));
	for (let ago = 50; ago < 365; ago += 91) list.push(tx(ago, -38410, "Skattestyrelsen"));
	list.push(tx(6, -6990, "Coffee grinder shop"));
	list.push(tx(1, -500, "Pending card", { status: "PDNG" }));
	return list;
}

describe("the bank summary reduction", () => {
	const summary = reduceBankSummary({
		bank: "Danske Bank",
		now,
		pausedSince: null,
		payTo: danishAccount("DK50 0040 0440 1162 43"),
		accounts: [
			{
				balances: [
					{ type: "CLBD", amount: 282730, currency: "DKK", referenceDate: date(0) },
					{ type: "ITAV", amount: 268410, currency: "DKK", referenceDate: date(0) },
				],
				transactions: year(),
			},
		],
	});

	it("gives the saldo, what is disponibel and what is reserveret, and where to put money in", () => {
		expect(summary).toMatchObject({
			schema: "qorpera.bank-summary/v1",
			bank: "Danske Bank",
			updatedAt: now.toISOString(),
			saldo: 282730,
			disponibel: 268410,
			reserveret: 14320,
			payTo: { reg: "0040", account: "0440116243" },
		});
		expect(danishAccount("NO9386011117947")).toBeNull();
	});

	it("draws the saldo back a year from today's, a point a day, the last one today's", () => {
		expect(summary.history).toHaveLength(365);
		expect(summary.history.at(-1)).toEqual({ date: date(0), saldo: 282730 });
		// The day before today the saldo was today's less today's payouts.
		expect(summary.history.at(-2)?.saldo).toBe(282730 - 3100 - 1350);
		const dates = summary.history.map((point) => point.date);
		expect([...dates].sort()).toEqual(dates);
	});

	it("adds money in and out per month, booked only", () => {
		expect(summary.months.length).toBeLessThanOrEqual(12);
		const october = summary.months.at(-1);
		expect(october?.month).toBe("2026-10");
		expect(summary.months.every((month) => month.in > 0 && month.out > 0)).toBe(true);
	});

	it("sorts money out by what it is, and tells what repeats and when it comes next", () => {
		const names = summary.moneyOut.categories.map((category) => category.name);
		expect(names).toContain("Salaries");
		expect(names).toContain("Rent");
		expect(names).toContain("Subscriptions");
		const subscriptions = summary.moneyOut.categories.find((category) => category.name === "Subscriptions");
		expect(subscriptions?.items[0]).toMatchObject({ name: "Office software", rhythm: "monthly" });
		const beans = summary.moneyOut.categories
			.flatMap((category) => category.items)
			.find((item) => item.name === "Bean supplier ApS");
		expect(beans).toMatchObject({ rhythm: "weekly" });
		expect(beans?.next && beans.next > date(0)).toBe(true);
		expect(summary.moneyOut.repeating).toBeGreaterThan(64000 + 18500);
		expect(summary.moneyOut.later).toEqual([expect.objectContaining({ name: "Skattestyrelsen", amount: 38410 })]);
	});

	it("sorts money in by who paid, the bank's shouting names made readable", () => {
		expect(summary.moneyIn.categories.map((category) => category.name)).toEqual(["Nets Danmark A/S", "MobilePay"]);
	});

	it("expects six weeks ahead from what repeats and what usually comes in", () => {
		expect(summary.expected).toHaveLength(6);
		expect(summary.expected[0]?.date).toBe(new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10));
	});

	it("keeps within the page's bounds: at most eight categories and names of at most 80 characters", () => {
		const many = reduceBankSummary({
			bank: "B".repeat(200),
			now,
			pausedSince: "2026-10-18",
			payTo: null,
			accounts: [
				{
					balances: [],
					transactions: Array.from({ length: 30 }, (_, index) =>
						tx(1, 100 + index, `Customer ${"x".repeat(index)} ${String.fromCharCode(65 + index)}`),
					),
				},
			],
		});
		expect(many.bank).toHaveLength(80);
		expect(many.pausedSince).toBe("2026-10-18");
		expect(many.moneyIn.categories.length).toBeLessThanOrEqual(8);
		expect(many.moneyIn.categories.at(-1)?.name).toBe("Other");
		for (const category of many.moneyIn.categories)
			for (const item of category.items) expect([...item.name].length).toBeLessThanOrEqual(80);
	});
});

describe("the bank summary reduction's edge cases", () => {
	const reduce = (accounts: Parameters<typeof reduceBankSummary>[0]["accounts"]) =>
		reduceBankSummary({ bank: "Danske Bank", now, pausedSince: null, payTo: null, accounts });
	const balance = (type: string, amount: number, daysAgo: number, currency = "DKK") => ({
		type,
		amount,
		currency,
		referenceDate: date(daysAgo),
	});

	it("counts only kroner balances", () => {
		const summary = reduce([
			{ balances: [balance("CLBD", 10_000, 0)], transactions: [] },
			{ balances: [balance("CLBD", 2_000, 0, "EUR")], transactions: [] },
		]);
		expect(summary.saldo).toBe(10_000);
	});

	it("takes today's interim balance over yesterday's closing one, and adds what was booked after a balance's day", () => {
		const both = reduce([
			{
				balances: [balance("CLBD", 1_000, 1), balance("ITBD", 900, 0)],
				transactions: [tx(0, -100, "Shop")],
			},
		]);
		expect(both.saldo).toBe(900);
		expect(both.history.slice(-2).map((point) => point.saldo)).toEqual([1_000, 900]);
		const closingOnly = reduce([{ balances: [balance("CLBD", 1_000, 1)], transactions: [tx(0, -100, "Shop")] }]);
		expect(closingOnly.saldo).toBe(900);
	});

	it("takes an account's own saldo as disponibel when its bank gives no available balance", () => {
		const summary = reduce([
			{ balances: [balance("CLBD", 1_000, 0), balance("ITAV", 1_000, 0)], transactions: [] },
			{ balances: [balance("CLBD", 2_000, 0)], transactions: [] },
		]);
		expect(summary.disponibel).toBe(3_000);
		expect(summary.reserveret).toBe(0);
	});

	it("counts a cost that comes every day in what repeats and in the weeks ahead", () => {
		const daily = Array.from({ length: 60 }, (_, ago) => tx(ago, -100, "Bakery"));
		const summary = reduce([{ balances: [balance("CLBD", 50_000, 0)], transactions: daily }]);
		const bakery = summary.moneyOut.categories
			.flatMap((category) => category.items)
			.find((item) => item.name === "Bakery");
		expect(bakery?.rhythm).toBe("daily");
		expect(summary.moneyOut.repeating).toBe(Math.round(((100 * 365) / 12) * 100) / 100);
		expect(summary.expected[0]?.saldo).toBe(50_000 - 700);
	});

	it("takes a payment due today, not yet booked, into the first week", () => {
		const monthly = [30, 60, 90].map((ago) => tx(ago, -10_000, "Landlord rent"));
		const summary = reduce([{ balances: [balance("CLBD", 50_000, 0)], transactions: monthly }]);
		expect(summary.expected[0]?.saldo).toBe(40_000);
		expect(summary.expected[1]?.saldo).toBe(40_000);
	});

	it("averages money in over the last three calendar months, a month with nothing counting as nothing", () => {
		const july = new Date("2026-07-15T12:00:00Z");
		const daysAgo = Math.round((now.getTime() - july.getTime()) / DAY);
		const summary = reduce([
			{ balances: [balance("CLBD", 50_000, 0)], transactions: [tx(daysAgo, 30_000, "Client")] },
		]);
		expect(summary.expected[0]?.saldo).toBe(Math.round((50_000 + 30_000 / 3 / (52 / 12)) * 100) / 100);
	});

	it("keeps every name within 80 UTF-16 code units, as the page counts them, without splitting a character", () => {
		const name = `${"x".repeat(79)}\u{1F600}`;
		const summary = reduceBankSummary({
			bank: name,
			now,
			pausedSince: null,
			payTo: null,
			accounts: [{ balances: [balance("CLBD", 1, 0)], transactions: [tx(1, 10, name), tx(1, -10, name)] }],
		});
		expect(summary.bank.length).toBeLessThanOrEqual(80);
		for (const category of [...summary.moneyIn.categories, ...summary.moneyOut.categories])
			for (const item of category.items) {
				expect(item.name.length).toBeLessThanOrEqual(80);
				expect(item.name).toBe("x".repeat(79));
			}
	});
});

describe("balances as the bank's types mean them", () => {
	const reduce = (accounts: Parameters<typeof reduceBankSummary>[0]["accounts"]) =>
		reduceBankSummary({ bank: "Danske Bank", now, pausedSince: null, payTo: null, accounts });
	const balance = (type: string, amount: number, daysAgo: number) => ({
		type,
		amount,
		currency: "DKK",
		referenceDate: date(daysAgo),
	});

	it("moves an opening balance forward with its own day's payments", () => {
		const summary = reduce([
			{ balances: [balance("CLBD", 1_000, 1), balance("OPBD", 1_000, 0)], transactions: [tx(0, -100, "Shop")] },
		]);
		expect(summary.saldo).toBe(900);
		expect(summary.history.slice(-2).map((point) => point.saldo)).toEqual([1_000, 900]);
	});

	it("leaves out a balance dated ahead", () => {
		const summary = reduce([
			{
				balances: [balance("CLBD", 1_000, 0), balance("CLAV", 1_000, 1), balance("FWAV", 5_000, -1)],
				transactions: [],
			},
		]);
		expect(summary.disponibel).toBe(1_000);
	});

	it("doesn't take a card hold off twice when it settles: an old available balance isn't moved forward", () => {
		const summary = reduce([
			{ balances: [balance("CLBD", 1_000, 1), balance("CLAV", 900, 1)], transactions: [tx(0, -100, "Shop")] },
		]);
		expect(summary.saldo).toBe(900);
		expect(summary.disponibel).toBe(900);
		expect(summary.reserveret).toBe(0);
	});

	it("doesn't take today's opening available balance as what is disponibel now", () => {
		const summary = reduce([
			{ balances: [balance("OPBD", 1_000, 0), balance("OPAV", 1_000, 0)], transactions: [tx(0, -100, "Shop")] },
		]);
		expect(summary.saldo).toBe(900);
		expect(summary.disponibel).toBe(900);
		expect(summary.reserveret).toBe(0);
	});

	it("reads two payments on one day as one day, not as something that comes every day", () => {
		const summary = reduce([
			{ balances: [balance("CLBD", 1_000, 0)], transactions: [tx(0, -100, "Shop"), tx(0, -100, "Shop")] },
		]);
		const shop = summary.moneyOut.categories
			.flatMap((category) => category.items)
			.find((item) => item.name === "Shop");
		expect(shop).toMatchObject({ rhythm: "once", amount: 200 });
		expect(summary.moneyOut.repeating).toBeNull();
		expect(summary.expected[0]?.saldo).toBe(1_000);
	});

	it("bounds a shouted name after making it readable, whose length can change", () => {
		const summary = reduce([
			{ balances: [balance("CLBD", 1, 0)], transactions: [tx(1, -10, `${"A".repeat(79)}\u0130`)] },
		]);
		for (const category of summary.moneyOut.categories)
			for (const item of category.items) expect(item.name.length).toBeLessThanOrEqual(80);
	});
});

describe("the days by kind", () => {
	const input = (accounts: Parameters<typeof reduceBankDays>[0]["accounts"], at = now) => ({
		bank: "Danske Bank",
		now: at,
		pausedSince: null,
		payTo: null,
		accounts,
	});
	const balances = [{ type: "CLBD", amount: 282730, currency: "DKK", referenceDate: date(0) }];
	const days = reduceBankDays(input([{ balances, transactions: year() }]));
	const summary = reduceBankSummary(input([{ balances, transactions: year() }]));
	const total = (rows: typeof days.days) => Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;

	it("covers each day from the first booked one to today, with only booked kroner and no names", () => {
		expect(days).toMatchObject({ schema: "qorpera.bank-days/v1", from: date(364), to: date(0) });
		expect(days.days[0]?.day).toBe(date(364));
		expect(days.days.at(-1)?.day).toBe(date(0));
		const serialized = JSON.stringify(days);
		for (const name of ["Nets", "NETS", "MobilePay", "Dataløn", "Husleje", "Bean", "Skattestyrelsen", "grinder"])
			expect(serialized).not.toContain(name);
		for (const row of days.days)
			expect(Object.keys(row).sort()).toEqual(["amount", "count", "day", "direction", "kind"]);
		// The pending card payment is no day's.
		expect(days.days.filter((row) => row.day === date(1) && row.direction === "out")).toEqual([]);
	});

	it("sums each day's money in and out by kind, with how many payments, adding up to the months", () => {
		expect(days.days.filter((row) => row.day === date(0))).toEqual([
			{ day: date(0), direction: "in", kind: "sales", amount: 4450, count: 2 },
		]);
		expect(days.days.filter((row) => row.day === date(3))).toEqual([
			{ day: date(3), direction: "in", kind: "sales", amount: 4450, count: 2 },
			{ day: date(3), direction: "out", kind: "other", amount: 6150, count: 1 },
		]);
		expect(days.days.find((row) => row.day === date(11) && row.direction === "out")).toEqual({
			day: date(11),
			direction: "out",
			kind: "salaries",
			amount: 64000,
			count: 1,
		});
		expect(days.days.find((row) => row.day === date(50) && row.direction === "out")?.kind).toBe("taxes");
		expect(days.days.find((row) => row.day === date(19) && row.direction === "out")?.kind).toBe("rent");
		for (const month of summary.months) {
			const inMonth = days.days.filter((row) => row.day.startsWith(month.month));
			expect(total(inMonth.filter((row) => row.direction === "in"))).toBe(month.in);
			expect(total(inMonth.filter((row) => row.direction === "out"))).toBe(month.out);
		}
	});

	it("gives this month's money out the summary's categories, as words", () => {
		const words: Record<string, string> = {
			Salaries: "salaries",
			"Taxes and VAT": "taxes",
			Rent: "rent",
			Utilities: "utilities",
			Subscriptions: "subscriptions",
			"Card and app fees": "fees",
			Other: "other",
		};
		const thisMonth = days.days.filter(
			(row) => row.day.startsWith(summary.moneyOut.month) && row.direction === "out",
		);
		for (const category of summary.moneyOut.categories)
			expect(total(thisMonth.filter((row) => row.kind === words[category.name]))).toBe(category.total);
		expect(new Set(thisMonth.map((row) => row.kind))).toEqual(
			new Set(summary.moneyOut.categories.map((category) => words[category.name])),
		);
	});

	it("names money in by what paid it, never who: payment providers' payouts, the tax authority's refunds, the rest", () => {
		const providers = [
			"Stripe Technology Europe",
			"SumUp Payments",
			"Zettle by PayPal",
			"Shopify International",
			"KLARNA BANK AB",
			"Nets Denmark A/S",
			"Vipps MobilePay AS",
		];
		const paid = reduceBankDays(
			input([
				{
					balances: [],
					transactions: [
						...providers.map((name) => tx(2, 100, name)),
						tx(2, 2500, "Skattestyrelsen"),
						tx(2, 900, "SKAT"),
						tx(2, 40, null, { text: "Overførsel fra Jens" }),
						tx(2, 3000, "Kunde ApS"),
					],
				},
			]),
		);
		expect(paid.days).toEqual([
			{ day: date(2), direction: "in", kind: "sales", amount: 700, count: 7 },
			{ day: date(2), direction: "in", kind: "tax", amount: 3400, count: 2 },
			{ day: date(2), direction: "in", kind: "other", amount: 3040, count: 2 },
		]);
		// A provider's fee is money out, a fee.
		const fee = reduceBankDays(input([{ balances: [], transactions: [tx(2, -12.5, "Stripe")] }]));
		expect(fee.days).toEqual([{ day: date(2), direction: "out", kind: "fees", amount: 12.5, count: 1 }]);
	});

	it("adds the accounts together, kroner only", () => {
		const both = reduceBankDays(
			input([
				{ balances: [], transactions: [tx(4, 100, "Kunde"), tx(4, -30, "Kiosk")] },
				{ balances: [], transactions: [tx(4, 50, "Kunde"), tx(4, 999, "Kunde", { currency: "EUR" })] },
			]),
		);
		expect(both.days).toEqual([
			{ day: date(4), direction: "in", kind: "other", amount: 150, count: 2 },
			{ day: date(4), direction: "out", kind: "other", amount: 30, count: 1 },
		]);
	});

	it("covers only today when nothing is booked, and at most 400 days", () => {
		expect(reduceBankDays(input([{ balances, transactions: [] }]))).toEqual({
			schema: "qorpera.bank-days/v1",
			from: date(0),
			to: date(0),
			days: [],
		});
		const long = reduceBankDays(
			input([{ balances, transactions: [tx(500, 10, "Kunde"), tx(399, 20, "Kunde"), tx(400, 30, "Kunde")] }]),
		);
		expect(BANK_DAYS_MAX).toBe(400);
		expect(long.from).toBe(date(399));
		expect(long.days).toEqual([{ day: date(399), direction: "in", kind: "other", amount: 20, count: 1 }]);
	});
});

describe("today is the company's date, in Copenhagen when it has no zone", () => {
	const at = (moment: string, transactions: EnableBankingTransaction[] = [], timeZone?: string | null) => {
		const reading = {
			bank: "Danske Bank",
			now: new Date(moment),
			timeZone,
			pausedSince: null,
			payTo: null,
			accounts: [{ balances: [], transactions }],
		};
		return { summary: reduceBankSummary(reading), days: reduceBankDays(reading) };
	};
	const on = (day: string, amount: number) =>
		({
			reference: null,
			amount,
			currency: "DKK",
			status: "BOOK",
			date: day,
			counterparty: "Kunde",
			text: null,
		}) satisfies EnableBankingTransaction;

	it("turns at midnight in Copenhagen, summer and winter, not at midnight UTC", () => {
		// Summer (UTC+2): 23:59 and 00:00 in Copenhagen.
		expect(companyDay(new Date("2026-07-14T21:59:59Z"))).toBe("2026-07-14");
		expect(companyDay(new Date("2026-07-14T22:00:00Z"))).toBe("2026-07-15");
		// Winter (UTC+1).
		expect(companyDay(new Date("2026-12-31T22:59:59Z"))).toBe("2026-12-31");
		expect(companyDay(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
		// The nights the clocks change: 29 March (02:00 becomes 03:00) and 25 October (03:00 becomes 02:00).
		expect(companyDay(new Date("2026-03-28T22:59:59Z"))).toBe("2026-03-28");
		expect(companyDay(new Date("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
		expect(companyDay(new Date("2026-03-29T21:59:59Z"))).toBe("2026-03-29");
		expect(companyDay(new Date("2026-03-29T22:00:00Z"))).toBe("2026-03-30");
		expect(companyDay(new Date("2026-10-24T21:59:59Z"))).toBe("2026-10-24");
		expect(companyDay(new Date("2026-10-24T22:00:00Z"))).toBe("2026-10-25");
		expect(companyDay(new Date("2026-10-25T22:59:59Z"))).toBe("2026-10-25");
		expect(companyDay(new Date("2026-10-25T23:00:00Z"))).toBe("2026-10-26");
	});

	it("counts a payment booked on the new day just after midnight, in the summary and the days", () => {
		// 00:30 on 1 November in Copenhagen is still 31 October in UTC.
		const { summary, days } = at("2026-10-31T23:30:00Z", [on("2026-10-31", 100), on("2026-11-01", 40)]);
		expect(days.to).toBe("2026-11-01");
		expect(days.days.map((row) => row.day)).toEqual(["2026-10-31", "2026-11-01"]);
		expect(summary.history.at(-1)?.date).toBe("2026-11-01");
		expect(summary.moneyIn.month).toBe("2026-11");
		expect(summary.moneyOut.month).toBe("2026-11");
		expect(summary.months.at(-1)).toEqual({ month: "2026-11", in: 40, out: 0 });
		// The summary keeps its shape: the Bank page parses it strictly.
		expect(Object.keys(summary).sort()).toEqual(
			[
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
			].sort(),
		);
		expect(summary.updatedAt).toBe("2026-10-31T23:30:00.000Z");
	});

	it("takes the company's own zone, and Copenhagen when it has none or an unknown one", () => {
		// 23:30 on 31 October in New York is 04:30 on 1 November in Copenhagen.
		const moment = new Date("2026-11-01T03:30:00Z");
		expect(companyDay(moment, "America/New_York")).toBe("2026-10-31");
		expect(companyDay(moment, "Asia/Tokyo")).toBe("2026-11-01");
		expect(companyDay(new Date("2026-10-31T15:30:00Z"), "Asia/Tokyo")).toBe("2026-11-01");
		for (const none of [undefined, null, "", "Mars/Olympus_Mons", "../etc/passwd", "x".repeat(65)])
			expect(companyDay(moment, none)).toBe("2026-11-01");
		const york = at("2026-11-01T03:30:00Z", [on("2026-10-31", 100), on("2026-11-01", 40)], "America/New_York");
		expect(york.days.to).toBe("2026-10-31");
		expect(york.days.days.map((row) => row.day)).toEqual(["2026-10-31"]);
		expect(york.summary.history.at(-1)?.date).toBe("2026-10-31");
		expect(york.summary.moneyIn.month).toBe("2026-10");
		const tokyo = at("2026-10-31T15:30:00Z", [on("2026-11-01", 40)], "Asia/Tokyo");
		expect(tokyo.days).toMatchObject({ from: "2026-11-01", to: "2026-11-01" });
		expect(tokyo.summary.moneyOut.month).toBe("2026-11");
		// No zone (null) is Copenhagen's date.
		const none = at("2026-11-01T03:30:00Z", [on("2026-11-01", 40)], null);
		expect(none.days.to).toBe("2026-11-01");
		expect(none.summary.months.at(-1)).toEqual({ month: "2026-11", in: 40, out: 0 });
		expect(Object.keys(york.summary).sort()).toEqual(Object.keys(none.summary).sort());
	});

	it("leaves out a payment dated after today in Copenhagen", () => {
		// 23:30 on 24 October in Copenhagen (summer time): the 25th has not begun.
		const { summary, days } = at("2026-10-24T21:30:00Z", [on("2026-10-24", 100), on("2026-10-25", 40)]);
		expect(days.to).toBe("2026-10-24");
		expect(days.days.map((row) => row.day)).toEqual(["2026-10-24"]);
		expect(summary.history.at(-1)?.date).toBe("2026-10-24");
		// On the night the clocks go back, 00:30 UTC is 02:30 in Copenhagen on the 25th.
		const night = at("2026-10-25T00:30:00Z", [on("2026-10-25", 40)]);
		expect(night.days.to).toBe("2026-10-25");
		expect(night.days.days).toEqual([{ day: "2026-10-25", direction: "in", kind: "other", amount: 40, count: 1 }]);
	});
});
