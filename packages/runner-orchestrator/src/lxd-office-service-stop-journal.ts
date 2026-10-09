import type { LxdOfficeServiceStopClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";

export interface LxdOfficeServiceStopIdentity extends LxdOfficeControlIdentity {
	transitionId: string;
	revocationSha256: string;
	startObservationSha256: string;
	attempt?: number;
}
/** One durable stop dispatch for one explicit lifecycle transition. Requires
 * the supervisor's kernel lock, retained SQL revocation and current physical
 * authority. Each journal only observes an uncertain submission. The stop worker may create a
 * separate retry attempt of the same command after its durable backoff. */
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
				identity.attempt === undefined ? "service-stop" : "service-stop-retry",
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
