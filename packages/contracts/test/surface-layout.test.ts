import { describe, expect, it } from "vitest";
import {
	describeSurfaceBlocks,
	parseSurfaceBinding,
	parseSurfaceLayout,
	parseSurfaceLayoutText,
	readSurfaceLayout,
	resolveSurfaceSource,
	SURFACE_BLOCK_TYPES,
	SURFACE_BLOCKS,
	SURFACE_LAYOUT_MAX_BYTES,
	SURFACE_LAYOUT_PATH,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_STARTER_KINDS,
	SURFACE_STARTER_LAYOUTS,
	type SurfaceLayout,
	type SurfaceLayoutNode,
	type SurfaceReadNode,
	starterSurfaceLayout,
	surfaceCompanyPath,
	surfaceGlobMatches,
} from "../src/index.ts";
import {
	IDENTITY_BRIEF_PATH,
	IDENTITY_COMPANY_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	IDENTITY_VOICE_PATH,
} from "../src/surface-shared-assets.ts";
import { WireValueError } from "../src/wire-values.ts";

const SCHEMA = SURFACE_LAYOUT_SCHEMA;

function layoutWith(blocks: unknown[], extraTabs: unknown[] = []): unknown {
	return { schema: SCHEMA, tabs: [{ id: "main", title: "Main", blocks }, ...extraTabs] };
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

function read(value: unknown): SurfaceReadNode[] {
	const result = readSurfaceLayout(JSON.stringify(value));
	if (!("layout" in result)) throw new Error(`expected a layout, got ${result.problem}`);
	return [...(result.layout.tabs[0]?.blocks ?? [])];
}

function many(count: number, make: (index: number) => unknown): unknown[] {
	return Array.from({ length: count }, (_, index) => make(index));
}

describe("parseSurfaceLayout", () => {
	it("accepts every block type and fills each default", () => {
		const layout = parseSurfaceLayout(
			layoutWith([
				{ type: "stage_3d", id: "stage" },
				{ type: "title", name: { value: "Headband" }, line: "specs.json#/overview/tagline" },
				{ type: "swatch_row", from: "specs.json#/colorways", tints: "stage" },
				{ type: "palette", from: "/identity/tokens.json#/colors", heading: "Palette" },
				{ type: "brand_mark", from: "/identity/logo.svg" },
				{ type: "type_specimen", from: "/identity/tokens.json#/typography" },
				{ type: "facts", from: "specs.json#/overview" },
				{ type: "facts", items: [{ label: "Weight", from: "specs.json#/overview/weight" }] },
				{ type: "spec_list", from: "specs.json#/overview" },
				{ type: "table", from: "specs.json#/bom", columns: [{ key: "part", label: "Part" }], caption: "Per unit" },
				{ type: "cards", from: "vendors.json#/vendors", title: "vendor", badge: "status" },
				{ type: "report", match: "*.report.json" },
				{ type: "report", from: "essay.report.json" },
				{ type: "files" },
				{
					type: "row",
					blocks: [
						{ type: "module", from: "modules/price-calc" },
						{ type: "module", from: "modules/stock", height: 480, heading: "Stock" },
					],
				},
			]),
		);
		const blocks = layout.tabs[0]?.blocks ?? [];
		expect(blocks[0]).toEqual({ type: "stage_3d", id: "stage", model: "object.json" });
		expect(blocks[4]).toEqual({ type: "brand_mark", from: "/identity/logo.svg", grounds: ["light", "dark"] });
		expect(blocks[6]).toEqual({ type: "facts", from: "specs.json#/overview", take: 4, skip: [] });
		expect(blocks[7]).toEqual({ type: "facts", items: [{ label: "Weight", from: "specs.json#/overview/weight" }] });
		expect(blocks[10]).toMatchObject({ type: "cards", lines: [] });
		expect(blocks[14]).toEqual({
			type: "row",
			blocks: [
				{ type: "module", from: "modules/price-calc", height: "auto" },
				{ type: "module", from: "modules/stock", height: 480, heading: "Stock" },
			],
		});
		expect(parseSurfaceLayout(layout)).toEqual(layout);
	});

	it.each<[string, unknown, string, string]>([
		["a non-object", "layout", "layout", "must be an object"],
		["a wrong schema", { schema: "x", tabs: [] }, "layout.schema", SCHEMA],
		[
			"an unknown root field",
			{ schema: SCHEMA, tabs: [], theme: "dark" },
			"layout",
			"has a field that the layout does not take",
		],
		["no tabs", { schema: SCHEMA, tabs: [] }, "layout.tabs", "1 to 12"],
		[
			"thirteen tabs",
			{ schema: SCHEMA, tabs: many(13, (index) => ({ id: `t${index}`, title: "T", blocks: [{ type: "files" }] })) },
			"layout.tabs",
			"1 to 12",
		],
		[
			"a tab id that is not a slug",
			{ schema: SCHEMA, tabs: [{ id: "Main", title: "M", blocks: [] }] },
			"layout.tabs[0].id",
			"slug",
		],
		[
			"a tab title past 40 chars",
			{ schema: SCHEMA, tabs: [{ id: "m", title: "x".repeat(41), blocks: [{ type: "files" }] }] },
			"layout.tabs[0].title",
			"longer than 40",
		],
		["an empty tab", layoutWith([]), "layout.tabs[0].blocks", "at least one block"],
		[
			"a repeated tab id",
			layoutWith([{ type: "files" }], [{ id: "main", title: "Again", blocks: [{ type: "files" }] }]),
			"layout.tabs[1].id",
			"repeats the id of layout.tabs[0]",
		],
		[
			"an unknown type",
			layoutWith([{ type: "carousel" }]),
			"layout.tabs[0].blocks[0].type",
			"must be one of stage_3d",
		],
		["a block without a type", layoutWith([{ from: "a.json" }]), "layout.tabs[0].blocks[0].type", "must be one of"],
		["a block that is a string", layoutWith(["files"]), "layout.tabs[0].blocks[0]", "must be an object"],
		[
			"an unknown field",
			layoutWith([{ type: "palette", from: "a.json", colour: "red" }]),
			"layout.tabs[0].blocks[0]",
			"has a field that palette does not take; its fields are type, id, from, heading",
		],
		["a missing required field", layoutWith([{ type: "spec_list" }]), "layout.tabs[0].blocks[0].from", "is missing"],
		[
			"a block id that is not a slug",
			layoutWith([{ type: "files", id: "my files" }]),
			"layout.tabs[0].blocks[0].id",
			"slug",
		],
		[
			"a number as a source",
			layoutWith([{ type: "spec_list", from: 3 }]),
			"layout.tabs[0].blocks[0].from",
			"binding",
		],
		[
			"a literal with another key",
			layoutWith([{ type: "spec_list", from: { value: {}, note: "x" } }]),
			"layout.tabs[0].blocks[0].from",
			'exactly {"value": ...}',
		],
		[
			"a pointer without /",
			layoutWith([{ type: "table", from: "a.json#bom" }]),
			"layout.tabs[0].blocks[0].from",
			"start with /",
		],
		["a bad ~ escape", layoutWith([{ type: "table", from: "a.json#/b~2" }]), "layout.tabs[0].blocks[0].from", "~0"],
		["a .. path", layoutWith([{ type: "table", from: "../a.json" }]), "layout.tabs[0].blocks[0].from", ". or .."],
		["a // path", layoutWith([{ type: "table", from: "a//b.json" }]), "layout.tabs[0].blocks[0].from", "empty part"],
		[
			"a backslash path",
			layoutWith([{ type: "table", from: "a\\b.json" }]),
			"layout.tabs[0].blocks[0].from",
			"backslash",
		],
		[
			"a padded binding",
			layoutWith([{ type: "table", from: " a.json" }]),
			"layout.tabs[0].blocks[0].from",
			"white space",
		],
		[
			"an empty binding",
			layoutWith([{ type: "table", from: "" }]),
			"layout.tabs[0].blocks[0].from",
			"names no file path",
		],
		[
			"a bare / binding",
			layoutWith([{ type: "table", from: "/" }]),
			"layout.tabs[0].blocks[0].from",
			"names no file path",
		],
		[
			"a brand mark with a pointer",
			layoutWith([{ type: "brand_mark", from: "logo.svg#/x" }]),
			"layout.tabs[0].blocks[0].from",
			"whole file",
		],
		[
			"a brand mark that is no picture",
			layoutWith([{ type: "brand_mark", from: "logo.json" }]),
			"layout.tabs[0].blocks[0].from",
			".svg, .png",
		],
		[
			"a brand mark held as a literal",
			layoutWith([{ type: "brand_mark", from: { value: "<svg/>" } }]),
			"layout.tabs[0].blocks[0].from",
			"binding",
		],
		[
			"a ground named twice",
			layoutWith([{ type: "brand_mark", from: "logo.svg", grounds: ["dark", "dark"] }]),
			"layout.tabs[0].blocks[0].grounds",
			"twice",
		],
		[
			"an unknown ground",
			layoutWith([{ type: "brand_mark", from: "logo.svg", grounds: ["grey"] }]),
			"layout.tabs[0].blocks[0].grounds[0]",
			'"light" or "dark"',
		],
		["facts with neither", layoutWith([{ type: "facts" }]), "layout.tabs[0].blocks[0]", "exactly one"],
		[
			"facts with both",
			layoutWith([{ type: "facts", from: "a.json", items: [{ label: "A", from: "a.json#/a" }] }]),
			"layout.tabs[0].blocks[0]",
			"exactly one",
		],
		[
			"facts with take beside items",
			layoutWith([{ type: "facts", take: 2, items: [{ label: "A", from: "a.json#/a" }] }]),
			"layout.tabs[0].blocks[0]",
			"only with from",
		],
		[
			"facts taking 9",
			layoutWith([{ type: "facts", from: "a.json", take: 9 }]),
			"layout.tabs[0].blocks[0].take",
			"1 to 8",
		],
		[
			"nine fact items",
			layoutWith([{ type: "facts", items: many(9, () => ({ label: "A", from: "a.json#/a" })) }]),
			"layout.tabs[0].blocks[0].items",
			"1 to 8",
		],
		[
			"a fact label past 40 chars",
			layoutWith([{ type: "facts", items: [{ label: "x".repeat(41), from: "a.json#/a" }] }]),
			"layout.tabs[0].blocks[0].items[0].label",
			"longer than 40",
		],
		[
			"a fact without from",
			layoutWith([{ type: "facts", items: [{ label: "A" }] }]),
			"layout.tabs[0].blocks[0].items[0].from",
			"is missing",
		],
		[
			"a heading past 80 chars",
			layoutWith([{ type: "files", heading: "x".repeat(81) }]),
			"layout.tabs[0].blocks[0].heading",
			"longer than 80",
		],
		[
			"an empty heading",
			layoutWith([{ type: "files", heading: " " }]),
			"layout.tabs[0].blocks[0].heading",
			"is empty",
		],
		[
			"a heading on a title",
			layoutWith([{ type: "title", heading: "Name" }]),
			"layout.tabs[0].blocks[0]",
			"has a field that title does not take",
		],
		["a report with neither", layoutWith([{ type: "report" }]), "layout.tabs[0].blocks[0]", "exactly one"],
		[
			"a report with both",
			layoutWith([{ type: "report", from: "a.report.json", match: "*.report.json" }]),
			"layout.tabs[0].blocks[0]",
			"exactly one",
		],
		[
			"a report from markdown",
			layoutWith([{ type: "report", from: "a.md" }]),
			"layout.tabs[0].blocks[0].from",
			".json",
		],
		[
			"a bare / glob",
			layoutWith([{ type: "files", match: ["/"] }]),
			"layout.tabs[0].blocks[0].match[0]",
			"names no glob",
		],
		[
			"a glob with ** inside a name",
			layoutWith([{ type: "files", match: ["a**b.md"] }]),
			"layout.tabs[0].blocks[0].match[0]",
			"** stands alone",
		],
		[
			"a glob with five **",
			layoutWith([{ type: "files", match: ["**/a/**/b/**/c/**/d/**/*.md"] }]),
			"layout.tabs[0].blocks[0].match[0]",
			"more than 4 **",
		],
		[
			"a glob with five * in one name",
			layoutWith([{ type: "report", match: "*a*a*a*a*a.json" }]),
			"layout.tabs[0].blocks[0].match",
			"more than 4 * in one name",
		],
		[
			"a glob seventeen folders deep",
			layoutWith([{ type: "files", match: [many(17, () => "a").join("/")] }]),
			"layout.tabs[0].blocks[0].match[0]",
			"more than 16 folder levels",
		],
		["a .. glob", layoutWith([{ type: "report", match: "../*.json" }]), "layout.tabs[0].blocks[0].match", ". or .."],
		["an empty glob list", layoutWith([{ type: "files", match: [] }]), "layout.tabs[0].blocks[0].match", "1 to 16"],
		[
			"a rooted module",
			layoutWith([{ type: "module", from: "/modules/x" }]),
			"layout.tabs[0].blocks[0].from",
			"leading /",
		],
		[
			"a module past 1600 px",
			layoutWith([{ type: "module", from: "m", height: 1601 }]),
			"layout.tabs[0].blocks[0].height",
			"120 to 1600",
		],
		[
			"a module under 120 px",
			layoutWith([{ type: "module", from: "m", height: 119 }]),
			"layout.tabs[0].blocks[0].height",
			"120 to 1600",
		],
		[
			"cards without a title key",
			layoutWith([{ type: "cards", from: "a.json" }]),
			"layout.tabs[0].blocks[0].title",
			"is missing",
		],
		[
			"a column without a label",
			layoutWith([{ type: "table", from: "a.json", columns: [{ key: "a" }] }]),
			"layout.tabs[0].blocks[0].columns[0].label",
			"is missing",
		],
		[
			"a row of one",
			layoutWith([{ type: "row", blocks: [{ type: "files" }] }]),
			"layout.tabs[0].blocks[0].blocks",
			"2 or 3 blocks, not 1",
		],
		[
			"a row of four",
			layoutWith([{ type: "row", blocks: many(4, () => ({ type: "files" })) }]),
			"layout.tabs[0].blocks[0].blocks",
			"not 4",
		],
		[
			"a row in a row",
			layoutWith([
				{
					type: "row",
					blocks: [{ type: "files" }, { type: "row", blocks: [{ type: "files" }, { type: "files" }] }],
				},
			]),
			"layout.tabs[0].blocks[0].blocks[1].type",
			"a row cannot hold a row",
		],
		[
			"a row with an id",
			layoutWith([{ type: "row", id: "pair", blocks: [{ type: "files" }, { type: "files" }] }]),
			"layout.tabs[0].blocks[0]",
			"has a field that row does not take",
		],
		[
			"a broken block inside a row",
			layoutWith([{ type: "row", blocks: [{ type: "files" }, { type: "table" }] }]),
			"layout.tabs[0].blocks[0].blocks[1].from",
			"is missing",
		],
		[
			"tints naming nothing",
			layoutWith([{ type: "swatch_row", from: "a.json", tints: "stage" }]),
			"layout.tabs[0].blocks[0].tints",
			"names no stage_3d",
		],
		[
			"tints naming a block that is not a stage",
			layoutWith([
				{ type: "files", id: "stage" },
				{ type: "swatch_row", from: "a.json", tints: "stage" },
			]),
			"layout.tabs[0].blocks[1].tints",
			"names no stage_3d",
		],
		[
			"tints naming a stage on another tab",
			layoutWith(
				[{ type: "swatch_row", from: "a.json", tints: "stage" }],
				[{ id: "other", title: "Other", blocks: [{ type: "stage_3d", id: "stage" }] }],
			),
			"layout.tabs[0].blocks[0].tints",
			"names no stage_3d",
		],
		[
			"a repeated block id across tabs",
			layoutWith(
				[{ type: "files", id: "notes" }],
				[
					{
						id: "other",
						title: "Other",
						blocks: [{ type: "row", blocks: [{ type: "files" }, { type: "files", id: "notes" }] }],
					},
				],
			),
			"layout.tabs[1].blocks[0].blocks[1].id",
			"repeats the id of layout.tabs[0].blocks[0]",
		],
		[
			"25 blocks on a tab",
			layoutWith(many(25, () => ({ type: "files" }))),
			"layout.tabs[0].blocks",
			"holds 25 blocks",
		],
		[
			"65 blocks in all",
			{
				schema: SCHEMA,
				tabs: [
					...many(2, (index) => ({ id: `t${index}`, title: "T", blocks: many(24, () => ({ type: "files" })) })),
					{ id: "t2", title: "T", blocks: many(17, () => ({ type: "files" })) },
				],
			},
			"layout.tabs",
			"hold 65 blocks",
		],
	])("refuses %s, naming where", (_name, value, label, words) => {
		const message = refusal(value);
		expect(message.startsWith(`${label} `)).toBe(true);
		expect(message).toContain(words);
	});

	it("counts a row and its blocks against a tab's 24", () => {
		const pair = { type: "row", blocks: [{ type: "files" }, { type: "files" }] };
		expect(() => parseSurfaceLayout(layoutWith(many(8, () => pair)))).not.toThrow();
		expect(refusal(layoutWith(many(9, () => pair)))).toBe(
			"layout.tabs[0].blocks holds 27 blocks; a tab holds at most 24, a row and the blocks in it each counted",
		);
	});

	it("refuses a layout larger than 64 KiB", () => {
		const big = layoutWith([{ type: "spec_list", from: { value: { note: "x".repeat(SURFACE_LAYOUT_MAX_BYTES) } } }]);
		expect(refusal(big)).toMatch(/^layout is larger than 65536 bytes/);
	});

	it("parses file text and refuses text that is not JSON", () => {
		expect(parseSurfaceLayoutText(JSON.stringify(layoutWith([{ type: "files" }]))).tabs[0]?.id).toBe("main");
		expect(() => parseSurfaceLayoutText("{")).toThrow("layout is not valid JSON");
		expect(() => parseSurfaceLayoutText(" ".repeat(SURFACE_LAYOUT_MAX_BYTES + 1))).toThrow(/larger than 65536/);
	});

	it("never quotes a value in a refusal", () => {
		expect(refusal(layoutWith([{ type: "secret-token-123" }]))).not.toContain("secret-token-123");
		expect(refusal(layoutWith([{ type: "table", from: "secret-token-123#x" }]))).not.toContain("secret-token-123");
		expect(refusal(layoutWith([{ type: "files", "secret-token-123": 1 }]))).not.toContain("secret-token-123");
		expect(refusal({ schema: SCHEMA, tabs: [], "secret-token-123": 1 })).not.toContain("secret-token-123");
	});
});

describe("readSurfaceLayout", () => {
	it("names a problem for text that is not a layout", () => {
		expect(readSurfaceLayout("{")).toEqual({ problem: "not valid JSON" });
		expect(readSurfaceLayout("[]")).toEqual({ problem: "not a JSON object" });
		expect(readSurfaceLayout(JSON.stringify({ schema: "x", tabs: [] }))).toHaveProperty("problem");
		expect(readSurfaceLayout(JSON.stringify({ schema: SCHEMA }))).toEqual({ problem: "no tabs list" });
		expect(
			readSurfaceLayout(JSON.stringify({ schema: SCHEMA, tabs: [{ id: "Bad", title: "x", blocks: [] }] })),
		).toEqual({
			problem: "no usable tab",
		});
		expect(readSurfaceLayout(" ".repeat(SURFACE_LAYOUT_MAX_BYTES + 1))).toHaveProperty("problem");
	});

	it("draws unknown and broken blocks as unknown in place and keeps the rest", () => {
		const blocks = read(
			layoutWith([
				{ type: "carousel" },
				{ type: "files", heading: "Notes" },
				{ type: "table" },
				"files",
				{ type: "spec_list", from: "a.json", extra: true },
			]),
		);
		expect(blocks.map((block) => block.type)).toEqual(["unknown", "files", "unknown", "unknown", "unknown"]);
		expect(blocks[0]).toMatchObject({ reason: expect.stringContaining("layout.tabs[0].blocks[0].type") });
		expect(blocks[2]).toMatchObject({ reason: expect.stringContaining("layout.tabs[0].blocks[2].from is missing") });
	});

	it("keeps a row whose child is broken, with the child unknown", () => {
		const blocks = read(
			layoutWith([
				{ type: "row", blocks: [{ type: "files" }, { type: "row", blocks: [] }] },
				{ type: "row", blocks: [{ type: "files" }] },
				{ type: "row", blocks: [{ type: "files" }, { type: "nope" }, { type: "files" }] },
			]),
		);
		expect(blocks[0]).toMatchObject({ type: "row", blocks: [{ type: "files" }, { type: "unknown" }] });
		expect(blocks[1]).toMatchObject({ type: "unknown", reason: expect.stringContaining("2 or 3 blocks") });
		expect(blocks[2]).toMatchObject({
			type: "row",
			blocks: [{ type: "files" }, { type: "unknown" }, { type: "files" }],
		});
	});

	it("turns a repeated id unknown and drops a tints that names no stage", () => {
		const blocks = read(
			layoutWith([
				{ type: "files", id: "notes" },
				{ type: "row", blocks: [{ type: "files" }, { type: "files", id: "notes" }] },
				{ type: "swatch_row", from: "a.json", tints: "stage" },
			]),
		);
		expect(blocks[0]).toEqual({ type: "files", id: "notes" });
		expect(blocks[1]).toMatchObject({
			type: "row",
			blocks: [{ type: "files" }, { type: "unknown", reason: expect.stringContaining("repeats the id") }],
		});
		expect(blocks[2]).toEqual({ type: "swatch_row", from: "a.json" });
	});

	it("skips unusable tabs and cuts past the limits", () => {
		const result = readSurfaceLayout(
			JSON.stringify({
				schema: SCHEMA,
				extra: "ignored",
				tabs: [
					{ id: "bad id", title: "x", blocks: [] },
					{ id: "a", title: "A", blocks: many(30, () => ({ type: "files" })) },
					{ id: "a", title: "Again", blocks: [{ type: "files" }] },
					...many(14, (index) => ({ id: `t${index}`, title: "T", blocks: many(5, () => ({ type: "files" })) })),
				],
			}),
		);
		if (!("layout" in result)) throw new Error(result.problem);
		expect(result.layout.tabs).toHaveLength(12);
		expect(result.layout.tabs[0]).toMatchObject({ id: "a" });
		expect(result.layout.tabs[0]?.blocks).toHaveLength(24);
		const total = result.layout.tabs.reduce((sum, tab) => sum + tab.blocks.length, 0);
		expect(total).toBe(64);
	});

	it("reads every starter as it parses", () => {
		for (const kind of SURFACE_STARTER_KINDS) {
			expect(readSurfaceLayout(JSON.stringify(SURFACE_STARTER_LAYOUTS[kind]))).toEqual({
				layout: SURFACE_STARTER_LAYOUTS[kind],
			});
		}
	});
});

describe("bindings", () => {
	it("splits a path from its pointer", () => {
		expect(parseSurfaceBinding("specs.json#/overview/tagline")).toEqual({
			path: "specs.json",
			pointer: "/overview/tagline",
		});
		expect(parseSurfaceBinding("specs.json")).toEqual({ path: "specs.json", pointer: "" });
		expect(parseSurfaceBinding("specs.json#")).toEqual({ path: "specs.json", pointer: "" });
		expect(parseSurfaceBinding("/identity/tokens.json#/colors")).toEqual({
			path: "/identity/tokens.json",
			pointer: "/colors",
		});
		expect(parseSurfaceBinding("a.json#/x#y")).toEqual({ path: "a.json", pointer: "/x#y" });
		expect(() => parseSurfaceBinding("a.json#x", "here")).toThrow(/^here /);
	});

	it("maps a binding path to a company path", () => {
		expect(surfaceCompanyPath("surfaces/headband", "specs.json")).toBe("surfaces/headband/specs.json");
		expect(surfaceCompanyPath("identity", "identity/tokens.json")).toBe("identity/identity/tokens.json");
		expect(surfaceCompanyPath("/identity/", "tokens.json")).toBe("identity/tokens.json");
		expect(surfaceCompanyPath("surfaces/headband", "/identity/tokens.json")).toBe("identity/tokens.json");
		expect(() => surfaceCompanyPath("surfaces/headband", "/../x.json")).toThrow();
		expect(() => surfaceCompanyPath("surfaces/headband", "../x.json")).toThrow();
	});

	it("resolves literals, whole files, pointers, escapes and list entries", () => {
		const files: Record<string, unknown> = {
			"specs.json": {
				overview: { tagline: "Calm", weight: 0, empty: null },
				"a/b": { "m~n": "escaped" },
				bom: [{ part: "Shell" }, { part: "Battery" }],
				"": "blank key",
			},
			"list.json": ["zero", "one"],
			"text.json": "plain",
		};
		const readJson = (path: string) => files[path];
		expect(resolveSurfaceSource({ value: "held" }, readJson)).toEqual({ found: true, value: "held" });
		expect(resolveSurfaceSource({ value: null }, readJson)).toEqual({ found: true, value: null });
		expect(resolveSurfaceSource({ value: false }, readJson)).toEqual({ found: true, value: false });
		expect(resolveSurfaceSource("list.json", readJson)).toEqual({ found: true, value: ["zero", "one"] });
		expect(resolveSurfaceSource("specs.json#/overview/tagline", readJson)).toEqual({ found: true, value: "Calm" });
		expect(resolveSurfaceSource("specs.json#/overview/weight", readJson)).toEqual({ found: true, value: 0 });
		expect(resolveSurfaceSource("specs.json#/overview/empty", readJson)).toEqual({ found: true, value: null });
		expect(resolveSurfaceSource("specs.json#/a~1b/m~0n", readJson)).toEqual({ found: true, value: "escaped" });
		expect(resolveSurfaceSource("specs.json#/", readJson)).toEqual({ found: true, value: "blank key" });
		expect(resolveSurfaceSource("specs.json#/bom/1/part", readJson)).toEqual({ found: true, value: "Battery" });
		expect(resolveSurfaceSource("list.json#/0", readJson)).toEqual({ found: true, value: "zero" });
	});

	it("tries a list of sources in order and takes the first one found", () => {
		const files: Record<string, unknown> = { "specs.json": { tagline: "Top", overview: { summary: null } } };
		const readJson = (path: string) => files[path];
		expect(resolveSurfaceSource(["specs.json#/overview/tagline", "specs.json#/tagline"], readJson)).toEqual({
			found: true,
			value: "Top",
		});
		expect(resolveSurfaceSource(["specs.json#/overview/summary", "specs.json#/tagline"], readJson)).toEqual({
			found: true,
			value: null,
		});
		expect(resolveSurfaceSource(["nothing.json", { value: "held" }], readJson)).toEqual({
			found: true,
			value: "held",
		});
		expect(resolveSurfaceSource([["specs.json#/tagline"], "nothing.json"], readJson)).toEqual({
			found: false,
			value: undefined,
		});
		expect(resolveSurfaceSource([], readJson)).toEqual({ found: false, value: undefined });
	});

	it("says not found, never throws, for anything missing", () => {
		const files: Record<string, unknown> = {
			"specs.json": { overview: { tagline: "Calm" }, bom: [{ part: "Shell" }] },
		};
		const readJson = (path: string) => files[path];
		const missing = { found: false, value: undefined };
		for (const source of [
			"nothing.json",
			"nothing.json#/a",
			"specs.json#/overview/weight",
			"specs.json#/overview/tagline/length",
			"specs.json#/bom/1",
			"specs.json#/bom/01",
			"specs.json#/bom/-",
			"specs.json#/bom/x",
			"specs.json#/toString",
			"specs.json#/__proto__",
			"specs.json#overview",
			"../specs.json",
			"",
		]) {
			expect(resolveSurfaceSource(source, readJson)).toEqual(missing);
		}
		expect(resolveSurfaceSource(42, readJson)).toEqual(missing);
		expect(resolveSurfaceSource({}, readJson)).toEqual(missing);
		expect(
			resolveSurfaceSource("specs.json", () => {
				throw new Error("unreadable");
			}),
		).toEqual(missing);
	});

	it("matches rooted globs against company paths only", () => {
		expect(surfaceGlobMatches("/identity/*.md", "/identity/voice.md")).toBe(true);
		expect(surfaceGlobMatches("/identity/*.md", "identity/voice.md")).toBe(false);
		expect(surfaceGlobMatches("*.md", "/voice.md")).toBe(false);
		expect(surfaceGlobMatches("**/*.md", "/identity/voice.md")).toBe(false);
		expect(surfaceGlobMatches("*/x", "/x")).toBe(false);
		expect(surfaceGlobMatches("**", "/identity/voice.md")).toBe(false);
		expect(surfaceGlobMatches("*/voice.md", "/identity/voice.md")).toBe(false);
		expect(surfaceGlobMatches("/**", "identity/voice.md")).toBe(false);
		expect(surfaceGlobMatches("/*/voice.md", "identity/voice.md")).toBe(false);
		expect(surfaceGlobMatches("/**", "/identity/voice.md")).toBe(true);
		expect(surfaceGlobMatches("/**/*.md", "/identity/voice.md")).toBe(true);
		expect(surfaceGlobMatches("/*/voice.md", "/identity/voice.md")).toBe(true);
		expect(surfaceGlobMatches("**/*.md", "identity/voice.md")).toBe(true);
		expect(surfaceGlobMatches("notes/**", "notes")).toBe(true);
		expect(surfaceGlobMatches("**", "a/b/c")).toBe(true);
	});

	it("answers adversarial globs at once", { timeout: 1000 }, () => {
		const deepPath = `${many(40, () => "a").join("/")}/x.txt`;
		const longName = `${"a".repeat(400)}b`;
		const cases: [string, string, boolean][] = [
			[`${many(42, () => "**").join("/")}/*.md`, deepPath, false],
			[`${many(42, () => "**").join("/")}/*.txt`, deepPath, true],
			[many(64, () => "*a").join(""), longName, false],
			[many(64, () => "*a").join(""), "a".repeat(400), true],
			["**/**/**/**/*a*a*a*a", `${many(60, () => "a".repeat(30)).join("/")}/b`, false],
			[`${many(200, () => "*").join("")}b`, "a".repeat(5000), false],
		];
		for (const [glob, path, expected] of cases) {
			const started = performance.now();
			expect(surfaceGlobMatches(glob, path)).toBe(expected);
			expect(performance.now() - started).toBeLessThan(200);
		}
	});

	it("matches globs within and across folders", () => {
		expect(surfaceGlobMatches("*.report.json", "essay.report.json")).toBe(true);
		expect(surfaceGlobMatches("*.report.json", "reports/essay.report.json")).toBe(false);
		expect(surfaceGlobMatches("**/*.report.json", "essay.report.json")).toBe(true);
		expect(surfaceGlobMatches("**/*.report.json", "a/b/essay.report.json")).toBe(true);
		expect(surfaceGlobMatches("notes/**", "notes/a/b.md")).toBe(true);
		expect(surfaceGlobMatches("v?.md", "v1.md")).toBe(true);
		expect(surfaceGlobMatches("v?.md", "v10.md")).toBe(false);
		expect(surfaceGlobMatches("a+b.(x).md", "a+b.(x).md")).toBe(true);
		expect(surfaceGlobMatches("*.md", "aXmd")).toBe(false);
	});
});

describe("source lists and spec_list skip", () => {
	it("accepts a list of 2 to 6 sources wherever a source goes, and a spec_list that skips keys", () => {
		const line = ["specs.json#/overview/tagline", "specs.json#/tagline", { value: "A band" }];
		const layout = parseSurfaceLayout(
			layoutWith([
				{ type: "title", line },
				{ type: "spec_list", from: "specs.json", skip: ["overview", "bom"], heading: "Other details" },
			]),
		);
		expect(layout.tabs[0]?.blocks).toEqual([
			{ type: "title", line },
			{ type: "spec_list", from: "specs.json", skip: ["overview", "bom"], heading: "Other details" },
		]);
	});

	it("refuses a list that is too short, too long or holds a list", () => {
		expect(refusal(layoutWith([{ type: "title", line: ["specs.json#/tagline"] }]))).toBe(
			"layout.tabs[0].blocks[0].line must hold 2 to 6 entries, not 1",
		);
		expect(refusal(layoutWith([{ type: "title", line: Array.from({ length: 7 }, () => "specs.json") }]))).toBe(
			"layout.tabs[0].blocks[0].line must hold 2 to 6 entries, not 7",
		);
		expect(refusal(layoutWith([{ type: "title", line: ["specs.json", ["specs.json"]] }]))).toBe(
			"layout.tabs[0].blocks[0].line[1] is a list inside a list; a list of sources holds sources only",
		);
		expect(refusal(layoutWith([{ type: "title", line: ["specs.json", "../specs.json"] }]))).toMatch(
			/^layout\.tabs\[0\]\.blocks\[0\]\.line\[1\] /,
		);
	});

	it("reads a block with a broken source list as unknown and keeps the rest", () => {
		const read = readSurfaceLayout(
			JSON.stringify(layoutWith([{ type: "title", line: ["specs.json", ["x.json"]] }, { type: "files" }])),
		);
		expect("layout" in read && read.layout.tabs[0]?.blocks.map((node) => node.type)).toEqual(["unknown", "files"]);
	});
});

describe("the block registry", () => {
	it("holds one entry per type: eleven families and the row", () => {
		const types = SURFACE_BLOCKS.map((block) => block.type);
		expect(types).toEqual([...SURFACE_BLOCK_TYPES, "row"]);
		expect(new Set(types).size).toBe(14);
		const families = new Set(SURFACE_BLOCKS.filter((block) => block.type !== "row").map((block) => block.family));
		expect(families.size).toBe(11);
	});

	it("is what the parser accepts, field by field", () => {
		for (const block of SURFACE_BLOCKS) {
			if (block.type === "row") continue;
			const names = ["type", "id", ...block.fields.map((field) => field.name)];
			expect(refusal(layoutWith([{ type: block.type, notAField: 1 }]))).toBe(
				`layout.tabs[0].blocks[0] has a field that ${block.type} does not take; its fields are ${names.join(", ")}`,
			);
			const required = block.fields.find((field) => field.required);
			if (required) {
				expect(refusal(layoutWith([{ type: block.type }]))).toBe(
					`layout.tabs[0].blocks[0].${required.name} is missing; ${block.type} needs it`,
				);
			}
		}
	});

	it("describes every type for the prompt, within 3 KB", () => {
		const text = describeSurfaceBlocks();
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(3072);
		expect(text).toContain(SURFACE_LAYOUT_PATH);
		expect(text).toContain(SURFACE_LAYOUT_SCHEMA);
		for (const block of SURFACE_BLOCKS) {
			expect(text).toContain(`- ${block.type}: `);
			for (const field of block.fields) expect(text).toContain(`${field.name}${field.required ? "" : "?"}`);
		}
		expect(text).not.toMatch(/parse|registry|\.ts\b|function/i);
		expect(text).toContain("A source may be a list of 2-6 sources tried in order; the first found wins.");
		expect(text).toContain("- spec_list: labelled values; nested objects as groups; found but empty, or skip with nothing left, draws nothing.");
	});
});

function nodesOf(layout: SurfaceLayout): SurfaceLayoutNode[] {
	return layout.tabs.flatMap((tab) =>
		tab.blocks.flatMap((node) => (node.type === "row" ? [node, ...node.blocks] : [node])),
	);
}

function sourcesOf(value: unknown, key = ""): string[] {
	if (typeof value === "string") return ["from", "model", "tint", "name", "line"].includes(key) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((item) => sourcesOf(item, key));
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([entry, item]) => sourcesOf(item, entry));
	}
	return [];
}

