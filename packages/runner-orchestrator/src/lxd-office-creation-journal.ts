import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LxdTrackedClient } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, parseLxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import {
	assertLxdOfficePhysicalBinding,
	type LxdOfficePhysicalPolicy,
	lxdOfficePhysicalPolicySha256,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface LxdOfficeCreationIdentity {
	schema: "qorpera.lxd-office-creation/v1";
	intentId: string;
	binding: Readonly<LxdOfficeGuestBinding>;
	createCommandId: string;
}

/** One durable allocation and create command per accepted intent, chosen
 * before SQL reservation. Losing either local record after allocation is an
 * explicit recovery problem, never permission to mint a replacement. */
export async function openLxdOfficeCreationIdentity(
	value: LxdOfficePhysicalPolicy,
	intentId: string,
	existing: boolean,
	client: Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">,
	signal: AbortSignal,
): Promise<Readonly<LxdOfficeCreationIdentity>> {
	const policy = parseLxdOfficePhysicalPolicy(value);
	if (!UUID.test(intentId)) throw new Error("INVALID_OFFICE_CREATION_INTENT");
	signal.throwIfAborted();
	const root = policy.journal.path;
	await checkDirectory(root);
	const name = `intent-${intentId}.json`;
	let result: unknown;
	try {
		result = (await readRecord(join(root, name))).value;
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		if (existing) throw new Error("OFFICE_CREATION_JOURNAL_MISSING");
		signal.throwIfAborted();
		const candidate: LxdOfficeCreationIdentity = {
			schema: "qorpera.lxd-office-creation/v1",
			intentId,
			binding: parseLxdOfficeGuestBinding({
				schema: "qorpera.lxd-office-guest/v2",
				...policy.guest,
				allocationId: randomUUID(),
				providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
			}),
			createCommandId: randomUUID(),
		};
		// Publish the empty operation journal first. Once an intent index is
		// visible, no reader is allowed to recreate a missing operation journal,
		// even from a stale pre-reservation cloud snapshot. Losing the race may
		// leave an unallocated local directory; it grants no cloud/VM authority.
		await LxdOfficeOperationJournal.open(root, intentId, candidate.binding, client);
		signal.throwIfAborted();
		await publish(root, name, Buffer.from(`${JSON.stringify(candidate)}\n`));
		result = (await readRecord(join(root, name))).value;
	}
	const record = officeRecord(result, ["schema", "intentId", "binding", "createCommandId"]);
	if (
		record.schema !== "qorpera.lxd-office-creation/v1" ||
		record.intentId !== intentId ||
		typeof record.createCommandId !== "string" ||
		!UUID.test(record.createCommandId)
	)
		throw new Error("OFFICE_CREATION_JOURNAL_UNCONFIRMED");
	const binding = parseLxdOfficeGuestBinding(record.binding);
	assertLxdOfficePhysicalBinding(policy, binding);
	// A surviving reader also syncs a concurrently published directory entry
	// before any cloud reservation can refer to it.
	await syncDirectory(root);
	signal.throwIfAborted();
	return Object.freeze({
		schema: "qorpera.lxd-office-creation/v1",
		intentId,
		binding,
		createCommandId: record.createCommandId,
	});
}
