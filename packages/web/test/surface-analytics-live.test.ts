// @vitest-environment jsdom
import type { CloudMemberDataAnswer, CloudMemberDataQuestion } from "@qorpera/cloud-client/cloud-member-data";
import { SURFACE_LAYOUT_SCHEMA, SURFACE_OKABE_ITO, type SurfaceSummary } from "@qorpera/contracts";
import { getInstanceByDom } from "echarts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyLiveSource } from "../src/app/interface-apps.ts";
import type { StudioHtmlPages } from "../src/app/views/surface-blocks/artifacts.ts";
import {
	answerChart,
	answerNumber,
	answerRecords,
	askKey,
	askQuestion,
	figureText,
	isRefusal,
	pickFigure,
	type SurfaceAskState,
	SurfaceAsks,
	type SurfaceLiveHosts,
} from "../src/app/views/surface-blocks/live.ts";
import { SurfaceLayoutView } from "../src/app/views/surface-layout-view.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fakeClient, storeWith, summary } from "./surface-fixtures.ts";

const ROOT = "surfaces/analytics";
const HTML_PAGES: StudioHtmlPages = {
	frame: () => document.createElement("iframe"),
	linksChanged: () => false,
};

function answer(columns: string[], rows: unknown[][], etag = "e1"): CloudMemberDataAnswer {
	return { columns, rows, more: false, etag, asOf: "2026-11-26T10:00:00Z" };
}

function refusal(question: string): Error {
	return Object.assign(new Error(`No question ${question} that you may read`), { status: 404 });
}

interface Watching {
	readonly asked: CloudMemberDataQuestion;
	readonly push: (watch: number, answer: CloudMemberDataAnswer) => void;
	readonly id: number;
}

class FakeLive implements CompanyLiveSource {
	readonly watches: Watching[] = [];
	readonly queries: CloudMemberDataQuestion[] = [];
	readonly unwatched: number[] = [];
	readonly #reply: (asked: CloudMemberDataQuestion) => Promise<CloudMemberDataAnswer>;
	readonly #cap: number;

	constructor(reply: (asked: CloudMemberDataQuestion) => Promise<CloudMemberDataAnswer>, cap = 8) {
		this.#reply = reply;
		this.#cap = cap;
	}

	async query(asked: CloudMemberDataQuestion): Promise<CloudMemberDataAnswer> {
		this.queries.push(asked);
		return this.#reply(asked);
	}

