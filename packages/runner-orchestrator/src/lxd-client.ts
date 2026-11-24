import { X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CODING_GUEST_HELPER_MAX_BYTES } from "@qorpera/contracts";
import { withAbortScopes, withTimeoutScope } from "./abort-scope.ts";
import { AGENT_BRIDGE } from "./agent-plug.ts";
import { lxdMacAddress } from "./lxd-guest-network.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";
import { NodeWebSocket } from "./node-websocket.ts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_INSTANCE_FILE_BYTES = 256 * 1024;
/** A coding guest helper, which the executor reads whole to compare it with its pin: within
 * CODING_GUEST_HELPER_MAX_BYTES, the only file read past 64 KiB. */
const CODING_GUEST_HELPER_PATH = /^\/opt\/qorpera-coding\/[a-z][a-z-]{0,62}\.mjs$/;
/** The folder program is about 1.5 MiB. */
const MAX_INSTANCE_PROGRAM_BYTES = 16 * 1024 * 1024;
/** One file directly in the guest agent's or the folder program's folder (LxdInstanceProgramClient). */
const GUEST_PROGRAM_PATH = /^\/opt\/qorpera-(guest|folder)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_EXEC_STREAM_INPUT_BYTES = 64 * 1024;
const MAX_EXEC_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024;
const CODING_MEMORY_CODING_SLICE =
	/^\/sys\/fs\/cgroup\/qorpera\.slice\/qorpera-coding\.slice\/qorpera-coding-[0-9a-f]{32}\.slice\/memory\.stat$/;
const CODING_MEMORY_FOLDER_SERVICE =
	/^\/sys\/fs\/cgroup\/(?:system|qorpera-folder)\.slice\/qorpera-folder-[0-9a-f]{32}\.service\/memory\.stat$/;
const CODING_MEMORY_USER_SLICE = /^\/sys\/fs\/cgroup\/user\.slice\/user-([2-5][0-9]{5})\.slice\/memory\.stat$/;
const CODING_MEMORY_HEADER = /^=== (\/[A-Za-z0-9/_.-]+) ===$/;
const CODING_MEMORY_BATCH_SIZE = 58;
const CODING_MEMORY_MAX_GROUPS = 1024;
const CODING_MEMORY_TIMEOUT_MS = 10_000;
const CODING_MEMORY_MAX_STDOUT_BYTES = 256 * 1024;
const CODING_MEMORY_MAX_STDERR_BYTES = 1024;
const CODING_MEMORY_READ_SCRIPT =
	'for p in "$@"; do printf "=== %s ===\\n" "$p"; [ -r "$p" ] && /usr/bin/cat -- "$p" 2>/dev/null || :; printf "\\n"; done';
/** LXD starts the command once all three are connected, and gives up after 10 seconds. */
const EXEC_STREAM_CONNECT_MS = 10_000;
/** After the operation ends, its streams' end barriers are already sent; this covers only their delivery. */
const EXEC_STREAM_DRAIN_MS = 5_000;
/** The code host's largest read (Q13: a file or pack under 256 MiB). */
const MAX_EXEC_PIPE_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_EXEC_PIPE_STDERR_TAIL_BYTES = 64 * 1024;
const MAX_EXEC_PIPE_ENVIRONMENT = 256;
/** Each stdin message; the next waits for the socket to drain. */
const EXEC_PIPE_MESSAGE_BYTES = 64 * 1024;

export type LxdInstancePowerAction = "start" | "stop";

export interface LxdInstanceRecord {
	name: string;
	type: "virtual-machine" | "container";
	status: string;
	statusCode: number;
	config: Readonly<Record<string, string>>;
	profiles: readonly string[];
	devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Includes profile inheritance; local devices alone are not a containment check. */
	expandedDevices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	expandedConfig: Readonly<Record<string, string>>;
}

export interface LxdInstanceStateRecord {
	status: string;
	statusCode: number;
	network: Readonly<
		Record<
			string,
			{
				hwaddr?: string;
				addresses: readonly { family: string; address: string; scope: string }[];
			}
		>
	>;
}

export interface LxdStorageVolumeRecord {
	name: string;
	type: "custom";
	contentType: "filesystem" | "block";
	description: string;
	config: Readonly<Record<string, string>>;
}

export interface LxdCreateStorageVolumeRequest {
	name: string;
	type: "custom";
	content_type: "filesystem";
	description: string;
	config: Readonly<Record<string, string>>;
}

export interface LxdCreateInstanceRequest {
	name: string;
	type: "virtual-machine";
	profiles: readonly string[];
	config: Readonly<Record<string, string>>;
	devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	source:
		| {
				type: "image";
				fingerprint: string;
		  }
		| {
				type: "image";
				mode: "pull";
				protocol: "simplestreams";
				server: string;
				fingerprint: string;
		  };
}

