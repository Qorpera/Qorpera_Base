import { describe, expect, it } from "vitest";
import {
	normalizeCloudRunnerAllowedModels,
	parseCloudRunnerModelPolicy,
	parseCloudRunnerModelResponse,
	parseCloudRunnerModelUsageObservation,
	validateCloudRunnerModelRequest,
} from "../src/cloud-runner-model.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const jobId = "77777777-7777-4777-8777-777777777777";
const requestId = "34343434-3434-4434-8434-343434343434";
const runnerId = "88888888-8888-4888-8888-888888888888";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";

describe("cloud runner model broker contracts", () => {
	it("normalizes explicit policy authority and keeps actor and authorizer separate", () => {
		expect(
			parseCloudRunnerModelPolicy({
				job_id: jobId,
				profile_id: profileId,
				environment_id: environmentId,
				allowed_models: [
					{ provider: "openai", model: "gpt-test-z" },
					{ provider: "openai", model: "gpt-test-a" },
				],
				max_calls: 4,
				max_input_tokens: 10_000,
				max_output_tokens: 2_000,
				authorized_by_user_id: actorUserId,
				created_at: "2026-08-17T03:00:00.000Z",
			}),
		).toMatchObject({
			jobId,
			allowedModels: [
				{ provider: "openai", model: "gpt-test-a" },
				{ provider: "openai", model: "gpt-test-z" },
			],
			authorizedByUserId: actorUserId,
		});
		expect(() =>
			normalizeCloudRunnerAllowedModels([
				{ provider: "openai", model: "gpt-test" },
				{ provider: "openai", model: "gpt-test" },
			]),
		).toThrow("duplicate");
	});

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

	it("parses immutable provider observations without assigning a payer", () => {
		const observation = parseCloudRunnerModelUsageObservation({
			observation_id: 1,
			profile_id: profileId,
			environment_id: environmentId,
			job_id: jobId,
			request_id: requestId,
			runner_id: runnerId,
			actor_user_id: actorUserId,
			authorized_by_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			provider: "openai",
			model: "gpt-test",
			outcome: "completed",
			input_tokens: 8,
			output_tokens: 2,
			cost_microusd: 125,
			created_at: "2026-08-17T03:00:00.000Z",
		});
		expect(observation).toMatchObject({ actorUserId, authorizedByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
		expect(observation).not.toHaveProperty("billingAccountId");
	});
});