	async watch(
		_page: AbortSignal,
		asked: CloudMemberDataQuestion,
		push: (watch: number, answer: CloudMemberDataAnswer) => void,
	): Promise<{ watch: number; answer: CloudMemberDataAnswer }> {
		if (this.watches.length >= this.#cap) throw new Error(`A page watches at most ${this.#cap} questions at once`);
		const id = this.watches.length + 1;
		this.watches.push({ asked, push, id });
		return { watch: id, answer: await this.#reply(asked) };
	}

	unwatch(_page: AbortSignal, watch: number): boolean {
		this.unwatched.push(watch);
		return true;
	}

	release(): void {}
}

const NUMBERS: Readonly<Record<string, CloudMemberDataAnswer>> = {
	"orders-now": answer(
		["orders_today", "sales_today", "to_pack"],
		[
			[1, "10", 0],
			[12, "48250", 3],
		],
	),
	"orders-days": answer(
		["day", "orders", "sales", "refunds"],
		[
			["2026-11-25", "7", 900, 40],
			["2026-11-24", 5, 700, null],
			["2026-11-26", 12, 1200, 0],
		],
	),
};

function numbersLive(refused: readonly string[] = []): FakeLive {
	return new FakeLive(async (asked) => {
		if (refused.includes(asked.question)) throw refusal(`qorpera/${asked.question}`);
		const found = NUMBERS[asked.question];
		if (!found) throw new Error("did not answer (502)");
		return found;
	});
}

function analyticsSurface(): SurfaceSummary {
	return summary({
		id: "22222222-2222-4222-8222-222222222260",
		slug: "analytics",
		title: "Analytics",
		archetype: "studio",
		kind: "dashboard",
		icon: "chart",
		sourceKind: "folder",
		repositoryKey: null,
		folderRoot: ROOT,
		siteSlug: null,
		previewMode: "studio_overlay",
		liveUrl: null,
	});
}

function layoutView(live: SurfaceLiveHosts | undefined, signal: AbortSignal): SurfaceLayoutView {
	return new SurfaceLayoutView({
		store: storeWith(fakeClient()),
		surface: analyticsSurface(),
		signal,
		baseFiles: () => ({}),
		...(live ? { live } : {}),
	});
}

function planOf(
	view: SurfaceLayoutView,
	layout: unknown,
	extra: {
		readonly files?: Record<string, string>;
		readonly company?: Record<string, string>;
		readonly tab?: string;
	} = {},
) {
	const files = { [`${ROOT}/layout.json`]: JSON.stringify(layout), ...extra.files };
	const company = extra.company ?? {};
	return view.plan({
		surface: analyticsSurface(),
		files,
		baseFiles: files,
		binaries: {},
		baseBinaries: {},
		company: { files: company, baseFiles: company, binaries: {}, baseBinaries: {} },
		briefSummary: "",
		starter: "analytics",
		tab: extra.tab ?? "now",
		legacyModel: undefined,
		htmlPages: HTML_PAGES,
	});
}

function mount(plan: ReturnType<SurfaceLayoutView["plan"]>): HTMLElement {
	const root = document.createElement("div");
	for (const task of plan.tasks) root.append(task.build());
	document.body.append(root);
	return root;
}

async function settle(): Promise<void> {
	for (let at = 0; at < 6; at += 1) await Promise.resolve();
}

async function chartOption(host: HTMLElement) {
	await vi.waitFor(() => expect(getInstanceByDom(host)?.getOption()).toBeTruthy(), { timeout: 5_000, interval: 10 });
	return getInstanceByDom(host)!.getOption() as {
		xAxis: { data?: string[] }[];
		series: { name?: string; data?: unknown[]; itemStyle?: { color?: string } }[];
		visualMap?: { inRange?: { color?: string[] } }[];
	};
}

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
});

