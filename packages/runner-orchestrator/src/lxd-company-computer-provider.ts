import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import type { LxdCreateInstanceRequest, LxdInstanceRecord, LxdPersistentInstanceClient } from "./lxd-client.ts";
import { HttpLxdGuestTransport, type LxdGuestTransport } from "./lxd-provider.ts";
import type {
	CloudRunnerAssignmentDelivery,
	CloudRunnerCapability,
	CloudRunnerInstance,
	CloudRunnerWork,
} from "./orchestrator.ts";
import { validateCloudRunnerWork } from "./orchestrator.ts";
import type { CloudRunnerProviderServiceBackend } from "./provider-service.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const NODE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const STORAGE_SIZE_PATTERN = /^[1-9][0-9]*(?:KiB|MiB|GiB|TiB)$/;
const DATASET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,180}(?:\/[a-z0-9][a-z0-9._-]{0,180}){0,7}$/;
const SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;
const JOURNAL_SCHEMA = "qorpera.lxd-company-computer-journal/v1";
const BOOTSTRAP_SCHEMA = "qorpera.company-computer-bootstrap/v2";
const IDENTITY_VOLUME_SCHEMA = "qorpera.compute-identity-volume/v1";

/** Layout inside the existing company NAS root. `live` is the same tree used
 * by Step 2 runners and every desktop; profiles and hidden machine state are
 * siblings on the same share. There is no second checkout or sync head. */
export const COMPANY_COMPUTER_DATASET_LAYOUT = {
	liveDirectory: "live",
	profilesDirectory: "profiles",
	stateDirectory: ".qorpera-computer",
} as const;

export const COMPANY_COMPUTER_GUEST_DATASET_PATH = "/srv/qorpera/dataset";

/** Default guest port for the screen agent's viewer listener; like the
 * assignment listener it accepts connections only from the trusted host
 * bridge address and is never publicly routable. */
export const COMPANY_COMPUTER_SCREEN_VIEWER_PORT = 8_446;

/** Default idle window before a machine with no open screens powers off. */
export const COMPANY_COMPUTER_IDLE_POWER_OFF_SECONDS = 300;

/** Synology's map-all-to-admin export exposes shared files through `users`. */
export const COMPANY_COMPUTER_NAS_SHARED_GID = 100;

/** Dataset rollback points are occasional background infrastructure work,
 * not a synchronous turn-completion publication pass. */
export const COMPANY_COMPUTER_DATASET_SNAPSHOT_INTERVAL_SECONDS = 6 * 60 * 60;

export type LxdCompanyComputerLifecycleState =
	| "provisioning"
	| "active"
	| "snapshotting"
	| "migrating"
	| "recovering"
	| "retired";

export type LxdCompanyComputerPhysicalState = "creating" | "starting" | "ready" | "stopped" | "lost";

export interface LxdCompanyComputerAuthority {
	companyComputerId: string;
	profileId: string;
	environmentId: string;
	logicalComputerId: string;
	lifecycleState: LxdCompanyComputerLifecycleState;
	nasDataset: string;
	nodeKey?: string;
	logicalComputerStatus: string;
	computeIdentityId: string;
	templateKey: string;
	templateVersion: string;
	capabilities: readonly CloudRunnerCapability[];
	computePolicySha256: string;
}

export interface LxdCompanyComputerControlPlane {
	describeCompanyComputer(logicalComputerId: string, signal?: AbortSignal): Promise<LxdCompanyComputerAuthority>;
	/** How many screens are open on the machine: the input to derived power.
	 * Screens without a power field (an older control plane) count as open so
	 * the machine never powers off on missing information. */
	countOpenScreens(companyComputerId: string, signal?: AbortSignal): Promise<number>;
	provisionRunner(
		runId: string,
		clientRunnerId: string,
		activationTokenSha256: string,
		signal?: AbortSignal,
	): Promise<unknown>;
	transitionLifecycle(
		companyComputerId: string,
		state: LxdCompanyComputerLifecycleState,
		nodeKey: string | undefined,
		detail: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void>;
	relocateDataset(
		companyComputerId: string,
		nasDataset: string,
		detail: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<LxdCompanyComputerAuthority>;
}

/** Captures the working world: a point-in-time snapshot of the per-company
 * NAS dataset, taken inside the control-plane snapshotting window. The
 * disposable VM root is recovered from its signed image, not snapshotted. */
export interface CompanyDatasetSnapshotClient {
	snapshotDataset(dataset: string, snapshotName: string, signal?: AbortSignal): Promise<void>;
}

/** Fail-closed proof that the configured source is the real, writable NAS
 * filesystem rather than a local directory exposed after a missing mount. */
export interface CompanyDatasetSourceVerifier {
	verifyDatasetSource(datasetRoot: string, datasetSource: string): Promise<void>;
}

function decodeLinuxMountInfoPath(value: string): string {
	return value.replaceAll("\\040", " ").replaceAll("\\011", "\t").replaceAll("\\012", "\n").replaceAll("\\134", "\\");
}

function pathIsWithin(root: string, candidate: string): boolean {
	return candidate === root || (root === "/" ? candidate.startsWith("/") : candidate.startsWith(`${root}/`));
}

/** Linux deployment verifier. `/proc/self/mountinfo` is used instead of
 * accepting any mountpoint: the backing filesystem must specifically be a
 * read-write NFS/NFS4 mount. */
export class LinuxNfsCompanyDatasetSourceVerifier implements CompanyDatasetSourceVerifier {
	readonly #mountInfoPath: string;

	constructor(mountInfoPath = "/proc/self/mountinfo") {
		if (!isAbsolute(mountInfoPath)) throw new Error("Linux mountinfo path must be absolute");
		this.#mountInfoPath = mountInfoPath;
	}

	async verifyDatasetSource(datasetRoot: string, datasetSource: string): Promise<void> {
		const [rootInfo, sourceInfo] = await Promise.all([lstat(datasetRoot), lstat(datasetSource)]);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
			throw new Error("Company computer NAS dataset root is not a real directory");
		}
		if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
			throw new Error("Company computer NAS dataset source is not a real directory");
		}
		const [resolvedRoot, resolvedSource, mountInfo] = await Promise.all([
			realpath(datasetRoot),
			realpath(datasetSource),
			readFile(this.#mountInfoPath, "utf-8"),
		]);
		if (!pathIsWithin(resolvedRoot, resolvedSource)) {
			throw new Error("Company computer NAS dataset source escapes its real dataset root");
		}
		const mounts = mountInfo
			.split("\n")
			.flatMap((line): Array<{ mountPoint: string; mountOptions: string; fileSystemType: string }> => {
				const separator = line.indexOf(" - ");
				if (separator < 0) return [];
				const mountFields = line.slice(0, separator).split(" ");
				const filesystemFields = line.slice(separator + 3).split(" ");
				const encodedMountPoint = mountFields[4];
				const mountOptions = mountFields[5];
				const fileSystemType = filesystemFields[0];
				if (!encodedMountPoint || !mountOptions || !fileSystemType) return [];
				const mountPoint = resolve(decodeLinuxMountInfoPath(encodedMountPoint));
				return pathIsWithin(mountPoint, resolvedRoot) ? [{ mountPoint, mountOptions, fileSystemType }] : [];
			})
			.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
		const backingMount = mounts[0];
		if (!backingMount || (backingMount.fileSystemType !== "nfs" && backingMount.fileSystemType !== "nfs4")) {
			throw new Error("Company computer NAS dataset root is not backed by NFS");
		}
		if (!backingMount.mountOptions.split(",").includes("rw")) {
			throw new Error("Company computer NAS dataset root is not mounted read-write");
		}
		/* The provider itself stays read-only to company data; guest bootstrap
		 * separately proves the shared GID has write access before agents start. */
		await access(resolvedSource, fsConstants.R_OK | fsConstants.X_OK);
	}
}

export type CompanyDatasetSnapshotExec = (
	command: string,
	args: readonly string[],
	signal?: AbortSignal,
) => Promise<{ code: number | null; stderr: string }>;

const defaultDatasetSnapshotExec: CompanyDatasetSnapshotExec = (command, args, signal) =>
	new Promise((resolveExec, rejectExec) => {
		const child = spawn(command, [...args], {
			stdio: ["ignore", "ignore", "pipe"],
			shell: false,
			env: Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"].flatMap((key) => {
					const value = process.env[key];
					return value === undefined ? [] : [[key, value]];
				}),
			),
			...(signal ? { signal } : {}),
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4_096) stderr += chunk.toString("utf-8");
		});
		child.on("error", rejectExec);
		child.on("close", (code) => resolveExec({ code, stderr }));
	});

/** Runs the deployment's dataset-snapshot command — zfs on a storage host,
 * ssh to the NAS, or a vendor CLI — with {dataset} and {snapshot} substituted
 * per argument and no shell in between. Both substituted values are
 * pattern-locked so the template can never be steered outside snapshot
 * naming. */
export class ExecCompanyDatasetSnapshotClient implements CompanyDatasetSnapshotClient {
	readonly #command: readonly string[];
	readonly #exec: CompanyDatasetSnapshotExec;

	constructor(command: readonly string[], exec: CompanyDatasetSnapshotExec = defaultDatasetSnapshotExec) {
		const joined = command.join(" ");
		if (
			command.length < 1 ||
			command.some((argument) => !argument.trim()) ||
			!joined.includes("{dataset}") ||
			!joined.includes("{snapshot}")
		) {
			throw new Error("Company dataset snapshot command must reference {dataset} and {snapshot}");
		}
		this.#command = [...command];
		this.#exec = exec;
	}

