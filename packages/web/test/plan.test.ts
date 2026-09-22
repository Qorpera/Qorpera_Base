// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_OFFERS, planName, renderPlan } from "../src/app/views/plan.ts";
import { file } from "./fixtures.ts";

const entitlement = (planKey: string) => ({
	planKey,
	billingMode: "fixture",
	featureSet: "fixture",
	storageAllocation: "fixture",
	storageAllocationBytes: 50 * 1024 ** 3,
	source: "fixture",
});
let container: HTMLElement;
beforeEach(() => {
	localStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(() => {
	document.body.replaceChildren();
	localStorage.clear();
});
const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")];

describe("Plan & usage", () => {
	it("calls the freemium plan a free trial and offers the site's three plans behind Upgrade", () => {
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Free trial");
		expect(text()).toContain("50.0 GiB company storage included");
		const upgrade = buttons().find((button) => button.textContent === "Upgrade")!;
		expect(upgrade.getAttribute("aria-expanded")).toBe("false");
		const grid = container.querySelector<HTMLElement>(".settings-plan-grid")!;
		expect(grid.hidden).toBe(true);
		upgrade.click();
		expect(grid.hidden).toBe(false);
		expect(upgrade.getAttribute("aria-expanded")).toBe("true");
		expect([...grid.querySelectorAll("h3")].map((h3) => h3.textContent)).toEqual([
			"Basis",
			"Standard",
			"Dedicated computer",
		]);
		expect([...grid.querySelectorAll(".settings-plan-price strong")].map((price) => price.textContent)).toEqual([
			"185 kr",
			"630 kr",
			"1,592 kr",
		]);
		expect(text()).toContain("About 37% off usage");
		// Plan changes are not open yet: every card's button is disabled and says so.
		for (const button of grid.querySelectorAll("button")) {
			expect(button.disabled).toBe(true);
			expect(button.textContent).toBe("Coming soon");
		}
		expect(text()).toContain("Every plan starts with a free trial, no card needed. Prices are ex. VAT.");
		// A re-render (storage arriving) keeps the plans open.
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		expect(container.querySelector<HTMLElement>(".settings-plan-grid")!.hidden).toBe(false);
	});

	it("shows placeholders for computer hours and billing until the cloud reports them", () => {
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		const hours = container.querySelector(".settings-hours")!;
		expect(hours.querySelector("strong")?.textContent).toBe("Not measured yet");
		expect(hours.textContent).toContain("Included in your free trial");
		expect(hours.querySelector("progress")).toBeNull();
		expect(text()).toContain("Choose a company to see its storage.");
		const rows = [...container.querySelectorAll(".billing-row")].map((row) => row.textContent);
		expect(rows[0]).toBe("PriceFree");
		expect(rows[1]).toBe("Next paymentNone during your free trial");
		expect(rows[2]).toContain("Payment methodNo card on file");
		expect(rows[3]).toBe("InvoicesNo invoices yet");
		const addCard = buttons().find((button) => button.textContent === "Add card")!;
		expect(addCard.disabled).toBe(true);
	});

	it("fills the meters and billing rows from the figures a paid plan will report", () => {
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{ companyName: "Company A", file: { ...file, storageUsedBytes: 1024 ** 3 }, loading: false, retry() {} },
			{
				computerHours: { used: 20, periodEnd: "2026-10-01T00:00:00Z" },
				nextPaymentAt: "2026-10-01T00:00:00Z",
				paymentMethod: "Visa ending 4242",
				invoices: [{ id: "inv-1", issuedAt: "2026-09-01T00:00:00Z", totalKr: 185, href: "#/invoice/inv-1" }],
			},
		);
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Basis");
		expect(buttons().find((button) => button.textContent === "Change plan")).toBeDefined();
		const hours = container.querySelector(".settings-hours")!;
		expect(hours.querySelector("strong")?.textContent).toBe("20 h used of 74 h");
		expect(hours.querySelector("small:not(.settings-eyebrow)")?.textContent).toBe("74 h a month with Basis");
		expect(hours.querySelector("progress")?.getAttribute("value")).toBe("20");
		expect(hours.querySelector("progress")?.getAttribute("max")).toBe("74");
		expect(hours.textContent).toContain("Resets ");
		const storage = container.querySelectorAll(".settings-usage")[1]!;
		expect(storage.querySelector("strong")?.textContent).toMatch(/^1\.0 GiB used of /);
		expect(storage.querySelector("progress")).not.toBeNull();
		const rows = [...container.querySelectorAll(".billing-row")].map((row) => row.textContent);
		expect(rows[0]).toBe("Price185 kr/month · ex. VAT");
		expect(rows[2]).toContain("Visa ending 4242");
		expect(container.querySelector(".settings-invoices a")?.getAttribute("href")).toBe("#/invoice/inv-1");
		expect(rows[3]).toContain("185 kr");
		const current = container.querySelector('[data-plan="basis"]')!;
		expect(current.querySelector(".settings-plan-current")?.textContent).toBe("Current plan");
		expect(current.querySelector("button")?.textContent).toBe("Current plan");
		expect(container.querySelector('[data-plan="dedicated"] .settings-plan-includes')?.textContent).toContain(
			"A dedicated computer all month",
		);
	});

	it("names known plans and keeps unknown keys readable", () => {
		expect(planName("freemium")).toBe("Free trial");
		expect(planName("dedicated")).toBe("Dedicated computer");
		expect(planName("some_new_plan")).toBe("some new plan");
		expect(PLAN_OFFERS.map((offer) => offer.includedHours)).toEqual([74, 286, undefined]);
	});
});
