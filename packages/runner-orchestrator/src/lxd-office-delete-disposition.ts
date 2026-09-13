import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerDeleteAdministrativeDisposition,
	type CompanyComputerResetPlan,
	parseCompanyComputerDeleteAdministrativeDisposition,
	parseCompanyComputerResetPlan,
} from "@qorpera/contracts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT = "/etc/qorpera/office-provider/delete-dispositions";
const LIMIT = 65536;
const verified = new WeakSet<object>();

export interface LxdOfficeDeletePhaseEvidence {
	readonly schema: "qorpera.office-reset-phase-evidence/v1";
	readonly resetId: string;
	readonly phase: "root_deleted";
	readonly observation: {
		readonly schema: "qorpera.office-delete-administrative-boundary/v1";
		readonly auditId: string;
		readonly dispositionSha256: string;
		readonly commandId: string;
		readonly operationId: string;
		readonly originalOutcome: "unknown";
		readonly targetPostcondition: "absent";
		readonly nextCreateCommandId: string;
	};
}

export interface LxdOfficeDeleteSqlReceipt {
	readonly schema: "qorpera.office-delete-administrative-receipt/v1";
	readonly auditId: string;
	readonly resetId: string;
	readonly dispositionSha256: string;
	readonly operatorId: string;
	readonly recordedAt: string;
	readonly originalOutcome: "unknown";
	readonly recoveryKind: "administrative_delete";
	readonly cleanResetAcceptance: false;
	readonly phaseEvidence: LxdOfficeDeletePhaseEvidence;
	readonly phaseEvidenceSha256: string;
	readonly resetRevision: number;
}

/** Only the protected reader creates a runtime-verified context. Its root
 * receipt records an already reconciled operator transition; it is not an
 * operation settlement, a current physical inspection or a dispatch grant. */
export interface LxdOfficeDeleteDispositionContext {
	readonly plan: CompanyComputerResetPlan;
	readonly document: Readonly<CompanyComputerDeleteAdministrativeDisposition>;
	readonly dispositionSha256: string;
	readonly sqlReceiptSha256: string;
	readonly phaseEvidenceSha256: string;
	readonly sqlReceipt: Readonly<LxdOfficeDeleteSqlReceipt>;
}

export function lxdOfficeDeleteDispositionPath(allocationId: string, auditId: string): string {
	if (!UUID.test(allocationId) || !UUID.test(auditId)) throw new Error("OFFICE_DELETE_DISPOSITION_ID_INVALID");
	return `${ROOT}/${allocationId}/${auditId}.json`;
}

/** The SQL document hash covers the exact submitted UTF8 text, including any
 * whitespace. PostgreSQL jsonb formatting is never substituted for its bytes. */
export function lxdOfficeDeleteDocumentSha256(documentText: string): string {
	return createHash("sha256").update(documentText, "utf8").digest("hex");
}

export function lxdOfficeDeletePhaseEvidence(
	document: Readonly<CompanyComputerDeleteAdministrativeDisposition>,
	dispositionSha256: string,
): LxdOfficeDeletePhaseEvidence {
	return {
		schema: "qorpera.office-reset-phase-evidence/v1",
		resetId: document.resetId,
		phase: "root_deleted",
		observation: {
			schema: "qorpera.office-delete-administrative-boundary/v1",
			auditId: document.auditId,
			dispositionSha256: officeSha(dispositionSha256),
			commandId: document.deleteCommandId,
			operationId: document.operationId,
			originalOutcome: "unknown",
			targetPostcondition: "absent",
			nextCreateCommandId: document.nextCreateCommandId,
		},
	};
}

function freeze(value: unknown): void {
	if (!value || typeof value !== "object") return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}

/** Runtime branding prevents a caller-created JSON object or truthy flag
 * from standing in for the root-protected historical receipt. */
export function assertLxdOfficeDeleteDispositionContext(
	value: unknown,
): asserts value is LxdOfficeDeleteDispositionContext {
	if (!value || typeof value !== "object" || !verified.has(value))
		throw new Error("OFFICE_DELETE_DISPOSITION_CONTEXT_UNVERIFIED");
}

