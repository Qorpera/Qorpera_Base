import { describe, expect, it } from "vitest";
import {
	describeSurfaceFormats,
	evaluateEconomicsCurve,
	evaluateEconomicsExpression,
	evaluateEconomicsModel,
	inferSurfaceKind,
	parseEconomicsDocument,
	parseStrategyHypothesesDocument,
	parseStrategyLandscapeDocument,
	parseStrategyPlaysDocument,
	parseStudioTourDocument,
	parseSurfaceLayout,
	resolveTourSay,
	SURFACE_ECONOMICS_FORMAT,
	SURFACE_HYPOTHESES_FORMAT,
	SURFACE_LANDSCAPE_FORMAT,
	SURFACE_PLAYS_FORMAT,
	SURFACE_REPORT_FORMAT,
	starterSurfaceLayout,
	studioTourCaptionTexts,
	surfaceLinkTarget,
	surfaceStarterKind,
} from "../src/index.ts";

describe("strategy starter and surface link parsing", () => {
	it("parses surface: links with optional tab hashes and rejects invalid slugs or tabs", () => {
		expect(surfaceLinkTarget("surface:strategy")).toEqual({ slug: "strategy" });
		expect(surfaceLinkTarget("surface:strategy#economics")).toEqual({ slug: "strategy", tab: "economics" });
		expect(surfaceLinkTarget("SURFACE:Growth-Lab#Unit-Econ")).toEqual({ slug: "growth-lab", tab: "unit-econ" });
		expect(surfaceLinkTarget("app:model")).toBeUndefined();
		expect(surfaceLinkTarget("surface:")).toBeUndefined();
		expect(surfaceLinkTarget("surface:bad/slug")).toBeUndefined();
		expect(surfaceLinkTarget("surface:strategy#")).toBeUndefined();
		expect(surfaceLinkTarget("surface:strategy#bad_tab")).toBeUndefined();
	});

	it("routes strategy studio surfaces to the strategy starter and validates the starter layout", () => {
		expect(inferSurfaceKind({ slug: "strategy", icon: "star", archetype: "studio" })).toBe("strategy");
		expect(inferSurfaceKind({ slug: "war-room", icon: "star", archetype: "studio" })).toBe("strategy");
		expect(inferSurfaceKind({ slug: "notes", icon: "figure:lighthouse", archetype: "studio" })).toBe("strategy");
		expect(
			surfaceStarterKind({ lookKind: "strategy", slug: "growth-plan", isGlobal: false, paths: [], hasModel: false }),
		).toBe("strategy");
		const starter = starterSurfaceLayout("strategy");
		expect(parseSurfaceLayout(starter)).toEqual(starter);
		expect(describeSurfaceFormats(starter)).toEqual([
			SURFACE_PLAYS_FORMAT,
			SURFACE_ECONOMICS_FORMAT,
			SURFACE_HYPOTHESES_FORMAT,
			SURFACE_LANDSCAPE_FORMAT,
			SURFACE_REPORT_FORMAT,
		]);
	});
});

describe("economics expression engine and document parser", () => {
	it("evaluates arithmetic, comparisons, and safe math helpers without eval", () => {
		const scope = { customers: 50, price: 1000, vat: 25, hoursPerCustomer: 1.5, capacity: 70 };
		expect(evaluateEconomicsExpression("customers * price / (1 + vat / 100)", scope)).toBe(40_000);
		expect(evaluateEconomicsExpression("customers * hoursPerCustomer > capacity", scope)).toBe(1);
		expect(evaluateEconomicsExpression("if(customers * hoursPerCustomer > capacity, 1, 0)", scope)).toBe(1);
		expect(evaluateEconomicsExpression("clamp(customers, 10, 40)", scope)).toBe(40);
		expect(evaluateEconomicsExpression("min(price, 500) + max(0, -10)", scope)).toBe(500);
		expect(evaluateEconomicsExpression("price / 0", scope)).toBeNull();
		expect(evaluateEconomicsExpression("unknownVar + 1", scope)).toBeNull();
		expect(evaluateEconomicsExpression("constructor()", scope)).toBeNull();
	});

	it("computes model values, constraints, and break-even plus capacity ceiling on curves", () => {
		const doc = parseEconomicsDocument({
			title: "Dealer Subscription",
			currency: "DKK",
			period: "month",
			inputs: [
				{
					id: "customers",
					label: "Customers",
					value: 50,
					min: 0,
					max: 120,
					tier: "hypothesis",
				},
				{
					id: "price",
					label: "Price ex VAT",
					value: 1000,
					min: 200,
					max: 3000,
					tier: "benchmark",
					source: "Rival pricing scan",
					marks: [{ value: 1495, label: "Rival Pro" }],
				},
				{
					id: "hours_per_customer",
					label: "Hours per customer",
					value: 1.5,
					min: 0.25,
					max: 4,
					tier: "hypothesis",
				},
				{
					id: "hourly_cost",
					label: "Hourly cost",
					value: 400,
					min: 200,
					max: 900,
					tier: "verified",
					source: "Payroll",
				},
				{
					id: "fixed_costs",
					label: "Fixed costs",
					value: 20000,
					min: 5000,
					max: 50000,
					tier: "verified",
				},
				{
					id: "capacity_hours",
					label: "Team capacity",
					value: 90,
					min: 40,
					max: 200,
					tier: "verified",
				},
			],
			computed: [
				{ id: "revenue", expr: "customers * price" },
				{ id: "work_hours", expr: "customers * hours_per_customer" },
				{ id: "labor_cost", expr: "work_hours * hourly_cost" },
				{ id: "contribution", expr: "revenue - labor_cost - fixed_costs" },
			],
			constraints: [
				{
					label: "Capacity ceiling",
					expr: "work_hours > capacity_hours",
					severity: "fatal",
					message: "Team capacity exceeded",
				},
			],
			curve: {
				xInput: "customers",
				yOutput: "contribution",
				xMin: 0,
				xMax: 120,
				steps: 24,
				capacityExpr: "capacity_hours / hours_per_customer",
			},
		});
		expect(doc).not.toBeNull();
		const base = evaluateEconomicsModel(doc!);
		expect(base.values.contribution).toBe(0);
		expect(base.constraints[0]?.triggered).toBe(false);

		const overloaded = evaluateEconomicsModel(doc!, { customers: 70 });
		expect(overloaded.constraints[0]?.triggered).toBe(true);

		const curve = evaluateEconomicsCurve(doc!);
		expect(curve?.breakEvenX).toBeCloseTo(50, 4);
		expect(curve?.capacityX).toBeCloseTo(60, 4);
	});
});

