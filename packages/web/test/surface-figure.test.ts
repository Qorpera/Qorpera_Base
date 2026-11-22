import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_KINDS, surfaceFigureOf, surfaceKindFigure } from "../src/app/surface-kinds.ts";
import { DANISH } from "../src/ui/danish/index.ts";
import {
	SURFACE_FIGURE_IDS,
	SURFACE_FIGURE_NAMES,
	surfaceFigure,
	surfaceFigureFromIcon,
	surfaceFigureIcon,
} from "../src/ui/surface-figure.ts";

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
