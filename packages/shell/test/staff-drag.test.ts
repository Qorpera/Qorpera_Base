import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface StaffDragOrder {
	pinned: string[];
	list: string[];
	order: string[];
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
}

const context: { window: { qorperaStaffDrag?: StaffDragApi } } = { window: {} };
runInNewContext(readFileSync(new URL("../userland/staff-drag.js", import.meta.url), "utf8"), context);
const drag = context.window.qorperaStaffDrag;
if (!drag) throw new Error("staff drag API did not initialize");

describe("staff drag ordering", () => {
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
