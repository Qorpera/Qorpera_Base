import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunnerBrokerAuthorization, parseRunnerBrokerRequest, readRunnerBrokerRequest } from "./runner-broker.ts";

const runnerId = "88888888-8888-4888-8888-888888888888";
const jobId = "77777777-7777-4777-8777-777777777777";
const runId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const leaseId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const token = "a".repeat(43);

function headers(): Headers {
	return new Headers({
		authorization: `Bearer ${token}`,
		"x-qorpera-lease-token": token,
	});
}

describe("runner broker request validation", () => {
	it("keeps runner and lease credentials in headers", () => {
		assert.deepEqual(parseRunnerBrokerAuthorization(headers()), {
			sessionToken: token,
			leaseToken: token,
		});
		const missingLease = headers();
		missingLease.delete("x-qorpera-lease-token");
		assert.throws(() => parseRunnerBrokerAuthorization(missingLease), /lease token/);
	});

	it("validates the description and native authority requests", () => {
		assert.deepEqual(parseRunnerBrokerRequest({ action: "describe", runnerId, jobId }), {
			action: "describe",
			runnerId,
			jobId,
		});
		assert.deepEqual(
			parseRunnerBrokerRequest({ action: "native_authority", runnerId, jobId, runId, assignmentId, leaseSeconds: 300 }),
			{ action: "native_authority", runnerId, jobId, runId, assignmentId, leaseSeconds: 300 },
		);
		assert.throws(
			() =>
				parseRunnerBrokerRequest({ action: "native_authority", runnerId, jobId, runId, assignmentId, leaseSeconds: 901 }),
			/lease seconds/,
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({ action: "renew_native_authority", runnerId, jobId, leaseId, leaseSeconds: 60 }),
			{ action: "renew_native_authority", runnerId, jobId, leaseId, leaseSeconds: 60 },
		);
		assert.deepEqual(
			parseRunnerBrokerRequest({ action: "release_native_authority", runnerId, jobId, leaseId, status: "released" }),
			{ action: "release_native_authority", runnerId, jobId, leaseId, status: "released" },
		);
		assert.throws(
			() => parseRunnerBrokerRequest({ action: "release_native_authority", runnerId, jobId, leaseId, status: "kept" }),
			/release status/,
		);
		// The snapshot-v1 lane's actions are gone (legacy sweep step D5).
		for (const action of ["inputs", "transcript", "operations", "artifacts", "model", "register_artifact"]) {
			assert.throws(() => parseRunnerBrokerRequest({ action, runnerId, jobId }), /broker action/);
		}
	});

	it("rejects oversized request bodies before parsing JSON", async () => {
		const request = new Request("https://example.test/functions/v1/runner-broker", {
			method: "POST",
			headers: { "content-length": String(513 * 1024) },
			body: "{}",
		});
		await assert.rejects(readRunnerBrokerRequest(request), /request size/);
	});
});
