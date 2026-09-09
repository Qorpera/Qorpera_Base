import type { LxdOfficeBootServiceStartClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";

export interface LxdOfficeBootServiceStartIdentity extends LxdOfficeControlIdentity {
	activationId: string;
	bootIntentId: string;
	configurationObservationSha256: string;
}
/** One ordinary-service dispatch for a configured retained boot. Current SQL
 * successor authority and independent root completion remain caller-owned. */
export function openLxdOfficeBootServiceStartJournal(
	root: string,
	identity: LxdOfficeBootServiceStartIdentity,
	client: Pick<LxdOfficeBootServiceStartClient, "submitOfficeBootServiceStart" | "inspectOfficeBootServiceStart">,
	existing = true,
) {
	return LxdOfficeControlJournal.open(
		root,
		identity,
		{
			submit: (...args) => client.submitOfficeBootServiceStart(...args),
			inspect: (...args) => client.inspectOfficeBootServiceStart(...args),
		},
		existing,
		"boot-service-start",
	);
}
