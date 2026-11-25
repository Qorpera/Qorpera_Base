// @vitest-environment jsdom
import type { SurfaceSummary } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceLayoutView } from "../src/app/views/surface-layout-view.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fakeClient, storeWith, summary } from "./surface-fixtures.ts";

const ROOT = "surfaces/strategy";

afterEach(() => {
	setLanguagePreference("en");
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function strategySurface(): SurfaceSummary {
	return summary({
		id: "22222222-2222-4222-8222-222222222250",
		slug: "strategy",
		title: "Strategy",
		archetype: "studio",
		kind: "strategy",
		icon: "figure:lighthouse",
		sourceKind: "folder",
		repositoryKey: null,
		folderRoot: ROOT,
		siteSlug: null,
		previewMode: "studio_overlay",
		liveUrl: null,
	});
}

type Ask = (prompt: string, title?: string) => Promise<void>;

function layoutInput(files: Readonly<Record<string, string>>, tab: string) {
	return {
		surface: strategySurface(),
		files,
		baseFiles: files,
		binaries: {},
		baseBinaries: {},
		company: undefined,
		briefSummary: "",
		starter: "strategy" as const,
		tab,
		legacyModel: undefined,
		htmlPages: { frame: () => document.createElement("div"), linksChanged: () => false },
	};
}

function layoutView(files: Readonly<Record<string, string>>, askSurface?: Ask) {
	const store = storeWith(fakeClient());
	const view = new SurfaceLayoutView({
		store,
		surface: strategySurface(),
		signal: new AbortController().signal,
		baseFiles: () => files,
		timeSlice: false,
		...(askSurface ? { askSurface } : {}),
	});
	const done = () => {
		view.dispose();
		store.dispose();
	};
	return { view, done };
}

function draw(files: Readonly<Record<string, string>>, tab: string, askSurface?: Ask) {
	const { view, done } = layoutView(files, askSurface);
	const plan = view.plan(layoutInput(files, tab));
	const root = document.createElement("div");
	if (plan.tabBar) root.append(plan.tabBar);
	root.append(...plan.tasks.map((task) => task.build()));
	document.body.append(root);
	return { root, done };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const texts = (els: Iterable<Element>) => [...els].map(text);
const file = (name: string, value: unknown) => ({ [`${ROOT}/${name}`]: JSON.stringify(value) });
const hover = (el: Element, kind: "mouseenter" | "mouseleave") => el.dispatchEvent(new MouseEvent(kind));
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

const PLAYS = {
	verdict: "Sell to dealers, not drivers.",
	summary: "Drivers will not pay; dealers already budget for leads.",
	plays: [
		{
			id: "drivers",
			name: "Driver subscription",
			thesis: "Drivers pay monthly for maintenance reminders.",
			status: "rejected",
			killRisk: "Drivers churn after the first free month.",
			cons: ["No budget"],
		},
		{
			id: "dealers",
			name: "Dealer lead engine",
			thesis: "Dealers pay per qualified service booking.",
			status: "recommended",
			whoPays: "Dealers",
			revenueModel: "Per booking",
			unitMargin: "62%",
			capacityCeiling: "40 dealers per ops hire",
			moat: "Booking data",
			killRisk: "Dealers build it in-house.",
			nextMove: "Sign three pilot dealers.",
			pros: ["Existing budget"],
			cons: ["Long sales cycle"],
			tier: "benchmark",
			source: "Dealer interviews",
		},
		{ id: "fleet", name: "Fleet software", thesis: "Fleets license the tool.", status: "exploring" },
	],
};

const ECONOMICS = {
	title: "Dealer lead engine",
	subtitle: "Monthly contribution per market",
	currency: "DKK",
	period: "month",
	verdict: "Break-even at fifty dealers, inside today's team.",
	inputs: [
		{
			id: "customers",
			label: "Dealers",
			group: "Demand",
			value: 50,
			min: 0,
			max: 120,
			step: 1,
			tier: "hypothesis",
		},
		{
			id: "price",
			label: "Price per dealer",
			group: "Pricing",
			unit: "DKK",
			value: 1000,
			min: 200,
			max: 3000,
			step: 5,
			tier: "benchmark",
			source: "Rival pricing scan",
			marks: [{ value: 1495, label: "Rival Pro" }],
		},
		{
			id: "hours_per_customer",
			label: "Hours per dealer",
			group: "Delivery",
			unit: "h",
			value: 1.5,
			min: 0.25,
			max: 4,
			step: 0.25,
			tier: "hypothesis",
			note: "Onboarding plus monthly review.",
		},
		{
			id: "hourly_cost",
			label: "Hourly cost",
			group: "Delivery",
			unit: "DKK",
			value: 400,
			min: 200,
			max: 900,
			tier: "verified",
			source: "Payroll 2026",
		},
		{
			id: "fixed_costs",
			label: "Fixed costs",
			group: "Delivery",
			unit: "DKK",
			value: 20000,
			min: 5000,
			max: 50000,
			tier: "verified",
		},
		{
			id: "capacity_hours",
			label: "Team capacity",
			group: "Delivery",
			unit: "h",
			value: 90,
			min: 40,
			max: 200,
			tier: "verified",
		},
	],
	computed: [
		{ id: "revenue", expr: "customers * price", unit: "DKK" },
		{ id: "work_hours", expr: "customers * hours_per_customer", unit: "h" },
		{ id: "labor_cost", expr: "work_hours * hourly_cost", unit: "DKK" },
		{ id: "contribution", expr: "revenue - labor_cost - fixed_costs", unit: "DKK" },
	],
	headlines: [
		{ id: "work_hours", label: "Team hours", format: "hours" },
		{
			id: "contribution",
			label: "Contribution",
			format: "currency",
			emphasis: "primary",
			toneWhenNegative: "danger",
		},
	],
	waterfall: [
		{ id: "revenue", label: "Revenue", kind: "income" },
		{ id: "labor_cost", label: "Delivery", kind: "cost" },
		{ id: "fixed_costs", label: "Fixed", kind: "cost" },
		{ id: "contribution", label: "Contribution", kind: "total" },
	],
	curve: {
		xInput: "customers",
		yOutput: "contribution",
		xMin: 0,
		xMax: 120,
		steps: 24,
		capacityExpr: "capacity_hours / hours_per_customer",
		capacityLabel: "Team capacity",
	},
	constraints: [
		{
			id: "capacity",
			label: "Capacity ceiling",
			expr: "work_hours > capacity_hours",
			severity: "fatal",
			message: "The team runs out of hours before the month ends.",
		},
		{
			id: "loss",
			label: "Losing money",
			expr: "contribution < 0",
			severity: "warning",
			message: "Each month burns cash.",
		},
	],
	scenarios: [
		{
			id: "premium",
			name: "Premium",
			thesis: "Fewer dealers at the rival's price.",
			values: { price: 1495, customers: 30 },
		},
	],
};

const HYPOTHESES = {
	summary: "Four bets carry the plan.",
	hypotheses: [
		{ id: "h1", bet: "Dealers pay before seeing results.", impact: "high", status: "testing", tier: "hypothesis" },
		{
			id: "h2",
			bet: "Dealers lack an in-house booking tool.",
			impact: "fatal",
			status: "untested",
			tier: "benchmark",
			cheapestTest: "Call ten dealers this week.",
			killCriteria: "Four of ten already run one.",
			evidence: "Two dealer calls",
			owner: "Founder",
		},
		{ id: "h3", bet: "Onboarding takes under two hours.", impact: "medium", status: "proven", tier: "verified" },
		{ id: "h4", bet: "Ads reach dealers below 400 DKK a lead.", impact: "high", status: "untested" },
	],
};

const LANDSCAPE = {
	wedge: "Bookings, not leads.",
	summary: "Incumbents sell leads; nobody sells booked service.",
	axes: { xLabel: "Price", yLabel: "Depth", xLow: "Cheap", xHigh: "Premium", yLow: "Leads", yHigh: "Bookings" },
	players: [
		{ id: "us", name: "Qorpera Auto", isUs: true, x: 55, y: 85, ourEdge: "Booked, not promised" },
		{
			id: "leadly",
			name: "Leadly",
			url: "https://leadly.example",
			category: "Incumbent",
			positioning: "Lead lists for every dealer",
			pricing: "1,495 DKK / month",
			strength: "Brand",
			weakness: "Lead quality",
			ourEdge: "We charge per booking",
			tier: "benchmark",
			source: "Leadly pricing page",
			x: 80,
			y: 30,
		},
		{ id: "sheet", name: "Spreadsheets", url: "javascript:alert(1)", category: "Substitute", x: 10, y: 10 },
		{ id: "agency", name: "Local agency", positioning: "Full service" },
	],
};

function strategyFiles(): Record<string, string> {
	return {
		...file("plan.json", { title: "Win the dealer market", thesis: "Dealers pay for booked service." }),
		...file("plays.json", PLAYS),
		...file("economics.json", ECONOMICS),
		...file("hypotheses.json", HYPOTHESES),
		...file("landscape.json", LANDSCAPE),
	};
}

const STRATEGY_TABS: readonly (readonly [string, string])[] = [
	["economics", "economics"],
	["market", "landscape"],
	["hypotheses", "hypotheses"],
];

describe("The strategy starter on the layout renderer", () => {
	it("draws the tabs and every strategy block's empty home, with an ask in each", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const plan = draw({}, "plan", ask);
		const tabs = texts(plan.root.querySelectorAll(".studio-tab"));
		expect(tabs).toEqual(["Grand plan", "Economics", "Market", "Hypotheses", "Breakdowns", "Deep dives"]);
		const empty = [...plan.root.querySelectorAll<HTMLElement>(".studio-tab.is-empty")];
		expect(empty.map((tab) => tab.dataset.tab)).toEqual([
			"economics",
			"market",
			"hypotheses",
			"breakdowns",
			"reports",
		]);
		const plays = plan.root.querySelector('[data-block="plays"]')!;
		expect(text(plays.querySelector(".studio-section-head h2"))).toBe("Competing plays");
		expect(text(plays.querySelector(".studio-strategy-empty.is-plays strong"))).toBe("No plays on the board yet");
		plays.querySelector<HTMLButtonElement>(".studio-ask-btn")!.click();
		expect(ask).toHaveBeenCalledWith(expect.stringContaining("competing plays"), "Draft competing plays");
		plan.done();

		for (const [tab, kind] of STRATEGY_TABS) {
			const drawn = draw({}, tab, ask);
			const block = drawn.root.querySelector(`[data-block="${kind}"]`)!;
			expect(block.querySelector(`.studio-strategy-empty.is-${kind}`)).not.toBeNull();
			expect(block.querySelector(".studio-ask-btn")).not.toBeNull();
			drawn.done();
		}

		const quiet = draw({}, "economics");
		expect(quiet.root.querySelector(".studio-ask-btn")).toBeNull();
		quiet.done();
	});

	it("fills every tab from the folder and speaks Danish in the starter's words", () => {
		const files = strategyFiles();
		const filled = draw(files, "plan");
		const empty = [...filled.root.querySelectorAll<HTMLElement>(".studio-tab.is-empty")];
		expect(empty.map((tab) => tab.dataset.tab)).toEqual(["breakdowns", "reports"]);
		expect(filled.root.querySelector('[data-block="plays"] .studio-plays-grid')).not.toBeNull();
		filled.done();
		for (const [tab, kind] of STRATEGY_TABS) {
			const drawn = draw(files, tab);
			expect(drawn.root.querySelector(`[data-block="${kind}"]`)).not.toBeNull();
			expect(drawn.root.querySelector(".studio-strategy-empty")).toBeNull();
			drawn.done();
		}

		setLanguagePreference("da");
		const danish = draw({}, "plan");
		const tabs = texts(danish.root.querySelectorAll(".studio-tab"));
		expect(tabs).toEqual(["Stor plan", "Økonomi", "Marked", "Hypoteser", "Gennemgange", "Dybdegående"]);
		const lead = text(danish.root.querySelector(".studio-strategy-empty strong"));
		expect(lead).toBe("Ingen strategier på bordet endnu");
		danish.done();
		const economy = draw(file("economics.json", ECONOMICS), "economics");
		expect(text(economy.root.querySelector('[data-block="economics"] .studio-section-head h2'))).toBe(
			"Enhedsøkonomi",
		);
		expect(texts(economy.root.querySelectorAll(".studio-econ-view"))).toEqual(["Pengestrøm", "Nulpunkt"]);
		economy.done();
	});
});

describe("The plays block", () => {
	it("keeps each play scannable at rest and opens the details on demand", async () => {
		let release: () => void = () => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ask = vi.fn<Ask>(() => pending);
		const { root, done } = draw(file("plays.json", PLAYS), "plan", ask);
		const block = root.querySelector('[data-block="plays"]')!;
		expect(text(block.querySelector(".studio-plays-verdict"))).toBe("Sell to dealers, not drivers.");
		expect(block.querySelector(".studio-play-facts")).not.toBeNull();
		const names = texts(block.querySelectorAll(".studio-play-name"));
		expect(names).toEqual(["Dealer lead engine", "Fleet software", "Driver subscription"]);

		const lead = block.querySelector<HTMLElement>(".studio-play.is-recommended")!;
		expect(lead.dataset.play).toBe("dealers");
		expect(text(lead.querySelector(".studio-play-status"))).toBe("Recommended");
		expect(lead.querySelector(".studio-tier-mark.is-benchmark")?.getAttribute("title")).toBe(
			"Benchmark · Dealer interviews",
		);
		expect(texts(lead.querySelectorAll(".studio-play-chip-label"))).toEqual([
			"Who pays",
			"Unit margin",
			"Capacity ceiling",
		]);
		expect(texts(lead.querySelectorAll(".studio-play-chip-value"))).toEqual([
			"Dealers",
			"62%",
			"40 dealers per ops hire",
		]);
		expect(text(lead.querySelector(".studio-play-kill-text"))).toBe("Dealers build it in-house.");

		const details = lead.querySelector<HTMLElement>(".studio-play-details")!;
		const more = lead.querySelector<HTMLButtonElement>(".studio-play-more")!;
		expect(details.hidden).toBe(true);
		expect(more.getAttribute("aria-expanded")).toBe("false");
		expect(block.querySelectorAll(".studio-play-details:not([hidden])")).toHaveLength(0);
		more.click();
		expect(details.hidden).toBe(false);
		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(lead.classList.contains("is-open")).toBe(true);
		expect(texts(details.querySelectorAll(".studio-play-fact dt"))).toEqual(["Revenue model", "Moat"]);
		expect(text(details.querySelector(".studio-play-next p"))).toBe("Sign three pilot dealers.");
		expect(text(details.querySelector(".studio-play-list.is-pros li"))).toBe("Existing budget");
		expect(text(details.querySelector(".studio-play-list.is-cons li"))).toBe("Long sales cycle");
		expect(text(details.querySelector(".studio-play-source"))).toBe("Source Dealer interviews");

		const fleet = block.querySelector('.studio-play[data-play="fleet"]')!;
		expect(fleet.querySelector(".studio-play-chips")).toBeNull();
		expect(fleet.querySelector(".studio-play-kill")).toBeNull();
		expect(block.querySelector(".studio-play.is-rejected .studio-play-kill")).not.toBeNull();

		const stress = details.querySelector<HTMLButtonElement>(".studio-ask-btn")!;
		expect(text(stress)).toBe("Stress-test");
		stress.click();
		stress.click();
		expect(ask).toHaveBeenCalledTimes(1);
		const [prompt, title] = ask.mock.calls[0]!;
		expect(prompt).toContain("Dealer lead engine");
		expect(prompt).toContain("Dealers build it in-house.");
		expect(title).toBe("Stress-test Dealer lead engine");
		expect(stress.disabled).toBe(true);
		release();
		await vi.waitFor(() => expect(stress.disabled).toBe(false));

		more.click();
		expect(details.hidden).toBe(true);
		done();
	});

	it("leaves the details toggle out when a play has nothing more to show", () => {
		const { root, done } = draw(file("plays.json", PLAYS), "plan");
		const fleet = root.querySelector('.studio-play[data-play="fleet"]')!;
		expect(fleet.querySelector(".studio-play-more")).toBeNull();
		expect(root.querySelector('.studio-play[data-play="dealers"] .studio-play-more')).not.toBeNull();
		done();
	});
});

function economics(ask?: Ask, doc: unknown = ECONOMICS) {
	const drawn = draw(file("economics.json", doc), "economics", ask);
	const block = drawn.root.querySelector<HTMLElement>('[data-block="economics"]')!;
	const range = (id: string) =>
		block.querySelector<HTMLInputElement>(`.studio-econ-lever[data-input="${id}"] input[type="range"]`)!;
	const slide = (id: string, value: number) => {
		const input = range(id);
		input.value = String(value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const hero = () => text(block.querySelector(".studio-econ-hero-value"));
	const metric = (id: string) => text(block.querySelector(`[data-headline="${id}"] .studio-econ-metric-value`));
	const band = (id: string) => block.querySelector<SVGPathElement>(`.studio-econ-band[data-stream="${id}"]`)!;
	const flag = (id: string) => block.querySelector<HTMLButtonElement>(`.studio-econ-flag[data-constraint="${id}"]`)!;
	return { ...drawn, block, range, slide, hero, metric, band, flag };
}

describe("The economics block", () => {
	it("leads with one hero number, inline metrics, the money river and three levers", () => {
		const { block, hero, metric, done } = economics();
		expect(text(block.querySelector(".studio-econ-title h3"))).toBe("Dealer lead engine");
		expect(texts(block.querySelectorAll(".studio-econ-scenario"))).toEqual(["Base", "Premium"]);
		expect(block.querySelector(".studio-econ-scenario.is-base.is-on")).not.toBeNull();
		expect(block.querySelector<HTMLElement>(".studio-econ-thesis")!.hidden).toBe(true);

		const readout = block.querySelector<HTMLElement>(".studio-econ-readout")!;
		expect(readout.dataset.headline).toBe("contribution");
		expect(text(readout.querySelector(".studio-econ-hero-label"))).toBe("Contribution");
		expect(hero()).toBe("DKK 0");
		expect(text(readout.querySelector(".studio-econ-hero-unit"))).toBe("/ month");
		expect(block.querySelectorAll(".studio-econ-metric")).toHaveLength(1);
		expect(metric("work_hours")).toBe("75 h");
		expect(block.querySelector(".studio-econ-kpi")).toBeNull();
		expect(block.querySelector<HTMLElement>(".studio-econ-holds")!.hidden).toBe(false);
		expect(text(block.querySelector(".studio-econ-holds"))).toBe("All constraints hold");
		expect(block.querySelectorAll(".studio-econ-flag:not([hidden])")).toHaveLength(0);
		expect(block.querySelector<HTMLElement>(".studio-econ-flag-line")!.hidden).toBe(true);
		expect(block.querySelector<HTMLElement>(".studio-econ-verdict")!.hidden).toBe(false);
		expect(text(block.querySelector(".studio-econ-verdict"))).toBe(ECONOMICS.verdict);

		expect(texts(block.querySelectorAll(".studio-econ-view"))).toEqual(["Money flow", "Break-even"]);
		expect(block.querySelector('.studio-econ-view[data-view="flow"]')?.getAttribute("aria-pressed")).toBe("true");
		const flow = block.querySelector(".studio-econ-flow svg.studio-econ-svg.is-flow")!;
		expect(flow.querySelectorAll(".studio-econ-band")).toHaveLength(4);
		expect(flow.querySelectorAll(".studio-econ-band.is-income")).toHaveLength(1);
		expect(flow.querySelectorAll(".studio-econ-band.is-cost")).toHaveLength(2);
		expect(flow.querySelectorAll(".studio-econ-band.is-total")).toHaveLength(1);
		expect(flow.querySelector(".studio-econ-band.is-shortfall")).toBeNull();
		expect(flow.querySelector(".studio-econ-spine")).not.toBeNull();
		for (const path of flow.querySelectorAll(".studio-econ-band"))
			expect(path.getAttribute("d")).toMatch(/^M.* C.* Z$/);
		expect(texts(flow.querySelectorAll(".studio-econ-flow-name"))).toEqual([
			"Revenue",
			"Delivery",
			"Fixed",
			"Contribution",
		]);
		expect(texts(flow.querySelectorAll(".studio-econ-flow-amount"))).toEqual([
			"DKK 50K",
			"DKK 30K · 60%",
			"DKK 20K · 40%",
			"DKK 0 · 0%",
		]);
		expect(block.querySelector(".studio-econ-svg.is-curve")).toBeNull();

		const levers = [...block.querySelectorAll<HTMLElement>(".studio-econ-levers > .studio-econ-lever")];
		expect(levers.map((lever) => lever.dataset.input)).toEqual(["customers", "price", "hours_per_customer"]);
		expect(block.querySelector(".studio-econ-levers .studio-tier")).toBeNull();
		expect(block.querySelector(".studio-econ-levers .studio-econ-note")).toBeNull();
		const price = levers[1]!;
		expect(text(price.querySelector(".studio-econ-lever-value"))).toBe("DKK 1,000");
		expect(price.querySelectorAll(".studio-econ-tick-mark")).toHaveLength(1);
		expect(text(price.querySelector(".studio-econ-mark"))).toBe("Rival Pro DKK 1,495");
		done();
	});

	it("dims every other band and swaps the hero to a stream while it is pointed at", () => {
		const { block, hero, band, done } = economics();
		const flow = block.querySelector(".studio-econ-flow")!;
		hover(band("labor_cost"), "mouseenter");
		expect(flow.classList.contains("is-picking")).toBe(true);
		expect(band("labor_cost").classList.contains("is-on")).toBe(true);
		expect(band("revenue").classList.contains("is-on")).toBe(false);
		expect(
			block.querySelector('.studio-econ-flow-label[data-stream="labor_cost"]')!.classList.contains("is-on"),
		).toBe(true);
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Delivery");
		expect(hero()).toBe("DKK 30K");
		expect(text(block.querySelector(".studio-econ-hero-sub"))).toBe("60% of revenue");
		expect(block.querySelector(".studio-econ-readout.is-peek")).not.toBeNull();
		hover(band("labor_cost"), "mouseleave");
		expect(flow.classList.contains("is-picking")).toBe(false);
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Contribution");
		expect(hero()).toBe("DKK 0");

		click(band("fixed_costs"));
		expect(band("fixed_costs").getAttribute("aria-pressed")).toBe("true");
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Fixed");
		click(band("fixed_costs"));
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Contribution");
		done();
	});

	it("shows a loss as a hatched shortfall and a breach as one pill with one line", () => {
		const { root, block, slide, hero, band, flag, range, done } = economics();
		slide("customers", 70);
		expect(root.querySelector('[data-block="economics"]')).toBe(block);
		expect(hero()).toBe("DKK 8,000");
		expect(block.querySelector(".studio-econ-readout.is-bad")).not.toBeNull();
		expect(flag("capacity").hidden).toBe(false);
		expect(flag("loss").hidden).toBe(true);
		expect(block.querySelector<HTMLElement>(".studio-econ-holds")!.hidden).toBe(true);
		const line = block.querySelector<HTMLElement>(".studio-econ-flag-line")!;
		expect(line.hidden).toBe(false);
		expect(line.classList.contains("is-fatal")).toBe(true);
		expect(text(line)).toBe("Capacity ceiling The team runs out of hours before the month ends.");
		expect(block.querySelectorAll(".studio-econ-flag-line")).toHaveLength(1);
		expect(block.querySelector<HTMLElement>(".studio-econ-verdict")!.hidden).toBe(true);
		flag("capacity").click();
		expect(line.hidden).toBe(true);
		expect(flag("capacity").getAttribute("aria-expanded")).toBe("false");
		flag("capacity").click();
		expect(line.hidden).toBe(false);
		const reset = block.querySelector<HTMLButtonElement>(".studio-econ-reset")!;
		expect(reset.hidden).toBe(false);

		slide("customers", 20);
		expect(hero()).toBe("-DKK 12K");
		expect(flag("capacity").hidden).toBe(true);
		expect(flag("loss").hidden).toBe(false);
		expect(line.hidden).toBe(true);
		flag("loss").click();
		expect(line.hidden).toBe(false);
		expect(text(line)).toBe("Losing money Each month burns cash.");
		const shortfall = band("shortfall");
		expect(shortfall.classList.contains("is-shortfall")).toBe(true);
		expect(shortfall.getAttribute("fill")).toMatch(/^url\(#studio-econ-hatch-\d+\)$/);
		expect(block.querySelector(".studio-econ-band.is-total")).toBeNull();
		expect(text(block.querySelector(".studio-econ-flow-label.is-shortfall .studio-econ-flow-amount"))).toBe(
			"-DKK 12K · 60%",
		);

		reset.click();
		expect(range("customers").value).toBe("50");
		expect(hero()).toBe("DKK 0");
		expect(reset.hidden).toBe(true);
		expect(block.querySelectorAll(".studio-econ-flag:not([hidden])")).toHaveLength(0);
		done();
	});

	it("switches the stage to the break-even curve with its capacity wall", () => {
		const { block, slide, done } = economics();
		const curveButton = block.querySelector<HTMLButtonElement>('.studio-econ-view[data-view="curve"]')!;
		curveButton.click();
		expect(curveButton.getAttribute("aria-pressed")).toBe("true");
		expect(block.querySelector(".studio-econ-flow")).toBeNull();
		const curve = block.querySelector(".studio-econ-svg.is-curve")!;
		expect(curve.querySelector(".studio-econ-line")).not.toBeNull();
		expect(curve.querySelector(".studio-econ-area.is-profit")).not.toBeNull();
		expect(curve.querySelector(".studio-econ-area.is-loss")).not.toBeNull();
		expect(curve.querySelector(".studio-econ-capacity")).not.toBeNull();
		expect(text(curve.querySelector(".studio-econ-capacity-label"))).toBe("Team capacity · 60");
		expect(text(curve.querySelector(".studio-econ-breakeven-label"))).toBe("Break-even 50");
		expect(curve.querySelector(".studio-econ-breakeven-dot")).not.toBeNull();
		expect(curve.querySelector(".studio-econ-breakeven.is-impossible")).toBeNull();
		expect(curve.querySelector(".studio-econ-now")).not.toBeNull();
		expect(text(block.querySelector(".studio-econ-chart-note"))).toBe("Break-even at 50.");

		block.querySelector<HTMLButtonElement>(".studio-econ-assumptions")!.click();
		slide("hours_per_customer", 1.75);
		expect(block.querySelector(".studio-econ-breakeven.is-impossible")).not.toBeNull();
		expect(text(block.querySelector(".studio-econ-chart-note.is-danger"))).toContain("past the capacity ceiling");

		block.querySelector<HTMLButtonElement>('.studio-econ-view[data-view="flow"]')!.click();
		expect(block.querySelector(".studio-econ-flow")).not.toBeNull();
		expect(block.querySelector(".studio-econ-svg.is-curve")).toBeNull();
		done();
	});

	it("keeps secondary inputs and their sources in a closed Assumptions drawer", () => {
		const { block, range, slide, metric, done } = economics();
		const toggle = block.querySelector<HTMLButtonElement>(".studio-econ-assumptions")!;
		const drawer = block.querySelector<HTMLElement>(".studio-econ-drawer")!;
		expect(text(toggle)).toBe("Assumptions (5)");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe(drawer.id);
		expect(drawer.hidden).toBe(true);
		const secondary = [...drawer.querySelectorAll<HTMLElement>(".studio-econ-secondary > .studio-econ-lever")];
		expect(secondary.map((lever) => lever.dataset.input)).toEqual(["hourly_cost", "fixed_costs", "capacity_hours"]);
		const basis = [...drawer.querySelectorAll<HTMLElement>(".studio-econ-basis-row")];
		expect(basis.map((row) => row.dataset.input)).toEqual(["price", "hours_per_customer"]);
		expect(basis[0]!.querySelector(".studio-tier.is-benchmark")?.getAttribute("title")).toBe("Rival pricing scan");
		expect(text(basis[1]!)).toContain("Onboarding plus monthly review.");
		const hourly = secondary[0]!;
		expect(hourly.querySelector(".studio-tier.is-verified")).not.toBeNull();
		expect(text(hourly.querySelector(".studio-econ-note"))).toBe("Payroll 2026");

		toggle.click();
		expect(drawer.hidden).toBe(false);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		slide("capacity_hours", 60);
		expect(range("capacity_hours").value).toBe("60");
		expect(metric("work_hours")).toBe("75 h");
		expect(block.querySelector<HTMLButtonElement>('.studio-econ-flag[data-constraint="capacity"]')!.hidden).toBe(
			false,
		);
		toggle.click();
		expect(drawer.hidden).toBe(true);
		done();
	});

	it("takes the inputs marked primary as the three levers", () => {
		const doc = {
			...ECONOMICS,
			inputs: ECONOMICS.inputs.map((input) =>
				input.id === "fixed_costs" || input.id === "hourly_cost" ? { ...input, primary: true } : input,
			),
		};
		const { block, done } = economics(undefined, doc);
		const levers = [...block.querySelectorAll<HTMLElement>(".studio-econ-levers > .studio-econ-lever")];
		expect(levers.map((lever) => lever.dataset.input)).toEqual(["hourly_cost", "fixed_costs"]);
		const secondary = [...block.querySelectorAll<HTMLElement>(".studio-econ-secondary > .studio-econ-lever")];
		expect(secondary.map((lever) => lever.dataset.input)).toEqual([
			"customers",
			"price",
			"hours_per_customer",
			"capacity_hours",
		]);
		done();
	});

	it("switches scenarios, snaps to a market mark and goes back to base", () => {
		const { block, hero, range, done } = economics();
		const premium = block.querySelector<HTMLButtonElement>('.studio-econ-scenario[data-scenario="premium"]')!;
		premium.click();
		expect(premium.classList.contains("is-on")).toBe(true);
		expect(text(block.querySelector(".studio-econ-thesis"))).toBe("Fewer dealers at the rival's price.");
		expect(range("price").value).toBe("1495");
		expect(range("customers").value).toBe("30");
		expect(hero()).toBe("DKK 6,850");
		expect(block.querySelector(".studio-econ-readout.is-good")).not.toBeNull();
		expect(block.querySelector(".studio-econ-mark.is-on")).not.toBeNull();
		expect(block.querySelector(".studio-econ-tick-mark.is-on")).not.toBeNull();
		expect(block.querySelector<HTMLButtonElement>(".studio-econ-reset")!.hidden).toBe(true);

		block.querySelector<HTMLButtonElement>(".studio-econ-scenario.is-base")!.click();
		expect(range("price").value).toBe("1000");
		expect(block.querySelector<HTMLElement>(".studio-econ-thesis")!.hidden).toBe(true);
		expect(block.querySelector(".studio-econ-mark.is-on")).toBeNull();

		block.querySelector<HTMLButtonElement>(".studio-econ-tick-mark")!.click();
		expect(range("price").value).toBe("1495");
		expect(block.querySelector(".studio-econ-mark.is-on")).not.toBeNull();
		expect(block.querySelector<HTMLButtonElement>(".studio-econ-reset")!.hidden).toBe(false);
		done();
	});

	it("sends the current levers, results and triggered limits when the numbers are challenged", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { block, slide, done } = economics(ask);
		slide("customers", 70);
		const challenge = block.querySelector<HTMLButtonElement>(".studio-econ-foot .studio-ask-btn")!;
		expect(text(challenge)).toBe("Challenge these numbers");
		challenge.click();
		expect(ask).toHaveBeenCalledTimes(1);
		const [prompt, title] = ask.mock.calls[0]!;
		expect(title).toBe("Challenge the numbers");
		expect(prompt).toContain("Challenge these numbers in Dealer lead engine.");
		expect(prompt).toContain("Dealers 70");
		expect(prompt).toContain("Contribution DKK");
		expect(prompt).toContain("Triggered constraints: Capacity ceiling");
		done();
	});

	it("keeps the founder's levers and view when the tab is drawn again", () => {
		const files = file("economics.json", ECONOMICS);
		const { view, done } = layoutView(files);
		const first = view.plan(layoutInput(files, "economics")).tasks.map((task) => task.build());
		const block = first.find((el) => el.matches('[data-block="economics"]'))!;
		block.querySelector<HTMLButtonElement>('.studio-econ-view[data-view="curve"]')!.click();
		const range = block.querySelector<HTMLInputElement>('[data-input="customers"] input')!;
		range.value = "70";
		range.dispatchEvent(new Event("input"));
		const again = view
			.plan(layoutInput(files, "economics"))
			.tasks.map((task) => task.build())
			.find((el) => el.matches('[data-block="economics"]'))!;
		expect(again.querySelector<HTMLInputElement>('[data-input="customers"] input')!.value).toBe("70");
		expect(again.querySelector<HTMLButtonElement>('.studio-econ-flag[data-constraint="capacity"]')!.hidden).toBe(
			false,
		);
		expect(again.querySelector('.studio-econ-view[data-view="curve"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(again.querySelector(".studio-econ-svg.is-curve")).not.toBeNull();
		done();
	});
});

describe("The hypotheses block", () => {
	function hypotheses(ask?: Ask) {
		const drawn = draw(file("hypotheses.json", HYPOTHESES), "hypotheses", ask);
		const block = drawn.root.querySelector<HTMLElement>('[data-block="hypotheses"]')!;
		const row = (id: string) => block.querySelector<HTMLElement>(`.studio-hyp[data-hypothesis="${id}"]`)!;
		const node = (id: string) => block.querySelector<SVGGElement>(`.studio-hyp-node[data-hypothesis="${id}"]`)!;
		const open = () =>
			[...block.querySelectorAll<HTMLElement>(".studio-hyp")]
				.filter((item) => item.querySelector<HTMLElement>(".studio-hyp-body")!.hidden === false)
				.map((item) => item.dataset.hypothesis);
		return { ...drawn, block, row, node, open };
	}

	it("draws the proof track in bet order with each node's status and impact", () => {
		const { block, node, done } = hypotheses();
		expect(text(block.querySelector(".studio-hyp-summary"))).toBe("Four bets carry the plan.");
		const track = block.querySelector(".studio-hyp-track svg")!;
		expect(track.getAttribute("viewBox")).toBe("0 0 760 130");
		const nodes = [...track.querySelectorAll<SVGGElement>(".studio-hyp-node")];
		expect(nodes.map((item) => item.dataset.hypothesis)).toEqual(["h2", "h1", "h4", "h3"]);
		expect(texts(track.querySelectorAll(".studio-hyp-node-label"))).toEqual([
			"B1 · Fatal",
			"B2 · High",
			"B3 · High",
			"B4 · Medium",
		]);
		expect(texts(track.querySelectorAll(".studio-hyp-node-status"))).toEqual([
			"Untested",
			"Testing",
			"Untested",
			"Proven",
		]);
		expect(node("h2").classList.contains("is-untested")).toBe(true);
		expect(node("h2").querySelector(".studio-hyp-node-danger")).not.toBeNull();
		expect(text(node("h2").querySelector(".studio-hyp-node-glyph"))).toBe("?");
		expect(node("h4").querySelector(".studio-hyp-node-danger")).toBeNull();
		expect(node("h1").querySelector(".studio-hyp-node-core")).not.toBeNull();
		expect(node("h3").querySelector(".studio-hyp-node-check")).not.toBeNull();
		const links = [...track.querySelectorAll(".studio-hyp-link")].map((line) => line.getAttribute("class"));
		expect(links).toEqual(["studio-hyp-link is-quiet", "studio-hyp-link is-fog", "studio-hyp-link is-quiet"]);
		expect(node("h2").classList.contains("is-selected")).toBe(true);
		done();
	});

	it("opens only the first open fatal bet and lets a node or a row pick another", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { row, node, open, done } = hypotheses(ask);
		expect(open()).toEqual(["h2"]);
		const fatal = row("h2");
		const head = fatal.querySelector<HTMLButtonElement>(".studio-hyp-row")!;
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(text(head.querySelector(".studio-hyp-impact.is-fatal"))).toBe("Fatal");
		expect(text(head.querySelector(".studio-hyp-bet"))).toBe("Dealers lack an in-house booking tool.");
		expect(head.querySelector(".studio-hyp-dot.is-untested")).not.toBeNull();
		expect(head.querySelector(".studio-tier-mark.is-benchmark")).not.toBeNull();
		expect(text(fatal.querySelector(".studio-hyp-test.is-test p"))).toBe("Call ten dealers this week.");
		expect(text(fatal.querySelector(".studio-hyp-test.is-kill p"))).toBe("Four of ten already run one.");
		expect(text(fatal.querySelector(".studio-hyp-meta"))).toContain("Founder");
		expect(row("h1").querySelector<HTMLButtonElement>(".studio-hyp-row")!.getAttribute("aria-expanded")).toBe(
			"false",
		);

		click(node("h3"));
		expect(open()).toEqual(["h3"]);
		expect(node("h3").classList.contains("is-selected")).toBe(true);
		expect(node("h2").classList.contains("is-selected")).toBe(false);
		row("h3").querySelector<HTMLButtonElement>(".studio-hyp-row")!.click();
		expect(open()).toEqual([]);
		head.click();
		expect(open()).toEqual(["h2"]);

		fatal.querySelector<HTMLButtonElement>(".studio-ask-btn")!.click();
		const [prompt, title] = ask.mock.calls[0]!;
		expect(title).toBe("Design test");
		expect(prompt).toContain("Dealers lack an in-house booking tool.");
		expect(prompt).toContain("Four of ten already run one.");
		done();
	});

	it("filters the list in place, mutes the track and clears the filter for a hidden node", () => {
		const { block, node, open, done } = hypotheses();
		const items = [...block.querySelectorAll<HTMLElement>(".studio-hyp")];
		const visible = () => items.filter((item) => !item.hidden).map((item) => item.dataset.hypothesis);
		const pill = (filter: string) =>
			block.querySelector<HTMLButtonElement>(`.studio-hyp-filter[data-filter="${filter}"]`)!;
		expect(visible()).toEqual(["h2", "h1", "h4", "h3"]);
		expect(texts(block.querySelectorAll(".studio-hyp-filter > span:first-child"))).toEqual([
			"All",
			"Fatal",
			"Untested",
			"Testing",
			"Proven",
		]);
		expect(texts(block.querySelectorAll(".studio-hyp-count"))).toEqual(["4", "1", "2", "1", "1"]);

		pill("fatal").click();
		expect(visible()).toEqual(["h2"]);
		expect(pill("fatal").getAttribute("aria-pressed")).toBe("true");
		expect(node("h1").classList.contains("is-muted")).toBe(true);
		expect(node("h2").classList.contains("is-muted")).toBe(false);
		pill("untested").click();
		expect(visible()).toEqual(["h2", "h4"]);
		click(node("h3"));
		expect(visible()).toEqual(["h2", "h1", "h4", "h3"]);
		expect(open()).toEqual(["h3"]);
		expect(pill("all").classList.contains("is-on")).toBe(true);
		done();
	});
});

describe("The landscape block", () => {
	it("maps every player with whole names placed clear of the edges and points", () => {
		const { root, done } = draw(file("landscape.json", LANDSCAPE), "market");
		const block = root.querySelector<HTMLElement>('[data-block="landscape"]')!;
		expect(text(block.querySelector(".studio-land-wedge"))).toBe("Our wedge Bookings, not leads.");
		expect(text(block.querySelector(".studio-land-summary"))).toBe(LANDSCAPE.summary);
		const map = block.querySelector(".studio-land-map svg")!;
		expect(map.getAttribute("viewBox")).toBe("0 0 680 420");
		expect(map.querySelectorAll(".studio-land-quad")).toHaveLength(2);
		expect(texts(map.querySelectorAll(".studio-land-axis"))).toEqual(["Price", "Depth"]);
		expect(texts(map.querySelectorAll(".studio-land-end"))).toEqual([
			"← Cheap",
			"Premium →",
			"↑ Bookings",
			"↓ Leads",
		]);
		expect(map.querySelectorAll(".studio-land-point")).toHaveLength(3);
		expect(map.querySelector('.studio-land-point.is-us[data-player="us"] .studio-land-halo')).not.toBeNull();
		const names = [...map.querySelectorAll<SVGTextElement>(".studio-land-name")];
		expect(texts(names)).toEqual(["Leadly", "Spreadsheets", "Qorpera Auto"]);
		expect(names.some((name) => text(name).includes("…"))).toBe(false);
		expect(names.map((name) => name.getAttribute("text-anchor"))).toEqual(["end", "start", "start"]);
		done();
	});

	it("lifts one of two close labels so they never collide", () => {
		const crowded = {
			axes: LANDSCAPE.axes,
			players: [
				{ id: "a", name: "Private Dealer B2B Network", x: 30, y: 50 },
				{ id: "b", name: "Biltorvet", x: 35, y: 55 },
				{ id: "c", name: "Bilbasen Pro Dealer Suite", x: 96, y: 52 },
			],
		};
		const { root, done } = draw(file("landscape.json", crowded), "market");
		const label = (id: string) =>
			root.querySelector<SVGTextElement>(`.studio-land-point[data-player="${id}"] .studio-land-name`)!;
		const y = (id: string) => Number(label(id).getAttribute("y"));
		expect(Math.abs(y("a") - y("b"))).toBeGreaterThanOrEqual(26);
		expect(text(label("a"))).toBe("Private Dealer B2B Network");
		expect(label("c").getAttribute("text-anchor")).toBe("end");
		expect(Number(label("c").getAttribute("x"))).toBeLessThan(680);
		done();
	});

	it("focuses one player at a time from the map and the strip, starting with us", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { root, done } = draw(file("landscape.json", LANDSCAPE), "market", ask);
		const block = root.querySelector<HTMLElement>('[data-block="landscape"]')!;
		const card = block.querySelector<HTMLElement>(".studio-land-focus")!;
		const point = (id: string) => block.querySelector<SVGGElement>(`.studio-land-point[data-player="${id}"]`)!;
		const chip = (id: string) => block.querySelector<HTMLButtonElement>(`.studio-land-chip[data-player="${id}"]`)!;
		expect(block.querySelector(".studio-land-table")).toBeNull();
		expect(card.dataset.player).toBe("us");
		expect(text(card.querySelector(".studio-land-focus-name"))).toBe("Qorpera Auto");
		expect(text(card.querySelector(".studio-land-us"))).toBe("Us");
		expect(text(card.querySelector(".studio-land-beat.is-edge p"))).toBe("Booked, not promised");
		expect(point("us").classList.contains("is-active")).toBe(true);
		expect(texts(block.querySelectorAll(".studio-land-chip-name"))).toEqual([
			"Qorpera Auto",
			"Leadly",
			"Spreadsheets",
			"Local agency",
		]);
		expect(text(chip("leadly").querySelector(".studio-land-chip-price"))).toBe("1,495 DKK / month");
		expect(chip("us").getAttribute("aria-pressed")).toBe("true");

		hover(point("leadly"), "mouseenter");
		expect(card.dataset.player).toBe("leadly");
		const link = card.querySelector("a")!;
		expect(link.getAttribute("href")).toBe("https://leadly.example");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(text(card.querySelector(".studio-land-category"))).toBe("Incumbent");
		expect(card.querySelector(".studio-tier-mark.is-benchmark")?.getAttribute("title")).toBe(
			"Benchmark · Leadly pricing page",
		);
		expect(text(card.querySelector(".studio-land-beat.is-position p"))).toBe("Lead lists for every dealer");
		expect(text(card.querySelector(".studio-land-price"))).toBe("1,495 DKK / month");
		expect(texts(card.querySelectorAll(".studio-land-contrast li"))).toEqual([
			"Strength Brand",
			"Weakness Lead quality",
		]);
		expect(text(card.querySelector(".studio-land-beat.is-edge p"))).toBe("We charge per booking");
		expect(chip("leadly").classList.contains("is-active")).toBe(true);
		hover(point("leadly"), "mouseleave");
		expect(card.dataset.player).toBe("us");

		chip("sheet").click();
		expect(card.dataset.player).toBe("sheet");
		expect(card.querySelector("a")).toBeNull();
		expect(point("sheet").classList.contains("is-active")).toBe(true);
		expect(point("us").classList.contains("is-active")).toBe(false);
		expect(chip("sheet").getAttribute("aria-pressed")).toBe("true");
		hover(chip("agency"), "mouseenter");
		expect(text(card.querySelector(".studio-land-beat.is-position p"))).toBe("Full service");
		hover(chip("agency"), "mouseleave");
		expect(card.dataset.player).toBe("sheet");
		click(point("leadly"));
		expect(card.dataset.player).toBe("leadly");
		expect(point("leadly").getAttribute("aria-pressed")).toBe("true");

		card.querySelector<HTMLButtonElement>(".studio-land-focus-foot .studio-ask-btn")!.click();
		const [prompt, title] = ask.mock.calls[0]!;
		expect(title).toBe("Research rivals");
		expect(prompt).toContain("Leadly, Spreadsheets, Local agency");
		done();
	});

	it("leaves the map out without axes or two placed players and keeps the strip", () => {
		const { root, done } = draw(file("landscape.json", { players: LANDSCAPE.players }), "market");
		expect(root.querySelector(".studio-land-map")).toBeNull();
		expect(root.querySelector(".studio-land-split.is-single .studio-land-focus")).not.toBeNull();
		expect(root.querySelectorAll(".studio-land-chip")).toHaveLength(4);
		done();
	});
});

describe("Surface links in messages", () => {
	it("draws one card per surface and tab under the words, with the links inline", () => {
		const prose = markdown(
			"See [Strategy](surface:strategy), the [Economics](surface:strategy#economics) tab and [Strategy](surface:strategy) again.",
		);
		const cards = [...prose.querySelectorAll<HTMLElement>(".surface-card")];
		const targets = cards.map((card) => [card.dataset.surfaceSlug, card.dataset.surfaceTab]);
		expect(targets).toEqual([
			["strategy", undefined],
			["strategy", "economics"],
		]);
		expect(text(cards[1]!.querySelector(".app-card-title"))).toBe("Economics");
		const links = [...prose.querySelectorAll<HTMLElement>("p .surface-link")];
		expect(links.map((link) => [text(link), link.dataset.surfaceTab])).toEqual([
			["Strategy", undefined],
			["Economics", "economics"],
			["Strategy", undefined],
		]);

		const bubbles = markdownBubbles("[Economics](surface:strategy#economics)");
		const card = bubbles
			.map((bubble) => bubble.querySelector<HTMLElement>('.surface-card[data-surface-slug="strategy"]'))
			.find(Boolean);
		expect(card?.dataset.surfaceTab).toBe("economics");
		expect(bubbles.some((bubble) => bubble.querySelector(".surface-link"))).toBe(false);
	});
});
