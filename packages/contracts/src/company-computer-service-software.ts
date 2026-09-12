import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
} from "./company-computer-lifecycle.ts";

export const COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH = "/opt/qorpera-office/qorpera-company-computer-service.mjs";
export interface CompanyComputerServiceSoftwareArtifact {
	readonly path: typeof COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH;
	readonly bytes: number;
	readonly sha256: string;
}
/** A separately signed service revision preserves the original image identity.
 * Package digests identify the original image package and reviewed inventories;
 * they do not claim that the retained root disk is a newly built image. */
export interface CompanyComputerServiceSoftwareStatement {
	readonly schema: "qorpera.office-service-software-statement/v1";
	readonly base: {
		readonly imageSha256: string;
		readonly bootstrapSha256: string;
		readonly packageManifestSha256: string;
		readonly sourceCommit: string;
	};
	readonly previous: {
		readonly packageManifestSha256: string;
		readonly sourceCommit: string;
		readonly service: CompanyComputerServiceSoftwareArtifact;
	};
	readonly next: { readonly packageManifestSha256: string; readonly service: CompanyComputerServiceSoftwareArtifact };
	readonly source: { readonly repository: string; readonly commit: string; readonly tree: "clean" };
	readonly acceptance: { readonly testedAt: string; readonly evidenceSha256: string; readonly change: "service-only" };
}
export interface CompanyComputerServiceSoftwareEnvelope {
	readonly schema: "qorpera.office-service-software-envelope/v1";
	readonly statement: CompanyComputerServiceSoftwareStatement;
	readonly signature: { readonly algorithm: "ed25519"; readonly value: string };
}
/** Protected operator/provider intent, not current SQL dispatch authority.
 * A stopped predecessor and future successor are immutable explicit bindings. */
export interface CompanyComputerServiceSoftwarePlan {
	readonly schema: "qorpera.office-service-software-plan/v1";
	readonly updateId: string;
	readonly predecessor: CompanyComputerLifecycleRequest;
	readonly stopAcknowledgementSha256: string;
	readonly successorActivationId: string;
	readonly statementSha256: string;
}
/** Historical installation data only. Protected root custody, actual byte
 * measurement and subsequent invocation admission are separate requirements. */