describe("strategy plays, hypotheses, and landscape parsers", () => {
	it("parses competing plays, hypotheses, and competitive landscape documents", () => {
		const plays = parseStrategyPlaysDocument({
			verdict: "Dealer-funded supply beats buyer search fees.",
			plays: [
				{
					id: "dealer-feed",
					name: "Dealer-Funded Pre-Market Feed",
					thesis: "Charge dealers for verified warm buyer demand.",
					status: "recommended",
					unitMargin: "72%",
					killRisk: "Dealers hoard top inventory",
				},
			],
		});
		expect(plays?.plays).toHaveLength(1);
		expect(plays?.plays[0]?.status).toBe("recommended");

		const hypotheses = parseStrategyHypothesesDocument({
			hypotheses: [
				{
					bet: "5 dealers will share incoming stock 7 days early.",
					impact: "fatal",
					status: "testing",
					tier: "hypothesis",
					cheapestTest: "10 cold calls this week",
					killCriteria: "Fewer than 3 sign pilot",
				},
			],
		});
		expect(hypotheses?.hypotheses[0]?.id).toBe("h-1");
		expect(hypotheses?.hypotheses[0]?.impact).toBe("fatal");

		const landscape = parseStrategyLandscapeDocument({
			wedge: "Pre-listing access before public classifieds.",
			axes: { xLabel: "Inventory Exclusivity", yLabel: "Buyer Trust" },
			players: [
				{ name: "Bilbasen", pricing: "995 DKK/mo", weakness: "Public listings only", x: 20, y: 65 },
				{ name: "Brooks", isUs: true, pricing: "1495 DKK/mo", x: 85, y: 90 },
			],
		});
		expect(landscape?.players).toHaveLength(2);
		expect(landscape?.players[1]?.isUs).toBe(true);
		expect(landscape?.axes?.xLabel).toBe("Inventory Exclusivity");
	});

	it("parses bilingual tour.json beats with tab, focus, effect and action", () => {
		const tour = parseStudioTourDocument({
			title: "Walk through Brooks",
			beats: [
				{
					id: "wedge",
					label: "Wedge",
					tab: "plan",
					focus: "play:dealer-fee",
					effect: "spotlight",
					say: { en: "Flip to dealers.", da: "Skift til forhandlere." },
				},
				{
					id: "stress",
					tab: "economics",
					focus: "econ:hero",
					effect: "pulse",
					action: { scenario: "high-load", view: "curve" },
					say: "At two hours per buyer the ceiling snaps.",
				},
			],
		});
		expect(tour?.title).toBe("Walk through Brooks");
		expect(tour?.beats).toHaveLength(2);
		expect(resolveTourSay(tour!.beats[0]!.say, "da")).toBe("Skift til forhandlere.");
		expect(resolveTourSay(tour!.beats[0]!.say, "en")).toBe("Flip to dealers.");
		expect(tour?.beats[1]?.action).toEqual({ scenario: "high-load", view: "curve" });
		expect(studioTourCaptionTexts(tour!)).toEqual([
			"Flip to dealers.",
			"Skift til forhandlere.",
			"At two hours per buyer the ceiling snaps.",
		]);
	});
});
