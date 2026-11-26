import { describe, expect, it } from "vitest";
import {
	describeSurfaceFormats,
	isSurfaceAskSource,
	liftSurfaceColorForDark,
	parseSurfaceLayout,
	readSurfaceLayout,
	resolveSurfaceChartColors,
	resolveSurfaceColors,
	resolveSurfaceSource,
	SURFACE_ASK_FORMAT,
	SURFACE_COLORS_FORMAT,
	SURFACE_DARK_GROUND,
	SURFACE_DARK_MIN_CONTRAST,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_OKABE_ITO,
	SURFACE_STARTER_LAYOUTS,
	type SurfaceAskSource,
	type SurfaceLayout,
	type SurfaceLayoutColors,
	splitSurfaceAsk,
	surfaceColorContrast,
	surfaceColorsForDark,
	surfaceStarterKind,
	surfaceStudioPage,
} from "../src/index.ts";
import { WireValueError } from "../src/wire-values.ts";

const SCHEMA = SURFACE_LAYOUT_SCHEMA;

function layoutWith(blocks: unknown[], colors?: unknown): unknown {
	return { schema: SCHEMA, ...(colors !== undefined && { colors }), tabs: [{ id: "main", title: "Main", blocks }] };
}

function refusal(value: unknown): string {
	try {
		parseSurfaceLayout(value);
	} catch (error) {
		expect(error).toBeInstanceOf(WireValueError);
		return (error as Error).message;
	}
	throw new Error("expected the layout to be refused");
}

function firstBlock(value: unknown): unknown {
	return parseSurfaceLayout(value).tabs[0]?.blocks[0];
}

const chart = (from: unknown, extra: Record<string, unknown> = {}) => ({ type: "chart", from, ...extra });

