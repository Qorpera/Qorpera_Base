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
		const help = () => container.querySelector<HTMLElement>(".settings-group .settings-help")!;
		expect(help().textContent).toBe(
			"Plan changes are not open yet. Every plan starts with a free trial, no card needed. Prices are ex. VAT.",
		);
		expect(help().hidden).toBe(false);
		expect(upgrade.getAttribute("aria-controls")).toBe(grid.id);
		// A re-render (storage arriving) keeps the plans open and the focus where it was.
		upgrade.focus();
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		expect(container.querySelector<HTMLElement>(".settings-plan-grid")!.hidden).toBe(false);
		expect(help().hidden).toBe(false);
		expect(document.activeElement?.textContent).toBe("Upgrade");
		buttons()
			.find((button) => button.textContent === "Upgrade")!
			.click();
		expect(container.querySelector<HTMLElement>(".settings-plan-grid")!.hidden).toBe(true);
		expect(help().hidden).toBe(true);
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
		const addCard = container.querySelectorAll(".billing-row")[2]!.querySelector("button")!;
		expect(addCard.textContent).toBe("Coming soon");
		expect(addCard.disabled).toBe(true);
		// A paid plan without a measurement gets no bar either: an empty bar reads as zero use.
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined);
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("Not measured yet");
		expect(container.querySelector(".settings-hours small:not(.settings-eyebrow)")?.textContent).toBe(
			"74 h a month with Basis",
		);
		expect(container.querySelector(".settings-hours progress")).toBeNull();
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
		expect(hours.textContent).toContain("Resets 1 Oct 2026");
		const storage = container.querySelectorAll(".settings-usage")[1]!;
		expect(storage.querySelector("strong")?.textContent).toMatch(/^1\.0 GiB used of /);
		expect(storage.querySelector("progress")).not.toBeNull();
		const rows = [...container.querySelectorAll(".billing-row")].map((row) => row.textContent);
		expect(rows[0]).toBe("Price185 kr/month · ex. VAT");
		expect(rows[2]).toContain("Visa ending 4242");
		expect(container.querySelector(".settings-invoices a")?.getAttribute("href")).toBe("#/invoice/inv-1");
		expect(rows[3]).toContain("1 Sept 2026 · 185 kr");
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

	it("gives every rendered panel its own grid id, as the account page and the dialog can both show one", () => {
		const other = document.createElement("div");
		document.body.append(other);
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		renderPlan(other, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		const ids = [container, other].map((panel) => panel.querySelector(".settings-plan-grid")!.id);
		expect(ids[0]).not.toBe(ids[1]);
		expect(document.querySelectorAll(`#${ids[0]}`)).toHaveLength(1);
		expect(other.querySelector("[aria-controls]")?.getAttribute("aria-controls")).toBe(ids[1]);
	});

	it("reads billing dates as calendar days whatever the machine's time zone", () => {
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined, {
			computerHours: { used: 1, periodEnd: "2026-10-01T00:00:00Z" },
			nextPaymentAt: "2026-10-01T00:00:00Z",
			invoices: [{ id: "inv-1", issuedAt: "2026-09-01T00:00:00Z", totalKr: 185 }],
		});
		expect(container.querySelector(".settings-period")?.textContent).toBe("Resets 1 Oct 2026");
		const rows = [...container.querySelectorAll(".billing-row")].map((row) => row.textContent);
		expect(rows[1]).toBe("Next payment1 Oct 2026");
		expect(rows[3]).toBe("Invoices1 Sept 2026 · 185 kr");
	});

	it("translates the plan card itself", () => {
		localStorage.setItem("qorpera.web.language", "da");
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		expect(container.querySelector(".settings-plan .settings-copy")?.textContent).toBe(
			"Nuværende abonnementGratis prøveperiode50.0 GiB virksomhedslager inkluderet",
		);
		renderPlan(container, { loaded: true }, undefined);
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Abonnement ikke tilgængeligt");
		renderPlan(container, {}, undefined);
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Henter…");
	});

	it("leaves the account error to the general panel on the standalone account page", () => {
		renderPlan(container, { loaded: true, error: "Entitlement offline" }, undefined, {}, { showError: false });
		expect(container.querySelector(".notice")).toBeNull();
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Plan unavailable");
		renderPlan(container, { loaded: true, error: "Entitlement offline" }, undefined);
		expect(container.querySelector(".notice")?.textContent).toContain("Entitlement offline");
	});

	it("writes hours, storage and dates in Danish when the interface is Danish", () => {
		localStorage.setItem("qorpera.web.language", "da");
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{ companyName: "Company A", file: { ...file, storageUsedBytes: 1024 ** 3 }, loading: false, retry() {} },
			{ computerHours: { used: 20.25, periodEnd: "2026-10-01T00:00:00Z" } },
		);
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("20,3 t brugt af 74 t");
		expect(container.querySelector(".settings-hours small:not(.settings-eyebrow)")?.textContent).toBe(
			"74 t om måneden med Basis",
		);
		expect(container.querySelector(".settings-period")?.textContent).toBe("Nulstilles 1. okt. 2026");
		expect(container.querySelectorAll(".settings-usage")[1]?.querySelector("strong")?.textContent).toMatch(
			/^1\.0 GiB brugt af /,
		);
		expect(container.querySelector(".settings-plan-discount")?.textContent).toBe("Ca. 37% rabat på forbrug");
	});
});