/** Read immutable operator evidence at a fixed root-owned local path. The
 * stored plan discovers historical scope without scanning mutable indexes.
 * Callers still compare that scope, original event prefix and local phase
 * evidence, and obtain current SQL/physical authority before any new effect.
 * No current operator session is required merely to read preserved history. */
export async function readLxdOfficeDeleteDisposition(
	allocationId: string,
	auditId: string,
	readProtected: typeof readLxdOfficeProtectedFile = readLxdOfficeProtectedFile,
): Promise<LxdOfficeDeleteDispositionContext> {
	try {
		const path = lxdOfficeDeleteDispositionPath(allocationId, auditId);
		const bytes = await readProtected(path, LIMIT);
		if (bytes.length < 1 || bytes.length > LIMIT) throw new Error("receipt size");
		const packet = officeRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), [
			"schema",
			"plan",
			"documentText",
			"sqlReceipt",
		]);
		if (
			packet.schema !== "qorpera.lxd-office-delete-disposition-receipt/v1" ||
			typeof packet.documentText !== "string" ||
			Buffer.byteLength(packet.documentText, "utf8") > 16384
		)
			throw new Error("receipt envelope");
		const plan = parseCompanyComputerResetPlan(packet.plan);
		if (plan.predecessor.startup.allocationId !== allocationId) throw new Error("receipt allocation");
		const raw = JSON.parse(packet.documentText) as CompanyComputerDeleteAdministrativeDisposition;
		// These historical reference pins are attested by root custody and the
		// matching immutable SQL receipt. This read does not re-inspect a VM.
		const document = parseCompanyComputerDeleteAdministrativeDisposition(raw, {
			plan,
			planSha256: officeDigest(plan),
			operationId: raw.operationId,
			journal: raw.journal,
			custodyEvidenceSha256: raw.custodyEvidenceSha256,
			stopAcknowledgementSha256: raw.stopAcknowledgementSha256,
			poweredOffPhaseSha256: raw.poweredOffPhaseSha256,
		});
		if (document.auditId !== auditId) throw new Error("receipt audit");
		const dispositionSha256 = lxdOfficeDeleteDocumentSha256(packet.documentText);
		const phaseEvidence = lxdOfficeDeletePhaseEvidence(document, dispositionSha256);
		const phaseEvidenceSha256 = officeDigest(phaseEvidence);
		const receipt = officeRecord(packet.sqlReceipt, [
			"schema",
			"auditId",
			"resetId",
			"dispositionSha256",
			"operatorId",
			"recordedAt",
			"originalOutcome",
			"recoveryKind",
			"cleanResetAcceptance",
			"phaseEvidence",
			"phaseEvidenceSha256",
			"resetRevision",
		]);
		if (
			typeof receipt.recordedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.recordedAt) ||
			!Number.isFinite(Date.parse(receipt.recordedAt)) ||
			new Date(receipt.recordedAt).toISOString() !== receipt.recordedAt ||
			!Number.isSafeInteger(receipt.resetRevision) ||
			(receipt.resetRevision as number) < 1
		)
			throw new Error("SQL receipt metadata");
		const sqlReceipt: LxdOfficeDeleteSqlReceipt = {
			schema: "qorpera.office-delete-administrative-receipt/v1",
			auditId,
			resetId: plan.resetId,
			dispositionSha256,
			operatorId: document.operator.principalId,
			recordedAt: receipt.recordedAt,
			originalOutcome: "unknown",
			recoveryKind: "administrative_delete",
			cleanResetAcceptance: false,
			phaseEvidence,
			phaseEvidenceSha256,
			resetRevision: receipt.resetRevision as number,
		};
		if (!isDeepStrictEqual(receipt, sqlReceipt)) throw new Error("SQL receipt differs");
		const context: LxdOfficeDeleteDispositionContext = {
			plan,
			document,
			dispositionSha256,
			sqlReceiptSha256: officeDigest(sqlReceipt),
			phaseEvidenceSha256,
			sqlReceipt,
		};
		freeze(context);
		verified.add(context);
		return context;
	} catch {
		throw new Error("OFFICE_DELETE_DISPOSITION_UNCONFIRMED");
	}
}
