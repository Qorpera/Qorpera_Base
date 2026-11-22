import { randomBytes, randomUUID } from "node:crypto";
import type { CodingMachineStandbyClaim } from "./coding-machine.ts";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdImageClient,
	LxdInstanceDeviceClient,
	LxdInstanceExecPipeClient,
	LxdStandbyClient,
} from "./lxd-client.ts";

export const CODING_STANDBY_VM_PREFIX = "qorpera-coding-standby-";
export const CODING_STANDBY_MAX_POOL_SIZE = 8;
export const CODING_STANDBY_DEFAULT_MAX_FINGERPRINTS = 4;

const HEX_64 = /^[0-9a-f]{64}$/;

export type CodingStandbyLxdClient = Pick<
	LxdClient,
	"getInstance" | "createInstance" | "setInstancePower" | "deleteInstance"
> &
	Pick<LxdInstanceDeviceClient, "replaceInstanceDevices"> &
	LxdStandbyClient &
	Partial<LxdImageClient> &
	Partial<LxdInstanceExecPipeClient>;

export interface CodingStandbyVmPolicy {
	readonly project: string;
	readonly imageFingerprint: string;
	readonly storagePool: string;
	readonly cpus: number;
	readonly memoryBytes: number;
	readonly rootDiskBytes: number;
}

export interface CodingStandbyPoolOptions {
	readonly lxd: CodingStandbyLxdClient;
	readonly vmPolicy: CodingStandbyVmPolicy;
	readonly standbyPoolSize?: number;
	readonly maxActiveFingerprints?: number;
	readonly preferStatefulSuspend?: boolean;
	readonly bootTimeoutMs?: number;
	readonly bootPollMs?: number;
	readonly replenishBackoffMs?: number;
	readonly cleanupTimeoutMs?: number;
	readonly waitForBootSettled?: (project: string, instanceName: string, signal: AbortSignal) => Promise<void>;
	readonly report?: (event: Record<string, unknown>) => void;
}

interface StandbyEntry {
	readonly name: string;
	readonly imageFingerprint: string;
	readonly cpus: number;
	readonly memoryBytes: number;
	readonly rootDiskBytes: number;
	readonly stateful: boolean;
	readonly createdAt: number;
}

interface WarmupHandle {
	readonly name: string;
	readonly imageFingerprint: string;
	readonly controller: AbortController;
	readonly done: Promise<void>;
}

export class CodingStandbyPool {
	readonly #lxd: CodingStandbyLxdClient;
	readonly #vmPolicy: CodingStandbyVmPolicy;
	readonly #standbyPoolSize: number;
	readonly #maxActiveFingerprints: number;
	readonly #preferStatefulSuspend: boolean;
	readonly #bootTimeoutMs: number;
	readonly #bootPollMs: number;
	readonly #replenishBackoffMs: number;
	readonly #cleanupTimeoutMs: number;
	readonly #waitForBootSettled:
		| ((project: string, instanceName: string, signal: AbortSignal) => Promise<void>)
		| undefined;
	readonly #report: (event: Record<string, unknown>) => void;

	readonly #shutdown = new AbortController();
	readonly #activeFingerprints = new Set<string>();
	readonly #ready = new Map<string, StandbyEntry[]>();
	readonly #warmups = new Set<WarmupHandle>();
	readonly #ownedNames = new Set<string>();
	readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #failureCounts = new Map<string, number>();
	readonly #destroyTasks = new Set<Promise<void>>();
	#closed = false;

