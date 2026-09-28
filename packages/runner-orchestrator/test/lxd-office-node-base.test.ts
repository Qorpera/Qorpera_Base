import { describe, expect, it } from "vitest";
import type { LxdOfficeInfrastructure } from "../src/lxd-client.ts";
import {
	type LxdOfficeNodeBasePorts,
	lxdOfficeNodeBaseSha256,
	lxdOfficeNodeObserverRecord,
	measureLxdOfficeNodeBase,
	officeNodeJournalMount,
	parseLxdOfficeNodeBaseConfig,
} from "../src/lxd-office-node-base.ts";
import { parseLxdOfficePhysicalPolicy } from "../src/lxd-office-physical-policy.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const signal = () => new AbortController().signal;
const nodeId = "77777777-7777-4777-8777-777777777777";
const config = () => ({
	schema: "qorpera.office-node-base-config/v1",
	nodeId,
	socketPath: "/var/snap/lxd/common/lxd/unix.socket",
	project: "offices",
	network: "office-net",
	storagePool: "office-pool",
	journal: { mountPoint: "/var/lib/qorpera-office-journals" },
	workbench: { serverAddress: "192.168.1.40", mountRoot: "/srv/qorpera-scratch" },
	ports: { from: 18600, to: 18699 },
});
const infrastructure = (): LxdOfficeInfrastructure => ({
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
});
const host = () => ({
	machineIdSha256: "c".repeat(64),
	socketPath: "/var/snap/lxd/common/lxd/unix.socket",
	socketGid: 998,
	certificateSha256: "e".repeat(64),
	serverName: "node-a",
	serverVersion: "6.9",
	architecture: "x86_64" as const,
});
const at = "/var/lib/qorpera-office-journals";
const mountInfo = [
	"22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
	`41 22 8:17 / ${at} rw,relatime shared:9 - ext4 /dev/sdb1 rw`,
	"52 22 0:48 / /srv/qorpera-scratch/a rw,nosuid,nodev,relatime shared:12 - nfs4 192.168.1.40:/volume1/scratch/a rw,vers=4.2,hard,proto=tcp",
].join("\n");
function ports(change: Partial<LxdOfficeNodeBasePorts> = {}): LxdOfficeNodeBasePorts {
	return {
		machineIdSha256: async () => "c".repeat(64),
		socketGid: async () => 998,
		server: async (project) => ({
			project,
			certificateSha256: "e".repeat(64),
			serverName: "node-a",
			serverVersion: "6.9",
			architecture: "x86_64",
		}),
		infrastructure: async () => infrastructure(),
		mountInfo: async () => mountInfo,
		hostNamespace: async () => {},
		observer: async () => ({ nodeId, host: host() }),
		...change,
	};
}
const observerConfig = (change: Record<string, unknown> = {}) =>
	Buffer.from(
		JSON.stringify({
			registryUrl: "https://registry.example",
			policy: {
				schema: "qorpera.runtime-node-inventory-policy/v1",
				nodeId,
				host: host(),
				operatingCpuMillis: 4000,
				operatingMemoryBytes: 4294967296,
				infrastructure: [],
				...change,
			},
		}),
	);

