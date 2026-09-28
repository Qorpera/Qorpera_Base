// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanPaymentsState } from "../src/app/plan-payments.ts";
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
		expect(hours.querySelector("strong")?.textContent).toBe("Counted once plans open");
		expect(hours.textContent).toContain("Included in your free trial");
		expect(hours.querySelector("progress")).toBeNull();
		expect(text()).toContain("Open a company to see its storage.");
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
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("Counted once plans open");
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

	it("shows the open company's measured computer hours this month and what they were used on", () => {
		const hours = {
			profileId: "00000000-0000-4000-8000-000000000001",
			month: "2026-09",
			timeZone: "Europe/Copenhagen",
			usedSeconds: 149_400,
			byKind: { companyMachines: 79_200, agentMachines: 179, codingMachines: 10_800, runs: 52_200 },
			awakeNow: { companyMachines: 1, agentMachines: 0, codingMachines: 0, runs: 2 },
			meteredUntil: "2026-09-28T18:00:00Z",
		};
		const usage = { companyName: "Company A", file, loading: false, retry() {} };
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{ ...usage, hours: { value: hours, loading: false } },
		);
		const card = container.querySelector(".settings-company-hours")!;
		expect(card.querySelector(".settings-eyebrow")?.textContent).toBe("Computer hours this month");
		expect(card.querySelector("strong")?.textContent).toBe("41.5 h used");
		expect(card.textContent).toContain("Company A · Measured, not charged yet");
		// Under three minutes of agents' machines would read "0 h": left out.
		expect(card.querySelector(".settings-hours-kinds")?.textContent).toBe(
			"Company machines 22 h · Agent runs 14.5 h · Coding machines 3 h",
		);
		// The plan's own allowance is a separate card, still waiting for plans.
		expect(container.querySelector(".settings-hours .settings-eyebrow")?.textContent).toBe(
			"Computer hours in your plan",
		);
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{ ...usage, hours: { loading: true } },
		);
		expect(container.querySelector(".settings-company-hours strong")?.textContent).toBe("Loading…");
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{ ...usage, hours: { loading: false, missing: true } },
		);
		expect(container.querySelector(".settings-company-hours strong")?.textContent).toBe("Not measured yet");
		expect(container.querySelector(".settings-company-hours .settings-hours-kinds")).toBeNull();
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{ ...usage, hours: { loading: false, failed: true } },
		);
		expect(container.querySelector(".settings-company-hours strong")?.textContent).toBe("Computer hours unavailable");
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined);
		expect(container.querySelector(".settings-company-hours")).toBeNull();
	});

	it("sells Basis as computer hours, not a computer per agent", () => {
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined);
		const basis = container.querySelector('[data-plan="basis"] .settings-plan-includes')!;
		expect([...basis.querySelectorAll("li")].map((li) => li.textContent)[1]).toBe("74 computer hours a month");
		expect(PLAN_OFFERS.flatMap((offer) => offer.includes).join(" ")).not.toContain("worker computer");
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
		renderPlan(
			container,
			{ loaded: true, entitlement: entitlement("basis") },
			{
				companyName: "Company A",
				file,
				loading: false,
				retry() {},
				hours: {
					loading: false,
					value: {
						profileId: "00000000-0000-4000-8000-000000000001",
						month: "2026-09",
						timeZone: "Europe/Copenhagen",
						usedSeconds: 149_400,
						byKind: { companyMachines: 0, agentMachines: 0, codingMachines: 0, runs: 149_400 },
						awakeNow: { companyMachines: 0, agentMachines: 0, codingMachines: 0, runs: 0 },
						meteredUntil: "2026-09-28T18:00:00Z",
					},
				},
			},
		);
		const card = container.querySelector(".settings-company-hours")!;
		expect(card.querySelector("strong")?.textContent).toBe("41,5 t brugt");
		expect(card.textContent).toContain("Company A · Målt, endnu ikke opkrævet");
		expect(card.querySelector(".settings-hours-kinds")?.textContent).toBe("Agentkørsler 41,5 t");
	});
});

