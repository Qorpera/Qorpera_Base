import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LxdOfficePreparationClient } from "./lxd-client.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import { checkDirectory } from "./lxd-office-journal-files.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const outageAttempt = new RegExp(`^outage-inspection-(${UUID})-(${UUID})-[0-9]{3}$`);

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
	const names = (await readdir(root)).filter(
		(name) =>
			/^(outage-configuration|outage-service-start|preparation|configuration|boot-configuration|boot-service-restart|boot-service-start|service-start|service-stop|service-restart|reset-configuration|reset-service-start|reset-service-restart)-[0-9a-f-]+$/.test(
				name,
			) || outageAttempt.test(name),
	);
	let next = 0;
	const outcomes = await Promise.allSettled(
		Array.from({ length: Math.min(8, names.length) }, async () => {
			let firstError: unknown;
			while (next < names.length && !signal.aborted) {
				const name = names[next++];
				try {
					let stateRoot = root,
						journalName = name;
					const attempt = outageAttempt.exec(name);
					if (attempt) {
						// Only the exact termination journal beneath a protected attempt
						// is eligible. Seed-only attempts have no command to observe.
						stateRoot = join(root, name);
						await checkDirectory(stateRoot);
						journalName = `outage-termination-${attempt[1]}-${attempt[2]}`;
						if (!(await readdir(stateRoot)).includes(journalName)) continue;
					}
					await LxdOfficeControlJournal.observeExisting(
						stateRoot,
						journalName,
						(reference, checked) => client.inspectOfficePreparation(reference, checked),
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
