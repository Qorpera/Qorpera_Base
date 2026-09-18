import type { LxdOfficePreparationClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
export type LxdOfficePreparationIdentity = Omit<LxdOfficeControlIdentity, "preparationObservationSha256">;
export type { LxdOfficeControlOperationResult as LxdOfficePreparationOperationResult } from "./lxd-office-control-journal.ts";

/** Preserves the original preparation journal format and fixed helper lane. */
export class LxdOfficePreparationJournal {
	readonly #journal: LxdOfficeControlJournal;
	private constructor(journal: LxdOfficeControlJournal) {
		this.#journal = journal;
	}
	static async open(
		stateRoot: string,
		identity: LxdOfficePreparationIdentity,
		client: Pick<LxdOfficePreparationClient, "submitOfficePreparation" | "inspectOfficePreparation">,
		existing = true,
	): Promise<LxdOfficePreparationJournal> {
		return new LxdOfficePreparationJournal(
			await LxdOfficeControlJournal.open(
				stateRoot,
				identity,
				{
					submit: (...args) => client.submitOfficePreparation(...args),
					inspect: (...args) => client.inspectOfficePreparation(...args),
				},
				existing,
				"preparation",
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
