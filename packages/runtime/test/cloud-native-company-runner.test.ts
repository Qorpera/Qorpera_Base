import { randomUUID } from "node:crypto";
import type { CloudRunnerJob } from "@qorpera/cloud-client/node/cloud-runner-protocol";
import { executeNativeCompanyRunnerJob } from "@qorpera/runtime/cloud-native-company-runner";
import {
	HttpNativeProviderComputerBridge,
	nativeProviderExecutionGuarantees,
} from "@qorpera/runtime/cloud-native-provider";
import type { CloudRunnerNativeAuthority } from "@qorpera/runtime/cloud-runner-broker";
import type { CloudRunnerSandboxProcess } from "@qorpera/runtime/cloud-runner-sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture() {
	const {
		binding,
		authority: { identity },
	} = nativeToolAuthorityFixture();
	const authority: CloudRunnerNativeAuthority = {
		...binding,
		providerConnectionId: identity.providerConnectionId,
		providerConnectionVersion: identity.providerConnectionVersion,
		encryptedCapsuleReference: `native-capsule/${binding.credentialCapsuleId}`,
		attestationPolicySha256: "a".repeat(64),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: identity.sponsorUserId!,
		credentialOwnershipKind: "member",
		credentialOwnerUserId: identity.sponsorUserId!,
		authenticationMode: "native_subscription",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	const job: CloudRunnerJob = {
		jobId: binding.jobId,
		runId: binding.runId,
		assignmentId: binding.assignmentId,
		runnerId: binding.runnerId,
		profileId: identity.companyId,
		environmentId: identity.environmentId,
		sessionId: identity.sessionId!,
		substrateVersionId: randomUUID(),
		clientJobId: randomUUID(),
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: { prompt: "UNTRUSTED_LOCAL_PAYLOAD", companyRoot: "/canonical/must-not-open" },
		status: "leased",
		attemptCount: 1,
		outputArtifactCount: 0,
		createdByUserId: identity.requesterUserId,
		createdAt: new Date().toISOString(),
		leaseExpiresAt: authority.expiresAt,
	};
	const receipt = {
		schema: "qorpera.native-harness-result/v2",
		run_id: binding.runId,
		message_count: 1,
		final_message_id: randomUUID(),
		provider_session_id: randomUUID(),
	};
	const terminate = vi.fn<CloudRunnerSandboxProcess["terminate"]>(async () => undefined);
	const start = vi.fn(async () => {
		throw new Error("Legacy route must never execute");
	});
	const startCompany = vi.fn(async () => ({ result: Promise.resolve(receipt), terminate }));
	const bridge = { executionGuarantees: nativeProviderExecutionGuarantees("virtual_machine"), start, startCompany };
	const options = {
		job,
		authority,
		bridge,
		signal: new AbortController().signal,
	};
	return { options, binding, receipt, terminate, start, startCompany };
}

afterEach(() => vi.useRealTimers());

it("executes with only cloud identity and produces a private receipt, never a tree publication", async () => {
	const f = fixture();
	const result = await executeNativeCompanyRunnerJob(f.options);
	expect(f.start).not.toHaveBeenCalled();
	expect(f.startCompany).toHaveBeenCalledWith(f.options.authority, { jobId: f.binding.jobId, attemptCount: 1 });
	expect(result).toMatchObject({
		outputFiles: [],
		outputBytes: 0,
		result: {
			runtime: "company-path-v1",
			native_lease_id: f.binding.leaseId,
			backend_result: f.receipt,
			publication: null,
		},
	});
	expect(result).not.toHaveProperty("outputSnapshotId");
	expect(JSON.stringify(f.startCompany.mock.calls)).not.toMatch(/UNTRUSTED_LOCAL_PAYLOAD|canonical/);
	expect(f.terminate).not.toHaveBeenCalled();
});

