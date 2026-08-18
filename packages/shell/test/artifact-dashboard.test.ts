import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

interface DashboardObservation {
	at: string;
	value: number;
	sourceRef?: string;
	evidence?: readonly string[];
}

interface DashboardDelta {
	value: number;
	previous: number;
	current: number;
	tone: "favorable" | "unfavorable" | "neutral";
}

interface DashboardSummary {
	metricCount: number;
	measuredMetricCount: number;
	staleMetricCount: number;
	blockedMetricCount: number;
	trendMetricCount: number;
	sourceCount: number;
	latestObservedAt?: string;
	unresolvedDataNeedCount: number;
}

interface ArtifactDashboardModel {
	artifactSummary(artifact: unknown): DashboardSummary;
	latestMetricSource(metric: unknown): string | undefined;
	metricDelta(metric: unknown): DashboardDelta | undefined;
	metricObservations(metric: unknown): readonly DashboardObservation[];
}

let dashboard: ArtifactDashboardModel;

beforeAll(() => {
	const directory = dirname(fileURLToPath(import.meta.url));
	const source = readFileSync(join(directory, "../userland/artifact-dashboard.js"), "utf-8");
	const context: Record<string, unknown> = {};
	runInNewContext(source, context);
	dashboard = context.QorperaArtifactDashboard as ArtifactDashboardModel;
});

describe("artifact dashboard model", () => {
	it("projects source-backed financial history without inventing missing measures", () => {
		const artifact = {
			metrics: [
				{
					id: "cash-balance",
					status: "measured",
					value: 18425.5,
					direction: "higher-is-better",
					observedAt: "2026-08-16T12:00:00.000Z",
					evidence: ["connection-request:request-1", "stale-fallback"],
					observations: [
						{
							at: "2026-08-15T12:00:00.000Z",
							value: 17500,
							sourceRef: "connector:google-sheets/sheets.values.read:Operating!B2",
						},
						{
							at: "2026-08-16T12:00:00.000Z",
							value: 18425.5,
							sourceRef: "connector:nordea/accounts.balances.read:account-1",
							evidence: ["bookedBalance"],
						},
					],
				},
				{
					id: "monthly-net-burn",
					status: "stale",
					value: 6200,
					direction: "lower-is-better",
					observedAt: "2026-08-15T12:00:00.000Z",
					observations: [
						{ at: "2026-07-31T12:00:00.000Z", value: 7500 },
						{ at: "2026-08-15T12:00:00.000Z", value: 6200 },
					],
				},
				{
					id: "cash-runway",
					status: "blocked",
					direction: "higher-is-better",
					evidence: [],
				},
			],
			dataNeeds: [
				{
					status: "available",
					sourceRefs: ["connection-request:request-1", "connector:google-sheets/sheets.values.read:Operating!B2"],
				},
				{
					status: "available",
					sourceRefs: ["connector:nordea/accounts.balances.read:account-1"],
				},
				{ status: "missing", sourceRefs: [] },
			],
		};

		expect(dashboard.artifactSummary(artifact)).toEqual({
			metricCount: 3,
			measuredMetricCount: 2,
			staleMetricCount: 1,
			blockedMetricCount: 1,
			trendMetricCount: 2,
			sourceCount: 2,
			latestObservedAt: "2026-08-16T12:00:00.000Z",
			unresolvedDataNeedCount: 1,
		});
		expect(dashboard.latestMetricSource(artifact.metrics[0])).toBe(
			"connector:nordea/accounts.balances.read:account-1",
		);
		expect(dashboard.metricDelta(artifact.metrics[0])).toEqual({
			value: 925.5,
			previous: 17500,
			current: 18425.5,
			tone: "favorable",
		});
		expect(dashboard.metricDelta(artifact.metrics[1])).toEqual({
			value: -1300,
			previous: 7500,
			current: 6200,
			tone: "favorable",
		});
		expect(dashboard.metricObservations(artifact.metrics[2])).toEqual([]);
	});

	it("sorts valid points and keeps point-level provenance", () => {
		const observations = dashboard.metricObservations({
			observations: [
				{ at: "invalid", value: 0 },
				{ at: "2026-08-16T12:00:00.000Z", value: 12, sourceRef: "connector:current" },
				{
					at: "2026-08-15T12:00:00.000Z",
					value: 18,
					sourceRef: "files:historical.csv",
					evidence: ["row:4"],
				},
			],
		});
		expect(observations).toEqual([
			{
				at: "2026-08-15T12:00:00.000Z",
				value: 18,
				sourceRef: "files:historical.csv",
				evidence: ["row:4"],
			},
			{ at: "2026-08-16T12:00:00.000Z", value: 12, sourceRef: "connector:current" },
		]);
	});
});