afterEach(() => {
	setLanguagePreference("en");
	delete document.documentElement.dataset.theme;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("live asks: pure helpers", () => {
	it("splits the ask, keys it by database, question and sorted params, and tells a refusal apart", () => {
		const asked = askQuestion({ ask: "shop_db/top-products", params: { to: "b", from: "a" } });
		expect(asked).toEqual({ database: "shop_db", question: "top-products", params: { to: "b", from: "a" } });
		expect(askKey(asked!)).toBe(
			askKey({ database: "shop_db", question: "top-products", params: { from: "a", to: "b" } }),
		);
		expect(askKey(asked!)).not.toBe(askKey({ database: "qorpera", question: "top-products", params: {} }));
		expect(askQuestion({ ask: "no-slash" })).toBeUndefined();
		expect(isRefusal(refusal("qorpera/money-now"))).toBe(true);
		expect(isRefusal(new Error("No question qorpera/money-now that you may read"))).toBe(true);
		expect(isRefusal(Object.assign(new Error("did not answer (502)"), { status: 502 }))).toBe(false);
		expect(isRefusal(new TypeError("Failed to fetch"))).toBe(false);
	});

	it("reads rows as records, picks the last row's figure and formats digits as numbers", () => {
		const orders = NUMBERS["orders-now"]!;
		expect(answerRecords(orders)).toEqual([
			{ orders_today: 1, sales_today: "10", to_pack: 0 },
			{ orders_today: 12, sales_today: "48250", to_pack: 3 },
		]);
		expect(pickFigure(orders, "sales_today")).toBe("48250");
		expect(pickFigure(orders, "missing")).toBeUndefined();
		expect(pickFigure(answer(["a"], []), "a")).toBeUndefined();
		expect(answerNumber("-12.5")).toBe(-12.5);
		expect(answerNumber("12a")).toBeNull();
		expect(answerNumber(null)).toBeNull();
		expect(figureText("48250")).toBe((48250).toLocaleString("en"));
		expect(figureText(0)).toBe("0");
		expect(figureText("DKK")).toBe("DKK");
		expect(figureText(null)).toBeUndefined();
	});

	it("turns an answer into a chart: dates in order, one series per y, digit strings as numbers", () => {
		const shaped = answerChart(NUMBERS["orders-days"]!, {
			ask: "qorpera/orders-days",
			x: "day",
			y: ["orders", "refunds"],
		});
		expect(shaped?.keys).toEqual(["orders", "refunds"]);
		expect(shaped?.doc.kind).toBe("line");
		expect(shaped?.doc.categories).toEqual(["Nov 24", "Nov 25", "Nov 26"]);
		expect(shaped?.doc.series?.map((series) => series.name)).toEqual(["Orders", "Refunds"]);
		expect(shaped?.doc.series?.[0]?.data).toEqual([5, 7, 12]);
		expect(shaped?.doc.series?.[1]?.data).toEqual([null, 40, 0]);
	});

	it("splits one y by a series column, takes kind, stacked and unit, and keeps the newest 120 days", () => {
		const kinds = answer(
			["kind", "direction", "amount"],
			[
				["Card", "in", "300"],
				["Rent", "out", 120],
				["Card", "out", 15],
			],
		);
		const split = answerChart(kinds, {
			ask: "qorpera/money-kinds",
			x: "kind",
			y: "amount",
			series: "direction",
			kind: "bar",
			stacked: true,
			unit: "kr",
		});
		expect(split?.keys).toEqual(["in", "out"]);
		expect(split?.doc).toMatchObject({ kind: "bar", stacked: true, unit: "kr", categories: ["Card", "Rent"] });
		expect(split?.doc.series?.map((series) => series.data)).toEqual([
			[300, null],
			[15, 120],
		]);
		expect(
			answerChart(kinds, { ask: "qorpera/money-kinds", x: "kind", y: "amount", kind: "sparkle" } as never)?.doc.kind,
		).toBe("line");
		const pie = answerChart(kinds, {
			ask: "qorpera/money-kinds",
			x: "kind",
			y: "amount",
			series: "direction",
			kind: "pie",
		});
		expect(pie?.doc.series).toHaveLength(1);

		const days = Array.from({ length: 150 }, (_, index) => {
			const day = new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10);
			return [day, index];
		}).reverse();
		const long = answerChart(answer(["day", "visits"], days), { ask: "qorpera/site-days", x: "day", y: "visits" });
		expect(long?.doc.categories).toHaveLength(120);
		expect(long?.doc.series?.[0]?.data.at(0)).toBe(30);
		expect(long?.doc.series?.[0]?.data.at(-1)).toBe(149);
		expect(
			answerChart(answer(["day", "visits"], [["2026-11-01", "n/a"]]), { ask: "a/b", x: "day", y: "visits" }),
		).toBeNull();
		expect(answerChart(answer(["day"], []), { ask: "a/b", x: "day", y: "visits" })).toBeNull();
	});
});

describe("live asks: the page's cache", () => {
	it("watches once per question, takes pushed answers, falls back to one query past the cap, and lets go", async () => {
		const life = new AbortController();
		const numbers = new FakeLive(async () => NUMBERS["orders-now"]!, 1);
		const asks = new SurfaceAsks({ numbers }, life.signal);
		const seen: SurfaceAskState["state"][] = [];
		const render = new AbortController();
		const first = asks.handle({ ask: "qorpera/orders-now", pick: "to_pack" });
		const again = asks.handle({ ask: "qorpera/orders-now", pick: "sales_today" });
		expect(first.key).toBe(again.key);
		expect(first.state.state).toBe("loading");
		first.follow((state) => seen.push(state.state), render.signal);
		again.follow(() => undefined, render.signal);
		await settle();
		expect(numbers.watches).toHaveLength(1);
		expect(seen).toEqual(["loading", "answered"]);
		numbers.watches[0]!.push(1, answer(["to_pack"], [[9]], "e2"));
		expect(seen).toEqual(["loading", "answered", "answered"]);

		const other = asks.handle({ ask: "qorpera/orders-days", x: "day", y: "orders" });
		other.follow(() => undefined, render.signal);
		await settle();
		expect(numbers.queries.map((asked) => asked.question)).toEqual(["orders-days"]);
		expect(asks.handle({ ask: "qorpera/orders-days", x: "day", y: "orders" }).state.state).toBe("answered");

		asks.keep(new Set([other.key]));
		expect(numbers.unwatched).toEqual([1]);
		render.abort();
		life.abort();
	});

	it("says refused for a question the member may not read and unavailable without a source", async () => {
		const life = new AbortController();
		const asks = new SurfaceAsks({ numbers: numbersLive(["money-balance"]) }, life.signal);
		const locked = asks.handle({ ask: "qorpera/money-balance", pick: "balance" });
		let state: SurfaceAskState["state"] | undefined;
		locked.follow((next) => {
			state = next.state;
		}, life.signal);
		await settle();
		expect(state).toBe("refused");
		const broken = asks.handle({ ask: "qorpera/site-now", pick: "visits" });
		broken.follow((next) => {
			state = next.state;
		}, life.signal);
		await settle();
		expect(state).toBe("unavailable");
		expect(asks.handle({ ask: "shop/orders", pick: "n" }).state.state).toBe("unavailable");
		life.abort();
	});
});

const NOW_LAYOUT = {
	schema: SURFACE_LAYOUT_SCHEMA,
	tabs: [
		{
			id: "now",
			title: "Now",
			blocks: [
				{
					type: "facts",
					id: "figures",
					items: [
						{ label: "Sales today", from: { ask: "qorpera/orders-now", pick: "sales_today" } },
						{ label: "To pack", from: { ask: "qorpera/orders-now", pick: "to_pack" } },
						{ label: "In the bank", from: { ask: "qorpera/money-balance", pick: "balance" } },
						{ label: "Top product", from: { ask: "shop/top-products", pick: "name" } },
					],
				},
				{
					type: "chart",
					id: "pulse",
					from: { ask: "qorpera/orders-days", x: "day", y: "orders" },
					heading: "Orders",
				},
			],
		},
		{
			id: "money",
			title: "Money",
			blocks: [{ type: "chart", id: "balance", from: { ask: "qorpera/money-balance", x: "day", y: "balance" } }],
		},
	],
};

describe("live asks on the page", () => {
	it("draws loading marks while asking, without greying a tab, then fills figures and the chart in place", async () => {
		const life = new AbortController();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const numbers = new FakeLive(async (asked) => {
			await gate;
			const found = NUMBERS[asked.question];
			if (!found) throw refusal(`qorpera/${asked.question}`);
			return found;
		});
		const plan = planOf(layoutView({ numbers }, life.signal), NOW_LAYOUT);
		expect(
			[...plan.tabBar!.querySelectorAll(".studio-tab")].map((tab) => tab.classList.contains("is-empty")),
		).toEqual([false, false]);
		const root = mount(plan);
		const dds = () => [...root.querySelectorAll<HTMLElement>(".studio-fact dd")];
		expect(dds().map((dd) => dd.className)).toEqual(["is-loading", "is-loading", "is-loading", "is-unknown"]);
		expect(dds()[3]!.textContent).toBe("?");
		expect(root.querySelector(".studio-chart-host")?.classList.contains("is-loading")).toBe(true);
		expect(numbers.watches.map((watch) => watch.asked.question).sort()).toEqual([
			"money-balance",
			"orders-days",
			"orders-now",
		]);

		release!();
		await settle();
		expect(dds().map((dd) => dd.textContent)).toEqual([(48250).toLocaleString("en"), "3", "", "?"]);
		expect(dds()[0]!.title).toContain("As of");
		expect(dds()[2]!.classList.contains("is-locked")).toBe(true);
		expect(dds()[2]!.querySelector(".studio-fact-lock")?.getAttribute("aria-label")).toBe("Not shared with you");
		const host = root.querySelector<HTMLElement>(".studio-chart-host")!;
		const option = await chartOption(host);
		expect(option.xAxis[0]?.data).toEqual(["Nov 24", "Nov 25", "Nov 26"]);
		expect(option.series[0]?.data?.map((point) => (point as { value?: unknown }).value ?? point)).toEqual([5, 7, 12]);
		expect(root.querySelector('[data-block="chart"]')?.getAttribute("title")).toContain("As of");
		expect(root.textContent).not.toContain("qorpera");
		life.abort();
	});

	it("locks a chart the member may not read and shows ? where nothing can be asked", async () => {
		const life = new AbortController();
		const plan = planOf(layoutView({ numbers: numbersLive(["money-balance"]) }, life.signal), NOW_LAYOUT, {
			tab: "money",
		});
		const root = mount(plan);
		await settle();
		const locked = root.querySelector(".studio-home-locked");
		expect(locked?.textContent).toBe("Not shared with you");
		expect(locked?.querySelector("svg")).toBeTruthy();
		expect(root.querySelector(".studio-chart-host")).toBeNull();

		const offline = mount(planOf(layoutView(undefined, life.signal), NOW_LAYOUT));
		expect([...offline.querySelectorAll(".studio-fact dd")].map((dd) => dd.textContent)).toEqual([
			"?",
			"?",
			"?",
			"?",
		]);
		expect(offline.querySelector(".studio-home-unknown")?.textContent).toBe("?");
		life.abort();
	});

	it("keeps answers across re-plans and lets go of a question the layout no longer names", async () => {
		const life = new AbortController();
		const numbers = numbersLive();
		const view = layoutView({ numbers }, life.signal);
		mount(planOf(view, NOW_LAYOUT));
		await settle();
		const watched = numbers.watches.length;
		const again = mount(planOf(view, NOW_LAYOUT));
		expect(again.querySelector(".studio-fact dd")?.textContent).toBe((48250).toLocaleString("en"));
		expect(numbers.watches).toHaveLength(watched);
		const fewer = {
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "now",
					title: "Now",
					blocks: [
						{
							type: "facts",
							id: "f",
							items: [{ label: "To pack", from: { ask: "qorpera/orders-now", pick: "to_pack" } }],
						},
					],
				},
			],
		};
		planOf(view, fewer);
		const days = numbers.watches.find((watch) => watch.asked.question === "orders-days")!.id;
		expect(numbers.unwatched).toEqual([days]);
		life.abort();
	});

	it("fills a live table and facts from the last row", async () => {
		const life = new AbortController();
		const data = new FakeLive(async (asked) =>
			asked.question === "pages"
				? answer(
						["path", "views"],
						[
							["/", "1200"],
							["/shop", 300],
						],
					)
				: answer(["visits", "orders"], [[10, 2]]),
		);
		const layout = {
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "now",
					title: "Now",
					blocks: [
						{ type: "facts", id: "f", from: { ask: "shop/today" } },
						{
							type: "table",
							id: "t",
							from: { ask: "shop/pages" },
							columns: [
								{ key: "path", label: "Page" },
								{ key: "views", label: "Views" },
							],
							heading: "Most read pages",
						},
					],
				},
			],
		};
		const root = mount(planOf(layoutView({ data }, life.signal), layout));
		expect(root.querySelector(".studio-table.is-loading")).toBeTruthy();
		await settle();
		expect([...root.querySelectorAll(".studio-fact")].map((fact) => fact.textContent)).toEqual([
			"Visits10",
			"Orders2",
		]);
		expect([...root.querySelectorAll(".studio-table td")].map((cell) => cell.textContent)).toEqual([
			"/",
			(1200).toLocaleString("en"),
			"/shop",
			"300",
		]);
		life.abort();
	});
});

