import { createHash, X509Certificate } from "node:crypto";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "./lxd-office-lifecycle-service.ts";
import {
	assertLxdOfficePhysicalImage,
	lxdOfficePhysicalPolicySha256,
	officePhysicalPath,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";
import { LxdOfficeProviderHttpRegistry } from "./lxd-office-provider-registry.ts";

export const OFFICE_INSTALL_ROOT = "/opt/qorpera/office-provider";
export const OFFICE_CONFIG_ROOT = "/etc/qorpera/office-provider";
export const OFFICE_PROVIDER_USER = "qorpera-office-provider";
export const OFFICE_INSTALL_DOCUMENTS = {
	service: { file: "service.json", maxBytes: 16384, mode: 0o444 },
	policy: { file: "policy.json", maxBytes: 16384, mode: 0o444 },
	provenance: { file: "provenance.json", maxBytes: 16384, mode: 0o444 },
	registry: { file: "registry.credential", maxBytes: 4096, mode: 0o440 },
	registryCa: { file: "registry-ca.pem", maxBytes: 65536, mode: 0o444 },
} as const;
export type OfficeInstallDocument = keyof typeof OFFICE_INSTALL_DOCUMENTS;
export const OFFICE_INSTALL_ARTIFACTS = [
	"qorpera-office-provider.cjs",
	"qorpera-office-host-namespace.cjs",
	"qorpera-office-provider-install.cjs",
	"qorpera-office-software-update.cjs",
	"qorpera-office-provider.service.in",
	"qorpera-office-host-namespace.service",
] as const;
const documentKeys = Object.keys(OFFICE_INSTALL_DOCUMENTS) as OfficeInstallDocument[];
export const officeInstallHash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function parseOfficeInstallationSpec(value: unknown) {
	const r = officeRecord(value, [
		"schema",
		"packageRoot",
		"packageManifestSha256",
		"providerPolicySha256",
		"documents",
	]);
	if (r.schema !== "qorpera.lxd-office-provider-installation/v1") throw new Error("INVALID_OFFICE_INSTALLATION");
	const docs = officeRecord(r.documents, documentKeys);
	const documents = {} as Record<OfficeInstallDocument, { path: string; bytes: number; sha256: string }>;
	for (const key of documentKeys) {
		const ref = officeRecord(docs[key], ["path", "bytes", "sha256"]);
		if (
			!Number.isSafeInteger(ref.bytes) ||
			(ref.bytes as number) < 1 ||
			(ref.bytes as number) > OFFICE_INSTALL_DOCUMENTS[key].maxBytes
		)
			throw new Error("INVALID_OFFICE_INSTALL_DOCUMENT");
		documents[key] = {
			path: officePhysicalPath(ref.path),
			bytes: ref.bytes as number,
			sha256: officeSha(ref.sha256),
		};
	}
	if (new Set(documentKeys.map((key) => documents[key].path)).size !== documentKeys.length)
		throw new Error("OFFICE_INSTALL_DOCUMENT_ALIAS");
	return {
		packageRoot: officePhysicalPath(r.packageRoot),
		packageManifestSha256: officeSha(r.packageManifestSha256),
		providerPolicySha256: officeSha(r.providerPolicySha256),
		documents,
	};
}

export function parseOfficeInstallationManifest(value: unknown) {
	const r = officeRecord(value, ["schema", "runtime", "artifacts"]),
		runtime = officeRecord(r.runtime, ["node", "platform"]);
	if (
		r.schema !== "qorpera.lxd-office-provider-package/v1" ||
		runtime.node !== ">=22.19.0" ||
		runtime.platform !== "linux" ||
		!Array.isArray(r.artifacts) ||
		r.artifacts.length !== OFFICE_INSTALL_ARTIFACTS.length
	)
		throw new Error("INVALID_OFFICE_INSTALL_PACKAGE");
	return r.artifacts.map((value, index) => {
		const a = officeRecord(value, ["file", "bytes", "sha256"]);
		if (
			a.file !== OFFICE_INSTALL_ARTIFACTS[index] ||
			!Number.isSafeInteger(a.bytes) ||
			(a.bytes as number) < 1 ||
			(a.bytes as number) > 2 * 1024 ** 2
		)
			throw new Error("INVALID_OFFICE_INSTALL_ARTIFACT");
		return { file: a.file as string, bytes: a.bytes as number, sha256: officeSha(a.sha256) };
	});
}

/** Quote a literal systemd path. Only command arguments expand environment
 * variables; dependency paths expand specifiers but retain literal dollars. */
export function officeSystemdPath(path: string, context: "command" | "dependency" = "command"): string {
	officePhysicalPath(path);
	const literal = path.replace(/%/g, "%%").replace(/"/g, '\\"');
	return `"${context === "command" ? literal.replace(/\$/g, "$$$$") : literal}"`;
}

export function validateOfficeInstallationDocuments(
	spec: ReturnType<typeof parseOfficeInstallationSpec>,
	documents: Record<OfficeInstallDocument, Buffer>,
	unitTemplate: string,
) {
	const decode = (key: OfficeInstallDocument) => {
		const bytes = documents[key],
			ref = spec.documents[key];
		if (bytes.length !== ref.bytes || officeInstallHash(bytes) !== ref.sha256)
			throw new Error("OFFICE_INSTALL_DOCUMENT_CHANGED");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes);
	};
	const service = parseLxdOfficeLifecycleServiceConfig(JSON.parse(decode("service")));
	const policy = parseLxdOfficePhysicalPolicy(JSON.parse(decode("policy")));
	assertLxdOfficePhysicalImage(policy, JSON.parse(decode("provenance")));
	if (
		lxdOfficePhysicalPolicySha256(policy) !== spec.providerPolicySha256 ||
		policy.workbench.gid === 0 ||
		policy.host.socketGid === 0 ||
		policy.host.socketGid === policy.workbench.gid
	)
		throw new Error("OFFICE_INSTALL_POLICY_MISMATCH");
	if (
		service.policyPath !== `${OFFICE_CONFIG_ROOT}/policy.json` ||
		service.provenancePath !== `${OFFICE_CONFIG_ROOT}/provenance.json` ||
		service.planPath !== `${OFFICE_CONFIG_ROOT}/review.json` ||
		service.registryCredential.path !== `${OFFICE_CONFIG_ROOT}/registry.credential` ||
		service.registryCredential.bytes !== spec.documents.registry.bytes ||
		service.registryCredential.sha256 !== spec.documents.registry.sha256
	)
		throw new Error("OFFICE_INSTALL_CONFIG_MISMATCH");
	new LxdOfficeProviderHttpRegistry(service.registryUrl, decode("registry"));
	const certificate = new X509Certificate(decode("registryCa"));
	if (
		!certificate.ca ||
		Date.parse(certificate.validFrom) > Date.now() ||
		Date.parse(certificate.validTo) <= Date.now()
	)
		throw new Error("OFFICE_INSTALL_CA_INVALID");
	if (
		["@SOCKET_GID@", "@JOURNAL_LOCK@", "@JOURNAL_MOUNT@", "@WORKBENCH_MOUNT@"].some(
			(marker) => unitTemplate.split(marker).length !== 2,
		)
	)
		throw new Error("OFFICE_INSTALL_UNIT_INVALID");
	const unit = unitTemplate
		.replace("@SOCKET_GID@", String(policy.host.socketGid))
		.replace("@JOURNAL_LOCK@", () => officeSystemdPath(`${policy.journal.path}/adoption.lock`))
		.replace("@JOURNAL_MOUNT@", () => officeSystemdPath(policy.journal.mountPoint, "dependency"))
		.replace("@WORKBENCH_MOUNT@", () => officeSystemdPath(policy.workbench.mountPoint, "dependency"));
	return { policy, service, unit, uid: policy.workbench.uid, gid: policy.workbench.gid };
}
