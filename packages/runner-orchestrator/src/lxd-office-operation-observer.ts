import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LxdTrackedClient } from "./lxd-client.ts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { checkDirectory, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { readLxdOfficeOutageVmLineage } from "./lxd-office-outage-history.ts";
import type { LxdOfficeOutageVmOrigin } from "./lxd-office-vm-lineage.ts";

/** VM task results have the same short LXD retention as guest exec results.
 * Scan independently of cloud reconciliation and guest control IO. The caller
 * holds the existing process kernel lock; only accepted operation IDs are read.
 * No missing result, VM absence or elapsed time establishes completion. */
export async function observeLxdOfficeOperationJournals(
	root: string,
	client: Pick<LxdTrackedClient, "inspectInstanceOperation">,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	await checkDirectory(root);
	const files = await readdir(root),
		names = files.filter((name) =>
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name),
		);
	let next = 0;
	const outcomes = await Promise.allSettled(
		Array.from({ length: Math.min(8, names.length) }, async () => {
			let firstError: unknown;
			while (next < names.length && !signal.aborted) {
				const name = names[next++];
				try {
					let selectedRoot = root;
					let origin: LxdOfficeOutageVmOrigin | undefined;
					if (files.some((file) => file.startsWith(`outage-recovery-${name}-`) && file.endsWith(".json"))) {
						const main = await LxdOfficeOperationJournal.readHistory(root, name);
						const creation = (await readRecord(join(root, `intent-${main.intentId}.json`)))
							.value as LxdOfficeCreationIdentity;
						if (
							creation.schema !== "qorpera.lxd-office-creation/v1" ||
							creation.intentId !== main.intentId ||
							creation.binding.allocationId !== name
						)
							throw new Error("OFFICE_OUTAGE_CREATION_DIFFERS");
						const selected = await readLxdOfficeOutageVmLineage(root, creation);
						selectedRoot = selected.segmentRoot;
						origin = selected.origin;
					}
					await LxdOfficeOperationJournal.observeExisting(
						selectedRoot,
						name,
						(reference, checked) => client.inspectInstanceOperation(reference, checked),
						signal,
						origin,
					);
				} catch (error) {
					firstError ??= error;
				}
			}
			if (firstError) throw firstError;
		}),
	);
	signal.throwIfAborted();
	if (outcomes.some((result) => result.status === "rejected"))
		throw new Error("OFFICE_VM_OPERATION_OBSERVATION_UNCONFIRMED");
}
