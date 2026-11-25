import { afterEach, describe, expect, it, vi } from "vitest";
import { dataAskLine } from "../src/app/data-ask.ts";
import { columnLabel, humanName, listedColumns, shownValue } from "../src/app/views/data.ts";
import { dataGroups, fieldWeights, squarify } from "../src/app/views/data-home.ts";

describe("names in two lines (app/views/data-home.ts)", () => {
	it("gathers tables that start with the same word under that word", () => {
		expect(
			dataGroups(
				["app_users", "calculation_attempts", "calculation_jobs", "hand_actions", "notes", "hand_decisions"],
				humanName,
			),
		).toEqual([
			{ title: "App users", members: [{ name: "app_users", short: "App users" }] },
			{
				title: "Calculation",
				members: [
					{ name: "calculation_attempts", short: "Attempts" },
					{ name: "calculation_jobs", short: "Jobs" },
				],
			},
			{
				title: "Hand",
				members: [
					{ name: "hand_actions", short: "Actions" },
					{ name: "hand_decisions", short: "Decisions" },
				],
			},
			{ title: "Notes", members: [{ name: "notes", short: "Notes" }] },
		]);
	});

	it("keeps a table named as the shared word itself readable", () => {
		expect(dataGroups(["hand", "hand_actions"], humanName)[0]?.members).toEqual([
			{ name: "hand", short: "Hand" },
			{ name: "hand_actions", short: "Actions" },
		]);
	});
});

describe("fields by size (app/views/data-home.ts)", () => {
	it("weighs a table by the root of its rows, with a floor so a small or empty one stays readable", () => {
		const [big, small, empty, unknown] = fieldWeights([10_000, 4, 0, undefined]);
		expect(big).toBe(100);
		expect(small).toBe(12);
		expect(empty).toBe(9);
		expect(unknown).toBe(12);
	});

	it("fills the whole box, each field in proportion to its weight and none outside it", () => {
		const weights = [36, 20, 10, 8, 6, 3];
		const box = { x: 0, y: 0, w: 1400, h: 1000 };
		const boxes = squarify(weights, box);
		const total = weights.reduce((sum, one) => sum + one, 0);
		expect(boxes).toHaveLength(weights.length);
		boxes.forEach((one, index) => {
			expect(one.w * one.h).toBeCloseTo(((weights[index] ?? 0) / total) * box.w * box.h, 3);
			expect(one.x).toBeGreaterThanOrEqual(-1e-6);
			expect(one.y).toBeGreaterThanOrEqual(-1e-6);
			expect(one.x + one.w).toBeLessThanOrEqual(box.w + 1e-6);
			expect(one.y + one.h).toBeLessThanOrEqual(box.h + 1e-6);
			expect(Math.max(one.w / one.h, one.h / one.w)).toBeLessThan(4);
		});
	});

	it("gives nothing for no fields and the whole box to a single one", () => {
		const box = { x: 10, y: 20, w: 300, h: 200 };
		expect(squarify([], box)).toEqual([]);
		expect(squarify([5], box)).toEqual([box]);
	});
});

describe("the list's columns (app/views/data.ts)", () => {
	const types: Record<string, string> = {
		id: "uuid",
		external_subject: "text",
		display_name: "text",
		role: "text",
		is_synthetic: "boolean",
		created_at: "timestamp with time zone",
		updated_at: "timestamp with time zone",
	};
	const typeOf = (name: string) => types[name];

	it("leads with the name and leaves ids and created times inside the row", () => {
		expect(listedColumns(Object.keys(types), ["id"], typeOf)).toEqual([
			"display_name",
			"external_subject",
			"role",
			"is_synthetic",
			"updated_at",
		]);
	});

	it("keeps a number key, and shows every column when nothing else would be left", () => {
		expect(listedColumns(["id", "bike", "price"], ["id"], (name) => (name === "bike" ? "text" : "integer"))).toEqual([
			"bike",
			"price",
			"id",
		]);
		expect(listedColumns(["id", "created_at"], ["id"], typeOf)).toEqual(["created_at", "id"]);
	});

	it("labels a yes/no column and a time without their plumbing words", () => {
		expect(columnLabel("is_synthetic", "boolean")).toBe("Synthetic");
		expect(columnLabel("updated_at", "time")).toBe("Updated");
		expect(columnLabel("is_synthetic", "text")).toBe("Is synthetic");
		expect(columnLabel("at", "time")).toBe("At");
	});
});

describe("a time in the list (app/views/data.ts)", () => {
	afterEach(() => vi.useRealTimers());

	it("shows without its year in the running year, and with it in any other", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
		expect(shownValue("2026-06-15T12:00:00+00:00", "time")).toMatch(/^15 Jun, \d{2}:\d{2}$/);
		expect(shownValue("2025-06-15T12:00:00+00:00", "time")).toMatch(/^15 Jun 2025, \d{2}:\d{2}$/);
	});
});

describe("Ask from the home (app/data-ask.ts)", () => {
	it("is about the database when no list is open", () => {
		expect(dataAskLine({ database: "workshop", databaseName: "Workshop", values: [] })).toBe(
			"page:data#workshop · Workshop",
		);
	});
});