it("accepts a silent private completion for a wake run and leaves reply obligations to the cloud", async () => {
	const { options, startCompany } = fixture();
	const { authority, job, bridge } = options;
	const wakeJob: CloudRunnerJob = {
		...job,
		payload: { schema: "qorpera.wake-run/v1", occurrenceId: randomUUID() },
	};
	startCompany.mockImplementationOnce(async () => ({
		result: Promise.resolve({
			schema: "qorpera.native-harness-result/v2",
			run_id: wakeJob.runId ?? "",
			message_count: 0,
			final_message_id: null,
			provider_session_id: randomUUID(),
		}) as never,
		terminate: vi.fn(async () => undefined),
	}));
	const completed = await executeNativeCompanyRunnerJob({
		job: wakeJob,
		authority,
		bridge,
		signal: new AbortController().signal,
	});
	expect((completed.result as { backend_result: { message_count: number } }).backend_result.message_count).toBe(0);
	// A conversation turn that is not a wake run still requires the final send.
	startCompany.mockImplementationOnce(async () => ({
		result: Promise.resolve({
			schema: "qorpera.native-harness-result/v2",
			run_id: wakeJob.runId ?? "",
			message_count: 0,
			final_message_id: null,
			provider_session_id: randomUUID(),
		}) as never,
		terminate: vi.fn(async () => undefined),
	}));
	await expect(
		executeNativeCompanyRunnerJob({
			job,
			authority,
			bridge,
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("invalid private completion receipt");
});

it("does not downgrade when the bridge has no governed execution endpoint", async () => {
	const f = fixture();
	await expect(
		executeNativeCompanyRunnerJob({ ...f.options, bridge: { ...f.options.bridge, startCompany: undefined } }),
	).rejects.toThrow("no fallback");
	expect(f.start).not.toHaveBeenCalled();
});

it("starts on the authority the runner just acquired, without renewing it first", async () => {
	// Acquisition runs every check a renewal runs and sets the same expiry; the worker's
	// maintenance loop renews the lease from then on. This call has no way to renew it.
	const f = fixture();
	await executeNativeCompanyRunnerJob(f.options);
	expect(f.startCompany).toHaveBeenCalledOnce();
	expect(f.startCompany.mock.calls[0]).toEqual([f.options.authority, { jobId: f.binding.jobId, attemptCount: 1 }]);
});

it.each(["expired", "unreadable"] as const)("refuses an %s authority before starting the bridge", async (kind) => {
	const f = fixture();
	const expiresAt = kind === "expired" ? new Date(Date.now() - 1).toISOString() : "not a time";
	await expect(
		executeNativeCompanyRunnerJob({ ...f.options, authority: { ...f.options.authority, expiresAt } }),
	).rejects.toThrow("Native company authority has expired");
	expect(f.startCompany).not.toHaveBeenCalled();
});

it.each(["runId", "assignmentId", "runnerId"] as const)(
	"refuses an authority whose %s is not the leased job's",
	async (key) => {
		const f = fixture();
		await expect(
			executeNativeCompanyRunnerJob({ ...f.options, authority: { ...f.options.authority, [key]: randomUUID() } }),
		).rejects.toThrow("no fallback");
		expect(f.startCompany).not.toHaveBeenCalled();
	},
);

it("rejects private text disguised as a completion receipt and terminates the boundary", async () => {
	const f = fixture();
	f.startCompany.mockResolvedValue({
		result: Promise.resolve({ ...f.receipt, thinking: "PRIVATE_REASONING" }),
		terminate: f.terminate,
	});
	await expect(executeNativeCompanyRunnerJob(f.options)).rejects.toThrow("private completion receipt");
	expect(f.terminate).toHaveBeenCalledOnce();
});

it("bounds shutdown even if the remote process ignores cancellation", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const cancel = new AbortController();
	f.startCompany.mockResolvedValue({
		result: new Promise(() => {}),
		terminate: vi.fn(async () => new Promise<void>(() => {})),
	});
	const pending = executeNativeCompanyRunnerJob({ ...f.options, signal: cancel.signal }).catch(
		(error: unknown) => error,
	);
	await vi.advanceTimersByTimeAsync(20);
	cancel.abort(new Error("cancelled"));
	await vi.advanceTimersByTimeAsync(10_030);
	expect(await pending).toBeInstanceOf(Error);
});

it("has no wall-clock deadline: a run that takes days completes and records it", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let finish: (value: typeof f.receipt) => void = () => {};
	f.startCompany.mockResolvedValue({
		result: new Promise<typeof f.receipt>((resolve) => {
			finish = resolve;
		}),
		terminate: f.terminate,
	});
	const pending = executeNativeCompanyRunnerJob(f.options);
	await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
	finish(f.receipt);
	const result = await pending;
	expect(result.usage.executionMs).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
	expect(result.usage.limits.wallTimeMs).toBe(Number.MAX_SAFE_INTEGER);
	expect(f.terminate).not.toHaveBeenCalled();
});

it("uses a closed, path-free HTTP execution schema with no copied job payload", async () => {
	const f = fixture();
	const fetcher = vi.fn(async () =>
		Response.json({ schema: "qorpera.native-provider-result/v1", lease_id: f.binding.leaseId, result: f.receipt }),
	);
	const bridge = new HttpNativeProviderComputerBridge("https://native.example/", "b".repeat(43), fetcher, {
		executionBoundary: "virtual_machine",
	});
	await executeNativeCompanyRunnerJob({ ...f.options, bridge });
	const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
	const body = JSON.parse(String(call[1].body));
	expect(body.schema).toBe("qorpera.native-company-execution/v1");
	expect(Object.keys(body).sort()).toEqual(["authority", "job", "schema"]);
	expect(body.job).toEqual({ job_id: f.binding.jobId, attempt_count: 1 });
	expect(JSON.stringify(body)).not.toMatch(/UNTRUSTED_LOCAL_PAYLOAD|canonical|execution_context_path|output_root/);
});
