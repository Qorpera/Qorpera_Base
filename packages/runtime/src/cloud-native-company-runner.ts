import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	CLOUD_RUNNER_NO_WALL_TIME_MS,
	serializeCloudRunnerExecutionUsage,
} from "@qorpera/cloud-client/cloud-runner-usage";
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
 *
 * `authority` is the lease the runner has just acquired: acquisition runs every check a
 * renewal runs and sets the same expiry (now plus the same lease length), so the run starts
 * on it without renewing it first. The worker's maintenance loop renews it from then on.
 */
export async function executeNativeCompanyRunnerJob(options: {
	job: CloudRunnerJob;
	authority: CloudRunnerNativeAuthority;
	bridge: NativeProviderComputerBridge;
	/** The job's lease token, for the host's calls through qorpera_native_host_call (G2-2). */
	leaseToken?: string;
	limits?: Partial<CloudRunnerSandboxLimits>;
	signal: AbortSignal;
}): Promise<CloudRunnerExecutionResult> {
	const { job, authority, bridge, signal } = options;
	const limits = resolveCloudRunnerSandboxLimits(options.limits);
	signal.throwIfAborted();
	if (
		!bridge.startCompany ||
		job.status !== "leased" ||
		!job.runId ||
		!job.assignmentId ||
		job.jobType !== "agent_turn" ||
		job.requiredCapability !== "agent_turn" ||
		job.runId !== authority.runId ||
		job.assignmentId !== authority.assignmentId ||
		job.runnerId !== authority.runnerId ||
		authority.provider !== "openai" ||
		authority.nativeHarness !== "codex-cli" ||
		authority.authenticationMode !== "native_subscription" ||
		!["virtual_machine", "microvm", "rootless_container"].includes(bridge.executionGuarantees.boundary)
	) {
		throw new Error("Governed native company execution is unavailable; no fallback is permitted");
	}
	if (!Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.now()) {
		throw new Error("Native company authority has expired");
	}
	const started = performance.now();
	const processHandle = await withCloudDeadline(
		() =>
			bridge.startCompany!(authority, {
				jobId: job.jobId,
				attemptCount: job.attemptCount,
				...(options.leaseToken !== undefined ? { leaseToken: options.leaseToken } : {}),
			}),
		30_000,
		signal,
	);
	// A company run has no wall-clock deadline (founder, 2026-09-24): it ends when
	// it completes, is cancelled, or loses its job lease.
	const stopped = signal;
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
				wallTimeMs: CLOUD_RUNNER_NO_WALL_TIME_MS,
				memoryBytes: limits.memoryBytes,
				cpuMillis: Math.ceil(limits.cpuCount * 1000),
				maxPids: limits.maxPids,
				maxInputBytes: limits.maxInputBytes,
				maxOutputBytes: limits.maxOutputBytes,
				maxResultBytes: limits.maxResultBytes,
			},
		};
		const result: JsonValue = {
			schema: "qorpera.runner-result/v1",
			runtime: "company-path-v1",
			backend: "native-company-runtime",
			native_lease_id: authority.leaseId,
			// A folder-v2 run has no substrate (folder core C3, P23): completion matches null against its job's null.
			substrate_version_id: job.substrateVersionId ?? null,
			backend_result: receipt,
			output_count: 0,
			output_bytes: 0,
			publication: null,
			usage: serializeCloudRunnerExecutionUsage(usage),
		};
		completed = true;
		return { result, outputFiles: [], outputBytes: 0, usage };
	} finally {
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
