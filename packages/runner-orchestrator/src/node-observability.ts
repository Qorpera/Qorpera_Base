import { statfs } from "node:fs/promises";
import { type CpuInfo, cpus, freemem, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
// Public build identifiers, never arbitrary environment text or host paths.
const VERSION_PATTERN = /^(?:[0-9a-f]{40}|[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-z0-9.-]{1,32})?)$/;
const CPU_FIELDS = ["user", "nice", "sys", "idle", "irq"] as const;
export const NODE_SAMPLE_INTERVAL_MS = 15_000;
export const NODE_STALE_AFTER_MS = 60_000;
export const NODE_DISK_TIMEOUT_MS = 1_000;
export const NODE_OBSERVATIONS_PATH = "/v1/qorpera-runner-provider/observations";

type ObservationReason =
	| "not_sampled"
	| "warming_up"
	| "sampling_gap"
	| "counter_reset"
	| "not_supported"
	| "invalid_measurement"
	| "clock_unavailable"
	| "read_failed"
	| "timeout"
	| "not_observed";

export interface NodeObservationReading<Value> {
	status: "observed" | "unknown" | "unavailable";
	reason: ObservationReason | null;
	observedAt: string | null;
	attemptedAt: string | null;
	freshness: "fresh" | "stale" | "unknown";
	value: Value | null;
}

export interface NodeCpuObservation {
	utilizationRatio: number;
	windowMs: number;
	logicalCpuCount: number;
}

export interface NodeMemoryObservation {
	totalBytes: number;
	freeBytes: number;
	usedBytes: number;
	// Includes caches: this is not application working-set memory or capacity.
	basis: "os-total-minus-free";
}

export interface NodeDiskObservation {
	totalBytes: number;
	availableBytes: number;
	scope: "provider-root-filesystem";
}

export interface ProviderNodeObservation {
	schema: "qorpera.node-observation/v1";
	providerAdapter: string | null;
	nodeId: string | null;
	softwareVersion: string | null;
	asOf: string | null;
	scope: "provider-host";
	retention: "latest-in-process-only";
	sampleIntervalMs: number;
	staleAfterMs: number;
	cpu: NodeObservationReading<NodeCpuObservation>;
	memory: NodeObservationReading<NodeMemoryObservation>;
	disk: NodeObservationReading<NodeDiskObservation>;
	network: NodeObservationReading<never>;
}

export interface NodeObservationSources {
	cpuTimes(): readonly CpuInfo["times"][];
	memory(): { totalBytes: number; freeBytes: number };
	disk(): Promise<{ blockSize: bigint; blocks: bigint; availableBlocks: bigint }>;
	now(): number;
	monotonicNow(): number;
}

export interface NodeObservabilityOptions {
	providerAdapter: string;
	nodeId?: string;
	softwareVersion?: string;
	sources?: Partial<NodeObservationSources>;
}

interface StoredReading<Value> {
	status: NodeObservationReading<Value>["status"];
	reason: ObservationReason | null;
	observedAt: string | null;
	attemptedAt: string | null;
	value: Value | null;
}

interface CpuSample {
	times: readonly CpuInfo["times"][];
	monotonic: number;
}

function emptyReading<Value>(): StoredReading<Value> {
	return { status: "unknown", reason: "not_sampled", observedAt: null, attemptedAt: null, value: null };
}

function failed<Value>(
	previous: StoredReading<Value>,
	at: string | null,
	reason: ObservationReason,
	status: "unknown" | "unavailable" = "unavailable",
): StoredReading<Value> {
	// A failed sample never erases the last measurement or restamps it as fresh.
	return { ...previous, status, reason, attemptedAt: at };
}

function observed<Value>(value: Value, at: string): StoredReading<Value> {
	return { status: "observed", reason: null, observedAt: at, attemptedAt: at, value };
}

function reading<Value>(value: StoredReading<Value>, now: number | null): NodeObservationReading<Value> {
	const age = value.observedAt === null || now === null ? null : now - Date.parse(value.observedAt);
	return {
		...value,
		freshness:
			value.observedAt === null
				? "unknown"
				: age !== null && age >= 0 && age < NODE_STALE_AFTER_MS
					? "fresh"
					: "stale",
		// Return a copy so callers cannot modify the sampler's retained reading.
		value: value.value === null ? null : structuredClone(value.value),
	};
}

/** Node diagnostics are optional evidence, never admission/allocation authority.
 * The only filesystem observation is statfs('/') in the provider's namespace.
 * No credentials, arbitrary paths, subprocesses or network requests are read.
 * The distinct object-gateway health endpoint remains the NAS/network evidence.
 */
