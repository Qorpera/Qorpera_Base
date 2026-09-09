import { X509Certificate } from "node:crypto";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officeInstallHash } from "./lxd-office-installation.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { parseRuntimeNodeInventoryPolicy } from "./runtime-node-inventory.ts";
import { RuntimeNodeObserverHttpRegistry } from "./runtime-node-observer-service.ts";

export const NODE_OBSERVER_INSTALL_ROOT = "/opt/qorpera/node-observer";
export const NODE_OBSERVER_USER = "qorpera-node-observer";
export const NODE_OBSERVER_INSTALL_ARTIFACTS = [
	"qorpera-node-observer.cjs",
	"qorpera-node-host-namespace.cjs",
	"qorpera-node-observer-install.cjs",
	"qorpera-node-observer.service.in",
	"qorpera-node-host-namespace.service",
] as const;
export const NODE_OBSERVER_INSTALL_DOCUMENTS = {
	service: { path: "/etc/qorpera/node-observer.json", maxBytes: 65536, mode: 0o444 },
	key: { path: "/etc/qorpera/node-observer.key", maxBytes: 4096, mode: 0o440 },
	ca: { path: "/etc/qorpera/node-observer-ca.pem", maxBytes: 65536, mode: 0o444 },
} as const;
export type NodeObserverInstallDocument = keyof typeof NODE_OBSERVER_INSTALL_DOCUMENTS;
const keys = Object.keys(NODE_OBSERVER_INSTALL_DOCUMENTS) as NodeObserverInstallDocument[];
function id(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
		throw new Error("NODE_OBSERVER_INSTALL_ID_INVALID");
	return value as number;
}
export function parseNodeObserverInstallationSpec(value: unknown) {
	const s = officeRecord(value, [
		"schema",
		"packageRoot",
		"packageManifestSha256",
		"policySha256",
		"uid",
		"gid",
		"documents",
	]);
	if (s.schema !== "qorpera.node-observer-installation/v1") throw new Error("NODE_OBSERVER_INSTALL_SPEC_INVALID");
	const d = officeRecord(s.documents, keys),
		documents = {} as Record<NodeObserverInstallDocument, { path: string; bytes: number; sha256: string }>;
	for (const key of keys) {
		const r = officeRecord(d[key], ["path", "bytes", "sha256"]);
		if (
			!Number.isSafeInteger(r.bytes) ||
			(r.bytes as number) < 1 ||
			(r.bytes as number) > NODE_OBSERVER_INSTALL_DOCUMENTS[key].maxBytes
		)
			throw new Error("NODE_OBSERVER_INSTALL_DOCUMENT_INVALID");
		documents[key] = { path: officePhysicalPath(r.path), bytes: r.bytes as number, sha256: officeSha(r.sha256) };
	}
	if (new Set(keys.map((k) => documents[k].path)).size !== keys.length)
		throw new Error("NODE_OBSERVER_INSTALL_DOCUMENT_ALIAS");
	return {
		packageRoot: officePhysicalPath(s.packageRoot),
		packageManifestSha256: officeSha(s.packageManifestSha256),
		policySha256: officeSha(s.policySha256),
		uid: id(s.uid),
		gid: id(s.gid),
		documents,
	};
}
export function parseNodeObserverInstallationManifest(value: unknown) {
	const m = officeRecord(value, ["schema", "runtime", "artifacts"]),
		runtime = officeRecord(m.runtime, ["node", "platform"]);
	if (
		m.schema !== "qorpera.runtime-node-observer-package/v1" ||
		runtime.node !== ">=22.19.0" ||
		runtime.platform !== "linux" ||
		!Array.isArray(m.artifacts) ||
		m.artifacts.length !== NODE_OBSERVER_INSTALL_ARTIFACTS.length
	)
		throw new Error("NODE_OBSERVER_INSTALL_PACKAGE_INVALID");
	return m.artifacts.map((value, index) => {
		const a = officeRecord(value, ["file", "bytes", "sha256"]);
		if (
			a.file !== NODE_OBSERVER_INSTALL_ARTIFACTS[index] ||
			!Number.isSafeInteger(a.bytes) ||
			(a.bytes as number) < 1 ||
			(a.bytes as number) > 2 * 1024 ** 2
		)
			throw new Error("NODE_OBSERVER_INSTALL_ARTIFACT_INVALID");
		return { file: a.file as string, bytes: a.bytes as number, sha256: officeSha(a.sha256) };
	});
}
export function validateNodeObserverInstallationDocuments(
	spec: ReturnType<typeof parseNodeObserverInstallationSpec>,
	documents: Record<NodeObserverInstallDocument, Buffer>,
	template: string,
) {
	const decode = (key: NodeObserverInstallDocument) => {
		const bytes = documents[key],
			ref = spec.documents[key];
		if (bytes.length !== ref.bytes || officeInstallHash(bytes) !== ref.sha256)
			throw new Error("NODE_OBSERVER_INSTALL_DOCUMENT_CHANGED");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes);
	};
	const config = officeRecord(JSON.parse(decode("service")), ["registryUrl", "policy"]),
		policy = parseRuntimeNodeInventoryPolicy(config.policy);
	if (
		typeof config.registryUrl !== "string" ||
		officeDigest(policy) !== spec.policySha256 ||
		policy.host.socketGid === 0 ||
		policy.host.socketGid === spec.gid
	)
		throw new Error("NODE_OBSERVER_INSTALL_POLICY_DIFFERS");
	new RuntimeNodeObserverHttpRegistry(config.registryUrl, decode("key").trim());
	const ca = new X509Certificate(decode("ca"));
	if (!ca.ca || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now())
		throw new Error("NODE_OBSERVER_INSTALL_CA_INVALID");
	if (template.split("@SOCKET_GID@").length !== 2) throw new Error("NODE_OBSERVER_INSTALL_UNIT_INVALID");
	return { policy, unit: template.replace("@SOCKET_GID@", String(policy.host.socketGid)) };
}
