import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { officeInstallHash } from "../src/lxd-office-installation.ts";
import {
	NODE_OBSERVER_INSTALL_ARTIFACTS,
	parseNodeObserverInstallationManifest,
	parseNodeObserverInstallationSpec,
	validateNodeObserverInstallationDocuments,
} from "../src/runtime-node-observer-installation.ts";

const ca = readFileSync(new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url));
function fixture() {
	const policy = {
		schema: "qorpera.runtime-node-inventory-policy/v1",
		nodeId: "11111111-1111-4111-8111-111111111111",
		host: {
			machineIdSha256: "a".repeat(64),
			socketPath: "/var/snap/lxd/common/lxd/unix.socket",
			socketGid: 2302,
			certificateSha256: "b".repeat(64),
			serverName: "node",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		operatingCpuMillis: 1000,
		operatingMemoryBytes: 1024 ** 3,
		infrastructure: [],
	};
	const documents = {
		service: Buffer.from(JSON.stringify({ registryUrl: "https://registry.example", policy })),
		key: Buffer.from("fixture-private-token-".repeat(3)),
		ca,
	};
	const spec = {
		schema: "qorpera.node-observer-installation/v1",
		packageRoot: "/staging/package",
		packageManifestSha256: "c".repeat(64),
		policySha256: officeDigest(policy),
		uid: 2301,
		gid: 2301,
		documents: Object.fromEntries(
			Object.entries(documents).map(([k, v]) => [
				k,
				{ path: `/staging/${k}`, bytes: v.length, sha256: officeInstallHash(v) },
			]),
		),
	};
	return { policy, documents, spec };
}
describe("protected headless observer installation contract", () => {
	it("validates the separate observer policy, private key, CA and socket group", () => {
		const f = fixture(),
			parsed = parseNodeObserverInstallationSpec(f.spec),
			result = validateNodeObserverInstallationDocuments(parsed, f.documents, "SupplementaryGroups=@SOCKET_GID@");
		expect(result.policy).toEqual(f.policy);
		expect(result.unit).toBe("SupplementaryGroups=2302");
		expect(JSON.stringify(parsed)).not.toContain(f.documents.key.toString());
	});
	it.each([0, -1, 1.5, "2301", [2301], null, 2147483648])("refuses invalid dedicated UID/GID %j", (value) => {
		const f = fixture();
		for (const name of ["uid", "gid"])
			expect(() => parseNodeObserverInstallationSpec({ ...f.spec, [name]: value })).toThrow();
	});
	it.each(["extra", "alias", "path", "bytes", "secret-hash"])("rejects altered specification %s", (fault) => {
		const f = fixture();
		if (fault === "extra") expect(() => parseNodeObserverInstallationSpec({ ...f.spec, extra: true })).toThrow();
		else {
			if (fault === "alias") f.spec.documents.key.path = f.spec.documents.service.path;
			if (fault === "path") f.spec.documents.key.path = "relative";
			if (fault === "bytes") f.spec.documents.key.bytes = 65537;
			if (fault === "secret-hash") f.spec.documents.key.sha256 = "not-a-hash";
			expect(() => parseNodeObserverInstallationSpec(f.spec)).toThrow();
		}
	});
	it.each(["policy-hash", "shared-group", "root-group", "service", "key", "ca", "duplicate-placeholder"])(
		"rejects mismatched installation documents %s",
		(fault) => {
			const f = fixture();
			if (fault === "policy-hash") f.spec.policySha256 = "d".repeat(64);
			if (fault === "shared-group") f.spec.gid = f.policy.host.socketGid;
			if (fault === "root-group") {
				f.policy.host.socketGid = 0;
				f.documents.service = Buffer.from(
					JSON.stringify({ registryUrl: "https://registry.example", policy: f.policy }),
				);
				f.spec.policySha256 = officeDigest(f.policy);
				f.spec.documents.service.bytes = f.documents.service.length;
				f.spec.documents.service.sha256 = officeInstallHash(f.documents.service);
			}
			if (["service", "key", "ca"].includes(fault))
				f.documents[fault as "service" | "key" | "ca"] = Buffer.from("changed");
			expect(() =>
				validateNodeObserverInstallationDocuments(
					parseNodeObserverInstallationSpec(f.spec),
					f.documents,
					fault === "duplicate-placeholder" ? "@SOCKET_GID@ @SOCKET_GID@" : "@SOCKET_GID@",
				),
			).toThrow();
		},
	);
	it("requires all five exact package artifacts, including the executing installer", () => {
		const m = {
			schema: "qorpera.runtime-node-observer-package/v1",
			runtime: { node: ">=22.19.0", platform: "linux" },
			artifacts: NODE_OBSERVER_INSTALL_ARTIFACTS.map((file) => ({ file, bytes: 100, sha256: "a".repeat(64) })),
		};
		expect(parseNodeObserverInstallationManifest(m)).toEqual(m.artifacts);
		expect(() => parseNodeObserverInstallationManifest({ ...m, artifacts: m.artifacts.slice(1) })).toThrow();
		expect(() => parseNodeObserverInstallationManifest({ ...m, artifacts: [...m.artifacts].reverse() })).toThrow();
		expect(() =>
			parseNodeObserverInstallationManifest({ ...m, artifacts: m.artifacts.map((a) => ({ ...a, bytes: "100" })) }),
		).toThrow();
	});
});
