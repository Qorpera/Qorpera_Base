/** Host-scoped completion tools exposed only to silent trigger workers. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const FINISH_TRIGGER_BUILD_TOOL_NAME = "finish_trigger_build";
export const FINISH_TRIGGER_CHECK_TOOL_NAME = "finish_trigger_check";

const buildSchema = Type.Union([
	Type.Object(
		{
			buildId: Type.String({ format: "uuid" }),
			status: Type.Literal("ready"),
			monitorInstructions: Type.String({ minLength: 1, maxLength: 32_768 }),
			connectorIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16 }),
			eventLabel: Type.String({ minLength: 1, maxLength: 160 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			buildId: Type.String({ format: "uuid" }),
			status: Type.Literal("failed"),
			error: Type.String({ minLength: 1, maxLength: 2_000 }),
		},
		{ additionalProperties: false },
	),
]);

const checkpoint = Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 }));

const checkSchema = Type.Union([
	Type.Object({ status: Type.Literal("no_match"), checkpoint }, { additionalProperties: false }),
	Type.Object(
		{
			status: Type.Literal("matched"),
			eventId: Type.String({ minLength: 1, maxLength: 200 }),
			summary: Type.String({ minLength: 1, maxLength: 300 }),
			checkpoint,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			status: Type.Literal("failed"),
			error: Type.String({ minLength: 1, maxLength: 2_000 }),
		},
		{ additionalProperties: false },
	),
]);

export type FinishTriggerBuildToolInput = Static<typeof buildSchema>;
export type FinishTriggerCheckToolInput = Static<typeof checkSchema>;

export function createFinishTriggerBuildToolDefinition(): ToolDefinition<typeof buildSchema, undefined> {
	return {
		name: FINISH_TRIGGER_BUILD_TOOL_NAME,
		label: "finish trigger build",
		description:
			"Finish the assigned hidden trigger build exactly once. Report ready only when the monitor can be executed from installed company connectors or company files; otherwise report the concrete blocker as failed.",
		parameters: buildSchema,
		async execute(_toolCallId, input: FinishTriggerBuildToolInput) {
			const result = await brokeredCompanyOperation("finish_trigger_build", input);
			return { content: [{ type: "text", text: result.message }], details: undefined };
		},
	};
}

export function createFinishTriggerCheckToolDefinition(): ToolDefinition<typeof checkSchema, undefined> {
	return {
		name: FINISH_TRIGGER_CHECK_TOOL_NAME,
		label: "finish trigger check",
		description:
			"Finish the assigned hidden event check exactly once. Report matched only for a newly observed event that satisfies the installed trigger instructions. Include a compact checkpoint on successful checks when future checks need cursor or comparison state.",
		parameters: checkSchema,
		async execute(_toolCallId, input: FinishTriggerCheckToolInput) {
			const result = await brokeredCompanyOperation("finish_trigger_check", input);
			return { content: [{ type: "text", text: result.message }], details: undefined };
		},
	};
}

export function createFinishTriggerBuildTool(): AgentTool<typeof buildSchema> {
	return wrapToolDefinition(createFinishTriggerBuildToolDefinition());
}

export function createFinishTriggerCheckTool(): AgentTool<typeof checkSchema> {
	return wrapToolDefinition(createFinishTriggerCheckToolDefinition());
}
