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
		{
			id: "contribution",
			label: "Contribution",
			format: "currency",
			emphasis: "primary",
			toneWhenNegative: "danger",
		},
		{ id: "work_hours", label: "Team hours", format: "hours" },
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
	it("draws five tabs and every strategy block's empty home, with an ask in each", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const plan = draw({}, "plan", ask);
		const tabs = texts(plan.root.querySelectorAll(".studio-tab"));
		expect(tabs).toEqual(["Grand plan", "Economics", "Market", "Hypotheses", "Deep dives"]);
		const empty = [...plan.root.querySelectorAll<HTMLElement>(".studio-tab.is-empty")];
		expect(empty.map((tab) => tab.dataset.tab)).toEqual(["economics", "market", "hypotheses", "reports"]);
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
		expect(filled.root.querySelectorAll(".studio-tab.is-empty")).toHaveLength(1);
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
		expect(tabs).toEqual(["Stor plan", "Økonomi", "Marked", "Hypoteser", "Dybdegående"]);
		const lead = text(danish.root.querySelector(".studio-strategy-empty strong"));
		expect(lead).toBe("Ingen strategier på bordet endnu");
		danish.done();
	});
});

describe("The plays block", () => {
	it("puts the recommended play first, raised, with its kill risk, and stress-tests it", async () => {
		let release: () => void = () => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ask = vi.fn<Ask>(() => pending);
		const { root, done } = draw(file("plays.json", PLAYS), "plan", ask);
		const block = root.querySelector('[data-block="plays"]')!;
		expect(text(block.querySelector(".studio-plays-verdict p"))).toBe("Sell to dealers, not drivers.");
		expect(text(block.querySelector(".studio-plays-summary"))).toBe(PLAYS.summary);
		const names = texts(block.querySelectorAll(".studio-play-name"));
		expect(names).toEqual(["Dealer lead engine", "Fleet software", "Driver subscription"]);
		const lead = block.querySelector<HTMLElement>(".studio-play.is-recommended")!;
		expect(lead.dataset.play).toBe("dealers");
		expect(text(lead.querySelector(".studio-play-status"))).toBe("Recommended");
		expect(lead.querySelector(".studio-tier.is-benchmark")?.getAttribute("title")).toBe("Dealer interviews");
		const facts = texts(lead.querySelectorAll(".studio-play-fact dt"));
		expect(facts).toEqual(["Who pays", "Revenue model", "Unit margin", "Capacity ceiling", "Moat"]);
		expect(text(lead.querySelector(".studio-play-kill p"))).toBe("Dealers build it in-house.");
		expect(text(lead.querySelector(".studio-play-next p"))).toBe("Sign three pilot dealers.");
		expect(text(lead.querySelector(".studio-play-list.is-pros li"))).toBe("Existing budget");
		expect(text(lead.querySelector(".studio-play-list.is-cons li"))).toBe("Long sales cycle");
		expect(block.querySelector(".studio-play.is-rejected .studio-play-kill")).not.toBeNull();
		expect(block.querySelector(".studio-play.is-exploring .studio-play-facts")).toBeNull();

		const stress = lead.querySelector<HTMLButtonElement>(".studio-ask-btn")!;
		expect(text(stress)).toBe("Stress-test play");
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
		done();
	});
});

