import { describe, expect, it } from "vitest";
import {
	describeSurfaceBlocks,
	parseSurfaceChartDocument,
	parseSurfaceLayout,
	SURFACE_BLOCK_TYPES,
	SURFACE_CHART_KINDS,
	SURFACE_LAYOUT_SCHEMA,
} from "../src/index.ts";

describe("parseSurfaceChartDocument", () => {
	it("parses line, bar, area, scatter, pie, and funnel charts with bounds and color validation", () => {
		const line = parseSurfaceChartDocument({
			kind: "line",
			title: "ARR Growth",
			subtitle: "Monthly recurring revenue",
			unit: "$",
			smooth: true,
			categories: ["Jan", "Feb", "Mar"],
			series: [
				{
					name: "Actual",
					color: "var(--studio-accent)",
					data: [12000, 18500, { value: 26000, name: "Mar" }],
					markLine: [{ value: 25000, label: "Target" }],
				},
			],
		});
		expect(line).toEqual({
			kind: "line",
			title: "ARR Growth",
			subtitle: "Monthly recurring revenue",
			unit: "$",
			smooth: true,
			categories: ["Jan", "Feb", "Mar"],
			series: [
				{
					name: "Actual",
					color: "var(--studio-accent)",
					data: [12000, 18500, { value: 26000, name: "Mar" }],
					markLine: [{ value: 25000, label: "Target" }],
				},
			],
		});

		const scatter = parseSurfaceChartDocument({
			kind: "scatter",
			series: [
				{
					name: "Cohorts",
					color: "javascript:alert(1)",
					data: [[10, 20, 5], { value: [30, 40], name: "Enterprise", color: "#0f7a55" }],
				},
			],
		});
		expect(scatter?.series?.[0]?.color).toBeUndefined();
		expect(scatter?.series?.[0]?.data).toEqual([
			{ value: [10, 20, 5] },
			{ value: [30, 40], name: "Enterprise", color: "#0f7a55" },
		]);

		const pie = parseSurfaceChartDocument({
			kind: "pie",
			donut: true,
			series: [
				{
					name: "Channels",
					data: [
						{ name: "Direct", value: 60 },
						{ name: "Partner", value: 40 },
					],
				},
			],
		});
		expect(pie?.donut).toBe(true);
		expect(pie?.series?.[0]?.data).toHaveLength(2);

		const bounded = parseSurfaceChartDocument({
			kind: "bar",
			xAxisMin: 0,
			xAxisMax: 100,
			yAxisMin: 0,
			yAxisMax: 10,
			categories: ["A", "B"],
			series: [
				{
					name: "Score",
					color: "hsl(152 65% 38%)",
					data: [6, { value: 9, color: "hsla(210, 70%, 45%, 0.9)" }],
				},
			],
		});
		expect(bounded?.xAxisMin).toBe(0);
		expect(bounded?.xAxisMax).toBe(100);
		expect(bounded?.yAxisMin).toBe(0);
		expect(bounded?.yAxisMax).toBe(10);
		expect(bounded?.series?.[0]?.color).toBe("hsl(152 65% 38%)");
		expect(bounded?.series?.[0]?.data[1]).toEqual({ value: 9, color: "hsla(210, 70%, 45%, 0.9)" });

		const inverted = parseSurfaceChartDocument({
			kind: "bar",
			yAxisMin: 10,
			yAxisMax: 5,
			xAxisMin: 4,
			xAxisMax: 4,
			series: [{ name: "Score", data: [6] }],
		});
		expect(inverted?.yAxisMin).toBeUndefined();
		expect(inverted?.yAxisMax).toBeUndefined();
		expect(inverted?.xAxisMin).toBeUndefined();
		expect(inverted?.xAxisMax).toBeUndefined();
	});

	it("parses sankey, radar, and heatmap charts and drops invalid entries", () => {
		const sankey = parseSurfaceChartDocument({
			kind: "sankey",
			nodes: ["Visits", { name: "Trial", color: "#d76f45" }],
			links: [
				{ source: "Visits", target: "Trial", value: 420 },
				{ source: "Trial", target: "Paid", value: 95 },
				{ source: "Paid", target: "Paid", value: 10 },
				{ source: "Visits", target: "Bad", value: -5 },
			],
		});
		expect(sankey?.nodes?.map((n) => n.name)).toEqual(["Visits", "Trial", "Paid"]);
		expect(sankey?.links).toHaveLength(2);

		const radar = parseSurfaceChartDocument({
			kind: "radar",
			indicators: [
				{ name: "Speed", max: 100 },
				{ name: "Quality", max: 100 },
				{ name: "Price", max: 100 },
			],
			series: [{ name: "Us", data: [90, 85, 80] }],
		});
		expect(radar?.indicators).toHaveLength(3);
		expect(
			parseSurfaceChartDocument({
				kind: "radar",
				indicators: [{ name: "A", max: 10 }],
				series: [{ name: "x", data: [1] }],
			}),
		).toBeNull();

		const heatmap = parseSurfaceChartDocument({
			kind: "heatmap",
			xCategories: ["W1", "W2"],
			yCategories: ["Jan", "Feb"],
			cells: [
				[0, 0, 100],
				[1, 0, 84],
				[5, 0, 10],
				[0, 1, 92],
			],
		});
		expect(heatmap?.cells).toEqual([
			[0, 0, 100],
			[1, 0, 84],
			[0, 1, 92],
		]);
	});

	it("rejects unknown chart kinds and empty payloads", () => {
		expect(parseSurfaceChartDocument(null)).toBeNull();
		expect(parseSurfaceChartDocument({ kind: "gauge", series: [{ name: "a", data: [1] }] })).toBeNull();
		expect(parseSurfaceChartDocument({ kind: "bar", series: [] })).toBeNull();
		expect(SURFACE_CHART_KINDS).toHaveLength(9);
	});

	it("accepts chart blocks in SurfaceLayout and keeps describeSurfaceBlocks within 3840 bytes", () => {
		expect(SURFACE_BLOCK_TYPES).toContain("chart");
		const parsed = parseSurfaceLayout({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "overview",
					title: "Overview",
					blocks: [
						{
							type: "chart",
							id: "arr-chart",
							from: "charts/arr.json",
							heading: "ARR Trajectory",
							caption: "Verified ledger + forecast",
							height: 360,
						},
					],
				},
			],
		});
		expect(parsed.tabs[0]?.blocks[0]).toEqual({
			type: "chart",
			id: "arr-chart",
			from: "charts/arr.json",
			heading: "ARR Trajectory",
			caption: "Verified ledger + forecast",
			height: 360,
		});
		expect(Buffer.byteLength(describeSurfaceBlocks(), "utf8")).toBeLessThanOrEqual(3840);
	});
});
