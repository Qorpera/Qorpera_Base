import type { JsonValue, SurfaceAskSource } from "@qorpera/contracts";
import {
	type CloudNativeTool,
	type CloudToolContext,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	askStudioPreview,
	renderStudioPreviewHtml,
	type StudioInspectAskAnswer,
	type StudioInspectSnapshot,
	studioAskChart,
	studioInspectAsker,
	studioPreviewAsks,
} from "@qorpera/runtime/cloud-surface-inspect-tool";
import { describe, expect, it } from "vitest";

const CONTEXT = { signal: new AbortController().signal, callId: "inspect-1" } as unknown as CloudToolContext;

const SNAPSHOT: StudioInspectSnapshot = {
	surfaceTitle: "Analytics",
	folderRoot: "surfaces/analytics",
	starter: "analytics",
	files: {},
	binaries: {},
};

const ANSWERS: Record<string, StudioInspectAskAnswer> = {
	"qorpera/orders-now": {
		state: "answered",
		columns: ["stripe", "orders_today", "sales_today", "to_pack"],
		rows: [["live", 5, 2100, 2]],
	},
	"qorpera/money-balance": { state: "refused", words: "No question qorpera/money-balance that you may read" },
	"qorpera/orders-days": {
		state: "answered",
		columns: ["day", "orders", "sales", "refunds"],
		rows: [
			["2026-11-25", 3, 1200, 0],
			["2026-11-26", 5, 2100, 150],
		],
	},
};

