import { danishAccount, reduceBankSummary } from "@qorpera/runtime/bank-summary-reduce";
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