describe("an ask source", () => {
	it("is taken alone by chart.from, facts items, facts.from and table.from, keys in one order", () => {
		const ask = {
			series: "site",
			y: "visits",
			x: "day",
			params: { from: "2026-11-01", limit: 5 },
			ask: "qorpera/site-days",
		};
		const block = firstBlock(layoutWith([chart(ask)]));
		expect(JSON.stringify(block)).toBe(
			JSON.stringify({
				type: "chart",
				from: {
					ask: "qorpera/site-days",
					params: { from: "2026-11-01", limit: 5 },
					x: "day",
					y: "visits",
					series: "site",
				},
			}),
		);
		expect(
			firstBlock(layoutWith([chart({ ask: "qorpera/orders-days", x: "day", y: ["sales", "refunds"] })])),
		).toEqual({
			type: "chart",
			from: { ask: "qorpera/orders-days", x: "day", y: ["sales", "refunds"] },
		});
		expect(
			firstBlock(
				layoutWith([
					{
						type: "facts",
						items: [{ label: "Orders", from: { ask: "qorpera/orders-now", pick: "orders_today" } }],
					},
				]),
			),
		).toEqual({
			type: "facts",
			items: [{ label: "Orders", from: { ask: "qorpera/orders-now", pick: "orders_today" } }],
		});
		expect(firstBlock(layoutWith([{ type: "facts", from: { ask: "qorpera/orders-now" } }]))).toEqual({
			type: "facts",
			from: { ask: "qorpera/orders-now" },
			take: 4,
			skip: [],
		});
		expect(
			firstBlock(layoutWith([{ type: "table", from: { ask: "sales/top-customers", params: { n: null } } }])),
		).toEqual({ type: "table", from: { ask: "sales/top-customers", params: { n: null } } });
	});

	it.each<[string, unknown, string]>([
		[
			"on a field that does not ask",
			{ type: "spec_list", from: { ask: "qorpera/orders-now" } },
			'layout.tabs[0].blocks[0].from asks a question, which only chart.from, facts.from, facts items and table.from take; here a source is a binding or {"value": ...}',
		],
		[
			"on a card",
			{ type: "cards", items: [{ title: "A", from: { ask: "qorpera/orders-now" } }] },
			"layout.tabs[0].blocks[0].items[0].from asks a question, which only",
		],
		[
			"on a title line",
			{ type: "title", line: { ask: "qorpera/orders-now" } },
			"layout.tabs[0].blocks[0].line asks a question",
		],
		[
			"in a list of a field that does not ask",
			{ type: "spec_list", from: ["a.json", { ask: "qorpera/orders-now" }] },
			"layout.tabs[0].blocks[0].from[1] asks a question",
		],
		[
			"in a list of a field that asks",
			chart(["a.chart.json", { ask: "qorpera/orders-days", x: "day", y: "orders" }]),
			"layout.tabs[0].blocks[0].from[1] is an ask inside a list of sources; an ask stands alone, never in a list",
		],
		[
			"with a name that is not database/question",
			chart({ ask: "orders-days", x: "day", y: "orders" }),
			'layout.tabs[0].blocks[0].from.ask must be "<database>/<question>", as "qorpera/orders-days"',
		],
		["with a capital in its question", chart({ ask: "qorpera/Orders", x: "d", y: "o" }), ".from.ask must be"],
		[
			"with a key it does not take",
			chart({ ask: "qorpera/orders-days", x: "day", y: "orders", against: "last-month" }),
			"has a field that an ask does not take; its fields are ask, params, pick, x, y, series",
		],
		[
			"a chart without x",
			chart({ ask: "qorpera/orders-days", y: "orders" }),
			".from.x is missing; a chart's ask needs x and y",
		],
		["a chart without y", chart({ ask: "qorpera/orders-days", x: "day" }), ".from.y is missing"],
		[
			"a chart with pick",
			chart({ ask: "qorpera/orders-days", x: "day", y: "orders", pick: "day" }),
			".from.pick is not taken by a chart's ask; it takes x, y, series",
		],
		[
			"a series over many y",
			chart({ ask: "qorpera/site-days", x: "day", y: ["views", "visits"], series: "site" }),
			".from.series splits one y column",
		],
		[
			"nine y",
			chart({ ask: "a/b", x: "day", y: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
			".from.y must hold 1 to 8 entries",
		],
		["a y twice", chart({ ask: "a/b", x: "day", y: ["a", "a"] }), ".from.y names a column twice"],
		["an empty column", chart({ ask: "a/b", x: "", y: "a" }), ".from.x is empty"],
		[
			"a figure without pick",
			{ type: "facts", items: [{ label: "A", from: { ask: "qorpera/orders-now" } }] },
			"items[0].from.pick is missing; a figure's ask names the column it shows",
		],
		[
			"a figure with x",
			{ type: "facts", items: [{ label: "A", from: { ask: "qorpera/orders-now", pick: "a", x: "b" } }] },
			"items[0].from.x is not taken by a figure's ask; it takes pick",
		],
		[
			"a table with pick",
			{ type: "table", from: { ask: "qorpera/site-pages", pick: "path" } },
			".from.pick is not taken by table.from's ask (the answer's rows); it shows the answer's columns as they are",
		],
		[
			"params as a list",
			{ type: "table", from: { ask: "a/b", params: [1] } },
			".from.params must be an object of named values",
		],
		[
			"a param that is an object",
			{ type: "table", from: { ask: "a/b", params: { from: {} } } },
			".from.params.from must be text, a number, true, false or null",
		],
		[
			"a param name with a dash",
			{ type: "table", from: { ask: "a/b", params: { "a-b": 1 } } },
			".from.params.a-b is not a value's name",
		],
		[
			"a long param",
			{ type: "table", from: { ask: "a/b", params: { a: "x".repeat(201) } } },
			".from.params.a is longer than 200 chars",
		],
		[
			"seventeen params",
			{
				type: "table",
				from: { ask: "a/b", params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, i])) },
			},
			".from.params names more than 16 values",
		],
	])("is refused %s", (_name, block, problem) => {
		expect(refusal(layoutWith([block]))).toContain(problem);
	});

	it("lets a chart's ask name its look: kind, stacked and unit, in the ask's key order", () => {
		const ask = { unit: "kr.", stacked: true, kind: "bar", y: "amount", x: "kind", ask: "qorpera/money-kinds" };
		expect(JSON.stringify(firstBlock(layoutWith([chart(ask)])))).toBe(
			JSON.stringify({
				type: "chart",
				from: { ask: "qorpera/money-kinds", x: "kind", y: "amount", kind: "bar", stacked: true, unit: "kr." },
			}),
		);
		for (const kind of ["line", "area", "bar", "pie", "funnel"]) {
			expect(firstBlock(layoutWith([chart({ ask: "a/b", x: "d", y: "v", kind })]))).toMatchObject({
				from: { kind },
			});
		}
	});

	it.each<[string, unknown, string]>([
		[
			"a kind it does not draw",
			chart({ ask: "a/b", x: "d", y: "v", kind: "radar" }),
			".from.kind must be one of line, area, bar, pie, funnel",
		],
		["stacked as text", chart({ ask: "a/b", x: "d", y: "v", stacked: "yes" }), ".from.stacked must be true or false"],
		[
			"a long unit",
			chart({ ask: "a/b", x: "d", y: "v", unit: "kroner-per-day" }),
			".from.unit is longer than 12 chars",
		],
		[
			"a kind on a figure",
			{ type: "facts", items: [{ label: "A", from: { ask: "a/b", pick: "v", kind: "bar" } }] },
			"items[0].from.kind is not taken by a figure's ask; it takes pick",
		],
		[
			"a unit on a table",
			{ type: "table", from: { ask: "a/b", unit: "kr." } },
			".from.unit is not taken by table.from's ask",
		],
		[
			"stacked on facts.from",
			{ type: "facts", from: { ask: "a/b", stacked: true } },
			".from.stacked is not taken by facts.from's ask",
		],
	])("refuses a look %s", (_name, block, problem) => {
		expect(refusal(layoutWith([block]))).toContain(problem);
	});

	it("is told apart, split, and never resolved from files", () => {
		const ask: SurfaceAskSource = { ask: "qorpera/orders-now", pick: "orders_today" };
		expect(isSurfaceAskSource(ask)).toBe(true);
		expect(isSurfaceAskSource({ value: 1 })).toBe(false);
		expect(isSurfaceAskSource("a.json")).toBe(false);
		expect(splitSurfaceAsk("qorpera/orders-now")).toEqual({ database: "qorpera", question: "orders-now" });
		expect(splitSurfaceAsk("sales_2/top-10")).toEqual({ database: "sales_2", question: "top-10" });
		for (const bad of ["qorpera", "qorpera/", "/orders", "Qorpera/orders", "a/b/c", "1db/q", `a/${"q".repeat(61)}`]) {
			expect(splitSurfaceAsk(bad)).toBeNull();
		}
		expect(resolveSurfaceSource(ask, () => ({ orders_today: 3 }))).toEqual({ found: false, value: undefined });
	});
});

