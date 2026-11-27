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
	codeWords,
	columnTexts,
	figureText,
	isRefusal,
	isUnconnected,
	pickFigure,
	previousSource,
	type SurfaceAskState,
	SurfaceAsks,
	type SurfaceLiveHosts,
	withPrevious,
	withUnit,
} from "../src/app/views/surface-blocks/live.ts";
import { SurfaceLayoutView } from "../src/app/views/surface-layout-view.ts";
import { setLanguagePreference, setTimeZonePreference } from "../src/ui/preferences.ts";
import { fakeClient, storeWith, summary } from "./surface-fixtures.ts";

const ROOT = "surfaces/analytics";
const HTML_PAGES: StudioHtmlPages = {
	frame: () => document.createElement("iframe"),
	linksChanged: () => false,
};

function cellText(value: unknown): string | undefined {
	return columnTexts([value], true).texts[0];
}

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
	HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
		this.removeAttribute("open");
	};
});

afterEach(() => {
	setLanguagePreference("en");
	setTimeZonePreference("system");
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
		expect(figureText("0800")).toBe("0800");
		expect(cellText("10042")).toBe("10042");
		expect(cellText(2026)).toBe("2026");
		expect(cellText("1234.567")).toBe((1234.57).toLocaleString("en"));
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

	it("asks again on the next plan after a first call failed, and tells the earlier followers", async () => {
		const life = new AbortController();
		let calls = 0;
		const numbers = new FakeLive(async () => {
			calls += 1;
			if (calls <= 2) throw new Error("did not answer (502)");
			return NUMBERS["orders-now"]!;
		});
		const asks = new SurfaceAsks({ numbers }, life.signal);
		const seen: SurfaceAskState["state"][] = [];
		asks
			.handle({ ask: "qorpera/orders-now", pick: "to_pack" })
			.follow((state) => seen.push(state.state), life.signal);
		await settle();
		expect(seen).toEqual(["loading", "unavailable"]);
		const again = asks.handle({ ask: "qorpera/orders-now", pick: "to_pack" });
		expect(again.state.state).toBe("loading");
		again.follow(() => undefined, life.signal);
		await settle();
		expect(seen).toEqual(["loading", "unavailable", "loading", "answered"]);
		expect(asks.handle({ ask: "qorpera/orders-now", pick: "to_pack" }).state.state).toBe("answered");
		expect(calls).toBe(3);

		const locked = new SurfaceAsks({ numbers: numbersLive(["money-balance"]) }, life.signal);
		locked.handle({ ask: "qorpera/money-balance", pick: "balance" }).follow(() => undefined, life.signal);
		await settle();
		expect(locked.handle({ ask: "qorpera/money-balance", pick: "balance" }).state.state).toBe("refused");
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

	it("draws a pushed answer into the same chart, also while it is shown large", async () => {
		const life = new AbortController();
		const numbers = numbersLive();
		const root = mount(planOf(layoutView({ numbers }, life.signal), NOW_LAYOUT));
		await settle();
		const host = root.querySelector<HTMLElement>(".studio-chart-host")!;
		await chartOption(host);
		root.querySelector<HTMLButtonElement>('[data-block="chart"] [data-act="studio-expand"]')!.click();
		const wide = await vi.waitFor(
			() => {
				const found = document.querySelector<HTMLElement>(".studio-chart-host.is-fullscreen");
				expect(found && getInstanceByDom(found)).toBeTruthy();
				return found!;
			},
			{ timeout: 5_000, interval: 10 },
		);
		const days = numbers.watches.find((watch) => watch.asked.question === "orders-days")!;
		days.push(
			days.id,
			answer(
				["day", "orders"],
				[
					["2026-11-25", 7],
					["2026-11-26", 13],
				],
				"e2",
			),
		);
		const values = (option: Awaited<ReturnType<typeof chartOption>>) =>
			option.series[0]?.data?.map((point) => (point as { value?: unknown }).value ?? point);
		expect(root.querySelector(".studio-chart-host")).toBe(host);
		expect(host.classList.contains("is-loading")).toBe(false);
		expect(values(await chartOption(host))).toEqual([7, 13]);
		expect(getInstanceByDom(wide)).toBeTruthy();
		expect(values(await chartOption(wide))).toEqual([7, 13]);
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

	it("keeps answers across re-plans, asks a failed question again, and lets go of one the layout no longer names", async () => {
		const life = new AbortController();
		const numbers = numbersLive();
		const view = layoutView({ numbers }, life.signal);
		mount(planOf(view, NOW_LAYOUT));
		await settle();
		const watched = numbers.watches.map((watch) => watch.asked.question);
		const again = mount(planOf(view, NOW_LAYOUT));
		expect(again.querySelector(".studio-fact dd")?.textContent).toBe((48250).toLocaleString("en"));
		await settle();
		expect(numbers.watches.map((watch) => watch.asked.question)).toEqual([...watched, "money-balance"]);
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
							["/order/0042", "0042"],
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
			"1200",
			"/shop",
			"300",
			"/order/0042",
			"0042",
		]);
		life.abort();
	});
});

describe("units and the previous days", () => {
	it("writes a unit after a figure and finds the previous range of days", () => {
		expect(withUnit("184.339", "kr.")).toBe("184.339 kr.");
		expect(withUnit("12", undefined)).toBe("12");
		const source = { ask: "qorpera/orders-days", x: "day", y: "orders", against: "previous" } as const;
		const shaped = answerChart(NUMBERS["orders-days"]!, source)!;
		expect(shaped.days).toEqual({ first: "2026-11-24", last: "2026-11-26", count: 3 });
		expect(previousSource(source, shaped.days)?.params).toEqual({ from: "2026-11-21", to: "2026-11-23" });
		expect(previousSource({ ...source, against: undefined }, shaped.days)).toBeNull();
		const months = answerChart(answer(["month", "n"], [["2026-10", 1]]), { ask: "a/b", x: "month", y: "n" });
		expect(months?.days).toBeUndefined();

		const earlier = answerChart(
			answer(
				["day", "orders"],
				[
					["2026-11-21", 2],
					["2026-11-22", "4"],
				],
			),
			source,
		);
		const doc = withPrevious(shaped, earlier, "Previous 3 days");
		expect(doc.series?.map((series) => series.name)).toEqual(["Orders", "Previous 3 days"]);
		expect(doc.series?.[1]?.data).toEqual([2, 4, null]);
		expect(withPrevious(shaped, null, "Previous 3 days")).toBe(shaped.doc);
	});

	it("draws units on live figures and the previous days in the compare colour, quietly without them", async () => {
		const life = new AbortController();
		const previousOrders = answer(
			["day", "orders"],
			[
				["2026-11-21", 3],
				["2026-11-22", 4],
				["2026-11-23", 6],
			],
		);
		const make = (refuse: boolean) =>
			new FakeLive(async (asked) => {
				if (asked.params.from !== undefined) {
					if (refuse) throw refusal("qorpera/orders-days");
					return previousOrders;
				}
				const found = NUMBERS[asked.question];
				if (!found) throw new Error("did not answer (502)");
				return found;
			});
		const layout = {
			schema: SURFACE_LAYOUT_SCHEMA,
			colors: { preset: "bright" },
			tabs: [
				{
					id: "now",
					title: "Now",
					blocks: [
						{
							type: "facts",
							id: "f",
							items: [
								{ label: "Sales today", from: { ask: "qorpera/orders-now", pick: "sales_today", unit: "kr." } },
							],
						},
						{
							type: "chart",
							id: "pulse",
							from: { ask: "qorpera/orders-days", x: "day", y: "orders", against: "previous" },
						},
					],
				},
			],
		};
		const numbers = make(false);
		const view = layoutView({ numbers }, life.signal);
		const root = mount(planOf(view, layout));
		await settle();
		expect(root.querySelector(".studio-fact dd")?.textContent).toBe(`${(48250).toLocaleString("en")} kr.`);
		let option = await chartOption(root.querySelector<HTMLElement>(".studio-chart-host")!);
		await vi.waitFor(async () => {
			option = await chartOption(root.querySelector<HTMLElement>(".studio-chart-host")!);
			expect(option.series).toHaveLength(2);
		});
		expect(option.series.map((series) => series.name)).toEqual(["Orders", "Previous 3 days"]);
		expect(option.series[1]?.itemStyle?.color).toBe("#999999");
		expect(option.series[0]?.itemStyle?.color).toBe(SURFACE_OKABE_ITO[0]);
		expect(numbers.queries.map((asked) => asked.params)).toEqual([{ from: "2026-11-21", to: "2026-11-23" }]);
		expect(numbers.watches.every((watch) => watch.asked.params.from === undefined)).toBe(true);

		mount(planOf(view, layout));
		await settle();
		expect(numbers.queries).toHaveLength(1);

		const refused = mount(planOf(layoutView({ numbers: make(true) }, life.signal), layout));
		await settle();
		const plain = await chartOption(refused.querySelector<HTMLElement>(".studio-chart-host")!);
		expect(plain.series.map((series) => series.name)).toEqual(["Orders"]);
		expect(refused.querySelector(".studio-home-locked")).toBeNull();
		life.abort();
	});

	it("writes the unit after each figure of a live facts.from", async () => {
		const life = new AbortController();
		const data = new FakeLive(async () => answer(["revenue", "orders"], [[1200, 3]]));
		const layout = {
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{ id: "now", title: "Now", blocks: [{ type: "facts", id: "f", from: { ask: "shop/today", unit: "kr." } }] },
			],
		};
		const root = mount(planOf(layoutView({ data }, life.signal), layout));
		await settle();
		expect([...root.querySelectorAll(".studio-fact dd")].map((dd) => dd.textContent)).toEqual([
			`${(1200).toLocaleString("en")} kr.`,
			"3 kr.",
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

function notConnected(what: string): Error {
	return Object.assign(
		new Error(`Not connected: ${what} once card payments are connected or an order is added by hand`),
		{
			status: 400,
		},
	);
}

describe("a question whose source is not connected", () => {
	it("tells it apart from a refusal, asks no fallback query, and asks again on the next plan", async () => {
		expect(isUnconnected(notConnected("orders count"))).toBe(true);
		expect(isUnconnected(new Error("  Not connected: visits count once the site is published"))).toBe(true);
		expect(isUnconnected(new Error("Bank is not connected"))).toBe(false);
		expect(isUnconnected("Not connected: x")).toBe(false);
		expect(isRefusal(notConnected("orders count"))).toBe(false);

		const life = new AbortController();
		let connected = false;
		const numbers = new FakeLive(async () => {
			if (!connected) throw notConnected("orders count");
			return NUMBERS["orders-now"]!;
		});
		const asks = new SurfaceAsks({ numbers }, life.signal);
		const seen: SurfaceAskState["state"][] = [];
		asks
			.handle({ ask: "qorpera/orders-now", pick: "to_pack" })
			.follow((state) => seen.push(state.state), life.signal);
		await settle();
		expect(seen).toEqual(["loading", "unconnected"]);
		expect(numbers.queries).toHaveLength(0);
		connected = true;
		const again = asks.handle({ ask: "qorpera/orders-now", pick: "to_pack" });
		expect(again.state.state).toBe("loading");
		again.follow(() => undefined, life.signal);
		await settle();
		expect(seen).toEqual(["loading", "unconnected", "loading", "answered"]);
		life.abort();
	});

	it("draws a faint dash on figures and a Not connected yet home on charts and tables, in Danish too", async () => {
		const life = new AbortController();
		const numbers = new FakeLive(async (asked) => {
			if (asked.question.startsWith("orders-")) throw notConnected("orders count");
			const found = NUMBERS[asked.question];
			if (!found) throw new Error("did not answer (502)");
			return found;
		});
		const layout = {
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
						{ type: "facts", id: "g", from: { ask: "qorpera/orders-now" }, take: 2 },
						{ type: "chart", id: "c", from: { ask: "qorpera/orders-days", x: "day", y: "orders" } },
						{ type: "table", id: "t", from: { ask: "qorpera/orders-states" } },
					],
				},
			],
		};
		const root = mount(planOf(layoutView({ numbers }, life.signal), layout));
		await settle();
		const dds = [...root.querySelectorAll<HTMLElement>(".studio-fact dd")];
		expect(dds.map((dd) => [dd.textContent, dd.className])).toEqual([
			["–", "is-unconnected"],
			["–", "is-unconnected"],
			["–", "is-unconnected"],
		]);
		expect(dds[0]!.title).toBe("Not connected yet");
		expect(root.querySelector(".studio-facts-live")?.getAttribute("title")).toBe("Not connected yet");
		expect([...root.querySelectorAll(".studio-home-unconnected")].map((home) => home.textContent)).toEqual([
			"Not connected yet",
			"Not connected yet",
		]);
		expect(root.querySelector(".studio-chart-host")).toBeNull();
		expect(root.querySelector(".studio-home-locked, .studio-home-unknown")).toBeNull();

		setLanguagePreference("da");
		const danish = mount(planOf(layoutView({ numbers }, life.signal), layout));
		await settle();
		expect(danish.querySelector(".studio-home-unconnected")?.textContent).toBe("Ikke forbundet endnu");
		expect(danish.querySelector<HTMLElement>(".studio-fact dd")?.title).toBe("Ikke forbundet endnu");
		life.abort();
	});
});

describe("live charts: estimates, whole numbers and hours", () => {
	it("names an estimate's series and draws it dashed, as a line and as bars", async () => {
		const days = answer(
			["day", "expected"],
			[
				["2026-11-25", 1200.5],
				["2026-11-26", 1300],
			],
		);
		const shaped = answerChart(days, { ask: "qorpera/money-expected", x: "day", y: "expected", estimate: true });
		expect(shaped?.doc.series?.map((series) => [series.name, series.estimate])).toEqual([
			["Expected (estimate)", true],
		]);
		expect(
			answerChart(days, { ask: "qorpera/money-expected", x: "day", y: "expected" })?.doc.series?.[0],
		).not.toHaveProperty("estimate");

		const life = new AbortController();
		const numbers = new FakeLive(async () => days);
		const layout = (kind: string) => ({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "now",
					title: "Now",
					blocks: [
						{
							type: "chart",
							id: "c",
							from: { ask: "qorpera/money-expected", x: "day", y: "expected", estimate: true, kind },
						},
					],
				},
			],
		});
		const line = mount(planOf(layoutView({ numbers }, life.signal), layout("line")));
		await settle();
		const lineOption = (await chartOption(line.querySelector<HTMLElement>(".studio-chart-host")!)) as unknown as {
			series: { name: string; lineStyle?: { type?: unknown } }[];
		};
		expect(lineOption.series[0]?.name).toBe("Expected (estimate)");
		expect(lineOption.series[0]?.lineStyle?.type).toEqual([6, 5]);
		const bars = mount(planOf(layoutView({ numbers }, life.signal), layout("bar")));
		await settle();
		const barOption = (await chartOption(bars.querySelector<HTMLElement>(".studio-chart-host")!)) as unknown as {
			series: { itemStyle?: { borderType?: unknown } }[];
		};
		expect(barOption.series[0]?.itemStyle?.borderType).toEqual([4, 3]);

		setLanguagePreference("da");
		expect(
			answerChart(days, { ask: "qorpera/money-expected", x: "day", y: "expected", estimate: true })?.doc.series?.[0]
				?.name,
		).toBe("Expected (skøn)");
		life.abort();
	});

	it("keeps a count axis on whole steps, also when every value is zero, and lets decimals be", async () => {
		const life = new AbortController();
		const zeros = answer(
			["day", "orders", "sales"],
			[
				["2026-11-25", 0, 0.5],
				["2026-11-26", 0, 1.25],
			],
		);
		const numbers = new FakeLive(async () => zeros);
		const axis = async (y: string) => {
			const root = mount(
				planOf(layoutView({ numbers }, life.signal), {
					schema: SURFACE_LAYOUT_SCHEMA,
					tabs: [
						{
							id: "now",
							title: "Now",
							blocks: [{ type: "chart", id: "c", from: { ask: "qorpera/orders-days", x: "day", y } }],
						},
					],
				}),
			);
			await settle();
			const option = (await chartOption(root.querySelector<HTMLElement>(".studio-chart-host")!)) as unknown as {
				yAxis: { minInterval?: number }[];
			};
			return option.yAxis[0]?.minInterval;
		};
		expect(await axis("orders")).toBe(1);
		expect(await axis("sales")).not.toBe(1);
		life.abort();
	});

	it("labels hours by their time, with the day only on the first label and at a new day", () => {
		const local = answer(
			["hour_local", "orders"],
			[
				["2026-11-25T23:00", 1],
				["2026-11-25T22:00", 0],
				["2026-11-26T00:00", 2],
				["2026-11-26T01:00", 3],
			],
		);
		const shaped = answerChart(local, { ask: "qorpera/orders-hours", x: "hour_local", y: "orders" });
		expect(shaped?.doc.categories).toEqual(["Nov 25 22:00", "23:00", "Nov 26", "01:00"]);
		expect(shaped?.days).toBeUndefined();

		setTimeZonePreference("Europe/Copenhagen");
		const zoned = answer(
			["hour", "orders"],
			[
				["2026-11-25T22:00:00Z", 1],
				["2026-11-25T23:00:00Z", 2],
				["2026-11-26T00:00:00Z", 3],
			],
		);
		expect(answerChart(zoned, { ask: "qorpera/orders-hours", x: "hour", y: "orders" })?.doc.categories).toEqual([
			"Nov 25 23:00",
			"Nov 26",
			"01:00",
		]);

		const midnights = answer(
			["day", "sales"],
			[
				["2026-11-25T00:00:00Z", 1],
				["2026-11-26T00:00:00Z", 2],
			],
		);
		const daily = answerChart(midnights, { ask: "shop/sales-days", x: "day", y: "sales" });
		expect(daily?.doc.categories).toEqual(["Nov 25", "Nov 26"]);
		expect(daily?.days).toEqual({ first: "2026-11-25", last: "2026-11-26", count: 2 });
	});
});

describe("live figures, table cells and the qorpera codes", () => {
	it("drops a figure's decimals from 100 up, keeps up to two below, and groups table numbers with their decimals", () => {
		expect(figureText(147579.4)).toBe((147579).toLocaleString("en"));
		expect(figureText("147579.40")).toBe((147579).toLocaleString("en"));
		expect(figureText(-250.75)).toBe("-251");
		expect(figureText(12.345)).toBe("12.35");
		expect(figureText("99.5")).toBe("99.5");
		expect(cellText(48250)).toBe((48250).toLocaleString("en"));
		expect(cellText(9999)).toBe("9999");
		expect(cellText("12345.5")).toBe((12345.5).toLocaleString("en"));
		expect(cellText(3.5)).toBe("3.5");
		expect(cellText("48250")).toBe("48250");
		expect(cellText("0042")).toBeUndefined();
		expect(cellText("Card")).toBeUndefined();
		expect(cellText(null)).toBeUndefined();
		setLanguagePreference("da");
		expect(figureText(147579.4)).toBe("147.579");
		expect(cellText(1234.5)).toBe("1.234,5");
	});

	it("groups every number in a column with a decimal part, with the same decimals, and leaves whole columns as written", () => {
		const money = columnTexts([8088, 1940, 12536, "90963.36", "5293.78", 438.55, null], true);
		expect(money.texts).toEqual(["8,088.00", "1,940.00", "12,536.00", "90,963.36", "5,293.78", "438.55", undefined]);
		expect(money.numeric).toBe(true);
		expect(columnTexts(["8088.00", "12536.00"], true).texts).toEqual(["8,088.00", "12,536.00"]);
		expect(columnTexts([1.5, 2], true).texts).toEqual(["1.5", "2.0"]);
		expect(columnTexts([0.3333, 1], true).texts).toEqual(["0.33", "1.00"]);
		expect(columnTexts([8088, 12536], true).texts).toEqual(["8,088", "12,536"]);
		expect(columnTexts([2025, 2026], true).texts).toEqual(["2025", "2026"]);
		expect(columnTexts(["10042", "9", 2026], true).texts).toEqual(["10042", "9", "2026"]);
		const codes = columnTexts(["10042", "0042", "9"], true);
		expect(codes.texts).toEqual(["10042", undefined, "9"]);
		expect(codes.numeric).toBe(false);
		expect(columnTexts(["Total", 12, ""], true).numeric).toBe(false);
		expect(columnTexts([12, "", null], true).numeric).toBe(true);
		expect(columnTexts([null, ""], true).numeric).toBe(false);
		expect(columnTexts([8088, 12536.5], false).texts).toEqual(["8,088.0", "12,536.5"]);
		expect(columnTexts([8088, 12536, "12.5"], false)).toEqual({
			texts: ["8088", "12536", undefined],
			numeric: false,
		});
		setLanguagePreference("da");
		expect(columnTexts([1234.5, 8], true).texts).toEqual(["1.234,50", "8,00"]);
	});

	it("right-aligns number columns and lets a wide table scroll inside its own frame", async () => {
		const life = new AbortController();
		const numbers = new FakeLive(async () =>
			answer(
				["source", "orders", "sales", "refunds"],
				[
					["stripe", 326, 115749.14, "5743.20"],
					["added", 6, 3072, 0],
				],
			),
		);
		const root = mount(
			planOf(
				layoutView({ numbers }, life.signal),
				{
					schema: SURFACE_LAYOUT_SCHEMA,
					tabs: [
						{
							id: "sales",
							title: "Sales",
							blocks: [
								{
									type: "table",
									id: "t",
									from: { ask: "qorpera/orders-sources" },
									heading: "Card or by hand?",
								},
								{ type: "table", id: "s", from: "plan.json#/months", heading: "The plan" },
							],
						},
					],
				},
				{
					files: {
						[`${ROOT}/plan.json`]: JSON.stringify({
							months: [
								{ month: "Jan", year: 2027, target: 8088 },
								{ month: "Feb", year: 2027, target: 12536.25 },
							],
						}),
					},
				},
			),
		);
		await settle();
		const table = root.querySelector(
			'[data-block="table"] .studio-table-wrap > .studio-table-scroll > .studio-table',
		)!;
		expect(table).toBeTruthy();
		expect([...table.querySelectorAll("th")].map((cell) => cell.className)).toEqual([
			"",
			"is-num",
			"is-num",
			"is-num",
		]);
		expect(
			[...table.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent)),
		).toEqual([
			["Card payments", "326", "115,749.14", "5,743.20"],
			["Added by hand", "6", "3,072.00", "0.00"],
		]);
		expect([...table.querySelectorAll("tbody tr:first-child td")].map((cell) => cell.className)).toEqual([
			"",
			"is-num",
			"is-num",
			"is-num",
		]);
		const plan = root.querySelectorAll('[data-block="table"]')[1]!;
		expect(plan.querySelector(".studio-table-scroll > .studio-table")).toBeTruthy();
		expect([...plan.querySelectorAll("th")].map((cell) => cell.className)).toEqual(["", "is-num", "is-num"]);
		expect(
			[...plan.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent)),
		).toEqual([
			["Jan", "2027", "8,088.00"],
			["Feb", "2027", "12,536.25"],
		]);
		life.abort();
	});

	it("says the qorpera codes in words by question and column, and leaves other databases as written", () => {
		const states = { ask: "qorpera/orders-states" };
		expect(codeWords(states, "state", "on_the_way")).toBe("On the way");
		expect(codeWords(states, "state", "paid")).toBe("Paid");
		expect(codeWords(states, "state", "toString")).toBeUndefined();
		expect(codeWords(states, "orders", "paid")).toBeUndefined();
		expect(codeWords({ ask: "qorpera/orders-sources" }, "source", "added")).toBe("Added by hand");
		expect(codeWords({ ask: "qorpera/orders-now" }, "stripe", "none")).toBe("Not connected");
		expect(codeWords({ ask: "qorpera/money-now" }, "state", "current")).toBe("Up to date");
		expect(codeWords({ ask: "qorpera/money-now" }, "bank", "current")).toBeUndefined();
		expect(codeWords({ ask: "shop/orders-states" }, "state", "paid")).toBeUndefined();
		expect(codeWords({ ask: "qorpera/money-kinds" }, "kind", 3)).toBeUndefined();
		setLanguagePreference("da");
		expect(codeWords(states, "state", "on_the_way")).toBe("På vej");
		expect(codeWords({ ask: "qorpera/money-kinds" }, "kind", "fees")).toBe("Kort- og app-gebyrer");
	});

	it("draws the words in chart categories, series names, table cells and figures", async () => {
		const kinds = answer(
			["direction", "kind", "amount", "count"],
			[
				["in", "all", 5000, null],
				["out", "salaries", 3000, null],
				["out", "fees", 120.4, null],
			],
		);
		const byKind = answerChart(kinds, { ask: "qorpera/money-kinds", x: "kind", y: "amount", series: "direction" });
		expect(byKind?.doc.categories).toEqual(["All", "Salaries", "Card and app fees"]);
		expect(byKind?.doc.series?.map((series) => series.name)).toEqual(["Money in", "Money out"]);
		expect(byKind?.keys).toEqual(["in", "out"]);
		expect(byKind?.categoryKeys).toEqual(["all", "salaries", "fees"]);

		const life = new AbortController();
		const numbers = new FakeLive(async (asked) => {
			if (asked.question === "orders-states") {
				return answer(
					["state", "orders", "amount"],
					[
						["paid", 2, "12500.50"],
						["on_the_way", 1, 300],
					],
				);
			}
			return answer(["stripe", "orders_today"], [["waiting", 0]]);
		});
		const root = mount(
			planOf(layoutView({ numbers }, life.signal), {
				schema: SURFACE_LAYOUT_SCHEMA,
				tabs: [
					{
						id: "now",
						title: "Now",
						blocks: [
							{
								type: "facts",
								id: "f",
								items: [{ label: "Card payments", from: { ask: "qorpera/orders-now", pick: "stripe" } }],
							},
							{ type: "table", id: "t", from: { ask: "qorpera/orders-states" } },
						],
					},
				],
			}),
		);
		await settle();
		expect(root.querySelector(".studio-fact dd")?.textContent).toBe("Waiting");
		expect([...root.querySelectorAll(".studio-table td")].map((cell) => cell.textContent)).toEqual([
			"Paid",
			"2",
			"12,500.50",
			"On the way",
			"1",
			"300.00",
		]);
		life.abort();
	});
});

