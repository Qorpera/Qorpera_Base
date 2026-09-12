import {
	COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES,
	parseCompanyComputerCodePackageProvisionPlan,
	parseCompanyComputerCodePackageProvisionReceipt,
	parseCompanyComputerCodePackageProvisionRequest,
	parseCompanyComputerCodePackageProvisionStatement,
	parseCompanyComputerResetPlan,
} from "@qorpera/contracts";
import { officeDigest } from "../../src/lxd-office-image-provenance.ts";
export const codePackageId = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
export function officeCodePackageControlFixture() {
	const id = codePackageId,
		sha = "a".repeat(64);
	const startup = {
		scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
		computerGeneration: 1,
		allocationId: id(10),
		instanceSha256: sha,
		imageSha256: sha,
		bootstrapSha256: sha,
		bootId: id(11),
		configurationSha256: sha,
		serviceInvocationId: "e".repeat(32),
	};
	const resetPlan = parseCompanyComputerResetPlan({
		schema: "qorpera.lxd-office-reset-plan/v1",
		resetId: id(1),
		intentId: id(13),
		predecessor: {
			schema: "qorpera.office-lifecycle-request/v1",
			transitionId: id(2),
			action: "replace",
			activationId: id(3),
			providerId: id(12),
			providerPolicySha256: sha,
			startup,
		},
		preparationObservationSha256: sha,
		providerBindingSha256: sha,
		nodeId: id(14),
		predecessorRootIncarnationId: null,
		rootIncarnationId: id(5),
		successorActivationId: id(4),
		commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
		custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
	});
	const statement = parseCompanyComputerCodePackageProvisionStatement({
		schema: "qorpera.office-code-package-provision-statement/v1",
		base: { imageSha256: sha, bootstrapSha256: sha, packageManifestSha256: sha, sourceCommit: "a".repeat(40) },
		target: {
			packageManifestSha256: sha,
			sourceCommit: "b".repeat(40),
			runtimeBundle: { id: "qorpera.cloud-runtime", version: 24, sha256: sha },
			service: { path: "/opt/qorpera-office/qorpera-company-computer-service.mjs", bytes: 123, sha256: sha },
			capabilities: COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES,
		},
		tools: { bootstrap: { bytes: 123, sha256: sha }, measure: { bytes: 123, sha256: sha } },
		compatibility: { baseInstallationReceiptSha256: sha, unchangedExternalDependenciesSha256: sha },
		acceptance: { testedAt: "2026-09-12T00:00:00.000Z", evidenceSha256: sha, change: "code-only-package" },
	});
	const plan = parseCompanyComputerCodePackageProvisionPlan({
		schema: "qorpera.lxd-office-code-package-provision-plan/v1",
		provisionId: id(31),
		resetId: resetPlan.resetId,
		resetPlanSha256: officeDigest(resetPlan),
		providerBindingSha256: resetPlan.providerBindingSha256,
		rootIncarnationId: resetPlan.rootIncarnationId,
		successorActivationId: resetPlan.successorActivationId,
		statementSha256: officeDigest(statement),
		expectedSoftwareRevision: null,
		targetRevision: 1,
		installCommandId: id(32),
	});
	const request = parseCompanyComputerCodePackageProvisionRequest({
		schema: "qorpera.office-code-package-provision-request/v1",
		plan,
		planSha256: officeDigest(plan),
		bootId: id(33),
		restoreSha256: sha,
		challengeId: id(34),
		targetRevision: 1,
		capabilityRevision: 1,
		targetManifestSha256: sha,
	});
	const receipt = parseCompanyComputerCodePackageProvisionReceipt({
		schema: "qorpera.office-code-package-provision-receipt/v1",
		planSha256: officeDigest(plan),
		provisionId: plan.provisionId,
		resetId: plan.resetId,
		rootIncarnationId: plan.rootIncarnationId,
		bootId: request.bootId,
		commandId: plan.installCommandId,
		requestSha256: officeDigest(request),
		restoreSha256: request.restoreSha256,
		state: "installed",
		targetRevision: plan.targetRevision,
		packageManifestSha256: statement.target.packageManifestSha256,
		installedInventorySha256: sha,
		sourceCommit: statement.target.sourceCommit,
		runtimeBundle: statement.target.runtimeBundle,
		service: statement.target.service,
	});
	const options = { plan, statement, resetPlan, inventorySha256: sha, providerCapability: "f".repeat(64) };
	const status = (state: "enrolled" | "authorized" | "installed" = "enrolled") => ({
		schema: "qorpera.office-code-package-provision-status/v1",
		plan,
		planSha256: officeDigest(plan),
		statement,
		state,
		targetRevision: 1,
		currentPackageRevision: state === "installed" ? 1 : 0,
		capabilityRevision: 1,
		request: state === "enrolled" ? null : request,
		requestSha256: state === "enrolled" ? null : officeDigest(request),
		receipt: state === "installed" ? receipt : null,
		receiptSha256: state === "installed" ? officeDigest(receipt) : null,
		installationEvidenceSha256: state === "installed" ? sha : null,
	});
	const dispatch = () => ({
		schema: "qorpera.office-code-package-dispatch-challenge/v1",
		request,
		requestSha256: officeDigest(request),
		statement,
		targetRevision: 1,
		capabilityRevision: 1,
		validForMs: 5000,
	});
	return { id, sha, startup, resetPlan, statement, plan, request, receipt, options, status, dispatch };
}
