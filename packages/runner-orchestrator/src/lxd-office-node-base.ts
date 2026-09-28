import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
	type LxdOfficeInfrastructure,
	type LxdOfficeInspectableClient,
	type LxdOfficeServerIdentity,
	LxdUnixClient,
} from "./lxd-client.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import {
	type LxdOfficeMountPolicy,
	type LxdOfficePhysicalPolicy,
	officePhysicalPath,
} from "./lxd-office-physical-policy.ts";
import { readRuntimeNodeHost } from "./runtime-node-host.ts";

// Automatic company machine setup, step 1 (design page "Company Machine Setup"). A node declares once
// where its company machines live (LXD project, network, pool, the local journal mount, the NAS and the
// scratch-folder mount root, a port range). The measure step reads everything node-specific that a
// machine's physical policy needs from the node itself, never from another machine: the host identity
// the node observer also checks, the LXD infrastructure digests the office gate compares, and the
// journal mount. A machine's policy is then node base + the waiting machine + its size.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LXD_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const JOURNAL_FILESYSTEMS = ["ext4", "xfs", "btrfs", "zfs"];

export interface LxdOfficeNodeBaseConfig {
	schema: "qorpera.office-node-base-config/v1";
	nodeId: string;
	socketPath: string;
	project: string;
	network: string;
	storagePool: string;
	/** The local mount that holds every machine's journal directory. */
	journal: { mountPoint: string };
	/** The NAS, and the local folder under which each machine's scratch folder is mounted. */
	workbench: { serverAddress: string; mountRoot: string };
	/** Ports for the machines' viewer and native passthrough; two per machine. */
	ports: { from: number; to: number };
}

export interface LxdOfficeNodeBase {
	schema: "qorpera.office-node-base/v1";
	nodeId: string;
	host: LxdOfficePhysicalPolicy["host"];
	infrastructure: LxdOfficePhysicalPolicy["infrastructure"];
	guest: { project: string; network: string; storagePool: string };
	journal: LxdOfficeMountPolicy;
	workbench: { serverAddress: string; mountRoot: string };
	ports: { from: number; to: number };
}

function port(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1024 || (value as number) > 65535)
		throw new Error("INVALID_OFFICE_NODE_BASE_CONFIG");
	return value as number;
}
function lxdName(value: unknown): string {
	if (typeof value !== "string" || !LXD_NAME.test(value)) throw new Error("INVALID_OFFICE_NODE_BASE_CONFIG");
	return value;
}

export function parseLxdOfficeNodeBaseConfig(value: unknown): LxdOfficeNodeBaseConfig {
	const c = officeRecord(value, [
		"schema",
		"nodeId",
		"socketPath",
		"project",
		"network",
		"storagePool",
		"journal",
		"workbench",
		"ports",
	]);
	const journal = officeRecord(c.journal, ["mountPoint"]);
	const workbench = officeRecord(c.workbench, ["serverAddress", "mountRoot"]);
	const ports = officeRecord(c.ports, ["from", "to"]);
	if (c.schema !== "qorpera.office-node-base-config/v1" || typeof c.nodeId !== "string" || !UUID.test(c.nodeId))
		throw new Error("INVALID_OFFICE_NODE_BASE_CONFIG");
	if (typeof workbench.serverAddress !== "string" || isIP(workbench.serverAddress) === 0)
		throw new Error("INVALID_OFFICE_NODE_BASE_CONFIG");
	const from = port(ports.from),
		to = port(ports.to);
	const journalMount = officePhysicalPath(journal.mountPoint),
		mountRoot = officePhysicalPath(workbench.mountRoot);
	if (
		to - from < 1 ||
		journalMount === mountRoot ||
		journalMount.startsWith(`${mountRoot}/`) ||
		mountRoot.startsWith(`${journalMount}/`)
	)
		throw new Error("INVALID_OFFICE_NODE_BASE_CONFIG");
	return {
		schema: c.schema,
		nodeId: c.nodeId,
		socketPath: officePhysicalPath(c.socketPath),
		project: lxdName(c.project),
		network: lxdName(c.network),
		storagePool: lxdName(c.storagePool),
		journal: { mountPoint: journalMount },
		workbench: { serverAddress: workbench.serverAddress, mountRoot },
		ports: { from, to },
	};
}

/** Everything the measurement reads, injectable for tests. Every port is read-only. */
export interface LxdOfficeNodeBasePorts {
	machineIdSha256(signal: AbortSignal): Promise<string>;
	/** The LXD socket's group; the socket must be root-owned, mode 0660. */
	socketGid(path: string): Promise<number>;
	server(project: string, signal: AbortSignal): Promise<LxdOfficeServerIdentity>;
	infrastructure(
		project: string,
		network: string,
		pool: string,
		signal: AbortSignal,
	): Promise<LxdOfficeInfrastructure>;
	mountInfo(): Promise<string>;
	/** The node observer's enrolled host record, or null when this node has no observer configuration. */
	observerHost(): Promise<unknown>;
}

function decodeMountField(value: string): string {
	const decoded = value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
	if (/[\x00-\x20\x7f\\]/.test(decoded)) throw new Error("OFFICE_NODE_BASE_MOUNT_UNSUPPORTED");
	return decoded;
}

