import { join } from "node:path";
import {
	assertLxdOfficeDeleteDispositionContext,
	type LxdOfficeDeleteDispositionContext,
} from "./lxd-office-delete-disposition.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { assertLxdOfficeDeleteDispositionPhases } from "./lxd-office-operation-completion.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { LxdOfficeResetJournal } from "./lxd-office-reset-journal.ts";

/** Complete only the two local metadata publications for an already committed
 * and root-reconciled SQL disposition. The operator keeps the installation
 * and adoption locks, stopped provider and fresh physical fence throughout.
 * This module has no SQL transport, VM client or service-start capability.
 * Each publication can fail after becoming durable; a later exact invocation
 * validates what exists and supplies only the missing publication. */
export async function reconcileLxdOfficeDeleteMetadata(
	root: string,
	context: LxdOfficeDeleteDispositionContext,
	assertPublicationBoundary: () => Promise<void>,
) {
	assertLxdOfficeDeleteDispositionContext(context);
	await assertPublicationBoundary();
	const allocationId = context.plan.predecessor.startup.allocationId;
	const before = await LxdOfficeOperationJournal.readHistory(root, allocationId);
	const phases = await LxdOfficeResetJournal.open(root, context.plan);
	if (phases.phase !== "powered_off" && phases.phase !== "root_deleted")
		throw new Error("OFFICE_DELETE_RECONCILIATION_PHASE_DIFFERS");
	await assertLxdOfficeDeleteDispositionPhases(
		context,
		async (name) => (await readRecord(join(root, name))).value,
		phases.phase === "root_deleted",
	);
	const count = context.document.journal.eventCount;
	const tail = before.events.at(-1);
	if (
		(before.events.length !== count && before.events.length !== count + 1) ||
		tail?.commandId !== context.document.deleteCommandId ||
		tail.operationId !== context.document.operationId ||
		tail.action !== "delete" ||
		(before.events.length === count && (tail.kind !== "accepted" || phases.phase !== "powered_off")) ||
		(before.events.length === count + 1 && tail.kind !== "administrative_disposition")
	)
		throw new Error("OFFICE_DELETE_RECONCILIATION_TAIL_DIFFERS");
	await assertPublicationBoundary();
	await LxdOfficeOperationJournal.recordAdministrativeDisposition(root, allocationId, context);
	// The marker is durable first. Until phase5 is also present every new VM
	// dispatch remains fenced by the shared operation-completion validator.
	await assertPublicationBoundary();
	await phases.advance("root_deleted", context.phaseEvidenceSha256);
	await assertPublicationBoundary();
	await assertLxdOfficeDeleteDispositionPhases(
		context,
		async (name) => (await readRecord(join(root, name))).value,
		true,
	);
	// This readback also revalidates the protected receipt and exact marker.
	await LxdOfficeOperationJournal.recordAdministrativeDisposition(root, allocationId, context);
	const after = await LxdOfficeOperationJournal.readHistory(root, allocationId);
	if (after.events.length !== count + 1 || after.events.at(-1)?.state !== "unknown")
		throw new Error("OFFICE_DELETE_RECONCILIATION_READBACK_DIFFERS");
	await assertPublicationBoundary();
	return {
		schema: "qorpera.lxd-office-delete-metadata-reconciliation/v1" as const,
		auditId: context.document.auditId,
		resetId: context.plan.resetId,
		allocationId,
		dispositionSha256: context.dispositionSha256,
		sqlReceiptSha256: context.sqlReceiptSha256,
		phaseEvidenceSha256: context.phaseEvidenceSha256,
		journalHeadSha256: after.journalHeadSha256,
		originalOutcome: "unknown" as const,
		cleanResetAcceptance: false as const,
		vmOperationRequested: false as const,
		metadataComplete: true as const,
	};
}
