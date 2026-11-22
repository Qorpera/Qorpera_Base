import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SURFACE_KINDS, surfaceFigureOf, surfaceKindFigure } from "../src/app/surface-kinds.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { DANISH } from "../src/ui/danish/index.ts";
import {
	SURFACE_FIGURE_IDS,
	SURFACE_FIGURE_NAMES,
	surfaceFigure,
	surfaceFigureFromIcon,
	surfaceFigureIcon,
} from "../src/ui/surface-figure.ts";
import { COMPANY, fakeClient, storeWith, summary } from "./surface-fixtures.ts";

describe("surface figures", () => {
	it("ships one picture per figure and nothing else", () => {
		const files = readdirSync(new URL("../public/assets/surfaces/figures-v1/", import.meta.url)).sort();
		expect(files).toEqual(SURFACE_FIGURE_IDS.map((id) => `${id}.png`).sort());
	});

	it("names every figure in English and Danish", () => {
		for (const id of SURFACE_FIGURE_IDS) expect(DANISH[SURFACE_FIGURE_NAMES[id]], id).toBeTruthy();
	});

	it("reads a chosen figure from the icon and ignores anything else", () => {
		expect(surfaceFigureIcon("piggy")).toBe("figure:piggy");
		expect(surfaceFigureFromIcon("figure:piggy")).toBe("piggy");
		expect(surfaceFigureFromIcon("figure:dragon")).toBeUndefined();
		expect(surfaceFigureFromIcon("mail")).toBeUndefined();
		expect(surfaceFigureFromIcon(null)).toBeUndefined();
	});

	it("gives every kind its own figure, and a chosen figure wins", () => {
		for (const kind of SURFACE_KINDS) expect(SURFACE_FIGURE_IDS).toContain(surfaceKindFigure(kind));
		expect(surfaceFigureOf({ icon: "globe" }, { kind: "website" })).toBe("browser");
		expect(surfaceFigureOf({ icon: "figure:jar" }, { kind: "website" })).toBe("jar");
		expect(surfaceFigureOf({ icon: "mail" }, { kind: "custom" })).toBe("envelope");
		expect(surfaceFigureOf({ icon: "rocket" }, { kind: "custom" })).toBe("gem");
		expect(surfaceFigureOf({ icon: "page" }, { kind: "money" })).toBe("money");
	});

	it("draws the picture with two eyes and becomes a ! when it needs you", () => {
		const resting = surfaceFigure("money");
		expect(resting.classList.contains("is-rest")).toBe(true);
		expect(resting.querySelector("img")?.getAttribute("src")).toMatch(/\/assets\/surfaces\/figures-v1\/money\.png$/);
		expect(resting.querySelectorAll(".surface-figure-eye")).toHaveLength(2);
		expect(resting.querySelector(".surface-figure-ask")).toBeNull();
		const asking = surfaceFigure("money", "attention");
		expect(asking.querySelector(".surface-figure-ask")?.textContent).toBe("!");
		expect(surfaceFigure("money", "working").classList.contains("is-working")).toBe(true);
	});
});

describe("a surface's figure in the rail", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("rests, works while sessions run, and asks when it needs you, with words for screen readers", async () => {
		const surfaces = [
			summary(),
			summary({ id: "s-busy", slug: "shop", title: "Shop", runningSessionCount: 2 }),
			summary({ id: "s-asks", slug: "mail", title: "Mail", runningSessionCount: 1, needsAttentionCount: 1 }),
		];
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => surfaces) }));
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const row = (slug: string) => rail.el.querySelector<HTMLElement>(`.rail-surface[data-surface-slug="${slug}"]`)!;
		const state = (slug: string) => row(slug).querySelector(".surface-figure")?.className;
		const said = (slug: string) => row(slug).querySelector(".visually-hidden")?.textContent ?? null;

		expect(state("website")).toContain("is-rest");
		expect(said("website")).toBeNull();
		expect(state("shop")).toContain("is-working");
		expect(said("shop")).toBe("Working");
		expect(state("mail")).toContain("is-attention");
		expect(row("mail").querySelector(".surface-figure-ask")?.textContent).toBe("!");
		expect(said("mail")).toBe("Needs your attention");
		store.dispose();
	});
});
