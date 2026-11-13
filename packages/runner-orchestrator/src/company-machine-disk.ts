import type { LxdStoragePoolSpace, LxdStoragePoolUseClient } from "./lxd-client.ts";

/** What an executor tells the kernel of its storage pool (qorpera_report_executor_disk, 20260930757000). */
export interface CompanyMachineDiskReport {
	schema: "qorpera.machine-executor-disk/v1";
	pool: string;
	totalBytes: number;
	usedBytes: number;
	/** By placement id: what that placement's disk holds of its own (what deleting it frees). */
	placements: Record<string, number>;
}

/** The most placements one report names: the kernel refuses more (qorpera_report_executor_disk). A placement a report
 * does not name is of unknown use: the kernel holds an awake one's whole disk as growth and never gives a sleeping one
 * away for room, so a report that names fewer is never less safe, only less able to make room. */
export const COMPANY_MACHINE_DISK_REPORT_MAX = 1024;
/** A sleeping disk cannot change, so its read is kept and not made again while it sleeps the same sleep; but only a read
 * made at least this long after it fell asleep (its list's asleepSince): ZFS's accounting of the last writes may lag the
 * stop, and the kernel holds a disk's growth until 30 s after it fell asleep. 60 s is past both, with room for the
 * node's clock against the database's. */
export const COMPANY_MACHINE_DISK_KEEP_AFTER_MS = 60_000;
/** How long one report may spend reading disks before it reads the pool and sends what it has. On node 2 (13 Nov 2026)
 * a disk read took 4.5 ms (5.1 at worst): about 2,000 reads. */
export const COMPANY_MACHINE_DISK_READ_BUDGET_MS = 10_000;

/** A placement of this executor as its list gives it: its LXD disk and since when it sleeps (null: awake). */
export interface CompanyMachineDiskPlacement {
	placementId: string;
	project: string;
	name: string;
	asleepSince: string | null;
}

export interface CompanyMachineDiskReading {
	report: CompanyMachineDiskReport;
	/** Disks read now. */
	reads: number;
	/** Sleeping disks named from a kept read, not read now. */
	fromKept: number;
	/** Listed placements the report does not name (unknown use: never given away, an awake one held whole). */
	unknown: number;
}

/** The executor's reader of its pool for the kernel's disk report (20260930757000; the coordinator's word after review
 * of #1773, 13 Nov 2026: the report must hold with many disks). One read reads the awake disks first (they may grow),
 * then the sleeping ones it keeps no read of, the most recently asleep first, as many as `readBudgetMs` and the report's
 * limit allow (the rest on later reads), then the pool last, so a write while it reads is in the pool's used bytes and
 * never credited to a disk. It names the awake disks first, then those read now, then the kept reads. A disk read that
 * fails leaves that disk unknown; a pool read that fails fails the read (no report: the kernel falls back to its paper
 * budget once its last report is 2 minutes old). After a restart nothing is kept: the first reads read every sleeping
 * disk again, within the budget each. */
export class CompanyMachineDiskReader {
	readonly #client: LxdStoragePoolUseClient;
	readonly #pool: string;
	readonly #now: () => number;
	readonly #budgetMs: number;
	readonly #max: number;
	readonly #kept = new Map<string, { asleepSince: string; bytes: number }>();

	constructor(options: {
		client: LxdStoragePoolUseClient;
		pool: string;
		now?: () => number;
		readBudgetMs?: number;
		max?: number;
	}) {
		this.#client = options.client;
		this.#pool = options.pool;
		this.#now = options.now ?? Date.now;
		this.#budgetMs = options.readBudgetMs ?? COMPANY_MACHINE_DISK_READ_BUDGET_MS;
		this.#max = options.max ?? COMPANY_MACHINE_DISK_REPORT_MAX;
	}

	/** How many sleeping disks' reads are kept. */
	get kept(): number {
		return this.#kept.size;
	}

	async read(
		placements: readonly CompanyMachineDiskPlacement[],
		signal: AbortSignal,
	): Promise<CompanyMachineDiskReading> {
		const listed = new Map(placements.map((placement) => [placement.placementId, placement]));
		// A kept read holds only while its placement sleeps the same sleep: gone, awake or asleep anew, it is read again.
		for (const [placementId, kept] of this.#kept)
			if (listed.get(placementId)?.asleepSince !== kept.asleepSince) this.#kept.delete(placementId);
		const awake = placements.filter((placement) => placement.asleepSince === null);
		const unkept = placements
			.filter((placement) => placement.asleepSince !== null && !this.#kept.has(placement.placementId))
			.sort(
				(a, b) =>
					Date.parse(b.asleepSince as string) - Date.parse(a.asleepSince as string) ||
					a.placementId.localeCompare(b.placementId),
			);
		const read = new Map<string, number>();
		const deadline = this.#now() + this.#budgetMs;
		let reads = 0;
		for (const placement of [...awake, ...unkept]) {
			if (reads >= this.#max || this.#now() >= deadline) break;
			signal.throwIfAborted();
			let bytes: number | undefined;
			try {
				bytes = await this.#client.readStorageVolumeUse(this.#pool, placement.project, placement.name, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				bytes = undefined;
			}
			reads++;
			if (bytes === undefined) continue;
			read.set(placement.placementId, bytes);
			if (
				placement.asleepSince !== null &&
				this.#now() >= Date.parse(placement.asleepSince) + COMPANY_MACHINE_DISK_KEEP_AFTER_MS
			)
				this.#kept.set(placement.placementId, { asleepSince: placement.asleepSince, bytes });
		}
		const space = await this.#client.readStoragePoolSpace(this.#pool, signal);
		const named: Record<string, number> = {};
		let count = 0;
		const name = (placementId: string, bytes: number): void => {
			if (count >= this.#max || bytes > space.totalBytes || placementId in named) return;
			named[placementId] = bytes;
			count++;
		};
		for (const placement of awake) {
			const bytes = read.get(placement.placementId);
			if (bytes !== undefined) name(placement.placementId, bytes);
		}
		for (const [placementId, bytes] of read) name(placementId, bytes);
		let fromKept = 0;
		for (const [placementId, kept] of this.#kept)
			if (!read.has(placementId) && !(placementId in named) && count < this.#max && kept.bytes <= space.totalBytes) {
				name(placementId, kept.bytes);
				fromKept++;
			}
		return {
			report: companyMachineDiskReport(this.#pool, space, named),
			reads,
			fromKept,
			unknown: placements.length - count,
		};
	}
}

/** The kernel's disk report: the pool's own figures and the placements' own use, by placement id. */
export function companyMachineDiskReport(
	pool: string,
	space: LxdStoragePoolSpace,
	placements: Record<string, number>,
): CompanyMachineDiskReport {
	return {
		schema: "qorpera.machine-executor-disk/v1",
		pool,
		totalBytes: space.totalBytes,
		usedBytes: space.usedBytes,
		placements,
	};
}
