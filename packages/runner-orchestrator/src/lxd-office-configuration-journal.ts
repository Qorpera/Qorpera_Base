import type { LxdOfficeConfigurationClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
export interface LxdOfficeConfigurationIdentity extends LxdOfficeControlIdentity {
	preparationObservationSha256: string;
}

/** One separately journaled configuration command bound to acknowledged guest
 * preparation. Stores no credential values. The worker must hold the kernel
 * lock, retain the identity and recheck current authority before every effect. */
export class LxdOfficeConfigurationJournal {
	readonly #journal: LxdOfficeControlJournal;
	private constructor(journal: LxdOfficeControlJournal) {
		this.#journal = journal;
	}
	static async open(
		stateRoot: string,
		identity: LxdOfficeConfigurationIdentity,
		client: Pick<LxdOfficeConfigurationClient, "submitOfficeConfiguration" | "inspectOfficeConfiguration">,
		existing = true,
	): Promise<LxdOfficeConfigurationJournal> {
		return new LxdOfficeConfigurationJournal(
			await LxdOfficeControlJournal.open(
				stateRoot,
				identity,
				{
					submit: (...args) => client.submitOfficeConfiguration(...args),
					inspect: (...args) => client.inspectOfficeConfiguration(...args),
				},
				existing,
				"configuration",
			),
		);
	}
	reconcile(signal: AbortSignal) {
		return this.#journal.reconcile(signal);
	}
	observe(signal: AbortSignal) {
		return this.#journal.observe(signal);
	}
}
