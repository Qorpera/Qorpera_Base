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

async function flushCharts(): Promise<void> {
	for (let i = 0; i < 6; i += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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
		await flushCharts();

		const hosts = [...document.querySelectorAll<HTMLElement>(".studio-chart-host")];
		expect(hosts).toHaveLength(3);
		expect(hosts.map((host) => host.dataset.chart)).toEqual(["area", "sankey", "heatmap"]);
		for (const host of hosts) {
			expect(getInstanceByDom(host)).toBeTruthy();
			expect(host.querySelector("svg")).toBeTruthy();
		}

		const expand = document.querySelector<HTMLButtonElement>('[data-act="studio-expand"]');
		expect(expand).toBeTruthy();
		expand!.click();
		await flushCharts();
		expect(document.querySelector(".studio-chart-host.is-fullscreen")?.getAttribute("data-chart")).toBe("area");

		controller.abort();
		for (const host of hosts) {
			expect(getInstanceByDom(host)).toBeUndefined();
		}
	});
});
