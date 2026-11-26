import { describe, expect, it } from "vitest";
import {
	describeSurfaceFormats,
	inferSurfaceKind,
	SURFACE_REPORT_FORMAT,
	type SurfaceStudioFacts,
	starterSurfaceLayout,
	surfaceFilesHaveModel,
	surfaceLookKind,
	surfacePageKind,
	surfaceStarterKind,
	surfaceStudioPage,
	surfaceStudioPageWhenKnown,
} from "../src/index.ts";

const studio: SurfaceStudioFacts = {
	archetype: "studio",
	kind: "custom",
	slug: "field-notes",
	icon: "star",
	isGlobal: false,
	paths: [],
	hasModel: false,
};

describe("which page an interface gets", () => {
	it("reads the kind from the row, else from the slug and icon", () => {
		expect(surfaceLookKind({ ...studio, kind: "product" })).toBe("product");
		expect(surfaceLookKind({ ...studio, kind: "members" })).toBe("custom");
		expect(inferSurfaceKind({ slug: "manifesto", icon: "box", archetype: "studio" })).toBe("identity");
		expect(inferSurfaceKind({ slug: "headband", icon: "book", archetype: "studio" })).toBe("report");
		expect(inferSurfaceKind({ slug: "travel-kit", icon: "box", archetype: "studio" })).toBe("product");
		expect(inferSurfaceKind({ slug: "travel-kit", icon: "board", archetype: "studio" })).toBe("product");
		expect(inferSurfaceKind({ slug: "headband", icon: "star", archetype: "studio" })).toBe("product");
		expect(inferSurfaceKind({ slug: "crm", icon: "box", archetype: "studio" })).toBe("database");
		expect(inferSurfaceKind({ slug: "notes", icon: "spark", archetype: "studio" })).toBe("brand");
		expect(inferSurfaceKind({ slug: "notes", icon: "star", archetype: "studio" })).toBe("custom");
	});

	it("draws a report look as a reading page and every other studio from a layout", () => {
		expect(surfacePageKind({ archetype: "studio", lookKind: "report" })).toBe("report");
		expect(surfacePageKind({ archetype: "studio", lookKind: "database" })).toBe("layout");
		expect(surfacePageKind({ archetype: "live_build", lookKind: "report" })).toBeNull();
	});

	it("picks the Identity, Product, Analytics or Custom starter as the page does", () => {
		const facts = { lookKind: "custom" as const, slug: "field-notes", isGlobal: false, paths: [], hasModel: false };
		expect(surfaceStarterKind(facts)).toBe("custom");
		expect(surfaceStarterKind({ ...facts, isGlobal: true })).toBe("identity");
		expect(surfaceStarterKind({ ...facts, lookKind: "identity" })).toBe("identity");
		expect(surfaceStarterKind({ ...facts, slug: "identity" })).toBe("identity");
		expect(surfaceStarterKind({ ...facts, paths: ["identity/tokens.json"] })).toBe("identity");
		expect(surfaceStarterKind({ ...facts, lookKind: "product" })).toBe("product");
		expect(surfaceStarterKind({ ...facts, hasModel: true })).toBe("product");
		expect(surfaceStarterKind({ ...facts, lookKind: "product", isGlobal: true })).toBe("identity");
		expect(surfaceStarterKind({ ...facts, lookKind: "dashboard" })).toBe("analytics");
		expect(surfaceStarterKind({ ...facts, slug: "analytics" })).toBe("analytics");
		expect(surfaceStarterKind({ ...facts, lookKind: "dashboard", hasModel: true })).toBe("analytics");
		expect(surfaceStudioPage({ ...studio, icon: "box" })).toEqual({ page: "layout", starter: "product" });
		expect(surfaceStudioPage({ ...studio, icon: "book" })).toEqual({ page: "report" });
		expect(surfaceStudioPage({ ...studio, archetype: "ops" })).toEqual({ page: null });
	});

	it("finds a model the way the page does: a .glb, or the first JSON file with a model group", () => {
		expect(surfaceFilesHaveModel({}, ["surfaces/x/model.GLB"])).toBe(true);
		expect(surfaceFilesHaveModel({}, ["surfaces/x/photo.png"])).toBe(false);
		expect(surfaceFilesHaveModel({ "surfaces/x/specs.json": '{"Geometry":{"kind":"device"}}' }, [])).toBe(true);
		expect(
			surfaceFilesHaveModel(
				{ "surfaces/x/a.json": '{"model":"box.glb"}', "surfaces/x/b.json": '{"model":{"kind":"device"}}' },
				[],
			),
		).toBe(false);
		expect(
			surfaceFilesHaveModel(
				{
					"surfaces/x/object.json": '{"model":{"kind":"device"}}',
					"surfaces/x/one.report.json": '{"model":{"kind":"device"}}',
					"surfaces/x/notes.md": "model",
					"surfaces/x/broken.json": "{",
				},
				[],
			),
		).toBe(false);
	});

	it("answers from partial facts only when every missing value gives the same page", () => {
		const partial = { ...studio, icon: null, isGlobal: null, hasOwnLayout: false };
		expect(surfaceStudioPageWhenKnown({ ...partial, kind: "product" })).toBeUndefined();
		expect(surfaceStudioPageWhenKnown({ ...partial, kind: "product", hasOwnLayout: true })).toEqual({
			page: "layout",
			starter: "product",
		});
		expect(surfaceStudioPageWhenKnown({ ...partial, hasOwnLayout: true })).toBeUndefined();
		expect(surfaceStudioPageWhenKnown({ ...partial, kind: "report" })).toEqual({ page: "report" });
		expect(surfaceStudioPageWhenKnown({ ...partial, slug: "identity" })).toEqual({
			page: "layout",
			starter: "identity",
		});
		expect(surfaceStudioPageWhenKnown({ ...partial, slug: "market-research" })).toEqual({ page: "report" });
		expect(surfaceStudioPageWhenKnown({ ...partial, icon: "box", isGlobal: false })).toEqual({
			page: "layout",
			starter: "product",
		});
	});
});

describe("format notes beside the blocks", () => {
	it("names the formats of the blocks a layout holds", () => {
		const product = describeSurfaceFormats(starterSurfaceLayout("product"));
		expect(product).toHaveLength(2);
		expect(product[0]).toContain("A stage_3d model file (default object.json)");
		expect(product[1]).toBe(SURFACE_REPORT_FORMAT);
		const identity = describeSurfaceFormats(starterSurfaceLayout("identity"));
		expect(identity).toHaveLength(2);
		expect(identity[0]).toContain("/identity/tokens.css is compiled from it");
		expect(describeSurfaceFormats(starterSurfaceLayout("custom"))).toEqual([SURFACE_REPORT_FORMAT]);
	});
});
