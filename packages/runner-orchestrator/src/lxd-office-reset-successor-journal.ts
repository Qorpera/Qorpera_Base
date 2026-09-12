import type { LxdOfficeResetSuccessorClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";

export interface LxdOfficeResetConfigurationIdentity extends LxdOfficeControlIdentity {
	activationId: string;
	resetId: string;
	originPreparationSha256: string;
}
export interface LxdOfficeResetServiceStartIdentity extends LxdOfficeControlIdentity {
	activationId: string;
	resetId: string;
	configurationObservationSha256: string;
}
/** One root configuration command per reset successor activation on the
 * recreated root. Unknown dispatch cannot be retried; current authority is
 * the reset worker's job. */
export function openLxdOfficeResetConfigurationJournal(
	root: string,
	identity: LxdOfficeResetConfigurationIdentity,
	client: Pick<LxdOfficeResetSuccessorClient, "submitOfficeResetConfiguration" | "inspectOfficeResetConfiguration">,
	existing = true,
) {
	return LxdOfficeControlJournal.open(
		root,
		identity,
		{
			submit: (...args) => client.submitOfficeResetConfiguration(...args),
			inspect: (...args) => client.inspectOfficeResetConfiguration(...args),
		},
		existing,
		"reset-configuration",
	);
}
/** One ordinary-service dispatch for the configured reset successor. Current
 * SQL successor authority and independent root completion remain caller-owned. */
export function openLxdOfficeResetServiceStartJournal(
	root: string,
	identity: LxdOfficeResetServiceStartIdentity,
	client: Pick<LxdOfficeResetSuccessorClient, "submitOfficeResetServiceStart" | "inspectOfficeResetServiceStart">,
	existing = true,
) {
	return LxdOfficeControlJournal.open(
		root,
		identity,
		{
			submit: (...args) => client.submitOfficeResetServiceStart(...args),
			inspect: (...args) => client.inspectOfficeResetServiceStart(...args),
		},
		existing,
		"reset-service-start",
	);
}