export interface LxdClient {
	getInstance(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceRecord | undefined>;
	getInstanceState(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceStateRecord>;
	getStorageVolume(
		project: string,
		pool: string,
		name: string,
		signal?: AbortSignal,
	): Promise<LxdStorageVolumeRecord | undefined>;
	createStorageVolume(
		project: string,
		pool: string,
		request: LxdCreateStorageVolumeRequest,
		signal?: AbortSignal,
	): Promise<void>;
	/** Deletes a custom volume; true when it existed. LXD refuses a volume that
	 * an instance still uses. */
	deleteStorageVolume(project: string, pool: string, name: string, signal?: AbortSignal): Promise<boolean>;
	/** Admission bounds submission only. Observation retains the caller's own
	 * lifetime after LXD accepts the operation. A failed submission is uncertain. */
	createInstance(
		project: string,
		request: LxdCreateInstanceRequest,
		signal?: AbortSignal,
		dispatchSignal?: AbortSignal,
	): Promise<void>;
	setInstancePower(
		project: string,
		name: string,
		action: LxdInstancePowerAction,
		signal?: AbortSignal,
		dispatchSignal?: AbortSignal,
	): Promise<void>;
	pushInstanceFile(
		project: string,
		name: string,
		path: string,
		content: string,
		mode: number,
		signal?: AbortSignal,
	): Promise<void>;
	/** `waitSeconds` (1-600) replaces the client's operation wait for this one command. */
	execInstance(
		project: string,
		name: string,
		command: readonly string[],
		signal?: AbortSignal,
		waitSeconds?: number,
	): Promise<void>;
	/** Deletes a stopped guest and its root disk; custom volumes attached as devices stay. */
	deleteInstance(project: string, name: string, signal?: AbortSignal): Promise<void>;
}

export interface LxdProjectRecord {
	name: string;
	config: Readonly<Record<string, string>>;
	/** LXD's `used_by`: the URL of everything in the project. */
	usedBy: readonly string[];
}

/** A node's code hosts (code-host.ts): the coding executor makes each company's project itself, on first use. */
export interface LxdCodeHostClient
	extends Pick<LxdClient, "getInstance" | "createInstance" | "setInstancePower" | "execInstance" | "deleteInstance"> {
	getProject(name: string, signal?: AbortSignal): Promise<LxdProjectRecord | undefined>;
	createProject(name: string, config: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void>;
	/** True when it existed. LXD refuses a project that holds anything but its default profile. */
	deleteProject(name: string, signal?: AbortSignal): Promise<boolean>;
	listProjectNames(signal?: AbortSignal): Promise<string[]>;
}

export interface LxdInstanceFile {
	content: Buffer;
	uid: number;
	gid: number;
	mode: number;
}

/** Office provisioning needs a bounded readback of boot and protected
 * bootstrap records. This capability is separate from existing runner mocks. */
export interface LxdInspectableClient extends LxdClient {
	readInstanceFile(
		project: string,
		name: string,
		path: string,
		maximumBytes: number,
		signal?: AbortSignal,
	): Promise<LxdInstanceFile>;
}

export type LxdTrackedInstanceAction =
	| { action: "create"; request: LxdCreateInstanceRequest }
	| { action: "start" | "delete"; name: string }
	/** `force` powers the VM off instead of asking the guest to shut down. Only
	 * for machines whose state lives outside the VM (coding VMs keep all work on
	 * the NAS); offices and login machines keep the graceful stop. */
	| { action: "stop"; name: string; force?: true }
	/** Gives a stopped VM a new root disk from a local image. The instance keeps
	 * its name, configuration and devices (F3 5g-5: a coding machine's new disk). */
	| { action: "rebuild"; name: string; fingerprint: string };

/** Whether an image is still in the node's image store. Old images get cleaned
 * up, and a coding machine rebuilds only from a local image. */
export interface LxdImageClient {
	hasImage(project: string, fingerprint: string, signal: AbortSignal): Promise<boolean>;
}

export interface LxdImageSummary {
	readonly fingerprint: string;
	readonly size: number;
	readonly createdAt?: string;
	readonly properties: Readonly<Record<string, string>>;
}

export interface LxdSnapshotImageClient extends LxdImageClient {
	publishInstanceImage(
		project: string,
		instanceName: string,
		options: {
			readonly properties?: Readonly<Record<string, string>>;
			readonly compressionAlgorithm?: string;
			readonly waitSeconds?: number;
		},
		signal: AbortSignal,
	): Promise<{ readonly fingerprint: string; readonly size: number }>;
	deleteImage(project: string, fingerprint: string, signal: AbortSignal): Promise<boolean>;
	listImages(project: string, signal: AbortSignal): Promise<readonly LxdImageSummary[]>;
}

export interface LxdStandbyClient {
	renameInstance(project: string, oldName: string, newName: string, signal: AbortSignal): Promise<void>;
	updateInstanceConfig(
		project: string,
		name: string,
		update: {
			readonly config: Readonly<Record<string, string>>;
			readonly devices?: Readonly<Record<string, Readonly<Record<string, string>>>>;
		},
		signal: AbortSignal,
	): Promise<void>;
	listInstances(project: string, signal: AbortSignal): Promise<readonly LxdInstanceRecord[]>;
}

/** Whether a project lets its instances have the agent card, read from LXD and never changed: LXD's own rule
 * (projectAllowsAgentCard), which LXD otherwise applies only at the create. LXD_PROJECT_UNCONFIRMED when the project
 * could not be read. */
export interface LxdProjectClient {
	allowsAgentCard(project: string, signal: AbortSignal): Promise<boolean>;
}

export interface LxdOperationReference {
	project: string;
	instanceName: string;
	operationId: string;
}

export type LxdOperationState = "pending" | "succeeded" | "failed";

export interface LxdExecStreamRequest {
	/** WHY: Defaults to root (0:0) in `/` with LXD's default environment; optional user/group (0-65535)
	 * allow unprivileged stream exec. */
	readonly command: readonly string[];
	readonly user?: number;
	readonly group?: number;
	/** Written to the command's stdin, which is then closed. Never recorded or logged. */
	readonly stdin: Buffer;
	/** A command printing more than this on stdout is killed and the call fails. */
	readonly maxStdoutBytes: number;
	readonly maxStderrBytes: number;
	/** The whole call, from the request to the last byte. Past it the command is killed and the call fails. */
	readonly timeoutMs: number;
}

export interface LxdExecStreamResult {
	readonly exitCode: number;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
}

export interface LxdCodingMachineMemory {
	readonly meminfo: string;
	readonly stats: ReadonlyMap<string, string>;
}

export interface LxdCodingMemoryClient {
	readCodingMachineMemory(
		project: string,
		name: string,
		groups: readonly string[],
		signal?: AbortSignal,
	): Promise<LxdCodingMachineMemory>;
}

/** Exec over LXD's websockets: input on stdin and output read off the stream, never in an argument or on the
 * host's disk. Separate from the runner mocks, like the capabilities below. */
export interface LxdInstanceExecStreamClient {
	execInstanceStream(
		project: string,
		name: string,
		request: LxdExecStreamRequest,
		signal?: AbortSignal,
	): Promise<LxdExecStreamResult>;
}

export interface LxdExecPipeRequest {
	/** At most 64 arguments; run as root unless `user` says otherwise. */
	readonly command: readonly string[];
	/** The account inside the instance, by uid and gid. Root (0) unless given: an agent's home runs Codex's own
	 * exec-server as the machine's unprivileged agent account (lanes/agent-box-20261113, slice 1). */
	readonly user?: number;
	readonly group?: number;
	/** The command's environment, over LXD's defaults (`PATH`, `LANG`, `HOME` and `USER` where not given) and the
	 * instance's `environment.*` keys. */
	readonly environment: Readonly<Record<string, string>>;
	/** An absolute path in the instance. */
	readonly cwd: string;
	/** Streamed to the command's stdin, which is then closed; without it stdin is closed at once. Never recorded or
	 * logged. A source the call does not read to its end is closed (its `return()`) when the call ends, also while a
	 * read is pending; an async generator runs its own close once that read settles. */
	readonly stdin?: Uint8Array | AsyncIterable<Uint8Array>;
	/** A command printing more than this on stdout is killed and the call fails. With `stdout`, the bound of each of
	 * LXD's messages instead: nothing is kept. */
	readonly maxStdoutBytes: number;
	/** How much of the end of stderr to keep; the rest is dropped, never a failure. */
	readonly stderrTailBytes: number;
	/** Hands each of stdout's messages over as it comes, in order, keeping none of it (20260930745000: a desktop's live
	 * picture, for as long as it is watched; an agent's home: Codex's exec-server channel, for as long as a turn, whose
	 * consumer bounds what it has not read yet, machine-exec-server.ts); the result's stdout is then empty. Never
	 * recorded or logged. A handler that throws ends the call, as an over-long message does. */
	readonly stdout?: (chunk: Buffer) => void;
	readonly onStdout?: (chunk: Buffer) => void;
}

export interface LxdExecPipeResult {
	readonly exitCode: number;
	readonly stdout: Buffer;
	readonly stderrTail: Buffer;
}

/** Exec over LXD's websockets for commands of any length: an input of any size streamed at the pace the command
 * reads it, an environment and a working directory, and no deadline but the signal. The code host's jobs run on it
 * (5e, RUNTIME-FOLDER-CODING-MACHINES.md "The code host"). */
export interface LxdInstanceExecPipeClient {
	execInstancePipe(
		project: string,
		name: string,
		request: LxdExecPipeRequest,
		signal: AbortSignal,
	): Promise<LxdExecPipeResult>;
}

/** A program the executor writes into a coding machine (F3 5g-4: the guest agent and the folder program), as bytes:
 * root's file, of the given mode, at a path under `/opt/qorpera-guest/` or `/opt/qorpera-folder/` whose folder
 * exists. LXD writes the file in place, and a running program's file can't be written: the caller writes beside it and
 * renames over it. Separate from the runner mocks, like the capabilities above. */
export interface LxdInstanceProgramClient {
	pushInstanceProgram(
		project: string,
		name: string,
		path: string,
		content: Buffer,
		mode: number,
		signal?: AbortSignal,
	): Promise<void>;
}

/** A coding machine's session folders are its only devices that change after
 * creation (lxd-client replaceInstanceDevices). */
export interface LxdInstanceDeviceClient {
	replaceInstanceDevices(
		project: string,
		name: string,
		devices: Readonly<Record<string, Readonly<Record<string, string>>>>,
		signal: AbortSignal,
	): Promise<void>;
}

/** A shared execution host's Compute Identity devices are changed by its
 * node's login gateway (lxd-execution-host-identity.ts): each change is
 * decided on, and written under, one read of the instance. */
export interface LxdInstanceDeviceUpdateClient {
	getInstance(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceRecord | undefined>;
	updateInstanceDevices(
		project: string,
		name: string,
		update: (instance: LxdInstanceRecord) => Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
		signal: AbortSignal,
	): Promise<boolean>;
	listCustomStorageVolumes(project: string, pool: string, signal: AbortSignal): Promise<LxdStorageVolumeRecord[]>;
}

/** A storage pool's own figures as LXD counts them (`lxc storage info`). */
export interface LxdStoragePoolSpace {
	totalBytes: number;
	usedBytes: number;
}
/** The two reads of an executor's disk report (20260930757000): what one virtual machine's disk holds of its own
 * (`lxc list -c D`; a thin clone holds only what was written to it), and the pool's own figures. The caller decides the
 * order (the disks first, the pool last) and how many disks it reads. */
export interface LxdStoragePoolUseClient {
	/** The disk's own use, or undefined when LXD has no such disk (404) or gives no use for it. */
	readStorageVolumeUse(pool: string, project: string, name: string, signal: AbortSignal): Promise<number | undefined>;
	readStoragePoolSpace(pool: string, signal: AbortSignal): Promise<LxdStoragePoolSpace>;
}

/** Submission and observation are separate so an office provider can persist
 * the operation ID before polling. A rejected submission has an UNKNOWN
 * physical outcome; neither a timeout nor a 404 authorizes a retry/release.
 * Observation reports LXD's own 404 as LXD_OPERATION_UNKNOWN (LXD keeps a
 * finished operation only briefly): still no outcome. Only a caller whose
 * effect is idempotent may act on it, and then only from the instance's own
 * physical state (a coding VM's forced stop). */
export interface LxdTrackedClient extends LxdInspectableClient {
	submitInstanceOperation(
		project: string,
		action: LxdTrackedInstanceAction,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectInstanceOperation(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
}

export interface LxdOfficeServerIdentity {
	project: string;
	certificateSha256: string;
	serverName: string;
	serverVersion: string;
	architecture: string;
}
export interface LxdHostInventoryInstance extends LxdInstanceRecord {
	project: string;
	location: string;
}
export interface LxdHostInventory {
	server: LxdOfficeServerIdentity;
	instances: LxdHostInventoryInstance[];
}
/** All projects and both instance types. A filtered project list is not a
 * physical host inventory and cannot establish spare host capacity. */
export interface LxdHostInventoryClient {
	inspectHostInventory(signal: AbortSignal): Promise<LxdHostInventory>;
}

const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

function trackedOperation(value: unknown, reference: LxdOperationReference): LxdOperationState {
	const input = record(value, "LXD operation");
	const resources = record(input.resources, "LXD operation resources");
	const instances = resources.instances;
	const path = `/1.0/instances/${encodeURIComponent(reference.instanceName)}`;
	const scopedPath = projectPath(path, reference.project);
	// LXD 6.9 moved the primary target from resources to metadata.entity_url.
	// If both are present they must agree; a legacy bare resource URL is only
	// accepted on this already project-scoped, exact operation-ID lookup.
	const metadata = input.metadata === undefined ? {} : record(input.metadata, "LXD operation metadata");
	const entity = metadata.entity_url;
	if (
		input.id !== reference.operationId ||
		input.class !== "task" ||
		(instances === undefined && entity === undefined) ||
		(instances !== undefined &&
			(!Array.isArray(instances) ||
				instances.length !== 1 ||
				(instances[0] !== path && instances[0] !== scopedPath))) ||
		(entity !== undefined && entity !== scopedPath && !(reference.project === "default" && entity === path)) ||
		typeof input.err !== "string"
	)
		throw new Error("invalid operation identity");
	if (input.status_code === 200 && input.status === "Success" && input.err === "") return "succeeded";
	if (
		(input.status_code === 400 && input.status === "Failure") ||
		(input.status_code === 401 && input.status === "Cancelled")
	)
		return "failed";
	const pending = new Map<number, string>([
		[100, "Operation created"],
		[103, "Running"],
		[104, "Cancelling"],
		[105, "Pending"],
	]);
	if (typeof input.status_code === "number" && pending.get(input.status_code) === input.status && input.err === "")
		return "pending";
	throw new Error("invalid operation status");
}

interface HttpResult {
	headers?: import("node:http").IncomingHttpHeaders;
	status: number;
	body: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

/** Keys JavaScript objects treat specially. Copied with `output[key] = …`, a
 * key `__proto__` sets the copy's prototype instead of adding an entry, so a
 * device of that name would vanish from Object.keys, JSON and every digest
 * (the node inventory's above all). LXD's own name rule allows it, so an LXD
 * map carrying such a key is refused and the read fails closed. Records stay
 * plain objects, not Object.create(null): callers compare them with
 * isDeepStrictEqual, which tells the two apart. Object.fromEntries builds
 * them without ever running the `__proto__` setter. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** LXD's device name rule (validate.IsDeviceName): 1-63 letters, digits and
 * `/ . - : _`, not starting with a full stop. */
const DEVICE_NAME = /^(?!\.)[A-Za-z0-9/.:_-]{1,63}$/;

function plainEntries(value: unknown, label: string): [string, unknown][] {
	const entries = Object.entries(record(value, label));
	if (entries.some(([key]) => RESERVED_KEYS.has(key))) throw new Error(`${label} is invalid`);
	return entries;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	const entries = plainEntries(value, label);
	if (entries.some(([, entry]) => typeof entry !== "string")) throw new Error(`${label} is invalid`);
	return Object.fromEntries(entries) as Record<string, string>;
}

/** Whether a project's instances may have the agent card, a bridged NIC whose parent is the agents' bridge (not a
 * network LXD manages). This is LXD's own rule (lxd/project/permissions.go, the NIC check and `NetworkAllowed`):
 * LXD enforces the restrictions unless `restricted` is empty or false, then needs every NIC allowed and the bridge
 * among the project's networks, if it lists any. */
function projectAllowsAgentCard(config: Readonly<Record<string, string>>): boolean {
	if (["", "false", "0", "no", "off"].includes((config.restricted ?? "").toLowerCase())) return true;
	if (config["restricted.devices.nic"] !== "allow") return false;
	const networks = config["restricted.networks.access"] ?? "";
	return networks === "" || networks.split(",").some((name) => name.trim() === AGENT_BRIDGE);
}

function devices(value: unknown): Record<string, Readonly<Record<string, string>>> {
	const entries = plainEntries(value, "LXD instance devices");
	if (entries.some(([name]) => !DEVICE_NAME.test(name))) throw new Error("LXD instance devices is invalid");
	return Object.fromEntries(entries.map(([name, device]) => [name, stringRecord(device, "LXD instance device")]));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error(`${label} is invalid`);
	}
	return [...value];
}

function instance(value: unknown): LxdInstanceRecord {
	const input = record(value, "LXD instance");
	if (
		typeof input.name !== "string" ||
		(input.type !== "virtual-machine" && input.type !== "container") ||
		typeof input.status !== "string" ||
		typeof input.status_code !== "number"
	) {
		throw new Error("LXD instance is invalid");
	}
	return {
		name: input.name,
		type: input.type,
		status: input.status,
		statusCode: input.status_code,
		config: stringRecord(input.config, "LXD instance config"),
		profiles: strings(input.profiles, "LXD instance profiles"),
		devices: devices(input.devices),
		expandedDevices: devices(input.expanded_devices),
		expandedConfig: stringRecord(input.expanded_config, "LXD expanded instance config"),
	};
}

function projectRecord(value: unknown): LxdProjectRecord {
	const input = record(value, "LXD project");
	if (typeof input.name !== "string") throw new Error("LXD project is invalid");
	return {
		name: input.name,
		config: stringRecord(input.config, "LXD project config"),
		usedBy: strings(input.used_by ?? [], "LXD project used by"),
	};
}

function instanceState(value: unknown): LxdInstanceStateRecord {
	const input = record(value, "LXD instance state");
	if (typeof input.status !== "string" || typeof input.status_code !== "number") {
		throw new Error("LXD instance state is invalid");
	}
	// A stopped VM has no network map. Preserve its status so readiness can
	// recognize shutdown instead of treating every poll as a malformed response.
	// Interface names come from inside the guest; a hidden `__proto__` one
	// would slip past lxdGuestIpv4's one-interface-per-MAC check.
	const networkInput =
		input.status === "Stopped" && input.network === null
			? []
			: plainEntries(input.network, "LXD instance network state");
	const network: Record<
		string,
		{ hwaddr?: string; addresses: readonly { family: string; address: string; scope: string }[] }
	> = {};
	for (const [name, rawInterface] of networkInput) {
		const networkInterface = record(rawInterface, "LXD instance network interface");
		if (!Array.isArray(networkInterface.addresses)) throw new Error("LXD instance network addresses are invalid");
		const addresses = networkInterface.addresses.map((rawAddress) => {
			const address = record(rawAddress, "LXD instance network address");
			if (
				typeof address.family !== "string" ||
				typeof address.address !== "string" ||
				typeof address.scope !== "string"
			) {
				throw new Error("LXD instance network address is invalid");
			}
			return { family: address.family, address: address.address, scope: address.scope };
		});
		const rawMac = networkInterface.hwaddr;
		const hwaddr = rawMac === undefined || rawMac === "" ? undefined : lxdMacAddress(rawMac);
		if (rawMac !== undefined && rawMac !== "" && !hwaddr) throw new Error("LXD instance network MAC is invalid");
		network[name] = { addresses, ...(hwaddr ? { hwaddr } : {}) };
	}
	return { status: input.status, statusCode: input.status_code, network };
}

function storageVolume(value: unknown): LxdStorageVolumeRecord {
	const input = record(value, "LXD storage volume");
	if (
		typeof input.name !== "string" ||
		input.type !== "custom" ||
		(input.content_type !== "filesystem" && input.content_type !== "block") ||
		typeof input.description !== "string"
	) {
		throw new Error("LXD storage volume is invalid");
	}
	return {
		name: input.name,
		type: "custom",
		contentType: input.content_type,
		description: input.description,
		config: stringRecord(input.config, "LXD storage volume config"),
	};
}

/** LXD's error while a VM's lxd-agent is not (yet) up: errQemuAgentOffline
 * "LXD VM agent is not currently running" (older: "isn't"), possibly wrapped. */
const AGENT_OFFLINE = /\bVM agent (?:is not|isn't) currently running\b/;
/** A failed operation as a fixed code: the agent being offline is its own
 * case (a starting VM), anything else is a plain failure. */
/** LXD reported the operation's end as Failure or Cancelled: it did not happen, and never will. Any other
 * failed wait (a timeout while it still runs, a lost reply) leaves the outcome unknown. */
export class LxdOperationFailed extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LxdOperationFailed";
	}
}

/** A tracked submission LXD answered with its own error, before any operation (submitInstanceOperation). The message
 * stays LXD_OPERATION_SUBMISSION_UNCONFIRMED: a caller judges the outcome as it judges any unconfirmed submission. What
 * LXD said is kept for its operator: the HTTP status, LXD's error code and its message, on one line and at most 500
 * characters. LXD's message names what the request named (instances, devices, keys), and only a caller whose request
 * carries no secret value should keep it. */
export class LxdSubmissionRefused extends Error {
	readonly status: number;
	readonly lxdCode: number | null;
	readonly lxdMessage: string;
	constructor(status: number, lxdCode: unknown, lxdMessage: unknown) {
		super("LXD_OPERATION_SUBMISSION_UNCONFIRMED");
		this.name = "LxdSubmissionRefused";
		this.status = status;
		this.lxdCode = Number.isSafeInteger(lxdCode) ? (lxdCode as number) : null;
		this.lxdMessage =
			typeof lxdMessage === "string"
				? [...lxdMessage.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim()].slice(0, 500).join("")
				: "";
	}
}

function operationFailure(message: unknown, definitive = false): Error {
	const text =
		typeof message === "string" && AGENT_OFFLINE.test(message)
			? "LXD instance agent not running"
			: "LXD operation failed";
	return definitive ? new LxdOperationFailed(text) : new Error(text);
}

function lxdError(result: HttpResult, fallback: string): Error {
	try {
		const envelope = record(result.body, "LXD response");
		if (typeof envelope.error === "string" && AGENT_OFFLINE.test(envelope.error))
			return operationFailure(envelope.error);
		if (typeof envelope.error === "string" && envelope.error.trim()) return new Error(`LXD: ${envelope.error}`);
	} catch {
		// Use the bounded status-only error below for malformed daemon responses.
	}
	return new Error(`${fallback} (${result.status})`);
}

function envelopeMetadata(result: HttpResult): unknown {
	const envelope = record(result.body, "LXD response");
	if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
	return envelope.metadata;
}

function projectPath(path: string, project: string): string {
	return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}

/** At most 64 arguments and 256 environment variables, nothing with a NUL, each argument and value at most 64 KiB and
 * all of them together at most 256 KiB (well under the kernel's limit for a new program). */
function validExecPipe(request: LxdExecPipeRequest): boolean {
	const { command, environment, cwd, stdin, maxStdoutBytes, stderrTailBytes, user, group } = request;
	for (const id of [user, group])
		if (id !== undefined && (!Number.isSafeInteger(id) || id < 0 || id > 65535)) return false;
	if (!Array.isArray(command) || command.length < 1 || command.length > 64 || !command[0]) return false;
	if (typeof environment !== "object" || environment === null) return false;
	const variables = Object.entries(environment);
	if (variables.length > MAX_EXEC_PIPE_ENVIRONMENT) return false;
	let bytes = 0;
	for (const value of [...command, ...variables.flat()]) {
		if (typeof value !== "string" || value.includes("\0")) return false;
		const length = Buffer.byteLength(value);
		if (length > 64 * 1024) return false;
		bytes += length;
	}
	return (
		bytes <= 256 * 1024 &&
		variables.every(([key]) => /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(key)) &&
		typeof cwd === "string" &&
		cwd.startsWith("/") &&
		!cwd.includes("\0") &&
		Buffer.byteLength(cwd) <= 4096 &&
		(stdin === undefined ||
			stdin instanceof Uint8Array ||
			(typeof stdin === "object" && stdin !== null && typeof stdin[Symbol.asyncIterator] === "function")) &&
		Number.isSafeInteger(maxStdoutBytes) &&
		maxStdoutBytes >= 0 &&
		maxStdoutBytes <= MAX_EXEC_PIPE_OUTPUT_BYTES &&
		(request.stdout === undefined || typeof request.stdout === "function") &&
		Number.isSafeInteger(stderrTailBytes) &&
		stderrTailBytes >= 0 &&
		stderrTailBytes <= MAX_EXEC_PIPE_STDERR_TAIL_BYTES &&
		(request.onStdout === undefined || typeof request.onStdout === "function")
	);
}

/** Hands `stdin` to an exec's stdin websocket in messages of at most 64 KiB, each sent once the last has drained, then
 * its end. True once all of it and the end are sent; false when the websocket closed first or `stop` ends the call. A
 * source that fails, or yields something other than bytes, throws. A source not read to its end is told to close (its
 * `return()`) as soon as the input stops, also while a read is pending: `stop` ends the wait for that read. */
async function pipeInput(
	socket: NodeWebSocket,
	stdin: Uint8Array | AsyncIterable<Uint8Array> | undefined,
	stop: AbortSignal,
): Promise<boolean> {
	const send = async (chunk: Uint8Array): Promise<boolean> => {
		for (let offset = 0; offset < chunk.byteLength; offset += EXEC_PIPE_MESSAGE_BYTES) {
			if (stop.aborted) return false;
			const length = Math.min(EXEC_PIPE_MESSAGE_BYTES, chunk.byteLength - offset);
			try {
				await socket.sendBinaryDrained(Buffer.from(chunk.buffer, chunk.byteOffset + offset, length));
			} catch {
				return false;
			}
		}
		return true;
	};
	if (stdin instanceof Uint8Array) {
		if (!(await send(stdin))) return false;
	} else if (stdin !== undefined) {
		const source = stdin[Symbol.asyncIterator]();
		// One abort listener for the whole input, which ends only the read pending at the time: racing each read
		// against one promise for the abort would keep every read's reaction on it until the call ends.
		let stopRead: (() => void) | undefined;
		const stopped = () => stopRead?.();
		stop.addEventListener("abort", stopped, { once: true });
		let open = true;
		try {
			for (;;) {
				if (stop.aborted) return false;
				const pending = source.next();
				const next = await new Promise<IteratorResult<Uint8Array> | undefined>((resolveNext, rejectNext) => {
					stopRead = () => resolveNext(undefined);
					if (stop.aborted) resolveNext(undefined);
					Promise.resolve(pending).then(resolveNext, rejectNext);
				});
				stopRead = undefined;
				if (next === undefined) return false;
				if (next.done) {
					open = false;
					break;
				}
				if (!(next.value instanceof Uint8Array)) throw new Error("LXD exec pipe input is invalid");
				if (!(await send(next.value))) return false;
			}
		} finally {
			stop.removeEventListener("abort", stopped);
			// Not awaited: an async generator closes only once its pending read settles.
			if (open) {
				try {
					Promise.resolve(source.return?.()).catch(() => undefined);
				} catch {
					// A source that cannot close has nothing more to give the command.
				}
			}
		}
	}
	if (stop.aborted) return false;
	try {
		socket.send("");
		return true;
	} catch {
		return false;
	}
}

function validCodingMemoryPath(path: string): boolean {
	if (CODING_MEMORY_CODING_SLICE.test(path) || CODING_MEMORY_FOLDER_SERVICE.test(path)) return true;
	const user = CODING_MEMORY_USER_SLICE.exec(path);
	if (!user) return false;
	const uid = Number(user[1]);
	return Number.isSafeInteger(uid) && uid >= 200_000 && uid <= 524_287;
}

export function defaultLxdRequestTimeoutMs(path: string, operationTimeoutSeconds: number): number {
	const waitMatch = /\/wait\?(?:.*&)?timeout=(\d+)(?:&|$)/.exec(path);
	return waitMatch ? (Number(waitMatch[1]) + 5) * 1000 : operationTimeoutSeconds * 1000;
}

export class LxdUnixClient
	implements
		LxdCodeHostClient,
		LxdCodingMemoryClient,
		LxdInstanceExecStreamClient,
		LxdInstanceExecPipeClient,
		LxdInstanceProgramClient,
		LxdInstanceDeviceClient,
		LxdInstanceDeviceUpdateClient,
		LxdImageClient,
		LxdSnapshotImageClient,
		LxdStandbyClient,
		LxdProjectClient,
		LxdHostInventoryClient,
		LxdStoragePoolUseClient
{
	readonly #socketPath: string;
	readonly #operationTimeoutSeconds: number;

	constructor(socketPath = "/var/snap/lxd/common/lxd/unix.socket", operationTimeoutSeconds = 120) {
		if (!socketPath.startsWith("/") || /[\0\r\n]/.test(socketPath)) throw new Error("LXD socket path is invalid");
		if (
			!Number.isSafeInteger(operationTimeoutSeconds) ||
			operationTimeoutSeconds < 1 ||
			operationTimeoutSeconds > 600
		) {
			throw new Error("LXD operation timeout is invalid");
		}
		this.#socketPath = socketPath;
		this.#operationTimeoutSeconds = operationTimeoutSeconds;
	}

	async #officeMetadata(path: string, signal: AbortSignal, maximumBytes = 65536): Promise<Record<string, unknown>> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
		checked.throwIfAborted();
		const result = await this.#requestPayload("GET", path, undefined, undefined, checked, maximumBytes);
		checked.throwIfAborted();
		const envelope = record(result.body, "office metadata");
		if (result.status !== 200 || envelope.type !== "sync" || envelope.status_code !== 200)
			throw new Error("office metadata unavailable");
		return record(envelope.metadata, "office metadata");
	}

	async inspectOfficeServer(
		project: string,
		signal: AbortSignal,
		requireInventory = false,
	): Promise<LxdOfficeServerIdentity> {
		try {
			if (!/^[a-z][a-z0-9-]{0,62}$/.test(project)) throw new Error("invalid project");
			const server = await this.#officeMetadata(projectPath("/1.0", project), signal);
			const environment = record(server.environment, "office server environment");
			if (requireInventory && !strings(server.api_extensions, "server extensions").includes("instance_all_projects"))
				throw new Error("all-project inventory unsupported");
			if (
				server.auth !== "trusted" ||
				server.auth_user_method !== "unix" ||
				server.api_version !== "1.0" ||
				server.api_status !== "stable" ||
				server.public !== false ||
				environment.server !== "lxd" ||
				environment.kernel !== "Linux" ||
				environment.server_clustered !== false ||
				environment.project !== project ||
				typeof environment.driver !== "string" ||
				!environment.driver.split(" | ").includes("qemu") ||
				!strings(environment.instance_types, "instance types").includes("virtual-machine") ||
				typeof environment.certificate !== "string" ||
				environment.certificate.length > 16384 ||
				typeof environment.certificate_fingerprint !== "string" ||
				!/^[0-9a-f]{64}$/.test(environment.certificate_fingerprint) ||
				typeof environment.server_name !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(environment.server_name) ||
				typeof environment.server_version !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9.+~-]{0,63}$/.test(environment.server_version) ||
				(environment.kernel_architecture !== "x86_64" && environment.kernel_architecture !== "aarch64")
			)
				throw new Error("unsupported office server");
			const certificate = new X509Certificate(environment.certificate);
			const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
			if (fingerprint !== environment.certificate_fingerprint) throw new Error("certificate identity differs");
			return {
				project,
				certificateSha256: fingerprint,
				serverName: environment.server_name,
				serverVersion: environment.server_version,
				architecture: environment.kernel_architecture,
			};
		} catch {
			throw new Error("LXD_OFFICE_SERVER_UNCONFIRMED");
		}
	}

	/** Bounded complete inventory of the already supported standalone daemon.
	 * Cross-check non-recursive identities against two matching expanded reads:
	 * omitted/render-failed entries, duplicates and concurrent changes all fail
	 * closed. No project, name, instance type or running-state filter is applied.
	 * This is daemon evidence only; callers must bind its protected local socket,
	 * host identity, provider journals and cloud allocations before publication. */
	async inspectHostInventory(signal: AbortSignal): Promise<LxdHostInventory> {
		try {
			return await withTimeoutScope(signal, 5000, async (checked) => {
				const server = await this.inspectOfficeServer("default", checked, true);
				const listing = async (recursive: boolean): Promise<unknown[]> => {
					checked.throwIfAborted();
					const result = await this.#requestPayload(
						"GET",
						`/1.0/instances?all-projects=true&recursion=${recursive ? 1 : 0}`,
						undefined,
						undefined,
						checked,
						recursive ? MAX_RESPONSE_BYTES : 1048576,
					);
					const envelope = record(result.body, "host inventory");
					if (
						result.status !== 200 ||
						envelope.type !== "sync" ||
						envelope.status_code !== 200 ||
						!Array.isArray(envelope.metadata) ||
						envelope.metadata.length > 4096
					)
						throw new Error("invalid host inventory");
					checked.throwIfAborted();
					return envelope.metadata;
				};
				const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
				const key = (project: unknown, name: unknown): string => {
					if (
						typeof project !== "string" ||
						typeof name !== "string" ||
						!namePattern.test(project) ||
						!namePattern.test(name)
					)
						throw new Error("invalid inventory identity");
					return JSON.stringify([project, name]);
				};
				const unique = (values: string[]): string[] => {
					if (new Set(values).size !== values.length) throw new Error("duplicate inventory identity");
					return values.sort();
				};
				const identities = async (): Promise<string[]> =>
					unique(
						(await listing(false)).map((value) => {
							if (typeof value !== "string" || !value.startsWith("/1.0/instances/"))
								throw new Error("invalid inventory URL");
							const url = new URL(value, "http://lxd.invalid"),
								name = url.pathname.slice("/1.0/instances/".length);
							if (
								url.origin !== "http://lxd.invalid" ||
								url.hash ||
								[...url.searchParams.keys()].some((name) => name !== "project") ||
								url.searchParams.getAll("project").length > 1
							)
								throw new Error("unscoped inventory URL");
							return key(url.searchParams.get("project") ?? "default", name);
						}),
					);
				const expanded = async (): Promise<LxdHostInventoryInstance[]> => {
					const result = (await listing(true)).map((value) => {
						const raw = record(value, "inventory instance"),
							parsed = instance(raw);
						key(raw.project, parsed.name);
						if (
							typeof raw.location !== "string" ||
							!["", "none", server.serverName].includes(raw.location) ||
							!Number.isSafeInteger(parsed.statusCode) ||
							parsed.statusCode < 100 ||
							parsed.statusCode > 599 ||
							!parsed.status ||
							parsed.status.length > 64
						)
							throw new Error("invalid inventory placement/state");
						return { ...parsed, project: raw.project as string, location: raw.location };
					});
					unique(result.map((item) => key(item.project, item.name)));
					return result.sort((a, b) => key(a.project, a.name).localeCompare(key(b.project, b.name)));
				};
				const before = await identities(),
					first = await expanded(),
					second = await expanded(),
					after = await identities();
				const finalServer = await this.inspectOfficeServer("default", checked, true);
				if (
					!isDeepStrictEqual(server, finalServer) ||
					!isDeepStrictEqual(before, after) ||
					!isDeepStrictEqual(before, unique(first.map((item) => key(item.project, item.name)))) ||
					!isDeepStrictEqual(first, second)
				)
					throw new Error("host inventory changed or incomplete");
				checked.throwIfAborted();
				return { server, instances: second };
			});
		} catch {
			throw new Error("LXD_HOST_INVENTORY_UNCONFIRMED");
		}
	}
	async listProjectInstances(project: string, signal: AbortSignal): Promise<LxdHostInventoryInstance[]> {
		const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
		if (!namePattern.test(project)) throw new Error("LXD_PROJECT_INSTANCES_UNCONFIRMED");
		try {
			// WHY: Scope office passthrough instance lookups to one project while retaining standalone server, location, and status validation.
			return await withTimeoutScope(signal, 5000, async (checked) => {
				checked.throwIfAborted();
				const server = await this.inspectOfficeServer("default", checked, false);
				const result = await this.#requestPayload(
					"GET",
					`/1.0/instances?project=${encodeURIComponent(project)}&recursion=1`,
					undefined,
					undefined,
					checked,
					MAX_RESPONSE_BYTES,
				);
				const envelope = record(result.body, "project instances");
				if (
					result.status !== 200 ||
					envelope.type !== "sync" ||
					envelope.status_code !== 200 ||
					!Array.isArray(envelope.metadata) ||
					envelope.metadata.length > 4096
				)
					throw new Error("invalid project instances");
				const seen = new Set<string>();
				const items = envelope.metadata.map((value) => {
					const raw = record(value, "project instance");
					const parsed = instance(raw);
					if (
						typeof raw.project !== "string" ||
						raw.project !== project ||
						!namePattern.test(parsed.name) ||
						seen.has(parsed.name) ||
						typeof raw.location !== "string" ||
						!["", "none", server.serverName].includes(raw.location) ||
						!Number.isSafeInteger(parsed.statusCode) ||
						parsed.statusCode < 100 ||
						parsed.statusCode > 599 ||
						!parsed.status ||
						parsed.status.length > 64
					)
						throw new Error("invalid project instance");
					seen.add(parsed.name);
					return {
						...parsed,
						project: raw.project,
						location: raw.location,
					};
				});
				checked.throwIfAborted();
				return items;
			});
		} catch {
			throw new Error("LXD_PROJECT_INSTANCES_UNCONFIRMED");
		}
	}

	async hasImage(project: string, fingerprint: string, signal: AbortSignal): Promise<boolean> {
		try {
			if (!/^[a-z][a-z0-9-]{0,62}$/.test(project) || !/^[0-9a-f]{64}$/.test(fingerprint))
				throw new Error("invalid image identity");
			return await withTimeoutScope(signal, 5000, async (checked) => {
				checked.throwIfAborted();
				const result = await this.#requestPayload(
					"GET",
					projectPath(`/1.0/images/${fingerprint}`, project),
					undefined,
					undefined,
					checked,
					65536,
				);
				checked.throwIfAborted();
				const envelope = record(result.body, "image");
				if (result.status === 404 && envelope.type === "error" && envelope.error_code === 404) return false;
				if (
					result.status !== 200 ||
					envelope.type !== "sync" ||
					envelope.status_code !== 200 ||
					record(envelope.metadata, "image").fingerprint !== fingerprint
				)
					throw new Error("image not confirmed");
				return true;
			});
		} catch {
			throw new Error("LXD_IMAGE_UNCONFIRMED");
		}
	}

