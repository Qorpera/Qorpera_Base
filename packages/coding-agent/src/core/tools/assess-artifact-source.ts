/** Record a source-and-datatype-specific authority decision for an owned
 * artifact. The desktop host supplies whether the assessor was the attended
 * agent, a background worker, or a lint process. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const ASSESS_ARTIFACT_SOURCE_TOOL_NAME = "assess_artifact_source";

const assessArtifactSourceSchema = Type.Object(
	{
		artifactId: Type.String({ minLength: 1, maxLength: 256 }),
		dataNeedId: Type.String({ minLength: 1, maxLength: 128 }),
		sourceRef: Type.String({ minLength: 1, maxLength: 1000 }),
		dataType: Type.String({ minLength: 1, maxLength: 160 }),
		decision: Type.Union([Type.Literal("authoritative"), Type.Literal("supporting"), Type.Literal("invalid")]),
		rationale: Type.String({ minLength: 1, maxLength: 1000 }),
		metricIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64 }),
		evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 64 }),
		assessedAt: Type.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export type AssessArtifactSourceToolInput = Static<typeof assessArtifactSourceSchema>;

const ITEM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validText(value: unknown, max: number): value is string {
	return typeof value === "string" && Boolean(value.trim()) && value === value.trim() && value.length <= max;
}

function validTextArray(value: unknown, maxItems: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= maxItems &&
		value.every((entry) => validText(entry, 1000))
	);
}

function assertAssessArtifactSourceInput(input: unknown): asserts input is AssessArtifactSourceToolInput {
	const value = recordValue(input);
	if (
		!value ||
		Object.keys(value).some(
			(key) =>
				![
					"artifactId",
					"dataNeedId",
					"sourceRef",
					"dataType",
					"decision",
					"rationale",
					"metricIds",
					"evidence",
					"assessedAt",
				].includes(key),
		) ||
		!validText(value.artifactId, 256) ||
		!validText(value.dataNeedId, 128) ||
		!ITEM_ID_PATTERN.test(value.dataNeedId) ||
		!validText(value.sourceRef, 1000) ||
		!validText(value.dataType, 160) ||
		(value.decision !== "authoritative" && value.decision !== "supporting" && value.decision !== "invalid") ||
		!validText(value.rationale, 1000) ||
		!validTextArray(value.metricIds, 64) ||
		!value.metricIds.every((id) => id.length <= 128 && ITEM_ID_PATTERN.test(id)) ||
		new Set(value.metricIds).size !== value.metricIds.length ||
		!validTextArray(value.evidence, 64) ||
		!validText(value.assessedAt, 64) ||
		Number.isNaN(Date.parse(value.assessedAt))
	) {
		throw new Error("assess_artifact_source input is invalid");
	}
}

export function createAssessArtifactSourceToolDefinition(): ToolDefinition<
	typeof assessArtifactSourceSchema,
	undefined
> {
	return {
		name: ASSESS_ARTIFACT_SOURCE_TOOL_NAME,
		label: "assess artifact source",
		description:
			"Assess whether one source is authoritative, supporting, or invalid for a specific datatype and set of artifact measures. Inspect the actual source, entity scope, field meaning, time coverage, provenance, and evidence that the company actually uses this dataset as the operating record. A connector is transport, never authority by itself. Access, repository ownership, admin permission, or an empty result does not prove completeness or company usage. Treat the source as supporting when it is plausible but its operational scope or completeness is unverified; absence and zero-count claims require evidence that the inspected dataset is complete for the company process. Use a stable sourceRef for the logical dataset or account and put individual query details in evidence so a reassessment replaces the prior decision instead of duplicating it. Cite the concrete basis in evidence. Call this before record_artifact_observation; only an authoritative decision permits values to become company facts.",
		promptSnippet: "Assess source authority for specific artifact measures before recording values",
		parameters: assessArtifactSourceSchema,
		async execute(_toolCallId, input: AssessArtifactSourceToolInput) {
			assertAssessArtifactSourceInput(input);
			const result = await brokeredCompanyOperation("assess_artifact_source", input);
			return {
				content: [{ type: "text", text: result.message }],
				details: undefined,
			};
		},
	};
}

export function createAssessArtifactSourceTool(): AgentTool<typeof assessArtifactSourceSchema> {
	return wrapToolDefinition(createAssessArtifactSourceToolDefinition());
}