describe("chart colours from the layout", () => {
	const TOKENS = JSON.stringify({ colors: { accent: "#c0392b", sand: "#d9b382", ink: "#121212", paper: "#ffffff" } });
	const CHART = JSON.stringify({
		kind: "line",
		categories: ["Jan", "Feb"],
		series: [
			{ name: "Sales", data: [1, 2] },
			{ name: "Refunds", data: [0, 1] },
			{ name: "Fees", data: [1, 1] },
			{ name: "Fixed", color: "#123456", data: [2, 2] },
		],
	});
	const layoutWith = (colors: unknown, blockColors?: Record<string, string>) => ({
		schema: SURFACE_LAYOUT_SCHEMA,
		...(colors ? { colors } : {}),
		tabs: [
			{
				id: "now",
				title: "Now",
				blocks: [{ type: "chart", id: "c", from: "chart.json", ...(blockColors ? { colors: blockColors } : {}) }],
			},
		],
	});

	async function seriesColours(layout: unknown): Promise<(string | undefined)[]> {
		const life = new AbortController();
		const root = mount(
			planOf(layoutView(undefined, life.signal), layout, {
				files: { [`${ROOT}/chart.json`]: CHART },
				company: { "identity/tokens.json": TOKENS },
			}),
		);
		const option = await chartOption(root.querySelector<HTMLElement>(".studio-chart-host")!);
		life.abort();
		return option.series.map((series) => series.itemStyle?.color);
	}

	it("keeps today's palette without layout colours, and an explicit series colour always wins", async () => {
		expect(await seriesColours(layoutWith(undefined))).toEqual(["#d76f45", "#0f7a55", "#2b6cb0", "#123456"]);
	});

	it("uses the preset's series, a job, a hex and a binding from the chart block", async () => {
		expect(await seriesColours(layoutWith({ preset: "bright" }))).toEqual([
			SURFACE_OKABE_ITO[0],
			SURFACE_OKABE_ITO[1],
			SURFACE_OKABE_ITO[2],
			"#123456",
		]);
		const company = await seriesColours(
			layoutWith(
				{ preset: "company" },
				{ Sales: "main", Refunds: "#00ff00", Fees: "/identity/tokens.json#/colors/sand", Fixed: "#ffffff" },
			),
		);
		expect(company).toEqual(["#c0392b", "#00ff00", "#d9b382", "#123456"]);
		expect(await seriesColours(layoutWith(undefined, { Refunds: "down" }))).toEqual([
			"#d76f45",
			"#121212",
			"#2b6cb0",
			"#123456",
		]);
	});

	it("lifts the page's colours for the dark ground and paints a heatmap in main", async () => {
		document.documentElement.dataset.theme = "dark";
		const [first] = await seriesColours(layoutWith({ main: "#101010", preset: "one-colour" }));
		expect(first).not.toBe("#101010");
		expect(first).toMatch(/^#[0-9a-f]{6}$/);
		delete document.documentElement.dataset.theme;

		const life = new AbortController();
		const heat = JSON.stringify({
			kind: "heatmap",
			xCategories: ["Mon"],
			yCategories: ["9"],
			cells: [[0, 0, 4]],
		});
		const root = mount(
			planOf(layoutView(undefined, life.signal), layoutWith({ main: "#0072b2" }), {
				files: { [`${ROOT}/chart.json`]: heat },
			}),
		);
		const option = await chartOption(root.querySelector<HTMLElement>(".studio-chart-host")!);
		expect(option.visualMap?.[0]?.inRange?.color?.at(-1)).toBe("#0072b2");
		life.abort();
	});
});
