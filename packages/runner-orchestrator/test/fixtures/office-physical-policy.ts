import { generateKeyPairSync, sign } from "node:crypto";
import type { LxdOfficeInfrastructure } from "../../src/lxd-client.ts";
import type { LxdOfficeGuestBinding } from "../../src/lxd-office-guest.ts";
import { type LxdOfficeImageStatement, officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import { type LxdOfficePhysicalPolicy, lxdOfficePhysicalPolicySha256 } from "../../src/lxd-office-physical-policy.ts";

// Ephemeral in-memory signatures over synthetic test records only. These keys
// never sign a candidate, use a release key, or write an artifact to disk.
const keys = generateKeyPairSync("ed25519");
export function officePhysicalFixture(architecture: "x86_64" | "aarch64" = "x86_64") {
	const statement: LxdOfficeImageStatement = {
		schema: "qorpera.lxd-office-image-provenance/v1",
		image: {
			fingerprint: "a".repeat(64),
			baseFingerprint: "b".repeat(64),
			architecture,
			bytes: 1024,
			guestPackageManifestSha256: "c".repeat(64),
			bootstrapSha256: "d".repeat(64),
		},
		source: { repository: "https://example.test/office.git", commit: "e".repeat(40), tree: "clean" },
		acceptance: {
			testedAt: "2026-09-08T00:00:00.000Z",
			evidenceSha256: "f".repeat(64),
			virtualization: "kvm",
			bootMode: "uefi-secureboot",
			secureBoot: true,
			credentials: "absent",
			computeIdentity: "absent",
			companyState: "absent",
			services: "fail-closed",
		},
	};
	const envelope = {
		schema: "qorpera.lxd-office-image-provenance-envelope/v1",
		statement,
		signature: {
			algorithm: "ed25519",
			value: sign(null, Buffer.from(officeCanonical(statement)), keys.privateKey).toString("base64"),
		},
	};
	const infrastructure: LxdOfficeInfrastructure = {
		project: {
			name: "offices",
			config: { "features.images": "true", "features.profiles": "true", "features.networks": "false" },
			replicaMode: "",
		},
		network: {
			name: "office-net",
			project: "default",
			type: "bridge",
			managed: true,
			status: "Created",
			config: { "ipv4.address": "10.44.0.1/24", "ipv4.nat": "true", "ipv6.address": "none" },
		},
		storagePool: { name: "office-pool", driver: "zfs", status: "Created", config: { source: "office-pool" } },
	};
	const policy: LxdOfficePhysicalPolicy = {
		schema: "qorpera.lxd-office-physical-policy/v2",
		infrastructure: {
			projectSha256: officeDigest(infrastructure.project),
			networkSha256: officeDigest(infrastructure.network),
			storagePoolSha256: officeDigest(infrastructure.storagePool),
		},
		guest: {
			providerId: "11111111-1111-4111-8111-111111111111",
			companyId: "22222222-2222-4222-8222-222222222222",
			environmentId: "33333333-3333-4333-8333-333333333333",
			companyComputerId: "44444444-4444-4444-8444-444444444444",
			logicalComputerId: "55555555-5555-4555-8555-555555555555",
			computerGeneration: 1,
			project: "offices",
			imageFingerprint: statement.image.fingerprint,
			bootstrapSha256: statement.image.bootstrapSha256,
			storagePool: "office-pool",
			rootDiskBytes: 1024 ** 3,
			workbenchSource: "/mnt/office-workbench",
			network: "office-net",
			cpus: 2,
			memoryBytes: 1024 ** 3,
		},
		host: {
			machineIdSha256: "1".repeat(64),
			socketPath: "/run/office-lxd/unix.socket",
			socketGid: 1001,
			certificateSha256: "2".repeat(64),
			serverName: "office-host",
			serverVersion: "6.9",
			architecture,
		},
		image: {
			bytes: statement.image.bytes,
			guestPackageManifestSha256: statement.image.guestPackageManifestSha256,
			statementSha256: officeDigest(statement),
			verificationKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
		},
		workbench: {
			mountPoint: "/mnt/office-workbench",
			root: "/",
			filesystem: "nfs4",
			source: "192.0.2.1:/offices/test",
			serverAddress: "192.0.2.1",
			uid: 1000,
			gid: 1000,
		},
		journal: {
			path: "/mnt/office-journal/state",
			mountPoint: "/mnt/office-journal",
			root: "/",
			filesystem: "ext4",
			source: "/dev/vdb",
		},
	};
	const binding: LxdOfficeGuestBinding = {
		schema: "qorpera.lxd-office-guest/v2",
		...policy.guest,
		allocationId: "66666666-6666-4666-8666-666666666666",
		providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
	};
	return { policy, statement, envelope, binding, infrastructure };
}
