import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	executeRunnerModelGateway,
	MAX_RUNNER_BROKER_OBJECT_BYTES,
	parseRunnerBrokerAuthorization,
	parseRunnerBrokerObjectRequest,
	parseRunnerBrokerRequest,
	parseRunnerModelGatewayAuthority,
	parseRunnerModelGatewayResponse,
	readRunnerBrokerObjectBody,
	readRunnerBrokerRequest,
	readRunnerModelGatewayResponse,
} from "./runner-broker.ts";

const runnerId = "88888888-8888-4888-8888-888888888888";
const jobId = "77777777-7777-4777-8777-777777777777";
const clientArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assignmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const receiptId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const token = "a".repeat(43);
const objectSha256 = "b".repeat(64);
const modelAuthority = {
	runId: "11111111-1111-4111-8111-111111111111",
	jobId,
	sponsorBindingId: "22222222-2222-4222-8222-222222222222",
	sponsorVersion: 3,
	providerConnectionId: "33333333-3333-4333-8333-333333333333",
	providerConnectionVersion: 4,
	provider: "openai",
	authenticationMode: "api_key" as const,
	nativeHarness: "openai-responses",
	maxCostMicrousd: 25_000,
};

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
			purpose: "artifact",
		});
		const companyFileHeaders = headers();
		companyFileHeaders.set("x-qorpera-object-purpose", "company_file");
		assert.equal(parseRunnerBrokerObjectRequest(companyFileHeaders).purpose, "company_file");
		companyFileHeaders.set("x-qorpera-object-purpose", "unscoped");
		assert.throws(() => parseRunnerBrokerObjectRequest(companyFileHeaders), /purpose/);
		const missingLease = headers();
		missingLease.delete("x-qorpera-lease-token");
		assert.throws(() => parseRunnerBrokerAuthorization(missingLease), /lease token/);
	});

	it("validates bounded metadata and pagination requests", () => {
		assert.deepEqual(parseRunnerBrokerRequest({ action: "inputs", runnerId, jobId }), {
			action: "inputs",
			runnerId,
			jobId,
		});
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "prepare_company_revision",
				runnerId,
				jobId,
				assignmentId,
				clientRevisionId: clientArtifactId,
				treeManifestSha256: objectSha256,
				treeManifestBytes: 512,
				treeContractVersion: 3,
				fileCount: 4,
				totalBytes: 4096,
			}),
			{
				action: "prepare_company_revision",
				runnerId,
				jobId,
				assignmentId,
				clientRevisionId: clientArtifactId,
				treeManifestSha256: objectSha256,
				treeManifestBytes: 512,
				treeContractVersion: 3,
				fileCount: 4,
				totalBytes: 4096,
			},
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "begin_company_revision_graph",
				runnerId,
				jobId,
				assignmentId,
				snapshotId: clientArtifactId,
				clientGraphId: receiptId,
				rootObjectSha256: objectSha256,
				contentSha256: "c".repeat(64),
				objectCount: 2,
				storageBytes: 1024,
			}),
			{
				action: "begin_company_revision_graph",
				runnerId,
				jobId,
				assignmentId,
				snapshotId: clientArtifactId,
				clientGraphId: receiptId,
				rootObjectSha256: objectSha256,
				contentSha256: "c".repeat(64),
				objectCount: 2,
				storageBytes: 1024,
			},
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "append_company_revision_graph",
				runnerId,
				jobId,
				assignmentId,
				graphId: receiptId,
				entries: [{ sha256: objectSha256, bytes: 512 }],
			}),
			{
				action: "append_company_revision_graph",
				runnerId,
				jobId,
				assignmentId,
				graphId: receiptId,
				entries: [{ sha256: objectSha256, bytes: 512 }],
			},
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "verify_company_revision",
				runnerId,
				jobId,
				assignmentId,
				snapshotId: clientArtifactId,
				graphId: receiptId,
			}),
			{
				action: "verify_company_revision",
				runnerId,
				jobId,
				assignmentId,
				snapshotId: clientArtifactId,
				graphId: receiptId,
			},
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({ action: "transcript", runnerId, jobId, afterSequence: 4, limit: 100 }),
			{ action: "transcript", runnerId, jobId, afterSequence: 4, limit: 100 },
		);
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
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "begin_operation",
				runnerId,
				jobId,
				assignmentId,
				receiptId,
				logicalOperationKey: "ticket:123:reply",
				operationKind: "send_email",
				inputSha256: objectSha256,
				downstreamIdempotencyKey: "qorpera-run-operation-123",
				requiresCompanyRevision: false,
			}),
			{
				action: "begin_operation",
				runnerId,
				jobId,
				assignmentId,
				receiptId,
				logicalOperationKey: "ticket:123:reply",
				operationKind: "send_email",
				inputSha256: objectSha256,
				downstreamIdempotencyKey: "qorpera-run-operation-123",
				requiresCompanyRevision: false,
			},
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({
				action: "append_transcript",
				runnerId,
				jobId,
				assignmentId,
				eventId: receiptId,
				eventType: "message",
				entry: {
					type: "message",
					id: receiptId,
					parentId: null,
					timestamp: "2026-08-20T12:00:00.000Z",
					message: { role: "assistant", text: "durable" },
				},
				expectedSequence: 4,
			}),
			{
				action: "append_transcript",
				runnerId,
				jobId,
				assignmentId,
				eventId: receiptId,
				eventType: "message",
				entry: {
					type: "message",
					id: receiptId,
					parentId: null,
					timestamp: "2026-08-20T12:00:00.000Z",
					message: { role: "assistant", text: "durable" },
				},
				expectedSequence: 4,
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

	it("validates the opaque sponsor authority without accepting a vault secret", () => {
		assert.deepEqual(
			parseRunnerModelGatewayAuthority({
				schema: "qorpera.model-gateway-authority/v1",
				run_id: modelAuthority.runId,
				job_id: modelAuthority.jobId,
				sponsor_binding_id: modelAuthority.sponsorBindingId,
				sponsor_version: modelAuthority.sponsorVersion,
				provider_connection_id: modelAuthority.providerConnectionId,
				provider_connection_version: modelAuthority.providerConnectionVersion,
				provider: modelAuthority.provider,
				authentication_mode: modelAuthority.authenticationMode,
				native_harness: modelAuthority.nativeHarness,
				max_cost_microusd: modelAuthority.maxCostMicrousd,
			}),
			modelAuthority,
		);
		assert.throws(
			() =>
				parseRunnerModelGatewayAuthority({
					schema: "qorpera.model-gateway-authority/v1",
					secret_reference: "must-not-cross-the-broker",
				}),
			/authority/,
		);
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
				authority: modelAuthority,
			},
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
		assert.doesNotMatch(String(gatewayRequest?.init?.body), /secret_reference/);
		assert.match(String(gatewayRequest?.init?.body), new RegExp(modelAuthority.providerConnectionId));
		assert.deepEqual(finalizations, [
			{
				outcome: "completed",
				usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 },
				response: { text: "safe" },
				errorCode: null,
			},
		]);
	});

	it("records observed usage when the gateway exceeds its reservation", async () => {
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
				authority: modelAuthority,
			},
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
				usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 },
				response: null,
				errorCode: "gateway_usage_exceeded",
			},
		]);
	});

	it("records and rejects a gateway response above the sponsor cost authority", async () => {
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
				authority: { ...modelAuthority, maxCostMicrousd: 100 },
			},
			fetchImplementation: async () =>
				Response.json({
					schema: "qorpera.model-gateway-response/v1",
					output: { text: "too expensive" },
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
				usage: { inputTokens: 8, outputTokens: 2, costMicrousd: 125 },
				response: null,
				errorCode: "gateway_cost_exceeded",
			},
		]);
	});

	it("leaves timeouts recoverable without inventing a zero-usage finalization", async () => {
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
				authority: modelAuthority,
			},
			fetchImplementation: async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
			timeoutMs: 1,
			finalize: async (input) => {
				finalizations.push(input);
				return null;
			},
		});
		assert.deepEqual(result, { status: "ambiguous", errorCode: "gateway_timeout" });
		assert.deepEqual(finalizations, []);
	});

	it("settles a deterministic gateway rejection as failed with zero usage", async () => {
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
				authority: modelAuthority,
			},
			fetchImplementation: async () => new Response("model is not allowed", { status: 422 }),
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
				errorCode: "gateway_rejected",
			},
		]);
	});

	it("keeps transient gateway backpressure ambiguous for replay recovery", async () => {
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
				authority: modelAuthority,
			},
			fetchImplementation: async () => new Response("slow down", { status: 429 }),
			finalize: async (input) => {
				finalizations.push(input);
				return null;
			},
		});
		assert.deepEqual(result, { status: "ambiguous", errorCode: "gateway_rejected" });
		assert.deepEqual(finalizations, []);
	});
});
