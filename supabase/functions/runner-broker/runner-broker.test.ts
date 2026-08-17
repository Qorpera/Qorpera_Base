import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	executeRunnerModelGateway,
	MAX_RUNNER_BROKER_OBJECT_BYTES,
	parseRunnerBrokerAuthorization,
	parseRunnerBrokerObjectRequest,
	parseRunnerBrokerRequest,
	parseRunnerModelGatewayResponse,
	readRunnerBrokerObjectBody,
	readRunnerBrokerRequest,
	readRunnerModelGatewayResponse,
} from "./runner-broker.ts";

const runnerId = "88888888-8888-4888-8888-888888888888";
const jobId = "77777777-7777-4777-8777-777777777777";
const clientArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = "a".repeat(43);
const objectSha256 = "b".repeat(64);

function headers(): Headers {
	return new Headers({
		authorization: `Bearer ${token}`,
		"x-qorpera-lease-token": token,
		"x-qorpera-runner-id": runnerId,
		"x-qorpera-job-id": jobId,
		"x-qorpera-object-sha256": objectSha256,
	});
}

describe("runner broker request validation", () => {
	it("keeps runner and lease credentials in headers", () => {
		assert.deepEqual(parseRunnerBrokerAuthorization(headers()), {
			sessionToken: token,
			leaseToken: token,
		});
		assert.deepEqual(parseRunnerBrokerObjectRequest(headers()), {
			sessionToken: token,
			leaseToken: token,
			runnerId,
			jobId,
			objectSha256,
		});
		const missingLease = headers();
		missingLease.delete("x-qorpera-lease-token");
		assert.throws(() => parseRunnerBrokerAuthorization(missingLease), /lease token/);
	});

	it("validates bounded metadata and pagination requests", () => {
		assert.deepEqual(
			parseRunnerBrokerRequest({ action: "operations", runnerId, jobId, afterSequence: 12, limit: 200 }),
			{ action: "operations", runnerId, jobId, afterSequence: 12, limit: 200 },
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "register_artifact",
				runnerId,
				jobId,
				clientArtifactId,
				artifactType: "runner_output",
				name: "result.txt",
				objectSha256,
				bytes: MAX_RUNNER_BROKER_OBJECT_BYTES,
				mediaType: "TEXT/PLAIN",
			}),
			{
				action: "register_artifact",
				runnerId,
				jobId,
				clientArtifactId,
				artifactType: "runner_output",
				name: "result.txt",
				objectSha256,
				bytes: MAX_RUNNER_BROKER_OBJECT_BYTES,
				mediaType: "text/plain",
			},
		);
		assert.throws(
			() =>
				parseRunnerBrokerRequest({
					action: "register_artifact",
					runnerId,
					jobId,
					clientArtifactId,
					artifactType: "runner_output",
					name: "result.txt",
					objectSha256,
					bytes: MAX_RUNNER_BROKER_OBJECT_BYTES + 1,
					mediaType: "text/plain",
				}),
			/artifact bytes/,
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "model",
				runnerId,
				jobId,
				requestId: "34343434-3434-4434-8434-343434343434",
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "bounded" },
				maxOutputTokens: 128,
			}),
			{
				action: "model",
				runnerId,
				jobId,
				requestId: "34343434-3434-4434-8434-343434343434",
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "bounded" },
				maxOutputTokens: 128,
			},
		);
	});

	it("rejects oversized request bodies before parsing JSON", async () => {
		const request = new Request("https://example.test/functions/v1/runner-broker", {
			method: "POST",
			headers: { "content-length": String(513 * 1024) },
			body: "{}",
		});
		await assert.rejects(readRunnerBrokerRequest(request), /request size/);
	});

	it("bounds streamed object bodies by their declared length", async () => {
		const exact = new Request("https://example.test", { method: "PUT", body: "test" });
		assert.deepEqual(await readRunnerBrokerObjectBody(exact, 4), new TextEncoder().encode("test"));
		const oversized = new Request("https://example.test", { method: "PUT", body: "tests" });
		await assert.rejects(readRunnerBrokerObjectBody(oversized, 4), /object body/);
	});

	it("validates and bounds the credential-free model gateway response", async () => {
		const body = {
			schema: "qorpera.model-gateway-response/v1",
			output: { text: "safe" },
			usage: { input_tokens: 8, output_tokens: 2, cost_microusd: 125 },
		};
		assert.deepEqual(parseRunnerModelGatewayResponse(body), {
			output: { text: "safe" },
			usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 },
		});
		assert.deepEqual(await readRunnerModelGatewayResponse(Response.json(body)), {
			output: { text: "safe" },
			usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 },
		});
		assert.throws(
			() => parseRunnerModelGatewayResponse({ ...body, usage: { ...body.usage, output_tokens: -1 } }),
			/output usage/,
		);
		const oversized = new Response("{}", { headers: { "content-length": String(513 * 1024) } });
		await assert.rejects(readRunnerModelGatewayResponse(oversized), /response size/);
	});

	it("executes one idempotent gateway call without forwarding runner credentials", async () => {
		let gatewayRequest: { url: string; init?: RequestInit } | undefined;
		const finalizations: unknown[] = [];
		const result = await executeRunnerModelGateway({
			url: "https://models.qorpera.test/v1/run",
			token: "gateway-secret-token-that-is-long-enough",
			request: {
				requestId: "34343434-3434-4434-8434-343434343434",
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "bounded" },
				maxOutputTokens: 128,
			},
			inputTokenReservation: 16_400,
			fetchImplementation: async (input, init) => {
				gatewayRequest = { url: String(input), init };
				return Response.json({
					schema: "qorpera.model-gateway-response/v1",
					output: { text: "safe" },
					usage: { input_tokens: 8, output_tokens: 2, cost_microusd: 125 },
				});
			},
			finalize: async (input) => {
				finalizations.push(input);
				return { stored: true };
			},
		});
		assert.deepEqual(result, { status: "completed", value: { stored: true } });
		assert.equal(gatewayRequest?.url, "https://models.qorpera.test/v1/run");
		const headers = new Headers(gatewayRequest?.init?.headers);
		assert.equal(headers.get("idempotency-key"), "34343434-3434-4434-8434-343434343434");
		assert.equal(headers.get("authorization"), "Bearer gateway-secret-token-that-is-long-enough");
		assert.doesNotMatch(String(gatewayRequest?.init?.body), new RegExp(token));
		assert.deepEqual(finalizations, [
			{
				outcome: "completed",
				usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 },
				response: { text: "safe" },
				errorCode: null,
			},
		]);
	});

	it("fails and records zero observed usage when the gateway exceeds its reservation", async () => {
		const finalizations: unknown[] = [];
		const result = await executeRunnerModelGateway({
			url: "https://models.qorpera.test/v1/run",
			token: "gateway-secret-token-that-is-long-enough",
			request: {
				requestId: "34343434-3434-4434-8434-343434343434",
				provider: "openai",
				model: "gpt-test",
				input: { prompt: "bounded" },
				maxOutputTokens: 1,
			},
			inputTokenReservation: 32,
			fetchImplementation: async () =>
				Response.json({
					schema: "qorpera.model-gateway-response/v1",
					output: { text: "too much" },
					usage: { input_tokens: 8, output_tokens: 2, cost_microusd: 125 },
				}),
			finalize: async (input) => {
				finalizations.push(input);
				return null;
			},
		});
		assert.deepEqual(result, { status: "failed" });
		assert.deepEqual(finalizations, [
			{
				outcome: "failed",
				usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0 },
				response: null,
				errorCode: "gateway_usage_invalid",
			},
		]);
	});
});
