import {
	parseCloudRunnerModelResponse,
	validateCloudRunnerModelRequest,
} from "@qorpera/cloud-client/cloud-runner-model";
import { describe, expect, it } from "vitest";

const requestId = "34343434-3434-4434-8434-343434343434";

describe("cloud runner model broker contracts", () => {
	it("bounds request and response projections", () => {
		expect(
			validateCloudRunnerModelRequest({
				requestId,
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "bounded" },
				maxOutputTokens: 128,
			}),
		).toMatchObject({ requestId, maxOutputTokens: 128 });
		expect(
			parseCloudRunnerModelResponse({
				request_id: requestId,
				provider: "openai",
				model: "gpt-test",
				output: { text: "safe" },
				usage: { input_tokens: 8, output_tokens: 2, cost_microusd: 125 },
			}),
		).toMatchObject({ requestId, usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 } });
		expect(() =>
			validateCloudRunnerModelRequest({
				requestId,
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "x".repeat(257 * 1024) },
				maxOutputTokens: 128,
			}),
		).toThrow("request input");
	});
});
