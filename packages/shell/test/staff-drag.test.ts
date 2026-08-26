import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface StaffDragOrder {
	pinned: string[];
	list: string[];
	order: string[];
}

interface PlacementItem {
	id: string;
	left: number;
	right: number;
	top: number;
	bottom: number;
}

interface StaffDragApi {
	moveOrder(
		pinnedIds: string[],
		listIds: string[],
		id: string,
		targetPinned: boolean,
		targetId?: string | null,
		after?: boolean,
	): StaffDragOrder;
	nearestPlacement(
		items: PlacementItem[],
		clientX: number,
		clientY: number,
		horizontal: boolean,
	): { targetId: string | null; after: boolean };
}

const context: { window: { qorperaStaffDrag?: StaffDragApi } } = { window: {} };
const source = readFileSync(new URL("../userland/staff-drag.js", import.meta.url), "utf8");
runInNewContext(source, context);
const drag = context.window.qorperaStaffDrag;
if (!drag) throw new Error("staff drag API did not initialize");

describe("staff drag ordering", () => {
	it("previews the reordered layout instead of marking a swap target", () => {
		expect(source).toContain("animateLayout(root");
		expect(source).toContain("applyOrder(pinnedZone, listZone");
		expect(source).not.toContain("staff-drop-before");
		expect(source).not.toContain("staff-drop-after");
	});

	it("uses the nearest grid card when the pointer crosses a gap", () => {
		const cards = [
			{ id: "a", left: 0, right: 72, top: 0, bottom: 84 },
			{ id: "b", left: 82, right: 154, top: 0, bottom: 84 },
		];
		expect(drag.nearestPlacement(cards, 77, 42, true)).toEqual({ targetId: "a", after: true });
		expect(drag.nearestPlacement(cards, 78, 42, true)).toEqual({ targetId: "b", after: false });
	});

	it("keeps a filtered pinned region hidden after drag cleanup", () => {
		expect(source).toContain("some((row) => !row.hidden)");
	});

	it("reorders agents within the ordinary list", () => {
		expect(drag.moveOrder(["p1"], ["a", "b", "c"], "c", false, "a")).toEqual({
			pinned: ["p1"],
			list: ["c", "a", "b"],
			order: ["p1", "c", "a", "b"],
		});
	});

	it("pins an agent at its grid drop position", () => {
		expect(drag.moveOrder(["p1", "p2"], ["a", "b"], "b", true, "p1", true)).toEqual({
			pinned: ["p1", "b", "p2"],
			list: ["a"],
			order: ["p1", "b", "p2", "a"],
		});
	});

	it("unpins an agent into the requested list position", () => {
		expect(drag.moveOrder(["p1", "p2"], ["a", "b"], "p1", false, "a", true)).toEqual({
			pinned: ["p2"],
			list: ["a", "p1", "b"],
			order: ["p2", "a", "p1", "b"],
		});
	});
});
