import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import {
	createDelegateToStaffTool,
	createDelegateToStaffToolDefinition,
	DELEGATE_TO_STAFF_TOOL_NAME,
} from "../../src/core/tools/delegate-to-staff.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";

const TARGET = "11111111-1111-4111-8111-111111111111";

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
			message: "Delegation queued for Research in this room. Continue your own response without impersonating them.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("delegate_to_staff tool", () => {
	it("is registered as a bounded no-authority room delegation", () => {
		expect(allToolNames.has(DELEGATE_TO_STAFF_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(DELEGATE_TO_STAFF_TOOL_NAME, process.cwd()).name).toBe(DELEGATE_TO_STAFF_TOOL_NAME);
		const definition = createDelegateToStaffToolDefinition();
		expect(definition.description).toContain("current group chat");
		expect(definition.description).toContain("never grants authority");
	});

	it("submits the delegation through the host operation broker", async () => {
		const result = await createDelegateToStaffTool().execute("del-1", {
			staffAgentId: TARGET,
			message: "Draft the launch checklist.",
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Delegation queued for Research in this room. Continue your own response without impersonating them.",
			},
		]);
		expect(lastFrame).toMatchObject({
			type: "qorpera_company_operation_request",
			kind: "delegate_to_staff",
			input: { staffAgentId: TARGET, message: "Draft the launch checklist." },
		});
	});

	it("rejects malformed identities and padded messages before they reach the host", async () => {
		await expect(
			createDelegateToStaffTool().execute("del-2", { staffAgentId: "manager", message: "Draft it." } as never),
		).rejects.toThrow("room participant");
		await expect(
			createDelegateToStaffTool().execute("del-3", { staffAgentId: TARGET, message: " padded " } as never),
		).rejects.toThrow("bounded message");
		expect(lastFrame).toBeUndefined();
	});
});
