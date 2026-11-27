import { describe, expect, it } from "vitest";
import {
	compareSurfaceLibraryPosts,
	describeSurfaceBlocks,
	describeSurfaceFormats,
	parseSurfaceLayout,
	readSurfaceLayout,
	readSurfaceLibrary,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_LIBRARY_DEFAULT_FILE,
	SURFACE_LIBRARY_DEFAULT_MATCH,
	SURFACE_LIBRARY_FEATURED_MAX,
	SURFACE_LIBRARY_FORMAT,
	SURFACE_LIBRARY_OPEN_MAX,
	SURFACE_LIBRARY_THEMES_MAX,
	SURFACE_REPORT_FORMAT,
	SURFACE_STARTER_KINDS,
	SURFACE_STARTER_LAYOUTS,
	surfaceLibraryThemeKey,
} from "../src/index.ts";

function layoutWith(blocks: readonly unknown[]): unknown {
	return { schema: SURFACE_LAYOUT_SCHEMA, tabs: [{ id: "research", title: "Research", blocks }] };
}

describe("the library block", () => {
	it("needs nothing named: the library file and the posts it shows have defaults", () => {
		expect(parseSurfaceLayout(layoutWith([{ type: "library" }])).tabs[0]?.blocks[0]).toEqual({
			type: "library",
			from: SURFACE_LIBRARY_DEFAULT_FILE,
			match: SURFACE_LIBRARY_DEFAULT_MATCH,
		});
		expect(
			parseSurfaceLayout(
				layoutWith([
					{ type: "library", id: "notes", from: "notes/library.json#/research", match: "notes/*.report.json" },
				]),
			).tabs[0]?.blocks[0],
		).toEqual({
			type: "library",
			id: "notes",
			from: "notes/library.json#/research",
			match: "notes/*.report.json",
		});
	});

	it("refuses a field it does not take, and an ask as its file", () => {
		expect(() => parseSurfaceLayout(layoutWith([{ type: "library", themes: [] }]))).toThrow(
			"layout.tabs[0].blocks[0] has a field that library does not take; its fields are type, id, from, match, heading",
		);
		expect(() => parseSurfaceLayout(layoutWith([{ type: "library", from: { ask: "qorpera/orders-now" } }]))).toThrow(
			"layout.tabs[0].blocks[0].from asks a question",
		);
		const read = readSurfaceLayout(JSON.stringify(layoutWith([{ type: "library", match: "a//b" }])));
		expect("layout" in read && read.layout.tabs[0]?.blocks[0]?.type).toBe("unknown");
	});

	it("is in the block reference, and brings the report and library formats to a layout that holds it", () => {
		const reference = describeSurfaceBlocks();
		expect(reference).toContain(
			`- library: the one home of research posts: themes, a featured post, all posts, a page per theme and post. from? source (${SURFACE_LIBRARY_DEFAULT_FILE}); match? glob (${SURFACE_LIBRARY_DEFAULT_MATCH}); heading?`,
		);
		const withLibrary = readSurfaceLayout(JSON.stringify(layoutWith([{ type: "library" }])));
		const withBoth = readSurfaceLayout(
			JSON.stringify(layoutWith([{ type: "report", match: "**/*" }, { type: "library" }])),
		);
		const withNeither = readSurfaceLayout(JSON.stringify(layoutWith([{ type: "title" }])));
		if (!("layout" in withLibrary) || !("layout" in withBoth) || !("layout" in withNeither))
			throw new Error("layout did not read");
		const formats = describeSurfaceFormats(withLibrary.layout);
		expect(formats.slice(0, 2)).toEqual([SURFACE_REPORT_FORMAT, SURFACE_LIBRARY_FORMAT]);
		expect(describeSurfaceFormats(withBoth.layout).filter((note) => note === SURFACE_REPORT_FORMAT)).toHaveLength(1);
		expect(describeSurfaceFormats(withNeither.layout)).not.toContain(SURFACE_LIBRARY_FORMAT);
		expect(SURFACE_LIBRARY_FORMAT).toContain(`default ${SURFACE_LIBRARY_DEFAULT_FILE}`);
		expect(SURFACE_LIBRARY_FORMAT).not.toMatch(/parse|registry|\.ts\b|function/i);
	});
});