export interface CompanyComputerServiceSoftwareReceipt {
	readonly schema: "qorpera.office-service-software-receipt/v1";
	readonly plan: CompanyComputerServiceSoftwarePlan;
	readonly planSha256: string;
	readonly state: "installed";
	readonly service: CompanyComputerServiceSoftwareArtifact;
	readonly installedAt: string;
}
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error("OFFICE_SERVICE_SOFTWARE_RECORD_INVALID");
	const names = Reflect.ownKeys(value);
	if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key)))
		throw new Error("OFFICE_SERVICE_SOFTWARE_RECORD_INVALID");
	const copied: Record<string, unknown> = {};
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !Object.hasOwn(property, "value")) throw new Error("OFFICE_SERVICE_SOFTWARE_RECORD_INVALID");
		copied[key] = property.value;
	}
	return copied;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("OFFICE_SERVICE_SOFTWARE_DIGEST_INVALID");
	return value;
}
function commit(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
		throw new Error("OFFICE_SERVICE_SOFTWARE_SOURCE_INVALID");
	return value;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("OFFICE_SERVICE_SOFTWARE_ID_INVALID");
	return value;
}
function timestamp(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	)
		throw new Error("OFFICE_SERVICE_SOFTWARE_TIME_INVALID");
	return value;
}
function artifact(value: unknown): CompanyComputerServiceSoftwareArtifact {
	const r = record(value, ["path", "bytes", "sha256"]);
	if (
		r.path !== COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH ||
		!Number.isSafeInteger(r.bytes) ||
		(r.bytes as number) < 1 ||
		(r.bytes as number) > 32 * 1024 ** 2
	)
		throw new Error("OFFICE_SERVICE_SOFTWARE_ARTIFACT_INVALID");
	return Object.freeze({
		path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
		bytes: r.bytes as number,
		sha256: sha(r.sha256),
	});
}
export function parseCompanyComputerServiceSoftwareStatement(value: unknown): CompanyComputerServiceSoftwareStatement {
	const r = record(value, ["schema", "base", "previous", "next", "source", "acceptance"]);
	const base = record(r.base, ["imageSha256", "bootstrapSha256", "packageManifestSha256", "sourceCommit"]);
	const previous = record(r.previous, ["packageManifestSha256", "sourceCommit", "service"]);
	const next = record(r.next, ["packageManifestSha256", "service"]);
	const source = record(r.source, ["repository", "commit", "tree"]);
	const acceptance = record(r.acceptance, ["testedAt", "evidenceSha256", "change"]);
	if (typeof source.repository !== "string" || source.repository.length > 2048)
		throw new Error("OFFICE_SERVICE_SOFTWARE_SOURCE_INVALID");
	const repository = new URL(source.repository);
	if (
		r.schema !== "qorpera.office-service-software-statement/v1" ||
		repository.protocol !== "https:" ||
		repository.username ||
		repository.password ||
		repository.hash ||
		repository.search ||
		repository.toString() !== source.repository ||
		source.tree !== "clean" ||
		acceptance.change !== "service-only"
	)
		throw new Error("OFFICE_SERVICE_SOFTWARE_STATEMENT_INVALID");
	const oldService = artifact(previous.service),
		newService = artifact(next.service);
	if (oldService.sha256 === newService.sha256 || previous.packageManifestSha256 === next.packageManifestSha256)
		throw new Error("OFFICE_SERVICE_SOFTWARE_REVISION_UNCHANGED");
	return Object.freeze({
		schema: "qorpera.office-service-software-statement/v1",
		base: Object.freeze({
			imageSha256: sha(base.imageSha256),
			bootstrapSha256: sha(base.bootstrapSha256),
			packageManifestSha256: sha(base.packageManifestSha256),
			sourceCommit: commit(base.sourceCommit),
		}),
		previous: Object.freeze({
			packageManifestSha256: sha(previous.packageManifestSha256),
			sourceCommit: commit(previous.sourceCommit),
			service: oldService,
		}),
		next: Object.freeze({ packageManifestSha256: sha(next.packageManifestSha256), service: newService }),
		source: Object.freeze({ repository: source.repository, commit: commit(source.commit), tree: "clean" }),
		acceptance: Object.freeze({
			testedAt: timestamp(acceptance.testedAt),
			evidenceSha256: sha(acceptance.evidenceSha256),
			change: "service-only",
		}),
	});
}
export function parseCompanyComputerServiceSoftwareEnvelope(value: unknown): CompanyComputerServiceSoftwareEnvelope {
	const r = record(value, ["schema", "statement", "signature"]),
		signature = record(r.signature, ["algorithm", "value"]);
	if (
		r.schema !== "qorpera.office-service-software-envelope/v1" ||
		signature.algorithm !== "ed25519" ||
		typeof signature.value !== "string" ||
		!/^[A-Za-z0-9+/]{86}==$/.test(signature.value)
	)
		throw new Error("OFFICE_SERVICE_SOFTWARE_SIGNATURE_INVALID");
	return Object.freeze({
		schema: "qorpera.office-service-software-envelope/v1",
		statement: parseCompanyComputerServiceSoftwareStatement(r.statement),
		signature: Object.freeze({ algorithm: "ed25519", value: signature.value }),
	});
}
export function parseCompanyComputerServiceSoftwarePlan(value: unknown): CompanyComputerServiceSoftwarePlan {
	const r = record(value, [
		"schema",
		"updateId",
		"predecessor",
		"stopAcknowledgementSha256",
		"successorActivationId",
		"statementSha256",
	]);
	const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor);
	const updateId = uuid(r.updateId),
		successorActivationId = uuid(r.successorActivationId);
	if (
		r.schema !== "qorpera.office-service-software-plan/v1" ||
		predecessor.action !== "service_restart" ||
		new Set([updateId, successorActivationId, predecessor.activationId, predecessor.transitionId]).size !== 4
	)
		throw new Error("OFFICE_SERVICE_SOFTWARE_PLAN_INVALID");
	return Object.freeze({
		schema: "qorpera.office-service-software-plan/v1",
		updateId,
		predecessor,
		stopAcknowledgementSha256: sha(r.stopAcknowledgementSha256),
		successorActivationId,
		statementSha256: sha(r.statementSha256),
	});
}
export function parseCompanyComputerServiceSoftwareReceipt(value: unknown): CompanyComputerServiceSoftwareReceipt {
	const r = record(value, ["schema", "plan", "planSha256", "state", "service", "installedAt"]);
	if (r.schema !== "qorpera.office-service-software-receipt/v1" || r.state !== "installed")
		throw new Error("OFFICE_SERVICE_SOFTWARE_RECEIPT_INVALID");
	return Object.freeze({
		schema: "qorpera.office-service-software-receipt/v1",
		plan: parseCompanyComputerServiceSoftwarePlan(r.plan),
		planSha256: sha(r.planSha256),
		state: "installed",
		service: artifact(r.service),
		installedAt: timestamp(r.installedAt),
	});
}