describe("layout colours", () => {
	it("parse closed: a preset, jobs, series, or a preset with jobs", () => {
		expect(parseSurfaceLayout(layoutWith([{ type: "artifacts" }], { preset: "bright" })).colors).toEqual({
			preset: "bright",
		});
		const own = {
			series: ["/identity/tokens.json#/colors/sand", "#abc"],
			down: "#b5543c",
			main: "/identity/tokens.json#/colors/sand",
			preset: "calm",
		};
		const parsed = parseSurfaceLayout(layoutWith([{ type: "artifacts" }], own));
		expect(Object.keys(parsed)).toEqual(["schema", "colors", "tabs"]);
		expect(JSON.stringify(parsed.colors)).toBe(
			JSON.stringify({
				preset: "calm",
				main: "/identity/tokens.json#/colors/sand",
				down: "#b5543c",
				series: ["/identity/tokens.json#/colors/sand", "#abc"],
			}),
		);
		expect(parseSurfaceLayout(layoutWith([{ type: "artifacts" }]))).not.toHaveProperty("colors");
	});

	it.each<[string, unknown, string]>([
		[
			"an unknown preset",
			{ preset: "loud" },
			"layout.colors.preset must be one of company, one-colour, calm, bright",
		],
		["nothing", {}, "layout.colors names no colours"],
		["an unknown job", { accent: "#fff" }, "layout.colors has a field that the layout's colours does not take"],
		["a whole file", { main: "/identity/tokens.json" }, 'layout.colors.main must be a colour "#rrggbb" or a binding'],
		["a word", { main: "red" }, "layout.colors.main must be a colour"],
		["a short hex", { up: "#12" }, 'layout.colors.up is not a colour; write "#rgb" or "#rrggbb"'],
		["an alpha hex", { up: "#11223344" }, "layout.colors.up is not a colour"],
		["a number", { down: 3 }, "layout.colors.down must be a colour"],
		["nine series", { series: Array.from({ length: 9 }, () => "#000") }, "layout.colors.series must hold 1 to 8"],
		["a pointer without /", { main: "/identity/tokens.json#colors" }, "start with /"],
		["not an object", "bright", "layout.colors must be an object"],
	])("refuse %s", (_name, colors, problem) => {
		expect(refusal(layoutWith([{ type: "artifacts" }], colors))).toContain(problem);
	});

	it("read leniently: bad colours are dropped, never a layout problem", () => {
		const bad = readSurfaceLayout(JSON.stringify(layoutWith([{ type: "artifacts" }], { preset: "loud" })));
		expect(bad).toEqual({
			layout: { schema: SCHEMA, tabs: [{ id: "main", title: "Main", blocks: [{ type: "artifacts" }] }] },
		});
		const good = readSurfaceLayout(
			JSON.stringify(layoutWith([{ type: "artifacts" }], { preset: "calm", up: "#0a0" })),
		);
		expect(good).toEqual({
			layout: {
				schema: SCHEMA,
				colors: { preset: "calm", up: "#0a0" },
				tabs: [{ id: "main", title: "Main", blocks: [{ type: "artifacts" }] }],
			},
		});
	});

	it("chart colours take a job, a colour or a binding per series, at most 16", () => {
		const colors = {
			Kept: "up",
			Other: "series-3",
			Sandstone: "/products/bands/object.json#/colourways/sandstone",
			Mine: "#3d6b8f",
		};
		expect(firstBlock(layoutWith([chart("a.chart.json", { colors })]))).toEqual({
			type: "chart",
			from: "a.chart.json",
			colors,
		});
		expect(refusal(layoutWith([chart("a.chart.json", { colors: { A: "red" } })]))).toContain(
			"layout.tabs[0].blocks[0].colors.A must be a job (main, compare, up, down, series-1 to series-8)",
		);
		expect(refusal(layoutWith([chart("a.chart.json", { colors: { A: "series-9" } })]))).toContain(
			"colors.A must be a job",
		);
		expect(refusal(layoutWith([chart("a.chart.json", { colors: {} })]))).toContain(
			"colors must hold 1 to 16 series, not 0",
		);
		const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, "main"]));
		expect(refusal(layoutWith([chart("a.chart.json", { colors: seventeen })]))).toContain("not 17");
		expect(refusal(layoutWith([chart("a.chart.json", { colors: ["main"] })]))).toContain("colors must be an object");
	});
});