describe("pie colours by a qorpera code", () => {
	it("colours a slice by its code whether the member reads it in English or Danish", async () => {
		const life = new AbortController();
		const numbers = new FakeLive(async () =>
			answer(
				["state", "orders", "amount"],
				[
					["paid", 4, 100],
					["cancelled", 1, 20],
				],
			),
		);
		const layout = {
			schema: SURFACE_LAYOUT_SCHEMA,
			colors: { preset: "calm" },
			tabs: [
				{
					id: "now",
					title: "Now",
					blocks: [
						{
							type: "chart",
							id: "c",
							from: { ask: "qorpera/orders-states", x: "state", y: "orders", kind: "pie" },
							colors: { paid: "#00aa00", cancelled: "#ff0000" },
						},
					],
				},
			],
		};
		const slices = async () => {
			const root = mount(planOf(layoutView({ numbers }, life.signal), layout));
			await settle();
			const option = (await chartOption(root.querySelector<HTMLElement>(".studio-chart-host")!)) as unknown as {
				series: { data: { name: string; itemStyle?: { color?: string } }[] }[];
			};
			return option.series[0]!.data.map((slice) => [slice.name, slice.itemStyle?.color]);
		};
		expect(await slices()).toEqual([
			["Paid", "#00aa00"],
			["Cancelled", "#ff0000"],
		]);
		setLanguagePreference("da");
		expect(await slices()).toEqual([
			["Betalt", "#00aa00"],
			["Annulleret", "#ff0000"],
		]);
		life.abort();
	});
});