	async snapshotDataset(dataset: string, snapshotName: string, signal?: AbortSignal): Promise<void> {
		if (!DATASET_PATTERN.test(dataset) || dataset.includes("..")) {
			throw new Error("Company dataset name is invalid");
		}
		if (!SNAPSHOT_NAME_PATTERN.test(snapshotName)) {
			throw new Error("Company dataset snapshot name is invalid");
		}
		const [command, ...args] = this.#command.map((argument) =>
			argument.replaceAll("{dataset}", dataset).replaceAll("{snapshot}", snapshotName),
		);
		const result = await this.#exec(command as string, args, signal);
		if (result.code !== 0) {
			throw new Error(
				`Company dataset snapshot command failed (${result.code ?? "signal"}): ${result.stderr.slice(0, 512).trim()}`,
			);
		}
	}
}

export interface LxdCompanyComputerProviderConfig {
	adapterId: string;
	nodeKey: string;
	supabaseUrl: string;
	supabaseServiceKey: string;
	supabasePublishableKey: string;
	stateRoot: string;
	project: string;
	computerProfile: string;
	networkInterface: string;
	imageServer: string;
	imageFingerprint: string;
	storagePool: string;
	identityVolumePrefix: string;
	identityVolumeSize: string;
	rootDiskSize: string;
	cpuLimit: number;
	memoryLimit: string;
	nasDatasetRoot: string;
	nasSharedGid?: number;
	guestDatasetPath?: string;
	guestAssignmentPort: number;
	guestAssignmentSource: string;
	nativeBridgePort: number;
	nativeExecutionGid: number;
	guestReadyTimeoutMs?: number;
	runnerImage: string;
	runnerPodmanPath: string;
	runnerEntrypoint: string;
	runnerVersion: string;
	codexPath: string;
	claudePath: string;
	datasetSnapshotIntervalSeconds?: number;
	guestScreenViewerPort?: number;
	screenPollSeconds?: number;
	guestBootstrapService?: string;
	/** Seconds of zero open screens (and no live assignment) before the VM
	 * powers off; 0 keeps the machine always on. Default 300. */
	idlePowerOffSeconds?: number;
}

interface LxdCompanyComputerJournal {
	schema: typeof JOURNAL_SCHEMA;
	logicalComputerId: string;
	companyComputerId: string;
	profileId: string;
	environmentId: string;
	instanceName: string;
	nasDataset: string;
	/** The machine's compute identity as adopted from the control plane at
	 * journal creation; the runner session, when present, must agree. Lets
	 * an operator-provisioned machine reach readiness before any work has
	 * ever registered a runner. */
	machine: {
		computeIdentityId: string;
		templateKey: string;
		templateVersion: string;
		policySha256: string;
		capabilities: readonly CloudRunnerCapability[];
	};
	runner?: CloudRunnerInstance;
	physicalState: LxdCompanyComputerPhysicalState;
	guestAddress?: string;
	activeAssignment?: { assignmentId: string; runId: string; expiresAt: string };
	lastStopReason?: "delivery_failed" | "idle" | "revoked" | "maintenance";
	/** First reconcile observation of zero open screens; the idle window
	 * counts from here and any open screen clears it. */
	screensIdleSince?: string;
	lastDatasetSnapshotAt?: string;
	lastDatasetSnapshotName?: string;
	lxd: {
		project: string;
		type: "virtual-machine";
		imageServer: string;
		imageFingerprint: string;
		profiles: readonly string[];
		storagePool: string;
		identityVolume: string;
		identityVolumeSize: string;
		rootDiskSize: string;
		datasetSource: string;
		policySha256: string;
	};
	credentials: {
		activationSha256: string;
		assignmentSha256: string;
		nativeBridgeSha256: string;
		screenViewerSha256: string;
	};
	createdAt: string;
	updatedAt: string;
}

interface ProviderCredentials {
	activationToken: string;
	assignmentToken: string;
	nativeBridgeToken: string;
	screenViewerToken: string;
}

interface CompanyComputerBootstrapFile {
	path: string;
	content: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function capabilities(value: unknown, label: string): CloudRunnerCapability[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > 3 ||
		new Set(value).size !== value.length ||
		!value.every(
			(entry): entry is CloudRunnerCapability =>
				entry === "agent_turn" || entry === "git_worktree" || entry === "company_substrate",
		)
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function lifecycleState(value: unknown, label: string): LxdCompanyComputerLifecycleState {
	if (
		value !== "provisioning" &&
		value !== "active" &&
		value !== "snapshotting" &&
		value !== "migrating" &&
		value !== "recovering" &&
		value !== "retired"
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

export function parseLxdCompanyComputerAuthority(value: unknown): LxdCompanyComputerAuthority {
	const input = record(value, "Company computer authority");
	const nodeKey = input.node_key ?? undefined;
	if (
		(nodeKey !== undefined && (typeof nodeKey !== "string" || !NODE_KEY_PATTERN.test(nodeKey))) ||
		typeof input.nas_dataset !== "string" ||
		!DATASET_PATTERN.test(input.nas_dataset) ||
		input.nas_dataset.includes("..") ||
		typeof input.logical_computer_status !== "string" ||
		typeof input.template_key !== "string" ||
		!/^[a-z][a-z0-9._-]{0,119}$/.test(input.template_key) ||
		typeof input.template_version !== "string" ||
		input.template_version !== input.template_version.trim() ||
		input.template_version.length < 1 ||
		input.template_version.length > 120 ||
		typeof input.compute_policy_sha256 !== "string" ||
		!SHA256_PATTERN.test(input.compute_policy_sha256)
	) {
		throw new Error("Company computer authority is invalid");
	}
	return {
		companyComputerId: uuid(input.company_computer_id, "Company computer id"),
		profileId: uuid(input.profile_id, "Company computer profile id"),
		environmentId: uuid(input.environment_id, "Company computer environment id"),
		logicalComputerId: uuid(input.logical_computer_id, "Company computer logical computer id"),
		lifecycleState: lifecycleState(input.lifecycle_state, "Company computer lifecycle"),
		nasDataset: input.nas_dataset,
		...(nodeKey === undefined ? {} : { nodeKey }),
		logicalComputerStatus: input.logical_computer_status,
		computeIdentityId: uuid(input.compute_identity_id, "Company computer compute identity id"),
		templateKey: input.template_key,
		templateVersion: input.template_version,
		capabilities: capabilities(input.capabilities, "Company computer capabilities"),
		computePolicySha256: input.compute_policy_sha256,
	};
}

export class SupabaseLxdCompanyComputerControlPlane implements LxdCompanyComputerControlPlane {
	readonly #supabaseUrl: string;
	readonly #serviceKey: string;
	readonly #adapterId: string;
	readonly #fetch: typeof fetch;

	constructor(supabaseUrl: string, serviceKey: string, adapterId: string, fetchImplementation: typeof fetch = fetch) {
		this.#supabaseUrl = supabaseUrl;
		this.#serviceKey = serviceKey;
		this.#adapterId = adapterId;
		this.#fetch = fetchImplementation;
	}

	async describeCompanyComputer(
		logicalComputerId: string,
		signal?: AbortSignal,
	): Promise<LxdCompanyComputerAuthority> {
		return parseLxdCompanyComputerAuthority(
			await this.#rpc("qorpera_describe_company_computer", { p_logical_computer_id: logicalComputerId }, signal),
		);
	}

	async provisionRunner(
		runId: string,
		clientRunnerId: string,
		activationTokenSha256: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"qorpera_provision_execution_runner",
			{
				p_run_id: runId,
				p_client_runner_id: clientRunnerId,
				p_provider_adapter: this.#adapterId,
				p_activation_token_sha256: activationTokenSha256,
			},
			signal,
		);
	}

	async countOpenScreens(companyComputerId: string, signal?: AbortSignal): Promise<number> {
		const listing = await this.#rpc(
			"qorpera_list_company_computer_screens",
			{ p_company_computer_id: companyComputerId },
			signal,
		);
		if (!Array.isArray(listing)) throw new Error("Company computer screen listing is invalid");
		return listing.filter((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
			const screen = entry as Record<string, unknown>;
			return screen.status === "active" && (screen.power_state === undefined || screen.power_state === "open");
		}).length;
	}

	async transitionLifecycle(
		companyComputerId: string,
		state: LxdCompanyComputerLifecycleState,
		nodeKey: string | undefined,
		detail: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#rpc(
			"qorpera_company_computer_lifecycle",
			{
				p_company_computer_id: companyComputerId,
				p_state: state,
				p_node_key: nodeKey ?? null,
				p_detail: detail,
			},
			signal,
		);
	}

	async relocateDataset(
		companyComputerId: string,
		nasDataset: string,
		detail: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<LxdCompanyComputerAuthority> {
		return parseLxdCompanyComputerAuthority(
			await this.#rpc(
				"qorpera_relocate_company_computer_dataset",
				{
					p_company_computer_id: companyComputerId,
					p_nas_dataset: nasDataset,
					p_detail: detail,
				},
				signal,
			),
		);
	}

	async #rpc(name: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const headers: Record<string, string> = { apikey: this.#serviceKey, "content-type": "application/json" };
		if (this.#serviceKey.startsWith("eyJ") && this.#serviceKey.split(".").length === 3) {
			headers.authorization = `Bearer ${this.#serviceKey}`;
		}
		const response = await this.#fetch(new URL(`/rest/v1/rpc/${name}`, this.#supabaseUrl), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Company computer control plane request failed (${response.status})`);
		return response.json() as Promise<unknown>;
	}
}

