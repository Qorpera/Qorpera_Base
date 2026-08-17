import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_RUNNER_BROKER_OBJECT_BYTES,
	parseRunnerBrokerAuthorization,
	parseRunnerBrokerObjectRequest,
	parseRunnerBrokerRequest,
	readRunnerBrokerObjectBody,
	readRunnerBrokerRequest,
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
	});

	it("rejects oversized request bodies before parsing JSON", async () => {
		const request = new Request("https://example.test/functions/v1/runner-broker", {
			method: "POST",
			headers: { "content-length": String(129 * 1024) },
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
});