	constructor(options: CodingStandbyPoolOptions) {
		if (!HEX_64.test(options.vmPolicy.imageFingerprint)) throw new Error("CODING_STANDBY_POOL_CONFIG_INVALID");
		const size = options.standbyPoolSize ?? 0;
		if (!Number.isSafeInteger(size) || size < 0 || size > CODING_STANDBY_MAX_POOL_SIZE)
			throw new Error("CODING_STANDBY_POOL_CONFIG_INVALID");
		this.#lxd = options.lxd;
		this.#vmPolicy = options.vmPolicy;
		this.#standbyPoolSize = size;
		this.#maxActiveFingerprints = Math.max(
			1,
			options.maxActiveFingerprints ?? CODING_STANDBY_DEFAULT_MAX_FINGERPRINTS,
		);
		this.#preferStatefulSuspend = options.preferStatefulSuspend ?? true;
		this.#bootTimeoutMs = options.bootTimeoutMs ?? 90_000;
		this.#bootPollMs = options.bootPollMs ?? 250;
		this.#replenishBackoffMs = options.replenishBackoffMs ?? 5_000;
		this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
		this.#waitForBootSettled = options.waitForBootSettled;
		const report = options.report;
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				undefined;
			}
		};
		this.#activeFingerprints.add(options.vmPolicy.imageFingerprint);
	}

	get size(): number {
		return this.#standbyPoolSize;
	}

	readyCount(imageFingerprint?: string): number {
		if (imageFingerprint !== undefined) return this.#ready.get(imageFingerprint)?.length ?? 0;
		let total = 0;
		for (const list of this.#ready.values()) total += list.length;
		return total;
	}

	activeFingerprints(): readonly string[] {
		return [...this.#activeFingerprints];
	}

	start(): void {
		if (this.#closed || this.#standbyPoolSize === 0) return;
		this.#ensureAllReplenished();
	}

	setActiveFingerprints(fingerprints: readonly string[]): void {
		const valid = fingerprints.filter((fp) => HEX_64.test(fp));
		const next = new Set<string>();
		next.add(this.#vmPolicy.imageFingerprint);
		for (const fp of valid) {
			if (next.size >= this.#maxActiveFingerprints) break;
			next.add(fp);
		}
		const removed: string[] = [];
		for (const fp of this.#activeFingerprints) {
			if (!next.has(fp)) removed.push(fp);
		}
		this.#activeFingerprints.clear();
		for (const fp of next) this.#activeFingerprints.add(fp);
		for (const fp of removed) {
			void this.invalidateFingerprint(fp);
		}
		if (!this.#closed && this.#standbyPoolSize > 0) this.#ensureAllReplenished();
	}

	async invalidateFingerprint(imageFingerprint: string): Promise<void> {
		this.#activeFingerprints.delete(imageFingerprint);
		this.#clearRetryTimer(imageFingerprint);
		this.#failureCounts.delete(imageFingerprint);
		const matchingWarmups: Promise<void>[] = [];
		for (const handle of this.#warmups) {
			if (handle.imageFingerprint === imageFingerprint) {
				handle.controller.abort(new Error("STANDBY_FINGERPRINT_INVALIDATED"));
				matchingWarmups.push(handle.done.catch(() => undefined));
			}
		}
		const entries = this.#ready.get(imageFingerprint) ?? [];
		this.#ready.delete(imageFingerprint);
		await Promise.all([...matchingWarmups, ...entries.map((entry) => this.#destroyStandbyVm(entry.name))]);
	}

	async claim(request: LxdCreateInstanceRequest, signal: AbortSignal): Promise<CodingMachineStandbyClaim | null> {
		if (this.#closed || this.#standbyPoolSize === 0) return null;
		const fingerprint = request.source.fingerprint;
		if (!HEX_64.test(fingerprint)) return null;

		if (!this.#activeFingerprints.has(fingerprint) && this.#activeFingerprints.size < this.#maxActiveFingerprints) {
			this.#activeFingerprints.add(fingerprint);
		}

		const requestedCpus = Number.parseInt(request.config["limits.cpu"] ?? "", 10);
		const requestedMemory = Number.parseInt(request.config["limits.memory"] ?? "", 10);
		const requestedDisk = Number.parseInt(request.devices.root?.size ?? "", 10);

		const list = this.#ready.get(fingerprint);
		while (list && list.length > 0) {
			const entry = list.shift();
			if (!entry) break;
			if (list.length === 0) this.#ready.delete(fingerprint);

			if (
				entry.cpus !== requestedCpus ||
				entry.memoryBytes !== requestedMemory ||
				entry.rootDiskBytes !== requestedDisk
			) {
				this.#trackDestroy(this.#destroyStandbyVm(entry.name));
				continue;
			}

			let existing: Awaited<ReturnType<CodingStandbyLxdClient["getInstance"]>>;
			try {
				existing = await this.#lxd.getInstance(this.#vmPolicy.project, entry.name, signal);
			} catch {
				this.#trackDestroy(this.#destroyStandbyVm(entry.name));
				continue;
			}
			if (!existing || (existing.status !== "Stopped" && existing.statusCode !== 102)) {
				this.#trackDestroy(this.#destroyStandbyVm(entry.name));
				continue;
			}

			try {
				await this.#lxd.renameInstance(this.#vmPolicy.project, entry.name, request.name, signal);
			} catch {
				this.#trackDestroy(this.#destroyStandbyVm(entry.name));
				continue;
			}
			this.#ownedNames.delete(entry.name);
			this.#ensureReplenished(fingerprint);

			const createOperationId = randomUUID();
			const isStateful = entry.stateful && existing.stateful !== false;
			if (!isStateful) {
				try {
					await this.#lxd.updateInstanceConfig(
						this.#vmPolicy.project,
						request.name,
						{ config: request.config, devices: request.devices },
						signal,
					);
				} catch (error) {
					await this.#destroyStandbyVm(request.name);
					throw error;
				}
				this.#report({
					event: "coding-standby-claimed",
					standbyName: entry.name,
					instanceName: request.name,
					imageFingerprint: fingerprint,
					stateful: false,
				});
				return { operationId: createOperationId };
			}

			try {
				await this.#lxd.updateInstanceConfig(
					this.#vmPolicy.project,
					request.name,
					{ config: request.config },
					signal,
				);
			} catch (error) {
				await this.#destroyStandbyVm(request.name);
				throw error;
			}
			this.#report({
				event: "coding-standby-claimed",
				standbyName: entry.name,
				instanceName: request.name,
				imageFingerprint: fingerprint,
				stateful: true,
			});
			return {
				operationId: createOperationId,
				resume: async (resumeSignal: AbortSignal): Promise<string | null> => {
					try {
						await this.#lxd.setInstancePowerStateful(
							this.#vmPolicy.project,
							request.name,
							"start",
							true,
							resumeSignal,
						);
						await this.#lxd.replaceInstanceDevices(
							this.#vmPolicy.project,
							request.name,
							request.devices,
							resumeSignal,
						);
						return randomUUID();
					} catch (error) {
						if (resumeSignal.aborted) throw error;
						// WHY: Transparently fall back to a cold start with static NIC config if stateful restore or hot-plug fails.
						this.#report({
							event: "coding-standby-stateful-fallback",
							instanceName: request.name,
							error: error instanceof Error ? error.message : String(error),
						});
						await this.#lxd
							.setInstancePowerStateful(this.#vmPolicy.project, request.name, "stop", false, resumeSignal, true)
							.catch(() => undefined);
						await this.#lxd.updateInstanceConfig(
							this.#vmPolicy.project,
							request.name,
							{ config: request.config, devices: request.devices },
							resumeSignal,
						);
						return null;
					}
				},
			};
		}

		this.#ensureReplenished(fingerprint);
		return null;
	}

	async sweepOrphans(signal: AbortSignal): Promise<string[]> {
		const instances = await this.#lxd.listInstances(this.#vmPolicy.project, signal);
		const removed: string[] = [];
		for (const inst of instances) {
			signal.throwIfAborted();
			if (!inst.name.startsWith(CODING_STANDBY_VM_PREFIX)) continue;
			if (this.#ownedNames.has(inst.name)) continue;
			await this.#destroyStandbyVm(inst.name);
			removed.push(inst.name);
		}
		return removed;
	}

	async waitIdle(): Promise<void> {
		while (this.#warmups.size > 0 || this.#destroyTasks.size > 0) {
			await Promise.all([
				...[...this.#warmups].map((h) => h.done.catch(() => undefined)),
				...[...this.#destroyTasks].map((p) => p.catch(() => undefined)),
			]);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#shutdown.abort(new Error("CODING_STANDBY_POOL_CLOSED"));
		for (const timer of this.#retryTimers.values()) clearTimeout(timer);
		this.#retryTimers.clear();
		for (const handle of this.#warmups) {
			handle.controller.abort(new Error("CODING_STANDBY_POOL_CLOSED"));
		}
		await Promise.all([...this.#warmups].map((h) => h.done.catch(() => undefined)));
		const toDelete: string[] = [];
		for (const list of this.#ready.values()) {
			for (const entry of list) toDelete.push(entry.name);
		}
		this.#ready.clear();
		await Promise.all(toDelete.map((name) => this.#destroyStandbyVm(name)));
		await Promise.all([...this.#destroyTasks].map((p) => p.catch(() => undefined)));
	}

	#ensureAllReplenished(): void {
		for (const fp of this.#activeFingerprints) {
			this.#ensureReplenished(fp);
		}
	}

	#ensureReplenished(imageFingerprint: string): void {
		if (this.#closed || this.#standbyPoolSize === 0) return;
		if (!this.#activeFingerprints.has(imageFingerprint)) return;
		if (this.#retryTimers.has(imageFingerprint)) return;
		const ready = this.#ready.get(imageFingerprint)?.length ?? 0;
		let inflight = 0;
		for (const handle of this.#warmups) {
			if (handle.imageFingerprint === imageFingerprint) inflight++;
		}
		if (ready + inflight >= this.#standbyPoolSize) return;
		if (this.#warmups.size >= 1) return;
		this.#launchWarmup(imageFingerprint);
	}

	#launchWarmup(imageFingerprint: string): void {
		const name = `${CODING_STANDBY_VM_PREFIX}${randomBytes(12).toString("hex")}`;
		const controller = new AbortController();
		const onShutdown = () => controller.abort(this.#shutdown.signal.reason ?? new Error("STANDBY_SHUTDOWN"));
		this.#shutdown.signal.addEventListener("abort", onShutdown, { once: true });
		this.#ownedNames.add(name);

		const handle: WarmupHandle = {
			name,
			imageFingerprint,
			controller,
			done: Promise.resolve(),
		};
		const task = this.#warmOne(name, imageFingerprint, controller.signal)
			.then((entry) => {
				if (entry && !this.#closed && this.#activeFingerprints.has(imageFingerprint)) {
					this.#failureCounts.delete(imageFingerprint);
					const list = this.#ready.get(imageFingerprint) ?? [];
					if (list.length < this.#standbyPoolSize) {
						list.push(entry);
						this.#ready.set(imageFingerprint, list);
						this.#report({
							event: "coding-standby-ready",
							standbyName: entry.name,
							imageFingerprint,
							stateful: entry.stateful,
						});
					} else {
						this.#trackDestroy(this.#destroyStandbyVm(entry.name));
					}
				} else if (entry) {
					this.#trackDestroy(this.#destroyStandbyVm(entry.name));
				}
			})
			.catch((error) => {
				if (!this.#closed && !controller.signal.aborted) {
					const failures = (this.#failureCounts.get(imageFingerprint) ?? 0) + 1;
					this.#failureCounts.set(imageFingerprint, failures);
					const backoff = Math.min(60_000, this.#replenishBackoffMs * 2 ** Math.min(failures - 1, 4));
					this.#report({
						event: "coding-standby-warmup-failed",
						standbyName: name,
						imageFingerprint,
						backoffMs: backoff,
						error: error instanceof Error ? error.message : String(error),
					});
					this.#scheduleRetry(imageFingerprint, backoff);
				}
			})
			.finally(() => {
				this.#shutdown.signal.removeEventListener("abort", onShutdown);
				this.#warmups.delete(handle);
				if (!this.#closed) this.#ensureAllReplenished();
			});
		const mutableHandle = handle as { done: Promise<void> };
		mutableHandle.done = task;
		this.#warmups.add(handle);
	}

	async #warmOne(name: string, imageFingerprint: string, signal: AbortSignal): Promise<StandbyEntry | null> {
		let created = false;
		try {
			signal.throwIfAborted();
			if (this.#lxd.hasImage) {
				const exists = await this.#lxd.hasImage(this.#vmPolicy.project, imageFingerprint, signal);
				if (!exists) throw new Error("CODING_STANDBY_IMAGE_MISSING");
			}
			created = true;
			await this.#lxd.createInstance(
				this.#vmPolicy.project,
				{
					name,
					type: "virtual-machine",
					profiles: [],
					config: {
						"limits.cpu": String(this.#vmPolicy.cpus),
						"limits.memory": `${this.#vmPolicy.memoryBytes}`,
						"security.secureboot": "false",
						"user.qorpera.role": "coding-standby",
						"user.qorpera.standby_image": imageFingerprint,
					},
					devices: {
						root: {
							type: "disk",
							path: "/",
							pool: this.#vmPolicy.storagePool,
							size: `${this.#vmPolicy.rootDiskBytes}`,
						},
					},
					source: {
						type: "image",
						fingerprint: imageFingerprint,
					},
				},
				signal,
			);
			await this.#lxd.setInstancePower(this.#vmPolicy.project, name, "start", signal);
			await this.#awaitBootSettled(name, signal);

			let stateful = false;
			if (this.#preferStatefulSuspend) {
				try {
					await this.#lxd.setInstancePowerStateful(this.#vmPolicy.project, name, "stop", true, signal);
					stateful = true;
				} catch {
					if (signal.aborted) throw signal.reason;
					await this.#lxd.setInstancePowerStateful(this.#vmPolicy.project, name, "stop", false, signal, true);
				}
			} else {
				await this.#lxd.setInstancePowerStateful(this.#vmPolicy.project, name, "stop", false, signal, true);
			}
			signal.throwIfAborted();
			return {
				name,
				imageFingerprint,
				cpus: this.#vmPolicy.cpus,
				memoryBytes: this.#vmPolicy.memoryBytes,
				rootDiskBytes: this.#vmPolicy.rootDiskBytes,
				stateful,
				createdAt: Date.now(),
			};
		} catch (error) {
			if (created) await this.#destroyStandbyVm(name);
			else this.#ownedNames.delete(name);
			throw error;
		}
	}

	async #awaitBootSettled(name: string, signal: AbortSignal): Promise<void> {
		if (this.#waitForBootSettled) {
			await this.#waitForBootSettled(this.#vmPolicy.project, name, signal);
			return;
		}
		const deadline = Date.now() + this.#bootTimeoutMs;
		for (;;) {
			signal.throwIfAborted();
			if (this.#lxd.execInstancePipe) {
				try {
					const probe = await this.#lxd.execInstancePipe(
						this.#vmPolicy.project,
						name,
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
			} else {
				const inst = await this.#lxd.getInstance(this.#vmPolicy.project, name, signal);
				if (inst && (inst.status === "Running" || inst.statusCode === 103)) return;
			}
			if (Date.now() >= deadline) throw new Error("CODING_STANDBY_BOOT_TIMEOUT");
			await delayAbortable(this.#bootPollMs, signal);
		}
	}

	async #destroyStandbyVm(name: string): Promise<void> {
		const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
		try {
			const existing = await this.#lxd.getInstance(this.#vmPolicy.project, name, cleanupSignal);
			if (!existing) return;
			if (existing.status === "Running" || existing.statusCode === 103) {
				await this.#lxd
					.setInstancePowerStateful(this.#vmPolicy.project, name, "stop", false, cleanupSignal, true)
					.catch(() => this.#lxd.setInstancePower(this.#vmPolicy.project, name, "stop", cleanupSignal));
			}
			await this.#lxd.deleteInstance(this.#vmPolicy.project, name, cleanupSignal);
		} catch (error) {
			this.#report({
				event: "coding-standby-cleanup-failed",
				standbyName: name,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#ownedNames.delete(name);
		}
	}

	#trackDestroy(promise: Promise<void>): void {
		this.#destroyTasks.add(promise);
		void promise.finally(() => {
			this.#destroyTasks.delete(promise);
		});
	}

	#scheduleRetry(imageFingerprint: string, delayMs: number): void {
		if (this.#closed || this.#retryTimers.has(imageFingerprint)) return;
		const timer = setTimeout(() => {
			this.#retryTimers.delete(imageFingerprint);
			this.#ensureReplenished(imageFingerprint);
		}, delayMs);
		timer.unref();
		this.#retryTimers.set(imageFingerprint, timer);
	}

	#clearRetryTimer(imageFingerprint: string): void {
		const timer = this.#retryTimers.get(imageFingerprint);
		if (!timer) return;
		clearTimeout(timer);
		this.#retryTimers.delete(imageFingerprint);
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
