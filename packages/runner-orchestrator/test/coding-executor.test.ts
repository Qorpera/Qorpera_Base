import { randomUUID } from "node:crypto";
import type { CloudCodingWorker } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCodingExecutor,
	type CodingExecutorClaim,
	type CodingExecutorControl,
	type CodingExecutorHost,
} from "../src/coding-executor.ts";

afterEach(() => vi.useRealTimers());
function fixture() {
	const id = randomUUID();
	let worker: CloudCodingWorker = {
		schema: "qorpera.coding-worker/v1",
		id,
		companyId: randomUUID(),
		parentAgentId: randomUUID(),
		parentRunId: randomUUID(),
		repository: { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" },
		branch: `qorpera/coding/${id}`,
		vmId: null,
		version: 1,
		state: "queued",
		turn: 1,
		pullRequest: null,
	};
	const claim: CodingExecutorClaim = {
		requestId: randomUUID(),
		leaseToken: randomUUID(),
		environmentId: randomUUID(),
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		worker,
		dispatch: {
			operationKey: "one",
			repository: worker.repository,
			goal: "Build",
			definitionOfDone: "Tests pass",
			context: "",
			sourceReadIds: [],
			todoPath: "projects/test/todo.json",
			cancellationPolicy: "retain-workspace",
			completionPolicy: "notify-parent",
			publication: "draft-pr",
		},
		kind: "dispatch",
		goal: "Build",
	};
	const events: string[] = [];
	const call = vi.fn<CodingExecutorControl["call"]>(async (method, args) => {
		if (method === "qorpera_claim_coding_request") return structuredClone(claim);
		if (method === "qorpera_prepare_coding_execution") {
			events.push("admit-native");
			return {};
		}
		if (method === "qorpera_heartbeat_coding_request") return new Date(Date.now() + 60000).toISOString();
		if (method === "qorpera_describe_coding_cancellation") return worker;
		if (method === "qorpera_record_coding_progress") {
			events.push(String(args.p_state));
			worker = { ...worker, version: worker.version + 1, state: args.p_state as CloudCodingWorker["state"] };
			return worker;
		}
		if (method === "qorpera_complete_coding_request") {
			events.push("complete");
			worker = {
				...worker,
				version: worker.version + 1,
				state: args.p_state as CloudCodingWorker["state"],
				pullRequest: args.p_pull_request as CloudCodingWorker["pullRequest"],
			};
			return worker;
		}
		throw new Error("unexpected");
	});
	const host = {
		refreshLease: vi.fn<CodingExecutorHost["refreshLease"]>(async () => {
			events.push("guest-lease");
		}),
		prepareWorkspace: vi.fn<CodingExecutorHost["prepareWorkspace"]>(async () => {
			events.push("workspace");
			worker = { ...worker, vmId: randomUUID(), version: worker.version + 1 };
			return worker;
		}),
		runNative: vi.fn<CodingExecutorHost["runNative"]>(async () => {
			events.push("native");
		}),
		publish: vi.fn<CodingExecutorHost["publish"]>(async () => {
			events.push("publish");
			return {
				summary: "Build completed and verified",
				noChange: false,
				pullRequest: { url: "https://github.com/Qorpera/test/pull/1", number: 1, headSha: "a".repeat(40) },
			};
		}),
		stopWorkspace: vi.fn<CodingExecutorHost["stopWorkspace"]>(async () => {
			events.push("stop");
		}),
	};
	const executor = new CloudCodingExecutor({ control: { call }, host, owner: "coding-node" });
	return { claim, call, host, executor, events, signal: new AbortController().signal };
}
describe("coding executor custody", () => {
	it("admit, prepare, run, publish, physically stop and only then complete", async () => {
		const f = fixture();
		expect(await f.executor.runOnce(f.signal)).toBe("completed");
		expect(f.events).toEqual([
			"admit-native",
			"workspace",
			"guest-lease",
			"provisioning",
			"ready",
			"running",
			"native",
			"publish",
			"stop",
			"complete",
		]);
		expect(f.call.mock.calls.find((row) => row[0] === "qorpera_complete_coding_request")?.[1]).toMatchObject({
			p_request_id: f.claim.requestId,
			p_lease_token: f.claim.leaseToken,
			p_result: { draftPrVerified: true },
			p_pull_request: { number: 1 },
		});
	});
	it("cancels physical work without starting a model or publishing", async () => {
		const f = fixture();
		f.claim.kind = "cancel";
		expect(await f.executor.runOnce(f.signal)).toBe("cancelled");
		expect(f.events).toEqual(["stop", "complete"]);
		expect(f.host.runNative).not.toHaveBeenCalled();
	});
	it("never converts a stopped-model failure into completion", async () => {
		const f = fixture();
		f.host.runNative.mockRejectedValue(new Error("provider unavailable"));
		expect(await f.executor.runOnce(f.signal)).toBe("recovery-required");
		expect(f.host.publish).not.toHaveBeenCalled();
		expect(f.host.stopWorkspace).toHaveBeenCalledTimes(1);
		expect(f.events).not.toContain("complete");
	});
	it("uses the authorized post-cleanup cancellation version", async () => {
		const f = fixture(),
			original = f.call.getMockImplementation()!;
		f.claim.kind = "cancel";
		f.call.mockImplementation((method, args, signal) =>
			method === "qorpera_describe_coding_cancellation"
				? Promise.resolve({ ...f.claim.worker, version: 7, state: "recovery-required" })
				: original(method, args, signal),
		);
		expect(await f.executor.runOnce(f.signal)).toBe("cancelled");
		expect(
			f.call.mock.calls.find(([method]) => method === "qorpera_complete_coding_request")?.[1].p_expected_version,
		).toBe(7);
	});
	it("refuses a cancellation snapshot for another worker", async () => {
		const f = fixture(),
			original = f.call.getMockImplementation()!;
		f.claim.kind = "cancel";
		f.call.mockImplementation((method, args, signal) =>
			method === "qorpera_describe_coding_cancellation"
				? Promise.resolve({ ...f.claim.worker, id: randomUUID(), version: 7, state: "recovery-required" })
				: original(method, args, signal),
		);
		expect(await f.executor.runOnce(f.signal)).toBe("recovery-required");
		expect(f.events).not.toContain("complete");
	});
	it("does not replay publication after a lost completion response", async () => {
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) => {
			const result = await original(method, args, signal);
			if (method === "qorpera_complete_coding_request") throw new Error("response lost");
			return result;
		});
		expect(await f.executor.runOnce(f.signal)).toBe("recovery-required");
		expect(f.host.publish).toHaveBeenCalledTimes(1);
		expect(f.call.mock.calls.filter((row) => row[0] === "qorpera_complete_coding_request")).toHaveLength(1);
	});
	it("lease expiry aborts native work and invokes independent physical cleanup", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation((method, args, signal) =>
			method === "qorpera_heartbeat_coding_request"
				? Promise.reject(new Error("revoked"))
				: original(method, args, signal),
		);
		f.host.runNative.mockImplementation(
			async (_claim, signal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }),
				),
		);
		const running = f.executor.runOnce(f.signal);
		await vi.advanceTimersByTimeAsync(60000);
		expect(await running).toBe("recovery-required");
		expect(f.host.stopWorkspace.mock.calls[0][1].aborted).toBe(false);
		expect(f.host.publish).not.toHaveBeenCalled();
	});
	it("rejects VM replacement before native execution", async () => {
		const f = fixture();
		f.claim.worker = { ...f.claim.worker, vmId: randomUUID() };
		expect(await f.executor.runOnce(f.signal)).toBe("recovery-required");
		expect(f.host.runNative).not.toHaveBeenCalled();
		expect(f.host.stopWorkspace).toHaveBeenCalledTimes(1);
	});
	it("does not start the native model without a confirmed guest lease", async () => {
		const f = fixture();
		f.host.refreshLease.mockRejectedValue(new Error("guest lease unconfirmed"));
		expect(await f.executor.runOnce(f.signal)).toBe("recovery-required");
		expect(f.host.runNative).not.toHaveBeenCalled();
		expect(f.host.stopWorkspace).toHaveBeenCalledTimes(1);
	});
});
