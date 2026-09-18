/** A code-only package revision is distinct from a service-only revision and
 * never changes the enrolled base image or the permanent preparation. */
export const COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS = [
	"qorpera-company-computer-boot-configuration-control.mjs",
	"qorpera-company-computer-boot-service-restart-control.mjs",
	"qorpera-company-computer-boot-service-start-control.mjs",
	"qorpera-company-computer-configuration-control.mjs",
	"qorpera-company-computer-preparation-control.mjs",
	"qorpera-company-computer-preparation.mjs",
	"qorpera-company-computer-reset-configuration-control.mjs",
	"qorpera-company-computer-reset-service-restart-control.mjs",
	"qorpera-company-computer-reset-service-start-control.mjs",
	"qorpera-company-computer-service-restart-control.mjs",
	"qorpera-company-computer-service-start-control.mjs",
	"qorpera-company-computer-service-stop-control.mjs",
	"qorpera-company-computer-service.mjs",
	"qorpera-office-image-install.cjs",
] as const;
export const COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS = COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS.slice(6, 9);
export const COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES = [
	"reset-configuration/v1",
	"reset-service-start/v1",
	"reset-service-restart/v1",
] as const;
export const COMPANY_COMPUTER_CODE_PACKAGE_MAX_BYTES = 65536;
export const COMPANY_COMPUTER_CODE_PACKAGE_MANIFEST_MAX_BYTES = 1024 ** 2;
export const COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACT_MAX_BYTES = 32 * 1024 ** 2;
export const COMPANY_COMPUTER_CODE_PACKAGE_TOOL_MAX_BYTES = 16 * 1024 ** 2;
export const COMPANY_COMPUTER_CODE_PACKAGE_TOTAL_MAX_BYTES = 128 * 1024 ** 2;
export const COMPANY_COMPUTER_CODE_PACKAGE_MAX_ARTIFACTS = 4096;
export interface CompanyComputerCodePackageArtifact {
	readonly bytes: number;
	readonly sha256: string;
}
export interface CompanyComputerCodePackageService extends CompanyComputerCodePackageArtifact {
	readonly path: "/opt/qorpera-office/qorpera-company-computer-service.mjs";
}
export interface CompanyComputerCodePackageRuntimeBundle {
	readonly id: "qorpera.cloud-runtime";
	readonly version: number;
	readonly sha256: string;
}
export interface CompanyComputerCodePackageProvisionStatement {
	readonly schema: "qorpera.office-code-package-provision-statement/v1";
	readonly base: {
		readonly imageSha256: string;
		readonly bootstrapSha256: string;
		readonly packageManifestSha256: string;
		readonly sourceCommit: string;
	};
	readonly target: {
		readonly packageManifestSha256: string;
		readonly sourceCommit: string;
		readonly runtimeBundle: CompanyComputerCodePackageRuntimeBundle;
		readonly service: CompanyComputerCodePackageService;
		readonly capabilities: typeof COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES;
	};
	readonly tools: {
		readonly bootstrap: CompanyComputerCodePackageArtifact;
		readonly measure: CompanyComputerCodePackageArtifact;
	};
	readonly compatibility: {
		readonly baseInstallationReceiptSha256: string;
		readonly unchangedExternalDependenciesSha256: string;
	};
	readonly acceptance: {
		readonly testedAt: string;
		readonly evidenceSha256: string;
		readonly change: "code-only-package";
	};
}
export interface CompanyComputerCodePackageProvisionEnvelope {
	readonly schema: "qorpera.office-code-package-provision-envelope/v1";
	readonly statement: CompanyComputerCodePackageProvisionStatement;
	readonly signature: { readonly algorithm: "ed25519"; readonly value: string };
}
export interface CompanyComputerCodePackageProvisionPlan {
	readonly schema: "qorpera.lxd-office-code-package-provision-plan/v1";
	readonly provisionId: string;
	readonly resetId: string;
	readonly resetPlanSha256: string;
	readonly providerBindingSha256: string;
	readonly rootIncarnationId: string;
	readonly successorActivationId: string;
	readonly statementSha256: string;
	readonly expectedSoftwareRevision: number | null;
	readonly targetRevision: number;
	readonly installCommandId: string;
}
/** Caller-chosen challenge ID and enrollment revisions are fixed before the
 * request is hashed. Renewed observation authority never rewrites this packet. */
