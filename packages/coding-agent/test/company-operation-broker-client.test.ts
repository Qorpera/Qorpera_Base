import { afterEach, describe, expect, it } from "vitest";
import {
	brokeredCompanyOperation,
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../src/core/company-operation-broker-client.ts";

afterEach(() => setCompanyOperationBrokerWriter(undefined));

describe("company operation broker client", () => {
	it("waits for the host acknowledgement before resolving", async () => {
		const frames: Array<Record<string, unknown>> = [];
		setCompanyOperationBrokerWriter((frame) => frames.push(frame as Record<string, unknown>));
		let settled = false;
		const pending = brokeredCompanyOperation("manage_routine", { action: "pause", routineKey: "weekly" }).then(
			(result) => {
				settled = true;
				return result;
			},
		);
		expect(settled).toBe(false);
		expect(frames[0]).toMatchObject({ type: "qorpera_company_operation_request", kind: "manage_routine" });
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId: frames[0].requestId,
			message: "Recurring work was paused.",
		});
		await expect(pending).resolves.toEqual({ message: "Recurring work was paused." });
	});

	it("turns host persistence failures into tool failures", async () => {
		let requestId = "";
		setCompanyOperationBrokerWriter((frame) => {
			requestId = (frame as { requestId: string }).requestId;
		});
		const pending = brokeredCompanyOperation("complete_setup", {});
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId,
			error: "company checkpoint failed",
		});
		await expect(pending).rejects.toThrow("company checkpoint failed");
	});
});