describe("the Strategy starter", () => {
	it("keeps posts in one Research tab: no post home under another tab, and no Deep dives", () => {
		const strategy = SURFACE_STARTER_LAYOUTS.strategy;
		expect(strategy.tabs.map((tab) => tab.title)).toEqual([
			"Grand plan",
			"Economics",
			"Market",
			"Hypotheses",
			"Breakdowns",
			"Research",
		]);
		const blocks = strategy.tabs.flatMap((tab) =>
			tab.blocks.flatMap((node) => (node.type === "row" ? node.blocks : [node])),
		);
		expect(blocks.filter((block) => block.type === "report")).toEqual([]);
		expect(strategy.tabs.at(-1)).toEqual({
			id: "research",
			title: "Research",
			blocks: [
				{
					type: "library",
					id: "library",
					from: SURFACE_LIBRARY_DEFAULT_FILE,
					match: SURFACE_LIBRARY_DEFAULT_MATCH,
				},
			],
		});
	});

	it("is the only starter that changes: every other starter keeps its one posts tab", () => {
		const homes = Object.fromEntries(
			SURFACE_STARTER_KINDS.map((kind) => [
				kind,
				SURFACE_STARTER_LAYOUTS[kind].tabs.flatMap((tab) =>
					tab.blocks.flatMap((node) =>
						node.type === "report" || node.type === "library" ? [`${tab.title}:${node.type}`] : [],
					),
				),
			]),
		);
		expect(homes).toEqual({
			product: ["Reports:report"],
			identity: ["Philosophy:report"],
			strategy: ["Research:library"],
			analytics: ["Questions:report"],
			custom: ["Reports:report"],
		});
	});
});

describe("a library file", () => {
	it("reads its line, themes with their open questions, and featured posts", () => {
		expect(
			readSurfaceLibrary({
				line: " What we have found out, and what we still have to. ",
				themes: [
					{
						name: "Hardware",
						question: "What can the band be built on?",
						lead: "looks at what can be ordered today.",
						icon: "research/icons/hardware.svg",
						open: [
							{ what: "What a maker charges for 50", note: "A written quote closes it." },
							{ what: "The fee" },
						],
					},
					{ name: "Hair" },
				],
				featured: ["research/one.report.json", "/identity/why.report.json"],
			}),
		).toEqual({
			line: "What we have found out, and what we still have to.",
			themes: [
				{
					name: "Hardware",
					question: "What can the band be built on?",
					lead: "looks at what can be ordered today.",
					icon: "research/icons/hardware.svg",
					open: [{ what: "What a maker charges for 50", note: "A written quote closes it." }, { what: "The fee" }],
				},
				{ name: "Hair", open: [] },
			],
			featured: ["research/one.report.json", "/identity/why.report.json"],
		});
	});

	it("drops what it cannot use instead of failing, and reads anything else as an empty library", () => {
		expect(
			readSurfaceLibrary({
				line: "two\nlines",
				themes: [
					{ name: "  " },
					"Hardware",
					{ name: "Hardware", icon: "icons/hardware.png", open: [{ note: "no what" }, "text", { what: "Price" }] },
					{ name: "hardware", question: "A second theme of the same name?" },
					{ name: "Selling", icon: "../outside.svg", question: 7 },
				],
				featured: ["research/one.report.json", "research/one.report.json", "notes.md", "a//b.report.json", 3],
			}),
		).toEqual({
			themes: [
				{ name: "Hardware", open: [{ what: "Price" }] },
				{ name: "Selling", open: [] },
			],
			featured: ["research/one.report.json"],
		});
		for (const value of [undefined, null, "text", 3, [], [{ name: "Hardware" }]])
			expect(readSurfaceLibrary(value)).toEqual({ themes: [], featured: [] });
	});

	it("holds its counts: themes, open lines a theme and featured posts", () => {
		const read = readSurfaceLibrary({
			themes: Array.from({ length: SURFACE_LIBRARY_THEMES_MAX + 3 }, (_, index) => ({
				name: `Theme ${index}`,
				open: Array.from({ length: SURFACE_LIBRARY_OPEN_MAX + 2 }, (_, at) => ({ what: `Open ${at}` })),
			})),
			featured: Array.from({ length: SURFACE_LIBRARY_FEATURED_MAX + 2 }, (_, index) => `p${index}.report.json`),
		});
		expect(read.themes).toHaveLength(SURFACE_LIBRARY_THEMES_MAX);
		expect(read.themes[0]?.open).toHaveLength(SURFACE_LIBRARY_OPEN_MAX);
		expect(read.featured).toHaveLength(SURFACE_LIBRARY_FEATURED_MAX);
	});

	it("orders posts oldest first by calendar day, then by path, with undated posts first", () => {
		const posts = [
			{ date: "2026-01-12", path: "research/b.report.json" },
			{ date: "November 2026", path: "plan/old.report.json" },
			{ date: "2026-01-12", path: "research/a.report.json" },
			{ date: "2026-01-05", path: "research/z.report.json" },
			{ date: "", path: "notes/first.report.json" },
		];
		expect([...posts].sort(compareSurfaceLibraryPosts).map((post) => post.path)).toEqual([
			"notes/first.report.json",
			"plan/old.report.json",
			"research/z.report.json",
			"research/a.report.json",
			"research/b.report.json",
		]);
	});

	it("matches a post's theme to a named one whatever its case or spacing", () => {
		expect(surfaceLibraryThemeKey("  The   Sleeve ")).toBe("the sleeve");
		expect(surfaceLibraryThemeKey("Hardware")).toBe(surfaceLibraryThemeKey("hardware"));
	});
});
