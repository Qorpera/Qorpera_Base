import type { LxdOfficeResetServiceRestartClient } from "./lxd-client.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import type { LxdOfficeServiceRestartIdentity } from "./lxd-office-service-restart-journal.ts";
export interface LxdOfficeResetServiceRestartIdentity extends LxdOfficeServiceRestartIdentity {
	resetId: string;
	rootIncarnationId: string;
	originActivationId: string;
}
/** Distinct restart dispatch, binding the immutable reset origin as well as
 * the acknowledged immediate predecessor. Unknown outcomes never retry. */
export function openLxdOfficeResetServiceRestartJournal(
	root: string,
	identity: LxdOfficeResetServiceRestartIdentity,
	client: Pick<
		LxdOfficeResetServiceRestartClient,
		"submitOfficeResetServiceRestart" | "inspectOfficeResetServiceRestart"
	>,
	existing = true,
) {
	return LxdOfficeControlJournal.open(
		root,
		identity,
		{
			submit: (...args) => client.submitOfficeResetServiceRestart(...args),
			inspect: (...args) => client.inspectOfficeResetServiceRestart(...args),
		},
		existing,
		"reset-service-restart",
	);
}
