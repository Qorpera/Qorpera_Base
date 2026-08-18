import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";
import {
	createManageRoutineTool,
	createManageRoutineToolDefinition,
	MANAGE_ROUTINE_TOOL_NAME,
} from "../../src/core/tools/manage-routine.ts";

let lastOperationFrame: object | undefined;

beforeEach(() => {
	setCompanyOperationBrokerWriter((frame) => {
		lastOperationFrame = frame;
		const requestId = (frame as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			message: "Recurring work was saved.",
		});
	});
});

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("manage_routine tool", () => {
	it("is registered with explicit-consent and idempotency guidance", () => {
		expect(allToolNames.has(MANAGE_ROUTINE_TOOL_NAME)).toBe(true);
		expect(createToolDefinition(MANAGE_ROUTINE_TOOL_NAME, process.cwd()).name).toBe(MANAGE_ROUTINE_TOOL_NAME);
		const definition = createManageRoutineToolDefinition();
		expect(definition.description).toContain("explicitly agrees");
		expect(definition.description).toContain("reuse the same routineKey");
		expect(definition.description).toContain("startAt");
	});

	it("accepts an agreed interval routine and defaults effort outside the tool", async () => {
		const result = await createManageRoutineTool().execute("routine-1", {
			action: "upsert",
			routineKey: "weekly-financial-review",
			title: "Weekly financial review",
			instructions: "Refresh the financial-health artifact and report material changes.",
			intervalMinutes: 7 * 24 * 60,
			startAt: "2026-08-24T07:00:00.000Z",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Recurring work was saved." });
	});

	it("submits a plain-English event for hidden trigger construction", async () => {
		const result = await createManageRoutineTool().execute("routine-event", {
			action: "upsert_event",
			routineKey: "large-payment",
			title: "Review large payments",
			instructions: "Review the payment and update the cash forecast.",
			eventDescription: "A newly settled Nordea payment exceeds DKK 50,000.",
			sourceHints: ["Nordea Open Banking"],
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Recurring work was saved." });
	});

	it("accepts a weekly wall-clock schedule in the computer timezone", async () => {
		const result = await createManageRoutineTool().execute("routine-weekly", {
			action: "upsert_weekly",
			routineKey: "weekly-engineering-health",
			title: "Weekly engineering health",
			instructions: "Refresh the engineering-health artifact and report material changes.",
			weekdays: ["monday"],
			localTime: "09:00",
			timeZone: "auto",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Recurring work was saved." });
	});

	it("normalizes weekdays when the model transport serializes the array", async () => {
		const result = await createManageRoutineTool().execute("routine-weekly-string", {
			action: "upsert_weekly",
			routineKey: "weekly-engineering-health",
			title: "Weekly engineering health",
			instructions: "Refresh the engineering-health artifact and report material changes.",
			weekdays: '[\n  "monday"\n]',
			localTime: "09:00",
			timeZone: "auto",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "Recurring work was saved." });
		expect(lastOperationFrame).toMatchObject({
			kind: "manage_routine",
			input: { action: "upsert_weekly", weekdays: ["monday"], localTime: "09:00", timeZone: "auto" },
		});
	});

	it("rejects duplicate-prone or underspecified inputs", async () => {
		const tool = createManageRoutineTool();
		await expect(
			tool.execute("routine-2", {
				action: "upsert",
				routineKey: "Weekly Review",
				title: "Weekly review",
				instructions: "Review it.",
				intervalMinutes: 1,
			}),
		).rejects.toThrow("routineKey");
	});
});
