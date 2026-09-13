import { readdir } from "node:fs/promises";
import type { LxdTrackedClient } from "./lxd-client.ts";
import { checkDirectory } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";

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
	const names = (await readdir(root)).filter((name) =>
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name),
	);
	let next = 0;
	const outcomes = await Promise.allSettled(
		Array.from({ length: Math.min(8, names.length) }, async () => {
			let firstError: unknown;
			while (next < names.length && !signal.aborted) {
				const name = names[next++];
				try {
					await LxdOfficeOperationJournal.observeExisting(
						root,
						name,
						(reference, checked) => client.inspectInstanceOperation(reference, checked),
						signal,
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
