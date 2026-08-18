/** Report a stale or blocked source for one owned artifact. The desktop host
 * applies the transition without discarding the last valid measurement. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME = "report_artifact_source_issue";

const reportArtifactSourceIssueSchema = Type.Object(
	{
		artifactId: Type.String({ minLength: 1, maxLength: 256 }),
		dataNeedId: Type.String({ minLength: 1, maxLength: 128 }),
		sourceRef: Type.String({ minLength: 1, maxLength: 1000 }),
		occurredAt: Type.String({ minLength: 1, maxLength: 64 }),
		status: Type.Union([Type.Literal("stale"), Type.Literal("blocked")]),
		reason: Type.String({ minLength: 1, maxLength: 1000 }),
		metricIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64 }),
	},
	{ additionalProperties: false },
);

export type ReportArtifactSourceIssueToolInput = Static<typeof reportArtifactSourceIssueSchema>;

const ITEM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validText(value: unknown, max: number): value is string {
	return typeof value === "string" && Boolean(value.trim()) && value === value.trim() && value.length <= max;
}

function assertReportArtifactSourceIssueInput(input: unknown): asserts input is ReportArtifactSourceIssueToolInput {
	const value = recordValue(input);
	if (
		!value ||
		Object.keys(value).some(
			(key) =>
				!["artifactId", "dataNeedId", "sourceRef", "occurredAt", "status", "reason", "metricIds"].includes(key),
		) ||
		!validText(value.artifactId, 256) ||
		!validText(value.dataNeedId, 128) ||
		!ITEM_ID_PATTERN.test(value.dataNeedId) ||
		!validText(value.sourceRef, 1000) ||
		!validText(value.occurredAt, 64) ||
		Number.isNaN(Date.parse(value.occurredAt)) ||
		(value.status !== "stale" && value.status !== "blocked") ||
		!validText(value.reason, 1000) ||
		!Array.isArray(value.metricIds) ||
		value.metricIds.length === 0 ||
		value.metricIds.length > 64 ||
		!value.metricIds.every((id) => validText(id, 128) && ITEM_ID_PATTERN.test(id)) ||
		new Set(value.metricIds).size !== value.metricIds.length
	) {
		throw new Error("report_artifact_source_issue input is invalid");
	}
}

export function createReportArtifactSourceIssueToolDefinition(): ToolDefinition<
	typeof reportArtifactSourceIssueSchema,
	undefined
> {
	return {
		name: REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME,
		label: "report artifact source issue",
		description:
			"Mark owned artifact measures stale when their last valid observation is too old, or blocked when a real source read fails. Use the exact source operation or company-file reference you attempted, a concrete bounded reason, and only affected metric ids. This preserves the last valid values and provenance. Use record_artifact_observation after the source works again.",
		promptSnippet: "Report stale or blocked evidence sources without erasing the last valid measures",
		parameters: reportArtifactSourceIssueSchema,
		async execute(_toolCallId, input: ReportArtifactSourceIssueToolInput) {
			assertReportArtifactSourceIssueInput(input);
			const result = await brokeredCompanyOperation("report_artifact_source_issue", input);
			return {
				content: [{ type: "text", text: result.message }],
				details: undefined,
			};
		},
	};
}

export function createReportArtifactSourceIssueTool(): AgentTool<typeof reportArtifactSourceIssueSchema> {
	return wrapToolDefinition(createReportArtifactSourceIssueToolDefinition());
}
