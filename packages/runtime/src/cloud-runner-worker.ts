import { CloudRequestTimeoutError, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	type CloudRunnerAssignmentAcceptance,
	type CloudRunnerJob,
	cloudRunnerControlRequestStatus,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import { executeNativeCompanyRunnerJob } from "./cloud-native-company-runner.ts";
import type { NativeProviderComputerBridge } from "./cloud-native-provider.ts";
import {
	CloudRunnerBrokerRequestError,
	type CloudRunnerBrokerTransport,
	type CloudRunnerStart,
	NATIVE_AUTHORITY_LEASE_SECONDS,
} from "./cloud-runner-broker.ts";
import type { DisposableCloudRunner } from "./cloud-runner-control.ts";
import type { CloudRunnerExecutionResult, CloudRunnerSandboxLimits } from "./cloud-runner-sandbox.ts";

const DEFAULT_IDLE_POLL_MS = 2_000;
const DEFAULT_LEASE_RENEWAL_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

export type EphemeralCloudRunnerWorkerResult =
	| { status: "idle" }
	| { status: "completed"; job: CloudRunnerJob }
	| { status: "requeued" | "failed"; job: CloudRunnerJob };

/** The company lane's executor: executeNativeCompanyRunnerJob, or a test's stand-in for it. */
export type CloudRunnerCompanyExecutor = typeof executeNativeCompanyRunnerJob;

export interface EphemeralCloudRunnerWorkerOptions {
	runner: DisposableCloudRunner;
	brokerTransport: CloudRunnerBrokerTransport;
	nativeProviderBridge?: NativeProviderComputerBridge;
	platform: string;
	runnerVersion: string;
	limits?: Partial<CloudRunnerSandboxLimits>;
	idlePollMs?: number;
	leaseRenewalMs?: number;
	heartbeatMs?: number;
	now?: () => number;
	retryable?: (error: unknown) => boolean;
	executeJob?: CloudRunnerCompanyExecutor;
}

export interface CloudRunnerAssignmentSource {
	next(signal: AbortSignal): Promise<CloudRunnerAssignmentAcceptance | undefined>;
}

function requiredInterval(value: number, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} is outside the supported range`);
	}
	return value;
}

function wait(delayMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolveWait) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolveWait(true);
		}, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			resolveWait(false);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function workerStopped(): Error {
	return new Error("Ephemeral runner worker stopped");
}

/* A lost or late answer to a native lease renewal: the broker's transport gave up on one (no answer, 429, 502, 503 or
 * 504), or the renewal outlived its deadline here. A refusal, or an answer naming another lease, is not one. */
function nativeRenewalUnanswered(error: unknown): boolean {
	return error instanceof CloudRunnerBrokerRequestError ? error.transient : error instanceof CloudRequestTimeoutError;
}

/* A lost or late answer to a heartbeat: 429 or 5xx, the call's deadline, or no answer at all (fetch rejects with a
 * TypeError). Unlike the lease's renewal, a failure without a status is not enough: a heartbeat's answer that the
 * runner is no longer active, or a local store that failed, has none either. */
function heartbeatUnanswered(error: unknown): boolean {
	const status = cloudRunnerControlRequestStatus(error);
	if (status !== undefined) return status === 429 || status >= 500;
	return error instanceof CloudRequestTimeoutError || error instanceof TypeError;
}

function safeFailure(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]")
			.slice(0, 1000)
			.trim() || "Runner execution failed"
	);
}

export function cloudRunnerJobFailureIsRetryable(error: unknown): boolean {
	// A provider's fixed code ("[code=…]") never changes whether a failure retries.
	const message = (error instanceof Error ? error.message : String(error)).replace(/ \[code=[A-Z0-9_:]{1,85}\]$/, "");
	return !/invalid|inconsistent|outside (?:its|the) immutable|exceeds (?:its|the) byte limit|cannot contain credentials|does not support|failed content verification|changed before publication|required isolation guarantees/i.test(
		message,
	);
}

/** A failure that is safe to try again from the start, and is tried again (the 21 October 2026 amendment, item 7): the
 * native host timed out reading the run's context or composing its prompt, before the run's start was recorded and
 * before any model request or tool call. The database still decides: it queues the job again only while nothing of the
 * attempt is durable and fewer than eight attempts were made, as for any retryable failure. Any other failure is not
 * retried here: once execution starts, a lost answer does not prove that nothing happened. */
const RETRYABLE_BEFORE_START =
	/ \[code=NATIVE_(?:COMPANY_CONTEXT|WAKE_ENVELOPE|CONNECTOR_TOOLS|PROMPT_COMPOSITION):TIMEOUT\]$/;
export function cloudRunnerJobFailureBeforeStartIsRetryable(error: unknown): boolean {
	return error instanceof Error && RETRYABLE_BEFORE_START.test(error.message);
}

export class EphemeralCloudRunnerWorker {
	readonly #options: EphemeralCloudRunnerWorkerOptions;
	readonly #idlePollMs: number;
	readonly #leaseRenewalMs: number;
	readonly #heartbeatMs: number;
	readonly #now: () => number;
	readonly #executeJob: CloudRunnerCompanyExecutor;
	#running = false;

	constructor(options: EphemeralCloudRunnerWorkerOptions) {
		if (
			!options.platform.trim() ||
			options.platform.length > 80 ||
			/[\0\r\n]/.test(options.platform) ||
			!options.runnerVersion.trim() ||
			options.runnerVersion.length > 80 ||
			/[\0\r\n]/.test(options.runnerVersion)
		) {
			throw new Error("Ephemeral runner worker identity is invalid");
		}
		this.#options = options;
		this.#idlePollMs = requiredInterval(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS, "Worker idle poll", 10, 60_000);
		this.#leaseRenewalMs = requiredInterval(
			options.leaseRenewalMs ?? DEFAULT_LEASE_RENEWAL_MS,
			"Worker lease renewal",
			10,
			90_000,
		);
		this.#heartbeatMs = requiredInterval(
			options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
			"Worker heartbeat",
			10,
			10 * 60_000,
		);
		this.#now = options.now ?? Date.now;
		this.#executeJob = options.executeJob ?? executeNativeCompanyRunnerJob;
	}

	async runNext(
		assignment: CloudRunnerAssignmentAcceptance | undefined,
		signal: AbortSignal = new AbortController().signal,
	): Promise<EphemeralCloudRunnerWorkerResult> {
		if (this.#running) throw new Error("Single-lane worker is already executing");
		this.#running = true;
		try {
			return await this.#runNext(assignment, signal);
		} finally {
			this.#running = false;
		}
	}

	async #runNext(
		assignment: CloudRunnerAssignmentAcceptance | undefined,
		signal: AbortSignal,
	): Promise<EphemeralCloudRunnerWorkerResult> {
		if (signal.aborted) throw workerStopped();
		const retained = this.#options.runner.leasedJobs();
		if (retained.length > 1) throw new Error("Single-lane ephemeral worker restored multiple active jobs");
		let job: CloudRunnerJob | undefined = retained.at(0);
		let start: CloudRunnerStart | undefined;
		if (job && Date.parse(job.leaseExpiresAt as string) <= this.#now()) {
			await this.#options.runner.discardJobAuthority(job.jobId);
			job = undefined;
		}
		if (job) {
			const pendingCompletion = this.#options.runner.stagedCompletion(job.jobId);
			if (pendingCompletion) {
				try {
					return {
						status: "completed",
						job: await this.#options.runner.complete(
							job.jobId,
							pendingCompletion.result,
							pendingCompletion.outputSnapshotId,
						),
					};
				} catch (error) {
					if (![401, 403, 409].includes(cloudRunnerControlRequestStatus(error) ?? 0)) throw error;
					await this.#options.runner.discardJobAuthority(job.jobId);
					job = undefined;
				}
			}
		}
		if (job) {
			const failure = this.#options.runner.stagedFailure(job.jobId);
			if (failure) {
				try {
					const failed = await this.#options.runner.fail(job.jobId, failure.error, failure.retryable);
					return { status: failed.status === "queued" ? "requeued" : "failed", job: failed };
				} catch (error) {
					if (![401, 403, 409].includes(cloudRunnerControlRequestStatus(error) ?? 0)) throw error;
					await this.#options.runner.discardJobAuthority(job.jobId);
					job = undefined;
				}
			}
		}
		if (job && this.#options.runner.executionStarted(job.jobId)) {
			await this.#options.runner.discardJobAuthority(job.jobId, "interrupted");
			job = undefined;
		}
		if (job) {
			if (assignment && assignment.jobId !== job.jobId) {
				throw new Error("Runner received an assignment while retained work is unresolved");
			}
			job = await this.#options.runner.renew(job.jobId);
		} else if (assignment) {
			// One round trip: the acceptance also reads the description and, for a runner that can
			// execute native subscriptions, acquires the native authority the broker would ask for.
			({ job, start } = await this.#options.runner.startAssignment(
				assignment,
				this.#options.nativeProviderBridge ? NATIVE_AUTHORITY_LEASE_SECONDS : undefined,
			));
		}
		if (!job) return { status: "idle" };
		return this.#execute(job, signal, start);
	}

	async run(
		assignments: CloudRunnerAssignmentSource,
		signal: AbortSignal,
		/** `activated`: the caller activated this runner just before; its session is fresh. */
		options: { maxAssignments?: number; activated?: boolean } = {},
	): Promise<void> {
		if (signal.aborted) return;
		const maxAssignments = options.maxAssignments;
		if (maxAssignments !== undefined && (!Number.isSafeInteger(maxAssignments) || maxAssignments < 1)) {
			throw new Error("Worker assignment limit is invalid");
		}
		if (this.#options.runner.snapshot().active) {
			if (!options.activated) await this.#options.runner.heartbeat();
		} else {
			await this.#options.runner.activate(this.#options.platform, this.#options.runnerVersion);
		}
		let nextHeartbeat = this.#now() + this.#heartbeatMs;
		let handledAssignments = 0;
		while (!signal.aborted) {
			if (this.#now() >= nextHeartbeat) {
				await this.#options.runner.heartbeat();
				nextHeartbeat = this.#now() + this.#heartbeatMs;
			}
			const retained = this.#options.runner.leasedJobs().length > 0;
			const assignment = retained ? undefined : await assignments.next(signal);
			if (signal.aborted) return;
			const result = await this.runNext(assignment, signal);
			if (signal.aborted) return;
			if (result.status !== "idle") {
				handledAssignments++;
				if (maxAssignments !== undefined && handledAssignments >= maxAssignments) return;
			}
			if (result.status === "idle" || result.status === "requeued" || result.status === "failed") {
				const untilHeartbeat = Math.max(10, nextHeartbeat - this.#now());
				if (!(await wait(Math.min(this.#idlePollMs, untilHeartbeat), signal))) return;
			}
		}
	}

	async #execute(
		job: CloudRunnerJob,
		signal: AbortSignal,
		start?: CloudRunnerStart,
	): Promise<EphemeralCloudRunnerWorkerResult> {
		const executionAbort = new AbortController();
		const maintenanceAbort = new AbortController();
		let maintenanceError: unknown;
		let renewNativeAuthority: (() => Promise<void>) | undefined;
		let nativeRenewalInFlight: Promise<void> | undefined;
		/* When the native lease ends, as its acquisition or last renewal answered; none while the run is not executing.
		 * The run's execution stops then too, so a host that holds its authority through an outage never goes past it
		 * (WB-001, 28 Oct 2026). */
		let nativeDeadline = Number.POSITIVE_INFINITY;
		// A heartbeat whose answer is late: the next round waits for it rather than rotating the session token twice.
		let heartbeatInFlight: Promise<unknown> | undefined;
		const externalAbort = (): void => {
			executionAbort.abort(workerStopped());
			maintenanceAbort.abort();
		};
		if (signal.aborted) externalAbort();
		else signal.addEventListener("abort", externalAbort, { once: true });
		let nextHeartbeat = this.#now() + this.#heartbeatMs;
		let leaseDeadline = Date.parse(job.leaseExpiresAt ?? "");
		if (!Number.isFinite(leaseDeadline)) throw new Error("Runner execution requires a finite lease deadline");
		let observedTime = this.#now();
		let leaseTimer: ReturnType<typeof setTimeout> | undefined;
		const sessionDeadline = (): number => Date.parse(this.#options.runner.snapshot().sessionExpiresAt ?? "");
		const armDeadline = (): void => {
			if (leaseTimer) clearTimeout(leaseTimer);
			const now = this.#now();
			const remaining = now < observedTime ? 0 : Math.min(leaseDeadline, sessionDeadline(), nativeDeadline) - now;
			observedTime = now;
			const expire = (): void => {
				maintenanceError = new Error("Runner execution authority expired; outcome requires reconciliation");
				executionAbort.abort(maintenanceError);
				maintenanceAbort.abort();
			};
			if (!Number.isFinite(remaining) || remaining <= 0) expire();
			else leaseTimer = setTimeout(expire, remaining);
		};
		armDeadline();
		const maintenance = (async () => {
			while (await wait(this.#leaseRenewalMs, maintenanceAbort.signal)) {
				try {
					/* One slow or shed control plane response must not abort a
					 * healthy execution mid-flight; platform incidents last
					 * minutes, so keep retrying transient renewal failures
					 * until the lease itself is nearly gone rather than for a
					 * fixed attempt count. Only a definitive rejection or the
					 * lease's own expiry treats the lease as lost. */
					for (;;) {
						try {
							const renewed = await withCloudDeadline(
								() => this.#options.runner.renew(job.jobId),
								Math.max(1, Math.min(30_000, leaseDeadline - this.#now())),
								maintenanceAbort.signal,
							);
							leaseDeadline = Date.parse(renewed.leaseExpiresAt ?? "") || leaseDeadline;
							armDeadline();
							break;
						} catch (renewError) {
							const status = cloudRunnerControlRequestStatus(renewError);
							const transient = status === undefined || status === 429 || status >= 500;
							if (!transient || maintenanceAbort.signal.aborted || this.#now() + 10_000 >= leaseDeadline) {
								throw renewError;
							}
							if (!(await wait(10_000, maintenanceAbort.signal))) throw renewError;
						}
					}
					/* The native lease the same way (WB-001, 28 Oct 2026): a lost or late answer is asked again every
					 * 10 s until the native lease or the job's is 10 s from its end, so a short control-plane outage
					 * does not stop the run. A refusal, or either lease's end, still does. */
					for (;;) {
						const renew = renewNativeAuthority;
						// No native lease, or the run ended meanwhile and its release follows.
						if (!renew) break;
						const renewal = withCloudDeadline(
							() => renew(),
							Math.max(1, Math.min(30_000, leaseDeadline - this.#now(), nativeDeadline - this.#now())),
							maintenanceAbort.signal,
						);
						nativeRenewalInFlight = renewal;
						try {
							try {
								await renewal;
							} finally {
								if (nativeRenewalInFlight === renewal) nativeRenewalInFlight = undefined;
							}
							break;
						} catch (renewError) {
							if (
								!nativeRenewalUnanswered(renewError) ||
								maintenanceAbort.signal.aborted ||
								!(this.#now() + 10_000 < Math.min(leaseDeadline, nativeDeadline))
							) {
								throw renewError;
							}
							if (!(await wait(10_000, maintenanceAbort.signal))) throw renewError;
						}
					}
					if (this.#now() >= nextHeartbeat) {
						try {
							await withCloudDeadline(
								() => {
									heartbeatInFlight ??= this.#options.runner.heartbeat().finally(() => {
										heartbeatInFlight = undefined;
									});
									return heartbeatInFlight;
								},
								Math.max(1, Math.min(30_000, leaseDeadline - this.#now())),
								maintenanceAbort.signal,
							);
							nextHeartbeat = this.#now() + this.#heartbeatMs;
							armDeadline();
						} catch (heartbeatError) {
							/* A lost or late heartbeat stays due and is asked again next round, without holding up
							 * either renewal: one is due long before the runner's session ends. A refusal, or a lease
							 * or session that ends within 10 s of the next round, still stops the run. */
							if (
								!heartbeatUnanswered(heartbeatError) ||
								maintenanceAbort.signal.aborted ||
								!(this.#now() + this.#leaseRenewalMs + 10_000 < Math.min(leaseDeadline, sessionDeadline()))
							) {
								throw heartbeatError;
							}
						}
					}
				} catch (error) {
					if (maintenanceAbort.signal.aborted) return;
					maintenanceError = error;
					executionAbort.abort(error);
					return;
				}
			}
		})();
		let maintenanceStopped = false;
		const stopMaintenance = async (): Promise<void> => {
			if (maintenanceStopped) return;
			maintenanceStopped = true;
			maintenanceAbort.abort();
			await maintenance;
		};
		try {
			executionAbort.signal.throwIfAborted();
			await this.#options.runner.markExecutionStarted(job.jobId);
			executionAbort.signal.throwIfAborted();
			const broker = this.#options.runner.broker(job, this.#options.brokerTransport, executionAbort.signal, start);
			let execution: CloudRunnerExecutionResult;
			try {
				// One lane: a native company run (folder-v2). The broker's description admits no other run (C-R8), and a
				// run that is not native is refused here, never downgraded.
				const description = await broker.describe();
				if (description.sponsor.authenticationMode !== "native_subscription") {
					throw new Error(
						"Governed company execution requires the native cloud runtime; no fallback is permitted",
					);
				}
				const bridge = this.#options.nativeProviderBridge;
				if (!bridge) throw new Error("Native subscription execution bridge is not configured");
				const authority = await broker.acquireNativeAuthority();
				nativeDeadline = Date.parse(authority.expiresAt);
				armDeadline();
				renewNativeAuthority = async () => {
					nativeDeadline = Date.parse((await broker.renewNativeAuthority()).expiresAt);
					armDeadline();
				};
				try {
					execution = await this.#executeJob({
						job,
						authority,
						bridge,
						leaseToken: this.#options.runner.nativeHostLeaseToken(job.jobId),
						...(this.#options.limits ? { limits: this.#options.limits } : {}),
						signal: executionAbort.signal,
					});
					// Retain the returned result before the completion, whose response can be lost
					// independently of successful work.
					await this.#options.runner.stageCompletion(job.jobId, execution.result, execution.outputSnapshotId);
				} finally {
					renewNativeAuthority = undefined;
					await nativeRenewalInFlight?.catch(() => undefined);
					// Execution is over; the completion that follows checks the native lease itself.
					nativeDeadline = Number.POSITIVE_INFINITY;
					if (!executionAbort.signal.aborted) armDeadline();
					// Governed completion validates the still-live native lease and releases it
					// atomically with the durable completion receipt; a run with no staged
					// completion releases it here.
					if (!this.#options.runner.stagedCompletion(job.jobId)) {
						await withCloudDeadline(
							() => broker.releaseNativeAuthority(executionAbort.signal.aborted ? "revoked" : "released"),
							Math.max(1, Math.min(30_000, leaseDeadline - this.#now())),
						);
					}
				}
			} catch (error) {
				await stopMaintenance();
				if (maintenanceError) throw maintenanceError;
				if (signal.aborted) throw workerStopped();
				if (this.#options.runner.stagedCompletion(job.jobId)) throw error;
				const failed = await this.#options.runner.fail(
					job.jobId,
					safeFailure(error),
					// A network error after execution started does not prove no external effects occurred; a timeout while the
					// run's context or prompt was composed comes before any of it.
					(this.#options.retryable ?? cloudRunnerJobFailureBeforeStartIsRetryable)(error),
				);
				return { status: failed.status === "queued" ? "requeued" : "failed", job: failed };
			}
			await stopMaintenance();
			if (maintenanceError) throw maintenanceError;
			if (signal.aborted) throw workerStopped();
			return {
				status: "completed",
				job: await withCloudDeadline(
					() => this.#options.runner.complete(job.jobId, execution.result, execution.outputSnapshotId),
					Math.max(1, Math.min(30_000, leaseDeadline - this.#now())),
					executionAbort.signal,
				),
			};
		} finally {
			if (leaseTimer) clearTimeout(leaseTimer);
			await stopMaintenance();
			signal.removeEventListener("abort", externalAbort);
		}
	}
}
