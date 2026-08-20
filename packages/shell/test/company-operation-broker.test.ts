import type { KernelExecutionIdentity, KernelIntentCapability } from "@qorpera/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import { createCompanyOperationBroker } from "../src/company-operation-broker.ts";

function intent(execution?: KernelExecutionIdentity): KernelIntentCapability {
	const issuedAt = Date.now();
	return {
		nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "session-1",
		requestHash: "hash",
		attended: true,
		issuedAt: new Date(issuedAt).toISOString(),
		expiresAt: new Date(issuedAt + 60_000).toISOString(),
		budget: { maxCalls: 100, maxInputTokens: 100, maxOutputTokens: 100, maxCostUsd: 1 },
		...(execution ? { execution } : {}),
		signature: "signature",
	};
}

describe("company operation host broker", () => {
	it("responds only after the host mutation has completed", async () => {
		let finish: ((result: { message: string }) => void) | undefined;
		const applied = new Promise<{ message: string }>((resolve) => {
			finish = resolve;
		});
		const broker = createCompanyOperationBroker({
			sessionId: "session-1",
			execution: () => undefined,
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt: async (_execution, _operationId, result) => result,
			apply: async () => applied,
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);
		const responses: object[] = [];
		expect(
			broker.handleFrame(
				{
					type: "qorpera_company_operation_request",
					requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					kind: "manage_routine",
					input: { action: "pause", routineKey: "weekly" },
					intent: capability,
				},
				(response) => responses.push(response),
			),
		).toBe(true);
		expect(responses).toEqual([]);
		finish?.({ message: "Recurring work was paused." });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(responses).toEqual([
			{
				type: "qorpera_company_operation_response",
				requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				message: "Recurring work was paused.",
			},
		]);
		broker.release();
	});

	it("denies operations without an authorized causal intent", async () => {
		const broker = createCompanyOperationBroker({
			sessionId: "session-1",
			execution: () => undefined,
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt: async (_execution, _operationId, result) => result,
			apply: async () => ({ message: "unreachable" }),
		});
		const responses: Array<Record<string, unknown>> = [];
		broker.handleFrame(
			{
				type: "qorpera_company_operation_request",
				requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				kind: "complete_setup",
				input: {},
				intent: intent(),
			},
			(response) => responses.push(response as Record<string, unknown>),
		);
		expect(responses[0].error).toContain("no verified causal intent");
	});

	it("fails closed when a cloud execution has no durable lease", async () => {
		const apply = vi.fn(async () => ({ message: "unreachable" }));
		const broker = createCompanyOperationBroker({
			sessionId: "session-1",
			requireDurableExecution: true,
			execution: () => undefined,
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt: async (_execution, _operationId, result) => result,
			apply,
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);
		const responses: Array<Record<string, unknown>> = [];
		broker.handleFrame(
			{
				type: "qorpera_company_operation_request",
				requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				kind: "complete_setup",
				input: {},
				intent: capability,
			},
			(response) => responses.push(response as Record<string, unknown>),
		);
		expect(responses[0].error).toContain("no durable lease");
		expect(apply).not.toHaveBeenCalled();
	});

	it("replays completed durable receipts without applying the operation again", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "turn",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		const apply = vi.fn(async () => ({ message: "must not run" }));
		const broker = createCompanyOperationBroker({
			sessionId: "session-1",
			execution: () => execution,
			beginReceipt: async () => ({
				started: false,
				status: "completed",
				result: { message: "Already submitted." },
			}),
			completeReceipt: async (_live, _operationId, result) => result,
			apply,
		});
		const capability = intent(execution);
		expect(broker.authorizeIntent(capability)).toBe(true);
		const responses: Array<Record<string, unknown>> = [];
		broker.handleFrame(
			{
				type: "qorpera_company_operation_request",
				requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				kind: "manage_routine",
				input: { action: "pause", routineKey: "weekly" },
				intent: capability,
			},
			(response) => responses.push(response as Record<string, unknown>),
		);
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(responses[0].message).toBe("Already submitted.");
		expect(apply).not.toHaveBeenCalled();
	});

	it("retries durable acknowledgement without applying the operation twice", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "wake",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		const apply = vi.fn(async () => ({ message: "Submitted." }));
		const completeReceipt = vi
			.fn(async (_live: KernelExecutionIdentity, _operationId: string, result: { message: string }) => result)
			.mockRejectedValueOnce(new Error("network response lost"))
			.mockRejectedValueOnce(new Error("network unavailable"));
		const broker = createCompanyOperationBroker({
			sessionId: "session-1",
			execution: () => execution,
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt,
			apply,
		});
		const capability = intent(execution);
		expect(broker.authorizeIntent(capability)).toBe(true);
		const responses: Array<Record<string, unknown>> = [];
		broker.handleFrame(
			{
				type: "qorpera_company_operation_request",
				requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				kind: "manage_routine",
				input: { action: "pause", routineKey: "weekly" },
				intent: capability,
			},
			(response) => responses.push(response as Record<string, unknown>),
		);
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(responses[0].message).toBe("Submitted.");
		expect(apply).toHaveBeenCalledTimes(1);
		expect(completeReceipt).toHaveBeenCalledTimes(3);
	});
});
