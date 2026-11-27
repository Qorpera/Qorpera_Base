// @vitest-environment jsdom
import type { StudioBinaryRef, SurfaceSummary } from "@qorpera/contracts";
import { getInstanceByDom } from "echarts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountMoneyFlowChart } from "../src/app/views/surface-blocks/strategy-charts.ts";
import { SurfaceLayoutView } from "../src/app/views/surface-layout-view.ts";
import { SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";
import { PAGE_READY } from "../src/ui/page-frame.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fakeClient, session, storeWith, summary, workspace } from "./surface-fixtures.ts";

const ROOT = "surfaces/strategy";

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
});

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
	const lifetime = new AbortController();
	const view = new SurfaceLayoutView({
		store,
		surface: strategySurface(),
		signal: lifetime.signal,
		baseFiles: () => files,
		timeSlice: false,
		...(askSurface ? { askSurface } : {}),
	});
	const done = () => {
		lifetime.abort();
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

function at(value: unknown, ...path: readonly (string | number)[]): unknown {
	let cursor = value;
	for (const key of path) {
		cursor =
			cursor !== null && typeof cursor === "object" ? (cursor as Record<string | number, unknown>)[key] : undefined;
	}
	return cursor;
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function chartOn(host: Element, kind: string) {
	await vi.waitFor(() => expect((host as HTMLElement).dataset.chart).toBe(kind));
	const chart = getInstanceByDom(host as HTMLElement);
	expect(chart).toBeDefined();
	return chart!;
}
const chartOption = (host: Element): unknown => getInstanceByDom(host as HTMLElement)?.getOption();
const seriesOf = (host: Element, index = 0) => at(chartOption(host), "series", index);
const fire = (host: Element, event: string, params?: unknown) =>
	(getInstanceByDom(host as HTMLElement) as unknown as { trigger: (name: string, value?: unknown) => void }).trigger(
		event,
		params,
	);

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
		{ id: "volume", name: "Volume push", values: { customers: 70 } },
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
		expect(texts(economy.root.querySelectorAll(".studio-econ-view"))).toEqual(["Pengestrøm", "Vandfald", "Nulpunkt"]);
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
		expect(block.querySelector('[data-tour-id="plays:verdict"]')).toBe(block.querySelector(".studio-plays-verdict"));
		expect([...block.querySelectorAll<HTMLElement>(".studio-play")].map((card) => card.dataset.tourId)).toEqual([
			"play:dealers",
			"play:fleet",
			"play:drivers",
		]);
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
		expect(more.classList.contains("studio-play-toggle")).toBe(true);
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
	const flag = (id: string) => block.querySelector<HTMLButtonElement>(`.studio-econ-flag[data-constraint="${id}"]`)!;
	const host = block.querySelector<HTMLElement>(".studio-econ-chart-host")!;
	const card = (id: string | null) =>
		block.querySelector<HTMLButtonElement>(
			id === null ? ".studio-econ-scenario.is-base" : `.studio-econ-scenario[data-scenario="${id}"]`,
		)!;
	const pickView = (key: string) =>
		block.querySelector<HTMLButtonElement>(`.studio-econ-view[data-econ-view="${key}"]`)!;
	return { ...drawn, block, range, slide, hero, metric, flag, host, card, pickView };
}

const nodeNames = (host: Element) => list(at(seriesOf(host), "data")).map((node) => at(node, "name"));
const nodeLabel = (host: Element, name: string) =>
	at(
		list(at(seriesOf(host), "data")).find((node) => at(node, "name") === name),
		"label",
		"formatter",
	);
const linksOf = (host: Element) =>
	list(at(seriesOf(host), "links")).map((link) => [at(link, "source"), at(link, "target"), at(link, "value")]);

describe("The economics block", () => {
	it("leads with scenario cards, one hero number, the ECharts money flow and three levers", async () => {
		const { block, hero, metric, host, card, done } = economics();
		expect(text(block.querySelector(".studio-econ-title h3"))).toBe("Dealer lead engine");
		const strip = block.querySelector<HTMLElement>(".studio-econ-scenarios")!;
		expect(strip.dataset.tourId).toBe("econ:scenarios");
		expect(texts(strip.querySelectorAll(".studio-econ-scenario-name"))).toEqual(["Base", "Premium", "Volume push"]);
		expect(texts(strip.querySelectorAll(".studio-econ-scenario-value"))).toEqual([
			"DKK 0",
			"+DKK 6,850",
			"+DKK 8,000",
		]);
		expect(card(null).classList.contains("is-on")).toBe(true);
		expect(card(null).getAttribute("aria-pressed")).toBe("true");
		expect(card(null).querySelector(".studio-econ-scenario-dot.is-good")).not.toBeNull();
		expect(card("premium").querySelector(".studio-econ-scenario-dot.is-good")).not.toBeNull();
		expect(card("volume").querySelector(".studio-econ-scenario-dot.is-bad")).not.toBeNull();
		expect(card("volume").dataset.tone).toBe("bad");
		expect(block.querySelector<HTMLElement>(".studio-econ-thesis")!.hidden).toBe(true);
		expect(block.querySelector<HTMLElement>(".studio-econ-hero")!.dataset.tourId).toBe("econ:hero");

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

		expect(texts(block.querySelectorAll(".studio-econ-view"))).toEqual(["Money flow", "Waterfall", "Break-even"]);
		expect(block.querySelector('.studio-econ-view[data-econ-view="flow"]')?.getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(block.querySelector<HTMLElement>(".studio-econ-board")!.dataset.tourId).toBe("econ:visual");
		expect(host.getAttribute("aria-label")).toBe("Where the money goes");
		await chartOn(host, "flow");
		expect(host.classList.contains("is-loading")).toBe(false);
		expect(host.querySelector("svg")).not.toBeNull();
		const sankey = seriesOf(host);
		expect(at(sankey, "type")).toBe("sankey");
		expect(at(sankey, "nodeAlign")).toBe("justify");
		expect(at(sankey, "emphasis", "focus")).toBe("adjacency");
		expect(at(sankey, "lineStyle", "curveness")).toBe(0.48);
		expect(at(sankey, "lineStyle", "color")).toBe("gradient");
		expect(at(sankey, "lineStyle", "opacity")).toBe(0.42);
		expect(nodeNames(host)).toEqual(["L:0", "R:0", "R:1", "R:2"]);
		expect(linksOf(host)).toEqual([
			["L:0", "R:0", 30000],
			["L:0", "R:1", 20000],
			["L:0", "R:2", 0],
		]);
		const clean = (value: unknown) => String(value).replace(/\u00a0/g, " ");
		expect(clean(nodeLabel(host, "L:0"))).toBe("{name|Revenue}\n{amount|DKK 50K}");
		expect(clean(nodeLabel(host, "R:0"))).toBe("{name|Delivery}\n{amount|DKK 30K · 60%}");
		expect(clean(nodeLabel(host, "R:2"))).toBe("{name|Contribution}\n{amount|DKK 0 · 0%}");
		const total = list(at(sankey, "data")).find((node) => at(node, "stream", "id") === "contribution");
		const rent = list(at(sankey, "data")).find((node) => at(node, "stream", "id") === "fixed_costs");
		expect(at(total, "itemStyle", "color")).not.toBe(at(rent, "itemStyle", "color"));
		const tip = at(chartOption(host), "tooltip", 0, "formatter") as (params: unknown) => HTMLElement;
		const delivery = list(at(sankey, "links"))[0];
		const deliveryTip = tip({ data: delivery });
		expect(clean(deliveryTip.textContent)).toContain("60% of revenue");
		expect(clean(deliveryTip.textContent)).toContain("DKK 30K");

		const leverStrip = block.querySelector<HTMLElement>(".studio-econ-levers")!;
		expect(leverStrip.dataset.tourId).toBe("econ:levers");
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

	it("swaps the hero to the stream ECharts points at and pins it on click", async () => {
		const { block, hero, host, done } = economics();
		await chartOn(host, "flow");
		const streams = list(at(seriesOf(host), "links")).map((link) => at(link, "stream"));
		const delivery = streams.find((stream) => at(stream, "id") === "labor_cost");
		const fixed = streams.find((stream) => at(stream, "id") === "fixed_costs");
		fire(host, "mouseover", { dataType: "edge", data: { stream: delivery } });
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Delivery");
		expect(hero()).toBe("DKK 30K");
		expect(text(block.querySelector(".studio-econ-hero-sub"))).toBe("60% of revenue");
		expect(block.querySelector(".studio-econ-readout.is-peek")).not.toBeNull();
		fire(host, "mouseout", {});
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Contribution");
		expect(hero()).toBe("DKK 0");
		expect(block.querySelector(".studio-econ-readout.is-peek")).toBeNull();

		fire(host, "click", { dataType: "edge", data: { stream: fixed } });
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Fixed");
		fire(host, "mouseout", {});
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Fixed");
		fire(host, "click", { dataType: "edge", data: { stream: fixed } });
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Contribution");
		fire(host, "mouseover", { dataType: "node", data: { name: "__hub__" } });
		expect(text(block.querySelector(".studio-econ-hero-label"))).toBe("Contribution");
		done();
	});

	it("routes a loss through a red shortfall node and shows a breach as one pill with one line", async () => {
		const { root, block, slide, hero, flag, range, host, card, done } = economics();
		const chart = await chartOn(host, "flow");
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
		expect(getInstanceByDom(host)).toBe(chart);
		expect(nodeNames(host)).toEqual(["L:0", "L:1", "__hub__", "R:0", "R:1"]);
		expect(linksOf(host)).toEqual([
			["L:0", "__hub__", 20000],
			["L:1", "__hub__", 12000],
			["__hub__", "R:0", 12000],
			["__hub__", "R:1", 20000],
		]);
		expect(String(nodeLabel(host, "L:1")).replace(/\u00a0/g, " ")).toBe("{name|Shortfall}\n{amount|-DKK 12K · 60%}");
		const fixedNode = list(at(seriesOf(host), "data")).find((node) => at(node, "stream", "id") === "fixed_costs");
		const gapNode = list(at(seriesOf(host), "data")).find((node) => at(node, "stream", "id") === "shortfall");
		expect(at(gapNode, "itemStyle", "color")).not.toBe(at(fixedNode, "itemStyle", "color"));
		expect(card(null).querySelector(".studio-econ-scenario-dot.is-bad")).not.toBeNull();
		expect(text(card(null).querySelector(".studio-econ-scenario-value"))).toBe("-DKK 12K");

		reset.click();
		expect(range("customers").value).toBe("50");
		expect(hero()).toBe("DKK 0");
		expect(reset.hidden).toBe(true);
		expect(block.querySelectorAll(".studio-econ-flag:not([hidden])")).toHaveLength(0);
		done();
	});

	it("bridges revenue to contribution as an ECharts waterfall", async () => {
		const { block, slide, host, pickView, done } = economics();
		await chartOn(host, "flow");
		pickView("waterfall").click();
		expect(pickView("waterfall").getAttribute("aria-pressed")).toBe("true");
		expect(pickView("flow").getAttribute("aria-pressed")).toBe("false");
		const chart = await chartOn(host, "waterfall");
		expect(host.getAttribute("aria-label")).toBe("Waterfall");
		expect([0, 1, 2].map((index) => at(seriesOf(host, index), "type"))).toEqual(["bar", "bar", "bar"]);
		expect(list(at(chartOption(host), "xAxis", 0, "data"))).toEqual(["Revenue", "Delivery", "Fixed", "Contribution"]);
		expect(list(at(seriesOf(host, 0), "data"))).toEqual(["-", 20000, "-", "-"]);
		const up = list(at(seriesOf(host, 1), "data"));
		expect(up.map((item) => at(item, "value"))).toEqual([50000, 30000, 20000, 0]);
		expect(up.map((item) => String(at(item, "label", "formatter")).replace(/\u00a0/g, " "))).toEqual([
			"+DKK 50K",
			"-DKK 30K",
			"-DKK 20K",
			"DKK 0",
		]);
		expect(at(up[0], "itemStyle", "borderRadius")).toEqual([6, 6, 0, 0]);
		expect(list(at(seriesOf(host, 1), "markLine", "data")).map((line) => at(line, "yAxis"))).toEqual([0]);

		slide("customers", 20);
		expect(getInstanceByDom(host)).toBe(chart);
		const down = list(at(seriesOf(host, 2), "data"));
		expect(at(down[3], "value")).toBe(-12000);
		expect(String(at(down[3], "label", "formatter")).replace(/\u00a0/g, " ")).toBe("-DKK 12K");
		expect(at(down[3], "itemStyle", "borderRadius")).toEqual([0, 0, 6, 6]);
		expect(at(down[2], "value")).toBe(-12000);
		expect(at(list(at(seriesOf(host, 1), "data"))[2], "value")).toBe(8000);

		const tip = at(chartOption(host), "tooltip", 0, "formatter") as (params: unknown) => HTMLElement;
		expect(tip([{ dataIndex: 1 }]).textContent).toContain("60% of revenue");
		expect(block.querySelector(".studio-econ-chart-foot")?.childElementCount).toBe(0);
		done();
	});

	it("draws the break-even curve with its red capacity danger zone and pin", async () => {
		const { block, slide, host, pickView, done } = economics();
		pickView("curve").click();
		expect(pickView("curve").getAttribute("aria-pressed")).toBe("true");
		const chart = await chartOn(host, "curve");
		expect(host.getAttribute("aria-label")).toBe("Dealers");
		const line = seriesOf(host);
		expect(at(line, "type")).toBe("line");
		expect(at(chartOption(host), "tooltip", 0, "trigger")).toBe("axis");
		expect(list(at(line, "data")).length).toBeGreaterThan(10);
		expect(at(line, "areaStyle", "color")).toBeDefined();
		const area = list(at(line, "markArea", "data"));
		expect(area).toHaveLength(1);
		expect(at(area[0], 0, "xAxis")).toBe(60);
		expect(at(area[0], 0, "label", "formatter")).toBe("Team capacity · 60");
		expect(at(area[0], 1, "xAxis")).toBe(120);
		const lines = list(at(line, "markLine", "data"));
		expect(lines.map((item) => [at(item, "xAxis"), at(item, "yAxis")])).toEqual([
			[undefined, 0],
			[60, undefined],
		]);
		expect(at(lines[1], "lineStyle", "type")).toEqual([5, 4]);
		const pins = list(at(line, "markPoint", "data"));
		expect(pins.map((pin) => at(pin, "name"))).toEqual(["Break-even 50", "now"]);
		expect(at(pins[0], "symbol")).toBe("pin");
		expect(at(pins[0], "coord")).toEqual([50, 0]);
		expect(text(block.querySelector(".studio-econ-chart-note"))).toBe("Break-even at 50.");

		block.querySelector<HTMLButtonElement>(".studio-econ-assumptions")!.click();
		slide("hours_per_customer", 1.75);
		expect(getInstanceByDom(host)).toBe(chart);
		expect(text(block.querySelector(".studio-econ-chart-note.is-danger"))).toContain("past the capacity ceiling");
		const moved = list(at(seriesOf(host), "markArea", "data"));
		expect(Number(at(moved[0], 0, "xAxis"))).toBeCloseTo(90 / 1.75, 5);

		pickView("flow").click();
		await chartOn(host, "flow");
		expect(at(seriesOf(host), "type")).toBe("sankey");
		expect(block.querySelector(".studio-econ-chart-note")).toBeNull();
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

	it("switches scenarios from the comparison cards, snaps to a market mark and goes back to base", async () => {
		const { block, hero, range, host, card, done } = economics();
		const chart = await chartOn(host, "flow");
		const premium = card("premium");
		premium.click();
		expect(premium.classList.contains("is-on")).toBe(true);
		expect(premium.getAttribute("aria-pressed")).toBe("true");
		expect(card(null).classList.contains("is-on")).toBe(false);
		expect(getInstanceByDom(host)).toBe(chart);
		expect(linksOf(host)[0]).toEqual(["L:0", "R:0", 18000]);
		expect(text(premium.querySelector(".studio-econ-scenario-value"))).toBe("+DKK 6,850");
		card("volume").click();
		expect(hero()).toBe("DKK 8,000");
		expect(block.querySelector<HTMLButtonElement>('.studio-econ-flag[data-constraint="capacity"]')!.hidden).toBe(
			false,
		);
		premium.click();
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
		expect(text(card(null).querySelector(".studio-econ-scenario-value"))).toBe("+DKK 24.8K");
		expect(text(premium.querySelector(".studio-econ-scenario-value"))).toBe("+DKK 6,850");
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

	it("keeps the founder's scenario, levers and chart when the tab is drawn again", async () => {
		const files = file("economics.json", ECONOMICS);
		const { view, done } = layoutView(files);
		const first = view.plan(layoutInput(files, "economics")).tasks.map((task) => task.build());
		const block = first.find((el) => el.matches('[data-block="economics"]'))!;
		block.querySelector<HTMLButtonElement>('.studio-econ-scenario[data-scenario="premium"]')!.click();
		block.querySelector<HTMLButtonElement>('.studio-econ-view[data-econ-view="waterfall"]')!.click();
		const range = block.querySelector<HTMLInputElement>('[data-input="customers"] input')!;
		range.value = "70";
		range.dispatchEvent(new Event("input"));
		const again = view
			.plan(layoutInput(files, "economics"))
			.tasks.map((task) => task.build())
			.find((el) => el.matches('[data-block="economics"]'))!;
		document.body.append(again);
		expect(again.querySelector<HTMLInputElement>('[data-input="customers"] input')!.value).toBe("70");
		expect(again.querySelector<HTMLInputElement>('[data-input="price"] input')!.value).toBe("1495");
		expect(again.querySelector('.studio-econ-scenario[data-scenario="premium"]')?.classList.contains("is-on")).toBe(
			true,
		);
		expect(again.querySelector<HTMLButtonElement>('.studio-econ-flag[data-constraint="capacity"]')!.hidden).toBe(
			false,
		);
		expect(again.querySelector('.studio-econ-view[data-econ-view="waterfall"]')?.getAttribute("aria-pressed")).toBe(
			"true",
		);
		await chartOn(again.querySelector(".studio-econ-chart-host")!, "waterfall");
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
		expect(block.querySelector('[data-tour-id="hypotheses:track"]')).toBe(block.querySelector(".studio-hyp-track"));
		expect([...block.querySelectorAll<HTMLElement>(".studio-hyp")].map((item) => item.dataset.tourId)).toEqual([
			"hypothesis:h2",
			"hypothesis:h1",
			"hypothesis:h4",
			"hypothesis:h3",
		]);
		expect(
			[...block.querySelectorAll<HTMLElement>(".studio-hyp-head")].map((head) => head.dataset.hypothesisToggle),
		).toEqual(["h2", "h1", "h4", "h3"]);
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
	it("maps every player on the ECharts quadrant map with our position pulsing", async () => {
		const { root, done } = draw(file("landscape.json", LANDSCAPE), "market");
		const block = root.querySelector<HTMLElement>('[data-block="landscape"]')!;
		expect(text(block.querySelector(".studio-land-wedge"))).toBe("Our wedge Bookings, not leads.");
		expect(block.querySelector<HTMLElement>(".studio-land-wedge")!.dataset.tourId).toBe("landscape:wedge");
		expect(text(block.querySelector(".studio-land-summary"))).toBe(LANDSCAPE.summary);
		const map = block.querySelector<HTMLElement>(".studio-land-map")!;
		expect(map.dataset.tourId).toBe("landscape:map");
		const host = map.querySelector<HTMLElement>(".studio-land-chart-host")!;
		expect(host.getAttribute("aria-label")).toBe("Positioning map: Price against Depth");
		await chartOn(host, "landscape");
		expect(host.querySelector("svg")).not.toBeNull();
		const option = chartOption(host);
		expect(at(option, "xAxis", 0, "name")).toBe("Price");
		expect(at(option, "yAxis", 0, "name")).toBe("Depth");
		const xEnds = at(option, "xAxis", 0, "axisLabel", "formatter") as (value: number) => string;
		const yEnds = at(option, "yAxis", 0, "axisLabel", "formatter") as (value: number) => string;
		expect([xEnds(0), xEnds(50), xEnds(100)]).toEqual(["← Cheap", "", "Premium →"]);
		expect([yEnds(0), yEnds(100)]).toEqual(["↓ Leads", "↑ Bookings"]);
		const rivals = seriesOf(host, 0);
		const ours = seriesOf(host, 1);
		expect(at(rivals, "type")).toBe("scatter");
		expect(at(ours, "type")).toBe("effectScatter");
		expect(list(at(rivals, "data")).map((item) => at(item, "name"))).toEqual(["Leadly", "Spreadsheets"]);
		expect(list(at(ours, "data")).map((item) => at(item, "name"))).toEqual(["Qorpera Auto"]);
		expect(at(ours, "rippleEffect", "scale")).toBe(3.4);
		expect(at(ours, "rippleEffect", "brushType")).toBe("stroke");
		expect(at(list(at(ours, "data"))[0], "symbolSize")).toBe(22);
		expect(at(list(at(rivals, "data"))[0], "symbolSize")).toBe(16);
		expect(list(at(rivals, "data")).map((item) => at(item, "label", "position"))).toEqual(["left", "right"]);
		expect(at(rivals, "labelLayout")).toEqual({ moveOverlap: "shiftY", hideOverlap: false });
		expect(list(at(rivals, "markLine", "data"))).toMatchObject([{ xAxis: 50 }, { yAxis: 50 }]);
		expect(list(at(rivals, "markArea", "data"))).toMatchObject([
			[
				{ xAxis: 50, yAxis: 50 },
				{ xAxis: 100, yAxis: 100 },
			],
		]);
		const tip = at(option, "tooltip", 0, "formatter") as (params: unknown) => HTMLElement;
		const leadly = tip({ data: list(at(rivals, "data"))[0] });
		expect(leadly.textContent).toContain("Leadly");
		expect(leadly.textContent).toContain("Incumbent");
		expect(leadly.textContent).toContain("1,495 DKK / month");
		expect(leadly.textContent).toContain("We charge per booking");
		done();
	});

	it("keeps every long rival name whole and escapes it in the tooltip", async () => {
		const crowded = {
			axes: LANDSCAPE.axes,
			players: [
				{ id: "a", name: "Private Dealer B2B Network", x: 30, y: 50 },
				{ id: "b", name: "Biltorvet <b>Pro</b>", x: 35, y: 55 },
				{ id: "c", name: "Bilbasen Pro Dealer Suite", x: 96, y: 52 },
			],
		};
		const { root, done } = draw(file("landscape.json", crowded), "market");
		const host = root.querySelector<HTMLElement>(".studio-land-chart-host")!;
		await chartOn(host, "landscape");
		const data = list(at(seriesOf(host, 0), "data"));
		expect(data.map((item) => at(item, "name"))).toEqual([
			"Private Dealer B2B Network",
			"Biltorvet <b>Pro</b>",
			"Bilbasen Pro Dealer Suite",
		]);
		expect(data.map((item) => at(item, "label", "formatter"))).toEqual(["{b}", "{b}", "{b}"]);
		expect(data.map((item) => at(item, "label", "position"))).toEqual(["right", "right", "left"]);
		expect(list(at(seriesOf(host, 1), "data"))).toEqual([]);
		const tip = at(chartOption(host), "tooltip", 0, "formatter") as (params: unknown) => HTMLElement;
		const el = tip({ data: data[1] });
		expect(el.textContent).toContain("Biltorvet <b>Pro</b>");
		expect(el.querySelector("b")?.textContent).not.toBe("Pro");
		expect(el.innerHTML).not.toContain("<b>Pro</b>");
		done();
	});

	it("focuses one player at a time from the ECharts map and the strip, starting with us", async () => {
		const ask = vi.fn<Ask>(async () => undefined);
		const { root, done } = draw(file("landscape.json", LANDSCAPE), "market", ask);
		const block = root.querySelector<HTMLElement>('[data-block="landscape"]')!;
		const card = block.querySelector<HTMLElement>(".studio-land-focus")!;
		const host = block.querySelector<HTMLElement>(".studio-land-chart-host")!;
		const chip = (id: string) => block.querySelector<HTMLButtonElement>(`.studio-land-chip[data-player="${id}"]`)!;
		const pointSize = (id: string) => {
			const all = [...list(at(seriesOf(host, 0), "data")), ...list(at(seriesOf(host, 1), "data"))];
			return at(
				all.find((item) => at(item, "key") === id),
				"symbolSize",
			);
		};
		await chartOn(host, "landscape");
		expect(block.querySelector(".studio-land-table")).toBeNull();
		expect(card.dataset.player).toBe("us");
		expect(card.dataset.tourId).toBe("rival:us");
		expect(text(card.querySelector(".studio-land-focus-name"))).toBe("Qorpera Auto");
		expect(text(card.querySelector(".studio-land-us"))).toBe("Us");
		expect(text(card.querySelector(".studio-land-beat.is-edge p"))).toBe("Booked, not promised");
		expect(pointSize("us")).toBe(22);
		expect(texts(block.querySelectorAll(".studio-land-chip-name"))).toEqual([
			"Qorpera Auto",
			"Leadly",
			"Spreadsheets",
			"Local agency",
		]);
		expect(text(chip("leadly").querySelector(".studio-land-chip-price"))).toBe("1,495 DKK / month");
		expect(chip("us").getAttribute("aria-pressed")).toBe("true");

		fire(host, "mouseover", { data: { key: "leadly" } });
		expect(card.dataset.player).toBe("leadly");
		expect(pointSize("leadly")).toBe(21);
		expect(pointSize("us")).toBe(18);
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
		fire(host, "mouseout", {});
		expect(card.dataset.player).toBe("us");

		chip("sheet").click();
		expect(card.dataset.player).toBe("sheet");
		expect(card.dataset.tourId).toBe("rival:sheet");
		expect(card.querySelector("a")).toBeNull();
		expect(pointSize("sheet")).toBe(21);
		expect(pointSize("us")).toBe(18);
		expect(chip("sheet").getAttribute("aria-pressed")).toBe("true");
		hover(chip("agency"), "mouseenter");
		expect(text(card.querySelector(".studio-land-beat.is-position p"))).toBe("Full service");
		hover(chip("agency"), "mouseleave");
		expect(card.dataset.player).toBe("sheet");
		fire(host, "click", { data: { key: "leadly" } });
		expect(card.dataset.player).toBe("leadly");
		expect(chip("leadly").getAttribute("aria-pressed")).toBe("true");
		expect(chip("sheet").getAttribute("aria-pressed")).toBe("false");
		expect(pointSize("leadly")).toBe(21);

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

const TOUR = {
	title: "Walk the plan",
	beats: [
		{
			id: "verdict",
			label: "The call",
			tab: "plan",
			focus: "plays:verdict",
			effect: "spotlight",
			say: { en: "We sell to dealers, not drivers.", da: "Vi sælger til forhandlere, ikke bilister." },
		},
		{
			id: "money",
			label: "The money",
			tab: "economics",
			focus: "econ:visual",
			effect: "pulse",
			action: { scenario: "premium", view: "waterfall" },
			say: "At the rival's price, fewer dealers still pay the bills.",
		},
		{
			id: "rival",
			tab: "market",
			focus: "rival:leadly",
			effect: "glow",
			action: { select: "leadly" },
			say: "Leadly sells leads; we sell bookings.",
		},
		{
			id: "bet",
			tab: "hypotheses",
			focus: "hypothesis:h1",
			effect: "spotlight",
			action: { expand: "h1" },
			say: "Test this bet first.",
		},
	],
};

async function studio(
	files: Readonly<Record<string, string>>,
	options?: {
		readonly baseBinaries?: Readonly<Record<string, StudioBinaryRef>>;
		readonly readBinary?: (file: StudioBinaryRef, signal: AbortSignal) => Promise<Uint8Array>;
	},
) {
	const surface = strategySurface();
	const store = storeWith(
		fakeClient({
			listSurfaces: vi.fn(async () => [surface]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
		}),
	);
	await store.load();
	await store.openSurface(surface.slug);
	const lifetime = new AbortController();
	const view = new SurfaceStudioView({
		store,
		surface,
		signal: lifetime.signal,
		baseFiles: files,
		...(options?.baseBinaries ? { baseBinaries: options.baseBinaries } : {}),
		...(options?.readBinary ? { readBinary: options.readBinary } : {}),
		timeSlice: false,
	});
	document.body.append(view.el);
	const tour = () => view.el.querySelector<HTMLElement>(".studio-tour")!;
	const control = (label: string) =>
		tour().querySelector<HTMLButtonElement>(`.studio-tour-btn[aria-label="${label}"]`)!;
	const focused = () => view.el.querySelector<HTMLElement>(".is-tour-focus");
	const done = () => {
		lifetime.abort();
		store.dispose();
	};
	return { view, tour, control, focused, done };
}

describe("The studio voice tour", () => {
	it("stays out of the way without a tour.json", async () => {
		const { view, done } = await studio(strategyFiles());
		expect(view.el.querySelector(".studio-tour")).toBeNull();
		done();
	});

	it("walks the founder across tabs, runs each beat's action and spotlights its target", async () => {
		const { view, tour, control, focused, done } = await studio({ ...strategyFiles(), ...file("tour.json", TOUR) });
		expect(tour().hidden).toBe(false);
		expect(tour().getAttribute("aria-label")).toBe("Guided walkthrough");
		const launch = tour().querySelector<HTMLButtonElement>(".studio-tour-launch")!;
		expect(text(launch.querySelector(".studio-tour-launch-label"))).toBe("Walk the plan");
		expect(text(launch.querySelector(".studio-tour-launch-meta"))).toBe("4 steps");
		expect(launch.querySelectorAll(".studio-tour-wave i")).toHaveLength(3);
		launch.click();
		expect(tour().classList.contains("is-open")).toBe(true);
		expect(tour().classList.contains("is-playing")).toBe(true);
		control("Pause walkthrough").click();
		expect(tour().classList.contains("is-playing")).toBe(false);
		expect(control("Play walkthrough")).not.toBeNull();

		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("plays:verdict"));
		expect(view.el.classList.contains("is-tour-active")).toBe(true);
		expect(view.el.classList.contains("is-tour-spotlight")).toBe(true);
		expect(focused()!.classList.contains("is-tour-effect-spotlight")).toBe(true);
		expect(view.el.querySelector('[data-block="plays"]')!.classList.contains("has-tour-focus")).toBe(true);
		expect(view.el.querySelector(".studio-grid")!.classList.contains("has-tour-focus")).toBe(true);
		expect(text(tour().querySelector(".studio-tour-caption"))).toBe("We sell to dealers, not drivers.");
		expect(text(tour().querySelector(".studio-tour-step"))).toBe("1/4 · The call");
		const dots = () => [...tour().querySelectorAll<HTMLElement>(".studio-tour-dot")];
		expect(dots()).toHaveLength(4);
		expect(dots()[0]!.classList.contains("is-on")).toBe(true);
		expect(control("Previous step").disabled).toBe(true);

		control("Next step").click();
		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("econ:visual"));
		const econ = view.el.querySelector<HTMLElement>('[data-block="economics"]')!;
		expect(econ.querySelector('.studio-econ-scenario[data-scenario="premium"]')!.classList.contains("is-on")).toBe(
			true,
		);
		expect(econ.querySelector('.studio-econ-view[data-econ-view="waterfall"]')!.getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(view.el.querySelector('[data-block="plays"]')).toBeNull();
		expect(view.el.classList.contains("is-tour-pulse")).toBe(true);
		expect(view.el.classList.contains("is-tour-spotlight")).toBe(false);
		expect(focused()!.classList.contains("is-tour-effect-pulse")).toBe(true);
		expect(econ.classList.contains("has-tour-focus")).toBe(true);
		expect(view.el.querySelectorAll(".is-tour-focus")).toHaveLength(1);
		expect(dots()[0]!.classList.contains("is-done")).toBe(true);
		expect(dots()[1]!.classList.contains("is-on")).toBe(true);
		await chartOn(econ.querySelector(".studio-econ-chart-host")!, "waterfall");

		control("Next step").click();
		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("rival:leadly"));
		const land = view.el.querySelector<HTMLElement>('[data-block="landscape"]')!;
		const card = land.querySelector<HTMLElement>(".studio-land-focus")!;
		expect(focused()).toBe(card);
		expect(card.dataset.player).toBe("leadly");
		expect(land.querySelector('.studio-land-chip[data-player="leadly"]')!.getAttribute("aria-pressed")).toBe("true");
		expect(focused()!.classList.contains("is-tour-effect-glow")).toBe(true);
		expect(view.el.classList.contains("is-tour-glow")).toBe(true);

		control("Next step").click();
		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("hypothesis:h1"));
		const bet = view.el.querySelector<HTMLElement>('.studio-hyp[data-hypothesis="h1"]')!;
		expect(focused()).toBe(bet);
		expect(bet.querySelector(".studio-hyp-head")!.getAttribute("aria-expanded")).toBe("true");
		expect(bet.querySelector<HTMLElement>(".studio-hyp-body")!.hidden).toBe(false);
		expect(view.el.classList.contains("is-tour-spotlight")).toBe(true);
		expect(text(tour().querySelector(".studio-tour-caption"))).toBe("Test this bet first.");
		expect(control("Finish walkthrough")).not.toBeNull();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(tour().classList.contains("is-open")).toBe(false);
		expect(tour().querySelector(".studio-tour-launch")).not.toBeNull();
		expect(view.el.querySelector(".is-tour-focus, .has-tour-focus")).toBeNull();
		for (const name of ["is-tour-active", "is-tour-spotlight", "is-tour-pulse", "is-tour-glow"]) {
			expect(view.el.classList.contains(name)).toBe(false);
		}
		done();
	});

	it("jumps from a progress dot, renders Danish captions without voice clips and stops from the close button", async () => {
		setLanguagePreference("da");
		const { view, tour, control, focused, done } = await studio({ ...strategyFiles(), ...file("tour.json", TOUR) });
		const launch = tour().querySelector<HTMLButtonElement>(".studio-tour-launch")!;
		expect(text(launch.querySelector(".studio-tour-launch-meta"))).toBe("4 trin");
		launch.click();
		control("Sæt gennemgangen på pause").click();
		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("plays:verdict"));
		expect(text(tour().querySelector(".studio-tour-caption"))).toBe("Vi sælger til forhandlere, ikke bilister.");
		expect(control("Slå stemmen fra")).toBeNull();
		expect(text(tour().querySelector(".studio-tour-mode"))).toBe("Undertekster");
		expect(control("Luk gennemgangen").querySelectorAll("svg path").length).toBeGreaterThan(0);

		tour().querySelectorAll<HTMLButtonElement>(".studio-tour-dot")[2]!.click();
		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("rival:leadly"));
		expect(view.el.querySelector('[data-block="landscape"]')).not.toBeNull();

		control("Luk gennemgangen").click();
		expect(tour().classList.contains("is-open")).toBe(false);
		expect(view.el.querySelector(".is-tour-focus")).toBeNull();
		expect(view.el.classList.contains("is-tour-active")).toBe(false);
		done();
	});

	it("shows the voice toggle and plays recorded voice clips when present", async () => {
		setLanguagePreference("da");
		const caption = "Vi sælger til forhandlere, ikke bilister.";
		let hash = 0x811c9dc5;
		for (const byte of new TextEncoder().encode(caption)) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		const clipHash = hash.toString(16).padStart(8, "0");
		const clipPath = `${ROOT}/voice/${clipHash}.webm`;
		const clipRef: StudioBinaryRef = {
			manifestSha256: "a".repeat(64),
			fileSha256: "b".repeat(64),
			bytes: 16,
			mediaType: "audio/webm",
		};
		const readBinary = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
		const play = vi.fn(async () => undefined);
		const pause = vi.fn();
		const createObjectURL = vi.fn(() => "blob:tour-voice");
		const revokeObjectURL = vi.fn();
		vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
		vi.stubGlobal(
			"Audio",
			class {
				preload = "";
				src = "";
				onended: (() => void) | null = null;
				onerror: (() => void) | null = null;
				play = play;
				pause = pause;
				removeAttribute = vi.fn();
			},
		);
		const { tour, control, focused, done } = await studio(
			{
				...strategyFiles(),
				...file("tour.json", TOUR),
				...file("voice/clips.json", {
					clips: [{ caption: clipHash, file: `${clipHash}.webm`, seconds: 2.4 }],
				}),
			},
			{ baseBinaries: { [clipPath]: clipRef }, readBinary },
		);
		tour().querySelector<HTMLButtonElement>(".studio-tour-launch")!.click();
		await vi.waitFor(() => expect(focused()?.dataset.tourId).toBe("plays:verdict"));
		await vi.waitFor(() => expect(readBinary).toHaveBeenCalledWith(clipRef, expect.any(AbortSignal)));
		await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
		control("Sæt gennemgangen på pause").click();
		const silent = control("Slå stemmen fra");
		expect(text(silent)).toBe("Stemme");
		silent.click();
		expect(text(control("Slå stemmen til"))).toBe("Lydløs");
		expect(control("Slå stemmen til").getAttribute("aria-pressed")).toBe("true");
		vi.unstubAllGlobals();
		done();
	});
});

describe("Surface links in messages", () => {
	const slugs = (root: ParentNode) =>
		[...root.querySelectorAll<HTMLElement>(".surface-card.is-figure")].map((figure) =>
			figure.dataset.surfaceTab
				? `${figure.dataset.surfaceSlug}#${figure.dataset.surfaceTab}`
				: figure.dataset.surfaceSlug,
		);
	const classes = (parts: readonly HTMLElement[]) => parts.map((part) => part.className);

	it("draws a line of only interface links as one row of figures between the words", () => {
		const parts = markdownBubbles(
			[
				"Your code is in. Website is ready to look at.",
				"",
				"[Website](surface:website) [Web App](surface:web-app), [Strategy](surface:strategy) and [Economics](surface:strategy#economics)",
				"",
				"Once you've approved Web App, archive OS Demo.",
			].join("\n"),
		);
		expect(classes(parts)).toEqual(["message-prose", "app-cards surface-figures", "message-prose"]);
		expect(slugs(parts[1]!)).toEqual(["website", "web-app", "strategy", "strategy#economics"]);
		expect(texts(parts[1]!.querySelectorAll(".app-card-title"))).toEqual([
			"Website",
			"Web App",
			"Strategy",
			"Economics",
		]);
		expect(parts[1]!.querySelector(".app-card-note, .app-card-go")).toBeNull();
	});

	it("keeps a name among words as a bold link and adds each interface once at the end", () => {
		const parts = markdownBubbles(
			[
				"I rebuilt [Website](surface:website) and started [Web App](surface:web-app).",
				"",
				"- Checked [Website](surface:website) again",
				"",
				"## [Strategy](surface:strategy)",
			].join("\n"),
		);
		expect(parts.slice(0, -1).some((part) => part.querySelector(".surface-card"))).toBe(false);
		expect(texts(parts[0]!.querySelectorAll("p .surface-link"))).toEqual(["Website", "Web App"]);
		expect(parts[2]!.querySelector("h2 .surface-link")?.getAttribute("data-surface-slug")).toBe("strategy");
		expect(parts.at(-1)!.className).toBe("app-cards surface-figures");
		expect(slugs(parts.at(-1)!)).toEqual(["website", "web-app", "strategy"]);
	});

	it("adds no end row for interfaces the message already shows in a row", () => {
		const parts = markdownBubbles(
			"[Website](surface:website) [Strategy](surface:strategy)\n\nOpen [Website](surface:website) first.",
		);
		expect(classes(parts)).toEqual(["app-cards surface-figures", "message-prose"]);
		expect(slugs(parts[0]!)).toEqual(["website", "strategy"]);
	});

	it("draws a list of only interface links as a row", () => {
		const parts = markdownBubbles("Set up:\n\n- [Website](surface:website)\n- **[Web App](surface:web-app)**");
		expect(classes(parts)).toEqual(["message-prose", "app-cards surface-figures"]);
		expect(slugs(parts[1]!)).toEqual(["website", "web-app"]);
	});

	it("puts more than six interfaces on one compact line", () => {
		const line = ["a", "b", "c", "d", "e", "f", "g"].map((slug) => `[${slug}](surface:${slug})`).join(" ");
		const [row] = markdownBubbles(line);
		expect(row?.className).toBe("app-cards surface-figures is-compact");
		expect(slugs(row!)).toHaveLength(7);
	});

	it("draws the end row in markdown only when asked", () => {
		const source = "See [Strategy](surface:strategy).";
		expect(markdown(source).querySelector(".surface-figures")).toBeNull();
		expect(text(markdown(source).querySelector("p .surface-link"))).toBe("Strategy");
		expect(slugs(markdown(source, { surfaceRow: true }))).toEqual(["strategy"]);
	});

	it("leaves interface links as plain text where links are off", () => {
		const prose = markdown("[Website](surface:website)", { links: false });
		expect(prose.querySelector(".surface-card, .surface-link")).toBeNull();
		expect(text(prose)).toBe("Website");
	});
});

describe("Studio module bridge security, empty tabs, chart lifecycle, tour recovery, and sankey key safety", () => {
	function connectFrame(iframe: HTMLIFrameElement) {
		const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");
		const readyEvt = new MessageEvent("message", { data: { type: PAGE_READY } });
		Object.defineProperty(readyEvt, "source", { value: iframe.contentWindow });
		window.dispatchEvent(readyEvt);
		const lastCall = postSpy.mock.calls.at(-1) as unknown[] | undefined;
		const port = (lastCall?.[2] as MessagePort[] | undefined)?.[0];
		if (!port) throw new Error("AppFrame did not transfer a MessagePort");
		let nextId = 0;
		const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
		port.onmessage = (event) => {
			const data = event.data as Record<string, unknown>;
			const id = typeof data.id === "number" ? data.id : 0;
			const resolve = waiting.get(id);
			if (resolve) {
				waiting.delete(id);
				resolve(data);
			}
		};
		return (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
			new Promise((resolve) => {
				const id = ++nextId;
				waiting.set(id, resolve);
				port.postMessage({ type: "qorpera-app-call", id, method, params });
			});
	}

	it("gates module tell behind member confirmation, scopes list by path, and blocks non-module HTML frames", async () => {
		const surface = strategySurface();
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [surface]),
				getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
			}),
		);
		await store.load();
		await store.openSurface(surface.slug);
		const startSession = vi.spyOn(store, "startSession").mockResolvedValue(session([]));
		const life = new AbortController();
		const files: Record<string, string> = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{
						id: "lab",
						title: "Lab",
						blocks: [
							{ type: "module", from: "sketch", heading: "Sketchpad" },
							{ type: "artifacts", heading: "Pages" },
						],
					},
				],
			}),
			[`${ROOT}/sketch/index.html`]: "<!doctype html><p>Sketch module</p>",
			[`${ROOT}/sketches/a.json`]: '{"a":1}',
			[`${ROOT}/sketches/b.json`]: '{"b":2}',
			[`${ROOT}/other.txt`]: "outside",
			[`${ROOT}/memo.html`]: "<!doctype html><p>Standalone HTML artifact</p>",
		};
		const view = new SurfaceStudioView({
			store,
			surface,
			signal: life.signal,
			baseFiles: files,
			timeSlice: false,
		});
		document.body.append(view.el);

		const moduleFrame = view.el.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!;
		expect(moduleFrame).not.toBeNull();
		const callModule = connectFrame(moduleFrame);

		const listRes = (await callModule("list", { path: "sketches" })) as {
			ok: boolean;
			value?: { name: string; path: string; kind: string; bytes: number }[];
		};
		expect(listRes.ok).toBe(true);
		expect(listRes.value?.map((e) => e.path)).toEqual(["sketches/a.json", "sketches/b.json"]);
		expect(listRes.value?.[0]).toMatchObject({ name: "a.json", kind: "file", bytes: 7 });

		const traversalRes = await callModule("list", { path: "../identity" });
		expect(traversalRes.ok).toBe(false);

		const readRes = await callModule("read", { path: "sketches/a.json" });
		expect(readRes).toMatchObject({ ok: true, value: '{"a":1}' });

		const tellPromise = callModule("tell", { about: "Sketch", text: "Refine the pricing ladder" });
		await vi.waitFor(() => expect(view.el.querySelector(".studio-tell-bar")).not.toBeNull());
		expect(startSession).not.toHaveBeenCalled();

		const concurrent = await callModule("tell", { text: "Second note" });
		expect(concurrent.ok).toBe(false);

		view.el.querySelector<HTMLButtonElement>('[data-tell-act="cancel"]')!.click();
		expect(await tellPromise).toMatchObject({ ok: false });
		expect(startSession).not.toHaveBeenCalled();
		expect(view.el.querySelector(".studio-tell-bar")).toBeNull();

		const tellPromise2 = callModule("tell", { about: "Sketch", text: "Draft note" });
		await vi.waitFor(() => expect(view.el.querySelector(".studio-tell-bar")).not.toBeNull());
		const textarea = view.el.querySelector<HTMLTextAreaElement>(".studio-tell-input")!;
		textarea.value = "Confirmed member note";
		view.el.querySelector<HTMLButtonElement>('[data-tell-act="send"]')!.click();
		expect(await tellPromise2).toMatchObject({ ok: true, value: { sent: true } });
		expect(startSession).toHaveBeenCalledTimes(1);
		expect(startSession).toHaveBeenCalledWith(surface.id, "Confirmed member note", {
			originKind: "member",
			originLabel: "Sketch",
		});

		const cooldownRes = await callModule("tell", { text: "Too soon" });
		expect(cooldownRes.ok).toBe(false);

		const artifactFrame = view.el.querySelector<HTMLIFrameElement>("iframe.studio-html-frame")!;
		expect(artifactFrame).not.toBeNull();
		const callArtifact = connectFrame(artifactFrame);
		expect(await callArtifact("tell", { text: "Sneaky prompt" })).toMatchObject({ ok: false });
		expect(await callArtifact("read", { path: "sketches/a.json" })).toMatchObject({ ok: false });
		expect(await callArtifact("list", { path: "sketches" })).toMatchObject({ ok: false });
		expect(startSession).toHaveBeenCalledTimes(1);

		life.abort();
		view.dispose();
		store.dispose();
	});

	it("serves binary and relative assets through the frame file bridge for modules and standalone HTML pages while blocking path escape", async () => {
		const surface = strategySurface();
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		const pngRef = {
			manifestSha256: "1".repeat(64),
			fileSha256: "2".repeat(64),
			bytes: pngBytes.byteLength,
			mediaType: "image/png",
		};
		const readBinary = vi.fn(async () => pngBytes);
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [surface]),
				getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
			}),
		);
		await store.load();
		await store.openSurface(surface.slug);
		const life = new AbortController();
		const files: Record<string, string> = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{
						id: "lab",
						title: "Lab",
						blocks: [
							{ type: "module", from: "modules/pod", heading: "Pod" },
							{ type: "artifacts", match: ["*.html"], heading: "Pages" },
						],
					},
				],
			}),
			[`${ROOT}/modules/pod/index.html`]: '<!doctype html><img src="img/hero.png">',
			[`${ROOT}/modules/pod/data.json`]: '{"ok":true}',
			[`${ROOT}/memo.html`]: '<!doctype html><img src="pictures/shot.png">',
		};
		const baseBinaries = {
			[`${ROOT}/modules/pod/img/hero.png`]: pngRef,
			[`${ROOT}/pictures/shot.png`]: pngRef,
		};
		const view = new SurfaceStudioView({
			store,
			surface,
			signal: life.signal,
			baseFiles: files,
			baseBinaries,
			readBinary,
			timeSlice: false,
		});
		document.body.append(view.el);

		const rawAnswers: Record<string, unknown>[] = [];
		const origPortPost = MessagePort.prototype.postMessage;
		vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
			this: MessagePort,
			message: unknown,
			...rest: unknown[]
		) {
			if (message && typeof message === "object" && (message as { type?: unknown }).type === "qorpera-app-answer") {
				rawAnswers.push(message as Record<string, unknown>);
			}
			return origPortPost.apply(this, [message, ...(rest as [])]);
		});

		const moduleFrame = view.el.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!;
		const postModule = vi.spyOn(moduleFrame.contentWindow!, "postMessage");
		const readyMod = new MessageEvent("message", { data: { type: PAGE_READY } });
		Object.defineProperty(readyMod, "source", { value: moduleFrame.contentWindow });
		window.dispatchEvent(readyMod);
		const lastModCall = postModule.mock.calls.at(-1) as unknown[] | undefined;
		const modMsg = lastModCall?.[0] as { html: string; base: string };
		const modPort = (lastModCall?.[2] as MessagePort[])[0]!;
		expect(modMsg.base).toBe("modules/pod");
		expect(modMsg.html).toContain('data-qorpera-src="modules/pod/img/hero.png"');

		const askPort = (port: MessagePort) => {
			let nextId = 0;
			const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
			port.onmessage = (event) => {
				const data = event.data as Record<string, unknown>;
				const resolve = waiting.get(typeof data.id === "number" ? data.id : 0);
				if (resolve) {
					waiting.delete(data.id as number);
					resolve(data);
				}
			};
			return async (method: string, params: Record<string, unknown>) => {
				const idx = rawAnswers.length;
				const data = await new Promise<Record<string, unknown>>((resolve) => {
					const id = ++nextId;
					waiting.set(id, resolve);
					port.postMessage({ type: "qorpera-app-call", id, method, params });
				});
				return rawAnswers[idx] ?? data;
			};
		};

		const callModule = askPort(modPort);
		const modImgRes = await callModule("file", { path: "img/hero.png", base: "modules/pod" });
		expect(modImgRes.ok).toBe(true);
		expect(modImgRes.value).toBeInstanceOf(Blob);
		expect((modImgRes.value as Blob).type).toBe("image/png");
		expect((modImgRes.value as Blob).size).toBe(pngBytes.byteLength);

		const modLazyRes = await callModule("file", { path: "modules/pod/img/hero.png", base: "" });
		expect(modLazyRes.ok).toBe(true);
		expect(modLazyRes.value).toBeInstanceOf(Blob);

		const modJsonRes = await callModule("file", { path: "data.json", base: "modules/pod" });
		expect(modJsonRes.ok).toBe(true);
		expect((modJsonRes.value as Blob).type).toContain("application/json");

		const modEscape = await callModule("file", { path: "../../../identity/logo.svg", base: "modules/pod" });
		expect(modEscape.ok).toBe(false);

		const modListRes = (await callModule("list", { path: "modules/pod/img" })) as {
			ok: boolean;
			value?: { path: string; bytes: number }[];
		};
		expect(modListRes.ok).toBe(true);
		expect(modListRes.value).toEqual([
			{ name: "hero.png", path: "modules/pod/img/hero.png", kind: "file", bytes: pngBytes.byteLength },
		]);

		const artifactFrame = view.el.querySelector<HTMLIFrameElement>("iframe.studio-html-frame")!;
		const callArtifact = connectFrame(artifactFrame);
		const artIdx = rawAnswers.length;
		await callArtifact("file", { path: "pictures/shot.png", base: "" });
		const artImgRes = rawAnswers[artIdx]!;
		expect(artImgRes.ok).toBe(true);
		expect(artImgRes.value).toBeInstanceOf(Blob);
		expect((artImgRes.value as Blob).type).toBe("image/png");
		expect(await callArtifact("file", { path: "../other/secret.png", base: "" })).toMatchObject({ ok: false });

		expect(readBinary).toHaveBeenCalledTimes(3);
		life.abort();
		view.dispose();
		store.dispose();
	});

	it("mounts fullscreen module tell bar inside its dialog, cancels on close, and keeps inline tell out of unrelated dialogs", async () => {
		const origShowModal = HTMLDialogElement.prototype.showModal;
		const origShow = HTMLDialogElement.prototype.show;
		const origClose = HTMLDialogElement.prototype.close;
		HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
			this.setAttribute("open", "");
		};
		HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
		HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
			this.removeAttribute("open");
			this.dispatchEvent(new Event("close"));
		};
		const surface = strategySurface();
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [surface]),
				getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
			}),
		);
		const life = new AbortController();
		let view: SurfaceStudioView | undefined;
		try {
			await store.load();
			await store.openSurface(surface.slug);
			const startSession = vi.spyOn(store, "startSession").mockResolvedValue(session([]));
			const files: Record<string, string> = {
				[`${ROOT}/layout.json`]: JSON.stringify({
					schema: "qorpera.surface-layout/v1",
					tabs: [
						{
							id: "lab",
							title: "Lab",
							blocks: [{ type: "module", from: "sketch", heading: "Sketchpad" }],
						},
					],
				}),
				[`${ROOT}/sketch/index.html`]: "<!doctype html><p>Sketch module</p>",
			};
			view = new SurfaceStudioView({
				store,
				surface,
				signal: life.signal,
				baseFiles: files,
				timeSlice: false,
			});
			document.body.append(view.el);

			const unrelatedDialog = document.createElement("dialog");
			unrelatedDialog.setAttribute("open", "");
			document.body.append(unrelatedDialog);

			const inlineFrame = view.el.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!;
			expect(inlineFrame).not.toBeNull();
			const callInline = connectFrame(inlineFrame);

			const inlineTell = callInline("tell", { about: "Inline", text: "Inline note while other dialog open" });
			await vi.waitFor(() => expect(view!.el.querySelector(".studio-tell-bar")).not.toBeNull());
			expect(unrelatedDialog.querySelector(".studio-tell-bar")).toBeNull();
			view.el.querySelector<HTMLButtonElement>('[data-tell-act="cancel"]')!.click();
			expect(await inlineTell).toMatchObject({ ok: false });
			unrelatedDialog.remove();

			const expandBtn = view.el.querySelector<HTMLButtonElement>('[data-block="module"] button.studio-expand-btn')!;
			expect(expandBtn).not.toBeNull();
			expandBtn.click();

			const fsDialog = document.querySelector<HTMLDialogElement>("dialog.studio-fullscreen-dialog")!;
			expect(fsDialog).not.toBeNull();
			const fsFrame = fsDialog.querySelector<HTMLIFrameElement>("iframe.studio-module-frame.is-fullscreen")!;
			expect(fsFrame).not.toBeNull();
			const callFullscreen = connectFrame(fsFrame);

			void callFullscreen("tell", { about: "Fullscreen", text: "Draft from expanded view" });
			await vi.waitFor(() => expect(fsDialog.querySelector(".studio-tell-bar")).not.toBeNull());
			expect(view.el.querySelector(".studio-tell-bar")).toBeNull();
			expect(await callInline("tell", { text: "Blocked while fullscreen note is open" })).toMatchObject({
				ok: false,
			});

			fsDialog.querySelector<HTMLButtonElement>(".surface-close")!.click();
			expect(document.querySelector(".studio-tell-bar")).toBeNull();
			expect(startSession).not.toHaveBeenCalled();

			const afterCloseTell = callInline("tell", { about: "Inline", text: "Allowed after fullscreen close" });
			await vi.waitFor(() => expect(view!.el.querySelector(".studio-tell-bar")).not.toBeNull());
			view.el.querySelector<HTMLButtonElement>('[data-tell-act="cancel"]')!.click();
			expect(await afterCloseTell).toMatchObject({ ok: false });
		} finally {
			life.abort();
			view?.dispose();
			store.dispose();
			HTMLDialogElement.prototype.showModal = origShowModal;
			HTMLDialogElement.prototype.show = origShow;
			HTMLDialogElement.prototype.close = origClose;
		}
	});

	it("keeps the tell bar and edited text for retry when startSession returns undefined and holds the guard during an in-flight dialog close", async () => {
		const origShowModal = HTMLDialogElement.prototype.showModal;
		const origShow = HTMLDialogElement.prototype.show;
		const origClose = HTMLDialogElement.prototype.close;
		HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
			this.setAttribute("open", "");
		};
		HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
		HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
			this.removeAttribute("open");
			this.dispatchEvent(new Event("close"));
		};
		const surface = strategySurface();
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [surface]),
				getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
			}),
		);
		const life = new AbortController();
		let view: SurfaceStudioView | undefined;
		try {
			await store.load();
			await store.openSurface(surface.slug);
			let resolveInFlight: ((value: ReturnType<typeof session> | undefined) => void) | undefined;
			const startSession = vi
				.spyOn(store, "startSession")
				.mockResolvedValueOnce(undefined)
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveInFlight = resolve;
						}),
				);
			const files: Record<string, string> = {
				[`${ROOT}/layout.json`]: JSON.stringify({
					schema: "qorpera.surface-layout/v1",
					tabs: [
						{
							id: "lab",
							title: "Lab",
							blocks: [{ type: "module", from: "sketch", heading: "Sketchpad" }],
						},
					],
				}),
				[`${ROOT}/sketch/index.html`]: "<!doctype html><p>Sketch module</p>",
			};
			view = new SurfaceStudioView({
				store,
				surface,
				signal: life.signal,
				baseFiles: files,
				timeSlice: false,
			});
			document.body.append(view.el);

			const inlineFrame = view.el.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!;
			const callInline = connectFrame(inlineFrame);

			let failedResolved = false;
			const failedTell = callInline("tell", { about: "Sketch", text: "Original note" }).then((answer) => {
				failedResolved = true;
				return answer;
			});
			await vi.waitFor(() => expect(view!.el.querySelector(".studio-tell-bar")).not.toBeNull());
			const input = view.el.querySelector<HTMLTextAreaElement>(".studio-tell-input")!;
			input.value = "Carefully edited member note";
			const sendBtn = view.el.querySelector<HTMLButtonElement>('[data-tell-act="send"]')!;
			const cancelBtn = view.el.querySelector<HTMLButtonElement>('[data-tell-act="cancel"]')!;
			sendBtn.click();

			await vi.waitFor(() => {
				const err = view!.el.querySelector<HTMLElement>(".studio-tell-error");
				expect(err && !err.hidden).toBe(true);
			});
			expect(failedResolved).toBe(false);
			expect(view.el.querySelector(".studio-tell-bar")).not.toBeNull();
			expect(input.value).toBe("Carefully edited member note");
			expect(input.disabled).toBe(false);
			expect(sendBtn.disabled).toBe(false);
			expect(cancelBtn.disabled).toBe(false);

			cancelBtn.click();
			expect(await failedTell).toMatchObject({ ok: false });

			view.el.querySelector<HTMLButtonElement>('[data-block="module"] button.studio-expand-btn')!.click();
			const fsDialog = document.querySelector<HTMLDialogElement>("dialog.studio-fullscreen-dialog")!;
			const fsFrame = fsDialog.querySelector<HTMLIFrameElement>("iframe.studio-module-frame.is-fullscreen")!;
			const callFullscreen = connectFrame(fsFrame);

			void callFullscreen("tell", { about: "Fullscreen", text: "In-flight note" });
			await vi.waitFor(() => expect(fsDialog.querySelector(".studio-tell-bar")).not.toBeNull());
			fsDialog.querySelector<HTMLButtonElement>('[data-tell-act="send"]')!.click();
			await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(2));

			fsDialog.querySelector<HTMLButtonElement>(".surface-close")!.click();
			expect(document.querySelector(".studio-tell-bar")).toBeNull();
			expect(await callInline("tell", { text: "Duplicate while in flight" })).toMatchObject({ ok: false });

			resolveInFlight!(session([]));
			await vi.waitFor(async () => {
				const res = await callInline("tell", { text: "Immediate post-send cooldown check" });
				expect(res.ok).toBe(false);
				expect(String(res.error)).toContain("moment ago");
			});
		} finally {
			life.abort();
			view?.dispose();
			store.dispose();
			HTMLDialogElement.prototype.showModal = origShowModal;
			HTMLDialogElement.prototype.show = origShow;
			HTMLDialogElement.prototype.close = origClose;
		}
	});

	it("does not open this surface's drawer when a send finishes after deactivation or parking", async () => {
		const surface = strategySurface();
		const other = summary();
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [surface, other]),
				getSurfaceWorkspace: vi.fn(async (surfaceId) =>
					workspace([], { surface: surfaceId === surface.id ? surface : other }),
				),
			}),
		);
		await store.load();
		await store.openSurface(surface.slug);
		let resolveDeactivated: ((value: ReturnType<typeof session> | undefined) => void) | undefined;
		let resolveParked: ((value: ReturnType<typeof session> | undefined) => void) | undefined;
		vi.spyOn(store, "startSession")
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveDeactivated = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveParked = resolve;
					}),
			);
		const files: Record<string, string> = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{
						id: "lab",
						title: "Lab",
						blocks: [{ type: "module", from: "sketch", heading: "Sketchpad" }],
					},
				],
			}),
			[`${ROOT}/sketch/index.html`]: "<!doctype html><p>Sketch module</p>",
		};

		const life1 = new AbortController();
		const view1 = new SurfaceStudioView({
			store,
			surface,
			signal: life1.signal,
			baseFiles: files,
			timeSlice: false,
		});
		document.body.append(view1.el);
		const call1 = connectFrame(view1.el.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!);
		const tell1 = call1("tell", { about: "Sketch", text: "Send before deactivate" });
		await vi.waitFor(() => expect(view1.el.querySelector(".studio-tell-bar")).not.toBeNull());
		view1.el.querySelector<HTMLButtonElement>('[data-tell-act="send"]')!.click();
		await vi.waitFor(() => expect(resolveDeactivated).toBeDefined());

		view1.deactivate();
		resolveDeactivated!(session([]));
		expect(await tell1).toMatchObject({ ok: true, value: { sent: true } });
		expect(store.state.drawer).toBeUndefined();
		life1.abort();
		view1.dispose();

		await store.openSurface(surface.slug);
		const life2 = new AbortController();
		const view2 = new SurfaceStudioView({
			store,
			surface,
			signal: life2.signal,
			baseFiles: files,
			timeSlice: false,
		});
		document.body.append(view2.el);
		const call2 = connectFrame(view2.el.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!);
		const tell2 = call2("tell", { about: "Sketch", text: "Send before parking to another surface" });
		await vi.waitFor(() => expect(view2.el.querySelector(".studio-tell-bar")).not.toBeNull());
		view2.el.querySelector<HTMLButtonElement>('[data-tell-act="send"]')!.click();
		await vi.waitFor(() => expect(resolveParked).toBeDefined());

		store.clearActiveSurface(surface.id);
		store.openDrawer(other.id, "other-session-1");
		resolveParked!(session([]));
		expect(await tell2).toMatchObject({ ok: true, value: { sent: true } });
		expect(store.state.drawer).toEqual({ surfaceId: other.id, sessionId: "other-session-1" });

		life2.abort();
		view2.dispose();
		store.dispose();
	});

	it("renders empty-state guidance on the fresh Strategy Breakdowns tab instead of a blank grid", async () => {
		const { view, done } = await studio({});
		view.el.querySelector<HTMLButtonElement>('[data-tab="breakdowns"]')!.click();
		const grid = view.el.querySelector(".studio-grid");
		expect(grid).not.toBeNull();
		expect(grid!.children.length).toBeGreaterThan(0);
		done();
	});

	it("disposes active ECharts hosts when switching tabs or entering Compare mode", async () => {
		const surface = strategySurface();
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [surface]),
				getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
			}),
		);
		await store.load();
		await store.openSurface(surface.slug);
		const life = new AbortController();
		const view = new SurfaceStudioView({
			store,
			surface,
			signal: life.signal,
			baseFiles: strategyFiles(),
			timeSlice: false,
		});
		document.body.append(view.el);

		view.el.querySelector<HTMLButtonElement>('[data-tab="economics"]')!.click();
		await vi.waitFor(() => {
			const host = view.el.querySelector<HTMLElement>(".studio-econ-chart-host");
			expect(host && getInstanceByDom(host)).toBeTruthy();
		});
		const oldHost = view.el.querySelector<HTMLElement>(".studio-econ-chart-host")!;
		expect(getInstanceByDom(oldHost)).toBeTruthy();

		view.el.querySelector<HTMLButtonElement>('[data-tab="plan"]')!.click();
		expect(getInstanceByDom(oldHost)).toBeUndefined();

		view.el.querySelector<HTMLButtonElement>('[data-tab="economics"]')!.click();
		await vi.waitFor(() => {
			const host = view.el.querySelector<HTMLElement>(".studio-econ-chart-host");
			expect(host && getInstanceByDom(host)).toBeTruthy();
		});
		const compareHost = view.el.querySelector<HTMLElement>(".studio-econ-chart-host")!;
		store.setMode("compare");
		view.update();
		expect(getInstanceByDom(compareHost)).toBeUndefined();

		life.abort();
		view.dispose();
		store.dispose();
	});

	it("does not double-advance when audio.play rejects alongside audio.onerror and does not re-run actions on unmute", async () => {
		vi.useFakeTimers();
		try {
			const caption1 = "First beat text.";
			let hash = 0x811c9dc5;
			for (const byte of new TextEncoder().encode(caption1)) {
				hash ^= byte;
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
			const clipHash = hash.toString(16).padStart(8, "0");
			const clipRef: StudioBinaryRef = {
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: 16,
				mediaType: "audio/mp4",
			};
			const revokeObjectURL = vi.fn();
			vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:tour"), revokeObjectURL }));
			let failPlay = true;
			const audioRef: { current: { onended: (() => void) | null } | null } = { current: null };
			vi.stubGlobal(
				"Audio",
				class {
					preload = "";
					src = "";
					onended: (() => void) | null = null;
					onerror: (() => void) | null = null;
					play = vi.fn(() => {
						audioRef.current = this;
						if (failPlay) {
							this.onerror?.();
							return Promise.reject(new Error("blocked"));
						}
						return Promise.resolve();
					});
					pause = vi.fn();
					removeAttribute = vi.fn();
				},
			);
			const tourDoc = {
				title: "Walkthrough",
				beats: [
					{ id: "b1", tab: "plan", focus: "plays:verdict", say: caption1, action: { expand: "dealers" } },
					{ id: "b2", tab: "plan", focus: "play:dealers", say: "Second beat." },
					{ id: "b3", tab: "plan", focus: "play:drivers", say: "Third beat." },
				],
			};
			const { view, tour, control, done } = await studio(
				{
					...strategyFiles(),
					...file("tour.json", tourDoc),
					...file("voice/clips.json", { clips: [{ caption: clipHash, file: `${clipHash}.mp4`, seconds: 2 }] }),
				},
				{
					baseBinaries: { [`${ROOT}/voice/${clipHash}.mp4`]: clipRef },
					readBinary: async () => new Uint8Array([1, 2]),
				},
			);
			const toggleBtn = view.el.querySelector<HTMLButtonElement>('[data-play="dealers"] .studio-play-toggle')!;
			const toggleSpy = vi.spyOn(toggleBtn, "click");
			tour().querySelector<HTMLButtonElement>(".studio-tour-launch")!.click();
			await vi.advanceTimersByTimeAsync(100);
			expect(revokeObjectURL).toHaveBeenCalled();
			expect(toggleSpy).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(4500);
			expect(text(tour().querySelector(".studio-tour-step"))).toContain("2/3");

			failPlay = false;
			control("Previous step").click();
			await vi.advanceTimersByTimeAsync(100);
			const clicksBeforeToggle = toggleSpy.mock.calls.length;
			control("Mute voice").click();
			control("Unmute voice").click();
			await vi.advanceTimersByTimeAsync(50);
			expect(toggleSpy).toHaveBeenCalledTimes(clicksBeforeToggle);
			audioRef.current?.onended?.();
			await vi.advanceTimersByTimeAsync(600);
			expect(text(tour().querySelector(".studio-tour-step"))).toContain("2/3");
			done();
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("mounts Money Flow Sankey cleanly even with colliding or duplicate stream IDs", () => {
		const host = document.createElement("div");
		document.body.append(host);
		const life = new AbortController();
		const mount = mountMoneyFlowChart(
			host,
			life.signal,
			{
				revenue: 100,
				left: [
					{ id: "__hub__", label: "Gross revenue", kind: "income", size: 80, signed: 80 },
					{ id: "shortfall", label: "Shortfall", kind: "shortfall", size: 20, signed: -20 },
				],
				right: [
					{ id: "shortfall", label: "Platform cost", kind: "cost", size: 40, signed: 40 },
					{ id: "net", label: "Fulfillment", kind: "cost", size: 30, signed: 30 },
					{ id: "net", label: "Other cost", kind: "cost", size: 30, signed: 30 },
				],
			},
			{
				hub: "Money in",
				money: (v) => `${v}`,
				percent: (r) => `${Math.round(r * 100)}%`,
				share: (r) => `${Math.round(r * 100)}%`,
			},
		);
		expect(mount.disposed()).toBe(false);
		expect(getInstanceByDom(host)).toBeTruthy();
		mount.dispose();
		expect(mount.disposed()).toBe(true);
		life.abort();
	});
});