describe("starter layouts", () => {
	it("pass the strict parser unchanged and come back as copies", () => {
		for (const kind of SURFACE_STARTER_KINDS) {
			const starter = SURFACE_STARTER_LAYOUTS[kind];
			expect(parseSurfaceLayout(starter)).toEqual(starter);
			expect(JSON.stringify(parseSurfaceLayout(starter))).toBe(JSON.stringify(starter));
			const copy = starterSurfaceLayout(kind);
			expect(copy).toEqual(starter);
			expect(copy).not.toBe(starter);
		}
	});

	it("bind Product and Custom inside their folder and Identity to the canonical identity files", () => {
		for (const kind of SURFACE_STARTER_KINDS) {
			for (const source of sourcesOf(SURFACE_STARTER_LAYOUTS[kind])) {
				const { path } = parseSurfaceBinding(source);
				expect(() => surfaceCompanyPath("surfaces/x", path)).not.toThrow();
				if (kind === "identity") expect(path.startsWith("/identity/")).toBe(true);
				else expect(path.startsWith("/")).toBe(false);
			}
		}
		const identityPaths = sourcesOf(SURFACE_STARTER_LAYOUTS.identity).map(
			(source) => parseSurfaceBinding(source).path,
		);
		for (const canonical of [IDENTITY_COMPANY_PATH, IDENTITY_TOKENS_JSON_PATH, IDENTITY_LOGO_PATH]) {
			expect(identityPaths).toContain(`/${canonical}`);
		}
		const voice = nodesOf(SURFACE_STARTER_LAYOUTS.identity).find(
			(node) => node.type === "files" && node.id === "voice",
		);
		expect(voice).toMatchObject({ match: [`/${IDENTITY_VOICE_PATH}`, `/${IDENTITY_BRIEF_PATH}`] });
	});

	it("keeps the product page's homes in today's order", () => {
		const product = SURFACE_STARTER_LAYOUTS.product;
		expect(product.tabs.map((tab) => tab.title)).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files"]);
		expect(product.tabs[0]?.blocks.map((node) => node.type)).toEqual(["stage_3d", "title", "swatch_row", "facts"]);
		expect(product.tabs[0]?.blocks[1]).toEqual({
			type: "title",
			line: [
				"specs.json#/overview/tagline",
				"specs.json#/tagline",
				"specs.json#/overview/summary",
				"specs.json#/summary",
				"specs.json#/overview/description",
				"specs.json#/description",
			],
		});
		expect(product.tabs[0]?.blocks[3]).toMatchObject({ from: "specs.json#/overview", take: 4 });
		expect(product.tabs[1]?.blocks.map((node) => node.type)).toEqual(["spec_list", "table", "spec_list"]);
		expect(product.tabs[1]?.blocks[2]).toEqual({
			type: "spec_list",
			from: "specs.json",
			skip: ["overview", "bom", "model", "colorways", "tagline", "summary", "description"],
			heading: "Other details",
		});
		expect(product.tabs[2]?.blocks.map((node) => node.type)).toEqual(["spec_list", "cards"]);
		expect(product.tabs[2]?.blocks[1]).toMatchObject({
			lines: ["component", "unitPrice", "moq", "leadTime", "region", "certifications"],
		});
		expect(product.tabs[3]?.blocks).toEqual([{ type: "report", match: "**/*.report.json" }]);
		expect(product.tabs[4]?.blocks).toEqual([
			{ type: "files", match: ["**/*.md", "**/*.markdown", "**/*.txt", "**/*.svg", "**/*.html", "**/*.htm"] },
		]);
	});

	it("gives Identity its homes in order, the face first", () => {
		const identity = SURFACE_STARTER_LAYOUTS.identity;
		const ids = nodesOf(identity).flatMap((node) => (node.type !== "row" && node.id ? [node.id] : []));
		expect(ids).toEqual([
			"logo",
			"wordmark",
			"name",
			"mission",
			"palette",
			"type",
			"strategy",
			"philosophy",
			"voice",
		]);
		expect(identity.tabs[0]?.blocks[0]).toMatchObject({
			type: "row",
			blocks: [{ type: "brand_mark" }, { type: "brand_mark" }],
		});
	});

	it("starts Custom with a title and its files", () => {
		expect(SURFACE_STARTER_LAYOUTS.custom.tabs).toEqual([
			{ id: "overview", title: "Overview", blocks: [{ type: "title" }, { type: "files" }] },
		]);
	});
});
