import type { LxdOfficeServiceStartClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
export interface LxdOfficeServiceStartIdentity extends LxdOfficeControlIdentity {
	configurationObservationSha256: string;
}
/** One durable ordinary-service start. Unknown submissions are never repeated.
 * Requires the supervisor's kernel lock and freshly checked authority. */
export class LxdOfficeServiceStartJournal {
	readonly #journal: LxdOfficeControlJournal;
	private constructor(journal: LxdOfficeControlJournal) {
		this.#journal = journal;
	}
	static async open(
		stateRoot: string,
		identity: LxdOfficeServiceStartIdentity,
		client: Pick<LxdOfficeServiceStartClient, "submitOfficeServiceStart" | "inspectOfficeServiceStart">,
		existing = true,
	): Promise<LxdOfficeServiceStartJournal> {
		return new LxdOfficeServiceStartJournal(
			await LxdOfficeControlJournal.open(
				stateRoot,
				identity,
				{
					submit: (...args) => client.submitOfficeServiceStart(...args),
					inspect: (...args) => client.inspectOfficeServiceStart(...args),
				},
				existing,
				"service-start",
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
