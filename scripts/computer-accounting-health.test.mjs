import assert from "node:assert/strict";
import test from "node:test";
import { healthOptions, healthReport } from "./computer-accounting-health.mjs";
const config = {
	psqlPath: "/usr/bin/psql",
	serviceFile: "/private/pg-service",
	reportPath: "/private/report.json",
};
const snapshot = {
	schema: "qorpera.computer-accounting-health/v1",
	observedAt: "2026-09-26T12:00:00Z",
	activePermitCount: 0,
	findings: [],
	informational: { fundingShortfallBuckets: 0 },
};
test("restricted health config refuses command, timing and path injection", () => {
	assert.equal(healthOptions(config).graceSeconds, 60);
	for (const patch of [
		{ psqlPath: "psql" },
		{ serviceFile: "/tmp/../secret" },
		{ graceSeconds: 0 },
		{ sampleSeconds: 301 },
		{ guardUnits: ["--help"] },
		{ guardUnits: ["other.service"] },
		{ query: "delete everything" },
	])
		assert.throws(() => healthOptions({ ...config, ...patch }));
	assert.throws(() =>
		healthOptions({
			...config,
			guardUnits: ["qorpera-paid-computer-guard.service"],
		}),
	);
});
test("refund shortfall remains informational while issued-balance invariants are findings", () => {
	assert.equal(
		healthReport(
			{ ...snapshot, informational: { fundingShortfallBuckets: 3 } },
			[],
		).healthy,
		true,
	);
	const report = healthReport(
		{
			...snapshot,
			findings: [
				{
					code: "bucket_conservation_mismatch",
					count: 1,
					ids: ["66700000-0000-4000-8000-000000000001"],
				},
			],
		},
		[],
	);
	assert.equal(report.healthy, false);
	assert.match(report.boundaries.mutation, /Read only/);
});
test("missing or unavailable guard custody never reports active paid execution healthy", () => {
	assert.equal(
		healthReport({ ...snapshot, activePermitCount: 1 }, []).healthy,
		false,
	);
	assert.equal(
		healthReport(snapshot, [
			{ unit: "qorpera-paid-computer-guard.service", state: "unavailable" },
		]).healthy,
		false,
	);
	assert.equal(
		healthReport({ ...snapshot, activePermitCount: 1 }, [
			{ unit: "qorpera-paid-computer-guard.service", state: "running" },
		]).healthy,
		true,
	);
});
test("reports accept only known redacted fields and bounded internal identifiers", () => {
	assert.throws(() => healthReport({ ...snapshot, secret: "do not echo" }, []));
	assert.throws(() =>
		healthReport(
			{ ...snapshot, findings: [{ code: "unknown", count: 1, ids: [] }] },
			[],
		),
	);
	assert.throws(() =>
		healthReport(
			{
				...snapshot,
				findings: [
					{
						code: "permit_expired_open",
						count: 1,
						ids: ["secret@example.test"],
					},
				],
			},
			[],
		),
	);
	assert.throws(() =>
		healthReport(
			{
				...snapshot,
				informational: { fundingShortfallBuckets: 0, credentials: "hidden" },
			},
			[],
		),
	);
});