export class ProviderNodeObservability {
	readonly #providerAdapter: string | null;
	readonly #nodeId: string | null;
	readonly #softwareVersion: string | null;
	readonly #sources: NodeObservationSources;
	#cpu = emptyReading<NodeCpuObservation>();
	#memory = emptyReading<NodeMemoryObservation>();
	#disk = emptyReading<NodeDiskObservation>();
	#previousCpu?: CpuSample;
	#timer?: ReturnType<typeof setInterval>;
	#diskTimer?: ReturnType<typeof setTimeout>;
	#diskPending?: Promise<void>;
	#running = false;
	#generation = 0;

	constructor(options: NodeObservabilityOptions) {
		this.#providerAdapter = ADAPTER_PATTERN.test(options.providerAdapter) ? options.providerAdapter : null;
		this.#nodeId = options.nodeId && UUID_PATTERN.test(options.nodeId) ? options.nodeId.toLowerCase() : null;
		this.#softwareVersion =
			options.softwareVersion && VERSION_PATTERN.test(options.softwareVersion) ? options.softwareVersion : null;
		this.#sources = {
			cpuTimes: () => cpus().map((cpu) => cpu.times),
			memory: () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
			disk: async () => {
				const space = await statfs("/", { bigint: true });
				return { blockSize: space.bsize, blocks: space.blocks, availableBlocks: space.bavail };
			},
			now: Date.now,
			monotonicNow: () => performance.now(),
			...options.sources,
		};
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#generation += 1;
		this.#previousCpu = undefined;
		this.#sample();
		this.#timer = setInterval(() => this.#sample(), NODE_SAMPLE_INTERVAL_MS);
		this.#timer.unref();
	}

	stop(): void {
		if (!this.#running) return;
		this.#running = false;
		this.#generation += 1;
		clearInterval(this.#timer);
		clearTimeout(this.#diskTimer);
		this.#timer = undefined;
		this.#diskTimer = undefined;
		// Keep the outstanding slot until statfs actually settles, even on restart.
	}

	snapshot(): ProviderNodeObservation {
		const now = this.#time();
		return {
			schema: "qorpera.node-observation/v1",
			providerAdapter: this.#providerAdapter,
			nodeId: this.#nodeId,
			softwareVersion: this.#softwareVersion,
			asOf: now === null ? null : new Date(now).toISOString(),
			scope: "provider-host",
			retention: "latest-in-process-only",
			sampleIntervalMs: NODE_SAMPLE_INTERVAL_MS,
			staleAfterMs: NODE_STALE_AFTER_MS,
			cpu: reading(this.#cpu, now),
			memory: reading(this.#memory, now),
			disk: reading(this.#disk, now),
			network: {
				status: "unknown",
				reason: "not_observed",
				observedAt: null,
				attemptedAt: null,
				freshness: "unknown",
				value: null,
			},
		};
	}

	#time(): number | null {
		try {
			const now = this.#sources.now();
			return Number.isSafeInteger(now) && now >= 0 && now <= 8_640_000_000_000_000 ? now : null;
		} catch {
			return null;
		}
	}

	#sample(): void {
		if (!this.#running) return;
		const now = this.#time();
		const at = now === null ? null : new Date(now).toISOString();
		if (at === null) {
			this.#cpu = failed(this.#cpu, at, "clock_unavailable");
			this.#memory = failed(this.#memory, at, "clock_unavailable");
			this.#disk = failed(this.#disk, at, "clock_unavailable");
			this.#previousCpu = undefined;
			return;
		}
		this.#sampleCpu(at);
		try {
			const { totalBytes, freeBytes } = this.#sources.memory();
			this.#memory =
				Number.isSafeInteger(totalBytes) &&
				totalBytes > 0 &&
				Number.isSafeInteger(freeBytes) &&
				freeBytes >= 0 &&
				freeBytes <= totalBytes
					? observed(
							{ totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, basis: "os-total-minus-free" },
							at,
						)
					: failed(this.#memory, at, "invalid_measurement");
		} catch {
			this.#memory = failed(this.#memory, at, "read_failed");
		}
		this.#sampleDisk(at);
	}

	#sampleCpu(at: string): void {
		try {
			const raw = this.#sources.cpuTimes();
			if (raw.length === 0) {
				this.#previousCpu = undefined;
				this.#cpu = failed(this.#cpu, at, "not_supported", "unknown");
				return;
			}
			const monotonic = this.#sources.monotonicNow();
			if (
				raw.length > 4096 ||
				!Number.isFinite(monotonic) ||
				monotonic < 0 ||
				!raw.every((times) => CPU_FIELDS.every((field) => Number.isSafeInteger(times[field]) && times[field] >= 0))
			) {
				this.#previousCpu = undefined;
				this.#cpu = failed(this.#cpu, at, "invalid_measurement");
				return;
			}
			const current: CpuSample = { times: raw.map((times) => ({ ...times })), monotonic };
			const previous = this.#previousCpu;
			this.#previousCpu = current;
			if (!previous) {
				this.#cpu = failed(this.#cpu, at, "warming_up", "unknown");
				return;
			}
			const windowMs = monotonic - previous.monotonic;
			if (windowMs <= 0 || windowMs > NODE_STALE_AFTER_MS) {
				this.#cpu = failed(this.#cpu, at, "sampling_gap", "unknown");
				return;
			}
			if (previous.times.length !== current.times.length) {
				this.#cpu = failed(this.#cpu, at, "counter_reset", "unknown");
				return;
			}
			let totalDelta = 0;
			let idleDelta = 0;
			for (let index = 0; index < current.times.length; index += 1) {
				for (const field of CPU_FIELDS) {
					const delta = current.times[index]![field] - previous.times[index]![field];
					if (delta < 0) {
						this.#cpu = failed(this.#cpu, at, "counter_reset", "unknown");
						return;
					}
					totalDelta += delta;
					if (field === "idle") idleDelta += delta;
				}
			}
			if (!Number.isSafeInteger(totalDelta) || totalDelta <= 0) {
				this.#cpu = failed(this.#cpu, at, "invalid_measurement");
				return;
			}
			this.#cpu = observed(
				{
					utilizationRatio: (totalDelta - idleDelta) / totalDelta,
					windowMs,
					logicalCpuCount: current.times.length,
				},
				at,
			);
		} catch {
			this.#previousCpu = undefined;
			this.#cpu = failed(this.#cpu, at, "read_failed");
		}
	}

	#sampleDisk(at: string): void {
		if (this.#diskPending) return;
		let started: number;
		try {
			started = this.#sources.monotonicNow();
			if (!Number.isFinite(started) || started < 0) throw new Error("Invalid clock");
		} catch {
			this.#disk = failed(this.#disk, at, "clock_unavailable");
			return;
		}
		const generation = this.#generation;
		let timedOut = false;
		this.#diskTimer = setTimeout(() => {
			timedOut = true;
			if (this.#running && this.#generation === generation) this.#disk = failed(this.#disk, at, "timeout");
		}, NODE_DISK_TIMEOUT_MS);
		this.#diskTimer.unref();
		const timer = this.#diskTimer;
		const pending = Promise.resolve()
			.then(() => {
				if (!this.#running || this.#generation !== generation) return undefined;
				return this.#sources.disk();
			})
			.then(
				(space) => {
					if (!this.#running || this.#generation !== generation || timedOut) return;
					try {
						const elapsed = this.#sources.monotonicNow() - started;
						if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= NODE_DISK_TIMEOUT_MS) {
							this.#disk = failed(this.#disk, at, "timeout");
							return;
						}
						if (
							space === undefined ||
							typeof space.blockSize !== "bigint" ||
							typeof space.blocks !== "bigint" ||
							typeof space.availableBlocks !== "bigint" ||
							space.blockSize <= 0n ||
							space.blocks <= 0n ||
							space.availableBlocks < 0n ||
							space.availableBlocks > space.blocks ||
							space.blocks * space.blockSize > BigInt(Number.MAX_SAFE_INTEGER)
						) {
							this.#disk = failed(this.#disk, at, "invalid_measurement");
							return;
						}
						this.#disk = observed(
							{
								totalBytes: Number(space.blocks * space.blockSize),
								availableBytes: Number(space.availableBlocks * space.blockSize),
								scope: "provider-root-filesystem",
							},
							at,
						);
					} catch {
						this.#disk = failed(this.#disk, at, "invalid_measurement");
					}
				},
				() => {
					if (this.#running && this.#generation === generation && !timedOut) {
						this.#disk = failed(this.#disk, at, "read_failed");
					}
				},
			)
			.finally(() => {
				clearTimeout(timer);
				if (this.#diskTimer === timer) this.#diskTimer = undefined;
				if (this.#diskPending === pending) this.#diskPending = undefined;
			});
		this.#diskPending = pending;
	}
}
