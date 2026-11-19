/**
 * The records of a member's repository snapshots on this node (5h-2; deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
 * "Setup file and snapshots"; migration 20260930435000). SQL decides at attach whether this node's snapshot is current,
 * whether a build runs elsewhere, whether the last one failed, or whether the caller builds; it keeps the build's lease
 * and log, and names the images the node may keep. The builder VMs and the setup at attach are 5h-3's.
 */
export const CODING_SNAPSHOT_RPCS = [
	"qorpera_begin_coding_snapshot_build",
	"qorpera_renew_coding_snapshot_build",
	"qorpera_finish_coding_snapshot_build",
	"qorpera_list_coding_snapshots",
	"qorpera_record_coding_snapshot_removed",
] as const;
