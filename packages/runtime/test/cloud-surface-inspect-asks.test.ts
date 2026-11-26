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

	it("says a question nobody could ask is unavailable, and asks nothing on a tab without asks", async () => {
		const snapshot = await askStudioPreview(SNAPSHOT, "sales", undefined, CONTEXT);
		const rendered = renderStudioPreviewHtml({ snapshot, tabId: "sales", theme: "dark" });
		expect(new Set(rendered.asks.map((one) => one.state))).toEqual(new Set(["unavailable"]));
		expect(rendered.asks[0]).toMatchObject({ words: "No company data here to ask" });
		expect(studioPreviewAsks(SNAPSHOT, "questions")).toEqual([]);
		expect(await askStudioPreview(SNAPSHOT, "questions", undefined, CONTEXT)).toBe(SNAPSHOT);
	});

	it("asks through data_query, telling a question the member may not read from one that is not there to ask", async () => {
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
		expect(await studioInspectAsker([])({ ask: "qorpera/money-now" }, CONTEXT)).toMatchObject({
			state: "unavailable",
		});
	});
});