describe("Plan & usage with payments", () => {
	const P = "00000000-0000-4000-8000-000000000001";
	const Q = "00000000-0000-4000-8000-000000000002";
	const offer = (itemKey: string, kind: "plan" | "credits", priceMinor: number, hours: number, available = true) => ({
		itemKey,
		kind,
		name: itemKey,
		priceMinor,
		currency: "dkk" as const,
		hours,
		available,
	});
	const OFFERS = [
		offer("basis", "plan", 18_500, 74),
		offer("standard", "plan", 63_000, 286),
		offer("hours_20", "credits", 7_000, 20),
		offer("hours_100", "credits", 35_000, 100),
		offer("hours_500", "credits", 175_000, 500, false),
	];
	const hours = {
		profileId: P,
		month: "2026-09",
		timeZone: "Europe/Copenhagen",
		usedSeconds: 7_200,
		byKind: { companyMachines: 7_200, agentMachines: 0, codingMachines: 0, runs: 0 },
		awakeNow: { companyMachines: 0, agentMachines: 0, codingMachines: 0, runs: 0 },
		meteredUntil: "2026-09-28T18:00:00Z",
	};
	const usage = (founder?: boolean) => ({
		companyName: "Company A",
		file,
		loading: false,
		retry() {},
		hours: { value: hours, loading: false },
		profileId: P,
		founder,
	});
	function payments(state: Partial<PlanPaymentsState> = {}) {
		const calls: string[] = [];
		return {
			calls,
			view: {
				state: { offers: OFFERS, loaded: true, ...state } as PlanPaymentsState,
				checkout: (itemKey: string, profileId?: string) => calls.push(`checkout ${itemKey} ${profileId ?? "-"}`),
				portal: () => calls.push("portal"),
				companyName: (profileId: string) => (profileId === P ? "Company A" : undefined),
			},
		};
	}

	it("sells the open plans through Stripe's checkout and keeps Dedicated coming soon", () => {
		const { calls, view } = payments({ plan: { mode: "dry_run", plan: null, hours: null } });
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, { payments: view });
		buttons()
			.find((button) => button.textContent === "Upgrade")!
			.click();
		const grid = container.querySelector<HTMLElement>(".settings-plan-grid")!;
		expect([...grid.querySelectorAll("button")].map((button) => [button.textContent, button.disabled])).toEqual([
			["Choose Basis", false],
			["Choose Standard", false],
			["Coming soon", true],
		]);
		grid.querySelector<HTMLButtonElement>("button")!.click();
		expect(calls).toEqual(["checkout basis -"]);
		expect(container.querySelector(".settings-group .settings-help")?.textContent).toBe(
			"Prices are ex. VAT. You pay on Stripe's secure page. Test mode: nothing is charged.",
		);
		// While a Stripe page opens, every buy button waits.
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, {
			payments: payments({ opening: "basis" }).view,
		});
		expect(
			[...container.querySelectorAll(".settings-plan-grid button")].map((button) => [
				button.textContent,
				(button as HTMLButtonElement).disabled,
			]),
		).toEqual([
			["Opening…", true],
			["Choose Standard", true],
			["Coming soon", true],
		]);
		// Nothing for sale: the page reads as before payments.
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, {
			payments: payments({ offers: OFFERS.map((item) => ({ ...item, available: false })) }).view,
		});
		expect(
			[...container.querySelectorAll(".settings-plan-grid button")].every(
				(button) => button.textContent === "Coming soon",
			),
		).toBe(true);
		expect(text()).toContain("Plan changes are not open yet.");
		expect(buttons().find((button) => button.textContent === "Payments and invoices")).toBeUndefined();
	});

	it("shows a paid plan, its hours per company, and Stripe's billing page", () => {
		const { calls, view } = payments({
			plan: {
				mode: "live",
				plan: {
					itemKey: "standard",
					status: "active",
					periodStart: "2026-09-10T00:00:00Z",
					periodEnd: "2026-10-10T00:00:00Z",
					cancelAtPeriodEnd: false,
				},
				hours: {
					grantedSeconds: 286 * 3600,
					companies: [
						{ profileId: P, seconds: 36_000 },
						{ profileId: Q, seconds: 1_800 },
					],
				},
			},
		});
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, { payments: view });
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Standard");
		expect(container.querySelector(".settings-plan small:not(.settings-eyebrow)")?.textContent).toBe(
			"Renews 10 Oct 2026",
		);
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("10.5 h used of 286 h");
		expect(container.querySelector(".settings-hours .settings-hours-kinds")?.textContent).toBe(
			"Company A 10 h · Other companies 0.5 h",
		);
		expect(container.querySelector(".settings-period")?.textContent).toBe("Resets 10 Oct 2026");
		expect(text()).toContain("630 kr/month · ex. VAT");
		expect(text()).toContain("Next payment10 Oct 2026");
		expect(text()).toContain("Payment methodOn Stripe's billing page");
		buttons()
			.find((button) => button.textContent === "Payments and invoices")!
			.click();
		// Switching plans happens on Stripe's billing page too.
		buttons()
			.find((button) => button.textContent === "Change plan")!
			.click();
		const grid = container.querySelector<HTMLElement>(".settings-plan-grid")!;
		expect([...grid.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			"Switch to Basis",
			"Current plan",
			"Coming soon",
		]);
		grid.querySelector<HTMLButtonElement>("button")!.click();
		expect(calls).toEqual(["portal", "portal"]);

		const ending = payments({
			plan: {
				...view.state.plan!,
				plan: { itemKey: "basis", status: "active", periodEnd: "2026-10-10T00:00:00Z", cancelAtPeriodEnd: true },
			},
		}).view;
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, { payments: ending });
		expect(container.querySelector(".settings-plan small:not(.settings-eyebrow)")?.textContent).toBe(
			"Ends 10 Oct 2026",
		);
		expect(text()).toContain("Next paymentNone scheduled");
		const failed = payments({
			plan: {
				...view.state.plan!,
				plan: { itemKey: "basis", status: "past_due", cancelAtPeriodEnd: false },
			},
		}).view;
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, { payments: failed });
		expect(container.querySelector(".settings-plan small:not(.settings-eyebrow)")?.textContent).toBe(
			"Payment failed. Update your card under Payments and invoices.",
		);
		// Before live payments a (test) plan shows no hours: members see only measured hours.
		const testing = payments({ plan: { ...view.state.plan!, mode: "dry_run", hours: null } }).view;
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, { payments: testing });
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Standard");
		expect(container.querySelector(".settings-plan")?.textContent).toContain("Test mode: nothing is charged.");
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("Counted once plans open");
		expect(container.querySelector(".settings-hours .settings-hours-kinds")).toBeNull();
	});

	it("lets founders buy hours for the company, and tells everyone else they are never charged", () => {
		const { calls, view } = payments();
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, usage(true), { payments: view });
		const card = container.querySelector<HTMLElement>(".settings-company-hours")!;
		const buy = [...card.querySelectorAll("button")].find((button) => button.textContent === "Buy hours")!;
		const packs = card.querySelector<HTMLElement>(".settings-hours-packs")!;
		expect(packs.hidden).toBe(true);
		buy.click();
		expect(packs.hidden).toBe(false);
		expect(buy.getAttribute("aria-expanded")).toBe("true");
		// The 500-hour pack is not for sale here.
		expect([...packs.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			"20 h · 70 kr",
			"100 h · 350 kr",
		]);
		expect(packs.textContent).toContain("For Company A, valid for 12 months. Prices are ex. VAT.");
		packs.querySelector<HTMLButtonElement>("button")!.click();
		expect(calls).toEqual([`checkout hours_20 ${P}`]);
		// The list stays open across a re-render.
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, usage(true), { payments: view });
		expect(container.querySelector<HTMLElement>(".settings-hours-packs")?.hidden).toBe(false);

		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, usage(false), { payments: view });
		expect(container.querySelector(".settings-hours-packs")).toBeNull();
		expect(container.querySelector(".settings-company-hours")?.textContent).toContain(
			"Computer hours are paid by the founders. You are never charged.",
		);
		// Role not known yet: neither.
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, usage(undefined), { payments: view });
		expect(container.querySelector(".settings-hours-packs")).toBeNull();
		expect(text()).not.toContain("paid by the founders");
	});

	it("shows the cloud catalog's prices and hours, which are what Stripe charges", () => {
		const catalog = payments({
			offers: [offer("basis", "plan", 19_900, 80), offer("standard", "plan", 63_000, 286, false)],
		}).view;
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined, { payments: catalog });
		expect(container.querySelector('[data-plan="basis"] .settings-plan-price strong')?.textContent).toBe("199 kr");
		expect(container.querySelector('[data-plan="basis"] .settings-plan-includes')?.textContent).toContain(
			"80 computer hours a month",
		);
		expect(text()).toContain("199 kr/month · ex. VAT");
		expect(container.querySelector(".settings-hours small:not(.settings-eyebrow)")?.textContent).toBe(
			"80 h a month with Basis",
		);
		// Without the catalog (a cloud before payments), the prices qorpera.com shows.
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined);
		expect(container.querySelector('[data-plan="basis"] .settings-plan-price strong')?.textContent).toBe("185 kr");
	});

	it("reads a paused plan, a plan without hours yet, and small uses honestly", () => {
		const live = (plan: object, hours: object) =>
			payments({ plan: { mode: "live", plan: { cancelAtPeriodEnd: false, ...plan }, hours } as never }).view;
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, {
			payments: live(
				{ itemKey: "basis", status: "paused", periodEnd: "2026-10-10T00:00:00Z" },
				{
					grantedSeconds: 0,
					companies: [],
				},
			),
		});
		expect(container.querySelector(".settings-plan small:not(.settings-eyebrow)")?.textContent).toBe("Paused");
		// No hours granted yet: no total, no meter.
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("0 h used");
		expect(container.querySelector(".settings-hours progress")).toBeNull();
		renderPlan(container, { loaded: true, entitlement: entitlement("freemium") }, undefined, {
			payments: live(
				{ itemKey: "basis", status: "active", periodEnd: "2026-10-10T00:00:00Z" },
				{
					grantedSeconds: 74 * 3600,
					companies: [
						{ profileId: P, seconds: 120 },
						{ profileId: Q, seconds: 100 },
					],
				},
			),
		});
		// A few seconds would read "0 h": they are summed with the unnamed ones instead.
		expect(container.querySelector(".settings-hours .settings-hours-kinds")?.textContent).toBe(
			"Other companies 0.1 h",
		);
	});

	it("marks test purchases, and says calmly that there are no payments yet", () => {
		const testing = payments({ plan: { mode: "dry_run", plan: null, hours: null }, info: "No payments yet." }).view;
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, usage(true), { payments: testing });
		expect(container.querySelector(".settings-hours-packs")?.textContent).toContain("Test mode: nothing is charged.");
		expect(container.querySelector(".notice-neutral")?.textContent).toBe("No payments yet.");
		expect(container.querySelector(".notice-danger")).toBeNull();
	});

	it("thanks the member back from Stripe and shows a refusal", () => {
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined, {
			payments: payments({ returned: "done" }).view,
		});
		expect(container.querySelector(".notice-ok")?.textContent).toBe(
			"Thank you. Your hours are added as soon as Stripe confirms the payment.",
		);
		renderPlan(container, { loaded: true, entitlement: entitlement("basis") }, undefined, {
			payments: payments({ error: "Only the company's founders can buy computer hours." }).view,
		});
		expect(container.querySelector(".notice-danger")?.textContent).toBe(
			"Only the company's founders can buy computer hours.",
		);
	});
});
