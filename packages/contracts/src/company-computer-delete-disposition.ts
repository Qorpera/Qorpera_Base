import { type CompanyComputerResetPlan, parseCompanyComputerResetPlan } from "./company-computer-reset.ts";

export const COMPANY_COMPUTER_DELETE_DISPOSITION_MAX_BYTES = 16384;

/** Digests reference the original protected authority and accepted tail. The
 * caller validates every contiguous event and its raw-byte hash chain. */
export interface CompanyComputerDeleteDispositionJournal {
	readonly authoritySha256: string;
	readonly acceptedHeadSha256: string;
	readonly eventCount: number;
}

/** An audit boundary, never a terminal operation result or fresh dispatch
 * permission. The original delete remains unknown, including in history. */
export interface CompanyComputerDeleteAdministrativeDisposition {
	readonly schema: "qorpera.office-delete-administrative-disposition/v1";
	readonly auditId: string;
	readonly resetId: string;
	readonly planSha256: string;
	readonly deleteCommandId: string;
	readonly operationId: string;
	readonly nextCreateCommandId: string;
	readonly originalOutcome: "unknown";
	readonly targetPostcondition: "absent";
	readonly journal: CompanyComputerDeleteDispositionJournal;
	/** The SQL custodied phase evidence, not the bare archive manifest. */
	readonly custodyEvidenceSha256: string;
	/** Existing SQL stopped-phase evidence hash, not bare stop bytes. */
	readonly stopAcknowledgementSha256: string;
	/** Existing SQL powered_off phase evidence hash, not its record hash. */
	readonly poweredOffPhaseSha256: string;
	readonly operator: {
		readonly principalId: string;
		readonly reasonCode: "accepted_delete_result_unavailable";
		readonly reason: string;
	};
	readonly source: { readonly sourceCommit: string; readonly artifactSha256: string };
	readonly executionFence: {
		readonly schema: "qorpera.office-delete-execution-fence/v1";
		readonly mechanism: "lxd-ab8fad2-zfs-ordered-delete/v1";
		readonly sha256: string;
	};
	readonly physicalEvidence: {
		readonly schema: "qorpera.office-delete-physical-evidence/v1";
		readonly sha256: string;
	};
	/** Original observation time. Parsing it does not assert freshness. */
	readonly observedAt: string;
}

/** Callers derive these pins from separately verified retained records. A
 * supplied binding is not authentication, execution fencing or SQL authority. */
export interface CompanyComputerDeleteDispositionBinding {
	readonly plan: CompanyComputerResetPlan;
	readonly planSha256: string;
	readonly operationId: string;
	readonly journal: CompanyComputerDeleteDispositionJournal;
	readonly custodyEvidenceSha256: string;
	readonly stopAcknowledgementSha256: string;
	readonly poweredOffPhaseSha256: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error("record");
	const names = keys.split(",");
	if (Reflect.ownKeys(value).length !== names.length) throw new Error("record");
	const result: Record<string, unknown> = {};
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("record");
		result[name] = descriptor.value;
	}
	return result;
}
function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("value");
	return value;
}
function journal(value: unknown): Readonly<CompanyComputerDeleteDispositionJournal> {
	const r = record(value, "authoritySha256,acceptedHeadSha256,eventCount");
	// At least initial create/start, reset stop, then dispatch+accepted delete.
	if (
		!Number.isSafeInteger(r.eventCount) ||
		(r.eventCount as number) < 11 ||
		(r.eventCount as number) > 383 ||
		(r.eventCount as number) % 3 !== 2
	)
		throw new Error("prefix");
	return Object.freeze({
		authoritySha256: text(r.authoritySha256, SHA),
		acceptedHeadSha256: text(r.acceptedHeadSha256, SHA),
		eventCount: r.eventCount as number,
	});
}

/** Pure closed parsing and exact retained-plan/reference comparison. Does
 * not read evidence, hash plan bytes, authenticate an operator, check clocks,
 * establish filesystem custody or grant administrative continuation. Fence
 * schema/mechanism/digest are references, not verified physical safety. The
 * execution layer also reserves capacity for the marker and remaining events. */
