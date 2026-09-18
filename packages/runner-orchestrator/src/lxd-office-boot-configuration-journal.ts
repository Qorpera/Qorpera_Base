import type { LxdOfficeBootConfigurationClient } from "./lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";

export interface LxdOfficeBootConfigurationIdentity extends LxdOfficeControlIdentity {
	activationId: string;
	bootIntentId: string;
	originPreparationSha256: string;
}
/** One root configuration command per planned new activation. Unknown dispatch
 * cannot be retried. Contains hashes only; current authority is the worker's job. */
export function openLxdOfficeBootConfigurationJournal(
	root: string,
	identity: LxdOfficeBootConfigurationIdentity,
	client: Pick<LxdOfficeBootConfigurationClient, "submitOfficeBootConfiguration" | "inspectOfficeBootConfiguration">,
	existing = true,
) {
	return LxdOfficeControlJournal.open(
		root,
		identity,
		{
			submit: (...args) => client.submitOfficeBootConfiguration(...args),
			inspect: (...args) => client.inspectOfficeBootConfiguration(...args),
		},
		existing,
		"boot-configuration",
	);
}
