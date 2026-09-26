import type { LxdOfficeBootServiceRestartClient } from "./lxd-client.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import type { LxdOfficeServiceRestartIdentity } from "./lxd-office-service-restart-journal.ts";
export type LxdOfficeBootServiceRestartIdentity = LxdOfficeServiceRestartIdentity & {
	originActivationId: string;
} & ({ bootIntentId: string; recoveryId?: never } | { recoveryId: string; bootIntentId?: never });
/** Distinct restart dispatch, binding the immutable boot origin as well as
 * the acknowledged immediate predecessor. Unknown outcomes never retry. */
export function openLxdOfficeBootServiceRestartJournal(
	root: string,
	identity: LxdOfficeBootServiceRestartIdentity,
	client: Pick<
		LxdOfficeBootServiceRestartClient,
		"submitOfficeBootServiceRestart" | "inspectOfficeBootServiceRestart"
	>,
	existing = true,
) {
	return LxdOfficeControlJournal.open(
		root,
		identity,
		{
			submit: (...args) => client.submitOfficeBootServiceRestart(...args),
			inspect: (...args) => client.inspectOfficeBootServiceRestart(...args),
		},
		existing,
		"boot-service-restart",
	);
}
