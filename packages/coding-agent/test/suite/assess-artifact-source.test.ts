import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import {
	ASSESS_ARTIFACT_SOURCE_TOOL_NAME,
	createAssessArtifactSourceTool,
	createAssessArtifactSourceToolDefinition,
} from "../../src/core/tools/assess-artifact-source.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";

beforeEach(() => {
	setCompanyOperationBrokerWriter((frame) => {
		const requestId = (frame as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			message: "Source validity was recorded.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("assess_artifact_source tool", () => {
	it("is registered as a source-datatype authority boundary", () => {
		expect(allToolNames.has(ASSESS_ARTIFACT_SOURCE_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(ASSESS_ARTIFACT_SOURCE_TOOL_NAME, process.cwd()).name).toBe(
			ASSESS_ARTIFACT_SOURCE_TOOL_NAME,
		);
		const definition = createAssessArtifactSourceToolDefinition();
		expect(definition.description).toContain("connector is transport");
		expect(definition.description).toContain("specific datatype");
		expect(definition.description).toContain("does not prove completeness");
		expect(definition.description).toContain("stable sourceRef");
	});

	it("submits a concrete assessment without allowing assessor spoofing", async () => {
		const result = await createAssessArtifactSourceTool().execute("assessment-1", {
			artifactId: "staff-financial-officer",
			dataNeedId: "financial-ledger",
			sourceRef: "connector:google-sheets/sheets.values.read@sha256:abc",
			dataType: "operating cash balance",
			decision: "supporting",
			rationale: "The sheet is a planning model and does not reconcile to a bank statement.",
			metricIds: ["cash-balance", "cash-runway"],
			evidence: ["sheet:forecast#metadata=planning-model"],
			assessedAt: "2026-08-17T12:00:00.000Z",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Source validity was recorded." });
	});

	it("requires evidence and unique metric ids", async () => {
		const tool = createAssessArtifactSourceTool();
		await expect(
			tool.execute("assessment-2", {
				artifactId: "staff-financial-officer",
				dataNeedId: "financial-ledger",
				sourceRef: "sheet:forecast",
				dataType: "operating cash balance",
				decision: "authoritative",
				rationale: "It says cash.",
				metricIds: ["cash-balance"],
				evidence: [],
				assessedAt: "2026-08-17T12:00:00.000Z",
			}),
		).rejects.toThrow("input is invalid");
		await expect(
			tool.execute("assessment-3", {
				artifactId: "staff-financial-officer",
				dataNeedId: "financial-ledger",
				sourceRef: "sheet:forecast",
				dataType: "operating cash balance",
				decision: "authoritative",
				rationale: "The source is inspected.",
				metricIds: ["cash-balance", "cash-balance"],
				evidence: ["sheet:forecast#metadata"],
				assessedAt: "2026-08-17T12:00:00.000Z",
			}),
		).rejects.toThrow("input is invalid");
	});
});
