/** Submit source-backed metric evidence for one owned artifact. The desktop
 * host applies successful staff calls with the attached agent identity. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const RECORD_ARTIFACT_OBSERVATION_TOOL_NAME = "record_artifact_observation";

const recordArtifactObservationSchema = Type.Object(
	{
		artifactId: Type.String({ minLength: 1, maxLength: 256 }),
		dataNeedId: Type.String({ minLength: 1, maxLength: 128 }),
		sourceRef: Type.String({ minLength: 1, maxLength: 1000 }),
		observedAt: Type.String({ minLength: 1, maxLength: 64 }),
		metrics: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1, maxLength: 128 }),
					value: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Number()]),
					score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
					evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 64 })),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 64 },
		),
	},
	{ additionalProperties: false },
);

export type RecordArtifactObservationToolInput = Static<typeof recordArtifactObservationSchema>;

const ITEM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validText(value: unknown, max: number): value is string {
	return typeof value === "string" && Boolean(value.trim()) && value === value.trim() && value.length <= max;
}

function assertRecordArtifactObservationInput(input: unknown): asserts input is RecordArtifactObservationToolInput {
	const value = recordValue(input);
	if (
		!value ||
		Object.keys(value).some(
			(key) => !["artifactId", "dataNeedId", "sourceRef", "observedAt", "metrics"].includes(key),
		) ||
		!validText(value.artifactId, 256) ||
		!validText(value.dataNeedId, 128) ||
		!ITEM_ID_PATTERN.test(value.dataNeedId) ||
		!validText(value.sourceRef, 1000) ||
		!validText(value.observedAt, 64) ||
		Number.isNaN(Date.parse(value.observedAt)) ||
		!Array.isArray(value.metrics) ||
		value.metrics.length === 0 ||
		value.metrics.length > 64
	) {
		throw new Error("record_artifact_observation input is invalid");
	}
	const ids = new Set<string>();
	for (const metric of value.metrics) {
		const entry = recordValue(metric);
		if (
			!entry ||
			Object.keys(entry).some((key) => !["id", "value", "score", "evidence"].includes(key)) ||
			!validText(entry.id, 128) ||
			!ITEM_ID_PATTERN.test(entry.id) ||
			ids.has(entry.id) ||
			((typeof entry.value !== "number" || !Number.isFinite(entry.value)) && !validText(entry.value, 2000)) ||
			(entry.score !== undefined &&
				(typeof entry.score !== "number" ||
					!Number.isFinite(entry.score) ||
					entry.score < 0 ||
					entry.score > 100)) ||
			(entry.evidence !== undefined &&
				(!Array.isArray(entry.evidence) ||
					entry.evidence.length > 64 ||
					!entry.evidence.every((evidence) => validText(evidence, 1000))))
		) {
			throw new Error("record_artifact_observation metric is invalid");
		}
		ids.add(entry.id);
	}
}

export function createRecordArtifactObservationToolDefinition(): ToolDefinition<
	typeof recordArtifactObservationSchema,
	undefined
> {
	return {
		name: RECORD_ARTIFACT_OBSERVATION_TOOL_NAME,
		label: "record artifact evidence",
		description:
			"Record measured values from a source you actually read into one of your owned artifacts. The exact source and each metric must first have an authoritative source-datatype assessment recorded with assess_artifact_source. sourceRef must identify the real file, connector operation, or service record behind the values. Never use connection setup, authorization state, an empty template, or invented figures as evidence.",
		promptSnippet: "Record validated source-backed measures in an owned artifact",
		parameters: recordArtifactObservationSchema,
		async execute(_toolCallId, input: RecordArtifactObservationToolInput) {
			assertRecordArtifactObservationInput(input);
			const result = await brokeredCompanyOperation("record_artifact_observation", input);
			return {
				content: [
					{
						type: "text",
						text: result.message,
					},
				],
				details: undefined,
			};
		},
	};
}

export function createRecordArtifactObservationTool(): AgentTool<typeof recordArtifactObservationSchema> {
	return wrapToolDefinition(createRecordArtifactObservationToolDefinition());
}