const TOKENS = {
	colors: {
		paper: "#f7f3ee",
		sand: "#b8865a",
		night: "#2b2f3a",
		moss: { hex: "#5d7a4a" },
		clay: { value: "#b5543c" },
		stone: "#c9c2b8",
		ink: "#1a1a1a",
	},
};

function reader(files: Record<string, unknown>) {
	return (path: string) => files[path];
}

const withTokens = reader({
	"/identity/tokens.json": TOKENS,
	"/products/bands/object.json": { c: { hex: "#123456" } },
});
const HEX = /^#[0-9a-f]{6}$/;

function expectWellFormed(colors: ReturnType<typeof resolveSurfaceColors>): void {
	for (const colour of [colors.main, colors.compare, colors.up, colors.down, ...colors.series])
		expect(colour).toMatch(HEX);
	expect(colors.down).not.toBe(colors.main);
	expect(colors.series.length).toBeGreaterThanOrEqual(1);
	expect(colors.series.length).toBeLessThanOrEqual(8);
}

describe("resolving colours", () => {
	it("company: the Identity's colours, grounds left out, muted as compare, ink as down", () => {
		const colors = resolveSurfaceColors({ preset: "company" }, withTokens);
		expectWellFormed(colors);
		expect(colors.main).toBe("#b8865a");
		expect(colors.compare).toBe("#c9c2b8");
		expect(colors.up).toBe("#b8865a");
		expect(colors.down).toBe("#1a1a1a");
		expect(colors.series.slice(0, 5)).toEqual(["#b8865a", "#2b2f3a", "#5d7a4a", "#b5543c", "#c9c2b8"]);
		expect(colors.series).toHaveLength(8);
		expect(new Set(colors.series).size).toBe(8);
		expect(colors.series).not.toContain("#f7f3ee");
		expect(resolveSurfaceColors(undefined, withTokens)).toEqual(colors);
	});

	it("company: accent is main and named jobs are used; compare mixes main toward grey without a muted colour", () => {
		const tokens = {
			colors: { background: "#ffffff", text: "#222222", accent: "#3d6b8f", success: "#2e7d32", danger: "#c62828" },
		};
		const colors = resolveSurfaceColors({ preset: "company" }, reader({ "/identity/tokens.json": tokens }));
		expectWellFormed(colors);
		expect(colors).toMatchObject({ main: "#3d6b8f", up: "#2e7d32", down: "#c62828" });
		expect(colors.compare).toBe("#8293a2");
		expect(colors.series.slice(0, 3)).toEqual(["#3d6b8f", "#2e7d32", "#c62828"]);
	});

	it("reads a palette group when there is no colors group", () => {
		const colors = resolveSurfaceColors(
			undefined,
			reader({ "/identity/tokens.json": { palette: { brand: "rgb(10, 20, 30)" } } }),
		);
		expect(colors.main).toBe("#0a141e");
	});

	it("without an Identity: quiet greys, down never main", () => {
		for (const preset of ["company", "one-colour", "calm"] as const) {
			const colors = resolveSurfaceColors({ preset }, reader({}));
			expectWellFormed(colors);
			expect(colors).toMatchObject({ main: "#5f6670", compare: "#b4b8be", up: "#5f6670", down: "#b4b8be" });
		}
	});

	it("one-colour: eight shades of main", () => {
		const colors = resolveSurfaceColors({ preset: "one-colour" }, withTokens);
		expectWellFormed(colors);
		expect(colors.main).toBe("#b8865a");
		expect(colors.series[0]).toBe("#b8865a");
		expect(colors.series).toHaveLength(8);
		expect(new Set(colors.series).size).toBe(8);
		expect(colors.series).not.toContain("#5d7a4a");
	});

	it("calm: main and greys", () => {
		const colors = resolveSurfaceColors({ preset: "calm" }, withTokens);
		expectWellFormed(colors);
		expect(colors.series).toEqual([
			"#b8865a",
			"#8b9098",
			"#b8bcc2",
			"#6b7079",
			"#cfd2d6",
			"#545961",
			"#9ea3aa",
			"#dfe1e4",
		]);
		expect(colors.compare).toBe("#a0a4aa");
		expect(colors.down).toBe("#1a1a1a");
	});

	it("bright: the Okabe-Ito set, whatever the Identity", () => {
		const colors = resolveSurfaceColors({ preset: "bright" }, withTokens);
		expectWellFormed(colors);
		expect(colors).toEqual({
			main: "#0072b2",
			compare: "#999999",
			up: "#009e73",
			down: "#d55e00",
			series: [...SURFACE_OKABE_ITO],
		});
		expect(resolveSurfaceColors({ preset: "bright" }, reader({}))).toEqual(colors);
	});

	it("jobs named in the layout win over the preset, and main leads the series", () => {
		const own: SurfaceLayoutColors = {
			main: "/identity/tokens.json#/colors/moss",
			compare: "#abc",
			up: "/products/bands/object.json#/c",
		};
		const colors = resolveSurfaceColors(own, withTokens);
		expectWellFormed(colors);
		expect(colors).toMatchObject({ main: "#5d7a4a", compare: "#aabbcc", up: "#123456", down: "#1a1a1a" });
		expect(colors.series[0]).toBe("#5d7a4a");
		expect(
			resolveSurfaceColors({ series: ["#111", "/identity/tokens.json#/colors/clay"] }, withTokens).series,
		).toEqual(["#111111", "#b5543c"]);
	});

	it("a binding that does not resolve keeps the preset's colour", () => {
		const colors = resolveSurfaceColors(
			{ main: "/identity/tokens.json#/colors/nothing", series: ["/nope.json#/a"] },
			withTokens,
		);
		expect(colors).toEqual(resolveSurfaceColors({ preset: "company" }, withTokens));
	});

	it("down is never main, even when named so", () => {
		const named = resolveSurfaceColors({ main: "#b5543c", down: "#B5543C" }, withTokens);
		expect(named.down).toBe("#1a1a1a");
		const noInk = reader({ "/identity/tokens.json": { colors: { brand: "#c62828", red: "#c62828" } } });
		const company = resolveSurfaceColors({ preset: "company" }, noInk);
		expectWellFormed(company);
		expect(company.down).toBe(company.compare);
		const allSame = resolveSurfaceColors({ main: "#336699", compare: "#336699", down: "#336699" }, reader({}));
		expectWellFormed(allSame);
		expect(allSame.down).toBe("#172e45");
	});

	it("is deterministic and leaves its inputs alone", () => {
		const own: SurfaceLayoutColors = { preset: "one-colour", series: ["#123"] };
		const before = JSON.stringify(own);
		expect(resolveSurfaceColors(own, withTokens)).toEqual(resolveSurfaceColors(own, withTokens));
		expect(JSON.stringify(own)).toBe(before);
	});

	it("resolves a chart's series colours by job, colour or binding, dropping what does not resolve", () => {
		const colors = resolveSurfaceColors({ preset: "bright" }, withTokens);
		expect(
			resolveSurfaceChartColors(
				{
					Refunds: "down",
					Two: "series-2",
					Ten: "series-8",
					Own: "#fff",
					Band: "/products/bands/object.json#/c",
					Gone: "/x.json#/a",
				},
				colors,
				withTokens,
			),
		).toEqual({
			Refunds: "#d55e00",
			Two: "#e69f00",
			Ten: "#000000",
			Own: "#ffffff",
			Band: "#123456",
		});
		const short = { ...colors, series: ["#111111", "#222222"] };
		expect(resolveSurfaceChartColors({ A: "series-3" }, short, withTokens)).toEqual({ A: "#111111" });
		expect(resolveSurfaceChartColors(undefined, colors, withTokens)).toEqual({});
	});
});

