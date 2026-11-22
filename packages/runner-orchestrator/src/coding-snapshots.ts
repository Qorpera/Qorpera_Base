import { isUuid } from "@qorpera/contracts";
import type { CodingSetup, CodingSetupStep } from "./coding-setup.ts";
import type { LxdClient, LxdInstanceExecPipeClient, LxdSnapshotImageClient, LxdStandbyClient } from "./lxd-client.ts";

export const CODING_SNAPSHOT_RPCS = [
	"qorpera_begin_coding_snapshot_build",
	"qorpera_renew_coding_snapshot_build",
	"qorpera_finish_coding_snapshot_build",
	"qorpera_list_coding_snapshots",
	"qorpera_record_coding_snapshot_removed",
	"qorpera_claim_coding_snapshot_build",
	"qorpera_complete_coding_snapshot_build",
	"qorpera_fail_coding_snapshot_build",
	"qorpera_sweep_coding_snapshots",
	"qorpera_fallback_coding_machine_base_image",
] as const;

export const CODING_SNAPSHOT_LOG_MAX_JSON_BYTES = 65536;
export const CODING_SNAPSHOT_BUILDER_VM_PREFIX = "qorpera-coding-snap-";
export const CODING_SNAPSHOT_DEFAULT_LEASE_SECONDS = 120;
export const CODING_SNAPSHOT_DEFAULT_TTL_SECONDS = 604800;
export const CODING_SNAPSHOT_DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;
export const CODING_SNAPSHOT_DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
export const CODING_SNAPSHOT_DEFAULT_HOUSEKEEP_INTERVAL_MS = 5 * 60_000;
export const CODING_SNAPSHOT_MAX_QUEUE_SIZE = 64;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const BUILDER_SRC_DIR = "/tmp/qorpera-snapshot-src";
const PROTECTED_BUILDER_ENV = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"QORPERA_SECRET_BROKER_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"AWS_SECRET_ACCESS_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
]);

const SCRUB_BUILDER_SCRIPT = [
	"set -eu",
	`rm -rf ${BUILDER_SRC_DIR}`,
	"find /tmp /var/tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true",
	"rm -f /root/.bash_history /root/.zsh_history /root/.sh_history /root/.netrc /root/.git-credentials /root/.ssh/known_hosts 2>/dev/null || true",
	'for d in /home/*; do [ -d "$d" ] || continue; rm -f "$d/.bash_history" "$d/.zsh_history" "$d/.sh_history" "$d/.netrc" "$d/.git-credentials" "$d/.ssh/known_hosts" 2>/dev/null || true; done',
	"rm -rf /run/qorpera-* /var/lib/cloud/instances/* /var/lib/dbus/machine-id 2>/dev/null || true",
	"truncate -s 0 /etc/machine-id 2>/dev/null || : > /etc/machine-id",
	"sync",
].join("\n");

