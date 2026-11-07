import { isUuid } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { timeOrderedUuid } from "../src/time-ordered-uuid.ts";

describe("timeOrderedUuid", () => {
	it("is a version 7 UUID the node's report checks accept", () => {
		for (let i = 0; i < 100; i++) {
			const id = timeOrderedUuid();
			// The same rule as parseRuntimeNodeHealth and qorpera_assert_runtime_node_health.
			expect(isUuid(id)).toBe(true);
			expect(id[14]).toBe("7");
		}
	});
	it("starts with the time in milliseconds", () => {
		const id = timeOrderedUuid(0x019a_2b3c_4d5e);
		expect(id.startsWith("019a2b3c-4d5e-7")).toBe(true);
	});
	it("sorts by time, as text and so in the database's uuid order", () => {
		const ids = [1_800_000_000_000, 1_800_000_000_001, 1_800_000_005_000, 1_800_003_600_000].map((at) =>
			timeOrderedUuid(at),
		);
		expect([...ids].sort()).toEqual(ids);
	});
	it("differs within one millisecond", () => {
		expect(new Set(Array.from({ length: 1000 }, () => timeOrderedUuid(1_800_000_000_000))).size).toBe(1000);
	});
});
