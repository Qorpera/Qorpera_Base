import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	acquireNativeAuthorityWithRollback,
	parseRunnerBrokerAuthorization,
	parseRunnerBrokerRequest,
	readRunnerBrokerRequest,
} from "./runner-broker.ts";

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
		assert.throws(() => parseRunnerBrokerRequest({ action: "unknown", runnerId, jobId }), /broker action/);
	});

	it("rejects oversized request bodies before parsing JSON", async () => {
		const request = new Request("https://example.test/functions/v1/runner-broker", {
			method: "POST",
			headers: { "content-length": String(513 * 1024) },
			body: "{}",
		});
		await assert.rejects(readRunnerBrokerRequest(request), /request size/);

		let pulled = 0;
		let cancelled = false;
		const oversized = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				if (pulled > 32) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(64 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const chunked = new Request("https://example.test/functions/v1/runner-broker", {
			method: "POST",
			body: oversized,
			duplex: "half",
		} as RequestInit);
		await assert.rejects(readRunnerBrokerRequest(chunked), /request size/);
		assert.equal(cancelled, true);
		assert.ok(pulled <= 10, `expected early stream cancellation, saw ${pulled} chunks`);
	});

	it("releases an acquired native provider lease when qorpera_native_run_model_authority fails", async () => {
		const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
		const outcome = await acquireNativeAuthorityWithRollback(
			async (fn, args) => {
				calls.push({ fn, args });
				if (fn === "qorpera_acquire_native_provider_connection_lease") {
					return { data: { lease_id: leaseId, provider: "openai" }, error: null };
				}
				if (fn === "qorpera_native_run_model_authority") {
					return { data: null, error: { code: "08006" } };
				}
				return { data: { released: true }, error: null };
			},
			{ action: "native_authority", runnerId, jobId, runId, assignmentId, leaseSeconds: 300 },
			{ sessionTokenSha256: "1".repeat(64), leaseTokenSha256: "2".repeat(64) },
		);
		assert.deepEqual(outcome, { ok: false, status: 503, error: "Native provider model authority was rejected" });
		assert.deepEqual(
			calls.map((c) => c.fn),
			[
				"qorpera_acquire_native_provider_connection_lease",
				"qorpera_native_run_model_authority",
				"qorpera_release_native_provider_connection_lease",
			],
		);
		assert.equal(calls[2]?.args.p_lease_id, leaseId);
		assert.equal(calls[2]?.args.p_status, "released");

		const thenableCalls: string[] = [];
		const thenOnlyOutcome = await acquireNativeAuthorityWithRollback(
			(fn) => ({
				then(onFulfilled, onRejected) {
					thenableCalls.push(fn);
					if (fn === "qorpera_acquire_native_provider_connection_lease") {
						return Promise.resolve({ data: { lease_id: leaseId }, error: null }).then(onFulfilled, onRejected);
					}
					if (fn === "qorpera_native_run_model_authority") {
						return Promise.resolve({ data: null, error: { code: "42501" } }).then(onFulfilled, onRejected);
					}
					return Promise.reject(new Error("release failed")).then(onFulfilled, onRejected);
				},
			}),
			{ action: "native_authority", runnerId, jobId, runId, assignmentId, leaseSeconds: 300 },
			{ sessionTokenSha256: "1".repeat(64), leaseTokenSha256: "2".repeat(64) },
		);
		assert.deepEqual(thenOnlyOutcome, {
			ok: false,
			status: 401,
			error: "Native provider model authority was rejected",
		});
		assert.deepEqual(thenableCalls, [
			"qorpera_acquire_native_provider_connection_lease",
			"qorpera_native_run_model_authority",
			"qorpera_release_native_provider_connection_lease",
		]);
	});
});
