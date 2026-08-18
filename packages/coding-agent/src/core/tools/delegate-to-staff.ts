/**
 * Room-scoped staff delegation.
 *
 * The tool cannot start another runtime. It submits one bounded delegation
 * through the transactional company-operation lane; the desktop host verifies
 * the source room, target membership, liveness, and the bounded delegation
 * graph before queueing the assignment as a durable room delivery.
 */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const DELEGATE_TO_STAFF_TOOL_NAME = "delegate_to_staff";

const STAFF_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const delegateToStaffSchema = Type.Object(
	{
		staffAgentId: Type.String({
			pattern: STAFF_UUID_PATTERN,
			description: "Exact staff UUID from the current room participant list",
		}),
		message: Type.String({
			minLength: 1,
			maxLength: 4_000,
			description: "Specific assignment or question for that room participant",
		}),
	},
	{ additionalProperties: false },
);

export type DelegateToStaffToolInput = Static<typeof delegateToStaffSchema>;

function assertDelegateInput(input: unknown): asserts input is DelegateToStaffToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("delegate_to_staff requires a room participant and message");
	}
	const record = input as Record<string, unknown>;
	if (
		Object.keys(record).some((key) => key !== "staffAgentId" && key !== "message") ||
		typeof record.staffAgentId !== "string" ||
		!new RegExp(STAFF_UUID_PATTERN).test(record.staffAgentId) ||
		typeof record.message !== "string" ||
		record.message !== record.message.trim() ||
		!record.message ||
		record.message.includes("\0") ||
		Buffer.byteLength(record.message, "utf-8") > 4_000
	) {
		throw new Error("delegate_to_staff requires a room participant and bounded message");
	}
}

export function createDelegateToStaffToolDefinition(): ToolDefinition<typeof delegateToStaffSchema, undefined> {
	return {
		name: DELEGATE_TO_STAFF_TOOL_NAME,
		label: "delegate to staff",
		description:
			"Ask another participant in the current group chat to take one specific assignment or answer one question. Use the exact staffAgentId shown in the room context. The desktop host verifies membership and enforces bounded depth, fanout, and cycle prevention; this tool never grants authority or access. The target works in their own session, so include all needed context and never claim their work as done until their own room reply confirms it.",
		promptSnippet: "Delegate one bounded assignment to another participant in this group chat",
		parameters: delegateToStaffSchema,
		async execute(_toolCallId, input: DelegateToStaffToolInput) {
			assertDelegateInput(input);
			const result = await brokeredCompanyOperation("delegate_to_staff", input);
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

export function createDelegateToStaffTool(): AgentTool<typeof delegateToStaffSchema> {
	return wrapToolDefinition(createDelegateToStaffToolDefinition());
}