function validateConfig(config: LxdCompanyComputerProviderConfig): void {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(config.adapterId)) throw new Error("Provider adapter id is invalid");
	if (!NODE_KEY_PATTERN.test(config.nodeKey)) throw new Error("Company computer node key is invalid");
	if (!isAbsolute(config.stateRoot)) throw new Error("Company computer provider state root must be absolute");
	if (
		config.idlePowerOffSeconds !== undefined &&
		(!Number.isSafeInteger(config.idlePowerOffSeconds) ||
			(config.idlePowerOffSeconds !== 0 && (config.idlePowerOffSeconds < 60 || config.idlePowerOffSeconds > 86_400)))
	) {
		throw new Error("Company computer idle power-off window is invalid");
	}
	if (!isAbsolute(config.nasDatasetRoot)) throw new Error("Company computer NAS dataset root must be absolute");
	const nasSharedGid = config.nasSharedGid ?? COMPANY_COMPUTER_NAS_SHARED_GID;
	if (!Number.isSafeInteger(nasSharedGid) || nasSharedGid < 1 || nasSharedGid > 65_535) {
		throw new Error("Company computer NAS shared group is invalid");
	}
	const guestDatasetPath = config.guestDatasetPath ?? COMPANY_COMPUTER_GUEST_DATASET_PATH;
	if (!guestDatasetPath.startsWith("/") || /[\0\r\n]/.test(guestDatasetPath) || guestDatasetPath.includes("..")) {
		throw new Error("Company computer guest dataset path is invalid");
	}
	for (const [label, value] of [
		["LXD project", config.project],
		["LXD computer profile", config.computerProfile],
		["LXD network interface", config.networkInterface],
		["LXD storage pool", config.storagePool],
	] as const) {
		if (!PROFILE_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	}
	if (
		config.imageServer !== "local" &&
		(!/^https:\/\//.test(config.imageServer) || /[\0\r\n]/.test(config.imageServer))
	) {
		throw new Error("LXD image source must be local or use HTTPS");
	}
	if (!SHA256_PATTERN.test(config.imageFingerprint)) throw new Error("LXD image fingerprint is invalid");
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(config.identityVolumePrefix)) {
		throw new Error("LXD identity-volume prefix is invalid");
	}
	if (
		!STORAGE_SIZE_PATTERN.test(config.identityVolumeSize) ||
		!STORAGE_SIZE_PATTERN.test(config.rootDiskSize) ||
		!STORAGE_SIZE_PATTERN.test(config.memoryLimit)
	) {
		throw new Error("LXD storage or memory limit is invalid");
	}
	if (!Number.isSafeInteger(config.cpuLimit) || config.cpuLimit < 1 || config.cpuLimit > 256) {
		throw new Error("LXD CPU limit is invalid");
	}
	if (
		!Number.isSafeInteger(config.guestAssignmentPort) ||
		config.guestAssignmentPort < 1024 ||
		config.guestAssignmentPort > 65_535
	) {
		throw new Error("LXD guest assignment port is invalid");
	}
	if (isIP(config.guestAssignmentSource) !== 4) {
		throw new Error("LXD guest assignment source must be an IPv4 address");
	}
	if (
		!Number.isSafeInteger(config.nativeBridgePort) ||
		config.nativeBridgePort < 1024 ||
		config.nativeBridgePort > 65_535 ||
		config.nativeBridgePort === config.guestAssignmentPort
	) {
		throw new Error("LXD native bridge port is invalid");
	}
	if (!Number.isSafeInteger(config.nativeExecutionGid) || config.nativeExecutionGid < 1) {
		throw new Error("LXD native execution group is invalid");
	}
	const readyTimeout = config.guestReadyTimeoutMs ?? 300_000;
	if (!Number.isSafeInteger(readyTimeout) || readyTimeout < 1_000 || readyTimeout > 900_000) {
		throw new Error("LXD guest readiness timeout is invalid");
	}
	const snapshotInterval = config.datasetSnapshotIntervalSeconds ?? COMPANY_COMPUTER_DATASET_SNAPSHOT_INTERVAL_SECONDS;
	if (
		!Number.isSafeInteger(snapshotInterval) ||
		(snapshotInterval !== 0 && (snapshotInterval < 900 || snapshotInterval > 7 * 24 * 60 * 60))
	) {
		throw new Error("Company computer dataset snapshot interval is invalid");
	}
	const screenViewerPort = config.guestScreenViewerPort ?? COMPANY_COMPUTER_SCREEN_VIEWER_PORT;
	if (
		!Number.isSafeInteger(screenViewerPort) ||
		screenViewerPort < 1_024 ||
		screenViewerPort > 65_535 ||
		screenViewerPort === config.guestAssignmentPort ||
		screenViewerPort === config.nativeBridgePort
	) {
		throw new Error("Company computer screen viewer port is invalid");
	}
	const screenPollSeconds = config.screenPollSeconds ?? 30;
	if (!Number.isSafeInteger(screenPollSeconds) || screenPollSeconds < 5 || screenPollSeconds > 3_600) {
		throw new Error("Company computer screen poll interval is invalid");
	}
	if (
		!config.supabaseUrl.trim() ||
		!config.supabaseServiceKey.trim() ||
		!config.supabasePublishableKey.trim() ||
		!/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(config.runnerImage) ||
		!config.runnerPodmanPath.startsWith("/") ||
		!config.runnerEntrypoint.startsWith("/") ||
		!config.codexPath.startsWith("/") ||
		!config.claudePath.startsWith("/") ||
		!config.runnerVersion.trim() ||
		/[\0\r\n]/.test(config.runnerVersion)
	) {
		throw new Error("Company computer guest runner configuration is invalid");
	}
	const service = config.guestBootstrapService ?? "qorpera-company-computer-bootstrap.service";
	if (!/^[A-Za-z0-9@_.-]+\.service$/.test(service)) throw new Error("Company computer bootstrap service is invalid");
}

function ensureCompanyComputerWork(work: CloudRunnerWork): asserts work is CloudRunnerWork & {
	logicalComputerId: string;
	computeIdentityId: string;
	computeTemplateKey: string;
	computeTemplateVersion: string;
	computePolicySha256: string;
} {
	validateCloudRunnerWork(work);
	if (work.workerClass !== "company_computer") {
		throw new Error("The company-computer provider only admits company_computer work");
	}
	if (
		!work.logicalComputerId ||
		!work.computeIdentityId ||
		!work.computeTemplateKey ||
		!work.computeTemplateVersion ||
		!work.computePolicySha256
	) {
		throw new Error("Company computer work is missing immutable compute authority");
	}
}

function runnerFromJson(value: unknown, expected: LxdCompanyComputerAuthority, adapterId: string): CloudRunnerInstance {
	const input = record(value, "Provisioned company computer runner");
	if (
		input.runner_kind !== "qorpera_computer" ||
		input.provider_adapter !== adapterId ||
		input.status === "revoked" ||
		input.worker_class !== "company_computer" ||
		input.logical_computer_id !== expected.logicalComputerId ||
		input.compute_identity_id !== expected.computeIdentityId ||
		input.template_key !== expected.templateKey ||
		input.template_version !== expected.templateVersion ||
		input.compute_policy_sha256 !== expected.computePolicySha256 ||
		!Array.isArray(input.capabilities)
	) {
		throw new Error("Provisioned runner does not match the company computer authority");
	}
	return {
		runnerId: uuid(input.runner_id, "Provisioned runner id"),
		logicalComputerId: expected.logicalComputerId,
		computeIdentityId: expected.computeIdentityId,
		workerClass: "company_computer",
		providerAdapter: adapterId,
		capabilities: capabilities(input.capabilities, "Provisioned runner capabilities"),
		templateKey: expected.templateKey,
		templateVersion: expected.templateVersion,
		policySha256: expected.computePolicySha256,
	};
}

function runnerFromJournal(value: unknown): CloudRunnerInstance {
	const input = record(value, "Company computer journal runner");
	if (
		typeof input.runnerId !== "string" ||
		!UUID_PATTERN.test(input.runnerId) ||
		typeof input.logicalComputerId !== "string" ||
		!UUID_PATTERN.test(input.logicalComputerId) ||
		typeof input.computeIdentityId !== "string" ||
		!UUID_PATTERN.test(input.computeIdentityId) ||
		input.workerClass !== "company_computer" ||
		typeof input.providerAdapter !== "string" ||
		typeof input.templateKey !== "string" ||
		typeof input.templateVersion !== "string" ||
		typeof input.policySha256 !== "string" ||
		!SHA256_PATTERN.test(input.policySha256)
	) {
		throw new Error("Company computer journal runner is invalid");
	}
	return {
		runnerId: input.runnerId,
		logicalComputerId: input.logicalComputerId,
		computeIdentityId: input.computeIdentityId,
		workerClass: "company_computer",
		providerAdapter: input.providerAdapter,
		capabilities: capabilities(input.capabilities, "Company computer journal capabilities"),
		templateKey: input.templateKey,
		templateVersion: input.templateVersion,
		policySha256: input.policySha256,
	};
}

function physicalState(value: unknown): LxdCompanyComputerPhysicalState {
	if (value !== "creating" && value !== "starting" && value !== "ready" && value !== "stopped" && value !== "lost") {
		throw new Error("Company computer journal physical state is invalid");
	}
	return value;
}

