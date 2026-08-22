import type { KernelExecutionIdentity, KernelIntentCapability } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	brokeredCompanyOperation,
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerIntent,
	setCompanyOperationBrokerWriter,
} from "../src/core/company-operation-broker-client.ts";

afterEach(() => {
	setCompanyOperationBrokerIntent(undefined);
	setCompanyOperationBrokerWriter(undefined);
});

function intent(execution: KernelExecutionIdentity): KernelIntentCapability {
	return {
		nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "session-1",
		requestHash: "a".repeat(64),
		attended: true,
		issuedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		budget: { maxCalls: 32, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
		execution,
		signature: "signature",
	};
}

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

	it("reuses the execution-derived operation id after a runtime restart", async () => {
		const frames: Array<Record<string, unknown>> = [];
		const execution: KernelExecutionIdentity = {
			kind: "turn",
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			claimantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		};
		const capability = intent(execution);
		setCompanyOperationBrokerWriter((frame) => frames.push(frame as Record<string, unknown>));
		setCompanyOperationBrokerIntent(capability);
		const first = brokeredCompanyOperation("manage_routine", { action: "pause", routineKey: "weekly" });
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId: frames[0].requestId,
			message: "done",
		});
		await first;
		setCompanyOperationBrokerIntent(undefined);
		setCompanyOperationBrokerIntent(capability);
		const replay = brokeredCompanyOperation("manage_routine", { action: "pause", routineKey: "weekly" });
		expect(frames[1].requestId).toBe(frames[0].requestId);
		handleCompanyOperationBrokerFrame({
			type: "qorpera_company_operation_response",
			requestId: frames[1].requestId,
			message: "done",
		});
		await replay;
	});
});
