import { executeNativeCloudRunnerJob, type NativeProviderComputerBridge } from "./cloud-native-provider.ts";
import {
	CloudRunnerBrokerCompanyFilePublisher,
	CloudRunnerBrokerOutputPublisher,
	type CloudRunnerBrokerTransport,
} from "./cloud-runner-broker.ts";
import {
	type CloudRunnerAssignmentAcceptance,
	type CloudRunnerJob,
	cloudRunnerControlRequestStatus,
	type DisposableCloudRunner,
} from "./cloud-runner-control.ts";
import {
	type CloudRunnerExecutionResult,
	type CloudRunnerSandboxBackend,
	type CloudRunnerSandboxLimits,
	type ExecuteCloudRunnerJobOptions,
	executeCloudRunnerJob,
} from "./cloud-runner-sandbox.ts";

const DEFAULT_IDLE_POLL_MS = 2_000;
const DEFAULT_LEASE_RENEWAL_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

export type EphemeralCloudRunnerWorkerResult =
	| { status: "idle" }
	| { status: "completed"; job: CloudRunnerJob }
	| { status: "requeued" | "failed"; job: CloudRunnerJob };

export interface EphemeralCloudRunnerWorkerOptions {
	runner: DisposableCloudRunner;
	brokerTransport: CloudRunnerBrokerTransport;
	backend: CloudRunnerSandboxBackend;
	nativeProviderBridge?: NativeProviderComputerBridge;
	nativeWorkspaceGid?: number;
	platform: string;
	runnerVersion: string;
	temporaryRoot?: string;
	environment?: Readonly<Record<string, string>>;
	limits?: Partial<CloudRunnerSandboxLimits>;
	idlePollMs?: number;
	leaseRenewalMs?: number;
	heartbeatMs?: number;
	now?: () => number;
	retryable?: (error: unknown) => boolean;
	executeJob?: (options: ExecuteCloudRunnerJobOptions) => Promise<CloudRunnerExecutionResult>;
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

function safeFailure(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]")
			.slice(0, 1000)
			.trim() || "Runner execution failed"
	);
}

export function cloudRunnerJobFailureIsRetryable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return !/invalid|inconsistent|outside (?:its|the) immutable|exceeds (?:its|the) byte limit|cannot contain credentials|does not support|failed content verification|changed before publication|required isolation guarantees/i.test(
		message,
	);
}

