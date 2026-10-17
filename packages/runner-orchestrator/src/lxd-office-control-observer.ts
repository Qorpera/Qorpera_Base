import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LxdOfficePreparationClient } from "./lxd-client.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import { checkDirectory, code } from "./lxd-office-journal-files.ts";

/** LXD retains a completed exec operation for only five seconds. Capture its
 * terminal fact while the lifecycle worker may be busy with other IO. Both
 * loops run in the same process under the service's kernel lock. Observation
 * cannot dispatch, infer missing results, activate a VM or release capacity. */
export async function observeLxdOfficeControlJournals(
	root: string,
	client: Pick<LxdOfficePreparationClient, "inspectOfficePreparation">,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	await checkDirectory(root);
	const names = (await readdir(root)).filter((name) =>
		/^(preparation|configuration|boot-configuration|boot-service-restart|boot-service-start|service-start|service-stop-retry|service-stop|service-restart|reset-configuration|reset-service-start|reset-service-restart)-[0-9a-f-]+$/.test(
			name,
		),
	);
	let next = 0;
	const outcomes = await Promise.allSettled(
		Array.from({ length: Math.min(8, names.length) }, async () => {
			let firstError: unknown;
			while (next < names.length && !signal.aborted) {
				const name = names[next++];
				try {
					await LxdOfficeControlJournal.observeExisting(
						root,
						name,
						(reference, checked) => client.inspectOfficePreparation(reference, checked),
						signal,
					);
				} catch (error) {
					// The stop worker may retire its preceding retry during this pass.
					// Only a vanished retry directory is gone; corrupted survivors fail.
					if (name.startsWith("service-stop-retry-")) {
						try {
							await lstat(join(root, name));
						} catch (gone) {
							if (code(gone, "ENOENT")) continue;
						}
					}
					firstError ??= error;
				}
			}
			if (firstError) throw firstError;
		}),
	);
	signal.throwIfAborted();
	if (outcomes.some((result) => result.status === "rejected"))
		throw new Error("OFFICE_CONTROL_OBSERVATION_UNCONFIRMED");
}

export async function runLxdOfficeControlObserver(
	observe: (signal: AbortSignal) => Promise<void>,
	signal: AbortSignal,
	onError: () => void,
) {
	while (!signal.aborted) {
		try {
			await observe(signal);
		} catch {
			if (!signal.aborted) {
				try {
					onError();
				} catch {}
			}
		}
		if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => {});
	}
}
