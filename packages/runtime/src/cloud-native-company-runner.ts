import { isDeepStrictEqual } from "node:util";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { serializeCloudRunnerExecutionUsage } from "@qorpera/cloud-client/cloud-runner-usage";
import type { CloudRunnerJob } from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import { type NativeProviderComputerBridge, parseNativeHarnessResult } from "./cloud-native-provider.ts";
import type { CloudRunnerNativeAuthority } from "./cloud-runner-broker.ts";
import {
	type CloudRunnerExecutionResult,
	type CloudRunnerSandboxLimits,
	resolveCloudRunnerSandboxLimits,
} from "./cloud-runner-sandbox.ts";

/** True when the job was materialized from a wake occurrence (qorpera.wake-run/v1). */
export function isWakeRunJob(job: Pick<CloudRunnerJob, "payload">): boolean {
	const payload = job.payload;
	return (
		payload !== null &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		(payload as { schema?: unknown }).schema === "qorpera.wake-run/v1"
	);
}

/** Executes over cloud-composed context and path effects, never a runner-owned
 * Company File tree. Completion/session binding happen atomically in the cloud.
 */
export async function executeNativeCompanyRunnerJob(options: {
	job: CloudRunnerJob;
	authority: CloudRunnerNativeAuthority;
	refreshAuthority: () => Promise<CloudRunnerNativeAuthority>;
	bridge: NativeProviderComputerBridge;
	limits?: Partial<CloudRunnerSandboxLimits>;
	signal: AbortSignal;
}): Promise<CloudRunnerExecutionResult> {
	const { job, bridge, signal } = options;
	const limits = resolveCloudRunnerSandboxLimits(options.limits);
	signal.throwIfAborted();
	if (
		!bridge.startCompany ||
		job.status !== "leased" ||
		!job.runId ||
		!job.assignmentId ||
		job.jobType !== "agent_turn" ||
		job.requiredCapability !== "agent_turn" ||
		job.runId !== options.authority.runId ||
		job.assignmentId !== options.authority.assignmentId ||
		job.runnerId !== options.authority.runnerId ||
		options.authority.provider !== "openai" ||
		options.authority.nativeHarness !== "codex-cli" ||
		options.authority.authenticationMode !== "native_subscription" ||
		!["virtual_machine", "microvm", "rootless_container"].includes(bridge.executionGuarantees.boundary)
	) {
		throw new Error("Governed native company execution is unavailable; no fallback is permitted");
	}
	const authority = await withCloudDeadline(() => options.refreshAuthority(), 30_000, signal);
	if (
		!isDeepStrictEqual({ ...authority, expiresAt: undefined }, { ...options.authority, expiresAt: undefined }) ||
		!Number.isFinite(Date.parse(authority.expiresAt)) ||
		Date.parse(authority.expiresAt) <= Date.now()
	) {
		throw new Error("Native company authority refresh returned another execution");
	}
	const started = performance.now();
	const processHandle = await withCloudDeadline(
		() =>
			bridge.startCompany!(authority, {
				jobId: job.jobId,
				attemptCount: job.attemptCount,
			}),
		30_000,
		signal,
	);
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new Error("Native company execution exceeded its deadline")),
		limits.wallTimeMs,
	);
	const stopped = AbortSignal.any([signal, timeout.signal]);
	let abort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(stopped.reason);
		stopped.addEventListener("abort", abort, { once: true });
		if (stopped.aborted) abort();
	});
	let completed = false;
	try {
		// Wake runs (runtime Step 3) carry their reply obligations in the cloud wake
		// policy; qorpera_assert_wake_completion enforces them at completion. A
		// silent or forbidden final send is a valid private completion there.
		const receipt = parseNativeHarnessResult(
			await Promise.race([processHandle.result, cancelled]),
			authority.runId,
			job.sessionId !== undefined && !isWakeRunJob(job),
		);
		stopped.throwIfAborted();
		if (receipt.provider_session_id === null) throw new Error("Native company session identity is missing");
		const resultBytes = Buffer.byteLength(JSON.stringify(receipt));
		if (resultBytes > limits.maxResultBytes) throw new Error("Native completion exceeds its byte limit");
		const usage = {
			executionMs: Math.max(1, Math.ceil(performance.now() - started)),
			// These count runner-materialized files, not cloud gateway/model traffic.
			inputBytes: 0,
			outputBytes: 0,
			resultBytes,
			limits: {
				wallTimeMs: limits.wallTimeMs,
				memoryBytes: limits.memoryBytes,
				cpuMillis: Math.ceil(limits.cpuCount * 1000),
				maxPids: limits.maxPids,
				maxInputBytes: limits.maxInputBytes,
				maxOutputBytes: limits.maxOutputBytes,
				maxResultBytes: limits.maxResultBytes,
			},
		};
		if (usage.executionMs > limits.wallTimeMs) throw new Error("Native company execution exceeded its deadline");
		const result: JsonValue = {
			schema: "qorpera.runner-result/v1",
			runtime: "company-path-v1",
			backend: "native-company-runtime",
			native_lease_id: authority.leaseId,
			substrate_version_id: job.substrateVersionId,
			backend_result: receipt,
			output_count: 0,
			output_bytes: 0,
			publication: null,
			usage: serializeCloudRunnerExecutionUsage(usage),
		};
		completed = true;
		return { result, outputFiles: [], outputBytes: 0, usage };
	} finally {
		clearTimeout(timer);
		stopped.removeEventListener("abort", abort);
		if (!completed) {
			// A non-cooperative bridge cannot hold the authority watchdog open.
			await withCloudDeadline(
				() => processHandle.terminate(signal.aborted ? "cancelled" : "deadline_exceeded"),
				10_000,
			).catch(() => undefined);
		}
	}
}