export function parseCompanyComputerDeleteAdministrativeDisposition(
	value: unknown,
	binding: CompanyComputerDeleteDispositionBinding,
): Readonly<CompanyComputerDeleteAdministrativeDisposition> {
	try {
		const r = record(
			value,
			"schema,auditId,resetId,planSha256,deleteCommandId,operationId,nextCreateCommandId,originalOutcome,targetPostcondition,journal,custodyEvidenceSha256,stopAcknowledgementSha256,poweredOffPhaseSha256,operator,source,executionFence,physicalEvidence,observedAt",
		);
		const b = record(
			binding,
			"plan,planSha256,operationId,journal,custodyEvidenceSha256,stopAcknowledgementSha256,poweredOffPhaseSha256",
		);
		const plan = parseCompanyComputerResetPlan(b.plan);
		const operator = record(r.operator, "principalId,reasonCode,reason");
		const source = record(r.source, "sourceCommit,artifactSha256");
		const fence = record(r.executionFence, "schema,mechanism,sha256");
		const physical = record(r.physicalEvidence, "schema,sha256");
		const actualJournal = journal(r.journal),
			expectedJournal = journal(b.journal);
		if (
			r.schema !== "qorpera.office-delete-administrative-disposition/v1" ||
			r.originalOutcome !== "unknown" ||
			r.targetPostcondition !== "absent" ||
			r.resetId !== plan.resetId ||
			r.deleteCommandId !== plan.commands.deleteCommandId ||
			r.nextCreateCommandId !== plan.commands.createCommandId ||
			operator.reasonCode !== "accepted_delete_result_unavailable" ||
			fence.schema !== "qorpera.office-delete-execution-fence/v1" ||
			fence.mechanism !== "lxd-ab8fad2-zfs-ordered-delete/v1" ||
			physical.schema !== "qorpera.office-delete-physical-evidence/v1" ||
			actualJournal.authoritySha256 !== expectedJournal.authoritySha256 ||
			actualJournal.acceptedHeadSha256 !== expectedJournal.acceptedHeadSha256 ||
			actualJournal.eventCount !== expectedJournal.eventCount
		)
			throw new Error("binding");
		const references = [
			"planSha256",
			"custodyEvidenceSha256",
			"stopAcknowledgementSha256",
			"poweredOffPhaseSha256",
		] as const;
		for (const key of references) if (text(r[key], SHA) !== text(b[key], SHA)) throw new Error("reference");
		const operationId = text(r.operationId, UUID),
			auditId = text(r.auditId, UUID);
		if (operationId !== text(b.operationId, UUID)) throw new Error("operation");
		const retainedIds = [
			plan.resetId,
			plan.intentId,
			plan.rootIncarnationId,
			plan.successorActivationId,
			plan.predecessor.transitionId,
			plan.predecessor.activationId,
			plan.predecessor.startup.allocationId,
			plan.predecessor.startup.bootId,
			...Object.values(plan.commands),
			plan.nodeId,
			plan.predecessorRootIncarnationId,
		];
		if (auditId === operationId || retainedIds.includes(auditId) || retainedIds.includes(operationId))
			throw new Error("identity reuse");
		if (
			typeof operator.reason !== "string" ||
			operator.reason.length < 1 ||
			operator.reason.length > 512 ||
			operator.reason.trim() !== operator.reason ||
			/[\x00-\x1f\x7f]/.test(operator.reason)
		)
			throw new Error("reason");
		const observedAt = text(r.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt)
			throw new Error("time");
		const parsed: CompanyComputerDeleteAdministrativeDisposition = Object.freeze({
			schema: "qorpera.office-delete-administrative-disposition/v1",
			auditId,
			resetId: plan.resetId,
			planSha256: r.planSha256 as string,
			deleteCommandId: plan.commands.deleteCommandId,
			operationId,
			nextCreateCommandId: plan.commands.createCommandId,
			originalOutcome: "unknown",
			targetPostcondition: "absent",
			journal: actualJournal,
			custodyEvidenceSha256: r.custodyEvidenceSha256 as string,
			stopAcknowledgementSha256: r.stopAcknowledgementSha256 as string,
			poweredOffPhaseSha256: r.poweredOffPhaseSha256 as string,
			operator: Object.freeze({
				principalId: text(operator.principalId, UUID),
				reasonCode: "accepted_delete_result_unavailable",
				reason: operator.reason,
			}),
			source: Object.freeze({
				sourceCommit: text(source.sourceCommit, /^[a-f0-9]{40}$/),
				artifactSha256: text(source.artifactSha256, SHA),
			}),
			executionFence: Object.freeze({
				schema: "qorpera.office-delete-execution-fence/v1",
				mechanism: "lxd-ab8fad2-zfs-ordered-delete/v1",
				sha256: text(fence.sha256, SHA),
			}),
			physicalEvidence: Object.freeze({
				schema: "qorpera.office-delete-physical-evidence/v1",
				sha256: text(physical.sha256, SHA),
			}),
			observedAt,
		});
		if (new TextEncoder().encode(JSON.stringify(parsed)).length > COMPANY_COMPUTER_DELETE_DISPOSITION_MAX_BYTES)
			throw new Error("size");
		return parsed;
	} catch {
		throw new Error("INVALID_OFFICE_DELETE_ADMINISTRATIVE_DISPOSITION");
	}
}