function journalFromJson(value: unknown): LxdCompanyComputerJournal {
	const input = record(value, "Company computer journal");
	const machine = record(input.machine, "Company computer journal machine identity");
	const lxd = record(input.lxd, "Company computer journal identity");
	const credentials = record(input.credentials, "Company computer journal credentials");
	const assignment =
		input.activeAssignment === undefined
			? undefined
			: record(input.activeAssignment, "Company computer journal assignment");
	if (
		input.schema !== JOURNAL_SCHEMA ||
		typeof input.instanceName !== "string" ||
		!/^[a-z][a-z0-9-]{0,62}$/.test(input.instanceName) ||
		typeof input.nasDataset !== "string" ||
		!DATASET_PATTERN.test(input.nasDataset) ||
		(input.guestAddress !== undefined && typeof input.guestAddress !== "string") ||
		(input.lastStopReason !== undefined &&
			input.lastStopReason !== "delivery_failed" &&
			input.lastStopReason !== "idle" &&
			input.lastStopReason !== "revoked" &&
			input.lastStopReason !== "maintenance") ||
		(input.screensIdleSince !== undefined &&
			(typeof input.screensIdleSince !== "string" || !Number.isFinite(Date.parse(input.screensIdleSince)))) ||
		(input.lastDatasetSnapshotAt !== undefined &&
			(typeof input.lastDatasetSnapshotAt !== "string" ||
				!Number.isFinite(Date.parse(input.lastDatasetSnapshotAt)))) ||
		(input.lastDatasetSnapshotName !== undefined &&
			(typeof input.lastDatasetSnapshotName !== "string" ||
				!SNAPSHOT_NAME_PATTERN.test(input.lastDatasetSnapshotName))) ||
		(input.lastDatasetSnapshotAt === undefined) !== (input.lastDatasetSnapshotName === undefined) ||
		(assignment !== undefined &&
			(typeof assignment.expiresAt !== "string" || !Number.isFinite(Date.parse(assignment.expiresAt)))) ||
		typeof machine.templateKey !== "string" ||
		typeof machine.templateVersion !== "string" ||
		typeof machine.policySha256 !== "string" ||
		!SHA256_PATTERN.test(machine.policySha256) ||
		!Array.isArray(machine.capabilities) ||
		!machine.capabilities.every((capability) => typeof capability === "string") ||
		lxd.type !== "virtual-machine" ||
		typeof lxd.project !== "string" ||
		typeof lxd.imageServer !== "string" ||
		typeof lxd.imageFingerprint !== "string" ||
		!SHA256_PATTERN.test(lxd.imageFingerprint) ||
		!Array.isArray(lxd.profiles) ||
		!lxd.profiles.every((profile) => typeof profile === "string") ||
		typeof lxd.storagePool !== "string" ||
		typeof lxd.identityVolume !== "string" ||
		typeof lxd.identityVolumeSize !== "string" ||
		!STORAGE_SIZE_PATTERN.test(lxd.identityVolumeSize) ||
		typeof lxd.rootDiskSize !== "string" ||
		typeof lxd.datasetSource !== "string" ||
		!isAbsolute(lxd.datasetSource) ||
		typeof lxd.policySha256 !== "string" ||
		!SHA256_PATTERN.test(lxd.policySha256) ||
		typeof credentials.activationSha256 !== "string" ||
		!SHA256_PATTERN.test(credentials.activationSha256) ||
		typeof credentials.assignmentSha256 !== "string" ||
		!SHA256_PATTERN.test(credentials.assignmentSha256) ||
		typeof credentials.nativeBridgeSha256 !== "string" ||
		!SHA256_PATTERN.test(credentials.nativeBridgeSha256) ||
		typeof credentials.screenViewerSha256 !== "string" ||
		!SHA256_PATTERN.test(credentials.screenViewerSha256) ||
		typeof input.createdAt !== "string" ||
		!Number.isFinite(Date.parse(input.createdAt)) ||
		typeof input.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(input.updatedAt))
	) {
		throw new Error("Company computer journal is invalid");
	}
	return {
		schema: JOURNAL_SCHEMA,
		logicalComputerId: uuid(input.logicalComputerId, "Company computer journal logical computer id"),
		companyComputerId: uuid(input.companyComputerId, "Company computer journal registry id"),
		profileId: uuid(input.profileId, "Company computer journal profile id"),
		environmentId: uuid(input.environmentId, "Company computer journal environment id"),
		instanceName: input.instanceName,
		nasDataset: input.nasDataset,
		machine: {
			computeIdentityId: uuid(machine.computeIdentityId, "Company computer journal compute identity"),
			templateKey: machine.templateKey,
			templateVersion: machine.templateVersion,
			policySha256: machine.policySha256,
			capabilities: machine.capabilities as CloudRunnerCapability[],
		},
		...(input.runner === undefined ? {} : { runner: runnerFromJournal(input.runner) }),
		physicalState: physicalState(input.physicalState),
		...(typeof input.guestAddress === "string" ? { guestAddress: input.guestAddress } : {}),
		...(assignment === undefined
			? {}
			: {
					activeAssignment: {
						assignmentId: uuid(assignment.assignmentId, "Company computer journal assignment id"),
						runId: uuid(assignment.runId, "Company computer journal assignment run id"),
						expiresAt: new Date(assignment.expiresAt as string).toISOString(),
					},
				}),
		...(input.lastStopReason === "delivery_failed" ||
		input.lastStopReason === "idle" ||
		input.lastStopReason === "revoked" ||
		input.lastStopReason === "maintenance"
			? { lastStopReason: input.lastStopReason }
			: {}),
		...(typeof input.screensIdleSince === "string"
			? { screensIdleSince: new Date(input.screensIdleSince).toISOString() }
			: {}),
		...(typeof input.lastDatasetSnapshotAt === "string" && typeof input.lastDatasetSnapshotName === "string"
			? {
					lastDatasetSnapshotAt: new Date(input.lastDatasetSnapshotAt).toISOString(),
					lastDatasetSnapshotName: input.lastDatasetSnapshotName,
				}
			: {}),
		lxd: {
			project: lxd.project,
			type: "virtual-machine",
			imageServer: lxd.imageServer,
			imageFingerprint: lxd.imageFingerprint,
			profiles: lxd.profiles,
			storagePool: lxd.storagePool,
			identityVolume: lxd.identityVolume,
			identityVolumeSize: lxd.identityVolumeSize,
			rootDiskSize: lxd.rootDiskSize,
			datasetSource: lxd.datasetSource,
			policySha256: lxd.policySha256,
		},
		credentials: {
			activationSha256: credentials.activationSha256,
			assignmentSha256: credentials.assignmentSha256,
			nativeBridgeSha256: credentials.nativeBridgeSha256,
			screenViewerSha256: credentials.screenViewerSha256,
		},
		createdAt: new Date(input.createdAt).toISOString(),
		updatedAt: new Date(input.updatedAt).toISOString(),
	};
}

/** Persistent company-computer lane beside the Step 2 ephemeral provider.
 *
 * One long-lived LXD virtual machine per company environment, journaled by
 * logical computer rather than by acquisition: every run targeted at the
 * computer reuses the same standing guest and the same durable runner
 * registration (the client runner id IS the logical computer id, so the
 * control plane's idempotent provisioning returns one runner row forever).
 * The machine's working storage is the per-company NAS dataset mounted
 * through a pinned disk device; the VM root stays disposable, so recovery
 * and migration are share reattachment plus control-plane lifecycle
 * transitions, never provider-side data movement. */
export class LxdCompanyComputerProviderBackend implements CloudRunnerProviderServiceBackend {
	readonly adapterId: string;
	readonly #config: LxdCompanyComputerProviderConfig;
	readonly #lxd: LxdPersistentInstanceClient;
	readonly #controlPlane: LxdCompanyComputerControlPlane;
	readonly #guest: LxdGuestTransport;
	readonly #datasetSnapshots?: CompanyDatasetSnapshotClient;
	readonly #datasetSourceVerifier: CompanyDatasetSourceVerifier;
	#serial: Promise<void> = Promise.resolve();

