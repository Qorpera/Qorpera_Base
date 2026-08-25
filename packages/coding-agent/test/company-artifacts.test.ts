import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assessCompanyArtifactSource,
	COMPANY_ARTIFACT_SCHEMA,
	createStarterCompanyArtifact,
	readCompanyArtifacts,
	recordCompanyArtifactObservation,
	reportCompanyArtifactSourceIssue,
	type StarterArtifactDefinition,
	transitionCompanyArtifactConnection,
	updateCompanyArtifact,
} from "../src/core/company-artifacts.ts";

const STAFF_ID = "11111111-1111-4111-8111-111111111111";
const STARTER: StarterArtifactDefinition = {
	title: "Customer health",
	purpose: "Keep customer conversations responsive and resolved.",
	metrics: [
		{
			id: "response-time",
			label: "First response time",
			description: "Time before a customer receives a useful response.",
			direction: "lower-is-better",
		},
	],
	dataNeeds: [
		{
			id: "support-inbox",
			label: "Support inbox",
			purpose: "Read and respond to customer messages.",
			connectorHints: ["gmail", "outlook email"],
		},
	],
};

let root: string;

beforeEach(() => {
	root = join(realpathSync(tmpdir()), `qorpera-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function markAuthoritative(artifactId: string, sourceRef: string, assessedAt = "2026-08-15T00:00:00.000Z"): void {
	assessCompanyArtifactSource(
		root,
		STAFF_ID,
		artifactId,
		{
			dataNeedId: "support-inbox",
			sourceRef,
			dataType: "customer support response time",
			decision: "authoritative",
			rationale: "The inspected records are the complete support inbox event log for the company account.",
			metricIds: ["response-time"],
			evidence: [`${sourceRef}#scope=company-support-inbox`],
			assessedAt,
		},
		"agent",
		new Date(assessedAt),
	);
}

