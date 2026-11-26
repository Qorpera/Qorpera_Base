// @vitest-environment jsdom
import { SURFACE_LAYOUT_SCHEMA, type SurfaceSummary } from "@qorpera/contracts";
import { getInstanceByDom } from "echarts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioHtmlPages } from "../src/app/views/surface-blocks/artifacts.ts";
import { SurfaceLayoutView } from "../src/app/views/surface-layout-view.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fakeClient, storeWith, summary } from "./surface-fixtures.ts";

const ROOT = "surfaces/strategy";
const HTML_PAGES: StudioHtmlPages = {
	frame: () => document.createElement("iframe"),
	linksChanged: () => false,
};

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
	if (typeof HTMLDialogElement !== "undefined") {
		HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
			this.setAttribute("open", "");
		};
		HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
			this.removeAttribute("open");
		};
	}
});

afterEach(() => {
	setLanguagePreference("en");
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function strategySurface(): SurfaceSummary {
	return summary({
		id: "22222222-2222-4222-8222-222222222250",
		slug: "strategy",
		title: "Strategy",
		archetype: "studio",
		kind: "strategy",
		icon: "figure:lighthouse",
		sourceKind: "folder",
		repositoryKey: null,
		folderRoot: ROOT,
		siteSlug: null,
		previewMode: "studio_overlay",
		liveUrl: null,
	});
}

describe("Studio chart block", () => {
	it("renders empty state when chart data is missing", () => {
		const controller = new AbortController();
		const surface = strategySurface();
		const view = new SurfaceLayoutView({
			store: storeWith(fakeClient()),
			surface,
			signal: controller.signal,
			baseFiles: () => ({}),
		});
		const files = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: SURFACE_LAYOUT_SCHEMA,
				tabs: [
					{
						id: "overview",
						title: "Overview",
						blocks: [{ type: "chart", from: "charts/missing.json", heading: "MRR" }],
					},
				],
			}),
		};
		const plan = view.plan({
			surface,
			files,
			baseFiles: files,
			binaries: {},
			baseBinaries: {},
			company: undefined,
			briefSummary: "",
			starter: "strategy",
			tab: "overview",
			legacyModel: undefined,
			htmlPages: HTML_PAGES,
		});
		const el = plan.tasks[0]!.build();
		expect(el.dataset.block).toBe("chart");
		expect(el.textContent).toContain("No chart data yet");
		controller.abort();
	});

	it("mounts ECharts SVG across chart kinds, expands fullscreen, and disposes on abort", async () => {
		const controller = new AbortController();
		const surface = strategySurface();
		const view = new SurfaceLayoutView({
			store: storeWith(fakeClient()),
			surface,
			signal: controller.signal,
			baseFiles: () => ({}),
		});
		const files = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: SURFACE_LAYOUT_SCHEMA,
				tabs: [
					{
						id: "overview",
						title: "Overview",
						blocks: [
							{ type: "chart", id: "arr", from: "charts/arr.json", heading: "ARR Growth", height: 320 },
							{ type: "chart", id: "flow", from: "charts/flow.json" },
							{ type: "chart", id: "heat", from: "charts/heat.json" },
						],
					},
				],
			}),
			[`${ROOT}/charts/arr.json`]: JSON.stringify({
				kind: "area",
				title: "ARR Growth",
				subtitle: "Monthly recurring revenue",
				unit: "$",
				smooth: true,
				categories: ["Jan", "Feb", "Mar"],
				series: [{ name: "MRR", data: [10000, 18000, 29000], markLine: [{ value: 25000, label: "Goal" }] }],
			}),
			[`${ROOT}/charts/flow.json`]: JSON.stringify({
				kind: "sankey",
				title: "Funnel Flow",
				links: [
					{ source: "Visitors", target: "Trials", value: 300 },
					{ source: "Trials", target: "Customers", value: 75 },
				],
			}),
			[`${ROOT}/charts/heat.json`]: JSON.stringify({
				kind: "heatmap",
				title: "Retention",
				unit: "%",
				xCategories: ["M1", "M2"],
				yCategories: ["Jan", "Feb"],
				cells: [
					[0, 0, 100],
					[1, 0, 88],
					[0, 1, 100],
					[1, 1, 91],
				],
			}),
		};
		const plan = view.plan({
			surface,
			files,
			baseFiles: files,
			binaries: {},
			baseBinaries: {},
			company: undefined,
			briefSummary: "",
			starter: "strategy",
			tab: "overview",
			legacyModel: undefined,
			htmlPages: HTML_PAGES,
		});
		for (const task of plan.tasks) document.body.append(task.build());

		const hosts = [...document.querySelectorAll<HTMLElement>(".studio-chart-host")];
		expect(hosts).toHaveLength(3);
		await vi.waitFor(
			() => {
				expect(hosts.map((host) => host.dataset.chart)).toEqual(["area", "sankey", "heatmap"]);
				for (const host of hosts) {
					expect(getInstanceByDom(host)).toBeTruthy();
					expect(host.querySelector("svg")).toBeTruthy();
				}
			},
			{ timeout: 5_000, interval: 10 },
		);

		const expand = document.querySelector<HTMLButtonElement>('[data-act="studio-expand"]');
		expect(expand).toBeTruthy();
		expand!.click();
		await vi.waitFor(
			() => {
				expect(document.querySelector(".studio-chart-host.is-fullscreen")?.getAttribute("data-chart")).toBe("area");
			},
			{ timeout: 5_000, interval: 10 },
		);

		controller.abort();
		for (const host of hosts) {
			expect(getInstanceByDom(host)).toBeUndefined();
		}
	});

	it("applies explicit axis min/max bounds and custom series/point colors", async () => {
		const controller = new AbortController();
		const surface = strategySurface();
		const view = new SurfaceLayoutView({
			store: storeWith(fakeClient()),
			surface,
			signal: controller.signal,
			baseFiles: () => ({}),
		});
		const files = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: SURFACE_LAYOUT_SCHEMA,
				tabs: [
					{
						id: "overview",
						title: "Overview",
						blocks: [
							{ type: "chart", id: "scores", from: "charts/scores.json" },
							{ type: "chart", id: "horiz", from: "charts/horiz.json" },
						],
					},
				],
			}),
			[`${ROOT}/charts/scores.json`]: JSON.stringify({
				kind: "bar",
				title: "Scores",
				yAxisMin: 0,
				yAxisMax: 10,
				categories: ["A", "B"],
				series: [
					{
						name: "Score",
						color: "#2b6cb0",
						data: [6, { value: 8, color: "#0f7a55" }],
					},
				],
			}),
			[`${ROOT}/charts/horiz.json`]: JSON.stringify({
				kind: "bar",
				title: "Horizontal",
				horizontal: true,
				xAxisMin: 0,
				xAxisMax: 100,
				categories: ["Speed"],
				series: [{ name: "Pct", color: "#7c4dff", data: [65] }],
			}),
		};
		const plan = view.plan({
			surface,
			files,
			baseFiles: files,
			binaries: {},
			baseBinaries: {},
			company: undefined,
			briefSummary: "",
			starter: "strategy",
			tab: "overview",
			legacyModel: undefined,
			htmlPages: HTML_PAGES,
		});
		for (const task of plan.tasks) document.body.append(task.build());

		const hosts = [...document.querySelectorAll<HTMLElement>(".studio-chart-host")];
		expect(hosts).toHaveLength(2);
		await vi.waitFor(
			() => {
				expect(hosts.every((host) => Boolean(getInstanceByDom(host)?.getOption()))).toBe(true);
			},
			{ timeout: 5_000, interval: 10 },
		);

		const barOpt = getInstanceByDom(hosts[0]!)!.getOption() as {
			yAxis: { min?: number; max?: number }[];
			series: { itemStyle?: { color?: string }; data?: unknown[] }[];
		};
		expect(barOpt.yAxis[0]?.min).toBe(0);
		expect(barOpt.yAxis[0]?.max).toBe(10);
		expect(barOpt.series[0]?.itemStyle?.color).toBe("#2b6cb0");
		expect(barOpt.series[0]?.data?.[1]).toMatchObject({ value: 8, itemStyle: { color: "#0f7a55" } });

		const horizOpt = getInstanceByDom(hosts[1]!)!.getOption() as {
			xAxis: { min?: number; max?: number }[];
			series: { itemStyle?: { color?: string } }[];
		};
		expect(horizOpt.xAxis[0]?.min).toBe(0);
		expect(horizOpt.xAxis[0]?.max).toBe(100);
		expect(horizOpt.series[0]?.itemStyle?.color).toBe("#7c4dff");

		controller.abort();
	});
});