	constructor(
		config: LxdCompanyComputerProviderConfig,
		lxd: LxdPersistentInstanceClient,
		controlPlane?: LxdCompanyComputerControlPlane,
		guest: LxdGuestTransport = new HttpLxdGuestTransport(lxd),
		datasetSnapshots?: CompanyDatasetSnapshotClient,
		datasetSourceVerifier: CompanyDatasetSourceVerifier = new LinuxNfsCompanyDatasetSourceVerifier(),
	) {
		validateConfig(config);
		this.adapterId = config.adapterId;
		this.#config = {
			...config,
			stateRoot: resolve(config.stateRoot),
			nasDatasetRoot: resolve(config.nasDatasetRoot),
		};
		this.#lxd = lxd;
		this.#controlPlane =
			controlPlane ??
			new SupabaseLxdCompanyComputerControlPlane(config.supabaseUrl, config.supabaseServiceKey, config.adapterId);
		this.#guest = guest;
		if (datasetSnapshots) this.#datasetSnapshots = datasetSnapshots;
		this.#datasetSourceVerifier = datasetSourceVerifier;
	}

	async reconcile(signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			await mkdir(this.#computersRoot(), { recursive: true, mode: 0o700 });
			await chmod(this.#computersRoot(), 0o700);
			for (const entry of await readdir(this.#computersRoot(), { withFileTypes: true })) {
				if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
				let current = await this.#readJournal(entry.name);
				if (!current || current.physicalState === "lost") continue;
				current = await this.#reconcileDatasetSnapshot(current, signal);
				await this.#reconcilePower(current, signal);
			}
		});
	}

	async #reconcileDatasetSnapshot(
		current: LxdCompanyComputerJournal,
		signal?: AbortSignal,
	): Promise<LxdCompanyComputerJournal> {
		const interval =
			this.#config.datasetSnapshotIntervalSeconds ?? COMPANY_COMPUTER_DATASET_SNAPSHOT_INTERVAL_SECONDS;
		if (!this.#datasetSnapshots || interval === 0) return current;
		const previous = Date.parse(current.lastDatasetSnapshotAt ?? current.createdAt);
		if (Date.now() - previous < interval * 1_000) return current;
		const authority = await this.#controlPlane.describeCompanyComputer(current.logicalComputerId, signal);
		this.#assertJournalAuthority(current, authority);
		if (authority.lifecycleState !== "active") return current;
		const snapshotName = this.#snapshotName("qorpera-data");
		await this.#controlPlane.transitionLifecycle(
			authority.companyComputerId,
			"snapshotting",
			undefined,
			{ snapshot: snapshotName, reason: "scheduled_rollback" },
			signal,
		);
		let datasetCaptured = false;
		try {
			await this.#datasetSnapshots.snapshotDataset(current.nasDataset, snapshotName, signal);
			datasetCaptured = true;
			const next = {
				...current,
				lastDatasetSnapshotAt: new Date().toISOString(),
				lastDatasetSnapshotName: snapshotName,
			};
			await this.#writeJournal(next);
			return next;
		} finally {
			await this.#controlPlane.transitionLifecycle(
				authority.companyComputerId,
				"active",
				undefined,
				{ snapshot: snapshotName, dataset_captured: datasetCaptured, reason: "scheduled_rollback" },
				signal,
			);
		}
	}

	/** The machine's power follows its screens (founder model 2026-08-26):
	 * agents and members power their own screens, never the machine — it runs
	 * while any screen is open or a task assignment is live, and powers off
	 * after the idle window once none are. A screen opening while the machine
	 * sleeps powers it back on; a maintenance stop stays down until the
	 * operator returns. Power is a node-local physical fact recorded in the
	 * journal — placement lifecycle in the control plane is untouched, and
	 * the screen open/close events already carry the audit trail. */
	async #reconcilePower(current: LxdCompanyComputerJournal, signal?: AbortSignal): Promise<void> {
		const idleSeconds = this.#config.idlePowerOffSeconds ?? COMPANY_COMPUTER_IDLE_POWER_OFF_SECONDS;
		if (current.physicalState === "stopped") {
			if (current.lastStopReason !== "idle") return;
			if ((await this.#controlPlane.countOpenScreens(current.companyComputerId, signal)) > 0) {
				await this.#ensureReady({ ...current, physicalState: "starting" }, signal);
			}
			return;
		}
		if (idleSeconds === 0) {
			/* Power management disabled: the classic persistent contract —
			 * reconcile restarts anything that should be ready. */
			await this.#ensureReady(current, signal);
			return;
		}
		const openScreens = await this.#controlPlane.countOpenScreens(current.companyComputerId, signal);
		const assignmentLive =
			current.activeAssignment !== undefined && Date.parse(current.activeAssignment.expiresAt) > Date.now();
		if (openScreens > 0 || assignmentLive) {
			if (current.screensIdleSince !== undefined) {
				const next = { ...current };
				delete next.screensIdleSince;
				await this.#writeJournal(next);
				await this.#ensureReady(next, signal);
				return;
			}
			await this.#ensureReady(current, signal);
			return;
		}
		if (current.screensIdleSince === undefined) {
			const next = { ...current, screensIdleSince: new Date().toISOString() };
			await this.#writeJournal(next);
			await this.#ensureReady(next, signal);
			return;
		}
		if (Date.now() - Date.parse(current.screensIdleSince) < idleSeconds * 1_000) {
			await this.#ensureReady(current, signal);
			return;
		}
		const instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
		if (instance && instance.status !== "Stopped") {
			await this.#lxd.setInstancePower(current.lxd.project, current.instanceName, "stop", signal);
		}
		const next = { ...current, physicalState: "stopped" as const, lastStopReason: "idle" as const };
		delete next.activeAssignment;
		delete next.screensIdleSince;
		await this.#writeJournal(next);
	}

	/** Operator provisioning: create and start the standing machine from the
	 * control plane's placement without any work acquisition — the first
	 * machine is proven by watching it, not by executing turns. Idempotent:
	 * an existing journal re-ensures readiness instead. No runner session is
	 * registered, so the machine carries screens and the viewer, and
	 * the runner lane stays dormant until work first arrives via acquire. */
	async provisionComputer(logicalComputerId: string, signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			const authority = await this.#controlPlane.describeCompanyComputer(logicalComputerId, signal);
			if (authority.nodeKey !== undefined && authority.nodeKey !== this.#config.nodeKey) {
				throw new Error("Company computer is placed on another node");
			}
			if (authority.lifecycleState !== "provisioning" && authority.lifecycleState !== "active") {
				throw new Error(`Company computer is ${authority.lifecycleState} and cannot be provisioned`);
			}
			const credentials = await this.#credentials(authority.logicalComputerId);
			let current = await this.#readJournal(authority.logicalComputerId);
			if (current) {
				this.#assertJournalAuthority(current, authority);
				this.#validateCredentialHashes(current, credentials);
			} else {
				const now = new Date().toISOString();
				current = {
					schema: JOURNAL_SCHEMA,
					logicalComputerId: authority.logicalComputerId,
					companyComputerId: authority.companyComputerId,
					profileId: authority.profileId,
					environmentId: authority.environmentId,
					instanceName: this.#instanceName(authority.logicalComputerId),
					nasDataset: authority.nasDataset,
					machine: {
						computeIdentityId: authority.computeIdentityId,
						templateKey: authority.templateKey,
						templateVersion: authority.templateVersion,
						policySha256: authority.computePolicySha256,
						capabilities: authority.capabilities,
					},
					physicalState: "creating",
					lxd: {
						project: this.#config.project,
						type: "virtual-machine",
						imageServer: this.#config.imageServer,
						imageFingerprint: this.#config.imageFingerprint,
						profiles: [this.#config.computerProfile],
						storagePool: this.#config.storagePool,
						identityVolume: `${this.#config.identityVolumePrefix}${authority.computeIdentityId}`,
						identityVolumeSize: this.#config.identityVolumeSize,
						rootDiskSize: this.#config.rootDiskSize,
						datasetSource: this.#datasetSource(authority.nasDataset),
						policySha256: authority.computePolicySha256,
					},
					credentials: {
						activationSha256: sha256(credentials.activationToken),
						assignmentSha256: sha256(credentials.assignmentToken),
						nativeBridgeSha256: sha256(credentials.nativeBridgeToken),
						screenViewerSha256: sha256(credentials.screenViewerToken),
					},
					createdAt: now,
					updatedAt: now,
				};
				await this.#writeJournal(current);
			}
			await this.#ensureReady(current, signal, credentials);
			if (authority.lifecycleState === "provisioning") {
				await this.#controlPlane.transitionLifecycle(
					authority.companyComputerId,
					"active",
					this.#config.nodeKey,
					{ reason: "operator_provision" },
					signal,
				);
			}
		});
	}

	async acquire(acquisitionId: string, work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		return this.#exclusive(async () => {
			ensureCompanyComputerWork(work);
			if (acquisitionId !== work.runId) throw new Error("Provider acquisition must use the immutable run id");
			const authority = await this.#controlPlane.describeCompanyComputer(work.logicalComputerId, signal);
			this.#assertWorkAuthority(work, authority);
			if (authority.nodeKey !== undefined && authority.nodeKey !== this.#config.nodeKey) {
				throw new Error("Company computer is placed on another node");
			}
			if (
				authority.lifecycleState !== "provisioning" &&
				authority.lifecycleState !== "active" &&
				authority.lifecycleState !== "snapshotting"
			) {
				throw new Error(`Company computer is ${authority.lifecycleState} and cannot accept work`);
			}
			const credentials = await this.#credentials(authority.logicalComputerId);
			let current = await this.#readJournal(authority.logicalComputerId);
			if (current) {
				this.#assertJournalAuthority(current, authority);
				this.#validateCredentialHashes(current, credentials);
			} else {
				const now = new Date().toISOString();
				current = {
					schema: JOURNAL_SCHEMA,
					logicalComputerId: authority.logicalComputerId,
					companyComputerId: authority.companyComputerId,
					profileId: authority.profileId,
					environmentId: authority.environmentId,
					instanceName: this.#instanceName(authority.logicalComputerId),
					nasDataset: authority.nasDataset,
					machine: {
						computeIdentityId: authority.computeIdentityId,
						templateKey: authority.templateKey,
						templateVersion: authority.templateVersion,
						policySha256: authority.computePolicySha256,
						capabilities: authority.capabilities,
					},
					physicalState: "creating",
					lxd: {
						project: this.#config.project,
						type: "virtual-machine",
						imageServer: this.#config.imageServer,
						imageFingerprint: this.#config.imageFingerprint,
						profiles: [this.#config.computerProfile],
						storagePool: this.#config.storagePool,
						identityVolume: `${this.#config.identityVolumePrefix}${authority.computeIdentityId}`,
						identityVolumeSize: this.#config.identityVolumeSize,
						rootDiskSize: this.#config.rootDiskSize,
						datasetSource: this.#datasetSource(authority.nasDataset),
						policySha256: authority.computePolicySha256,
					},
					credentials: {
						activationSha256: sha256(credentials.activationToken),
						assignmentSha256: sha256(credentials.assignmentToken),
						nativeBridgeSha256: sha256(credentials.nativeBridgeToken),
						screenViewerSha256: sha256(credentials.screenViewerToken),
					},
					createdAt: now,
					updatedAt: now,
				};
				await this.#writeJournal(current);
			}
			/* Unlike the ephemeral lane there is no per-run acquisition binding:
			 * re-dispatch of a run re-ensures the standing machine and returns
			 * the standing runner, which removes the one-acquisition-per-run
			 * poisoning the Step 2 postmortem recorded. */
			const runner = runnerFromJson(
				await this.#controlPlane.provisionRunner(
					work.runId,
					authority.logicalComputerId,
					sha256(credentials.activationToken),
					signal,
				),
				authority,
				this.adapterId,
			);
			if (current.runner && current.runner.runnerId !== runner.runnerId) {
				throw new Error("Company computer runner registration drifted from its durable journal");
			}
			current = { ...current, runner };
			await this.#writeJournal(current);
			current = await this.#ensureReady(current, signal, credentials);
			if (authority.lifecycleState === "provisioning") {
				await this.#controlPlane.transitionLifecycle(
					authority.companyComputerId,
					"active",
					this.#config.nodeKey,
					{ reason: "first_acquire", run_id: work.runId },
					signal,
				);
			}
			return runner;
		});
	}

	async deliver(
		runner: CloudRunnerInstance,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#exclusive(async () => {
			if (!delivery.work.logicalComputerId) throw new Error("Company computer delivery names no computer");
			const current = await this.#readJournal(delivery.work.logicalComputerId);
			if (
				!current ||
				!current.runner ||
				current.runner.runnerId !== runner.runnerId ||
				current.runner.runnerId !== delivery.assignment.runnerId ||
				(current.physicalState !== "ready" && current.physicalState !== "starting")
			) {
				throw new Error("Company computer is unavailable for this assignment");
			}
			if (
				current.activeAssignment &&
				current.activeAssignment.assignmentId !== delivery.assignment.assignmentId &&
				Date.parse(current.activeAssignment.expiresAt) > Date.now()
			) {
				throw new Error("Company computer is fenced to another live assignment");
			}
			const credentials = await this.#credentials(current.logicalComputerId);
			this.#validateCredentialHashes(current, credentials);
			const address = current.guestAddress ?? (await this.#readyAddress(current, signal));
			await this.#guest.deliver(
				address,
				this.#config.guestAssignmentPort,
				credentials.assignmentToken,
				delivery,
				signal,
			);
			await this.#writeJournal({
				...current,
				physicalState: "ready",
				guestAddress: address,
				activeAssignment: {
					assignmentId: delivery.assignment.assignmentId,
					runId: delivery.assignment.runId,
					expiresAt: delivery.assignment.expiresAt,
				},
			});
		});
	}

	/** A shared company machine never powers off because one run went wrong:
	 * delivery failures and idleness only clear the assignment fence, and a
	 * revocation is enforced by the control plane denying every future
	 * capability while sealed capsules leave no credential residue on the
	 * dataset to protect by force. */
	async stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void> {
		void signal;
		await this.#exclusive(async () => {
			const current = await this.#findJournalByRunner(runner.runnerId);
			if (!current) return;
			const next = { ...current, lastStopReason: reason };
			delete next.activeAssignment;
			await this.#writeJournal(next);
		});
	}

	/** Deliberate power-off for node maintenance; lifecycle transitions such
	 * as migrating or recovering are recorded by the caller against the
	 * control plane, which is the placement authority. */
	async stopComputer(logicalComputerId: string, signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			const current = await this.#readJournal(logicalComputerId);
			if (!current || current.physicalState === "stopped" || current.physicalState === "lost") return;
			const instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
			if (instance && instance.status !== "Stopped") {
				await this.#lxd.setInstancePower(current.lxd.project, current.instanceName, "stop", signal);
			}
			const next = { ...current, physicalState: "stopped" as const, lastStopReason: "maintenance" as const };
			delete next.activeAssignment;
			await this.#writeJournal(next);
		});
	}

	async startComputer(logicalComputerId: string, signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			const current = await this.#readJournal(logicalComputerId);
			if (!current) throw new Error("Company computer has no durable journal on this node");
			await this.#ensureReady({ ...current, physicalState: "starting" }, signal);
		});
	}

	/** Rebinds a stopped Company Computer to another directory under the
	 * configured NAS root. The disposable VM root is deleted and recreated
	 * from the currently signed image; the Compute Identity volume is never
	 * deleted or replaced. If the operation is interrupted, lifecycle remains
	 * `recovering` and `recoverComputer` safely resumes it. */
	async relocateComputerDataset(logicalComputerId: string, nasDataset: string, signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			if (!DATASET_PATTERN.test(nasDataset) || nasDataset.includes("..")) {
				throw new Error("Company computer dataset name is invalid");
			}
			const current = await this.#readJournal(logicalComputerId);
			if (!current) throw new Error("Company computer has no durable journal on this node");
			const authority = await this.#controlPlane.describeCompanyComputer(logicalComputerId, signal);
			this.#assertRelocationJournalAuthority(current, authority);
			if (authority.lifecycleState !== "active") {
				throw new Error(`Company computer is ${authority.lifecycleState} and cannot relocate its dataset`);
			}
			if (nasDataset === authority.nasDataset) return;
			if (
				(current.activeAssignment && Date.parse(current.activeAssignment.expiresAt) > Date.now()) ||
				(await this.#controlPlane.countOpenScreens(current.companyComputerId, signal)) > 0
			) {
				throw new Error("Company computer dataset relocation requires no live assignment or open screen");
			}
			await this.#verifyDatasetSource(this.#datasetSource(nasDataset));
			const relocated = await this.#controlPlane.relocateDataset(
				authority.companyComputerId,
				nasDataset,
				{ reason: "adopt_existing_company_root", from: authority.nasDataset },
				signal,
			);
			await this.#recoverComputer(current, relocated, signal);
		});
	}

	async recoverComputer(logicalComputerId: string, signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			const current = await this.#readJournal(logicalComputerId);
			if (!current) throw new Error("Company computer has no durable journal on this node");
			const authority = await this.#controlPlane.describeCompanyComputer(logicalComputerId, signal);
			await this.#recoverComputer(current, authority, signal);
		});
	}

	async #recoverComputer(
		current: LxdCompanyComputerJournal,
		authority: LxdCompanyComputerAuthority,
		signal?: AbortSignal,
	): Promise<void> {
		this.#assertRecoveryJournalAuthority(current, authority);
		if (authority.lifecycleState !== "recovering") {
			throw new Error(`Company computer is ${authority.lifecycleState} and cannot be recovered`);
		}
		const datasetSource = this.#datasetSource(authority.nasDataset);
		/* Verify before touching the disposable root. A missing NAS mount must
		 * never turn recovery into a VM backed by a same-named local directory. */
		await this.#verifyDatasetSource(datasetSource);
		const instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
		const replacementAlreadyRecorded =
			current.nasDataset === authority.nasDataset &&
			current.lxd.datasetSource === datasetSource &&
			current.lxd.imageServer === this.#config.imageServer &&
			current.lxd.imageFingerprint === this.#config.imageFingerprint &&
			JSON.stringify(current.lxd.profiles) === JSON.stringify([this.#config.computerProfile]) &&
			current.lxd.rootDiskSize === this.#config.rootDiskSize;
		if (replacementAlreadyRecorded) {
			/* A final control-plane transition may have failed after the new VM was
			 * already ready. Resume that replacement instead of deleting it again. */
			const resumed = { ...current };
			delete resumed.activeAssignment;
			delete resumed.screensIdleSince;
			delete resumed.lastStopReason;
			if (!instance) {
				resumed.physicalState = "creating";
				delete resumed.guestAddress;
			}
			await this.#writeJournal(resumed);
			await this.#ensureReady(resumed, signal);
			await this.#activateRecoveredComputer(authority, current.lxd.identityVolume, signal);
			return;
		}
		if (instance && instance.status !== "Stopped") {
			await this.#lxd.setInstancePower(current.lxd.project, current.instanceName, "stop", signal);
		}
		if (instance) await this.#lxd.deleteInstance(current.lxd.project, current.instanceName, signal);
		const next: LxdCompanyComputerJournal = {
			...current,
			nasDataset: authority.nasDataset,
			physicalState: "creating",
			lxd: {
				...current.lxd,
				imageServer: this.#config.imageServer,
				imageFingerprint: this.#config.imageFingerprint,
				profiles: [this.#config.computerProfile],
				rootDiskSize: this.#config.rootDiskSize,
				datasetSource,
			},
		};
		delete next.guestAddress;
		delete next.activeAssignment;
		delete next.screensIdleSince;
		delete next.lastStopReason;
		if (current.nasDataset !== authority.nasDataset) {
			delete next.lastDatasetSnapshotAt;
			delete next.lastDatasetSnapshotName;
		}
		await this.#writeJournal(next);
		await this.#ensureReady(next, signal);
		await this.#activateRecoveredComputer(authority, current.lxd.identityVolume, signal);
	}

	async #activateRecoveredComputer(
		authority: LxdCompanyComputerAuthority,
		identityVolume: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#controlPlane.transitionLifecycle(
			authority.companyComputerId,
			"active",
			this.#config.nodeKey,
			{
				reason: "recovered_from_signed_image",
				dataset: authority.nasDataset,
				image_fingerprint: this.#config.imageFingerprint,
				identity_volume: identityVolume,
			},
			signal,
		);
	}

	/** Coordinated rollback point: inside the control-plane snapshotting
	 * window, capture the NAS dataset that holds the entire mutable working
	 * world. The disposable VM root is deliberately omitted; recovery always
	 * recreates it from signed image provenance. */
	async snapshotComputer(logicalComputerId: string, signal?: AbortSignal): Promise<string> {
		return this.#exclusive(async () => {
			const current = await this.#readJournal(logicalComputerId);
			if (!current) throw new Error("Company computer has no durable journal on this node");
			if (!this.#datasetSnapshots) {
				throw new Error("Company computer dataset snapshot tooling is not configured");
			}
			const authority = await this.#controlPlane.describeCompanyComputer(logicalComputerId, signal);
			this.#assertJournalAuthority(current, authority);
			const snapshotName = this.#snapshotName("qorpera-cc");
			await this.#controlPlane.transitionLifecycle(
				authority.companyComputerId,
				"snapshotting",
				undefined,
				{ snapshot: snapshotName },
				signal,
			);
			let datasetCaptured = false;
			try {
				/* Dataset first: if the working world cannot be captured, fail
				 * before producing a root snapshot that would pose as one. */
				await this.#datasetSnapshots.snapshotDataset(current.nasDataset, snapshotName, signal);
				datasetCaptured = true;
				await this.#writeJournal({
					...current,
					lastDatasetSnapshotAt: new Date().toISOString(),
					lastDatasetSnapshotName: snapshotName,
				});
			} finally {
				await this.#controlPlane.transitionLifecycle(
					authority.companyComputerId,
					"active",
					undefined,
					{ snapshot: snapshotName, dataset_captured: datasetCaptured },
					signal,
				);
			}
			return snapshotName;
		});
	}

	/** Attachment target for the host-side screen viewer gateway: where the
	 * guest's viewer listener lives and the per-computer viewer token that
	 * opens it. Same-process trusted consumer only — the token never leaves
	 * the provider host. */
	async screenViewerTarget(
		logicalComputerId: string,
	): Promise<{ guestAddress: string; viewerPort: number; viewerToken: string }> {
		return this.#exclusive(async () => {
			const current = await this.#readJournal(logicalComputerId);
			if (!current || current.physicalState !== "ready" || !current.guestAddress) {
				throw new Error("Company computer guest is not ready for screen viewing");
			}
			const credentials = await this.#credentials(logicalComputerId);
			this.#validateCredentialHashes(current, credentials);
			return {
				guestAddress: current.guestAddress,
				viewerPort: this.#config.guestScreenViewerPort ?? COMPANY_COMPUTER_SCREEN_VIEWER_PORT,
				viewerToken: credentials.screenViewerToken,
			};
		});
	}

	#assertWorkAuthority(
		work: CloudRunnerWork & { logicalComputerId: string; computeIdentityId: string },
		authority: LxdCompanyComputerAuthority,
	): void {
		if (
			authority.logicalComputerId !== work.logicalComputerId ||
			authority.profileId !== work.profileId ||
			authority.environmentId !== work.environmentId ||
			authority.computeIdentityId !== work.computeIdentityId ||
			authority.templateKey !== work.computeTemplateKey ||
			authority.templateVersion !== work.computeTemplateVersion ||
			authority.computePolicySha256 !== work.computePolicySha256 ||
			!authority.capabilities.includes(work.requiredCapability) ||
			authority.logicalComputerStatus !== "active"
		) {
			throw new Error("Company computer work does not match the registry authority");
		}
	}

	#assertJournalAuthority(journal: LxdCompanyComputerJournal, authority: LxdCompanyComputerAuthority): void {
		if (
			journal.logicalComputerId !== authority.logicalComputerId ||
			journal.companyComputerId !== authority.companyComputerId ||
			journal.profileId !== authority.profileId ||
			journal.environmentId !== authority.environmentId ||
			journal.nasDataset !== authority.nasDataset ||
			journal.lxd.datasetSource !== this.#datasetSource(authority.nasDataset) ||
			journal.lxd.policySha256 !== authority.computePolicySha256
		) {
			throw new Error("Company computer journal drifted from the registry authority");
		}
	}

	#assertRecoveryJournalAuthority(journal: LxdCompanyComputerJournal, authority: LxdCompanyComputerAuthority): void {
		if (
			journal.logicalComputerId !== authority.logicalComputerId ||
			journal.companyComputerId !== authority.companyComputerId ||
			journal.profileId !== authority.profileId ||
			journal.environmentId !== authority.environmentId ||
			journal.machine.computeIdentityId !== authority.computeIdentityId ||
			journal.machine.templateKey !== authority.templateKey ||
			journal.machine.templateVersion !== authority.templateVersion ||
			journal.machine.policySha256 !== authority.computePolicySha256 ||
			authority.nodeKey !== this.#config.nodeKey
		) {
			throw new Error("Company computer recovery authority does not match this node's durable identity");
		}
	}

	#assertRelocationJournalAuthority(journal: LxdCompanyComputerJournal, authority: LxdCompanyComputerAuthority): void {
		this.#assertRecoveryJournalAuthority(journal, authority);
		if (journal.nasDataset !== authority.nasDataset || journal.lxd.policySha256 !== authority.computePolicySha256) {
			throw new Error("Company computer relocation authority does not match its current dataset");
		}
	}

	async #ensureReady(
		current: LxdCompanyComputerJournal,
		signal?: AbortSignal,
		credentials?: ProviderCredentials,
	): Promise<LxdCompanyComputerJournal> {
		const resolvedCredentials = credentials ?? (await this.#credentials(current.logicalComputerId));
		this.#validateCredentialHashes(current, resolvedCredentials);
		await this.#verifyDatasetSource(current.lxd.datasetSource);
		await this.#ensureIdentityVolume(current, current.machine.computeIdentityId, signal);
		let instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
		if (!instance) {
			if (current.physicalState === "ready" || current.physicalState === "stopped") {
				const lost = { ...current, physicalState: "lost" as const };
				await this.#writeJournal(lost);
				throw new Error("Company computer guest is missing; recovery is a control-plane lifecycle decision");
			}
			await this.#lxd.createInstance(current.lxd.project, this.#createRequest(current), signal);
			instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
			if (!instance) throw new Error("LXD did not persist the company computer guest");
		}
		this.#assertInstanceAuthority(current, instance);
		if (instance.status !== "Running") {
			current = { ...current, physicalState: "starting" };
			await this.#writeJournal(current);
			await this.#lxd.setInstancePower(current.lxd.project, current.instanceName, "start", signal);
		}
		await this.#installBootstrap(current, resolvedCredentials, signal);
		const address = await this.#readyAddress(current, signal);
		current = { ...current, physicalState: "ready", guestAddress: address };
		await this.#writeJournal(current);
		return current;
	}

	async #readyAddress(current: LxdCompanyComputerJournal, signal?: AbortSignal): Promise<string> {
		return this.#guest.waitReady(
			current.lxd.project,
			current.instanceName,
			this.#config.networkInterface,
			this.#config.guestAssignmentPort,
			this.#config.guestReadyTimeoutMs ?? 300_000,
			signal,
		);
	}

	#datasetSource(nasDataset: string): string {
		if (!DATASET_PATTERN.test(nasDataset) || nasDataset.includes("..")) {
			throw new Error("Company computer dataset name is invalid");
		}
		const source = resolve(this.#config.nasDatasetRoot, ...nasDataset.split("/"));
		if (source !== this.#config.nasDatasetRoot && !source.startsWith(`${this.#config.nasDatasetRoot}/`)) {
			throw new Error("Company computer dataset escapes the NAS dataset root");
		}
		return source;
	}

	async #verifyDatasetSource(datasetSource: string): Promise<void> {
		await this.#datasetSourceVerifier.verifyDatasetSource(this.#config.nasDatasetRoot, datasetSource);
	}

	#createRequest(current: LxdCompanyComputerJournal): LxdCreateInstanceRequest {
		return {
			name: current.instanceName,
			type: "virtual-machine" as const,
			profiles: current.lxd.profiles,
			config: {
				"boot.mode": "uefi-secureboot",
				"limits.cpu": String(this.#config.cpuLimit),
				"limits.memory": this.#config.memoryLimit,
				"user.qorpera.company_computer_id": current.companyComputerId,
				"user.qorpera.logical_computer_id": current.logicalComputerId,
				"user.qorpera.environment_id": current.environmentId,
				"user.qorpera.compute_policy_sha256": current.lxd.policySha256,
			},
			devices: {
				root: {
					type: "disk",
					path: "/",
					pool: current.lxd.storagePool,
					size: current.lxd.rootDiskSize,
				},
				"compute-identity": {
					type: "disk",
					path: "/var/lib/qorpera/identity",
					pool: current.lxd.storagePool,
					source: current.lxd.identityVolume,
				},
				/* The working world: the per-company NAS dataset, mounted from
				 * the host's NAS mount into the guest. Reattaching this device
				 * on another node IS the migration. */
				"company-dataset": {
					type: "disk",
					path: this.#guestDatasetPath(),
					source: current.lxd.datasetSource,
				},
			},
			source:
				current.lxd.imageServer === "local"
					? { type: "image" as const, fingerprint: current.lxd.imageFingerprint }
					: {
							type: "image" as const,
							mode: "pull" as const,
							protocol: "simplestreams" as const,
							server: current.lxd.imageServer,
							fingerprint: current.lxd.imageFingerprint,
						},
		};
	}

	#guestDatasetPath(): string {
		return this.#config.guestDatasetPath ?? COMPANY_COMPUTER_GUEST_DATASET_PATH;
	}

	#bootstrapFiles(
		journal: LxdCompanyComputerJournal,
		credentials: ProviderCredentials,
	): CompanyComputerBootstrapFile[] {
		const datasetPath = this.#guestDatasetPath();
		/* Before any work has registered a runner session, the runner config
		 * carries the logical computer id as its runner id: the guest runner
		 * service cannot activate without a registered session either way,
		 * and the first real acquire rewrites these files with the session's
		 * id. Screens and the viewer never depend on it. */
		const runnerId = journal.runner ? (journal.runner.runnerId as string) : journal.logicalComputerId;
		const liveCompanyRoot = `${datasetPath}/${COMPANY_COMPUTER_DATASET_LAYOUT.liveDirectory}`;
		const stateRoot = `${datasetPath}/${COMPANY_COMPUTER_DATASET_LAYOUT.stateDirectory}`;
		const runnerConfig = JSON.stringify(
			{
				schema: "qorpera.company-computer-service/v2",
				base_url: this.#config.supabaseUrl,
				publishable_key: this.#config.supabasePublishableKey,
				runner_id: runnerId,
				authority_state_path: "/var/lib/qorpera-runner/.local/state/qorpera-runner/authority.json",
				temporary_root: `${stateRoot}/runner`,
				image: this.#config.runnerImage,
				podman_path: this.#config.runnerPodmanPath,
				entrypoint: this.#config.runnerEntrypoint,
				capabilities: [...journal.machine.capabilities],
				platform: "linux-x64",
				runner_version: this.#config.runnerVersion,
				native_bridge_url: `http://127.0.0.1:${this.#config.nativeBridgePort}/`,
				native_bridge_boundary: "virtual_machine",
				native_bridge_shared_gid: this.#config.nativeExecutionGid,
				assignment_host: "0.0.0.0",
				assignment_port: this.#config.guestAssignmentPort,
				assignment_trusted_source: this.#config.guestAssignmentSource,
				max_assignments: 1,
				environment: {
					QORPERA_LIVE_COMPANY_ROOT: liveCompanyRoot,
					QORPERA_LIVE_COMPANY_PROFILE_ID: journal.profileId,
				},
			},
			null,
			2,
		);
		const bootstrap = JSON.stringify(
			{
				schema: BOOTSTRAP_SCHEMA,
				company_computer_id: journal.companyComputerId,
				logical_computer_id: journal.logicalComputerId,
				profile_id: journal.profileId,
				environment_id: journal.environmentId,
				compute_identity_id: journal.machine.computeIdentityId,
				compute_template_key: journal.machine.templateKey,
				compute_template_version: journal.machine.templateVersion,
				compute_policy_sha256: journal.machine.policySha256,
				dataset_path: datasetPath,
				nas_shared_gid: this.#config.nasSharedGid ?? COMPANY_COMPUTER_NAS_SHARED_GID,
				dataset_layout: COMPANY_COMPUTER_DATASET_LAYOUT,
				screens: {
					viewer_host: "0.0.0.0",
					viewer_port: this.#config.guestScreenViewerPort ?? COMPANY_COMPUTER_SCREEN_VIEWER_PORT,
					viewer_trusted_source: this.#config.guestAssignmentSource,
					poll_seconds: this.#config.screenPollSeconds ?? 30,
				},
				runner_config_path: "/var/lib/qorpera-bootstrap/runner-config.json",
				native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
				credential_source: "/var/lib/qorpera-bootstrap/credentials",
				identity_volume_path: "/var/lib/qorpera/identity",
			},
			null,
			2,
		);
		/* Sealed capsules keep delivering per-staff credentials through the
		 * same native-host boundary as the ephemeral lane; nothing here parks
		 * a provider credential on the shared dataset. */
		const nativeProviderEnvironment = [
			`QORPERA_SUPABASE_URL=${this.#config.supabaseUrl}`,
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${journal.machine.computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=127.0.0.1",
			`QORPERA_NATIVE_PROVIDER_PORT=${this.#config.nativeBridgePort}`,
			"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=/var/lib/qorpera-native-provider/tmp",
			`QORPERA_CODEX_PATH=${this.#config.codexPath}`,
			`QORPERA_CLAUDE_PATH=${this.#config.claudePath}`,
			"",
		].join("\n");
		return [
			{ path: "/var/lib/qorpera-bootstrap/company-computer.json", content: `${bootstrap}\n` },
			{ path: "/var/lib/qorpera-bootstrap/runner-config.json", content: `${runnerConfig}\n` },
			{ path: "/var/lib/qorpera-bootstrap/native-provider.env", content: nativeProviderEnvironment },
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-runner-activation",
				content: `${credentials.activationToken}\n`,
			},
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-runner-assignment",
				content: `${credentials.assignmentToken}\n`,
			},
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-native-bridge",
				content: `${credentials.nativeBridgeToken}\n`,
			},
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-screen-viewer",
				content: `${credentials.screenViewerToken}\n`,
			},
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-supabase-service-key",
				content: `${this.#config.supabaseServiceKey}\n`,
			},
		];
	}

	async #installBootstrap(
		journal: LxdCompanyComputerJournal,
		credentials: ProviderCredentials,
		signal?: AbortSignal,
	): Promise<void> {
		const files = this.#bootstrapFiles(journal, credentials);
		await this.#waitForGuestAgent(journal, signal);
		for (const file of files) {
			await this.#lxd.pushInstanceFile(
				journal.lxd.project,
				journal.instanceName,
				file.path,
				file.content,
				0o600,
				signal,
			);
		}
		await this.#lxd.execInstance(
			journal.lxd.project,
			journal.instanceName,
			[
				"/usr/bin/systemctl",
				"enable",
				"--now",
				this.#config.guestBootstrapService ?? "qorpera-company-computer-bootstrap.service",
			],
			signal,
		);
	}

	async #waitForGuestAgent(journal: LxdCompanyComputerJournal, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + (this.#config.guestReadyTimeoutMs ?? 300_000);
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason;
			try {
				await this.#lxd.execInstance(
					journal.lxd.project,
					journal.instanceName,
					["/usr/bin/test", "-d", "/var/lib/qorpera-bootstrap/credentials"],
					signal,
				);
				return;
			} catch (error) {
				lastError = error;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		throw new Error("Company computer guest agent did not become ready for private bootstrap injection", {
			cause: lastError,
		});
	}

	#assertInstanceAuthority(journal: LxdCompanyComputerJournal, instance: LxdInstanceRecord): void {
		const root = instance.devices.root;
		const identity = instance.devices["compute-identity"];
		const dataset = instance.devices["company-dataset"];
		if (
			instance.name !== journal.instanceName ||
			instance.type !== "virtual-machine" ||
			JSON.stringify(instance.profiles) !== JSON.stringify(journal.lxd.profiles) ||
			instance.config["boot.mode"] !== "uefi-secureboot" ||
			instance.config["cloud-init.user-data"] !== undefined ||
			instance.config["user.qorpera.company_computer_id"] !== journal.companyComputerId ||
			instance.config["user.qorpera.logical_computer_id"] !== journal.logicalComputerId ||
			instance.config["user.qorpera.environment_id"] !== journal.environmentId ||
			instance.config["user.qorpera.compute_policy_sha256"] !== journal.lxd.policySha256 ||
			root?.type !== "disk" ||
			root.path !== "/" ||
			root.pool !== journal.lxd.storagePool ||
			root.size !== journal.lxd.rootDiskSize ||
			identity?.type !== "disk" ||
			identity.path !== "/var/lib/qorpera/identity" ||
			identity.pool !== journal.lxd.storagePool ||
			identity.source !== journal.lxd.identityVolume ||
			dataset?.type !== "disk" ||
			dataset.path !== this.#guestDatasetPath() ||
			dataset.source !== journal.lxd.datasetSource
		) {
			throw new Error("Company computer guest drifted from immutable provider authority");
		}
	}

	async #ensureIdentityVolume(
		journal: LxdCompanyComputerJournal,
		computeIdentityId: string,
		signal?: AbortSignal,
	): Promise<void> {
		let volume = await this.#lxd.getStorageVolume(
			journal.lxd.project,
			journal.lxd.storagePool,
			journal.lxd.identityVolume,
			signal,
		);
		if (!volume) {
			await this.#lxd.createStorageVolume(
				journal.lxd.project,
				journal.lxd.storagePool,
				{
					name: journal.lxd.identityVolume,
					type: "custom",
					content_type: "filesystem",
					description: `Qorpera Compute Identity ${computeIdentityId}`,
					config: {
						size: journal.lxd.identityVolumeSize,
						"user.qorpera.schema": IDENTITY_VOLUME_SCHEMA,
						"user.qorpera.compute_identity_id": computeIdentityId,
						"user.qorpera.provider_adapter": this.adapterId,
					},
				},
				signal,
			);
			volume = await this.#lxd.getStorageVolume(
				journal.lxd.project,
				journal.lxd.storagePool,
				journal.lxd.identityVolume,
				signal,
			);
		}
		if (!volume) throw new Error("LXD did not persist the Compute Identity volume");
		if (
			volume.name !== journal.lxd.identityVolume ||
			volume.type !== "custom" ||
			volume.contentType !== "filesystem" ||
			volume.config.size !== journal.lxd.identityVolumeSize ||
			volume.config["user.qorpera.schema"] !== IDENTITY_VOLUME_SCHEMA ||
			volume.config["user.qorpera.compute_identity_id"] !== computeIdentityId ||
			volume.config["user.qorpera.provider_adapter"] !== this.adapterId
		) {
			throw new Error("LXD Compute Identity volume drifted from immutable provider authority");
		}
	}

	async #credentials(logicalComputerId: string): Promise<ProviderCredentials> {
		const root = join(this.#computersRoot(), logicalComputerId, "credentials");
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		return {
			activationToken: await this.#privateToken(join(root, "qorpera-runner-activation")),
			assignmentToken: await this.#privateToken(join(root, "qorpera-runner-assignment")),
			nativeBridgeToken: await this.#privateToken(join(root, "qorpera-native-bridge")),
			screenViewerToken: await this.#privateToken(join(root, "qorpera-screen-viewer")),
		};
	}

	async #privateToken(path: string): Promise<string> {
		try {
			const existing = (await readFile(path, "utf-8")).trim();
			if (!TOKEN_PATTERN.test(existing)) throw new Error("Stored company computer credential is invalid");
			return existing;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			const value = randomBytes(32).toString("base64url");
			await writeFile(path, `${value}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
			return value;
		}
	}

	#validateCredentialHashes(journal: LxdCompanyComputerJournal, credentials: ProviderCredentials): void {
		if (
			sha256(credentials.activationToken) !== journal.credentials.activationSha256 ||
			sha256(credentials.assignmentToken) !== journal.credentials.assignmentSha256 ||
			sha256(credentials.nativeBridgeToken) !== journal.credentials.nativeBridgeSha256 ||
			sha256(credentials.screenViewerToken) !== journal.credentials.screenViewerSha256
		) {
			throw new Error("Company computer credentials do not match their durable journal");
		}
	}

	async #readJournal(logicalComputerId: string): Promise<LxdCompanyComputerJournal | undefined> {
		try {
			return journalFromJson(JSON.parse(await readFile(this.#journalPath(logicalComputerId), "utf-8")) as unknown);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async #writeJournal(journal: LxdCompanyComputerJournal): Promise<void> {
		const root = join(this.#computersRoot(), journal.logicalComputerId);
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		const updated: LxdCompanyComputerJournal = { ...journal, updatedAt: new Date().toISOString() };
		const path = this.#journalPath(journal.logicalComputerId);
		const temporary = join(root, `.journal-${process.pid}-${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
		await chmod(path, 0o600);
	}

	async #findJournalByRunner(runnerId: string): Promise<LxdCompanyComputerJournal | undefined> {
		await mkdir(this.#computersRoot(), { recursive: true, mode: 0o700 });
		for (const entry of await readdir(this.#computersRoot(), { withFileTypes: true })) {
			if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
			const journal = await this.#readJournal(entry.name);
			if (journal?.runner?.runnerId === runnerId) return journal;
		}
		return undefined;
	}

	#computersRoot(): string {
		return join(this.#config.stateRoot, "computers");
	}

	#journalPath(logicalComputerId: string): string {
		return join(this.#computersRoot(), logicalComputerId, "journal.json");
	}

	#instanceName(logicalComputerId: string): string {
		return `qorpera-cc-${logicalComputerId.replaceAll("-", "")}`;
	}

	#snapshotName(prefix: "qorpera-cc" | "qorpera-data"): string {
		return `${prefix}-${new Date()
			.toISOString()
			.replaceAll(/[:.]/g, "-")
			.replaceAll(/[TZ]/g, "-")
			.replaceAll(/-+$/g, "")
			.toLowerCase()}`;
	}

	async #exclusive<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.#serial;
		let release = (): void => undefined;
		this.#serial = new Promise<void>((resolveWait) => {
			release = resolveWait;
		});
		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}
}
