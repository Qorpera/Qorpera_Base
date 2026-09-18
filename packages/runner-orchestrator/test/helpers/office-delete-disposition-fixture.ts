import { createHash } from "node:crypto";
import type {
	CompanyComputerDeleteAdministrativeDisposition,
	CompanyComputerDeleteDispositionBinding,
	CompanyComputerResetPlan,
} from "@qorpera/contracts";
import { readLxdOfficeDeleteDisposition } from "../../src/lxd-office-delete-disposition.ts";
import { officeDigest } from "../../src/lxd-office-image-provenance.ts";
export const officeDeleteDispositionId = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const id = officeDeleteDispositionId;
export const officeDeleteDispositionSha = (n: string) => n.repeat(64);
const sha = officeDeleteDispositionSha;
function fixture(): {
	binding: CompanyComputerDeleteDispositionBinding;
	value: CompanyComputerDeleteAdministrativeDisposition;
} {
	const binding: CompanyComputerDeleteDispositionBinding = {
		plan: {
			schema: "qorpera.lxd-office-reset-plan/v1",
			resetId: id(1),
			intentId: id(13),
			predecessor: {
				schema: "qorpera.office-lifecycle-request/v1",
				transitionId: id(2),
				action: "replace",
				activationId: id(3),
				providerId: id(12),
				providerPolicySha256: sha("f"),
				startup: {
					scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
					computerGeneration: 1,
					allocationId: id(10),
					instanceSha256: sha("a"),
					imageSha256: sha("b"),
					bootstrapSha256: sha("c"),
					bootId: id(11),
					configurationSha256: sha("d"),
					serviceInvocationId: "e".repeat(32),
				},
			},
			preparationObservationSha256: sha("1"),
			providerBindingSha256: sha("2"),
			nodeId: id(14),
			predecessorRootIncarnationId: null,
			rootIncarnationId: id(5),
			successorActivationId: id(4),
			commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
			custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
		},
		planSha256: sha("3"),
		operationId: id(40),
		journal: { authoritySha256: sha("4"), acceptedHeadSha256: sha("5"), eventCount: 11 },
		custodyEvidenceSha256: sha("6"),
		stopAcknowledgementSha256: sha("7"),
		poweredOffPhaseSha256: sha("8"),
	};
	const value: CompanyComputerDeleteAdministrativeDisposition = {
		schema: "qorpera.office-delete-administrative-disposition/v1",
		auditId: id(41),
		resetId: binding.plan.resetId,
		planSha256: binding.planSha256,
		deleteCommandId: binding.plan.commands.deleteCommandId,
		operationId: binding.operationId,
		nextCreateCommandId: binding.plan.commands.createCommandId,
		originalOutcome: "unknown",
		targetPostcondition: "absent",
		journal: { ...binding.journal },
		custodyEvidenceSha256: binding.custodyEvidenceSha256,
		stopAcknowledgementSha256: binding.stopAcknowledgementSha256,
		poweredOffPhaseSha256: binding.poweredOffPhaseSha256,
		operator: {
			principalId: id(42),
			reasonCode: "accepted_delete_result_unavailable",
			reason: "Accepted delete result was not retained.",
		},
		source: { sourceCommit: "a".repeat(40), artifactSha256: sha("9") },
		executionFence: {
			schema: "qorpera.office-delete-execution-fence/v1",
			mechanism: "lxd-ab8fad2-zfs-ordered-delete/v1",
			sha256: sha("a"),
		},
		physicalEvidence: { schema: "qorpera.office-delete-physical-evidence/v1", sha256: sha("b") },
		observedAt: "2020-01-01T00:00:00.000Z",
	};
	return { binding, value };
}

// Independent fixture matches SQL's closed result, without using the reader's builders.
export function officeDeleteDispositionEnvelopeFixture(documentText?: string) {
	const { binding, value } = fixture();
	return officeDeleteDispositionEnvelopeFor(
		binding.plan,
		{ ...value, planSha256: officeDigest(binding.plan) },
		documentText,
	);
}

export function officeDeleteDispositionEnvelopeFor(
	plan: CompanyComputerResetPlan,
	document: CompanyComputerDeleteAdministrativeDisposition,
	documentText?: string,
) {
	const text = documentText ?? `${JSON.stringify(document, null, 2)}\n`,
		d = JSON.parse(text);
	const digest = createHash("sha256").update(text).digest("hex");
	const phaseEvidence = {
		schema: "qorpera.office-reset-phase-evidence/v1",
		resetId: d.resetId,
		phase: "root_deleted",
		observation: {
			schema: "qorpera.office-delete-administrative-boundary/v1",
			auditId: d.auditId,
			dispositionSha256: digest,
			commandId: d.deleteCommandId,
			operationId: d.operationId,
			originalOutcome: "unknown",
			targetPostcondition: "absent",
			nextCreateCommandId: d.nextCreateCommandId,
		},
	};
	return {
		schema: "qorpera.lxd-office-delete-disposition-receipt/v1",
		plan,
		documentText: text,
		sqlReceipt: {
			schema: "qorpera.office-delete-administrative-receipt/v1",
			auditId: d.auditId,
			resetId: d.resetId,
			dispositionSha256: digest,
			operatorId: d.operator.principalId,
			recordedAt: "2020-01-01T00:01:00.000Z",
			originalOutcome: "unknown",
			recoveryKind: "administrative_delete",
			cleanResetAcceptance: false,
			phaseEvidence,
			phaseEvidenceSha256: officeDigest(phaseEvidence),
			resetRevision: 6,
		},
	};
}

export function officeDeleteDispositionFixture() {
	const original = fixture();
	const binding = { ...original.binding, planSha256: officeDigest(original.binding.plan) };
	const document = { ...original.value, planSha256: binding.planSha256 };
	return {
		binding,
		plan: binding.plan,
		document,
		envelope: officeDeleteDispositionEnvelopeFixture(`${JSON.stringify(document, null, 2)}\n`),
	};
}
/** Real protected-reader validation and WeakSet branding, with only filesystem IO injected. */
export async function officeDeleteDispositionContextFixture() {
	const result = officeDeleteDispositionFixture();
	const bytes = Buffer.from(JSON.stringify(result.envelope));
	const context = await readLxdOfficeDeleteDisposition(
		result.plan.predecessor.startup.allocationId,
		result.document.auditId,
		async () => bytes,
	);
	return { ...result, context };
}

/** Caller-supplied real journal/phase fixtures still pass the production parser and brand. */
export async function officeDeleteDispositionContextFor(
	plan: CompanyComputerResetPlan,
	document: CompanyComputerDeleteAdministrativeDisposition,
) {
	const envelope = officeDeleteDispositionEnvelopeFor(plan, document);
	const bytes = Buffer.from(JSON.stringify(envelope));
	const context = await readLxdOfficeDeleteDisposition(
		plan.predecessor.startup.allocationId,
		document.auditId,
		async () => bytes,
	);
	return { plan, document, envelope, bytes, context };
}
