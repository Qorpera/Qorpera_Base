import type { LxdOfficeServiceStopClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";

export interface LxdOfficeServiceStopIdentity extends LxdOfficeControlIdentity {
	transitionId: string;
	revocationSha256: string;
	startObservationSha256: string;
}
/** One durable stop dispatch for one explicit lifecycle transition. Requires
 * the supervisor's kernel lock, retained SQL revocation and current physical
 * authority. An uncertain submission is only observed, never repeated. */
export class LxdOfficeServiceStopJournal {
	readonly #journal: LxdOfficeControlJournal;
	private constructor(journal: LxdOfficeControlJournal) {
		this.#journal = journal;
	}
	static async open(
		stateRoot: string,
		identity: LxdOfficeServiceStopIdentity,
		client: Pick<LxdOfficeServiceStopClient, "submitOfficeServiceStop" | "inspectOfficeServiceStop">,
		existing = true,
	): Promise<LxdOfficeServiceStopJournal> {
		return new LxdOfficeServiceStopJournal(
			await LxdOfficeControlJournal.open(
				stateRoot,
				identity,
				{
					submit: (...args) => client.submitOfficeServiceStop(...args),
					inspect: (...args) => client.inspectOfficeServiceStop(...args),
				},
				existing,
				"service-stop",
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
