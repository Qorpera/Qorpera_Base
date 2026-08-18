import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";
import {
	createReportArtifactSourceIssueTool,
	createReportArtifactSourceIssueToolDefinition,
	REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME,
} from "../../src/core/tools/report-artifact-source-issue.ts";

beforeEach(() => {
	setCompanyOperationBrokerWriter((frame) => {
		const requestId = (frame as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			message: "Artifact source health was updated.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("report_artifact_source_issue tool", () => {
	it("is registered and preserves the source-health boundary in its guidance", () => {
		expect(allToolNames.has(REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME, process.cwd()).name).toBe(
			REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME,
		);
		const definition = createReportArtifactSourceIssueToolDefinition();
		expect(definition.description).toContain("last valid values");
		expect(definition.description).toContain("source operation");
	});

	it("reports a concrete failed source for selected measures", async () => {
		const result = await createReportArtifactSourceIssueTool().execute("artifact-issue-1", {
			artifactId: "staff-financial-officer",
			dataNeedId: "financial-ledger",
			sourceRef: "connector:google-sheets/sheets.values.read@sha256:failed",
			occurredAt: "2026-08-17T12:00:00.000Z",
			status: "blocked",
			reason: "The provider returned 403 after its grant was revoked.",
			metricIds: ["cash-balance", "monthly-net-burn"],
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Artifact source health was updated." });
	});

	it("rejects duplicate measures and invalid timestamps", async () => {
		const tool = createReportArtifactSourceIssueTool();
		await expect(
			tool.execute("artifact-issue-2", {
				artifactId: "staff-financial-officer",
				dataNeedId: "financial-ledger",
				sourceRef: "connector:google-sheets/sheets.values.read@sha256:failed",
				occurredAt: "not-a-time",
				status: "stale",
				reason: "No successful refresh was available.",
				metricIds: ["cash-balance"],
			}),
		).rejects.toThrow("input is invalid");
		await expect(
			tool.execute("artifact-issue-3", {
				artifactId: "staff-financial-officer",
				dataNeedId: "financial-ledger",
				sourceRef: "connector:google-sheets/sheets.values.read@sha256:failed",
				occurredAt: "2026-08-17T12:00:00.000Z",
				status: "blocked",
				reason: "The same metric was selected twice.",
				metricIds: ["cash-balance", "cash-balance"],
			}),
		).rejects.toThrow("input is invalid");
	});
});