describe("the dark ground", () => {
	it("lifts a colour toward white until it stands 3:1 against #1f2120, and keeps one that already does", () => {
		const lifted = liftSurfaceColorForDark("#2b2f3a");
		expect(lifted).not.toBe("#2b2f3a");
		expect(surfaceColorContrast(lifted, SURFACE_DARK_GROUND)).toBeGreaterThanOrEqual(SURFACE_DARK_MIN_CONTRAST);
		expect(surfaceColorContrast("#2b2f3a", SURFACE_DARK_GROUND)).toBeLessThan(SURFACE_DARK_MIN_CONTRAST);
		expect(liftSurfaceColorForDark("#e69f00")).toBe("#e69f00");
		expect(liftSurfaceColorForDark("#000000")).toMatch(HEX);
		expect(liftSurfaceColorForDark("not a colour")).toBe("not a colour");
	});

	it("lifts every job of a resolved set", () => {
		const dark = surfaceColorsForDark(resolveSurfaceColors({ preset: "company" }, withTokens));
		for (const colour of [dark.main, dark.compare, dark.up, dark.down, ...dark.series]) {
			expect(surfaceColorContrast(colour, SURFACE_DARK_GROUND)).toBeGreaterThanOrEqual(SURFACE_DARK_MIN_CONTRAST);
		}
	});
});

