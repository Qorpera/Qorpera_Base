import { COMPANY_COMPUTER_RESET_PHASES, parseCompanyComputerResetPhaseRecord } from "@qorpera/contracts";
import {
	assertLxdOfficeDeleteDispositionContext,
	type LxdOfficeDeleteDispositionContext,
} from "./lxd-office-delete-disposition.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";

/** The third record preserves the accepted operation's unknown outcome. It
 * is an administrative boundary, never a normal settlement. */
export interface LxdOfficeAdministrativeDeleteMarker {
	schema: "qorpera.lxd-office-operation-event/v3";
	sequence: number;
	previousSha256: string;
	commandId: string;
	action: "delete";
	kind: "administrative_disposition";
	operationId: string;
	state: "unknown";
	recordedAt: string;
	auditId: string;
	resetId: string;
	nextCreateCommandId: string;
	dispositionSha256: string;
	sqlReceiptSha256: string;
	phaseEvidenceSha256: string;
}

export interface LxdOfficeVmCompletionAuthority {
	authoritySha256: string;
	intentId: string;
	binding: Readonly<LxdOfficeGuestBinding>;
}

/** Shared completion classification. A provider-owned marker alone cannot
 * satisfy this predicate; administrative context must have been produced by
 * the root-protected receipt reader and retain its runtime brand. */
export function lxdOfficeVmCompletion(
	event:
		| { kind: "dispatch" | "accepted" | "settled"; state: "succeeded" | "failed" | null }
		| LxdOfficeAdministrativeDeleteMarker
		| undefined,
	context?: LxdOfficeDeleteDispositionContext,
	authority?: LxdOfficeVmCompletionAuthority,
): "succeeded" | "administratively_disposed" | undefined {
	if (event?.kind === "settled" && event.state === "succeeded") return "succeeded";
	if (event?.kind !== "administrative_disposition" || !context || !authority) return undefined;
	assertLxdOfficeDeleteDispositionContext(context);
	const { plan, document } = context;
	if (
		event.schema !== "qorpera.lxd-office-operation-event/v3" ||
		event.state !== "unknown" ||
		event.action !== "delete" ||
		event.auditId !== document.auditId ||
		event.resetId !== plan.resetId ||
		event.commandId !== plan.commands.deleteCommandId ||
		event.operationId !== document.operationId ||
		event.nextCreateCommandId !== plan.commands.createCommandId ||
		event.dispositionSha256 !== context.dispositionSha256 ||
		event.sqlReceiptSha256 !== context.sqlReceiptSha256 ||
		event.phaseEvidenceSha256 !== context.phaseEvidenceSha256 ||
		event.sequence !== document.journal.eventCount ||
		event.previousSha256 !== document.journal.acceptedHeadSha256 ||
		authority.authoritySha256 !== document.journal.authoritySha256 ||
		plan.intentId !== authority.intentId ||
		plan.providerBindingSha256 !== officeDigest(authority.binding) ||
		plan.predecessor.startup.allocationId !== authority.binding.allocationId
	)
		throw new Error("OFFICE_DELETE_DISPOSITION_JOURNAL_DIFFERS");
	return "administratively_disposed";
}

/** Verify retained phase1–4 before marker publication; phase5 is additionally
 * mandatory before any new VM dispatch or terminal historical acceptance.
 * This read never advances the reset journal or supplies SQL authority. */
export async function assertLxdOfficeDeleteDispositionPhases(
	context: LxdOfficeDeleteDispositionContext,
	read: (name: string) => Promise<unknown>,
	requireAdministrativePhase: boolean,
): Promise<void> {
	assertLxdOfficeDeleteDispositionContext(context);
	const { plan, document } = context;
	let previous: string | null = null;
	const expected = [
		officeDigest(plan),
		document.stopAcknowledgementSha256,
		document.custodyEvidenceSha256,
		document.poweredOffPhaseSha256,
		context.phaseEvidenceSha256,
	];
	for (let i = 0; i < (requireAdministrativePhase ? 5 : 4); i++) {
		const record = parseCompanyComputerResetPhaseRecord(
			await read(`reset-phase-${plan.predecessor.startup.allocationId}-${plan.resetId}-${i + 1}.json`),
			plan,
		);
		if (
			record.phase !== COMPANY_COMPUTER_RESET_PHASES[i] ||
			record.previousSha256 !== previous ||
			(expected[i] !== undefined && record.evidenceSha256 !== expected[i])
		)
			throw new Error("OFFICE_DELETE_DISPOSITION_PHASES_DIFFER");
		previous = officeDigest(record);
	}
}
