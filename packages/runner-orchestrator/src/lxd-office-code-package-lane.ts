import { createHash } from "node:crypto";
import { officeImagePublicKey, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

/** Root-protected provider configuration, never part of a client reset request.
 * The base image manifest is independently bound to the enrolled physical policy.
 * The separate capability is loaded only into provider memory. */
export interface LxdOfficeCodePackageLaneDocument {
	readonly envelopePath: string;
	readonly planPath: string;
	readonly baseManifestPath: string;
	readonly targetManifestPath: string;
	readonly artifactRoot: string;
	readonly baseInstallationReceiptPath: string;
	readonly baseMountTemplatePath: string;
	/** Only for a base whose package carries the company folder's mount template (F3 4e-2). */
	readonly baseFolderMountTemplatePath?: string;
	readonly bootstrapToolPath: string;
	readonly measurementToolPath: string;
	readonly trust: {
		readonly verificationKeySpki: string;
		readonly statementSha256: string;
		readonly planSha256: string;
		readonly baseInstallationReceiptSha256: string;
		readonly unchangedExternalDependenciesSha256: string;
	};
	readonly providerCapabilityCredential: { readonly path: string; readonly bytes: 64; readonly sha256: string };
}
export function parseLxdOfficeCodePackageLaneDocument(value: unknown): Readonly<LxdOfficeCodePackageLaneDocument> {
	try {
		const optional =
			value && typeof value === "object" && "baseFolderMountTemplatePath" in value
				? (["baseFolderMountTemplatePath"] as const)
				: [];
		const r = officeRecord(value, [
			"schema",
			"envelopePath",
			"planPath",
			"baseManifestPath",
			"targetManifestPath",
			"artifactRoot",
			"baseInstallationReceiptPath",
			"baseMountTemplatePath",
			"bootstrapToolPath",
			"measurementToolPath",
			"trust",
			"providerCapabilityCredential",
			...optional,
		]);
		if (r.schema !== "qorpera.lxd-office-code-package-lane/v1") throw new Error("schema");
		const trust = officeRecord(r.trust, [
			"verificationKeySpki",
			"statementSha256",
			"planSha256",
			"baseInstallationReceiptSha256",
			"unchangedExternalDependenciesSha256",
		]);
		officeImagePublicKey(trust.verificationKeySpki);
		const credential = officeRecord(r.providerCapabilityCredential, ["path", "bytes", "sha256"]);
		if (credential.bytes !== 64) throw new Error("capability size");
		return Object.freeze({
			envelopePath: officePhysicalPath(r.envelopePath),
			planPath: officePhysicalPath(r.planPath),
			baseManifestPath: officePhysicalPath(r.baseManifestPath),
			targetManifestPath: officePhysicalPath(r.targetManifestPath),
			artifactRoot: officePhysicalPath(r.artifactRoot),
			baseInstallationReceiptPath: officePhysicalPath(r.baseInstallationReceiptPath),
			baseMountTemplatePath: officePhysicalPath(r.baseMountTemplatePath),
			...(optional.length ? { baseFolderMountTemplatePath: officePhysicalPath(r.baseFolderMountTemplatePath) } : {}),
			bootstrapToolPath: officePhysicalPath(r.bootstrapToolPath),
			measurementToolPath: officePhysicalPath(r.measurementToolPath),
			trust: Object.freeze({
				verificationKeySpki: trust.verificationKeySpki as string,
				statementSha256: officeSha(trust.statementSha256),
				planSha256: officeSha(trust.planSha256),
				baseInstallationReceiptSha256: officeSha(trust.baseInstallationReceiptSha256),
				unchangedExternalDependenciesSha256: officeSha(trust.unchangedExternalDependenciesSha256),
			}),
			providerCapabilityCredential: Object.freeze({
				path: officePhysicalPath(credential.path),
				bytes: 64 as const,
				sha256: officeSha(credential.sha256),
			}),
		});
	} catch {
		throw new Error("INVALID_OFFICE_CODE_PACKAGE_LANE");
	}
}
export async function loadLxdOfficeCodePackageCapability(
	document: Readonly<LxdOfficeCodePackageLaneDocument>,
	readCredential: (path: string, limit: number) => Promise<Buffer>,
): Promise<string> {
	const bytes = await readCredential(document.providerCapabilityCredential.path, 64);
	try {
		const capability = bytes.toString("ascii");
		if (
			bytes.length !== 64 ||
			!/^[0-9a-f]{64}$/.test(capability) ||
			createHash("sha256").update(bytes).digest("hex") !== document.providerCapabilityCredential.sha256
		)
			throw new Error("OFFICE_CODE_PACKAGE_CAPABILITY_UNCONFIRMED");
		return capability;
	} finally {
		bytes.fill(0);
	}
}
