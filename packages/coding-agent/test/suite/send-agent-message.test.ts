import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";
import {
	createSendAgentMessageTool,
	createSendAgentMessageToolDefinition,
	SEND_AGENT_MESSAGE_TOOL_NAME,
} from "../../src/core/tools/send-agent-message.ts";

const RECIPIENT = "22222222-2222-4222-8222-222222222222";

let lastFrame: Record<string, unknown> | undefined;

beforeEach(() => {
	lastFrame = undefined;
	setCompanyOperationBrokerWriter((frame) => {
		lastFrame = frame as Record<string, unknown>;
		const requestId = (frame as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			message: "Message msg-1 was queued for Research. They will read it in their own next session.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("send_agent_message tool", () => {
	it("is registered as an addressed durable peer message", () => {
		expect(allToolNames.has(SEND_AGENT_MESSAGE_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(SEND_AGENT_MESSAGE_TOOL_NAME, process.cwd()).name).toBe(SEND_AGENT_MESSAGE_TOOL_NAME);
		const definition = createSendAgentMessageToolDefinition();
		expect(definition.description).toContain("durable message to another staff agent");
		expect(definition.description).toContain("nothing is shared live");
	});

	it("submits the addressed message through the host operation broker", async () => {
		const result = await createSendAgentMessageTool().execute("msg-1", {
			toAgentId: RECIPIENT,
			subject: "Handoff",
			message: "The supplier report is ready under files/reports/.",
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Message msg-1 was queued for Research. They will read it in their own next session.",
			},
		]);
		expect(lastFrame).toMatchObject({
			type: "qorpera_company_operation_request",
			kind: "send_agent_message",
			input: {
				toAgentId: RECIPIENT,
				subject: "Handoff",
				message: "The supplier report is ready under files/reports/.",
			},
		});
	});

	it("rejects malformed input before it reaches the host", async () => {
		await expect(
			createSendAgentMessageTool().execute("msg-2", { toAgentId: RECIPIENT, message: "  " } as never),
		).rejects.toThrow("send_agent_message input is invalid");
		await expect(
			createSendAgentMessageTool().execute("msg-3", {
				toAgentId: RECIPIENT,
				message: "Hello",
				cc: "everyone",
			} as never),
		).rejects.toThrow("send_agent_message input is invalid");
		expect(lastFrame).toBeUndefined();
	});
});
