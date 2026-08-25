import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import type { LxdCreateInstanceRequest, LxdInstanceRecord, LxdInstanceSnapshotClient } from "./lxd-client.ts";
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
const BOOTSTRAP_SCHEMA = "qorpera.company-computer-bootstrap/v1";
const IDENTITY_VOLUME_SCHEMA = "qorpera.compute-identity-volume/v1";

/** Dataset layout carried by the per-company NAS dataset. The dataset, not
 * the VM disk, is the machine's working world: the standing Company File
 * checkout, the shared workbench every staff agent sees, browser profiles,
 * and the machine-local sync/state directory that must migrate with the
 * share. */
export const COMPANY_COMPUTER_DATASET_LAYOUT = {
	companyDirectory: "company",
	workbenchDirectory: "workbench",
	profilesDirectory: "profiles",
	stateDirectory: ".qorpera-computer",
} as const;

export const COMPANY_COMPUTER_GUEST_DATASET_PATH = "/srv/qorpera/dataset";

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
}

/** Captures the working world: a point-in-time snapshot of the per-company
 * NAS dataset, taken inside the control-plane snapshotting window. The
 * stateless LXD snapshot beside it covers only the disposable VM root. */
export interface CompanyDatasetSnapshotClient {
	snapshotDataset(dataset: string, snapshotName: string, signal?: AbortSignal): Promise<void>;
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
	syncPollSeconds?: number;
	guestBootstrapService?: string;
}

interface LxdCompanyComputerJournal {
	schema: typeof JOURNAL_SCHEMA;
	logicalComputerId: string;
	companyComputerId: string;
	profileId: string;
	environmentId: string;
	instanceName: string;
	nasDataset: string;
	runner?: CloudRunnerInstance;
	physicalState: LxdCompanyComputerPhysicalState;
	guestAddress?: string;
	activeAssignment?: { assignmentId: string; runId: string; expiresAt: string };
	lastStopReason?: "delivery_failed" | "idle" | "revoked" | "maintenance";
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
	};
	createdAt: string;
	updatedAt: string;
}

