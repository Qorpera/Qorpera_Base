import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";
import {
	createRecordArtifactObservationTool,
	createRecordArtifactObservationToolDefinition,
	RECORD_ARTIFACT_OBSERVATION_TOOL_NAME,
} from "../../src/core/tools/record-artifact-observation.ts";

beforeEach(() => {
	setCompanyOperationBrokerWriter((frame) => {
		const requestId = (frame as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			message: "Artifact evidence was recorded.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("record_artifact_observation tool", () => {
	it("is registered with a real-source acceptance boundary", () => {
		expect(allToolNames.has(RECORD_ARTIFACT_OBSERVATION_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(RECORD_ARTIFACT_OBSERVATION_TOOL_NAME, process.cwd()).name).toBe(
			RECORD_ARTIFACT_OBSERVATION_TOOL_NAME,
		);
		const definition = createRecordArtifactObservationToolDefinition();
		expect(definition.description).toContain("source you actually read");
		expect(definition.description).toContain("Never use connection setup");
	});

	it("accepts timestamped evidence for measured values", async () => {
		const result = await createRecordArtifactObservationTool().execute("artifact-1", {
			artifactId: "staff-financial-officer",
			dataNeedId: "financial-ledger",
			sourceRef: "connector:google-sheets/sheets.values.read@sha256:abc",
			observedAt: "2026-08-16T12:00:00.000Z",
			metrics: [
				{ id: "cash-balance", value: 20000, evidence: ["sheet:ledger#Operating!B2"] },
				{ id: "monthly-net-burn", value: 7500, score: 60 },
			],
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Artifact evidence was recorded." });
	});

	it("rejects invalid timestamps and duplicate metric ids", async () => {
		const tool = createRecordArtifactObservationTool();
		await expect(
			tool.execute("artifact-2", {
				artifactId: "staff-financial-officer",
				dataNeedId: "financial-ledger",
				sourceRef: "connector:google-sheets/sheets.values.read@sha256:abc",
				observedAt: "not-a-time",
				metrics: [{ id: "cash-balance", value: 20000 }],
			}),
		).rejects.toThrow("input is invalid");
		await expect(
			tool.execute("artifact-3", {
				artifactId: "staff-financial-officer",
				dataNeedId: "financial-ledger",
				sourceRef: "connector:google-sheets/sheets.values.read@sha256:abc",
				observedAt: "2026-08-16T12:00:00.000Z",
				metrics: [
					{ id: "cash-balance", value: 20000 },
					{ id: "cash-balance", value: 21000 },
				],
			}),
		).rejects.toThrow("metric is invalid");
	});
});