function economics(ask?: Ask) {
	const drawn = draw(file("economics.json", ECONOMICS), "economics", ask);
	const block = drawn.root.querySelector<HTMLElement>('[data-block="economics"]')!;
	const range = (id: string) =>
		block.querySelector<HTMLInputElement>(`.studio-econ-lever[data-input="${id}"] input[type="range"]`)!;
	const slide = (id: string, value: number) => {
		const input = range(id);
		input.value = String(value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const kpi = (id: string) => text(block.querySelector(`[data-headline="${id}"] .studio-econ-kpi-value`));
	return { ...drawn, block, range, slide, kpi };
}

describe("The economics block", () => {
	it("draws the head, grouped levers with tiers and marks, KPIs, the verdict and both charts", () => {
		const { block, kpi, done } = economics();
		expect(text(block.querySelector(".studio-econ-title h3"))).toBe("Dealer lead engine");
		expect(texts(block.querySelectorAll(".studio-econ-scenario"))).toEqual(["Base", "Premium"]);
		expect(block.querySelector(".studio-econ-scenario.is-base.is-on")).not.toBeNull();
		expect(block.querySelector<HTMLButtonElement>(".studio-econ-reset")!.hidden).toBe(true);
		expect(texts(block.querySelectorAll(".studio-econ-group-head"))).toEqual(["Demand", "Pricing", "Delivery"]);
		const price = block.querySelector('.studio-econ-lever[data-input="price"]')!;
		expect(price.querySelector(".studio-tier.is-benchmark")?.getAttribute("title")).toBe("Rival pricing scan");
		expect(text(price.querySelector(".studio-econ-lever-value"))).toBe("DKK 1,000");
		expect(price.querySelectorAll(".studio-econ-tick-mark")).toHaveLength(1);
		const hours = block.querySelector('.studio-econ-lever[data-input="hours_per_customer"]')!;
		expect(text(hours.querySelector(".studio-econ-note"))).toBe("Onboarding plus monthly review.");
		expect(block.querySelector('[data-input="customers"] .studio-tier.is-hypothesis')).not.toBeNull();
		expect(kpi("contribution")).toBe("DKK 0");
		expect(kpi("work_hours")).toBe("75 h");
		expect(text(block.querySelector('[data-headline="contribution"] .studio-econ-kpi-sub'))).toBe("Per month");
		expect(text(block.querySelector(".studio-econ-verdict p"))).toBe(ECONOMICS.verdict);
		expect(block.querySelector(".studio-econ-alert")).toBeNull();
		expect(text(block.querySelector(".studio-econ-holds"))).toBe("Every hard constraint holds.");

		const waterfall = block.querySelector(".studio-econ-svg.is-waterfall")!;
		expect(waterfall.querySelectorAll(".studio-econ-wf-bar")).toHaveLength(4);
		expect(waterfall.querySelectorAll(".studio-econ-wf-bar.is-cost")).toHaveLength(2);
		expect(waterfall.querySelectorAll(".studio-econ-wf-bar.is-total")).toHaveLength(1);
		const curve = block.querySelector(".studio-econ-svg.is-curve")!;
		expect(curve.querySelector(".studio-econ-line")).not.toBeNull();
		expect(curve.querySelector(".studio-econ-capacity")).not.toBeNull();
		expect(text(curve.querySelector(".studio-econ-capacity-label"))).toBe("Team capacity");
		expect(text(curve.querySelector(".studio-econ-pill-text"))).toBe("Break-even 50");
		expect(curve.querySelector(".studio-econ-breakeven.is-impossible")).toBeNull();
		expect(curve.querySelector(".studio-econ-now")).not.toBeNull();
		expect(text(block.querySelector(".studio-econ-chart-note"))).toBe("Break-even at 50.");
		done();
	});

	it("recomputes in place as levers move, raises a fatal ceiling and resets to the scenario", () => {
		const { root, block, slide, kpi, range, done } = economics();
		slide("customers", 70);
		expect(root.querySelector('[data-block="economics"]')).toBe(block);
		expect(kpi("contribution")).toBe("DKK 8,000");
		expect(kpi("work_hours")).toBe("105 h");
		const fatal = block.querySelector(".studio-econ-alert.is-fatal")!;
		expect(text(fatal.querySelector("strong"))).toBe("Capacity ceiling");
		expect(text(fatal.querySelector("p"))).toBe("The team runs out of hours before the month ends.");
		expect(block.querySelector(".studio-econ-verdict")).toBeNull();
		const reset = block.querySelector<HTMLButtonElement>(".studio-econ-reset")!;
		expect(reset.hidden).toBe(false);

		slide("customers", 20);
		expect(block.querySelector(".studio-econ-alert.is-fatal")).toBeNull();
		expect(text(block.querySelector(".studio-econ-alert.is-warning strong"))).toBe("Losing money");
		expect(block.querySelector('[data-headline="contribution"].is-negative')).not.toBeNull();

		reset.click();
		expect(range("customers").value).toBe("50");
		expect(kpi("contribution")).toBe("DKK 0");
		expect(reset.hidden).toBe(true);
		expect(block.querySelector(".studio-econ-alert")).toBeNull();

		slide("hours_per_customer", 1.75);
		expect(block.querySelector(".studio-econ-breakeven.is-impossible")).not.toBeNull();
		const note = text(block.querySelector(".studio-econ-chart-note.is-danger"));
		expect(note).toContain("past the capacity ceiling");
		done();
	});

	it("switches scenarios, snaps to a market mark and goes back to base", () => {
		const { block, kpi, range, done } = economics();
		const premium = block.querySelector<HTMLButtonElement>('.studio-econ-scenario[data-scenario="premium"]')!;
		premium.click();
		expect(premium.classList.contains("is-on")).toBe(true);
		expect(text(block.querySelector(".studio-econ-thesis"))).toBe("Fewer dealers at the rival's price.");
		expect(range("price").value).toBe("1495");
		expect(range("customers").value).toBe("30");
		expect(kpi("contribution")).toBe("DKK 6,850");
		expect(block.querySelector(".studio-econ-mark.is-on")).not.toBeNull();
		expect(block.querySelector<HTMLButtonElement>(".studio-econ-reset")!.hidden).toBe(true);

		block.querySelector<HTMLButtonElement>(".studio-econ-scenario.is-base")!.click();
		expect(range("price").value).toBe("1000");
		expect(block.querySelector<HTMLElement>(".studio-econ-thesis")!.hidden).toBe(true);
		expect(block.querySelector(".studio-econ-mark.is-on")).toBeNull();

		block.querySelector<HTMLButtonElement>(".studio-econ-mark")!.click();
		expect(range("price").value).toBe("1495");
		expect(block.querySelector(".studio-econ-mark.is-on")).not.toBeNull();
		expect(block.querySelector<HTMLButtonElement>(".studio-econ-reset")!.hidden).toBe(false);
		done();
	});

	it("sends the current levers, results and triggered limits when the numbers are challenged", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { block, slide, done } = economics(ask);
		slide("customers", 70);
		const challenge = block.querySelector<HTMLButtonElement>(".studio-strategy-foot .studio-ask-btn")!;
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

	it("keeps the founder's levers when the tab is drawn again", () => {
		const files = file("economics.json", ECONOMICS);
		const { view, done } = layoutView(files);
		const first = view.plan(layoutInput(files, "economics")).tasks.map((task) => task.build());
		const range = first[0]!.querySelector<HTMLInputElement>('[data-input="customers"] input')!;
		range.value = "70";
		range.dispatchEvent(new Event("input"));
		const again = view.plan(layoutInput(files, "economics")).tasks.map((task) => task.build());
		expect(again[0]!.querySelector<HTMLInputElement>('[data-input="customers"] input')!.value).toBe("70");
		expect(again[0]!.querySelector(".studio-econ-alert.is-fatal")).not.toBeNull();
		done();
	});
});

describe("The hypotheses block", () => {
	it("ranks the ledger by impact, filters it in place and designs a test", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { root, done } = draw(file("hypotheses.json", HYPOTHESES), "hypotheses", ask);
		const block = root.querySelector('[data-block="hypotheses"]')!;
		const items = [...block.querySelectorAll<HTMLElement>(".studio-hyp")];
		const visible = () => items.filter((item) => !item.hidden).map((item) => item.dataset.hypothesis);
		const pill = (filter: string) =>
			block.querySelector<HTMLButtonElement>(`.studio-hyp-filter[data-filter="${filter}"]`)!;
		expect(text(block.querySelector(".studio-hyp-summary"))).toBe("Four bets carry the plan.");
		expect(visible()).toEqual(["h2", "h1", "h4", "h3"]);
		const filters = texts(block.querySelectorAll(".studio-hyp-filter > span:first-child"));
		expect(filters).toEqual(["All", "Fatal", "Untested", "Testing", "Proven"]);
		expect(texts(block.querySelectorAll(".studio-hyp-count"))).toEqual(["4", "1", "2", "1", "1"]);

		const fatal = block.querySelector('.studio-hyp[data-hypothesis="h2"]')!;
		expect(text(fatal.querySelector(".studio-hyp-impact.is-fatal"))).toBe("Fatal");
		expect(text(fatal.querySelector(".studio-hyp-status"))).toBe("Untested");
		expect(fatal.querySelector(".studio-tier.is-benchmark")).not.toBeNull();
		expect(text(fatal.querySelector(".studio-hyp-test.is-test p"))).toBe("Call ten dealers this week.");
		expect(text(fatal.querySelector(".studio-hyp-test.is-kill p"))).toBe("Four of ten already run one.");
		expect(text(fatal.querySelector(".studio-hyp-meta"))).toContain("Founder");

		pill("fatal").click();
		expect(visible()).toEqual(["h2"]);
		expect(pill("fatal").getAttribute("aria-pressed")).toBe("true");
		pill("untested").click();
		expect(visible()).toEqual(["h2", "h4"]);
		pill("untested").click();
		expect(visible()).toEqual(["h2", "h1", "h4", "h3"]);
		expect(pill("all").classList.contains("is-on")).toBe(true);

		fatal.querySelector<HTMLButtonElement>(".studio-ask-btn")!.click();
		const [prompt, title] = ask.mock.calls[0]!;
		expect(title).toBe("Design test");
		expect(prompt).toContain("Dealers lack an in-house booking tool.");
		expect(prompt).toContain("Four of ten already run one.");
		done();
	});
});

describe("The landscape block", () => {
	it("maps the players, highlights us, links rows and points, and asks for research", () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { root, done } = draw(file("landscape.json", LANDSCAPE), "market", ask);
		const block = root.querySelector<HTMLElement>('[data-block="landscape"]')!;
		expect(text(block.querySelector(".studio-land-wedge p"))).toBe("Bookings, not leads.");
		const map = block.querySelector(".studio-land-map svg")!;
		expect(map.getAttribute("viewBox")).toBe("0 0 600 400");
		expect(map.querySelectorAll(".studio-land-quad")).toHaveLength(2);
		expect(texts(map.querySelectorAll(".studio-land-axis"))).toEqual(["Price", "Depth"]);
		expect(texts(map.querySelectorAll(".studio-land-end"))).toEqual(["Cheap", "Premium", "Bookings", "Leads"]);
		expect(map.querySelectorAll(".studio-land-point")).toHaveLength(3);
		expect(map.querySelector('.studio-land-point.is-us[data-player="us"] .studio-land-halo')).not.toBeNull();

		const rows = [...block.querySelectorAll<HTMLTableRowElement>("tbody tr")];
		expect(rows.map((row) => row.dataset.player)).toEqual(["us", "leadly", "sheet", "agency"]);
		expect(rows[0]!.classList.contains("is-us")).toBe(true);
		expect(text(rows[0]!.querySelector(".studio-land-us"))).toBe("Us");
		const heads = texts(block.querySelectorAll("thead th"));
		expect(heads).toEqual(["Player", "Positioning", "Pricing", "Target", "Strength", "Weakness", "Our edge"]);
		const leadly = rows[1]!;
		expect(leadly.querySelector("a")?.getAttribute("href")).toBe("https://leadly.example");
		expect(leadly.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(rows[2]!.querySelector("a")).toBeNull();
		expect(text(leadly.querySelector(".studio-land-category"))).toBe("Incumbent");
		expect(leadly.querySelector(".studio-tier.is-benchmark")?.getAttribute("title")).toBe("Leadly pricing page");
		expect(text(leadly.querySelector("td.studio-land-edge"))).toBe("We charge per booking");
		expect(text(rows[3]!.querySelector("td.studio-land-edge"))).toBe("–");

		const point = map.querySelector<SVGGElement>('.studio-land-point[data-player="leadly"]')!;
		point.dispatchEvent(new MouseEvent("mouseenter"));
		expect(block.classList.contains("has-active")).toBe(true);
		expect(leadly.classList.contains("is-active")).toBe(true);
		point.dispatchEvent(new MouseEvent("mouseleave"));
		expect(leadly.classList.contains("is-active")).toBe(false);
		rows[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		const sheet = map.querySelector('.studio-land-point[data-player="sheet"]')!;
		expect(sheet.classList.contains("is-active")).toBe(true);
		rows[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(block.classList.contains("has-active")).toBe(false);

		block.querySelector<HTMLButtonElement>(".studio-strategy-foot .studio-ask-btn")!.click();
		const [prompt, title] = ask.mock.calls[0]!;
		expect(title).toBe("Research rivals");
		expect(prompt).toContain("Leadly, Spreadsheets, Local agency");
		done();
	});

	it("leaves the map out without axes or two placed players", () => {
		const { root, done } = draw(file("landscape.json", { players: LANDSCAPE.players }), "market");
		expect(root.querySelector(".studio-land-map")).toBeNull();
		expect(root.querySelectorAll("tbody tr")).toHaveLength(4);
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