const QORPERA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	"orders-now": [
		"stripe",
		"orders_today",
		"sales_today",
		"to_pack",
		"on_the_way",
		"refunds_30d",
		"disputes_open",
		"last_order_at",
	],
	"orders-days": ["day", "orders", "sales", "refunds"],
	"site-days": ["site", "day", "views", "visits"],
	"site-pages": ["site", "path", "views", "visits"],
	"money-balance": ["day", "balance"],
	"money-months": ["month", "money_in", "money_out"],
	"money-kinds": ["direction", "kind", "amount", "count"],
};

function asksOf(
	value: unknown,
	out: { ask: SurfaceAskSource; holder: Record<string, unknown> }[] = [],
	holder?: Record<string, unknown>,
) {
	if (isSurfaceAskSource(value)) {
		if (holder) out.push({ ask: value, holder });
		return out;
	}
	if (Array.isArray(value)) for (const item of value) asksOf(item, out, holder);
	else if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const next = typeof record.type === "string" ? record : holder;
		for (const item of Object.values(record)) asksOf(item, out, next);
	}
	return out;
}

describe("the Analytics starter", () => {
	const starter: SurfaceLayout = SURFACE_STARTER_LAYOUTS.analytics;

	it("has its tabs, company colours, a dated reading and the numbers file", () => {
		expect(starter.tabs.map((tab) => tab.title)).toEqual([
			"Now",
			"Sales",
			"Money",
			"Visitors",
			"Questions",
			"Numbers",
		]);
		expect(starter.colors).toEqual({ preset: "company" });
		const looks = Object.fromEntries(
			asksOf(starter).flatMap(({ ask, holder }) =>
				holder.type === "chart" ? [[holder.id, ask.kind ?? "line"]] : [],
			),
		);
		expect(looks).toEqual({
			pulse: "line",
			"sales-days": "bar",
			balance: "area",
			months: "bar",
			kinds: "bar",
			visits: "line",
		});
		expect(starter.tabs[0]?.blocks[0]).toEqual({ type: "title", id: "reading", line: "reading.json#/line" });
		expect(starter.tabs[4]?.blocks).toEqual([{ type: "report", id: "questions", match: "questions/*.report.json" }]);
		expect(starter.tabs[5]?.blocks[0]).toMatchObject({
			type: "table",
			from: "metrics.json#/metrics",
			columns: [
				{ key: "name", label: "Number" },
				{ key: "counts", label: "What it counts" },
				{ key: "leaves_out", label: "Leaves out" },
			],
		});
	});

	it("asks only qorpera questions that exist, naming their real columns", () => {
		const asks = asksOf(starter);
		expect(new Set(asks.map(({ ask }) => splitSurfaceAsk(ask.ask)?.question))).toEqual(
			new Set(Object.keys(QORPERA_COLUMNS)),
		);
		for (const { ask, holder } of asks) {
			const parts = splitSurfaceAsk(ask.ask);
			expect(parts?.database).toBe("qorpera");
			const columns = QORPERA_COLUMNS[parts?.question ?? ""] ?? [];
			const named = [ask.pick, ask.x, ask.series, ...(Array.isArray(ask.y) ? ask.y : [ask.y])].filter(
				(column): column is string => column !== undefined,
			);
			for (const column of named) expect(columns).toContain(column);
			if (holder.type === "table" && Array.isArray(holder.columns)) {
				for (const column of holder.columns as { key: string }[]) expect(columns).toContain(column.key);
			}
			if (holder.type === "chart" && holder.colors) {
				const series = Array.isArray(ask.y) ? ask.y : [];
				for (const name of Object.keys(holder.colors)) expect(series).toContain(name);
			}
		}
	});

	it("names the ask and colour formats for its agent, and only charts or asks bring them", () => {
		const notes = describeSurfaceFormats(starter);
		expect(notes).toContain(SURFACE_ASK_FORMAT);
		expect(notes).toContain(SURFACE_COLORS_FORMAT);
		expect(SURFACE_ASK_FORMAT).toContain("as the member viewing it");
		expect(SURFACE_ASK_FORMAT).toContain("kind line|area|bar|pie|funnel, default line");
		expect(SURFACE_COLORS_FORMAT).toContain('"preset":"company"|"one-colour"|"calm"|"bright"');
		const asksOnly = parseSurfaceLayout(layoutWith([{ type: "table", from: { ask: "qorpera/site-pages" } }]));
		expect(describeSurfaceFormats(asksOnly)).toEqual([SURFACE_ASK_FORMAT]);
		const colorsOnly = parseSurfaceLayout(layoutWith([{ type: "artifacts" }], { preset: "calm" }));
		expect(describeSurfaceFormats(colorsOnly)).toEqual([SURFACE_COLORS_FORMAT]);
		expect(describeSurfaceFormats(parseSurfaceLayout(layoutWith([{ type: "table", from: "a.json" }])))).toEqual([]);
	});

	it("is the page of a studio of dashboard kind or analytics slug; a live_build dashboard has no Studio page", () => {
		const facts = { lookKind: "custom" as const, slug: "numbers", isGlobal: false, paths: [], hasModel: false };
		expect(surfaceStarterKind({ ...facts, lookKind: "dashboard" })).toBe("analytics");
		expect(surfaceStarterKind({ ...facts, slug: "analytics" })).toBe("analytics");
		expect(surfaceStarterKind({ ...facts, lookKind: "dashboard", isGlobal: true })).toBe("identity");
		const studio = {
			archetype: "studio" as const,
			kind: "dashboard" as const,
			slug: "numbers",
			icon: "chart",
			isGlobal: false,
			paths: [],
			hasModel: false,
		};
		expect(surfaceStudioPage(studio)).toEqual({ page: "layout", starter: "analytics" });
		expect(surfaceStudioPage({ ...studio, kind: "custom", slug: "analytics" })).toEqual({
			page: "layout",
			starter: "analytics",
		});
		expect(surfaceStudioPage({ ...studio, archetype: "live_build" })).toEqual({ page: null });
	});
});
