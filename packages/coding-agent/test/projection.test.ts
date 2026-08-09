import { describe, expect, it } from "vitest";
import { PROJECTION_SCHEMA, parseProjectionDocument } from "../src/core/projection.ts";

describe("company UI projection", () => {
	it("accepts the bounded Department → Category → Page hierarchy with stable IDs", () => {
		const projection = parseProjectionDocument({
			schema: PROJECTION_SCHEMA,
			default: "page:finance.overview",
			navigation: ["department:finance"],
			nodes: [
				{
					id: "department:finance",
					kind: "department",
					label: "Finance",
					items: ["page:finance.overview", "category:finance.planning"],
				},
				{
					id: "category:finance.planning",
					kind: "category",
					label: "Planning",
					items: ["page:finance.outlook"],
				},
				{
					id: "page:finance.overview",
					kind: "page",
					label: "Overview",
					view: { type: "surface", entry: "finance/overview.html" },
				},
				{
					id: "page:finance.outlook",
					kind: "page",
					label: "Outlook",
					view: { type: "surface", entry: "finance/outlook.html" },
				},
			],
		});

		expect(projection.diagnostics).toEqual([]);
		expect(projection.navigation).toEqual(["department:finance"]);
		expect(projection.default).toBe("page:finance.overview");
	});

	it("rejects reserved IDs, missing references, and category nesting", () => {
		const projection = parseProjectionDocument({
			schema: PROJECTION_SCHEMA,
			navigation: ["department:ops"],
			nodes: [
				{ id: "q:main", kind: "department", label: "Fake Main", items: [] },
				{ id: "department:ops", kind: "department", label: "Operations", items: ["category:ops.queue"] },
				{
					id: "category:ops.queue",
					kind: "category",
					label: "Queue",
					items: ["category:ops.nested", "page:ops.missing"],
				},
				{ id: "category:ops.nested", kind: "category", label: "Nested", items: [] },
			],
		});

		expect(projection.diagnostics).toEqual(
			expect.arrayContaining([
				expect.stringContaining("reserved q: namespace"),
				expect.stringContaining("may contain pages only"),
				expect.stringContaining("missing node page:ops.missing"),
			]),
		);
	});

	it("fails closed when the projection schema is unsupported", () => {
		const projection = parseProjectionDocument({
			schema: "qorpera.projection/v2",
			navigation: ["department:finance"],
			nodes: [{ id: "department:finance", kind: "department", label: "Finance", items: [] }],
		});

		expect(projection.navigation).toEqual([]);
		expect(projection.nodes).toEqual([]);
		expect(projection.diagnostics).toEqual([expect.stringContaining(PROJECTION_SCHEMA)]);
	});
});
