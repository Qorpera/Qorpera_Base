// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BANK_SUMMARY_PATH } from "../src/app/bank-page.ts";
import { BANK_SUMMARY_SCHEMA, parseBankSummary } from "../src/app/bank-summary.ts";
import { CompanyController } from "../src/app/company.ts";
import type { InterfacePagesState } from "../src/app/interface-pages.ts";
import { companyInterfaces } from "../src/app/interfaces.ts";
import { parseKroner } from "../src/app/views/bank.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import { interfaceEmblem } from "../src/ui/interface-emblem.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* The Bank page (app/bank-page.ts, app/bank-summary.ts, app/views/bank.ts): a third page a company may switch on,
 * drawn from the bank summary in its folder. */

const cofounder = { ...staff, id: id(40), displayName: "Kaya", templateId: "co-founder" };

function summary(extra: Record<string, unknown> = {}) {
	return {
		schema: BANK_SUMMARY_SCHEMA,
		bank: "Danske Bank",
		updatedAt: "2026-10-20T19:58:00Z",
		pausedSince: null,
		saldo: 282730,
		disponibel: 268410,
		reserveret: 14320,
		payTo: { reg: "1234", account: "0004471" },
		history: [
			{ date: "2026-09-29", saldo: 250000 },
			{ date: "2026-10-06", saldo: 262000 },
			{ date: "2026-10-13", saldo: 271000 },
			{ date: "2026-10-20", saldo: 282730 },
		],
		expected: [
			{ date: "2026-10-27", saldo: 300000 },
			{ date: "2026-11-03", saldo: 236000 },
		],
		months: [
			{ month: "2026-09", in: 125000, out: 122700 },
			{ month: "2026-10", in: 140200, out: 127500 },
		],
		moneyIn: {
			month: "2026-10",
			categories: [
				{
					name: "Card terminal",
					total: 68400,
					items: [{ name: "22 payouts", rhythm: "weekdays", next: null, amount: 68400 }],
				},
				{
					name: "Wolt",
					total: 71800,
					items: [{ name: "Payout", rhythm: "weekly", next: "2026-10-27", amount: 71800 }],
				},
			],
		},
		moneyOut: {
			month: "2026-10",
			repeating: 114070,
			categories: [
				{
					name: "Salaries",
					total: 64000,
					items: [{ name: "Net pay, 3 people", rhythm: "monthly", next: "2026-10-31", amount: 64000 }],
				},
				{
					name: "Subscriptions",
					total: 4870,
					items: [
						{ name: "Insurance", rhythm: "monthly", next: "2026-11-01", amount: 2800 },
						{ name: "Office software", rhythm: "monthly", next: "2026-11-07", amount: 2070 },
					],
				},
			],
			later: [{ name: "VAT, Jul–Sep", date: "2026-12-01", amount: 38410 }],
		},
		...extra,
	};
}

const pages = (bank: boolean): InterfacePagesState => ({
	pages: [
		{ page: "mailbox", on: false },
		{ page: "members", on: false },
		{ page: "bank", on: bank },
	],
	mayChange: true,
});

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
		this.removeAttribute("open");
	};
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function company(on: boolean, file?: string) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: [cofounder],
		sessions: [session],
		team: {
			...team,
			members: [
				{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
			],
		},
		interfacePages: pages(on),
		interfaceFolder: {
			tables: new Map(),
			files: file === undefined ? new Map() : new Map([[BANK_SUMMARY_PATH, file]]),
			sources: new Map(),
		},
	});
	cleanup.push(() => controller.stop());
	return controller;
}

function draw(file?: string): HTMLElement {
	const container = document.createElement("main");
	document.body.append(container);
	renderInterface(container, company(true, file), "bank");
	return container;
}

