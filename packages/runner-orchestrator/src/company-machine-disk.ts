import type { LxdStoragePoolUse } from "./lxd-client.ts";

/** What an executor tells the kernel of its storage pool (qorpera_report_executor_disk, 20260930757000). */
export interface CompanyMachineDiskReport {
	schema: "qorpera.machine-executor-disk/v1";
	pool: string;
	totalBytes: number;
	usedBytes: number;
	/** By placement id: what that placement's disk holds of its own (what deleting it frees). */
	placements: Record<string, number>;
}

/** The kernel's disk report from LXD's reading of `pool`: the pool's own figures, and each placement of `named` (its LXD
 * instance name to its placement id) whose disk LXD gave a use for. A name LXD gave that is not named is left out; so
 * is a named one LXD gave nothing for, whose use the kernel then does not know (and never gives away for room). */
export function companyMachineDiskReport(
	pool: string,
	use: LxdStoragePoolUse,
	named: ReadonlyMap<string, string>,
): CompanyMachineDiskReport {
	const placements: Record<string, number> = {};
	for (const [name, bytes] of use.volumes) {
		const placementId = named.get(name);
		if (placementId !== undefined) placements[placementId] = bytes;
	}
	return {
		schema: "qorpera.machine-executor-disk/v1",
		pool,
		totalBytes: use.totalBytes,
		usedBytes: use.usedBytes,
		placements,
	};
}