export class EphemeralCloudRunnerWorker {
	readonly #options: EphemeralCloudRunnerWorkerOptions;
	readonly #idlePollMs: number;
	readonly #leaseRenewalMs: number;
	readonly #heartbeatMs: number;
	readonly #now: () => number;
	readonly #executeJob: (options: ExecuteCloudRunnerJobOptions) => Promise<CloudRunnerExecutionResult>;
	readonly #injectedExecuteJob: boolean;

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
		this.#executeJob = options.executeJob ?? executeCloudRunnerJob;
		this.#injectedExecuteJob = options.executeJob !== undefined;
		if (
			options.nativeWorkspaceGid !== undefined &&
			(!Number.isSafeInteger(options.nativeWorkspaceGid) || options.nativeWorkspaceGid < 1)
		) {
			throw new Error("Native workspace group is invalid");
		}
	}

	async runNext(
		assignment: CloudRunnerAssignmentAcceptance | undefined,
		signal: AbortSignal = new AbortController().signal,
	): Promise<EphemeralCloudRunnerWorkerResult> {
		if (signal.aborted) throw workerStopped();
		const retained = this.#options.runner.leasedJobs();
		if (retained.length > 1) throw new Error("Single-lane ephemeral worker restored multiple active jobs");
		let job: CloudRunnerJob | undefined = retained.at(0);
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
					if (cloudRunnerControlRequestStatus(error) !== 409) throw error;
					await this.#options.runner.discardJobAuthority(job.jobId);
					job = undefined;
				}
			}
		}
		if (job) {
			if (assignment && assignment.jobId !== job.jobId) {
				throw new Error("Runner received an assignment while retained work is unresolved");
			}
			job = await this.#options.runner.renew(job.jobId);
		} else if (assignment) {
			job = await this.#options.runner.acceptAssignment(assignment);
		}
		if (!job) return { status: "idle" };
		return this.#execute(job, signal);
	}

	async run(
		assignments: CloudRunnerAssignmentSource,
		signal: AbortSignal,
		options: { maxAssignments?: number } = {},
	): Promise<void> {
		if (signal.aborted) return;
		const maxAssignments = options.maxAssignments;
		if (maxAssignments !== undefined && (!Number.isSafeInteger(maxAssignments) || maxAssignments < 1)) {
			throw new Error("Worker assignment limit is invalid");
		}
		if (this.#options.runner.snapshot().active) {
			await this.#options.runner.heartbeat();
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

	async #execute(job: CloudRunnerJob, signal: AbortSignal): Promise<EphemeralCloudRunnerWorkerResult> {
		const executionAbort = new AbortController();
		const maintenanceAbort = new AbortController();
		let maintenanceError: unknown;
		let renewNativeAuthority: (() => Promise<void>) | undefined;
		let nativeRenewalInFlight: Promise<void> | undefined;
		const externalAbort = (): void => executionAbort.abort(workerStopped());
		if (signal.aborted) externalAbort();
		else signal.addEventListener("abort", externalAbort, { once: true });
		let nextHeartbeat = this.#now() + this.#heartbeatMs;
		const maintenance = (async () => {
			while (await wait(this.#leaseRenewalMs, maintenanceAbort.signal)) {
				try {
					await this.#options.runner.renew(job.jobId);
					if (renewNativeAuthority) {
						const renewal = renewNativeAuthority();
						nativeRenewalInFlight = renewal;
						try {
							await renewal;
						} finally {
							if (nativeRenewalInFlight === renewal) nativeRenewalInFlight = undefined;
						}
					}
					if (this.#now() >= nextHeartbeat) {
						await this.#options.runner.heartbeat();
						nextHeartbeat = this.#now() + this.#heartbeatMs;
					}
				} catch (error) {
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
			const broker = this.#options.runner.broker(job, this.#options.brokerTransport, executionAbort.signal);
			let execution: CloudRunnerExecutionResult;
			try {
				const shared = {
					job,
					substrate: broker,
					objects: broker.objects,
					outputPublisher: new CloudRunnerBrokerOutputPublisher(broker),
					companyFilePublisher: new CloudRunnerBrokerCompanyFilePublisher(broker),
					...(this.#options.limits ? { limits: this.#options.limits } : {}),
					...(this.#options.environment ? { environment: this.#options.environment } : {}),
					...(this.#options.temporaryRoot ? { temporaryRoot: this.#options.temporaryRoot } : {}),
					signal: executionAbort.signal,
				};
				if (this.#injectedExecuteJob) {
					await this.#options.backend.prepare?.();
					execution = await this.#executeJob({
						...shared,
						backend: this.#options.backend,
						modelBroker: broker,
					});
				} else {
					const description = await broker.describe();
					if (description.sponsor.authenticationMode === "native_subscription") {
						if (!this.#options.nativeProviderBridge) {
							throw new Error("Native subscription execution bridge is not configured");
						}
						const authority = await broker.acquireNativeAuthority();
						renewNativeAuthority = async () => {
							await broker.renewNativeAuthority();
						};
						try {
							execution = await executeNativeCloudRunnerJob({
								...shared,
								authority,
								refreshAuthority: () => broker.renewNativeAuthority(),
								bridge: this.#options.nativeProviderBridge,
								nativeBroker: broker,
								...(this.#options.nativeWorkspaceGid !== undefined
									? { nativeWorkspaceGid: this.#options.nativeWorkspaceGid }
									: {}),
							});
						} finally {
							renewNativeAuthority = undefined;
							await nativeRenewalInFlight?.catch(() => undefined);
							await broker.releaseNativeAuthority(executionAbort.signal.aborted ? "revoked" : "released");
						}
					} else {
						await this.#options.backend.prepare?.();
						execution = await this.#executeJob({
							...shared,
							backend: this.#options.backend,
							modelBroker: broker,
						});
					}
				}
			} catch (error) {
				await stopMaintenance();
				if (maintenanceError) throw maintenanceError;
				if (signal.aborted) throw workerStopped();
				const failed = await this.#options.runner.fail(
					job.jobId,
					safeFailure(error),
					(this.#options.retryable ?? cloudRunnerJobFailureIsRetryable)(error),
				);
				return { status: failed.status === "queued" ? "requeued" : "failed", job: failed };
			}
			await stopMaintenance();
			if (maintenanceError) throw maintenanceError;
			if (signal.aborted) throw workerStopped();
			return {
				status: "completed",
				job: await this.#options.runner.complete(job.jobId, execution.result, execution.outputSnapshotId),
			};
		} finally {
			await stopMaintenance();
			signal.removeEventListener("abort", externalAbort);
		}
	}
}
