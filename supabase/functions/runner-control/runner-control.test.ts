import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseRunnerBearer,
	parseRunnerControlRequest,
	runnerControlRpcName,
	runnerControlRpcStatus,
} from "./runner-control.ts";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const jobId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const renewalId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const clientArtifactIndexId = "11111111-1111-4111-8111-111111111111";
const clientSubstrateVersionId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(43);
const nextToken = "b".repeat(43);

describe("runner control boundary", () => {
	it("parses activation and heartbeat without returning bearer secrets in errors", () => {
		assert.equal(parseRunnerBearer(`Bearer ${token}`), token);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "activate",
				runnerId,
				nextSessionToken: nextToken,
				platform: "linux-x64",
				runnerVersion: "0.1.0",
			}),
			{
				action: "activate",
				runnerId,
				nextSessionToken: nextToken,
				platform: "linux-x64",
				runnerVersion: "0.1.0",
			},
		);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "heartbeat",
				runnerId,
				nextSessionToken: nextToken,
				renewalId,
			}),
			{ action: "heartbeat", runnerId, nextSessionToken: nextToken, renewalId },
		);
		assert.throws(() => parseRunnerBearer(`Bearer ${token}secret`), (error: Error) => {
			assert.doesNotMatch(error.message, /secret/);
			return true;
		});
	});

	it("bounds claim, completion, and failure payloads", () => {
		assert.equal(runnerControlRpcName("complete"), "qorpera_complete_runner_job_v4");
		assert.equal(runnerControlRpcStatus({ code: "40001" }), 409);
		assert.equal(runnerControlRpcStatus({ code: "55000" }), 423);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "claim",
				runnerId,
				clientLeaseId: renewalId,
				leaseToken: token,
			}),
			{ action: "claim", runnerId, clientLeaseId: renewalId, leaseToken: token },
		);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "complete",
				runnerId,
				jobId,
				leaseToken: token,
				clientArtifactIndexId,
				clientSubstrateVersionId,
				result: { ok: true },
			}),
			{
				action: "complete",
				runnerId,
				jobId,
				leaseToken: token,
				clientArtifactIndexId,
				clientSubstrateVersionId,
				result: { ok: true },
			},
		);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "fail",
				runnerId,
				jobId,
				leaseToken: token,
				error: "temporary sandbox failure",
				retryable: true,
			}),
			{
				action: "fail",
				runnerId,
				jobId,
				leaseToken: token,
				error: "temporary sandbox failure",
				retryable: true,
			},
		);
		assert.throws(() =>
			parseRunnerControlRequest({
				action: "complete",
				runnerId,
				jobId,
				leaseToken: token,
				clientArtifactIndexId,
				clientSubstrateVersionId,
				result: { output: "x".repeat(70 * 1024) },
			}),
		);
	});
});
