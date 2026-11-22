import { randomBytes, randomUUID } from "node:crypto";
import { CODING_MACHINE_BASE_CONFIG, type CodingMachineStandbyClaim } from "./coding-machine.ts";
import type { LxdClient, LxdCreateInstanceRequest, LxdImageClient, LxdStandbyClient } from "./lxd-client.ts";

export const CODING_STANDBY_SCHEMA = "qorpera.coding-standby/v1";
export const CODING_STANDBY_VM_PREFIX = "qorpera-coding-standby-";
export const CODING_STANDBY_VM_NAME = /^qorpera-coding-standby-[0-9a-f]{24}$/;
export const CODING_STANDBY_MAX_POOL_SIZE = 8;
export const CODING_STANDBY_DEFAULT_MAX_FINGERPRINTS = 4;

const HEX_64 = /^[0-9a-f]{64}$/;

export type CodingStandbyLxdClient = Pick<
	LxdClient,
	"getInstance" | "createInstance" | "setInstancePower" | "deleteInstance"
> &
	LxdStandbyClient &
	Partial<LxdImageClient>;

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
	readonly replenishBackoffMs?: number;
	readonly cleanupTimeoutMs?: number;
	readonly report?: (event: Record<string, unknown>) => void;
}

interface StandbyEntry {
	readonly name: string;
	readonly imageFingerprint: string;
	readonly cpus: number;
	readonly memoryBytes: number;
	readonly rootDiskBytes: number;
	readonly createdAt: number;
}

interface ProvisionHandle {
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
	readonly #replenishBackoffMs: number;
	readonly #cleanupTimeoutMs: number;
	readonly #report: (event: Record<string, unknown>) => void;

	readonly #shutdown = new AbortController();
	readonly #activeFingerprints = new Set<string>();
	readonly #ready = new Map<string, StandbyEntry[]>();
	readonly #provisions = new Set<ProvisionHandle>();
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
		this.#replenishBackoffMs = options.replenishBackoffMs ?? 5_000;
		this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
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
		const matching: Promise<void>[] = [];
		for (const handle of this.#provisions) {
			if (handle.imageFingerprint === imageFingerprint) {
				handle.controller.abort(new Error("STANDBY_FINGERPRINT_INVALIDATED"));
				matching.push(handle.done.catch(() => undefined));
			}
		}
		const entries = this.#ready.get(imageFingerprint) ?? [];
		this.#ready.delete(imageFingerprint);
		await Promise.all([...matching, ...entries.map((entry) => this.#destroyStandbyVm(entry.name))]);
		if (!this.#closed && this.#standbyPoolSize > 0) this.#ensureAllReplenished();
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
			if (!existing || existing.status !== "Stopped" || existing.statusCode !== 102) {
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
			});
			return { operationId: randomUUID() };
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
		while (this.#provisions.size > 0 || this.#destroyTasks.size > 0) {
			await Promise.all([
				...[...this.#provisions].map((h) => h.done.catch(() => undefined)),
				...[...this.#destroyTasks].map((p) => p.catch(() => undefined)),
			]);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#shutdown.abort(new Error("CODING_STANDBY_POOL_CLOSED"));
		for (const timer of this.#retryTimers.values()) clearTimeout(timer);
		this.#retryTimers.clear();
		for (const handle of this.#provisions) {
			handle.controller.abort(new Error("CODING_STANDBY_POOL_CLOSED"));
		}
		await Promise.all([...this.#provisions].map((h) => h.done.catch(() => undefined)));
		const toDelete: string[] = [];
		for (const list of this.#ready.values()) {
			for (const entry of list) toDelete.push(entry.name);
		}
		this.#ready.clear();
		await Promise.all(toDelete.map((name) => this.#destroyStandbyVm(name)));
		await Promise.all([...this.#destroyTasks].map((p) => p.catch(() => undefined)));
	}

	#totalAllocated(): number {
		return this.readyCount() + this.#provisions.size;
	}

	#ensureAllReplenished(): void {
		if (this.#closed || this.#standbyPoolSize === 0) return;
		if (this.#totalAllocated() >= this.#standbyPoolSize) return;
		const candidates = [...this.#activeFingerprints].sort((a, b) => this.readyCount(a) - this.readyCount(b));
		for (const fp of candidates) {
			this.#ensureReplenished(fp);
			if (this.#provisions.size >= 1 || this.#totalAllocated() >= this.#standbyPoolSize) break;
		}
	}

	#ensureReplenished(imageFingerprint: string): void {
		if (this.#closed || this.#standbyPoolSize === 0) return;
		if (!this.#activeFingerprints.has(imageFingerprint)) return;
		if (this.#retryTimers.has(imageFingerprint)) return;
		if (this.#totalAllocated() >= this.#standbyPoolSize) return;
		if (this.#provisions.size >= 1) return;
		this.#launchProvision(imageFingerprint);
	}

	#launchProvision(imageFingerprint: string): void {
		const name = `${CODING_STANDBY_VM_PREFIX}${randomBytes(12).toString("hex")}`;
		const controller = new AbortController();
		const onShutdown = () => controller.abort(this.#shutdown.signal.reason ?? new Error("STANDBY_SHUTDOWN"));
		this.#shutdown.signal.addEventListener("abort", onShutdown, { once: true });
		this.#ownedNames.add(name);

		const handle: ProvisionHandle = {
			name,
			imageFingerprint,
			controller,
			done: Promise.resolve(),
		};
		const task = this.#provisionOne(name, imageFingerprint, controller.signal)
			.then((entry) => {
				if (
					entry &&
					!this.#closed &&
					this.#activeFingerprints.has(imageFingerprint) &&
					this.readyCount() < this.#standbyPoolSize
				) {
					this.#failureCounts.delete(imageFingerprint);
					const list = this.#ready.get(imageFingerprint) ?? [];
					list.push(entry);
					this.#ready.set(imageFingerprint, list);
					this.#report({
						event: "coding-standby-ready",
						standbyName: entry.name,
						imageFingerprint,
					});
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
						event: "coding-standby-provision-failed",
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
				this.#provisions.delete(handle);
				if (!this.#closed) this.#ensureAllReplenished();
			});
		const mutableHandle = handle as { done: Promise<void> };
		mutableHandle.done = task;
		this.#provisions.add(handle);
	}

	async #provisionOne(name: string, imageFingerprint: string, signal: AbortSignal): Promise<StandbyEntry> {
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
						...CODING_MACHINE_BASE_CONFIG,
						"limits.cpu": String(this.#vmPolicy.cpus),
						"limits.memory": `${this.#vmPolicy.memoryBytes}`,
						"user.qorpera.schema": CODING_STANDBY_SCHEMA,
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
			signal.throwIfAborted();
			return {
				name,
				imageFingerprint,
				cpus: this.#vmPolicy.cpus,
				memoryBytes: this.#vmPolicy.memoryBytes,
				rootDiskBytes: this.#vmPolicy.rootDiskBytes,
				createdAt: Date.now(),
			};
		} catch (error) {
			if (created) await this.#destroyStandbyVm(name);
			else this.#ownedNames.delete(name);
			throw error;
		}
	}

	async #destroyStandbyVm(name: string): Promise<void> {
		const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
		try {
			const existing = await this.#lxd.getInstance(this.#vmPolicy.project, name, cleanupSignal);
			if (!existing) return;
			if (existing.status === "Running" || existing.statusCode === 103) {
				await this.#lxd.setInstancePower(this.#vmPolicy.project, name, "stop", cleanupSignal);
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