/** The one mount at `mountPoint`, from /proc/self/mountinfo: whole filesystem (root "/"), local, writable. */
export function officeNodeJournalMount(mountInfo: string, mountPoint: string): LxdOfficeMountPolicy {
	if (Buffer.byteLength(mountInfo) > 1048576) throw new Error("OFFICE_NODE_BASE_MOUNT_UNCONFIRMED");
	const lines = mountInfo
		.trim()
		.split("\n")
		.map((line) => {
			const [prefix, suffix, extra] = line.split(" - ");
			const before = prefix.split(" "),
				after = suffix?.split(" ");
			if (extra !== undefined || before.length < 6 || !after || after.length !== 3)
				throw new Error("OFFICE_NODE_BASE_MOUNT_UNCONFIRMED");
			return {
				root: decodeMountField(before[3]),
				mountPoint: decodeMountField(before[4]),
				options: before[5].split(","),
				filesystem: after[0],
				source: decodeMountField(after[1]),
				superOptions: after[2].split(","),
			};
		});
	const matches = lines.filter((line) => line.mountPoint === mountPoint);
	if (matches.length !== 1) throw new Error("OFFICE_NODE_BASE_JOURNAL_NOT_MOUNTED");
	const m = matches[0];
	if (
		m.root !== "/" ||
		!JOURNAL_FILESYSTEMS.includes(m.filesystem) ||
		!m.options.includes("rw") ||
		!m.superOptions.includes("rw")
	)
		throw new Error("OFFICE_NODE_BASE_JOURNAL_UNSUITABLE");
	return { mountPoint, root: "/", filesystem: m.filesystem, source: m.source };
}

/** Reads the node's own values. Changes nothing. The result is the same on every run while the node's
 * setup is unchanged, so a stored base can be compared with a fresh measurement. */
export async function measureLxdOfficeNodeBase(
	configValue: unknown,
	ports: LxdOfficeNodeBasePorts,
	signal: AbortSignal,
): Promise<LxdOfficeNodeBase> {
	const c = parseLxdOfficeNodeBaseConfig(configValue);
	const machineIdSha256 = officeSha(await ports.machineIdSha256(signal));
	const socketGid = await ports.socketGid(c.socketPath);
	if (!Number.isSafeInteger(socketGid) || socketGid < 1 || socketGid > 4294967294)
		throw new Error("OFFICE_NODE_BASE_SOCKET_UNPROTECTED");
	const server = await ports.server(c.project, signal);
	if (server.project !== c.project || !["x86_64", "aarch64"].includes(server.architecture))
		throw new Error("OFFICE_NODE_BASE_SERVER_UNSUPPORTED");
	const infrastructure = await ports.infrastructure(c.project, c.network, c.storagePool, signal);
	const journal = officeNodeJournalMount(await ports.mountInfo(), c.journal.mountPoint);
	signal.throwIfAborted();
	const host: LxdOfficeNodeBase["host"] = {
		machineIdSha256,
		socketPath: c.socketPath,
		socketGid,
		certificateSha256: officeSha(server.certificateSha256),
		serverName: server.serverName,
		serverVersion: server.serverVersion,
		architecture: server.architecture as "x86_64" | "aarch64",
	};
	// The node observer checks the same host; a different answer means the configuration names another
	// socket or the observer's record is stale. Either way, stop before anything is built on it.
	const observed = await ports.observerHost();
	if (observed !== null && !isDeepStrictEqual(observed, host)) throw new Error("OFFICE_NODE_BASE_OBSERVER_DIFFERS");
	return {
		schema: "qorpera.office-node-base/v1",
		nodeId: c.nodeId,
		host,
		infrastructure: {
			projectSha256: officeDigest(infrastructure.project),
			networkSha256: officeDigest(infrastructure.network),
			storagePoolSha256: officeDigest(infrastructure.storagePool),
		},
		guest: { project: c.project, network: c.network, storagePool: c.storagePool },
		journal,
		workbench: { ...c.workbench },
		ports: { ...c.ports },
	};
}

const OBSERVER_CONFIG = "/etc/qorpera/node-observer.json";

/** The production readers: the node's own files and its local LXD daemon. */
export function lxdOfficeNodeBasePorts(
	socketPath: string,
	client?: LxdOfficeInspectableClient,
): LxdOfficeNodeBasePorts {
	const lxd = client ?? new LxdUnixClient(socketPath);
	return {
		machineIdSha256: async (signal) => (await readRuntimeNodeHost(signal)).machineIdSha256,
		socketGid: async (path) => {
			const socket = await lstat(path);
			if (!socket.isSocket() || socket.uid !== 0 || (socket.mode & 0o7777) !== 0o660)
				throw new Error("OFFICE_NODE_BASE_SOCKET_UNPROTECTED");
			return socket.gid;
		},
		server: (project, signal) => lxd.inspectOfficeServer(project, signal),
		infrastructure: (project, network, pool, signal) =>
			lxd.inspectOfficeInfrastructure(project, network, pool, signal),
		mountInfo: () => readFile("/proc/self/mountinfo", "utf8"),
		observerHost: async () => {
			let bytes: Buffer;
			try {
				bytes = await readLxdOfficeProtectedFile(OBSERVER_CONFIG, 65536);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
				throw error;
			}
			const config = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as {
				policy?: { host?: unknown };
			};
			return config.policy?.host ?? null;
		},
	};
}

/** The base's own digest, for a stored base to name what it was measured as. */
export function lxdOfficeNodeBaseSha256(base: LxdOfficeNodeBase): string {
	return officeDigest(base);
}