describe("company artifacts", () => {
	it("materializes an adaptable starter artifact without overwriting later work", () => {
		const first = createStarterCompanyArtifact(
			root,
			STAFF_ID,
			"costumer-relationist",
			STARTER,
			new Date("2026-08-16T08:00:00.000Z"),
		);
		expect(first).toMatchObject({
			schema: COMPANY_ARTIFACT_SCHEMA,
			title: "Customer health",
			stewardAgentId: STAFF_ID,
			status: "waiting-for-data",
			relativePath: `agents/${STAFF_ID}/artifacts/starter-costumer-relationist.json`,
			metrics: [{ id: "response-time", status: "unknown", evidence: [] }],
			dataNeeds: [{ id: "support-inbox", status: "missing", sourceRefs: [], sourceAssessments: [] }],
		});

		const path = join(root, first.relativePath);
		const edited = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		edited.title = "Customer trust";
		edited.updatedAt = "2026-08-16T09:00:00.000Z";
		writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`, "utf-8");

		const second = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		expect(second.title).toBe("Customer trust");
		expect(readCompanyArtifacts(root)).toEqual([second]);
	});

	it("keeps blank agents blank and skips malformed or misplaced files", () => {
		expect(readCompanyArtifacts(root)).toEqual([]);
		const directory = join(root, "agents", STAFF_ID, "artifacts");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "broken.json"), "{not json", "utf-8");
		writeFileSync(
			join(directory, "wrong-steward.json"),
			JSON.stringify({
				schema: COMPANY_ARTIFACT_SCHEMA,
				id: "wrong",
				title: "Wrong",
				purpose: "Should not project from another steward's directory.",
				stewardAgentId: "22222222-2222-4222-8222-222222222222",
				status: "setting-up",
				metrics: [],
				dataNeeds: [],
				createdAt: "2026-08-16T08:00:00.000Z",
				updatedAt: "2026-08-16T08:00:00.000Z",
			}),
			"utf-8",
		);
		expect(readCompanyArtifacts(root)).toEqual([]);
	});

	it("lets founders change definitions without overwriting observations and links connector state", () => {
		const created = createStarterCompanyArtifact(
			root,
			STAFF_ID,
			"costumer-relationist",
			STARTER,
			new Date("2026-08-16T08:00:00.000Z"),
		);
		const path = join(root, created.relativePath);
		const observed = JSON.parse(readFileSync(path, "utf-8")) as {
			metrics: Array<Record<string, unknown>>;
			updatedAt: string;
		};
		observed.metrics[0] = {
			...observed.metrics[0],
			status: "measured",
			value: 12,
			evidence: ["support/messages.csv#row=12"],
			observedAt: "2026-08-16T08:30:00.000Z",
			observations: [
				{ at: "2026-08-15T08:30:00.000Z", value: 18 },
				{ at: "2026-08-16T08:30:00.000Z", value: 12 },
			],
		};
		observed.updatedAt = "2026-08-16T08:30:00.000Z";
		writeFileSync(path, `${JSON.stringify(observed, null, 2)}\n`, "utf-8");

		const updated = updateCompanyArtifact(root, created.id, {
			expectedUpdatedAt: observed.updatedAt,
			title: "Customer trust",
			accountableDepartmentId: "customer-success",
			metrics: [
				{
					id: "response-time",
					label: "Useful response time",
					description: "Time until a customer receives a useful response.",
					direction: "lower-is-better",
					target: "under 30 minutes",
				},
			],
		});
		expect(updated).toMatchObject({
			title: "Customer trust",
			accountableDepartmentId: "customer-success",
			metrics: [
				{
					label: "Useful response time",
					target: "under 30 minutes",
					status: "measured",
					value: 12,
					evidence: ["support/messages.csv#row=12"],
					observations: [
						{ at: "2026-08-15T08:30:00.000Z", value: 18 },
						{ at: "2026-08-16T08:30:00.000Z", value: 12 },
					],
				},
			],
		});
		expect(() =>
			updateCompanyArtifact(root, created.id, {
				expectedUpdatedAt: observed.updatedAt,
				title: "Stale edit",
			}),
		).toThrow("changed while it was being edited");

		const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const suggested = transitionCompanyArtifactConnection(
			root,
			STAFF_ID,
			created.id,
			"support-inbox",
			requestId,
			"suggested",
		);
		expect(suggested.dataNeeds[0]).toMatchObject({ status: "missing", connectionRequestId: requestId });
		const selected = transitionCompanyArtifactConnection(
			root,
			STAFF_ID,
			created.id,
			"support-inbox",
			requestId,
			"selected",
		);
		expect(selected.dataNeeds[0]).toMatchObject({ status: "selected", connectionRequestId: requestId });
		const connected = transitionCompanyArtifactConnection(
			root,
			STAFF_ID,
			created.id,
			"support-inbox",
			requestId,
			"connected",
		);
		expect(connected).toMatchObject({
			status: "validating",
			dataNeeds: [
				{
					status: "connected",
					connectionRequestId: requestId,
					sourceRefs: [`connection-request:${requestId}`],
				},
			],
		});
	});

	it("marks data available only after source authority is assessed and evidence is recorded", () => {
		const created = createStarterCompanyArtifact(
			root,
			STAFF_ID,
			"costumer-relationist",
			STARTER,
			new Date("2026-08-16T08:00:00.000Z"),
		);

		expect(() =>
			recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
				dataNeedId: "support-inbox",
				sourceRef: "connector:gmail/messages.list@sha256:abc",
				observedAt: "2026-08-16T08:30:00.000Z",
				metrics: [{ id: "response-time", value: 18 }],
			}),
		).toThrow("no authority assessment");
		markAuthoritative(created.id, "connector:gmail/messages.list@sha256:abc");

		const first = recordCompanyArtifactObservation(
			root,
			STAFF_ID,
			created.id,
			{
				dataNeedId: "support-inbox",
				sourceRef: "connector:gmail/messages.list@sha256:abc",
				observedAt: "2026-08-16T08:30:00.000Z",
				metrics: [
					{
						id: "response-time",
						value: 18,
						score: 70,
						evidence: ["gmail:thread/123"],
					},
				],
			},
			new Date("2026-08-16T08:31:00.000Z"),
		);

		expect(first).toMatchObject({
			status: "operating",
			score: 70,
			metrics: [
				{
					id: "response-time",
					status: "measured",
					value: 18,
					score: 70,
					observedAt: "2026-08-16T08:30:00.000Z",
					evidence: ["connector:gmail/messages.list@sha256:abc", "gmail:thread/123"],
					observations: [
						{
							at: "2026-08-16T08:30:00.000Z",
							value: 18,
							sourceRef: "connector:gmail/messages.list@sha256:abc",
							evidence: ["gmail:thread/123"],
						},
					],
				},
			],
			dataNeeds: [
				{
					id: "support-inbox",
					status: "available",
					sourceRefs: ["connector:gmail/messages.list@sha256:abc"],
				},
			],
		});

		const corrected = recordCompanyArtifactObservation(
			root,
			STAFF_ID,
			created.id,
			{
				dataNeedId: "support-inbox",
				sourceRef: "connector:gmail/messages.list@sha256:abc",
				observedAt: "2026-08-16T08:30:00.000Z",
				metrics: [{ id: "response-time", value: 12 }],
			},
			new Date("2026-08-16T08:32:00.000Z"),
		);
		expect(corrected.metrics[0]?.observations).toEqual([
			{
				at: "2026-08-16T08:30:00.000Z",
				value: 12,
				sourceRef: "connector:gmail/messages.list@sha256:abc",
			},
		]);
		expect(corrected.dataNeeds[0]?.sourceRefs).toEqual(["connector:gmail/messages.list@sha256:abc"]);
	});

	it("keeps each numeric point auditable and does not let a backfill replace the current value", () => {
		const created = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		markAuthoritative(created.id, "connector:gmail/messages.list@sha256:current");
		recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
			dataNeedId: "support-inbox",
			sourceRef: "connector:gmail/messages.list@sha256:current",
			observedAt: "2026-08-16T09:00:00.000Z",
			metrics: [
				{
					id: "response-time",
					value: 12,
					score: 80,
					evidence: ["gmail:thread/current"],
				},
			],
		});

		markAuthoritative(created.id, "files/support-export-2026-08-15.csv");
		const backfilled = recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
			dataNeedId: "support-inbox",
			sourceRef: "files/support-export-2026-08-15.csv",
			observedAt: "2026-08-15T09:00:00.000Z",
			metrics: [
				{
					id: "response-time",
					value: 24,
					score: 40,
					evidence: ["files/support-export-2026-08-15.csv#row=8"],
				},
			],
		});

		expect(backfilled.metrics[0]).toMatchObject({
			value: 12,
			score: 80,
			observedAt: "2026-08-16T09:00:00.000Z",
			observations: [
				{
					at: "2026-08-15T09:00:00.000Z",
					value: 24,
					sourceRef: "files/support-export-2026-08-15.csv",
					evidence: ["files/support-export-2026-08-15.csv#row=8"],
				},
				{
					at: "2026-08-16T09:00:00.000Z",
					value: 12,
					sourceRef: "connector:gmail/messages.list@sha256:current",
					evidence: ["gmail:thread/current"],
				},
			],
		});
	});

	it("preserves the last valid evidence through stale and blocked source health, then clears it on recovery", () => {
		const created = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		markAuthoritative(created.id, "connector:gmail/messages.list@sha256:current");
		recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
			dataNeedId: "support-inbox",
			sourceRef: "connector:gmail/messages.list@sha256:current",
			observedAt: "2026-08-16T09:00:00.000Z",
			metrics: [{ id: "response-time", value: 12, score: 80, evidence: ["gmail:thread/current"] }],
		});

		const stale = reportCompanyArtifactSourceIssue(
			root,
			STAFF_ID,
			created.id,
			{
				dataNeedId: "support-inbox",
				sourceRef: "connector:gmail/messages.list@sha256:stale-check",
				occurredAt: "2026-08-17T09:00:00.000Z",
				status: "stale",
				reason: "The inbox has not refreshed within its expected daily window.",
				metricIds: ["response-time"],
			},
			new Date("2026-08-17T09:01:00.000Z"),
		);
		expect(stale).toMatchObject({
			status: "partial",
			metrics: [
				{
					id: "response-time",
					status: "stale",
					statusReason: "The inbox has not refreshed within its expected daily window.",
					statusChangedAt: "2026-08-17T09:00:00.000Z",
					value: 12,
					observedAt: "2026-08-16T09:00:00.000Z",
					evidence: [
						"connector:gmail/messages.list@sha256:current",
						"gmail:thread/current",
						"connector:gmail/messages.list@sha256:stale-check",
					],
				},
			],
			dataNeeds: [{ id: "support-inbox", status: "connected" }],
		});
		expect(stale).not.toHaveProperty("score");

		const blocked = reportCompanyArtifactSourceIssue(root, STAFF_ID, created.id, {
			dataNeedId: "support-inbox",
			sourceRef: "connector:gmail/messages.list@sha256:failed-read",
			occurredAt: "2026-08-17T09:05:00.000Z",
			status: "blocked",
			reason: "The provider revoked the grant.",
			metricIds: ["response-time"],
		});
		expect(blocked.metrics[0]).toMatchObject({
			status: "blocked",
			statusReason: "The provider revoked the grant.",
			value: 12,
			observations: [{ at: "2026-08-16T09:00:00.000Z", value: 12 }],
		});

		markAuthoritative(created.id, "connector:gmail/messages.list@sha256:recovered", "2026-08-17T09:09:00.000Z");
		const recovered = recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
			dataNeedId: "support-inbox",
			sourceRef: "connector:gmail/messages.list@sha256:recovered",
			observedAt: "2026-08-17T09:10:00.000Z",
			metrics: [{ id: "response-time", value: 10, score: 90 }],
		});
		expect(recovered).toMatchObject({
			status: "operating",
			score: 90,
			metrics: [{ status: "measured", value: 10, observedAt: "2026-08-17T09:10:00.000Z" }],
			dataNeeds: [{ status: "available" }],
		});
		expect(recovered.metrics[0]).not.toHaveProperty("statusReason");
		expect(recovered.metrics[0]).not.toHaveProperty("statusChangedAt");
	});

	it("stores assessor provenance and retracts values when a source is invalid for their datatype", () => {
		const created = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		const sourceRef = "files/synthetic-support-fixture.csv";
		markAuthoritative(created.id, sourceRef);
		recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
			dataNeedId: "support-inbox",
			sourceRef,
			observedAt: "2026-08-16T09:00:00.000Z",
			metrics: [{ id: "response-time", value: 12, score: 80 }],
		});

		const invalidated = assessCompanyArtifactSource(
			root,
			STAFF_ID,
			created.id,
			{
				dataNeedId: "support-inbox",
				sourceRef,
				dataType: "customer support response time",
				decision: "invalid",
				rationale: "The file is a synthetic transport fixture, not a company support record.",
				metricIds: ["response-time"],
				evidence: [`${sourceRef}#fixture-metadata`],
				assessedAt: "2026-08-16T09:05:00.000Z",
			},
			"lint",
			new Date("2026-08-16T09:06:00.000Z"),
		);

		expect(invalidated).toMatchObject({
			status: "validating",
			metrics: [
				{
					id: "response-time",
					status: "blocked",
					statusReason: "The file is a synthetic transport fixture, not a company support record.",
					evidence: [],
				},
			],
			dataNeeds: [
				{
					status: "connected",
					sourceAssessments: [{ decision: "invalid", assessedBy: "lint" }],
				},
			],
		});
		expect(invalidated).not.toHaveProperty("score");
		expect(invalidated.metrics[0]).not.toHaveProperty("value");
		expect(invalidated.metrics[0]).not.toHaveProperty("observedAt");
		expect(() =>
			recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
				dataNeedId: "support-inbox",
				sourceRef,
				observedAt: "2026-08-16T09:10:00.000Z",
				metrics: [{ id: "response-time", value: 10 }],
			}),
		).toThrow("invalid, not authoritative");
	});

	it("keeps only the current decision for the same source, datatype, and metric", () => {
		const created = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		const sourceRef = "connector:gmail/company-support-inbox";
		markAuthoritative(created.id, sourceRef);
		const reassessed = assessCompanyArtifactSource(
			root,
			STAFF_ID,
			created.id,
			{
				dataNeedId: "support-inbox",
				sourceRef,
				dataType: "customer support response time",
				decision: "supporting",
				rationale: "The mailbox scope is no longer known to include every support channel.",
				metricIds: ["response-time"],
				evidence: [`${sourceRef}#scope-review`],
				assessedAt: "2026-08-16T09:05:00.000Z",
			},
			"worker",
		);

		expect(reassessed.dataNeeds[0]?.sourceAssessments).toEqual([
			expect.objectContaining({
				sourceRef,
				decision: "supporting",
				metricIds: ["response-time"],
				assessedBy: "worker",
			}),
		]);
	});

	it("keeps supporting evidence from becoming a company fact", () => {
		const created = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		const sourceRef = "files/customer-interview-notes.md";
		assessCompanyArtifactSource(
			root,
			STAFF_ID,
			created.id,
			{
				dataNeedId: "support-inbox",
				sourceRef,
				dataType: "customer support response time",
				decision: "supporting",
				rationale: "The notes describe delays but are not the complete timestamped inbox record.",
				metricIds: ["response-time"],
				evidence: [`${sourceRef}#reported-delay`],
				assessedAt: "2026-08-16T09:00:00.000Z",
			},
			"worker",
		);
		expect(() =>
			recordCompanyArtifactObservation(root, STAFF_ID, created.id, {
				dataNeedId: "support-inbox",
				sourceRef,
				observedAt: "2026-08-16T09:05:00.000Z",
				metrics: [{ id: "response-time", value: 20 }],
			}),
		).toThrow("supporting, not authoritative");
	});

	it("refuses observations for another steward or unknown measures", () => {
		const created = createStarterCompanyArtifact(root, STAFF_ID, "costumer-relationist", STARTER);
		const observation = {
			dataNeedId: "support-inbox",
			sourceRef: "connector:gmail/messages.list@sha256:abc",
			observedAt: "2026-08-16T08:30:00.000Z",
			metrics: [{ id: "unknown", value: 12 }],
		};

		expect(() =>
			recordCompanyArtifactObservation(root, "22222222-2222-4222-8222-222222222222", created.id, observation),
		).toThrow("not owned");
		expect(() => recordCompanyArtifactObservation(root, STAFF_ID, created.id, observation)).toThrow(
			"Unknown metric: unknown",
		);
	});
});