const click = (root: ParentNode, label: string) => {
	const target = [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
	if (!target) throw new Error(`No button ${label}`);
	target.click();
};

describe("the bank summary (app/bank-summary.ts)", () => {
	it("reads a summary", () => {
		const parsed = parseBankSummary(JSON.stringify(summary()));
		expect(parsed?.saldo).toBe(282730);
		expect(parsed?.moneyOut.categories.map((category) => category.name)).toEqual(["Salaries", "Subscriptions"]);
		expect(parsed?.payTo).toEqual({ reg: "1234", account: "0004471" });
	});

	it("refuses a file that isn't one, so the page never draws half a summary", () => {
		const bad = [
			"not json",
			JSON.stringify({ ...summary(), schema: "qorpera.bank-summary/v2" }),
			JSON.stringify({ ...summary(), extra: 1 }),
			JSON.stringify({ ...summary(), saldo: "282730" }),
			JSON.stringify({ ...summary(), saldo: 1.234 }),
			JSON.stringify({ ...summary(), reserveret: -1 }),
			JSON.stringify({
				...summary(),
				history: [
					{ date: "2026-10-20", saldo: 1 },
					{ date: "2026-10-19", saldo: 2 },
				],
			}),
			JSON.stringify({ ...summary(), months: [{ month: "2026-13", in: 1, out: 1 }] }),
			JSON.stringify({ ...summary(), pausedSince: "2026-02-31" }),
			JSON.stringify({ ...summary(), pausedSince: "2027-02-29" }),
			JSON.stringify({ ...summary(), history: [{ date: "2026-04-31", saldo: 1 }] }),
			JSON.stringify({ ...summary(), payTo: { reg: "12", account: "1" } }),
			JSON.stringify({
				...summary(),
				moneyIn: {
					month: "2026-10",
					categories: [{ name: "A", total: 1, items: [{ name: "x", rhythm: "hourly", next: null, amount: 1 }] }],
				},
			}),
		];
		for (const text of bad) expect(parseBankSummary(text)).toBeNull();
		// A leap day is a day.
		expect(parseBankSummary(JSON.stringify({ ...summary(), pausedSince: "2028-02-29" }))?.pausedSince).toBe(
			"2028-02-29",
		);
	});
});

describe("an amount the member writes (app/views/bank.ts)", () => {
	it("reads the Danish way, to the øre, and refuses what it would have to guess", () => {
		expect(parseKroner("50.000")).toBe(50000);
		expect(parseKroner("1.250,50")).toBe(1250.5);
		expect(parseKroner("100,5")).toBe(100.5);
		expect(parseKroner(" 2 500 ")).toBe(2500);
		for (const bad of ["", "0", "100.50", "1,234", "12.34.567", "-5", "abc", "1.25"])
			expect(parseKroner(bad)).toBeNull();
	});
});

describe("the Bank page (app/views/bank.ts)", () => {
	it("is listed once it is switched on, before the company has a summary, with the bank emblem", () => {
		expect(companyInterfaces(company(false)).map((entry) => entry.name)).toEqual([]);
		expect(companyInterfaces(company(true)).map((entry) => entry.name)).toEqual(["bank"]);
		expect(interfaceEmblem("bank", "green", 40).querySelectorAll("rect")).toHaveLength(5);
	});

	it("says there is no bank yet, or that its summary can't be read", () => {
		expect(draw().textContent).toContain("No bank yet");
		expect(draw("{}").textContent).toContain("The bank summary can't be read");
	});

	it("shows the saldo, what is disponibel and reserveret, the saldo over time and money in and out", () => {
		const page = draw(JSON.stringify(summary()));
		const text = page.textContent ?? "";
		expect(text).toContain("282.730 kr");
		expect(text).toContain("Disponibel");
		expect(text).toContain("268.410 kr");
		expect(text).toContain("Reserveret");
		expect(page.querySelector(".bank-chart svg")).not.toBeNull();
		expect(page.querySelectorAll(".bank-bar-in")).toHaveLength(2);
		expect(page.querySelectorAll(".bank-bar-out")).toHaveLength(2);
		expect([...page.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toEqual([
			"Overview",
			"Money in",
			"Money out",
		]);
	});

	it("breaks money out down by category, each opening to what it holds, and folds a section away", () => {
		const page = draw(JSON.stringify(summary()));
		click(page, "Money out");
		expect(page.textContent).toContain("Repeats every month");
		expect(page.textContent).toContain("114.070 kr");
		expect(page.querySelector(".bank-ring")?.getAttribute("aria-label")).toBe("Salaries 93%, Subscriptions 7%");
		expect(page.textContent).not.toContain("Office software");
		const row = [...page.querySelectorAll<HTMLButtonElement>(".bank-category-row")].find((button) =>
			button.textContent?.includes("Subscriptions"),
		);
		row?.click();
		expect(page.textContent).toContain("Office software");
		expect(page.textContent).toContain("Also coming: VAT, Jul–Sep");
		click(page, "Where it goes");
		expect(page.querySelector(".bank-ring")).toBeNull();
	});

	it("dims the page and says so while the bank has paused sharing", () => {
		const page = draw(JSON.stringify(summary({ pausedSince: "2026-10-18" })));
		expect(page.querySelector(".bank-paused")?.textContent).toContain("Danske Bank paused sharing on");
		expect(page.querySelector(".bank-dimmed")).not.toBeNull();
	});

	it("tells the member how to put money in, as a loan or as share capital, and moves no money", () => {
		const page = draw(JSON.stringify(summary()));
		click(page, "Put in money");
		const dialog = document.querySelector<HTMLDialogElement>(".bank-put-dialog");
		expect(dialog?.textContent).toContain("A loan to the company");
		expect(dialog?.textContent).toContain("Kaya writes a short loan paper");
		const write = (value: string) => {
			const input = dialog?.querySelector("input");
			if (!input) throw new Error("No amount field");
			input.value = value;
			input.dispatchEvent(new Event("input"));
		};
		// An amount it can't read is said, never changed into another.
		write("100.50");
		click(dialog as HTMLElement, "Continue");
		expect(dialog?.querySelector("[role=alert]")?.textContent).toBe("Write an amount like 50.000 or 1.250,50.");
		expect(dialog?.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
		write("1.250,50");
		click(dialog as HTMLElement, "Continue");
		expect(dialog?.textContent).toContain("Send 1.250,50 kr from your own bank");
		expect(dialog?.textContent).toContain("Loan from Ann");
		expect(dialog?.textContent).toContain("1234 0004471");
		click(dialog as HTMLElement, "Back");
		const shares = dialog?.querySelectorAll<HTMLButtonElement>("[role=radio]")[1];
		shares?.click();
		click(dialog as HTMLElement, "Continue");
		expect(dialog?.textContent).toContain("Share capital, Ann");
		click(dialog as HTMLElement, "Done");
		expect(document.querySelector(".bank-put-dialog")).toBeNull();
	});

	it("closes the dialog, with the company's account in it, when the page goes", async () => {
		const page = draw(JSON.stringify(summary()));
		click(page, "Put in money");
		expect(document.querySelector(".bank-put-dialog")).not.toBeNull();
		page.replaceChildren();
		await settle();
		expect(document.querySelector(".bank-put-dialog")).toBeNull();
	});

	it("keeps the saldo axis to a few round lines, however far apart the days are", () => {
		const page = draw(
			JSON.stringify(
				summary({
					history: [
						{ date: "2026-10-13", saldo: 0 },
						{ date: "2026-10-20", saldo: 900_000_000_000 },
					],
					expected: [],
				}),
			),
		);
		const lines = page.querySelectorAll(".bank-axis-y").length;
		expect(lines).toBeGreaterThan(1);
		expect(lines).toBeLessThanOrEqual(8);
	});

	it("names each line of a nearly flat saldo differently", () => {
		for (const second of [1_001_000, 1_000_001, 1_000_000.5]) {
			const page = draw(
				JSON.stringify(
					summary({
						history: [
							{ date: "2026-10-13", saldo: 1_000_000 },
							{ date: "2026-10-20", saldo: second },
						],
						expected: [],
					}),
				),
			);
			const names = [...page.querySelectorAll(".bank-axis-y")].map((label) => label.textContent);
			expect(names.length).toBeGreaterThan(1);
			expect(new Set(names).size).toBe(names.length);
		}
	});

	it("tints a category in place when it is pointed at, and keeps the focus when one opens", () => {
		const page = draw(JSON.stringify(summary()));
		click(page, "Money out");
		const ring = page.querySelector<HTMLElement>(".bank-ring");
		const row = () =>
			[...page.querySelectorAll<HTMLButtonElement>(".bank-category-row")].find((button) =>
				button.textContent?.includes("Subscriptions"),
			);
		row()?.dispatchEvent(new Event("pointerenter"));
		expect(page.querySelector(".bank-ring")).toBe(ring);
		expect(page.querySelector(".bank-ring-hole")?.textContent).toContain("Subscriptions");
		expect(page.querySelector(".bank-ring-hole")?.textContent).toContain("4.870 kr");
		page.querySelector(".bank-categories")?.dispatchEvent(new Event("pointerleave"));
		expect(page.querySelector(".bank-ring-hole")?.textContent).toContain("Total");
		row()?.focus();
		row()?.click();
		expect(document.activeElement).toBe(row());
		expect(row()?.getAttribute("aria-expanded")).toBe("true");
	});
});
