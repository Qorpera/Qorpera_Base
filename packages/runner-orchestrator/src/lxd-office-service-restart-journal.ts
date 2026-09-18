import type { LxdOfficeServiceRestartClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";

export interface LxdOfficeServiceRestartIdentity extends LxdOfficeControlIdentity {
	activationId: string;
	transitionId: string;
	configurationObservationSha256: string;
	stopObservationSha256: string;
}
/** One durable successor dispatch, indexed by its distinct activation. The
 * command digest binds the complete prepared successor and acknowledged stop.
 * The supervisor must hold the real kernel lock and revalidate current SQL and
 * physical authority before dispatch. Unknown outcomes are only observed. */
export class LxdOfficeServiceRestartJournal {
	readonly #journal: LxdOfficeControlJournal;
	private constructor(journal: LxdOfficeControlJournal) {
		this.#journal = journal;
	}
	static async open(
		stateRoot: string,
		identity: LxdOfficeServiceRestartIdentity,
		client: Pick<LxdOfficeServiceRestartClient, "submitOfficeServiceRestart" | "inspectOfficeServiceRestart">,
		existing = true,
	): Promise<LxdOfficeServiceRestartJournal> {
		return new LxdOfficeServiceRestartJournal(
			await LxdOfficeControlJournal.open(
				stateRoot,
				identity,
				{
					submit: (...args) => client.submitOfficeServiceRestart(...args),
					inspect: (...args) => client.inspectOfficeServiceRestart(...args),
				},
				existing,
				"service-restart",
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