interface ProviderCredentials {
	activationToken: string;
	assignmentToken: string;
	nativeBridgeToken: string;
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
	if (!isAbsolute(config.nasDatasetRoot)) throw new Error("Company computer NAS dataset root must be absolute");
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
	const syncPollSeconds = config.syncPollSeconds ?? 30;
	if (!Number.isSafeInteger(syncPollSeconds) || syncPollSeconds < 5 || syncPollSeconds > 3_600) {
		throw new Error("Company computer sync poll interval is invalid");
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
		(assignment !== undefined &&
			(typeof assignment.expiresAt !== "string" || !Number.isFinite(Date.parse(assignment.expiresAt)))) ||
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
	readonly #lxd: LxdInstanceSnapshotClient;
	readonly #controlPlane: LxdCompanyComputerControlPlane;
	readonly #guest: LxdGuestTransport;
	readonly #datasetSnapshots?: CompanyDatasetSnapshotClient;
	#serial: Promise<void> = Promise.resolve();

	constructor(
		config: LxdCompanyComputerProviderConfig,
		lxd: LxdInstanceSnapshotClient,
		controlPlane?: LxdCompanyComputerControlPlane,
		guest: LxdGuestTransport = new HttpLxdGuestTransport(lxd),
		datasetSnapshots?: CompanyDatasetSnapshotClient,
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
	}

	async reconcile(signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			await mkdir(this.#computersRoot(), { recursive: true, mode: 0o700 });
			await chmod(this.#computersRoot(), 0o700);
			for (const entry of await readdir(this.#computersRoot(), { withFileTypes: true })) {
				if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
				const current = await this.#readJournal(entry.name);
				if (!current || current.physicalState === "stopped" || current.physicalState === "lost") continue;
				/* Persistent machines are meant to stay up: reconcile restarts
				 * anything that should be ready, unlike the ephemeral lane where
				 * a stopped guest is terminal. */
				await this.#ensureReady(current, signal);
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

	/** Coordinated snapshot: the control-plane snapshotting window is the
	 * fence. Inside it the NAS dataset snapshot captures the working world
	 * and the stateless LXD snapshot covers the disposable VM root; the
	 * closing lifecycle event records whether the dataset was captured so a
	 * deployment without storage tooling never presents a root-only snapshot
	 * as a recovery point. */
	async snapshotComputer(logicalComputerId: string, signal?: AbortSignal): Promise<string> {
		return this.#exclusive(async () => {
			const current = await this.#readJournal(logicalComputerId);
			if (!current) throw new Error("Company computer has no durable journal on this node");
			const authority = await this.#controlPlane.describeCompanyComputer(logicalComputerId, signal);
			this.#assertJournalAuthority(current, authority);
			const snapshotName = `qorpera-cc-${new Date()
				.toISOString()
				.replaceAll(/[:.]/g, "-")
				.replaceAll(/[TZ]/g, "-")
				.replaceAll(/-+$/g, "")
				.toLowerCase()}`;
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
				if (this.#datasetSnapshots) {
					await this.#datasetSnapshots.snapshotDataset(current.nasDataset, snapshotName, signal);
					datasetCaptured = true;
				}
				await this.#lxd.createInstanceSnapshot(current.lxd.project, current.instanceName, snapshotName, signal);
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

	async #ensureReady(
		current: LxdCompanyComputerJournal,
		signal?: AbortSignal,
		credentials?: ProviderCredentials,
	): Promise<LxdCompanyComputerJournal> {
		const resolvedCredentials = credentials ?? (await this.#credentials(current.logicalComputerId));
		this.#validateCredentialHashes(current, resolvedCredentials);
		if (!current.runner) throw new Error("Company computer journal has no durable runner registration");
		await this.#ensureIdentityVolume(current, current.runner.computeIdentityId as string, signal);
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
		runner: CloudRunnerInstance,
		credentials: ProviderCredentials,
	): CompanyComputerBootstrapFile[] {
		const datasetPath = this.#guestDatasetPath();
		const runnerConfig = JSON.stringify(
			{
				schema: "qorpera.company-computer-service/v1",
				base_url: this.#config.supabaseUrl,
				publishable_key: this.#config.supabasePublishableKey,
				runner_id: runner.runnerId,
				authority_state_path: "/var/lib/qorpera-runner/.local/state/qorpera-runner/authority.json",
				workbench_root: `${datasetPath}/${COMPANY_COMPUTER_DATASET_LAYOUT.workbenchDirectory}`,
				image: this.#config.runnerImage,
				podman_path: this.#config.runnerPodmanPath,
				entrypoint: this.#config.runnerEntrypoint,
				capabilities: [...runner.capabilities],
				platform: "linux-x64",
				runner_version: this.#config.runnerVersion,
				native_bridge_url: `http://127.0.0.1:${this.#config.nativeBridgePort}/`,
				native_bridge_boundary: "virtual_machine",
				native_bridge_shared_gid: this.#config.nativeExecutionGid,
				assignment_host: "0.0.0.0",
				assignment_port: this.#config.guestAssignmentPort,
				assignment_trusted_source: this.#config.guestAssignmentSource,
				max_assignments: 1,
				environment: {},
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
				compute_identity_id: runner.computeIdentityId,
				compute_template_key: runner.templateKey,
				compute_template_version: runner.templateVersion,
				compute_policy_sha256: runner.policySha256,
				dataset_path: datasetPath,
				dataset_layout: COMPANY_COMPUTER_DATASET_LAYOUT,
				sync: {
					company_root: `${datasetPath}/${COMPANY_COMPUTER_DATASET_LAYOUT.companyDirectory}`,
					state_path: `${datasetPath}/${COMPANY_COMPUTER_DATASET_LAYOUT.stateDirectory}/company-sync.json`,
					poll_seconds: this.#config.syncPollSeconds ?? 30,
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
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${runner.computeIdentityId}`,
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
		if (!journal.runner) throw new Error("Company computer journal has no durable runner registration");
		const files = this.#bootstrapFiles(journal, journal.runner, credentials);
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
			sha256(credentials.nativeBridgeToken) !== journal.credentials.nativeBridgeSha256
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
