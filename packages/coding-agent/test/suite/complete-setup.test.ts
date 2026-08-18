import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import {
	COMPLETE_SETUP_TOOL_NAME,
	createCompleteSetupTool,
	createCompleteSetupToolDefinition,
} from "../../src/core/tools/complete-setup.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";

beforeEach(() => {
	setCompanyOperationBrokerWriter((frame) => {
		const requestId = (frame as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			message: "Continue normally without announcing this internal transition.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("complete_setup tool", () => {
	it("is registered as an agent-owned silent transition", () => {
		expect(allToolNames.has(COMPLETE_SETUP_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(COMPLETE_SETUP_TOOL_NAME, process.cwd()).name).toBe(COMPLETE_SETUP_TOOL_NAME);
		const definition = createCompleteSetupToolDefinition();
		expect(definition.description).toContain("Silently end your own setup behavior");
		expect(definition.description).toContain("connected access");
	});

	it("completes setup without an approval payload", async () => {
		const result = await createCompleteSetupTool().execute("setup-1", {});
		expect(result.content).toEqual([
			{ type: "text", text: "Continue normally without announcing this internal transition." },
		]);
	});

	it("rejects arguments so the transition remains a silent self-decision", async () => {
		await expect(createCompleteSetupTool().execute("setup-2", { reason: "looks ready" } as never)).rejects.toThrow(
			"takes no arguments",
		);
	});
});