describe("inspect_surface with live asks", () => {
	it("asks each question of the tab once and reports every block: answered with rows and its figure, or refused", async () => {
		const asked: SurfaceAskSource[] = [];
		const snapshot = await askStudioPreview(
			SNAPSHOT,
			"now",
			async (ask) => {
				asked.push(ask);
				return ANSWERS[ask.ask] ?? { state: "unavailable", words: "none" };
			},
			CONTEXT,
		);
		expect(asked.map((ask) => ask.ask)).toEqual([
			"qorpera/orders-now",
			"qorpera/money-balance",
			"qorpera/orders-days",
		]);
		const rendered = renderStudioPreviewHtml({ snapshot, tabId: "now", theme: "light" });
		expect(rendered.asks).toEqual([
			{ block: "facts: Orders today", ask: "qorpera/orders-now", state: "answered", rows: 1, value: "5" },
			{ block: "facts: Sales today", ask: "qorpera/orders-now", state: "answered", rows: 1, value: "2100" },
			{ block: "facts: To pack", ask: "qorpera/orders-now", state: "answered", rows: 1, value: "2" },
			{
				block: "facts: In the bank",
				ask: "qorpera/money-balance",
				state: "refused",
				words: "No question qorpera/money-balance that you may read",
			},
			{ block: "Are more people buying?", ask: "qorpera/orders-days", state: "answered", rows: 2 },
		]);
		expect(rendered.renderedBlocks.find((block) => block.type === "chart")).toMatchObject({ filled: true });
		expect(rendered.warnings.join("\n")).not.toContain("has no valid chart data");
		expect(rendered.html).toContain("<svg");
	});

	it("says which named columns an answer lacks, leaves that block empty, and draws a missing value as a gap, never 0", async () => {
		const files = {
			"surfaces/analytics/layout.json": JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{
						id: "main",
						title: "Main",
						blocks: [
							{
								type: "chart",
								heading: "Is revenue up?",
								from: { ask: "qorpera/orders-days", x: "day", y: "revenue" },
							},
							{
								type: "facts",
								items: [{ label: "Orders", from: { ask: "qorpera/orders-now", pick: "orders" } }],
							},
						],
					},
				],
			}),
		};
		const snapshot = await askStudioPreview(
			{ ...SNAPSHOT, files },
			undefined,
			async (ask) => ANSWERS[ask.ask] ?? { state: "unavailable", words: "none" },
			CONTEXT,
		);
		const rendered = renderStudioPreviewHtml({ snapshot, theme: "light" });
		expect(rendered.asks).toEqual([
			{
				block: "Is revenue up?",
				ask: "qorpera/orders-days",
				state: "answered",
				rows: 2,
				missing: ["revenue"],
				columns: ["day", "orders", "sales", "refunds"],
			},
			{
				block: "facts: Orders",
				ask: "qorpera/orders-now",
				state: "answered",
				rows: 1,
				missing: ["orders"],
				columns: ["stripe", "orders_today", "sales_today", "to_pack"],
			},
		]);
		expect(rendered.renderedBlocks.map((block) => block.filled)).toEqual([false, false]);
		expect(rendered.warnings).toContain(
			"Is revenue up? asks qorpera/orders-days for revenue, which its answer has no column for; its columns are day, orders, sales, refunds.",
		);
		const chart = studioAskChart({ ask: "qorpera/orders-days", x: "day", y: "orders" }, [
			{ day: "2026-11-25", orders: null },
			{ day: "2026-11-26", orders: 4 },
		]);
		expect(chart && "series" in chart ? chart.series?.[0]?.data : undefined).toEqual([null, 4]);
	});

	it("reports a question whose source is not connected as not connected, and leaves its home empty", async () => {
		const words = "Not connected: orders count once card payments are connected or an order is added by hand";
		const snapshot = await askStudioPreview(
			SNAPSHOT,
			"now",
			async (ask) =>
				ask.ask === "qorpera/money-balance"
					? (ANSWERS[ask.ask] as StudioInspectAskAnswer)
					: { state: "not connected", words },
			CONTEXT,
		);
		const rendered = renderStudioPreviewHtml({ snapshot, tabId: "now", theme: "light" });
		expect(rendered.asks).toEqual([
			{ block: "facts: Orders today", ask: "qorpera/orders-now", state: "not connected", words },
			{ block: "facts: Sales today", ask: "qorpera/orders-now", state: "not connected", words },
			{ block: "facts: To pack", ask: "qorpera/orders-now", state: "not connected", words },
			{
				block: "facts: In the bank",
				ask: "qorpera/money-balance",
				state: "refused",
				words: "No question qorpera/money-balance that you may read",
			},
			{ block: "Are more people buying?", ask: "qorpera/orders-days", state: "not connected", words },
		]);
		expect(rendered.renderedBlocks.find((block) => block.type === "chart")).toMatchObject({ filled: false });
	});

	it("says a question nobody could ask is unavailable, and asks nothing on a tab without asks", async () => {
		const snapshot = await askStudioPreview(SNAPSHOT, "sales", undefined, CONTEXT);
		const rendered = renderStudioPreviewHtml({ snapshot, tabId: "sales", theme: "dark" });
		expect(new Set(rendered.asks.map((one) => one.state))).toEqual(new Set(["unavailable"]));
		expect(rendered.asks[0]).toMatchObject({ words: "No company data here to ask" });
		expect(studioPreviewAsks(SNAPSHOT, "questions")).toEqual([]);
		expect(await askStudioPreview(SNAPSHOT, "questions", undefined, CONTEXT)).toBe(SNAPSHOT);
	});

	it("asks through data_query, telling a question the member may not read and one not connected from one not there to ask", async () => {
		const query: CloudNativeTool = {
			name: "data_query",
			source: "runtime",
			description: "",
			inputSchema: { type: "object" },
			parseArguments: (value) => value,
			async execute(value) {
				const args = value as { database: string; question: string; params?: JsonValue };
				if (args.question === "money-now")
					throw new CloudToolRefusal("No question qorpera/money-now that you may read");
				if (args.question === "site-days") throw new CloudToolRefusal("qorpera/site-days is not counted yet");
				if (args.question === "orders-now")
					throw new CloudToolRefusal(
						"Not connected: orders count once card payments are connected or an order is added by hand",
					);
				return {
					kind: "text",
					value: JSON.stringify({ columns: ["n"], rows: [[args.params ? 2 : 1]], more: false, asOf: "x" }),
				};
			},
		};
		const ask = studioInspectAsker([query]);
		expect(await ask({ ask: "shop/count", params: { from: "2026-11-01" } }, CONTEXT)).toEqual({
			state: "answered",
			columns: ["n"],
			rows: [[2]],
		});
		expect(await ask({ ask: "qorpera/money-now" }, CONTEXT)).toEqual({
			state: "refused",
			words: "No question qorpera/money-now that you may read",
		});
		expect(await ask({ ask: "qorpera/site-days" }, CONTEXT)).toEqual({
			state: "unavailable",
			words: "qorpera/site-days is not counted yet",
		});
		expect(await ask({ ask: "qorpera/orders-now" }, CONTEXT)).toEqual({
			state: "not connected",
			words: "Not connected: orders count once card payments are connected or an order is added by hand",
		});
		expect(await studioInspectAsker([])({ ask: "qorpera/money-now" }, CONTEXT)).toMatchObject({
			state: "unavailable",
		});
	});
});