export interface CodingSnapshotRpcControl {
	rpc(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export type CodingSnapshotBuilderLxdClient = Pick<
	LxdClient,
	"getInstance" | "createInstance" | "setInstancePower" | "pushInstanceFile" | "deleteInstance"
> &
	LxdInstanceExecPipeClient &
	LxdSnapshotImageClient &
	Partial<Pick<LxdStandbyClient, "setInstancePowerStateful" | "listInstances">>;

export interface CodingSnapshotVmPolicy {
	readonly project: string;
	readonly imageFingerprint: string;
	readonly storagePool: string;
	readonly cpus: number;
	readonly memoryBytes: number;
	readonly rootDiskBytes: number;
	readonly network?: string;
}

export interface CodingSnapshotBuildRequest {
	readonly workerId: string;
	readonly leaseToken: string;
	readonly environmentId: string;
	readonly memberUserId: string;
	readonly repository: string;
	readonly setupDigest: string;
	readonly commitSha: string;
	readonly setupSpec: CodingSetup;
	readonly readArchive?: (signal: AbortSignal) => Promise<Buffer | null>;
}

export type CodingSnapshotBuildOutcome =
	| { readonly state: "current"; readonly snapshotImageFingerprint: string | null }
	| { readonly state: "waiting"; readonly waitingUntil: string | null }
	| { readonly state: "failed"; readonly code: string; readonly buildId: string | null; readonly log: string | null }
	| { readonly state: "abandoned"; readonly code: string; readonly buildId: string | null }
	| {
			readonly state: "ready";
			readonly buildId: string;
			readonly imageFingerprint: string;
			readonly imageBytes: number;
			readonly expiresAt: string | null;
	  };

export interface CodingSnapshotSweepResult {
	readonly abandonedBuilds: number;
	readonly retiredSnapshots: number;
	readonly prunedImages: readonly string[];
	readonly orphanImagesDeleted: readonly string[];
	readonly orphanVmsDeleted: readonly string[];
}

export interface CodingSnapshotBuilderOptions {
	readonly control: CodingSnapshotRpcControl;
	readonly lxd: CodingSnapshotBuilderLxdClient;
	readonly owner: string;
	readonly machineIdSha256: string;
	readonly vmPolicy: CodingSnapshotVmPolicy;
	readonly builderNetwork?: string | null;
	readonly builderCpus?: number;
	readonly builderMemoryBytes?: number;
	readonly builderRootDiskBytes?: number;
	readonly leaseSeconds?: number;
	readonly ttlSeconds?: number;
	readonly buildTimeoutMs?: number;
	readonly stepTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
	readonly readyPollMs?: number;
	readonly publishWaitSeconds?: number;
	readonly compressionAlgorithm?: string;
	readonly cleanupTimeoutMs?: number;
	readonly maxQueueSize?: number;
	readonly redact?: (text: string) => string;
	readonly report?: (event: Record<string, unknown>) => void;
}

interface ClaimedBuild {
	readonly buildId: string;
	readonly leaseToken: string;
	readonly leaseUntil: string;
	readonly baseImageFingerprint: string;
	readonly repository: string;
	readonly setupDigest: string;
	readonly commitSha: string;
	readonly ttlSeconds: number | null;
}

type ClaimDecision =
	| { readonly state: "current"; readonly snapshotImageFingerprint: string | null }
	| { readonly state: "waiting"; readonly waitingUntil: string | null }
	| { readonly state: "failed"; readonly buildId: string | null; readonly code: string; readonly log: string | null }
	| { readonly state: "claimed"; readonly build: ClaimedBuild };

export function codingSnapshotLog(raw: string, redact?: (text: string) => string): string {
	const cleaned = (redact ? redact(raw) : raw).replaceAll("\0", "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
	if (jsonStringPayloadBytes(cleaned) <= CODING_SNAPSHOT_LOG_MAX_JSON_BYTES) return cleaned;
	const prefix = "...[truncated]\n";
	const budget = CODING_SNAPSHOT_LOG_MAX_JSON_BYTES - jsonStringPayloadBytes(prefix);
	let low = 0;
	let high = cleaned.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (jsonStringPayloadBytes(cleaned.slice(mid)) <= budget) high = mid;
		else low = mid + 1;
	}
	return `${prefix}${cleaned.slice(low)}`;
}

function jsonStringPayloadBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_INVALID`);
	return value as Record<string, unknown>;
}

function buildVmName(buildId: string): string {
	return `${CODING_SNAPSHOT_BUILDER_VM_PREFIX}${buildId.replaceAll("-", "").slice(0, 24)}`;
}

function queueKey(request: CodingSnapshotBuildRequest, baseImageFingerprint: string): string {
	return [
		request.environmentId,
		request.memberUserId,
		request.repository.toLowerCase(),
		request.setupDigest,
		request.commitSha,
		baseImageFingerprint,
	].join(":");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function filteredSetupEnv(setupSpec: CodingSetup): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(setupSpec.containerEnv)) {
		if (PROTECTED_BUILDER_ENV.has(key)) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) continue;
		env[key] = value;
	}
	for (const [key, value] of Object.entries(setupSpec.remoteEnv)) {
		if (PROTECTED_BUILDER_ENV.has(key)) continue;
		if (value === null) {
			delete env[key];
			continue;
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) continue;
		env[key] = value;
	}
	return env;
}

function failureCodeFromError(error: unknown): string {
	if (error instanceof SnapshotStepFailure) return error.code;
	if (error instanceof Error) {
		const normalized = error.message
			.toUpperCase()
			.replace(/[^A-Z0-9_:]/g, "_")
			.slice(0, 80);
		if (/^[A-Z][A-Z0-9_:]{0,119}$/.test(normalized)) return normalized;
	}
	return "SNAPSHOT_BUILD_FAILED";
}

class SnapshotStepFailure extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

interface QueuedBuild {
	readonly key: string;
	readonly request: CodingSnapshotBuildRequest;
	readonly resolve?: (outcome: CodingSnapshotBuildOutcome) => void;
	readonly reject?: (error: unknown) => void;
	readonly signal?: AbortSignal;
}

export class CodingSnapshotBuilder {
	readonly #control: CodingSnapshotRpcControl;
	readonly #lxd: CodingSnapshotBuilderLxdClient;
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #vmPolicy: CodingSnapshotVmPolicy;
	readonly #builderNetwork: string | null;
	readonly #builderCpus: number;
	readonly #builderMemoryBytes: number;
	readonly #builderRootDiskBytes: number;
	readonly #leaseSeconds: number;
	readonly #ttlSeconds: number;
	readonly #buildTimeoutMs: number;
	readonly #stepTimeoutMs: number;
	readonly #readyTimeoutMs: number;
	readonly #readyPollMs: number;
	readonly #publishWaitSeconds: number;
	readonly #compressionAlgorithm: string;
	readonly #cleanupTimeoutMs: number;
	readonly #maxQueueSize: number;
	readonly #redact: ((text: string) => string) | undefined;
	readonly #report: (event: Record<string, unknown>) => void;

	readonly #shutdown = new AbortController();
	readonly #queue: QueuedBuild[] = [];
	readonly #queuedKeys = new Set<string>();
	readonly #publishedFingerprints = new Map<string, number>();
	#activeKey: string | null = null;
	#activeVmName: string | null = null;
	#activePublishedFingerprint: string | null = null;
	#drainPromise: Promise<void> | null = null;
	#housekeepTimer: ReturnType<typeof setInterval> | null = null;
	#housekeepInFlight: Promise<CodingSnapshotSweepResult> | null = null;
	#closed = false;

	constructor(options: CodingSnapshotBuilderOptions) {
		if (!HEX_64.test(options.machineIdSha256) || !HEX_64.test(options.vmPolicy.imageFingerprint))
			throw new Error("CODING_SNAPSHOT_BUILDER_CONFIG_INVALID");
		this.#control = options.control;
		this.#lxd = options.lxd;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		this.#vmPolicy = options.vmPolicy;
		this.#builderNetwork = options.builderNetwork ?? null;
		this.#builderCpus = Math.max(1, Math.min(options.builderCpus ?? options.vmPolicy.cpus, options.vmPolicy.cpus));
		this.#builderMemoryBytes = Math.min(
			options.builderMemoryBytes ?? options.vmPolicy.memoryBytes,
			options.vmPolicy.memoryBytes,
		);
		this.#builderRootDiskBytes = Math.min(
			options.builderRootDiskBytes ?? options.vmPolicy.rootDiskBytes,
			options.vmPolicy.rootDiskBytes,
		);
		this.#leaseSeconds = options.leaseSeconds ?? CODING_SNAPSHOT_DEFAULT_LEASE_SECONDS;
		this.#ttlSeconds = options.ttlSeconds ?? CODING_SNAPSHOT_DEFAULT_TTL_SECONDS;
		this.#buildTimeoutMs = options.buildTimeoutMs ?? CODING_SNAPSHOT_DEFAULT_BUILD_TIMEOUT_MS;
		this.#stepTimeoutMs = options.stepTimeoutMs ?? CODING_SNAPSHOT_DEFAULT_STEP_TIMEOUT_MS;
		this.#readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
		this.#readyPollMs = options.readyPollMs ?? 500;
		this.#publishWaitSeconds = options.publishWaitSeconds ?? 600;
		this.#compressionAlgorithm = options.compressionAlgorithm ?? "zstd";
		this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
		this.#maxQueueSize = options.maxQueueSize ?? CODING_SNAPSHOT_MAX_QUEUE_SIZE;
		this.#redact = options.redact;
		const report = options.report;
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				undefined;
			}
		};
	}

	get queueLength(): number {
		return this.#queue.length;
	}

	get isBuilding(): boolean {
		return this.#activeKey !== null;
	}

	enqueue(request: CodingSnapshotBuildRequest): boolean {
		if (this.#closed) return false;
		if (!HEX_64.test(request.setupDigest) || !HEX_40.test(request.commitSha)) return false;
		const key = queueKey(request, this.#vmPolicy.imageFingerprint);
		if (this.#activeKey === key || this.#queuedKeys.has(key)) return true;
		if (this.#queue.length >= this.#maxQueueSize) {
			this.#report({
				event: "coding-snapshot-queue-full",
				repository: request.repository,
				setupDigest: request.setupDigest,
			});
			return false;
		}
		this.#queuedKeys.add(key);
		this.#queue.push({ key, request });
		this.#scheduleDrain();
		return true;
	}

	buildNow(request: CodingSnapshotBuildRequest, signal?: AbortSignal): Promise<CodingSnapshotBuildOutcome> {
		if (this.#closed) return Promise.reject(new Error("CODING_SNAPSHOT_BUILDER_CLOSED"));
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("CODING_SNAPSHOT_BUILD_ABORTED"));
		const key = queueKey(request, this.#vmPolicy.imageFingerprint);
		return new Promise<CodingSnapshotBuildOutcome>((resolve, reject) => {
			this.#queue.push({ key, request, resolve, reject, signal });
			this.#scheduleDrain();
		});
	}

	startHousekeeping(intervalMs = CODING_SNAPSHOT_DEFAULT_HOUSEKEEP_INTERVAL_MS): void {
		if (this.#closed || this.#housekeepTimer) return;
		this.#housekeepTimer = setInterval(() => {
			if (this.#closed || this.#housekeepInFlight) return;
			void this.housekeep(this.#shutdown.signal).catch((error) => {
				this.#report({
					event: "coding-snapshot-housekeep-error",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, intervalMs);
		this.#housekeepTimer.unref();
	}

	stopHousekeeping(): void {
		if (!this.#housekeepTimer) return;
		clearInterval(this.#housekeepTimer);
		this.#housekeepTimer = null;
	}

	async housekeep(signal: AbortSignal): Promise<CodingSnapshotSweepResult> {
		if (this.#housekeepInFlight) return this.#housekeepInFlight;
		const run = this.#runHousekeep(signal);
		this.#housekeepInFlight = run;
		try {
			return await run;
		} finally {
			if (this.#housekeepInFlight === run) this.#housekeepInFlight = null;
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.stopHousekeeping();
		this.#shutdown.abort(new Error("CODING_SNAPSHOT_BUILDER_CLOSED"));
		while (this.#queue.length > 0) {
			const pending = this.#queue.shift();
			if (!pending) break;
			this.#queuedKeys.delete(pending.key);
			pending.reject?.(new Error("CODING_SNAPSHOT_BUILDER_CLOSED"));
		}
		if (this.#drainPromise) await this.#drainPromise.catch(() => undefined);
		if (this.#housekeepInFlight) await this.#housekeepInFlight.catch(() => undefined);
	}

	#scheduleDrain(): void {
		if (this.#drainPromise) return;
		this.#drainPromise = this.#drain().finally(() => {
			this.#drainPromise = null;
			if (!this.#closed && this.#queue.length > 0) this.#scheduleDrain();
		});
	}

	async #drain(): Promise<void> {
		while (!this.#closed && this.#queue.length > 0) {
			const next = this.#queue.shift();
			if (!next) break;
			this.#queuedKeys.delete(next.key);
			if (next.signal?.aborted) {
				next.reject?.(next.signal.reason ?? new Error("CODING_SNAPSHOT_BUILD_ABORTED"));
				continue;
			}
			this.#activeKey = next.key;
			try {
				const outcome = await this.#executeBuild(next.request, next.signal);
				next.resolve?.(outcome);
			} catch (error) {
				this.#report({
					event: "coding-snapshot-build-error",
					repository: next.request.repository,
					setupDigest: next.request.setupDigest,
					error: error instanceof Error ? error.message : String(error),
				});
				next.reject?.(error);
			} finally {
				this.#activeKey = null;
			}
		}
	}

	async #claim(request: CodingSnapshotBuildRequest, signal: AbortSignal): Promise<ClaimDecision> {
		const raw = await this.#control.rpc(
			"qorpera_claim_coding_snapshot_build",
			{
				p_worker_id: request.workerId,
				p_lease_token: request.leaseToken,
				p_machine_id_sha256: this.#machineIdSha256,
				p_setup_digest: request.setupDigest,
				p_commit_sha: request.commitSha,
				p_lease_seconds: this.#leaseSeconds,
				p_ttl_seconds: this.#ttlSeconds,
			},
			signal,
		);
		const record = asObject(raw, "CODING_SNAPSHOT_CLAIM");
		if (record.schema !== "qorpera.coding-snapshot-claim/v1") throw new Error("CODING_SNAPSHOT_CLAIM_INVALID");
		const snapshot =
			record.snapshot && typeof record.snapshot === "object" ? (record.snapshot as Record<string, unknown>) : null;
		const snapshotFp = typeof snapshot?.imageFingerprint === "string" ? snapshot.imageFingerprint : null;
		if (record.state === "current") return { state: "current", snapshotImageFingerprint: snapshotFp };
		if (record.state === "waiting")
			return {
				state: "waiting",
				waitingUntil: typeof record.waitingUntil === "string" ? record.waitingUntil : null,
			};
		if (record.state === "failed") {
			const failure =
				record.failure && typeof record.failure === "object" ? (record.failure as Record<string, unknown>) : null;
			return {
				state: "failed",
				buildId: typeof failure?.buildId === "string" ? failure.buildId : null,
				code: typeof failure?.code === "string" ? failure.code : "SNAPSHOT_BUILD_FAILED",
				log: typeof failure?.log === "string" ? failure.log : null,
			};
		}
		if (record.state !== "claimed") throw new Error("CODING_SNAPSHOT_CLAIM_INVALID");
		const build = asObject(record.build, "CODING_SNAPSHOT_BUILD");
		if (
			typeof build.buildId !== "string" ||
			!isUuid(build.buildId) ||
			typeof build.leaseToken !== "string" ||
			!isUuid(build.leaseToken) ||
			typeof build.leaseUntil !== "string" ||
			typeof build.baseImageFingerprint !== "string" ||
			!HEX_64.test(build.baseImageFingerprint)
		)
			throw new Error("CODING_SNAPSHOT_CLAIM_INVALID");
		return {
			state: "claimed",
			build: {
				buildId: build.buildId,
				leaseToken: build.leaseToken,
				leaseUntil: build.leaseUntil,
				baseImageFingerprint: build.baseImageFingerprint,
				repository: typeof build.repository === "string" ? build.repository : request.repository.toLowerCase(),
				setupDigest: typeof build.setupDigest === "string" ? build.setupDigest : request.setupDigest,
				commitSha: typeof build.commitSha === "string" ? build.commitSha : request.commitSha,
				ttlSeconds: typeof build.ttlSeconds === "number" ? build.ttlSeconds : this.#ttlSeconds,
			},
		};
	}

	async #executeBuild(
		request: CodingSnapshotBuildRequest,
		callerSignal?: AbortSignal,
	): Promise<CodingSnapshotBuildOutcome> {
		const outerSignal = callerSignal ? AbortSignal.any([this.#shutdown.signal, callerSignal]) : this.#shutdown.signal;
		outerSignal.throwIfAborted();
		const claim = await this.#claim(request, outerSignal);
		if (claim.state !== "claimed") return claim;

		const { build } = claim;
		const vmName = buildVmName(build.buildId);
		const buildController = new AbortController();
		const onOuterAbort = () => buildController.abort(outerSignal.reason ?? new Error("BUILD_ABORTED"));
		outerSignal.addEventListener("abort", onOuterAbort, { once: true });
		const timeoutHandle = setTimeout(() => {
			buildController.abort(new SnapshotStepFailure("BUILD_TIMEOUT", "Snapshot build exceeded timeout."));
		}, this.#buildTimeoutMs);
		timeoutHandle.unref();

		let leaseLost = false;
		const renewIntervalMs = Math.max(5_000, Math.floor((this.#leaseSeconds * 1000) / 2));
		const renewHandle = setInterval(() => {
			void this.#control
				.rpc(
					"qorpera_renew_coding_snapshot_build",
					{
						p_build_id: build.buildId,
						p_lease_token: build.leaseToken,
						p_lease_seconds: this.#leaseSeconds,
					},
					buildController.signal,
				)
				.catch(() => {
					leaseLost = true;
					buildController.abort(new SnapshotStepFailure("LEASE_EXPIRED", "Snapshot build lease lost."));
				});
		}, renewIntervalMs);
		renewHandle.unref();

		let logBuffer = "";
		const maxLogChars = CODING_SNAPSHOT_LOG_MAX_JSON_BYTES * 4;
		const appendLog = (chunk: string) => {
			if (chunk.length === 0) return;
			logBuffer += chunk;
			if (logBuffer.length > maxLogChars) logBuffer = logBuffer.slice(-maxLogChars);
		};

		let vmCreated = false;
		let publishedFingerprint: string | null = null;
		this.#activeVmName = vmName;
		this.#report({
			event: "coding-snapshot-build-start",
			buildId: build.buildId,
			repository: build.repository,
			setupDigest: build.setupDigest,
			commitSha: build.commitSha,
			baseImageFingerprint: build.baseImageFingerprint,
		});

		try {
			const buildSignal = buildController.signal;
			buildSignal.throwIfAborted();
			vmCreated = true;
			await this.#launchBuilderVm(vmName, build, buildSignal);
			await this.#waitForBuilderReady(vmName, buildSignal);

			let workingDir = "/";
			if (request.readArchive) {
				const archive = await request.readArchive(buildSignal);
				if (archive && archive.byteLength > 0) {
					await this.#extractRepositoryArchive(vmName, archive, buildSignal);
					workingDir = BUILDER_SRC_DIR;
				}
			}

			const env = filteredSetupEnv(request.setupSpec);
			await this.#runBaseSetup(vmName, request.setupSpec, workingDir, env, appendLog, buildSignal);
			await this.#runSteps(vmName, request.setupSpec.initialize, workingDir, env, appendLog, buildSignal);
			await this.#runSteps(vmName, request.setupSpec.install, workingDir, env, appendLog, buildSignal);
			await this.#scrubBuilderVm(vmName, buildSignal);

			await this.#lxd.setInstancePower(this.#vmPolicy.project, vmName, "stop", buildSignal);
			const published = await this.#lxd.publishInstanceImage(
				this.#vmPolicy.project,
				vmName,
				{
					compressionAlgorithm: this.#compressionAlgorithm,
					waitSeconds: this.#publishWaitSeconds,
					properties: {
						"qorpera.kind": "coding-snapshot",
						"qorpera.owner": this.#owner,
						"qorpera.snapshot_id": build.buildId,
						"qorpera.setup_digest": build.setupDigest,
						"qorpera.base_image": build.baseImageFingerprint,
						"qorpera.repository": build.repository,
					},
				},
				buildSignal,
			);
			publishedFingerprint = published.fingerprint;
			this.#activePublishedFingerprint = published.fingerprint;
			this.#recordPublishedFingerprint(published.fingerprint);

			const logText = logBuffer.length > 0 ? codingSnapshotLog(logBuffer, this.#redact) : null;
			const completedRaw = await this.#control.rpc(
				"qorpera_complete_coding_snapshot_build",
				{
					p_build_id: build.buildId,
					p_lease_token: build.leaseToken,
					p_image_fingerprint: published.fingerprint,
					p_image_bytes: published.size,
					p_log: logText,
					p_ttl_seconds: build.ttlSeconds ?? this.#ttlSeconds,
				},
				buildSignal,
			);
			const completed = asObject(completedRaw, "CODING_SNAPSHOT_COMPLETE");
			this.#report({
				event: "coding-snapshot-build-ready",
				buildId: build.buildId,
				imageFingerprint: published.fingerprint,
				imageBytes: published.size,
			});
			return {
				state: "ready",
				buildId: build.buildId,
				imageFingerprint: published.fingerprint,
				imageBytes: published.size,
				expiresAt: typeof completed.expiresAt === "string" ? completed.expiresAt : null,
			};
		} catch (error) {
			if (publishedFingerprint) {
				// WHY: Remove an unpublished-in-SQL image if completion RPC fails so orphaned LXD images never leak disk.
				const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
				await this.#lxd
					.deleteImage(this.#vmPolicy.project, publishedFingerprint, cleanupSignal)
					.catch(() => undefined);
			}
			const aborted = outerSignal.aborted || leaseLost;
			const code = aborted ? (leaseLost ? "LEASE_EXPIRED" : "BUILD_ABORTED") : failureCodeFromError(error);
			if (error instanceof Error && error.message) appendLog(`\n[${code}] ${error.message}\n`);
			const logText = logBuffer.length > 0 ? codingSnapshotLog(logBuffer, this.#redact) : null;
			if (!leaseLost) {
				const reportSignal = AbortSignal.timeout(10_000);
				await this.#control
					.rpc(
						"qorpera_fail_coding_snapshot_build",
						{
							p_build_id: build.buildId,
							p_lease_token: build.leaseToken,
							p_failure: code,
							p_log: logText,
							p_abandoned: aborted,
						},
						reportSignal,
					)
					.catch(() => undefined);
			}
			this.#report({
				event: aborted ? "coding-snapshot-build-abandoned" : "coding-snapshot-build-failed",
				buildId: build.buildId,
				code,
			});
			return aborted
				? { state: "abandoned", code, buildId: build.buildId }
				: { state: "failed", code, buildId: build.buildId, log: logText };
		} finally {
			clearInterval(renewHandle);
			clearTimeout(timeoutHandle);
			outerSignal.removeEventListener("abort", onOuterAbort);
			this.#activePublishedFingerprint = null;
			if (vmCreated) await this.#destroyBuilderVm(vmName);
			this.#activeVmName = null;
		}
	}

	async #launchBuilderVm(vmName: string, build: ClaimedBuild, signal: AbortSignal): Promise<void> {
		const devices: Record<string, Record<string, string>> = {
			root: {
				type: "disk",
				path: "/",
				pool: this.#vmPolicy.storagePool,
				size: `${this.#builderRootDiskBytes}`,
			},
		};
		if (this.#builderNetwork) {
			devices.network = {
				type: "nic",
				network: this.#builderNetwork,
			};
		}
		await this.#lxd.createInstance(
			this.#vmPolicy.project,
			{
				name: vmName,
				type: "virtual-machine",
				profiles: [],
				config: {
					"limits.cpu": String(this.#builderCpus),
					"limits.memory": `${this.#builderMemoryBytes}`,
					"security.secureboot": "false",
					"user.qorpera.role": "coding-snapshot-builder",
					"user.qorpera.owner": this.#owner,
					"user.qorpera.build_id": build.buildId,
					"user.qorpera.setup_digest": build.setupDigest,
				},
				devices,
				source: {
					type: "image",
					fingerprint: build.baseImageFingerprint,
				},
			},
			signal,
		);
		await this.#lxd.setInstancePower(this.#vmPolicy.project, vmName, "start", signal);
	}

	async #waitForBuilderReady(vmName: string, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + this.#readyTimeoutMs;
		for (;;) {
			signal.throwIfAborted();
			try {
				const probe = await this.#lxd.execInstancePipe(
					this.#vmPolicy.project,
					vmName,
					{
						command: ["/bin/true"],
						environment: {},
						cwd: "/",
						maxStdoutBytes: 1024,
						stderrTailBytes: 1024,
					},
					AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
				);
				if (probe.exitCode === 0) return;
			} catch {
				if (signal.aborted) throw signal.reason;
			}
			if (Date.now() >= deadline)
				throw new SnapshotStepFailure("BUILDER_BOOT_TIMEOUT", "Snapshot builder VM did not become ready.");
			await delayAbortable(this.#readyPollMs, signal);
		}
	}

	async #extractRepositoryArchive(vmName: string, archive: Buffer, signal: AbortSignal): Promise<void> {
		const result = await this.#lxd.execInstancePipe(
			this.#vmPolicy.project,
			vmName,
			{
				command: [
					"/bin/sh",
					"-lc",
					`rm -rf ${BUILDER_SRC_DIR} && mkdir -p ${BUILDER_SRC_DIR} && tar -xf - -C ${BUILDER_SRC_DIR}`,
				],
				environment: {},
				cwd: "/",
				stdin: archive,
				maxStdoutBytes: 64 * 1024,
				stderrTailBytes: 16 * 1024,
			},
			AbortSignal.any([signal, AbortSignal.timeout(this.#stepTimeoutMs)]),
		);
		if (result.exitCode !== 0) {
			throw new SnapshotStepFailure(
				"ARCHIVE_EXTRACT_FAILED",
				`Repository archive extraction exited ${result.exitCode}: ${result.stderrTail.toString("utf8")}`,
			);
		}
	}

	async #runBaseSetup(
		vmName: string,
		setupSpec: CodingSetup,
		cwd: string,
		env: Record<string, string>,
		appendLog: (text: string) => void,
		signal: AbortSignal,
	): Promise<void> {
		if (setupSpec.base.kind === "machine") return;
		if (setupSpec.base.kind === "image") {
			const image = setupSpec.base.image;
			const missingMessage = `No container runtime available for base image ${image}`;
			const script = `if command -v docker >/dev/null 2>&1; then docker pull -- ${shellQuote(image)}; elif command -v podman >/dev/null 2>&1; then podman pull -- ${shellQuote(image)}; else printf '%s\\n' ${shellQuote(missingMessage)} >&2; exit 127; fi`;
			await this.#runCommandInBuilder(
				vmName,
				["/bin/sh", "-lc", script],
				cwd,
				env,
				appendLog,
				"BASE_IMAGE_FAILED",
				signal,
			);
			return;
		}
		const dockerfileBase = setupSpec.base;
		const srcRoot = cwd === "/" ? BUILDER_SRC_DIR : cwd;
		let dockerfilePath = dockerfileBase.dockerfile;
		if (dockerfileBase.contents !== null) {
			dockerfilePath = `${srcRoot}/.qorpera-snapshot.Dockerfile`;
			if (cwd === "/") {
				await this.#lxd.execInstancePipe(
					this.#vmPolicy.project,
					vmName,
					{
						command: ["/bin/mkdir", "-p", srcRoot],
						environment: {},
						cwd: "/",
						maxStdoutBytes: 4096,
						stderrTailBytes: 4096,
					},
					AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
				);
			}
			await this.#lxd.pushInstanceFile(
				this.#vmPolicy.project,
				vmName,
				dockerfilePath,
				dockerfileBase.contents,
				0o600,
				signal,
			);
		} else if (dockerfilePath !== null) {
			dockerfilePath = `${srcRoot}/${dockerfilePath}`;
		}
		if (!dockerfilePath) throw new SnapshotStepFailure("DOCKERFILE_MISSING", "Dockerfile path missing.");
		const contextPath = dockerfileBase.context === "." ? srcRoot : `${srcRoot}/${dockerfileBase.context}`;
		const buildArgs: string[] = [];
		for (const [k, v] of Object.entries(dockerfileBase.args)) {
			buildArgs.push("--build-arg", `${k}=${v}`);
		}
		if (dockerfileBase.target) buildArgs.push("--target", dockerfileBase.target);
		const argsJoined = buildArgs.map(shellQuote).join(" ");
		const tag = "qorpera-snapshot-base:latest";
		const script = [
			`if command -v docker >/dev/null 2>&1; then docker build -f ${shellQuote(dockerfilePath)} -t ${tag} ${argsJoined} -- ${shellQuote(contextPath)};`,
			`elif command -v podman >/dev/null 2>&1; then podman build -f ${shellQuote(dockerfilePath)} -t ${tag} ${argsJoined} -- ${shellQuote(contextPath)};`,
			`else echo "No container runtime available for build.dockerfile" >&2; exit 127; fi`,
		].join(" ");
		await this.#runCommandInBuilder(
			vmName,
			["/bin/sh", "-lc", script],
			srcRoot,
			env,
			appendLog,
			"DOCKERFILE_BUILD_FAILED",
			signal,
		);
	}

	async #runSteps(
		vmName: string,
		steps: readonly CodingSetupStep[],
		cwd: string,
		env: Record<string, string>,
		appendLog: (text: string) => void,
		signal: AbortSignal,
	): Promise<void> {
		for (const step of steps) {
			signal.throwIfAborted();
			if (step.commands.length === 0) continue;
			if (step.commands.length === 1) {
				await this.#runSetupCommand(vmName, step.from, step.commands[0], cwd, env, appendLog, signal);
			} else {
				await Promise.all(
					step.commands.map((command) =>
						this.#runSetupCommand(vmName, step.from, command, cwd, env, appendLog, signal),
					),
				);
			}
		}
	}

	async #runSetupCommand(
		vmName: string,
		from: string,
		command: CodingSetupStep["commands"][number],
		cwd: string,
		env: Record<string, string>,
		appendLog: (text: string) => void,
		signal: AbortSignal,
	): Promise<void> {
		const label = command.name ? `${from}:${command.name}` : from;
		appendLog(`==> ${label}\n`);
		const argv = "shell" in command.run ? ["/bin/sh", "-lc", command.run.shell] : [...command.run.argv];
		await this.#runCommandInBuilder(vmName, argv, cwd, env, appendLog, "SETUP_STEP_FAILED", signal);
	}

	async #runCommandInBuilder(
		vmName: string,
		command: readonly string[],
		cwd: string,
		env: Record<string, string>,
		appendLog: (text: string) => void,
		failureCode: string,
		signal: AbortSignal,
	): Promise<void> {
		const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#stepTimeoutMs)]);
		let streamedStdout = false;
		const result = await this.#lxd.execInstancePipe(
			this.#vmPolicy.project,
			vmName,
			{
				command,
				environment: env,
				cwd,
				maxStdoutBytes: 256 * 1024,
				stderrTailBytes: 32 * 1024,
				stdout: (chunk) => {
					streamedStdout = true;
					appendLog(chunk.toString("utf8"));
				},
			},
			stepSignal,
		);
		if (!streamedStdout && result.stdout.byteLength > 0) appendLog(result.stdout.toString("utf8"));
		if (result.stderrTail.byteLength > 0) appendLog(result.stderrTail.toString("utf8"));
		if (result.exitCode !== 0) {
			throw new SnapshotStepFailure(failureCode, `Command exited with status ${result.exitCode}`);
		}
	}

	async #scrubBuilderVm(vmName: string, signal: AbortSignal): Promise<void> {
		const result = await this.#lxd.execInstancePipe(
			this.#vmPolicy.project,
			vmName,
			{
				command: ["/bin/sh", "-lc", SCRUB_BUILDER_SCRIPT],
				environment: {},
				cwd: "/",
				maxStdoutBytes: 16 * 1024,
				stderrTailBytes: 16 * 1024,
			},
			AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
		);
		if (result.exitCode !== 0) {
			throw new SnapshotStepFailure(
				"BUILDER_SCRUB_FAILED",
				`Builder scrub exited ${result.exitCode}: ${result.stderrTail.toString("utf8")}`,
			);
		}
	}

	async #destroyBuilderVm(vmName: string): Promise<void> {
		// WHY: Always use a fresh bounded cleanup signal so aborting or timing out a build still deletes the VM.
		const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
		try {
			const existing = await this.#lxd.getInstance(this.#vmPolicy.project, vmName, cleanupSignal);
			if (!existing) return;
			if (existing.status === "Running" || existing.statusCode === 103) {
				if (this.#lxd.setInstancePowerStateful) {
					await this.#lxd
						.setInstancePowerStateful(this.#vmPolicy.project, vmName, "stop", false, cleanupSignal, true)
						.catch(() => this.#lxd.setInstancePower(this.#vmPolicy.project, vmName, "stop", cleanupSignal));
				} else {
					await this.#lxd.setInstancePower(this.#vmPolicy.project, vmName, "stop", cleanupSignal);
				}
			}
			await this.#lxd.deleteInstance(this.#vmPolicy.project, vmName, cleanupSignal);
		} catch (error) {
			this.#report({
				event: "coding-snapshot-builder-cleanup-failed",
				vmName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#recordPublishedFingerprint(fingerprint: string): void {
		const now = Date.now();
		this.#publishedFingerprints.set(fingerprint, now);
		for (const [fp, publishedAt] of this.#publishedFingerprints) {
			if (now - publishedAt > 10 * 60_000) this.#publishedFingerprints.delete(fp);
		}
	}

	async #runHousekeep(signal: AbortSignal): Promise<CodingSnapshotSweepResult> {
		const sweepStartedAt = Date.now();
		const raw = await this.#control.rpc(
			"qorpera_sweep_coding_snapshots",
			{
				p_owner: this.#owner,
				p_machine_id_sha256: this.#machineIdSha256,
				p_current_base_image_fingerprint: this.#vmPolicy.imageFingerprint,
			},
			signal,
		);
		const sweep = asObject(raw, "CODING_SNAPSHOT_SWEEP");
		if (sweep.schema !== "qorpera.coding-snapshot-sweep/v1") throw new Error("CODING_SNAPSHOT_SWEEP_INVALID");
		const keepSet = new Set<string>([this.#vmPolicy.imageFingerprint]);
		if (this.#activePublishedFingerprint) keepSet.add(this.#activePublishedFingerprint);
		if (Array.isArray(sweep.keepImageFingerprints)) {
			for (const fp of sweep.keepImageFingerprints) {
				if (typeof fp === "string" && HEX_64.test(fp)) keepSet.add(fp);
			}
		}

		const prunedImages: string[] = [];
		if (Array.isArray(sweep.pruneImages)) {
			for (const entry of sweep.pruneImages) {
				signal.throwIfAborted();
				if (!entry || typeof entry !== "object") continue;
				const item = entry as Record<string, unknown>;
				const snapshotId = typeof item.snapshotId === "string" ? item.snapshotId : "";
				const imageFingerprint = typeof item.imageFingerprint === "string" ? item.imageFingerprint : "";
				if (!isUuid(snapshotId) || !HEX_64.test(imageFingerprint) || keepSet.has(imageFingerprint)) continue;
				try {
					await this.#lxd.deleteImage(this.#vmPolicy.project, imageFingerprint, signal);
					await this.#control.rpc(
						"qorpera_record_coding_snapshot_removed",
						{
							p_snapshot_id: snapshotId,
							p_owner: this.#owner,
							p_machine_id_sha256: this.#machineIdSha256,
						},
						signal,
					);
					prunedImages.push(imageFingerprint);
				} catch (error) {
					this.#report({
						event: "coding-snapshot-prune-failed",
						snapshotId,
						imageFingerprint,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		const orphanImagesDeleted: string[] = [];
		const images = await this.#lxd.listImages(this.#vmPolicy.project, signal).catch(() => []);
		for (const image of images) {
			signal.throwIfAborted();
			if (image.properties["qorpera.kind"] !== "coding-snapshot") continue;
			if (image.properties["qorpera.owner"] && image.properties["qorpera.owner"] !== this.#owner) continue;
			if (
				keepSet.has(image.fingerprint) ||
				prunedImages.includes(image.fingerprint) ||
				this.#activePublishedFingerprint === image.fingerprint ||
				(this.#publishedFingerprints.get(image.fingerprint) ?? 0) >= sweepStartedAt
			)
				continue;
			const deleted = await this.#lxd
				.deleteImage(this.#vmPolicy.project, image.fingerprint, signal)
				.catch(() => false);
			if (deleted) orphanImagesDeleted.push(image.fingerprint);
		}

		const orphanVmsDeleted: string[] = [];
		if (this.#lxd.listInstances) {
			const instances = await this.#lxd.listInstances(this.#vmPolicy.project, signal).catch(() => []);
			for (const inst of instances) {
				signal.throwIfAborted();
				if (!inst.name.startsWith(CODING_SNAPSHOT_BUILDER_VM_PREFIX)) continue;
				if (inst.config["user.qorpera.owner"] && inst.config["user.qorpera.owner"] !== this.#owner) continue;
				if (inst.name === this.#activeVmName) continue;
				await this.#destroyBuilderVm(inst.name);
				orphanVmsDeleted.push(inst.name);
			}
		}

		return {
			abandonedBuilds: typeof sweep.abandonedBuilds === "number" ? sweep.abandonedBuilds : 0,
			retiredSnapshots: typeof sweep.retiredSnapshots === "number" ? sweep.retiredSnapshots : 0,
			prunedImages,
			orphanImagesDeleted,
			orphanVmsDeleted,
		};
	}
}

function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("ABORTED"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("ABORTED"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