describe("node base for automatic company machine setup (step 1)", () => {
	it("measures the node's own values into a base that slots into a real machine policy", async () => {
		const base = await measureLxdOfficeNodeBase(config(), ports(), signal());
		expect(base).toEqual({
			schema: "qorpera.office-node-base/v1",
			nodeId,
			host: host(),
			infrastructure: base.infrastructure,
			guest: { project: "offices", network: "office-net", storagePool: "office-pool" },
			journal: { mountPoint: at, root: "/", filesystem: "ext4", source: "/dev/sdb1" },
			workbench: { serverAddress: "192.168.1.40", mountRoot: "/srv/qorpera-scratch" },
			ports: { from: 18600, to: 18699 },
		});
		// A machine's policy is node base + the waiting machine + its size: the node parts parse as a policy.
		const { policy } = officePhysicalFixture();
		const machine = {
			...policy,
			host: base.host,
			infrastructure: base.infrastructure,
			journal: { ...base.journal, path: `${base.journal.mountPoint}/machine-1` },
		};
		expect(parseLxdOfficePhysicalPolicy(JSON.parse(JSON.stringify(machine))).infrastructure).toEqual(
			policy.infrastructure,
		);
	});
	it("gives the same base, and the same digest, on every run", async () => {
		const [a, b] = await Promise.all([
			measureLxdOfficeNodeBase(config(), ports(), signal()),
			measureLxdOfficeNodeBase(config(), ports(), signal()),
		]);
		expect(a).toEqual(b);
		expect(lxdOfficeNodeBaseSha256(a)).toBe(lxdOfficeNodeBaseSha256(b));
	});
	it("requires the node observer's record and agrees with its node and host", async () => {
		await expect(
			measureLxdOfficeNodeBase(
				config(),
				ports({
					observer: async () => {
						throw new Error("OFFICE_NODE_BASE_OBSERVER_UNAVAILABLE");
					},
				}),
				signal(),
			),
		).rejects.toThrow("OFFICE_NODE_BASE_OBSERVER_UNAVAILABLE");
		await expect(
			measureLxdOfficeNodeBase(
				config(),
				ports({ observer: async () => ({ nodeId, host: { ...host(), socketGid: 997 } }) }),
				signal(),
			),
		).rejects.toThrow("OFFICE_NODE_BASE_OBSERVER_DIFFERS");
		await expect(
			measureLxdOfficeNodeBase(
				config(),
				ports({ observer: async () => ({ nodeId: "88888888-8888-4888-8888-888888888888", host: host() }) }),
				signal(),
			),
		).rejects.toThrow("OFFICE_NODE_BASE_OBSERVER_DIFFERS");
	});
	it("reads the observer's own configuration shape", () => {
		expect(lxdOfficeNodeObserverRecord(observerConfig())).toEqual({ nodeId, host: host() });
		for (const bad of [
			Buffer.from("not json"),
			Buffer.from(JSON.stringify({ policy: {} })),
			observerConfig({ host: { ...host(), extra: 1 } }),
			observerConfig({ nodeId: "node-a" }),
		])
			expect(() => lxdOfficeNodeObserverRecord(bad)).toThrow("OFFICE_NODE_BASE_OBSERVER_UNREADABLE");
	});
	it("refuses outside the host's mount namespace", async () => {
		await expect(
			measureLxdOfficeNodeBase(
				config(),
				ports({
					hostNamespace: async () => {
						throw new Error("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
					},
				}),
				signal(),
			),
		).rejects.toThrow("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
	});
	it.each([
		[
			"another project in the answer",
			{
				server: async () => ({
					project: "other",
					certificateSha256: "e".repeat(64),
					serverName: "n",
					serverVersion: "6.9",
					architecture: "x86_64",
				}),
			},
			"OFFICE_NODE_BASE_SERVER_UNSUPPORTED",
		],
		[
			"an unsupported architecture",
			{
				server: async (project: string) => ({
					project,
					certificateSha256: "e".repeat(64),
					serverName: "n",
					serverVersion: "6.9",
					architecture: "riscv64",
				}),
			},
			"OFFICE_NODE_BASE_SERVER_UNSUPPORTED",
		],
		["a root socket group", { socketGid: async () => 0 }, "OFFICE_NODE_BASE_SOCKET_UNPROTECTED"],
		["an impossible socket group", { socketGid: async () => 4294967295 }, "OFFICE_NODE_BASE_SOCKET_UNPROTECTED"],
		["a bad machine id", { machineIdSha256: async () => "nope" }, "INVALID_OFFICE_SHA256"],
	])("refuses %s", async (_label, change, error) => {
		await expect(
			measureLxdOfficeNodeBase(config(), ports(change as Partial<LxdOfficeNodeBasePorts>), signal()),
		).rejects.toThrow(error);
	});
	it("the journal must be one local, whole, writable filesystem", () => {
		expect(() => officeNodeJournalMount("22 1 8:2 / / rw - ext4 /dev/sda2 rw", at)).toThrow(
			"OFFICE_NODE_BASE_JOURNAL_NOT_MOUNTED",
		);
		for (const line of [
			`41 22 0:5 / ${at} rw - nfs4 nas:/j rw`,
			`41 22 8:17 / ${at} ro - ext4 /dev/sdb1 rw`,
			`41 22 8:17 / ${at} rw - ext4 /dev/sdb1 ro`,
			`41 22 8:17 /sub ${at} rw - ext4 /dev/sdb1 rw`,
			`41 22 8:17 / ${at} rw - ext4 /dev/${"x".repeat(4096)} rw`,
		])
			expect(() => officeNodeJournalMount(line, at)).toThrow("OFFICE_NODE_BASE_JOURNAL_UNSUITABLE");
		expect(() =>
			officeNodeJournalMount(
				`41 22 8:17 / ${at} rw - ext4 /dev/sdb1 rw\n42 22 8:18 / ${at} rw - ext4 /dev/sdc1 rw`,
				at,
			),
		).toThrow("OFFICE_NODE_BASE_JOURNAL_NOT_MOUNTED");
		expect(() => officeNodeJournalMount(`41 22 8:17 / ${at} rw ext4 /dev/sdb1 rw`, at)).toThrow(
			"OFFICE_NODE_BASE_MOUNT_UNCONFIRMED",
		);
		expect(() => officeNodeJournalMount("x".repeat(1048577), at)).toThrow("OFFICE_NODE_BASE_MOUNT_UNCONFIRMED");
		expect(officeNodeJournalMount(`41 22 8:17 / ${at} rw - xfs /dev/sdb1 rw`, at).filesystem).toBe("xfs");
		// Octal escapes in mountinfo are decoded; a decoded space is refused, never guessed around.
		expect(() =>
			officeNodeJournalMount(
				"41 22 8:17 / /var/lib/qorpera\\040journals rw - ext4 /dev/sdb1 rw",
				"/var/lib/qorpera journals",
			),
		).toThrow("OFFICE_NODE_BASE_MOUNT_UNSUPPORTED");
	});
	it("parses only a complete, consistent configuration", () => {
		expect(parseLxdOfficeNodeBaseConfig(config())).toEqual(config());
		for (const bad of [
			{ ...config(), extra: 1 },
			{ ...config(), nodeId: "node-a" },
			{ ...config(), project: "Offices" },
			{ ...config(), socketPath: "relative/socket" },
			{ ...config(), socketPath: "/srv/qorpera-scratch/lxd.socket" },
			{ ...config(), socketPath: `${at}/lxd.socket` },
			{ ...config(), ports: { from: 18600, to: 18600 } },
			{ ...config(), ports: { from: 18600, to: 18602 } },
			{ ...config(), ports: { from: 80, to: 91 } },
			{ ...config(), ports: { from: 65534, to: 65537 } },
			{ ...config(), ports: { from: 18600.5, to: 18700 } },
			{ ...config(), workbench: { serverAddress: "nas.local", mountRoot: "/srv/qorpera-scratch" } },
			{ ...config(), workbench: { serverAddress: "192.168.1.40", mountRoot: at } },
			{ ...config(), workbench: { serverAddress: "192.168.1.40", mountRoot: `${at}/scratch` } },
			{ ...config(), workbench: { serverAddress: "192.168.1.40", mountRoot: "/srv/identity/scratch" } },
			{ ...config(), journal: { mountPoint: "/srv/qorpera-scratch/journals" } },
		])
			expect(() => parseLxdOfficeNodeBaseConfig(bad)).toThrow();
	});
});
