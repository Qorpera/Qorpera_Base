import { CloudRunnerBrokerOutputPublisher, type CloudRunnerBrokerTransport } from "./cloud-runner-broker.ts";
import type { CloudRunnerJob, DisposableCloudRunner } from "./cloud-runner-control.ts";
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
	}

	async runNext(signal: AbortSignal = new AbortController().signal): Promise<EphemeralCloudRunnerWorkerResult> {
		if (signal.aborted) throw workerStopped();
		const retained = this.#options.runner.leasedJobs();
		if (retained.length > 1) throw new Error("Single-lane ephemeral worker restored multiple active jobs");
		let job: CloudRunnerJob | undefined = retained.at(0);
		if (job) {
			const pendingCompletion = this.#options.runner.pendingCompletion(job.jobId);
			if (pendingCompletion) {
				return { status: "completed", job: await this.#options.runner.complete(job.jobId, pendingCompletion) };
			}
		}
		await this.#options.backend.prepare?.();
		if (job && Date.parse(job.leaseExpiresAt as string) <= this.#now()) {
			await this.#options.runner.discardJobAuthority(job.jobId);
			job = undefined;
		}
		if (job) job = await this.#options.runner.renew(job.jobId);
		else job = await this.#options.runner.claim();
		if (!job) return { status: "idle" };
		return this.#execute(job, signal);
	}

	async run(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		if (this.#options.runner.snapshot().active) {
			await this.#options.runner.heartbeat();
		} else {
			await this.#options.backend.prepare?.();
			await this.#options.runner.activate(this.#options.platform, this.#options.runnerVersion);
		}
		let nextHeartbeat = this.#now() + this.#heartbeatMs;
		while (!signal.aborted) {
			if (this.#now() >= nextHeartbeat) {
				await this.#options.runner.heartbeat();
				nextHeartbeat = this.#now() + this.#heartbeatMs;
			}
			const result = await this.runNext(signal);
			if (signal.aborted) return;
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
		const externalAbort = (): void => executionAbort.abort(workerStopped());
		if (signal.aborted) externalAbort();
		else signal.addEventListener("abort", externalAbort, { once: true });
		let nextHeartbeat = this.#now() + this.#heartbeatMs;
		const maintenance = (async () => {
			while (await wait(this.#leaseRenewalMs, maintenanceAbort.signal)) {
				try {
					await this.#options.runner.renew(job.jobId);
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
			const broker = this.#options.runner.broker(job, this.#options.brokerTransport);
			let execution: CloudRunnerExecutionResult;
			try {
				execution = await this.#executeJob({
					job,
					substrate: broker,
					objects: broker.objects,
					backend: this.#options.backend,
					outputPublisher: new CloudRunnerBrokerOutputPublisher(broker),
					...(this.#options.limits ? { limits: this.#options.limits } : {}),
					...(this.#options.environment ? { environment: this.#options.environment } : {}),
					...(this.#options.temporaryRoot ? { temporaryRoot: this.#options.temporaryRoot } : {}),
					signal: executionAbort.signal,
				});
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
			return { status: "completed", job: await this.#options.runner.complete(job.jobId, execution.result) };
		} finally {
			await stopMaintenance();
			signal.removeEventListener("abort", externalAbort);
		}
	}
}
