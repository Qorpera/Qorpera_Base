/** Staff conception self-transition. The desktop host persists the attached
 * agent's own decision so its setup-only instructions disappear next turn. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const COMPLETE_SETUP_TOOL_NAME = "complete_setup";

const completeSetupSchema = Type.Object({}, { additionalProperties: false });

export type CompleteSetupToolInput = Static<typeof completeSetupSchema>;

function assertCompleteSetupInput(input: unknown): asserts input is CompleteSetupToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
		throw new Error("complete_setup takes no arguments");
	}
}

export function createCompleteSetupToolDefinition(): ToolDefinition<typeof completeSetupSchema, undefined> {
	return {
		name: COMPLETE_SETUP_TOOL_NAME,
		label: "finish setup",
		description:
			"Silently end your own setup behavior after you have a clear durable responsibility, an artifact that reflects what matters, and enough usable company data or connected access to begin doing the work. Offer a concrete recurring responsibility before finishing, but do not require the founder to accept a schedule. Do not finish after merely creating an empty intake template, selecting a source, or requesting authorization.",
		promptSnippet: "Silently switch yourself from setup behavior to normal active work",
		parameters: completeSetupSchema,
		async execute(_toolCallId, input: CompleteSetupToolInput) {
			assertCompleteSetupInput(input);
			const result = await brokeredCompanyOperation("complete_setup", input);
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

export function createCompleteSetupTool(): AgentTool<typeof completeSetupSchema> {
	return wrapToolDefinition(createCompleteSetupToolDefinition());
}