	async publishInstanceImage(
		project: string,
		instanceName: string,
		options: {
			readonly properties?: Readonly<Record<string, string>>;
			readonly compressionAlgorithm?: string;
			readonly waitSeconds?: number;
		},
		signal: AbortSignal,
	): Promise<{ readonly fingerprint: string; readonly size: number }> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(instanceName))
			throw new Error("LXD instance scope is invalid");
		const waitSeconds = options.waitSeconds ?? 600;
		if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 1800)
			throw new Error("LXD image publish timeout is invalid");
		const compression = options.compressionAlgorithm ?? "zstd";
		if (!/^[a-z0-9-]+$/.test(compression)) throw new Error("LXD image compression is invalid");
		const body = {
			public: false,
			compression_algorithm: compression,
			properties: options.properties ? { ...options.properties } : {},
			source: { type: "instance", name: instanceName },
		};
		const result = await this.#request("POST", projectPath("/1.0/images", project), body, signal);
		const operation = await this.#waitForOperation(result, signal, waitSeconds);
		const metadata = record(operation.metadata, "LXD image publish metadata");
		const fingerprint = metadata.fingerprint;
		if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint))
			throw new Error("LXD published image fingerprint is invalid");
		const info = await this.#request("GET", projectPath(`/1.0/images/${fingerprint}`, project), undefined, signal);
		const imageMeta = record(envelopeMetadata(info), "LXD image");
		if (
			imageMeta.fingerprint !== fingerprint ||
			!Number.isSafeInteger(imageMeta.size) ||
			(imageMeta.size as number) < 0
		)
			throw new Error("LXD published image metadata is invalid");
		return { fingerprint, size: imageMeta.size as number };
	}

	async deleteImage(project: string, fingerprint: string, signal: AbortSignal): Promise<boolean> {
		if (!INSTANCE_NAME.test(project) || !/^[0-9a-f]{64}$/.test(fingerprint))
			throw new Error("LXD image identity is invalid");
		const result = await this.#request(
			"DELETE",
			projectPath(`/1.0/images/${fingerprint}`, project),
			undefined,
			signal,
		);
		if (result.status === 404) return false;
		await this.#waitForOperation(result, signal);
		return true;
	}

	async listImages(project: string, signal: AbortSignal): Promise<readonly LxdImageSummary[]> {
		if (!INSTANCE_NAME.test(project)) throw new Error("LXD project name is invalid");
		const result = await this.#request("GET", projectPath("/1.0/images?recursion=1", project), undefined, signal);
		const entries = envelopeMetadata(result);
		if (!Array.isArray(entries)) throw new Error("LXD images list is invalid");
		return entries.map((entry) => {
			const meta = record(entry, "LXD image");
			if (
				typeof meta.fingerprint !== "string" ||
				!/^[0-9a-f]{64}$/.test(meta.fingerprint) ||
				!Number.isSafeInteger(meta.size) ||
				(meta.size as number) < 0
			)
				throw new Error("LXD image summary is invalid");
			const properties = meta.properties ? stringRecord(meta.properties, "LXD image properties") : {};
			return {
				fingerprint: meta.fingerprint,
				size: meta.size as number,
				...(typeof meta.created_at === "string" ? { createdAt: meta.created_at } : {}),
				properties,
			};
		});
	}

	async renameInstance(project: string, oldName: string, newName: string, signal: AbortSignal): Promise<void> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(oldName) || !INSTANCE_NAME.test(newName))
			throw new Error("LXD instance scope is invalid");
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(oldName)}`, project),
			{ name: newName },
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async updateInstanceConfig(
		project: string,
		name: string,
		update: {
			readonly config: Readonly<Record<string, string>>;
			readonly devices?: Readonly<Record<string, Readonly<Record<string, string>>>>;
		},
		signal: AbortSignal,
	): Promise<void> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(name)) throw new Error("LXD instance scope is invalid");
		const path = projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project);
		const current = await this.#request("GET", path, undefined, signal);
		const metadata = record(envelopeMetadata(current), "LXD instance");
		const etag = current.headers?.etag;
		if (typeof etag !== "string" || !etag) throw new Error("LXD instance version is unavailable");
		const existingConfig = stringRecord(metadata.config, "LXD instance config");
		const nextConfig: Record<string, string> = {};
		for (const [key, value] of Object.entries(existingConfig)) {
			if (key.startsWith("volatile.") || key.startsWith("image.")) nextConfig[key] = value;
		}
		for (const [key, value] of Object.entries(update.config)) nextConfig[key] = value;
		const body = {
			architecture: metadata.architecture,
			config: nextConfig,
			devices: update.devices ?? devices(metadata.devices),
			ephemeral: metadata.ephemeral,
			profiles: strings(metadata.profiles, "LXD instance profiles"),
			stateful: metadata.stateful,
			description: metadata.description,
		};
		const payload = Buffer.from(JSON.stringify(body), "utf-8");
		const result = await this.#requestPayload(
			"PUT",
			path,
			payload,
			{ "content-type": "application/json", "if-match": etag },
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async listInstances(project: string, signal: AbortSignal): Promise<readonly LxdInstanceRecord[]> {
		if (!INSTANCE_NAME.test(project)) throw new Error("LXD project name is invalid");
		const result = await this.#request("GET", projectPath("/1.0/instances?recursion=1", project), undefined, signal);
		const entries = envelopeMetadata(result);
		if (!Array.isArray(entries)) throw new Error("LXD instances list is invalid");
		return entries.map((entry) => instance(entry));
	}

	async getInstance(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceRecord | undefined> {
		const result = await this.#request(
			"GET",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project),
			undefined,
			signal,
		);
		if (result.status === 404) return undefined;
		return instance(envelopeMetadata(result));
	}

	/** Replaces the instance's own devices and nothing else: the rest of its
	 * configuration is written back exactly as read, under that read's ETag, so
	 * a change between this method's read and its write fails instead of being
	 * overwritten. The caller builds `devices` from an earlier read: callers
	 * must serialize their device changes (the coding host holds the machine's
	 * lifecycle lock). On a running VM LXD hot-plugs and hot-unplugs the
	 * difference. Any failure leaves the outcome to be observed again from the
	 * instance. */
	async replaceInstanceDevices(
		project: string,
		name: string,
		devices: Readonly<Record<string, Readonly<Record<string, string>>>>,
		signal: AbortSignal,
	): Promise<void> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(name)) throw new Error("LXD instance scope is invalid");
		const path = projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project);
		const current = await this.#request("GET", path, undefined, signal);
		const metadata = record(envelopeMetadata(current), "LXD instance");
		const etag = current.headers?.etag;
		if (typeof etag !== "string" || !etag) throw new Error("LXD instance version is unavailable");
		await this.#putInstanceDevices(path, metadata, etag, devices, signal);
	}

	/** Like replaceInstanceDevices, but `update` decides from the very read
	 * whose ETag the write carries: a change anywhere in the instance between
	 * the two fails the write (412) instead of being overwritten, so callers
	 * need no lock across processes. `update` returns the instance's new local
	 * devices, or undefined to write nothing (then this returns false). */
	async updateInstanceDevices(
		project: string,
		name: string,
		update: (instance: LxdInstanceRecord) => Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
		signal: AbortSignal,
	): Promise<boolean> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(name)) throw new Error("LXD instance scope is invalid");
		const path = projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project);
		const current = await this.#request("GET", path, undefined, signal);
		const metadata = record(envelopeMetadata(current), "LXD instance");
		const etag = current.headers?.etag;
		if (typeof etag !== "string" || !etag) throw new Error("LXD instance version is unavailable");
		const devices = update(instance(metadata));
		if (!devices) return false;
		await this.#putInstanceDevices(path, metadata, etag, devices, signal);
		return true;
	}

	async #putInstanceDevices(
		path: string,
		metadata: Record<string, unknown>,
		etag: string,
		devices: Readonly<Record<string, Readonly<Record<string, string>>>>,
		signal: AbortSignal,
	): Promise<void> {
		const body = {
			architecture: metadata.architecture,
			config: stringRecord(metadata.config, "LXD instance config"),
			devices,
			ephemeral: metadata.ephemeral,
			profiles: strings(metadata.profiles, "LXD instance profiles"),
			stateful: metadata.stateful,
			description: metadata.description,
		};
		const payload = Buffer.from(JSON.stringify(body), "utf-8");
		const result = await this.#requestPayload(
			"PUT",
			path,
			payload,
			{ "content-type": "application/json", "if-match": etag },
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async getInstanceState(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceStateRecord> {
		const result = await this.#request(
			"GET",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/state`, project),
			undefined,
			signal,
		);
		return instanceState(envelopeMetadata(result));
	}

	async getStorageVolume(
		project: string,
		pool: string,
		name: string,
		signal?: AbortSignal,
	): Promise<LxdStorageVolumeRecord | undefined> {
		const result = await this.#request(
			"GET",
			projectPath(
				`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
				project,
			),
			undefined,
			signal,
		);
		if (result.status === 404) return undefined;
		return storageVolume(envelopeMetadata(result));
	}

	/** Every custom volume of the pool in this project, with its configuration. */
	async listCustomStorageVolumes(
		project: string,
		pool: string,
		signal: AbortSignal,
	): Promise<LxdStorageVolumeRecord[]> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(pool)) throw new Error("LXD storage scope is invalid");
		const result = await this.#request(
			"GET",
			projectPath(`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom?recursion=1`, project),
			undefined,
			signal,
		);
		const volumes = envelopeMetadata(result);
		if (!Array.isArray(volumes)) throw new Error("LXD storage volume listing is invalid");
		return volumes.map(storageVolume);
	}

	/** One virtual machine disk volume's own use (`/state`), within 5 s: undefined when LXD has no such volume (404) or
	 * gives no whole byte count for it. Measured on node 2 (LXD 6.9, 13 Nov 2026): 4.5 ms (median, 5.1 worst) for a
	 * stopped machine's disk, 3.8 ms (4.0) for a running one's. */
	async readStorageVolumeUse(
		pool: string,
		project: string,
		name: string,
		signal: AbortSignal,
	): Promise<number | undefined> {
		if (!INSTANCE_NAME.test(pool) || !INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(name))
			throw new Error("LXD storage scope is invalid");
		const result = await withTimeoutScope(signal, 5000, (checked) =>
			this.#request(
				"GET",
				projectPath(
					`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/virtual-machine/${encodeURIComponent(name)}/state`,
					project,
				),
				undefined,
				checked,
			),
		);
		if (result.status < 200 || result.status >= 300) return undefined;
		const state = envelopeMetadata(result);
		const usage = state && typeof state === "object" ? (state as Record<string, unknown>).usage : undefined;
		const used = usage && typeof usage === "object" ? (usage as Record<string, unknown>).used : undefined;
		return typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : undefined;
	}

	/** The pool's own figures (`/resources`: LXD's space used and total, as `lxc storage info` gives them), within 5 s; a
	 * pool whose figures are missing or not whole byte counts fails the read. Measured on node 2: 5.9 ms (7.0 worst). */
	async readStoragePoolSpace(pool: string, signal: AbortSignal): Promise<LxdStoragePoolSpace> {
		if (!INSTANCE_NAME.test(pool)) throw new Error("LXD storage scope is invalid");
		const resources = await this.#officeMetadata(`/1.0/storage-pools/${encodeURIComponent(pool)}/resources`, signal);
		const space = record(resources.space, "LXD storage pool space");
		const totalBytes = space.total;
		const usedBytes = space.used;
		if (
			typeof totalBytes !== "number" ||
			typeof usedBytes !== "number" ||
			!Number.isSafeInteger(totalBytes) ||
			!Number.isSafeInteger(usedBytes) ||
			totalBytes <= 0 ||
			usedBytes < 0 ||
			usedBytes > totalBytes
		)
			throw new Error("LXD storage pool use is invalid");
		return { totalBytes, usedBytes };
	}

	async createStorageVolume(
		project: string,
		pool: string,
		request: LxdCreateStorageVolumeRequest,
		signal?: AbortSignal,
	): Promise<void> {
		if (request.type !== "custom" || request.content_type !== "filesystem") {
			throw new Error("LXD provider only creates custom filesystem volumes");
		}
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, project),
			request,
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async deleteStorageVolume(project: string, pool: string, name: string, signal?: AbortSignal): Promise<boolean> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(pool) || !INSTANCE_NAME.test(name))
			throw new Error("LXD storage scope is invalid");
		const result = await this.#request(
			"DELETE",
			projectPath(
				`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
				project,
			),
			undefined,
			signal,
		);
		if (result.status === 404) return false;
		const envelope = record(result.body, "LXD response");
		if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
		// A custom volume's delete answers synchronously, with or without metadata.
		if (envelope.type !== "sync") await this.#waitForOperation(result, signal);
		return true;
	}

	async createInstance(
		project: string,
		request: LxdCreateInstanceRequest,
		signal?: AbortSignal,
		dispatchSignal?: AbortSignal,
	): Promise<void> {
		if (request.type !== "virtual-machine") throw new Error("LXD provider only creates full virtual machines");
		const result = dispatchSignal
			? await withAbortScopes([dispatchSignal, signal], (dispatch) => {
					dispatch.throwIfAborted();
					return this.#request("POST", projectPath("/1.0/instances", project), request, dispatch);
				})
			: await (async () => {
					signal?.throwIfAborted();
					return this.#request("POST", projectPath("/1.0/instances", project), request, signal);
				})();
		await this.#waitForOperation(result, signal);
	}

	async submitInstanceOperation(
		project: string,
		action: LxdTrackedInstanceAction,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		try {
			const name = action.action === "create" ? action.request.name : action.name;
			if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(name)) throw new Error("invalid scope");
			if (action.action === "create" && action.request.type !== "virtual-machine") throw new Error("not a VM");
			const result = await withTimeoutScope(signal, 5000, async (checked) => {
				checked.throwIfAborted();
				let response: HttpResult;
				if (action.action === "create") {
					response = await this.#request("POST", projectPath("/1.0/instances", project), action.request, checked);
				} else if (action.action === "delete") {
					response = await this.#request(
						"DELETE",
						projectPath(`/1.0/instances/${name}`, project),
						undefined,
						checked,
					);
				} else if (action.action === "start" || action.action === "stop") {
					response = await this.#request(
						"PUT",
						projectPath(`/1.0/instances/${name}/state`, project),
						{
							action: action.action,
							timeout: this.#operationTimeoutSeconds,
							force: action.action === "stop" && action.force === true,
							stateful: false,
						},
						checked,
					);
				} else if (action.action === "rebuild") {
					if (!/^[0-9a-f]{64}$/.test(action.fingerprint)) throw new Error("invalid image");
					response = await this.#request(
						"POST",
						projectPath(`/1.0/instances/${name}/rebuild`, project),
						{ source: { type: "image", fingerprint: action.fingerprint } },
						checked,
					);
				} else throw new Error("invalid action");
				checked.throwIfAborted();
				return response;
			});
			const envelope = record(result.body, "LXD response");
			// LXD refused the request itself, with its own error and no operation: what it said is kept.
			if (result.status >= 400 && result.status <= 599 && envelope.type === "error")
				throw new LxdSubmissionRefused(result.status, envelope.error_code, envelope.error);
			if (
				result.status !== 202 ||
				envelope.type !== "async" ||
				envelope.status_code !== 100 ||
				typeof envelope.operation !== "string" ||
				!envelope.operation.startsWith("/1.0/operations/")
			)
				throw new Error("operation not confirmed");
			const operationId = envelope.operation.slice("/1.0/operations/".length);
			if (!OPERATION_UUID.test(operationId)) throw new Error("invalid operation URL");
			const reference = { project, instanceName: name, operationId };
			trackedOperation(envelope.metadata, reference);
			return reference;
		} catch (error) {
			if (error instanceof LxdSubmissionRefused) throw error;
			throw new Error("LXD_OPERATION_SUBMISSION_UNCONFIRMED");
		}
	}

	async allowsAgentCard(project: string, signal: AbortSignal): Promise<boolean> {
		let config: Record<string, string>;
		try {
			if (!/^[a-z][a-z0-9-]{0,62}$/.test(project)) throw new Error("invalid project");
			// Its used_by lists every instance, image and volume in it, so its record is not held to 64 KiB.
			const value = await this.#officeMetadata(`/1.0/projects/${project}`, signal, MAX_RESPONSE_BYTES);
			if (value.name !== project) throw new Error("project differs");
			config = stringRecord(value.config, "project config");
		} catch {
			throw new Error("LXD_PROJECT_UNCONFIRMED");
		}
		return projectAllowsAgentCard(config);
	}

	async inspectInstanceOperation(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
		let unknown = false;
		try {
			if (
				!INSTANCE_NAME.test(reference.project) ||
				!INSTANCE_NAME.test(reference.instanceName) ||
				!OPERATION_UUID.test(reference.operationId)
			)
				throw new Error("invalid operation reference");
			const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			checked.throwIfAborted();
			const result = await this.#request(
				"GET",
				projectPath(`/1.0/operations/${reference.operationId}`, reference.project),
				undefined,
				checked,
			);
			checked.throwIfAborted();
			const envelope = record(result.body, "LXD response");
			if (result.status === 404 && envelope.type === "error" && envelope.error_code === 404) unknown = true;
			if (result.status !== 200 || envelope.type !== "sync" || envelope.status_code !== 200)
				throw new Error("operation unavailable");
			return trackedOperation(envelope.metadata, reference);
		} catch {
			throw new Error(unknown ? "LXD_OPERATION_UNKNOWN" : "LXD_OPERATION_UNCONFIRMED");
		}
	}

	async setInstancePower(
		project: string,
		name: string,
		action: LxdInstancePowerAction,
		signal?: AbortSignal,
		dispatchSignal?: AbortSignal,
	): Promise<void> {
		const path = projectPath(`/1.0/instances/${encodeURIComponent(name)}/state`, project);
		const body = { action, timeout: this.#operationTimeoutSeconds, force: action === "stop", stateful: false };
		const result = dispatchSignal
			? await withAbortScopes([dispatchSignal, signal], (dispatch) => {
					dispatch.throwIfAborted();
					return this.#request("PUT", path, body, dispatch);
				})
			: await (async () => {
					signal?.throwIfAborted();
					return this.#request("PUT", path, body, signal);
				})();
		await this.#waitForOperation(result, signal);
	}

	async pushInstanceFile(
		project: string,
		name: string,
		path: string,
		content: string,
		mode: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (!path.startsWith("/") || /[\0\r\n]/.test(path)) throw new Error("LXD instance file path is invalid");
		if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) throw new Error("LXD instance file mode is invalid");
		const payload = Buffer.from(content, "utf-8");
		if (payload.byteLength > MAX_INSTANCE_FILE_BYTES) throw new Error("LXD instance file exceeds the supported size");
		const result = await this.#requestPayload(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, project),
			payload,
			{
				"content-type": "application/octet-stream",
				"x-lxd-type": "file",
				"x-lxd-uid": "0",
				"x-lxd-gid": "0",
				"x-lxd-mode": mode.toString(8).padStart(4, "0"),
				"x-lxd-modify-perm": "uid,gid,mode",
			},
			signal,
		);
		envelopeMetadata(result);
	}

	async pushInstanceProgram(
		project: string,
		name: string,
		path: string,
		content: Buffer,
		mode: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (!GUEST_PROGRAM_PATH.test(path)) throw new Error("LXD instance program path is invalid");
		if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)
			throw new Error("LXD instance program mode is invalid");
		if (!Buffer.isBuffer(content) || content.byteLength < 1 || content.byteLength > MAX_INSTANCE_PROGRAM_BYTES)
			throw new Error("LXD instance program exceeds the supported size");
		const result = await this.#requestPayload(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, project),
			content,
			{
				"content-type": "application/octet-stream",
				"x-lxd-type": "file",
				"x-lxd-uid": "0",
				"x-lxd-gid": "0",
				"x-lxd-mode": mode.toString(8).padStart(4, "0"),
				"x-lxd-modify-perm": "uid,gid,mode",
			},
			signal,
		);
		envelopeMetadata(result);
	}

	/** Provider-only metadata read, never a model/member filesystem tool. A file
	 * response does not attest the VM, its parent paths, or cloud activation. */
	async readInstanceFile(
		project: string,
		name: string,
		path: string,
		maximumBytes: number,
		signal?: AbortSignal,
	): Promise<LxdInstanceFile> {
		if (
			!Number.isSafeInteger(maximumBytes) ||
			maximumBytes < 1 ||
			maximumBytes > (CODING_GUEST_HELPER_PATH.test(path) ? CODING_GUEST_HELPER_MAX_BYTES : 65536)
		)
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		const file = await this.#readInstanceFile(project, name, path, maximumBytes, signal);
		// LXD 6.9 serves procfs using its zero stat size. Preserve the real file
		// metadata, but obtain these two public kernel values through fixed,
		// unprivileged read. Ordinary files never gain an execution fallback.
		if ((path !== "/proc/sys/kernel/random/boot_id" && path !== "/proc/uptime") || file.content.length !== 0)
			return file;
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444 || maximumBytes < (path === "/proc/uptime" ? 10 : 37))
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		const content = await this.#readPublicProcValue(project, name, path, maximumBytes, signal);
		const after = await this.#readInstanceFile(project, name, path, maximumBytes, signal);
		if (
			after.uid !== file.uid ||
			after.gid !== file.gid ||
			after.mode !== file.mode ||
			(after.content.length !== 0 &&
				(path === "/proc/uptime"
					? parseLxdProcUptime(after.content) < parseLxdProcUptime(content)
					: !after.content.equals(content)))
		)
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		return { ...after, content };
	}

	async #readPublicProcValue(
		project: string,
		name: string,
		path: "/proc/sys/kernel/random/boot_id" | "/proc/uptime",
		maximumBytes: number,
		signal?: AbortSignal,
	): Promise<Buffer> {
		try {
			return await withTimeoutScope(signal, 10000, async (checked) => {
				checked.throwIfAborted();
				const result = await this.#request(
					"POST",
					projectPath(`/1.0/instances/${name}/exec`, project),
					{
						command: ["/usr/bin/cat", "--", path],
						interactive: false,
						"wait-for-websocket": false,
						"record-output": true,
						user: 65534,
						group: 65534,
						cwd: "/",
						environment: {},
					},
					checked,
				);
				const envelope = record(result.body, "boot read");
				if (
					result.status !== 202 ||
					envelope.type !== "async" ||
					envelope.status_code !== 100 ||
					typeof envelope.operation !== "string" ||
					!envelope.operation.startsWith("/1.0/operations/")
				)
					throw new Error("read not accepted");
				const operationId = envelope.operation.slice("/1.0/operations/".length);
				if (!OPERATION_UUID.test(operationId)) throw new Error("invalid read operation");
				const reference = { project, instanceName: name, operationId };
				trackedOperation(envelope.metadata, reference);
				const operation = await this.#officeMetadata(
					projectPath(`${envelope.operation}/wait?timeout=5`, project),
					checked,
				);
				if (trackedOperation(operation, reference) !== "succeeded") throw new Error("read incomplete");
				const metadata = record(operation.metadata, "boot read result");
				const output = record(metadata.output, "boot read output");
				const prefix = `/1.0/instances/${name}/logs/exec-output/exec_${operationId}`;
				if (
					metadata.return !== 0 ||
					Object.keys(output).sort().join() !== "1,2" ||
					output["1"] !== `${prefix}.stdout` ||
					output["2"] !== `${prefix}.stderr`
				)
					throw new Error("read output identity differs");
				const stdout = await this.#requestPayload(
					"GET",
					projectPath(`${prefix}.stdout`, project),
					undefined,
					undefined,
					checked,
					Math.min(maximumBytes, path === "/proc/uptime" ? 128 : 64),
					"text",
				);
				const stderr = await this.#requestPayload(
					"GET",
					projectPath(`${prefix}.stderr`, project),
					undefined,
					undefined,
					checked,
					1,
					"text",
				);
				if (
					stdout.status !== 200 ||
					stderr.status !== 200 ||
					stderr.body !== "" ||
					typeof stdout.body !== "string" ||
					(path === "/proc/sys/kernel/random/boot_id" &&
						(!/^[0-9a-f-]{36}\n$/.test(stdout.body) || !OPERATION_UUID.test(stdout.body.slice(0, -1))))
				)
					throw new Error("invalid public proc read");
				if (path === "/proc/uptime") parseLxdProcUptime(Buffer.from(stdout.body));
				// Delete only the two public output logs belonging to this completed
				// observation. No guest file or lifecycle command is changed/replayed.
				for (const suffix of ["stdout", "stderr"]) {
					const removed = await this.#request(
						"DELETE",
						projectPath(`${prefix}.${suffix}`, project),
						undefined,
						checked,
					);
					if (removed.status !== 200) throw new Error("read log cleanup unconfirmed");
				}
				checked.throwIfAborted();
				return Buffer.from(stdout.body);
			});
		} catch {
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		}
	}

	async #readInstanceFile(
		project: string,
		name: string,
		path: string,
		maximumBytes: number,
		signal?: AbortSignal,
	): Promise<LxdInstanceFile> {
		try {
			if (
				![project, name].every((value) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)) ||
				path === "/" ||
				path !== resolve(path) ||
				path.length > 4096 ||
				/[\x00-\x1f\x7f\\]/.test(path) ||
				!Number.isSafeInteger(maximumBytes) ||
				maximumBytes < 1 ||
				maximumBytes > (CODING_GUEST_HELPER_PATH.test(path) ? CODING_GUEST_HELPER_MAX_BYTES : 65536)
			)
				throw new Error("invalid request");
			const checked = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
			checked.throwIfAborted();
			return await new Promise<LxdInstanceFile>((resolveRead, reject) => {
				const request = httpRequest(
					{
						method: "GET",
						socketPath: this.#socketPath,
						signal: checked,
						path: projectPath(
							`/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`,
							project,
						),
						headers: { accept: "application/octet-stream" },
					},
					(response) => {
						const fail = (): void => {
							response.destroy();
							request.destroy();
							reject(new Error("invalid read"));
						};
						response.once("error", fail);
						response.once("aborted", fail);
						const integer = (key: string): number => {
							const value = response.headers[key];
							if (
								typeof value !== "string" ||
								!/^(?:0|[1-9][0-9]{0,9})$/.test(value) ||
								Number(value) > 4294967295
							)
								throw new Error("invalid metadata");
							return Number(value);
						};
						let uid: number;
						let gid: number;
						let mode: number;
						let expectedLength: number | undefined;
						try {
							if (response.statusCode !== 200 || response.headers["x-lxd-type"] !== "file")
								throw new Error("not a file");
							uid = integer("x-lxd-uid");
							gid = integer("x-lxd-gid");
							const mask = response.headers["x-lxd-mode"];
							if (typeof mask !== "string" || !/^(?:0[0-7]{3,4}|[1-9][0-9]{0,3}|0)$/.test(mask))
								throw new Error("mode");
							mode = Number.parseInt(mask, mask.startsWith("0") ? 8 : 10);
							if (mode > 0o7777) throw new Error("mode");
							if (response.headers["content-length"] !== undefined) {
								expectedLength = integer("content-length");
								if (expectedLength > maximumBytes) throw new Error("oversized");
							}
						} catch {
							fail();
							return;
						}
						const chunks: Buffer[] = [];
						let length = 0;
						response.on("data", (chunk: Buffer) => {
							length += chunk.length;
							if (length > maximumBytes) {
								fail();
								return;
							}
							chunks.push(chunk);
						});
						response.once("end", () => {
							if (
								checked.aborted ||
								!response.complete ||
								(expectedLength !== undefined && length !== expectedLength)
							) {
								fail();
								return;
							}
							resolveRead({ content: Buffer.concat(chunks), uid, gid, mode });
						});
					},
				);
				request.once("error", () => reject(new Error("read unavailable")));
				request.end();
			});
		} catch {
			// LXD diagnostics and raw file bytes may contain private bootstrap data.
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		}
	}

	async deleteInstance(project: string, name: string, signal?: AbortSignal): Promise<void> {
		const result = await this.#request(
			"DELETE",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project),
			undefined,
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async getProject(name: string, signal?: AbortSignal): Promise<LxdProjectRecord | undefined> {
		if (!INSTANCE_NAME.test(name)) throw new Error("LXD project name is invalid");
		const result = await this.#request("GET", `/1.0/projects/${encodeURIComponent(name)}`, undefined, signal);
		if (result.status === 404) return undefined;
		return projectRecord(envelopeMetadata(result));
	}

	async createProject(name: string, config: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void> {
		if (!INSTANCE_NAME.test(name)) throw new Error("LXD project name is invalid");
		const result = await this.#request(
			"POST",
			"/1.0/projects",
			{ name, description: "", config: { ...config } },
			signal,
		);
		const envelope = record(result.body, "LXD response");
		if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
		// A project's create answers synchronously, with null metadata.
		if (envelope.type !== "sync") await this.#waitForOperation(result, signal);
	}

	async deleteProject(name: string, signal?: AbortSignal): Promise<boolean> {
		if (!INSTANCE_NAME.test(name)) throw new Error("LXD project name is invalid");
		const result = await this.#request("DELETE", `/1.0/projects/${encodeURIComponent(name)}`, undefined, signal);
		if (result.status === 404) return false;
		const envelope = record(result.body, "LXD response");
		if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
		// A project's delete answers synchronously, with or without metadata.
		if (envelope.type !== "sync") await this.#waitForOperation(result, signal);
		return true;
	}

	async listProjectNames(signal?: AbortSignal): Promise<string[]> {
		const result = await this.#request("GET", "/1.0/projects", undefined, signal);
		return strings(envelopeMetadata(result), "LXD projects").map((url) => {
			if (!url.startsWith("/1.0/projects/") || url.slice(14).includes("/"))
				throw new Error("LXD projects is invalid");
			return decodeURIComponent(url.slice(14));
		});
	}

	async execInstance(
		project: string,
		name: string,
		command: readonly string[],
		signal?: AbortSignal,
		waitSeconds = this.#operationTimeoutSeconds,
	): Promise<void> {
		if (
			!Number.isSafeInteger(waitSeconds) ||
			waitSeconds < 1 ||
			waitSeconds > 600 ||
			command.length < 1 ||
			command.length > 64 ||
			command.some((argument) => !argument || /[\0\r\n]/.test(argument) || Buffer.byteLength(argument) > 4096)
		) {
			throw new Error("LXD instance command is invalid");
		}
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/exec`, project),
			{
				command: [...command],
				interactive: false,
				"wait-for-websocket": false,
				"record-output": true,
				user: 0,
				group: 0,
			},
			signal,
		);
		const operation = await this.#waitForOperation(result, signal, waitSeconds);
		const metadata = record(operation.metadata, "LXD exec operation metadata");
		if (metadata.return !== 0) throw new Error("LXD instance command failed");
	}

	async readCodingMachineMemory(
		project: string,
		name: string,
		groups: readonly string[],
		signal?: AbortSignal,
	): Promise<LxdCodingMachineMemory> {
		if (!INSTANCE_NAME.test(project) || !INSTANCE_NAME.test(name)) throw new Error("LXD instance scope is invalid");
		if (groups.length > CODING_MEMORY_MAX_GROUPS || !groups.every(validCodingMemoryPath))
			throw new Error("LXD_CODING_MEMORY_PATH_INVALID");
		const allPaths = ["/proc/meminfo", ...new Set(groups)];
		const stats = new Map<string, string>();
		let meminfo = "";
		const timeoutMs = Math.min(CODING_MEMORY_TIMEOUT_MS, this.#operationTimeoutSeconds * 1000);
		// WHY: LXD 6.9 serves procfs and cgroup v2 files as zero bytes via /files; batch-read via unprivileged websocket exec.
		for (let offset = 0; offset < allPaths.length; offset += CODING_MEMORY_BATCH_SIZE) {
			const batch = allPaths.slice(offset, offset + CODING_MEMORY_BATCH_SIZE);
			const batchSet = new Set(batch);
			const result = await this.execInstanceStream(
				project,
				name,
				{
					command: ["/bin/sh", "-c", CODING_MEMORY_READ_SCRIPT, "qorpera-memory", ...batch],
					user: 65534,
					group: 65534,
					stdin: Buffer.alloc(0),
					maxStdoutBytes: CODING_MEMORY_MAX_STDOUT_BYTES,
					maxStderrBytes: CODING_MEMORY_MAX_STDERR_BYTES,
					timeoutMs,
				},
				signal,
			);
			if (result.exitCode !== 0) throw new Error("LXD_CODING_MEMORY_READ_FAILED");
			const buffers = new Map<string, string[]>();
			let current: string | undefined;
			for (const line of result.stdout.toString("utf8").split("\n")) {
				const header = CODING_MEMORY_HEADER.exec(line);
				if (header && batchSet.has(header[1]!)) {
					current = header[1]!;
					if (buffers.has(current)) throw new Error("LXD_CODING_MEMORY_READ_FAILED");
					buffers.set(current, []);
					continue;
				}
				if (current !== undefined) buffers.get(current)!.push(line);
			}
			for (const path of batch) {
				const section = buffers.get(path);
				if (section === undefined) throw new Error("LXD_CODING_MEMORY_READ_FAILED");
				const text = section.join("\n").trim();
				if (path === "/proc/meminfo") meminfo = text;
				else if (text) stats.set(path, text);
			}
		}
		if (!meminfo) throw new Error("LXD_CODING_MEMORY_READ_FAILED");
		return { meminfo, stats };
	}

	/** LXD's non-interactive exec with `wait-for-websocket`: one websocket each for stdin, stdout and stderr, binary
	 * messages, and an empty text message as each stream's end. The control websocket is left unconnected, so closing
	 * the stdout websocket before the command ends makes LXD kill it (SIGKILL): every early exit here does that. */
	async execInstanceStream(
		project: string,
		name: string,
		request: LxdExecStreamRequest,
		signal?: AbortSignal,
	): Promise<LxdExecStreamResult> {
		const { command, stdin, maxStdoutBytes, maxStderrBytes, timeoutMs, user = 0, group = 0 } = request;
		if (
			!Number.isSafeInteger(user) ||
			user < 0 ||
			user > 65535 ||
			!Number.isSafeInteger(group) ||
			group < 0 ||
			group > 65535 ||
			command.length < 1 ||
			command.length > 64 ||
			command.some((argument) => !argument || /[\0\r\n]/.test(argument) || Buffer.byteLength(argument) > 4096) ||
			!Buffer.isBuffer(stdin) ||
			stdin.byteLength > MAX_EXEC_STREAM_INPUT_BYTES ||
			[maxStdoutBytes, maxStderrBytes].some(
				(bound) => !Number.isSafeInteger(bound) || bound < 0 || bound > MAX_EXEC_STREAM_OUTPUT_BYTES,
			) ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > this.#operationTimeoutSeconds * 1000
		)
			throw new Error("LXD instance command is invalid");
		return withTimeoutScope(signal, timeoutMs, async (checked) => {
			checked.throwIfAborted();
			const result = await this.#request(
				"POST",
				projectPath(`/1.0/instances/${encodeURIComponent(name)}/exec`, project),
				{
					command: [...command],
					interactive: false,
					"wait-for-websocket": true,
					"record-output": false,
					user,
					group,
					cwd: "/",
					environment: {},
				},
				checked,
			);
			if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD exec stream was refused");
			const envelope = record(result.body, "LXD exec stream");
			if (
				envelope.type !== "async" ||
				typeof envelope.operation !== "string" ||
				!envelope.operation.startsWith("/1.0/operations/") ||
				!OPERATION_UUID.test(envelope.operation.slice("/1.0/operations/".length))
			)
				throw new Error("LXD exec stream operation is invalid");
			const fds = record(
				record(record(envelope.metadata, "LXD exec stream operation").metadata, "LXD exec stream metadata").fds,
				"LXD exec stream fds",
			);
			const fdStream = (fd: "0" | "1" | "2", bound: number) => {
				const secret = fds[fd];
				if (typeof secret !== "string" || !/^[0-9A-Za-z]{16,256}$/.test(secret))
					throw new Error("LXD exec stream fds are invalid");
				return { secret, bound, chunks: [] as Buffer[], bytes: 0, ended: false };
			};
			const input = fdStream("0", 0);
			const stdout = fdStream("1", maxStdoutBytes);
			const stderr = fdStream("2", maxStderrBytes);
			const connectAbort = new AbortController();
			const sockets: [NodeWebSocket | undefined, NodeWebSocket | undefined, NodeWebSocket | undefined] = [
				undefined,
				undefined,
				undefined,
			];
			let failure: Error | undefined;
			let settle: () => void = () => undefined;
			const drained = new Promise<void>((resolveDrained) => {
				settle = resolveDrained;
			});
			// Ends the call: the stdout websocket closes first, which kills a command still running.
			const fail = (error: Error): void => {
				failure ??= error;
				connectAbort.abort();
				for (const socket of sockets) socket?.close();
				settle();
			};
			const aborted = (): void => fail(new Error("LXD exec stream was stopped"));
			if (checked.aborted) aborted();
			else checked.addEventListener("abort", aborted, { once: true });
			let connects: Promise<void>[] = [];
			try {
				connects = [stdout, stderr, input].map(async (stream, index) => {
					try {
						const socket = await NodeWebSocket.connect(
							new URL(`ws://lxd${envelope.operation}/websocket?secret=${encodeURIComponent(stream.secret)}`),
							{
								// A text message is the stream's end; LXD sends it once the command's side has closed.
								message: () => {
									if (stream === input) return;
									stream.ended = true;
									if (stdout.ended && stderr.ended) settle();
								},
								binary: (payload) => {
									if (stream === input || stream.ended || failure) return;
									stream.bytes += payload.byteLength;
									if (stream.bytes > stream.bound) {
										fail(new Error("LXD exec stream output exceeded its bound"));
										return;
									}
									stream.chunks.push(payload);
								},
								close: () => {
									if (stream !== input && !stream.ended)
										fail(new Error("LXD exec stream ended before its output"));
								},
							},
							EXEC_STREAM_CONNECT_MS,
							// The deadline and the signal also stop a handshake LXD has not answered yet.
							{ socketPath: this.#socketPath, signal: connectAbort.signal },
						);
						if (failure || connectAbort.signal.aborted) {
							socket.close();
							fail(failure ?? new Error("LXD exec stream was stopped"));
							throw failure;
						}
						sockets[index] = socket;
					} catch (error) {
						fail(
							checked.aborted
								? new Error("LXD exec stream was stopped")
								: error instanceof Error
									? error
									: new Error("LXD exec stream failed"),
						);
						throw failure;
					}
				});
				await Promise.all(connects);
				if (failure || checked.aborted) {
					fail(failure ?? new Error("LXD exec stream was stopped"));
					throw failure;
				}
				const stdinSocket = sockets[2]!;
				if (stdin.byteLength > 0) stdinSocket.sendBinary(stdin);
				stdinSocket.send("");
				const operation = await this.#waitForOperation(result, checked);
				const metadata = record(operation.metadata, "LXD exec stream result");
				const exitCode = metadata.return;
				if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))
					throw new Error("LXD exec stream result is invalid");
				const drainTimer = setTimeout(
					() => fail(new Error("LXD exec stream output did not end")),
					EXEC_STREAM_DRAIN_MS,
				);
				try {
					await drained;
				} finally {
					clearTimeout(drainTimer);
				}
				if (failure) throw failure;
				return { exitCode, stdout: Buffer.concat(stdout.chunks), stderr: Buffer.concat(stderr.chunks) };
			} catch (error) {
				fail(error instanceof Error ? error : new Error("LXD exec stream failed"));
				await Promise.allSettled(connects);
				throw failure;
			} finally {
				connectAbort.abort();
				checked.removeEventListener("abort", aborted);
				for (const socket of sockets) socket?.close();
			}
		});
	}

	/** `execInstanceStream`'s exec for the code host's jobs, which run as long as they need and move whole bundles: the
	 * command gets its environment and working directory, its input streams in beside its output (one message at a
	 * time, each once the last has drained, so the source is read no faster than the command reads), stdout is kept up
	 * to its bound and only the end of stderr. The output's end messages, not a deadline, end the wait; the signal is
	 * the only bound. As there, every early exit closes the stdout websocket, on which LXD kills the command; the end of
	 * the call also stops a handshake LXD has not answered and closes a source it did not read to its end. */
	async execInstancePipe(
		project: string,
		name: string,
		request: LxdExecPipeRequest,
		signal: AbortSignal,
	): Promise<LxdExecPipeResult> {
		const { command, environment, cwd, stdin, maxStdoutBytes, stderrTailBytes, stdout: handOver, onStdout } = request;
		if (!validExecPipe(request)) throw new Error("LXD instance command is invalid");
		signal.throwIfAborted();
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/exec`, project),
			{
				command: [...command],
				interactive: false,
				"wait-for-websocket": true,
				"record-output": false,
				user: request.user ?? 0,
				group: request.group ?? 0,
				cwd,
				environment: { ...environment },
			},
			signal,
		);
		if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD exec pipe was refused");
		const envelope = record(result.body, "LXD exec pipe");
		if (
			envelope.type !== "async" ||
			typeof envelope.operation !== "string" ||
			!envelope.operation.startsWith("/1.0/operations/") ||
			!OPERATION_UUID.test(envelope.operation.slice("/1.0/operations/".length))
		)
			throw new Error("LXD exec pipe operation is invalid");
		const fds = record(
			record(record(envelope.metadata, "LXD exec pipe operation").metadata, "LXD exec pipe metadata").fds,
			"LXD exec pipe fds",
		);
		const secretOf = (fd: "0" | "1" | "2"): string => {
			const secret = fds[fd];
			if (typeof secret !== "string" || !/^[0-9A-Za-z]{16,256}$/.test(secret))
				throw new Error("LXD exec pipe fds are invalid");
			return secret;
		};
		const streams = [
			{ name: "stdout", secret: secretOf("1") },
			{ name: "stderr", secret: secretOf("2") },
			{ name: "stdin", secret: secretOf("0") },
		] as const;
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		const stderrChunks: Buffer[] = [];
		let stderrHead = 0;
		let stderrBytes = 0;
		let stdoutEnded = false;
		let stderrEnded = false;
		let inputSent = false;
		// Aborted when the call ends: it stops a handshake LXD has not answered, and the input, which closes a source
		// not read to its end.
		const callEnd = new AbortController();
		const sockets: [NodeWebSocket | undefined, NodeWebSocket | undefined, NodeWebSocket | undefined] = [
			undefined,
			undefined,
			undefined,
		];
		let failure: Error | undefined;
		let settle: () => void = () => undefined;
		const ended = new Promise<void>((resolveEnded) => {
			settle = resolveEnded;
		});
		// Ends the call: the stdout websocket closes first, which kills a command still running.
		const fail = (error: Error): void => {
			failure ??= error;
			callEnd.abort();
			for (const socket of sockets) socket?.close();
			settle();
		};
		const aborted = (): void => fail(new Error("LXD exec pipe was stopped"));
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
		let connects: Promise<void>[] = [];
		try {
			connects = streams.map(async (stream, index) => {
				try {
					const socket = await NodeWebSocket.connect(
						new URL(`ws://lxd${envelope.operation}/websocket?secret=${encodeURIComponent(stream.secret)}`),
						{
							// A text message is the stream's end; LXD sends it once the command's side has closed.
							message: () => {
								if (stream.name === "stdout") stdoutEnded = true;
								else if (stream.name === "stderr") stderrEnded = true;
								if (stdoutEnded && stderrEnded) settle();
							},
							binary: (payload) => {
								if (failure) return;
								if (stream.name === "stdout" && !stdoutEnded && handOver) {
									// Handed over as it comes, nothing kept: the bound is each message's.
									if (payload.byteLength > maxStdoutBytes)
										fail(new Error("LXD exec pipe output exceeded its bound"));
									else
										try {
											handOver(payload);
										} catch (error) {
											fail(error instanceof Error ? error : new Error("LXD exec pipe output was refused"));
										}
								} else if (stream.name === "stdout" && !stdoutEnded) {
									stdoutBytes += payload.byteLength;
									if (stdoutBytes > maxStdoutBytes) fail(new Error("LXD exec pipe output exceeded its bound"));
									else {
										stdout.push(payload);
										// The caller's own reading may fail; that fails the call, as a bound does.
										try {
											onStdout?.(Buffer.from(payload));
										} catch (error) {
											fail(error instanceof Error ? error : new Error("LXD exec pipe output was refused"));
										}
									}
								} else if (
									stream.name === "stderr" &&
									!stderrEnded &&
									stderrTailBytes > 0 &&
									payload.byteLength > 0
								) {
									if (payload.byteLength >= stderrTailBytes) {
										stderrChunks.length = 0;
										stderrHead = 0;
										stderrChunks.push(Buffer.from(payload.subarray(payload.byteLength - stderrTailBytes)));
										stderrBytes = stderrTailBytes;
									} else {
										stderrChunks.push(payload);
										stderrBytes += payload.byteLength;
										while (stderrBytes > stderrTailBytes && stderrHead < stderrChunks.length) {
											const overflow = stderrBytes - stderrTailBytes;
											const first = stderrChunks[stderrHead]!;
											if (first.byteLength <= overflow) {
												stderrHead += 1;
												stderrBytes -= first.byteLength;
											} else {
												stderrChunks[stderrHead] = first.subarray(overflow);
												stderrBytes -= overflow;
											}
										}
										if (stderrHead > 64 && stderrHead * 2 >= stderrChunks.length) {
											stderrChunks.splice(0, stderrHead);
											stderrHead = 0;
										}
									}
								}
							},
							// The stdin websocket may close as soon as the command is done with it.
							close: () => {
								if ((stream.name === "stdout" && !stdoutEnded) || (stream.name === "stderr" && !stderrEnded))
									fail(new Error("LXD exec pipe ended before its output"));
							},
						},
						EXEC_STREAM_CONNECT_MS,
						// The signal and the call's end also stop a handshake LXD has not answered yet.
						{ socketPath: this.#socketPath, signal: callEnd.signal },
					);
					if (failure || callEnd.signal.aborted) {
						socket.close();
						fail(failure ?? new Error("LXD exec pipe was stopped"));
						throw failure;
					}
					sockets[index] = socket;
				} catch (error) {
					fail(
						signal.aborted
							? new Error("LXD exec pipe was stopped")
							: error instanceof Error
								? error
								: new Error("LXD exec pipe failed"),
					);
					throw failure;
				}
			});
			await Promise.all(connects);
			if (failure || signal.aborted) {
				fail(failure ?? new Error("LXD exec pipe was stopped"));
				throw failure;
			}
			// The input runs beside the output: a command may print before it has read all of its stdin. Only the
			// source's own failure fails the call; a websocket that closed under the input leaves it to the exit code.
			pipeInput(sockets[2]!, stdin, callEnd.signal).then(
				(sent) => {
					inputSent = sent;
				},
				(error: unknown) => fail(error instanceof Error ? error : new Error("LXD exec pipe input failed")),
			);
			await ended;
			if (failure) throw failure;
			const operation = await this.#waitForOperation(result, signal);
			const metadata = record(operation.metadata, "LXD exec pipe result");
			const exitCode = metadata.return;
			if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))
				throw new Error("LXD exec pipe result is invalid");
			if (failure) throw failure;
			// A command that succeeded without all of its input never saw what the caller gave it.
			if (exitCode === 0 && !inputSent) throw new Error("LXD exec pipe command ended before its input");
			const stderrTail =
				stderrBytes === 0
					? Buffer.alloc(0)
					: Buffer.concat(stderrHead === 0 ? stderrChunks : stderrChunks.slice(stderrHead), stderrBytes);
			return { exitCode, stdout: Buffer.concat(stdout), stderrTail };
		} catch (error) {
			fail(error instanceof Error ? error : new Error("LXD exec pipe failed"));
			await Promise.allSettled(connects);
			throw failure;
		} finally {
			callEnd.abort();
			signal.removeEventListener("abort", aborted);
			for (const socket of sockets) socket?.close();
		}
	}

	async #waitForOperation(
		result: HttpResult,
		signal?: AbortSignal,
		waitSeconds = this.#operationTimeoutSeconds,
	): Promise<Record<string, unknown>> {
		const envelope = record(result.body, "LXD response");
		if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
		if (envelope.type === "sync") return record(envelope.metadata, "LXD synchronous operation");
		if (
			envelope.type !== "async" ||
			typeof envelope.operation !== "string" ||
			!envelope.operation.startsWith("/1.0/operations/")
		) {
			throw new Error("LXD operation response is invalid");
		}
		const waitPath = `${envelope.operation}/wait?timeout=${waitSeconds}`;
		const wait = await this.#request("GET", waitPath, undefined, signal);
		// LXD 5.21-6.x write the wait's 200 header before the operation ends, so a
		// failed operation arrives as an error envelope under HTTP 200
		// ({"type":"error","error_code":500,"error":"...","metadata":null}). Newer
		// LXD renders the failed operation itself (status_code 400, err "...").
		const waited = record(wait.body, "LXD response");
		// That error envelope is also what a wait that merely timed out writes ("context deadline exceeded"):
		// only the operation's own end says whether it failed.
		if (wait.status >= 200 && wait.status < 300 && waited.type === "error")
			throw operationFailure(waited.error, await this.#endedInFailure(envelope.operation, signal));
		const operation = record(envelopeMetadata(wait), "LXD operation");
		if (
			typeof operation.status_code !== "number" ||
			operation.status_code < 200 ||
			operation.status_code >= 300 ||
			(typeof operation.err === "string" && operation.err.length > 0)
		) {
			// Only an ended operation is a known failure; a wait that timed out returns it still running.
			throw operationFailure(
				operation.err,
				(operation.status_code === 400 && operation.status === "Failure") ||
					(operation.status_code === 401 && operation.status === "Cancelled"),
			);
		}
		return operation;
	}

	/** Whether LXD reports the operation ended in Failure or Cancelled. LXD keeps an ended operation for a few
	 * seconds; anything else (still running, gone, unreadable) is no proof. */
	async #endedInFailure(operationPath: string, signal?: AbortSignal): Promise<boolean> {
		try {
			return await withTimeoutScope(signal, 5000, async (checked) => {
				const result = await this.#request("GET", operationPath, undefined, checked);
				const envelope = record(result.body, "LXD response");
				if (result.status !== 200 || envelope.type !== "sync") return false;
				const operation = record(envelope.metadata, "LXD operation");
				return (
					(operation.status_code === 400 && operation.status === "Failure") ||
					(operation.status_code === 401 && operation.status === "Cancelled")
				);
			});
		} catch {
			return false;
		}
	}

	async #request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<HttpResult> {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
		return this.#requestPayload(
			method,
			path,
			payload,
			payload ? { "content-type": "application/json" } : undefined,
			signal,
		);
	}

	async #requestPayload(
		method: string,
		path: string,
		payload: Buffer | undefined,
		headers: Readonly<Record<string, string>> | undefined,
		signal?: AbortSignal,
		maximumResponseBytes = MAX_RESPONSE_BYTES,
		format: "json" | "text" = "json",
	): Promise<HttpResult> {
		if (!signal) {
			const defaultTimeoutMs = defaultLxdRequestTimeoutMs(path, this.#operationTimeoutSeconds);
			return withTimeoutScope(undefined, defaultTimeoutMs, (checked) =>
				this.#requestPayload(method, path, payload, headers, checked, maximumResponseBytes, format),
			);
		}
		return new Promise<HttpResult>((resolve, reject) => {
			const request = httpRequest(
				{
					method,
					path,
					socketPath: this.#socketPath,
					headers: payload ? { ...headers, "content-length": String(payload.byteLength) } : headers,
					signal,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let length = 0;
					response.once("error", reject);
					response.once("aborted", () => reject(new Error("LXD response was truncated")));
					response.on("data", (chunk: Buffer) => {
						length += chunk.byteLength;
						if (length > maximumResponseBytes) {
							reject(new Error("LXD response exceeded the supported size"));
							request.destroy();
							return;
						}
						chunks.push(chunk);
					});
					response.once("end", () => {
						try {
							if (!response.complete || signal?.aborted) throw new Error("LXD response was incomplete");
							const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
							resolve({
								status: response.statusCode ?? 500,
								headers: response.headers,
								body: format === "text" ? text : text ? (JSON.parse(text) as unknown) : null,
							});
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			request.once("error", reject);
			if (payload) request.end(payload);
			else request.end();
		});
	}
}
