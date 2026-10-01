import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseRunnerBearer,
	parseRunnerControlRequest,
	runnerControlRpcName,
	runnerControlRpcStatus,
	runnerStartRpcStatus,
} from "./runner-control.ts";

const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const jobId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const renewalId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const assignmentId = "33333333-3333-4333-8333-333333333333";
const clientArtifactIndexId = "11111111-1111-4111-8111-111111111111";
const clientSubstrateVersionId = "22222222-2222-4222-8222-222222222222";
const outputSnapshotId = "44444444-4444-4444-8444-444444444444";
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

	it("bounds assignment acceptance, completion, and failure payloads", () => {
		assert.equal(runnerControlRpcName("complete"), "qorpera_complete_runner_job_v6");
		assert.equal(runnerControlRpcStatus({ code: "40001" }), 409);
		assert.equal(runnerControlRpcStatus({ code: "23505" }), 409);
		assert.equal(runnerControlRpcStatus({ code: "55000" }), 423);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "accept",
				runnerId,
				assignmentId,
				jobId,
				assignmentCapability: token,
			}),
			{ action: "accept", runnerId, assignmentId, jobId, assignmentCapability: token },
		);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "complete",
				runnerId,
				jobId,
				leaseToken: token,
				clientArtifactIndexId,
				clientSubstrateVersionId,
				outputSnapshotId,
				result: { ok: true },
			}),
			{
				action: "complete",
				runnerId,
				jobId,
				leaseToken: token,
				clientArtifactIndexId,
				clientSubstrateVersionId,
				outputSnapshotId,
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

	it("parses a start as an acceptance plus an optional native authority lease", () => {
		assert.equal(runnerControlRpcName("start"), "qorpera_start_runner_assignment");
		assert.deepEqual(
			parseRunnerControlRequest({ action: "start", runnerId, assignmentId, jobId, assignmentCapability: token }),
			{ action: "start", runnerId, assignmentId, jobId, assignmentCapability: token },
		);
		assert.deepEqual(
			parseRunnerControlRequest({
				action: "start",
				runnerId,
				assignmentId,
				jobId,
				assignmentCapability: token,
				nativeLeaseSeconds: 120,
			}),
			{ action: "start", runnerId, assignmentId, jobId, assignmentCapability: token, nativeLeaseSeconds: 120 },
		);
		// The same bounds the broker's native authority action applies.
		for (const nativeLeaseSeconds of [29, 901, 120.5, "120", null]) {
			assert.throws(() =>
				parseRunnerControlRequest({
					action: "start",
					runnerId,
					assignmentId,
					jobId,
					assignmentCapability: token,
					nativeLeaseSeconds,
				}),
			);
		}
		assert.throws(() =>
			parseRunnerControlRequest({ action: "start", runnerId, assignmentId, jobId, assignmentCapability: "short" }),
		);
	});

	it("maps start refusals like acceptance, and a database without the start function to 501", () => {
		assert.equal(runnerStartRpcStatus({ code: "PGRST202" }), 501);
		for (const code of ["42501", "40001", "23505", "55000", "QRC01", undefined]) {
			assert.equal(runnerStartRpcStatus({ code }), runnerControlRpcStatus({ code }));
		}
		// Only the start action treats a missing function as "use the separate calls".
		assert.equal(runnerControlRpcStatus({ code: "PGRST202" }), 503);
	});
});