export interface CompanyComputerCodePackageProvisionRequest {
	readonly schema: "qorpera.office-code-package-provision-request/v1";
	readonly plan: CompanyComputerCodePackageProvisionPlan;
	readonly planSha256: string;
	readonly bootId: string;
	readonly restoreSha256: string;
	readonly challengeId: string;
	readonly targetRevision: number;
	readonly capabilityRevision: number;
	readonly targetManifestSha256: string;
}
export interface CompanyComputerCodePackageProvisionReceipt {
	readonly schema: "qorpera.office-code-package-provision-receipt/v1";
	readonly planSha256: string;
	readonly provisionId: string;
	readonly resetId: string;
	readonly rootIncarnationId: string;
	readonly bootId: string;
	readonly commandId: string;
	readonly requestSha256: string;
	readonly restoreSha256: string;
	readonly state: "installed";
	readonly targetRevision: number;
	readonly packageManifestSha256: string;
	readonly installedInventorySha256: string;
	readonly sourceCommit: string;
	readonly runtimeBundle: CompanyComputerCodePackageRuntimeBundle;
	readonly service: CompanyComputerCodePackageService;
}
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error("INVALID_CODE_PACKAGE_RECORD");
	const names = keys.split(",");
	if (Reflect.ownKeys(value).length !== names.length) throw new Error("INVALID_CODE_PACKAGE_RECORD");
	const out: Record<string, unknown> = {};
	for (const name of names) {
		const d = Object.getOwnPropertyDescriptor(value, name);
		if (!d || !Object.hasOwn(d, "value")) throw new Error("INVALID_CODE_PACKAGE_RECORD");
		out[name] = d.value;
	}
	return out;
}
function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("INVALID_CODE_PACKAGE_VALUE");
	return value;
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new Error("INVALID_CODE_PACKAGE_NUMBER");
	return value as number;
}
function distinct(ids: string[]): void {
	if (new Set(ids).size !== ids.length) throw new Error("CODE_PACKAGE_IDENTITY_REUSED");
}
function artifact(value: unknown, limit: number): Readonly<CompanyComputerCodePackageArtifact> {
	const r = record(value, "bytes,sha256");
	return Object.freeze({ bytes: integer(r.bytes, 1, limit), sha256: text(r.sha256, SHA) });
}
function service(value: unknown): Readonly<CompanyComputerCodePackageService> {
	const r = record(value, "path,bytes,sha256");
	if (r.path !== "/opt/qorpera-office/qorpera-company-computer-service.mjs")
		throw new Error("INVALID_CODE_PACKAGE_SERVICE");
	return Object.freeze({
		path: r.path,
		...artifact({ bytes: r.bytes, sha256: r.sha256 }, COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACT_MAX_BYTES),
	});
}
function bundle(value: unknown): Readonly<CompanyComputerCodePackageRuntimeBundle> {
	const r = record(value, "id,version,sha256");
	if (r.id !== "qorpera.cloud-runtime") throw new Error("INVALID_CODE_PACKAGE_BUNDLE");
	return Object.freeze({ id: r.id, version: integer(r.version), sha256: text(r.sha256, SHA) });
}
export function parseCompanyComputerCodePackageProvisionStatement(
	value: unknown,
): Readonly<CompanyComputerCodePackageProvisionStatement> {
	const r = record(value, "schema,base,target,tools,compatibility,acceptance");
	if (r.schema !== "qorpera.office-code-package-provision-statement/v1")
		throw new Error("INVALID_CODE_PACKAGE_STATEMENT");
	const base = record(r.base, "imageSha256,bootstrapSha256,packageManifestSha256,sourceCommit");
	const target = record(r.target, "packageManifestSha256,sourceCommit,runtimeBundle,service,capabilities");
	const tools = record(r.tools, "bootstrap,measure");
	const compatibility = record(r.compatibility, "baseInstallationReceiptSha256,unchangedExternalDependenciesSha256");
	const acceptance = record(r.acceptance, "testedAt,evidenceSha256,change");
	if (
		!Array.isArray(target.capabilities) ||
		target.capabilities.length !== 3 ||
		target.capabilities.some((v, i) => v !== COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES[i]) ||
		acceptance.change !== "code-only-package"
	)
		throw new Error("INVALID_CODE_PACKAGE_SCOPE");
	const testedAt = text(acceptance.testedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
	if (!Number.isFinite(Date.parse(testedAt)) || new Date(testedAt).toISOString() !== testedAt)
		throw new Error("INVALID_CODE_PACKAGE_TIME");
	return Object.freeze({
		schema: r.schema,
		base: Object.freeze({
			imageSha256: text(base.imageSha256, SHA),
			bootstrapSha256: text(base.bootstrapSha256, SHA),
			packageManifestSha256: text(base.packageManifestSha256, SHA),
			sourceCommit: text(base.sourceCommit, /^[a-f0-9]{40}$/),
		}),
		target: Object.freeze({
			packageManifestSha256: text(target.packageManifestSha256, SHA),
			sourceCommit: text(target.sourceCommit, /^[a-f0-9]{40}$/),
			runtimeBundle: bundle(target.runtimeBundle),
			service: service(target.service),
			capabilities: Object.freeze([...COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES] as const),
		}),
		tools: Object.freeze({
			bootstrap: artifact(tools.bootstrap, COMPANY_COMPUTER_CODE_PACKAGE_TOOL_MAX_BYTES),
			measure: artifact(tools.measure, COMPANY_COMPUTER_CODE_PACKAGE_TOOL_MAX_BYTES),
		}),
		compatibility: Object.freeze({
			baseInstallationReceiptSha256: text(compatibility.baseInstallationReceiptSha256, SHA),
			unchangedExternalDependenciesSha256: text(compatibility.unchangedExternalDependenciesSha256, SHA),
		}),
		acceptance: Object.freeze({
			testedAt,
			evidenceSha256: text(acceptance.evidenceSha256, SHA),
			change: "code-only-package",
		}),
	});
}
export function parseCompanyComputerCodePackageProvisionEnvelope(
	value: unknown,
): Readonly<CompanyComputerCodePackageProvisionEnvelope> {
	const r = record(value, "schema,statement,signature");
	const s = record(r.signature, "algorithm,value");
	if (r.schema !== "qorpera.office-code-package-provision-envelope/v1" || s.algorithm !== "ed25519")
		throw new Error("INVALID_CODE_PACKAGE_ENVELOPE");
	return Object.freeze({
		schema: r.schema,
		statement: parseCompanyComputerCodePackageProvisionStatement(r.statement),
		signature: Object.freeze({ algorithm: s.algorithm, value: text(s.value, /^[A-Za-z0-9+/]{86}==$/) }),
	});
}
export function parseCompanyComputerCodePackageProvisionPlan(
	value: unknown,
): Readonly<CompanyComputerCodePackageProvisionPlan> {
	const r = record(
		value,
		"schema,provisionId,resetId,resetPlanSha256,providerBindingSha256,rootIncarnationId,successorActivationId,statementSha256,expectedSoftwareRevision,targetRevision,installCommandId",
	);
	if (r.schema !== "qorpera.lxd-office-code-package-provision-plan/v1") throw new Error("INVALID_CODE_PACKAGE_PLAN");
	const ids = [r.provisionId, r.resetId, r.rootIncarnationId, r.successorActivationId, r.installCommandId].map((v) =>
		text(v, UUID),
	);
	distinct(ids);
	return Object.freeze({
		schema: r.schema,
		provisionId: ids[0],
		resetId: ids[1],
		rootIncarnationId: ids[2],
		successorActivationId: ids[3],
		installCommandId: ids[4],
		resetPlanSha256: text(r.resetPlanSha256, SHA),
		providerBindingSha256: text(r.providerBindingSha256, SHA),
		statementSha256: text(r.statementSha256, SHA),
		expectedSoftwareRevision: r.expectedSoftwareRevision === null ? null : integer(r.expectedSoftwareRevision, 0),
		targetRevision: integer(r.targetRevision),
	});
}
export function parseCompanyComputerCodePackageProvisionRequest(
	value: unknown,
): Readonly<CompanyComputerCodePackageProvisionRequest> {
	const r = record(
		value,
		"schema,plan,planSha256,bootId,restoreSha256,challengeId,targetRevision,capabilityRevision,targetManifestSha256",
	);
	const plan = parseCompanyComputerCodePackageProvisionPlan(r.plan);
	if (r.schema !== "qorpera.office-code-package-provision-request/v1" || r.targetRevision !== plan.targetRevision)
		throw new Error("INVALID_CODE_PACKAGE_REQUEST");
	const bootId = text(r.bootId, UUID),
		challengeId = text(r.challengeId, UUID);
	distinct([
		plan.provisionId,
		plan.resetId,
		plan.rootIncarnationId,
		plan.successorActivationId,
		plan.installCommandId,
		bootId,
		challengeId,
	]);
	return Object.freeze({
		schema: r.schema,
		plan,
		planSha256: text(r.planSha256, SHA),
		bootId,
		restoreSha256: text(r.restoreSha256, SHA),
		challengeId,
		targetRevision: plan.targetRevision,
		capabilityRevision: integer(r.capabilityRevision),
		targetManifestSha256: text(r.targetManifestSha256, SHA),
	});
}
export function parseCompanyComputerCodePackageProvisionReceipt(
	value: unknown,
): Readonly<CompanyComputerCodePackageProvisionReceipt> {
	const r = record(
		value,
		"schema,planSha256,provisionId,resetId,rootIncarnationId,bootId,commandId,requestSha256,restoreSha256,state,targetRevision,packageManifestSha256,installedInventorySha256,sourceCommit,runtimeBundle,service",
	);
	if (r.schema !== "qorpera.office-code-package-provision-receipt/v1" || r.state !== "installed")
		throw new Error("INVALID_CODE_PACKAGE_RECEIPT");
	const ids = [r.provisionId, r.resetId, r.rootIncarnationId, r.bootId, r.commandId].map((v) => text(v, UUID));
	distinct(ids);
	return Object.freeze({
		schema: r.schema,
		state: "installed",
		provisionId: ids[0],
		resetId: ids[1],
		rootIncarnationId: ids[2],
		bootId: ids[3],
		commandId: ids[4],
		planSha256: text(r.planSha256, SHA),
		requestSha256: text(r.requestSha256, SHA),
		restoreSha256: text(r.restoreSha256, SHA),
		targetRevision: integer(r.targetRevision),
		packageManifestSha256: text(r.packageManifestSha256, SHA),
		installedInventorySha256: text(r.installedInventorySha256, SHA),
		sourceCommit: text(r.sourceCommit, /^[a-f0-9]{40}$/),
		runtimeBundle: bundle(r.runtimeBundle),
		service: service(r.service),
	});
}
