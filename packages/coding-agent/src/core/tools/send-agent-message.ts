/** Addressed peer message to another staff agent. The desktop host validates
 * the recipient, stores the message in the protected company ledger, and wakes
 * the recipient to handle it; delivery is durable, never a live connection. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const SEND_AGENT_MESSAGE_TOOL_NAME = "send_agent_message";

const sendAgentMessageSchema = Type.Object(
	{
		toAgentId: Type.String({
			minLength: 36,
			maxLength: 36,
			description: "Staff identity of the receiving coworker, exactly as listed in your coworker roster",
		}),
		subject: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Optional one-line subject" })),
		message: Type.String({
			minLength: 1,
			maxLength: 16_384,
			description:
				"The message body. Include enough context to act on: the coworker does not share your conversation",
		}),
	},
	{ additionalProperties: false },
);

export type SendAgentMessageToolInput = Static<typeof sendAgentMessageSchema>;

function assertSendAgentMessageInput(input: unknown): asserts input is SendAgentMessageToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("send_agent_message input is invalid");
	}
	const record = input as Record<string, unknown>;
	if (
		typeof record.toAgentId !== "string" ||
		typeof record.message !== "string" ||
		!record.message.trim() ||
		(record.subject !== undefined && typeof record.subject !== "string") ||
		Object.keys(record).some((key) => key !== "toAgentId" && key !== "subject" && key !== "message")
	) {
		throw new Error("send_agent_message input is invalid");
	}
}

export function createSendAgentMessageToolDefinition(): ToolDefinition<typeof sendAgentMessageSchema, undefined> {
	return {
		name: SEND_AGENT_MESSAGE_TOOL_NAME,
		label: "message coworker",
		description:
			"Send a durable message to another staff agent in this company, addressed by the staff identity from your coworker roster. Use it to hand off work, ask for information a coworker owns, or report a result they are waiting on. The coworker reads it in their own next session and may reply the same way; nothing is shared live, so include all needed context. Do not use it for founder communication or to delegate work outside the recipient's role.",
		promptSnippet: "Send a durable message to a coworker agent",
		parameters: sendAgentMessageSchema,
		async execute(_toolCallId, input: SendAgentMessageToolInput) {
			assertSendAgentMessageInput(input);
			const result = await brokeredCompanyOperation("send_agent_message", input);
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

export function createSendAgentMessageTool(): AgentTool<typeof sendAgentMessageSchema> {
	return wrapToolDefinition(createSendAgentMessageToolDefinition());
}
