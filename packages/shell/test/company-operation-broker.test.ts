import type { KernelIntentCapability } from "@qorpera/pi-protocol";
import { describe, expect, it } from "vitest";
import { createCompanyOperationBroker } from "../src/company-operation-broker.ts";

function intent(): KernelIntentCapability {
	const issuedAt = Date.now();
	return {
		nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "session-1",
		requestHash: "hash",
		attended: true,
		issuedAt: new Date(issuedAt).toISOString(),
		expiresAt: new Date(issuedAt + 60_000).toISOString(),
		budget: { maxCalls: 100, maxInputTokens: 100, maxOutputTokens: 100, maxCostUsd: 1 },
		signature: "signature",
	};
}

describe("company operation host broker", () => {
	it("responds only after the host mutation has completed", async () => {
		let finish: ((result: { message: string }) => void) | undefined;
		const applied = new Promise<{ message: string }>((resolve) => {
			finish = resolve;
		});
		const broker = createCompanyOperationBroker({ sessionId: "session-1", apply: async () => applied });
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
});
