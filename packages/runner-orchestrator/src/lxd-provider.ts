import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseCompanyComputerNativeUrl } from "@qorpera/contracts";
import type { ServiceHttpFetch } from "./http-transport.ts";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdStorageVolumeRecord,
} from "./lxd-client.ts";
import { type LxdNativeCompanyRuntimeConfig, validateLxdNativeCompanyRuntime } from "./lxd-company-runtime.ts";
import { lxdNativeNodePolicy } from "./lxd-native-node-policy.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "./orchestrator.ts";
import { validateCloudRunnerWork } from "./orchestrator.ts";
import type { CloudRunnerProviderServiceBackend } from "./provider-service.ts";
import { reserveRuntimeNodeMachine } from "./runtime-node-admission.ts";
import { readRuntimeNodeHost } from "./runtime-node-host.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const STORAGE_SIZE_PATTERN = /^[1-9][0-9]*(?:KiB|MiB|GiB|TiB)$/;
const JOURNAL_SCHEMA = "qorpera.lxd-provider-journal/v2";
const COMPANY_JOURNAL_SCHEMA = "qorpera.lxd-company-provider-journal/v1";
const BOOTSTRAP_SCHEMA = "qorpera.lxd-runner-bootstrap/v1";
const IDENTITY_VOLUME_SCHEMA = "qorpera.compute-identity-volume/v1";
const RECOVERY_VOLUME_SCHEMA = "qorpera.native-company-recovery-volume/v1";

export type LxdProviderPhysicalState =
	| "reserving"
	| "creating"
	| "starting"
	| "bootstrapping"
	| "registered"
	| "assigned"
	| "stopping"
	| "stopped"
	| "lost";

export interface LxdCloudRunnerProviderConfig {
	adapterId: string;
	supabaseUrl: string;
	supabaseServiceKey: string;
	supabasePublishableKey: string;
	stateRoot: string;
	project: string;
	jobProfile: string;
	networkInterface: string;
	imageServer: string;
	imageFingerprint: string;
	storagePool: string;
	identityVolumePrefix: string;
	identityVolumeSize: string;
	rootDiskSize: string;
	cpuLimit: number;
	memoryLimit: string;
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
	guestBootstrapService?: string;
	/** Host path of the company's one live tree (a NAS mount). When present
	 * and healthy it is passed into ordinary turn runner VMs as a read/write
	 * disk, and the guest works on it directly instead of copying the company
	 * file in and out per turn. Proposal reviews remain copy-isolated. */
	liveCompanyRoot?: string;
	/** Profile the live tree belongs to; the guest refuses the mount for any
	 * other profile's job. Required together with liveCompanyRoot. */
	liveCompanyProfileId?: string;
	/** Separate, explicitly enrolled path-authorized runtime. Never mounts the company tree. */
	nativeCompanyRuntime?: LxdNativeCompanyRuntimeConfig;
}

/** Where the live company tree appears inside a runner VM. */
export const LXD_LIVE_COMPANY_GUEST_PATH = "/qorpera/company-live";

export interface LxdGuestTransport {
	waitReady(
		project: string,
		instanceName: string,
		networkInterface: string,
		port: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<string>;
	deliver(
		address: string,
		port: number,
		assignmentToken: string,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void>;
}

interface LxdProviderJournal {
	schema: typeof JOURNAL_SCHEMA | typeof COMPANY_JOURNAL_SCHEMA;
	acquisitionId: string;
	/** Absent only in retained journals created before attempt separation. */
	runId?: string;
	attempt?: number;
	workSha256: string;
	jobType: string;
	instanceName: string;
	runner: CloudRunnerInstance;
	physicalState: LxdProviderPhysicalState;
	/** Durable proof that the exact VM deletion completed before capacity RPC cleanup. */
	deletionConfirmed?: true;
	/** Written only after the control plane confirms this physical allocation. */
	capacityRegistered?: true;
	/** Exact node binding retained after the node reservation commits. */
	nodeCapacity?: NativeNodePlacement;
	guestAddress?: string;
	assignmentId?: string;
	stopReason?: "delivery_failed" | "idle" | "revoked";
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
		bootstrapSha256: string;
		policySha256: string;
		companyRuntime?: {
			mode: "company-path-v1";
			profileId: string;
			recoveryVolume: string;
			recoveryVolumeSize: string;
			configurationSha256: string;
			office?: { environmentId: string; url: string; tokenSha256: string };
		};
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

interface LxdGuestBootstrapAuthority {
	runId: string;
	profileId?: string;
	environmentId?: string;
	runner: CloudRunnerInstance;
	computeIdentityId: string;
	computeTemplateKey: string;
	computeTemplateVersion: string;
	computePolicySha256: string;
	jobType: string;
}

interface LxdGuestBootstrapFile {
	path: string;
	content: string;
}

interface LiveCompanyAuthority {
	root: string;
	profileId: string;
}

function liveCompanyAuthority(config: LxdCloudRunnerProviderConfig, jobType: string): LiveCompanyAuthority | undefined {
	if (jobType === "proposal_review" || !config.liveCompanyRoot || !config.liveCompanyProfileId) return undefined;
	return { root: config.liveCompanyRoot, profileId: config.liveCompanyProfileId };
}

function companyRuntimeAuthority(
	config: LxdCloudRunnerProviderConfig,
	acquisitionId: string,
	profileId?: string,
	environmentId?: string,
): LxdProviderJournal["lxd"]["companyRuntime"] {
	const runtime = config.nativeCompanyRuntime;
	if (!runtime) return undefined;
	if (!profileId || !UUID_PATTERN.test(profileId)) throw new Error("Governed runtime company authority is missing");
	const office = runtime.offices?.find(
		(route) => route.companyId === profileId && route.environmentId === environmentId,
	);
	return {
		mode: "company-path-v1",
		profileId,
		recoveryVolume: `${runtime.recoveryVolumePrefix}${acquisitionId}`,
		recoveryVolumeSize: runtime.recoveryVolumeSize,
		configurationSha256: sha256(JSON.stringify(canonical(runtime))),
		...(office
			? { office: { environmentId: office.environmentId, url: office.url, tokenSha256: sha256(office.token) } }
			: {}),
	};
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => canonical(entry));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) output[key] = canonical(entry);
	}
	return output;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function workSha256(work: CloudRunnerWork): string {
	/* The control plane annotates each dispatch with attempt-scoped fields; a
	 * retry is the same immutable run, so the journal digest must not vary
	 * with them — or every second attempt is refused as foreign work. */
	const { attempt: _attempt, ...immutable } = work as CloudRunnerWork & { attempt?: unknown };
	return sha256(JSON.stringify(canonical(immutable)));
}

function runAttemptAcquisitionId(runId: string, attempt: number): string {
	// The first attempt retains its original key and historical journals. A
	// control-plane continuation gets a new physical guest, never a replay of
	// the prior attempt's credentials, activation or retained recovery volume.
	if (attempt === 1) return runId;
	const digest = sha256(`qorpera.lxd-run-attempt/v1:${runId}:${attempt}`);
	const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function token(): string {
	return randomBytes(32).toString("base64url");
}

function bootstrapSha256(files: readonly LxdGuestBootstrapFile[]): string {
	return sha256(
		JSON.stringify(
			files.map((file) => ({ path: file.path, contentSha256: sha256(file.content), mode: "0600", uid: 0, gid: 0 })),
		),
	);
}

function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function exactRunner(value: unknown, work: CloudRunnerWork, adapterId: string): CloudRunnerInstance {
	const input = record(value, "Provisioned runner");
	if (
		input.runner_kind !== "qorpera_computer" ||
		input.provider_adapter !== adapterId ||
		input.status === "revoked" ||
		input.compute_identity_id !== work.computeIdentityId ||
		input.logical_computer_id !== (work.logicalComputerId ?? null) ||
		input.worker_class !== work.workerClass ||
		input.template_key !== work.computeTemplateKey ||
		input.template_version !== work.computeTemplateVersion ||
		input.compute_policy_sha256 !== work.computePolicySha256 ||
		!Array.isArray(input.capabilities) ||
		!input.capabilities.includes(work.requiredCapability)
	) {
		throw new Error("Provisioned runner does not match immutable compute authority");
	}
	return {
		runnerId: uuid(input.runner_id, "Provisioned runner id"),
		...(work.logicalComputerId ? { logicalComputerId: work.logicalComputerId } : {}),
		...(work.computeIdentityId ? { computeIdentityId: work.computeIdentityId } : {}),
		workerClass: work.workerClass,
		providerAdapter: adapterId,
		capabilities: input.capabilities as CloudRunnerInstance["capabilities"],
		templateKey: work.computeTemplateKey as string,
		templateVersion: work.computeTemplateVersion as string,
		policySha256: work.computePolicySha256 as string,
	};
}

function runnerFromJournal(value: unknown): CloudRunnerInstance {
	const input = record(value, "LXD provider journal runner");
	if (
		typeof input.runnerId !== "string" ||
		!UUID_PATTERN.test(input.runnerId) ||
		(input.logicalComputerId !== undefined &&
			(typeof input.logicalComputerId !== "string" || !UUID_PATTERN.test(input.logicalComputerId))) ||
		(input.computeIdentityId !== undefined &&
			(typeof input.computeIdentityId !== "string" || !UUID_PATTERN.test(input.computeIdentityId))) ||
		(input.workerClass !== "managed_sandbox" && input.workerClass !== "company_computer") ||
		typeof input.providerAdapter !== "string" ||
		!Array.isArray(input.capabilities) ||
		!input.capabilities.every(
			(capability) =>
				capability === "agent_turn" || capability === "git_worktree" || capability === "company_substrate",
		) ||
		typeof input.templateKey !== "string" ||
		typeof input.templateVersion !== "string" ||
		typeof input.policySha256 !== "string" ||
		!SHA256_PATTERN.test(input.policySha256)
	) {
		throw new Error("LXD provider journal runner is invalid");
	}
	return {
		runnerId: input.runnerId,
		...(typeof input.logicalComputerId === "string" ? { logicalComputerId: input.logicalComputerId } : {}),
		...(typeof input.computeIdentityId === "string" ? { computeIdentityId: input.computeIdentityId } : {}),
		workerClass: input.workerClass,
		providerAdapter: input.providerAdapter,
		capabilities: input.capabilities,
		templateKey: input.templateKey,
		templateVersion: input.templateVersion,
		policySha256: input.policySha256,
	};
}

function physicalState(value: unknown): LxdProviderPhysicalState {
	if (
		value !== "reserving" &&
		value !== "creating" &&
		value !== "starting" &&
		value !== "bootstrapping" &&
		value !== "registered" &&
		value !== "assigned" &&
		value !== "stopping" &&
		value !== "stopped" &&
		value !== "lost"
	) {
		throw new Error("LXD provider journal physical state is invalid");
	}
	return value;
}

interface NativeNodePlacement {
	nodeId: string;
	policySha256: string;
	machineIdSha256: string;
	cpuMillis: number;
	memoryBytes: number;
}
function nodePlacement(value: unknown): NativeNodePlacement {
	const p = record(value, "LXD node placement");
	if (
		Object.keys(p).sort().join() !== "cpuMillis,machineIdSha256,memoryBytes,nodeId,policySha256" ||
		typeof p.nodeId !== "string" ||
		!UUID_PATTERN.test(p.nodeId) ||
		typeof p.policySha256 !== "string" ||
		!SHA256_PATTERN.test(p.policySha256) ||
		typeof p.machineIdSha256 !== "string" ||
		!SHA256_PATTERN.test(p.machineIdSha256) ||
		!Number.isSafeInteger(p.cpuMillis) ||
		(p.cpuMillis as number) < 1 ||
		(p.cpuMillis as number) > 1024000 ||
		!Number.isSafeInteger(p.memoryBytes) ||
		(p.memoryBytes as number) < 1 ||
		(p.memoryBytes as number) > 1125899906842624
	)
		throw new Error("LXD node placement is invalid");
	return p as unknown as NativeNodePlacement;
}
function journalFromJson(value: unknown): LxdProviderJournal {
	const input = record(value, "LXD provider journal");
	const lxd = record(input.lxd, "LXD provider journal identity");
	const credentials = record(input.credentials, "LXD provider journal credentials");
	if (
		(input.schema !== JOURNAL_SCHEMA && input.schema !== COMPANY_JOURNAL_SCHEMA) ||
		typeof input.acquisitionId !== "string" ||
		!UUID_PATTERN.test(input.acquisitionId) ||
		typeof input.workSha256 !== "string" ||
		!SHA256_PATTERN.test(input.workSha256) ||
		typeof input.jobType !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(input.jobType) ||
		typeof input.instanceName !== "string" ||
		!NAME_PATTERN.test(input.instanceName) ||
		(input.guestAddress !== undefined && typeof input.guestAddress !== "string") ||
		(input.assignmentId !== undefined &&
			(typeof input.assignmentId !== "string" || !UUID_PATTERN.test(input.assignmentId))) ||
		(input.stopReason !== undefined &&
			input.stopReason !== "delivery_failed" &&
			input.stopReason !== "idle" &&
			input.stopReason !== "revoked") ||
		(input.deletionConfirmed !== undefined &&
			(input.deletionConfirmed !== true ||
				!["stopping", "stopped", "lost"].includes(String(input.physicalState)))) ||
		(input.capacityRegistered !== undefined && input.capacityRegistered !== true) ||
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
		typeof lxd.bootstrapSha256 !== "string" ||
		!SHA256_PATTERN.test(lxd.bootstrapSha256) ||
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
		throw new Error("LXD provider journal is invalid");
	}
	if (
		(input.runId === undefined) !== (input.attempt === undefined) ||
		(input.runId !== undefined &&
			(input.schema !== COMPANY_JOURNAL_SCHEMA ||
				typeof input.runId !== "string" ||
				!UUID_PATTERN.test(input.runId) ||
				!Number.isSafeInteger(input.attempt) ||
				(input.attempt as number) < 1 ||
				(input.attempt as number) > 1_000_000 ||
				runAttemptAcquisitionId(input.runId, input.attempt as number) !== input.acquisitionId))
	) {
		throw new Error("LXD provider journal run attempt is invalid");
	}
	let companyRuntime: LxdProviderJournal["lxd"]["companyRuntime"];
	if (input.schema === COMPANY_JOURNAL_SCHEMA) {
		const company = record(lxd.companyRuntime, "Governed runtime journal");
		if (
			Object.keys(company).sort().join() !==
				[
					"mode",
					"profileId",
					"recoveryVolume",
					"recoveryVolumeSize",
					"configurationSha256",
					...(company.office !== undefined ? ["office"] : []),
				]
					.sort()
					.join() ||
			company.mode !== "company-path-v1" ||
			typeof company.profileId !== "string" ||
			!UUID_PATTERN.test(company.profileId) ||
			typeof company.recoveryVolume !== "string" ||
			!NAME_PATTERN.test(company.recoveryVolume) ||
			typeof company.recoveryVolumeSize !== "string" ||
			!STORAGE_SIZE_PATTERN.test(company.recoveryVolumeSize) ||
			typeof company.configurationSha256 !== "string" ||
			!SHA256_PATTERN.test(company.configurationSha256)
		) {
			throw new Error("Governed runtime journal is invalid");
		}
		let office: NonNullable<LxdProviderJournal["lxd"]["companyRuntime"]>["office"];
		if (company.office !== undefined) {
			const route = record(company.office, "Governed office route");
			if (
				Object.keys(route).sort().join() !== "environmentId,tokenSha256,url" ||
				typeof route.environmentId !== "string" ||
				!UUID_PATTERN.test(route.environmentId) ||
				typeof route.url !== "string" ||
				typeof route.tokenSha256 !== "string" ||
				!SHA256_PATTERN.test(route.tokenSha256)
			)
				throw new Error("Governed office route is invalid");
			office = {
				environmentId: route.environmentId,
				url: parseCompanyComputerNativeUrl(route.url).url,
				tokenSha256: route.tokenSha256,
			};
		}
		companyRuntime = {
			mode: "company-path-v1",
			profileId: company.profileId,
			recoveryVolume: company.recoveryVolume,
			recoveryVolumeSize: company.recoveryVolumeSize,
			configurationSha256: company.configurationSha256,
			...(office ? { office } : {}),
		};
	} else if (lxd.companyRuntime !== undefined) {
		throw new Error("Legacy journal cannot carry governed runtime authority");
	}
	return {
		schema: input.schema,
		acquisitionId: input.acquisitionId,
		...(typeof input.runId === "string" ? { runId: input.runId, attempt: input.attempt as number } : {}),
		workSha256: input.workSha256,
		jobType: input.jobType,
		instanceName: input.instanceName,
		runner: runnerFromJournal(input.runner),
		physicalState: physicalState(input.physicalState),
		...(input.deletionConfirmed === true ? { deletionConfirmed: true } : {}),
		...(input.capacityRegistered === true ? { capacityRegistered: true } : {}),
		...(input.nodeCapacity !== undefined ? { nodeCapacity: nodePlacement(input.nodeCapacity) } : {}),
		...(typeof input.guestAddress === "string" ? { guestAddress: input.guestAddress } : {}),
		...(typeof input.assignmentId === "string" ? { assignmentId: input.assignmentId } : {}),
		...(input.stopReason === "delivery_failed" || input.stopReason === "idle" || input.stopReason === "revoked"
			? { stopReason: input.stopReason }
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
			bootstrapSha256: lxd.bootstrapSha256,
			policySha256: lxd.policySha256,
			...(companyRuntime ? { companyRuntime } : {}),
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

function validateConfig(config: LxdCloudRunnerProviderConfig): void {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(config.adapterId)) throw new Error("Provider adapter id is invalid");
	if (!isAbsolute(config.stateRoot)) throw new Error("LXD provider state root must be absolute");
	for (const [label, value] of [
		["LXD project", config.project],
		["LXD job profile", config.jobProfile],
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
		throw new Error("LXD guest runner configuration is invalid");
	}
	const service = config.guestBootstrapService ?? "qorpera-lxd-runner-bootstrap.service";
	if (!/^[A-Za-z0-9@_.-]+\.service$/.test(service)) throw new Error("LXD guest bootstrap service is invalid");
	if (
		(config.liveCompanyRoot === undefined) !== (config.liveCompanyProfileId === undefined) ||
		(config.liveCompanyRoot !== undefined &&
			(!isAbsolute(config.liveCompanyRoot) || /[\0\r\n]/.test(config.liveCompanyRoot))) ||
		(config.liveCompanyProfileId !== undefined && !UUID_PATTERN.test(config.liveCompanyProfileId))
	) {
		throw new Error("Live Company File root and profile must be configured together");
	}
	if (config.nativeCompanyRuntime) {
		validateLxdNativeCompanyRuntime(config.nativeCompanyRuntime);
		let authority: URL;
		try {
			authority = new URL(config.supabaseUrl);
		} catch {
			throw new Error("Governed native runtime requires an exact HTTPS control-plane origin");
		}
		if (
			authority.protocol !== "https:" ||
			authority.username ||
			authority.password ||
			authority.search ||
			authority.hash ||
			authority.pathname !== "/" ||
			![authority.origin, `${authority.origin}/`].includes(config.supabaseUrl)
		)
			throw new Error("Governed native runtime requires an exact HTTPS control-plane origin");
		if (config.liveCompanyRoot !== undefined || config.liveCompanyProfileId !== undefined) {
			throw new Error("Governed native runtime cannot mount a live Company File");
		}
		if (
			service !== "qorpera-lxd-runner-bootstrap.service" ||
			config.nativeCompanyRuntime.recoveryVolumePrefix === config.identityVolumePrefix ||
			config.nativeCompanyRuntime.objectGatewayToken === config.supabaseServiceKey ||
			config.nativeCompanyRuntime.offices?.some((office) => office.token === config.supabaseServiceKey)
		) {
			throw new Error(
				"Governed native runtime requires the pinned bootstrap and separate recovery and credential authority",
			);
		}
	}
}

function ensureStep2Work(
	work: CloudRunnerWork,
	governedCompanyRuntime: boolean,
): asserts work is CloudRunnerWork & {
	computeIdentityId: string;
	computeTemplateKey: string;
	computeTemplateVersion: string;
	computePolicySha256: string;
} {
	validateCloudRunnerWork(work);
	if (work.workerClass === "company_computer" && !governedCompanyRuntime) {
		throw new Error("The Step 2 LXD provider admits company computers only through company-path-v1");
	}
	if (
		!work.computeIdentityId ||
		!work.computeTemplateKey ||
		!work.computeTemplateVersion ||
		!work.computePolicySha256
	) {
		throw new Error("The Step 2 LXD provider requires immutable Compute Identity authority");
	}
}

function ipv4(state: LxdInstanceStateRecord, networkInterface: string): string | undefined {
	return state.network[networkInterface]?.addresses.find(
		(address) =>
			address.family === "inet" &&
			address.scope === "global" &&
			isIP(address.address) === 4 &&
			!address.address.startsWith("169.254."),
	)?.address;
}

export class HttpLxdGuestTransport implements LxdGuestTransport {
	readonly #lxd: LxdClient;
	readonly #fetch: ServiceHttpFetch;

	constructor(lxd: LxdClient, fetchImplementation: ServiceHttpFetch = fetch) {
		this.#lxd = lxd;
		this.#fetch = fetchImplementation;
	}

	async waitReady(
		project: string,
		instanceName: string,
		networkInterface: string,
		port: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason;
			let poweredOff = false;
			try {
				const state = await this.#lxd.getInstanceState(project, instanceName, signal);
				poweredOff = state.status === "Stopped";
				const address = ipv4(state, networkInterface);
				if (state.status === "Running" && address) {
					const response = await this.#fetch(`http://${address}:${port}/healthz`, {
						redirect: "error",
						signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000),
					});
					void response.body?.cancel().catch(() => undefined);
					if (response.ok) return address;
				}
			} catch (error) {
				if (signal?.aborted) throw signal.reason;
				if (!(error instanceof Error)) throw error;
			}
			if (poweredOff) throw new Error("LXD guest powered off before activating its private assignment inbox");
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		throw new Error("LXD guest did not activate its private assignment inbox");
	}

	async deliver(
		address: string,
		port: number,
		assignmentToken: string,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void> {
		if (
			isIP(address) !== 4 ||
			!Number.isSafeInteger(port) ||
			port < 1 ||
			port > 65_535 ||
			!TOKEN_PATTERN.test(assignmentToken)
		) {
			throw new Error("LXD guest assignment destination or token is invalid");
		}
		const response = await this.#fetch(`http://${address}:${port}/v1/assignment`, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${assignmentToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				schema: "qorpera.runner-assignment-delivery/v1",
				assignment_id: delivery.assignment.assignmentId,
				job_id: delivery.assignment.jobId,
				capability: delivery.capability,
			}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});
		void response.body?.cancel().catch(() => undefined);
		if (response.status !== 200 && response.status !== 202) {
			throw new Error(`LXD guest rejected assignment delivery (${response.status})`);
		}
	}
}

export class LxdCloudRunnerProviderBackend implements CloudRunnerProviderServiceBackend {
	readonly #registeredCapacity = new Set<string>();
	readonly #registeredNodeCapacity = new Map<string, NativeNodePlacement>();
	readonly adapterId: string;
	readonly #config: LxdCloudRunnerProviderConfig;
	readonly #lxd: LxdClient;
	readonly #guest: LxdGuestTransport;
	readonly #fetch: ServiceHttpFetch;
	#serial: Promise<void> = Promise.resolve();

	constructor(
		config: LxdCloudRunnerProviderConfig,
		lxd: LxdClient,
		guest: LxdGuestTransport = new HttpLxdGuestTransport(lxd),
		fetchImplementation: ServiceHttpFetch = fetch,
	) {
		validateConfig(config);
		this.adapterId = config.adapterId;
		this.#config = {
			...config,
			stateRoot: resolve(config.stateRoot),
			...(config.nativeCompanyRuntime ? { nativeCompanyRuntime: structuredClone(config.nativeCompanyRuntime) } : {}),
		};
		this.#lxd = lxd;
		this.#guest = guest;
		this.#fetch = fetchImplementation;
	}

	async reconcile(signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			await mkdir(this.#config.stateRoot, { recursive: true, mode: 0o700 });
			await chmod(this.#config.stateRoot, 0o700);
			for (const entry of await readdir(this.#config.stateRoot, { withFileTypes: true })) {
				if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
				const current = await this.#readJournal(entry.name);
				if (!current) continue;
				await this.#reconcileJournal(current, signal);
			}
		});
	}

	async acquire(runId: string, work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		return this.#exclusive(async () => {
			await this.#assertCapacityInventory(signal);
			ensureStep2Work(work, this.#config.nativeCompanyRuntime !== undefined);
			if (
				this.#config.nativeCompanyRuntime &&
				(work.sponsor.authenticationMode !== "native_subscription" ||
					work.sponsor.provider !== "openai" ||
					work.sponsor.nativeHarness !== "codex-cli")
			) {
				throw new Error("Governed native runtime requires the pinned Codex subscription harness");
			}
			if (runId !== work.runId) throw new Error("Provider acquisition must use the immutable run id");
			const acquisitionId = this.#config.nativeCompanyRuntime
				? runAttemptAcquisitionId(work.runId, work.attempt)
				: runId;
			const digest = workSha256(work);
			let current = await this.#readJournal(acquisitionId);
			if (!current && this.#config.nativeCompanyRuntime && work.attempt > 1) {
				// A sponsor handoff is recorded before the old one-run guest finishes
				// shutting down. Keep this acquisition (and its renewed dispatch claim)
				// pending instead of exhausting infrastructure retries during shutdown.
				const retirementSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
				await mkdir(this.#config.stateRoot, { recursive: true, mode: 0o700 });
				for (const entry of await readdir(this.#config.stateRoot, { withFileTypes: true })) {
					if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name) || entry.name === acquisitionId) continue;
					let prior = await this.#readJournal(entry.name);
					if (!prior || (prior.runId ?? prior.acquisitionId) !== work.runId) continue;
					if ((prior.attempt ?? 1) >= work.attempt) throw new Error("LXD provider refuses an older run attempt");
					for (;;) {
						retirementSignal.throwIfAborted();
						await this.#reconcileJournal(prior, retirementSignal);
						const retired = await this.#readJournal(entry.name);
						if (!retired) throw new Error("LXD prior run attempt lost its journal");
						const instance = await this.#lxd.getInstance(prior.lxd.project, prior.instanceName, retirementSignal);
						retirementSignal.throwIfAborted();
						if (["stopped", "lost"].includes(retired.physicalState) && !instance) break;
						if (!instance || !["registered", "assigned"].includes(retired.physicalState)) {
							throw new Error("LXD prior run attempt has not retired its guest");
						}
						// Reconciliation validates physical and retained-volume authority on
						// every poll. Never stop a still-running prior attempt here.
						prior = retired;
						await delay(250, undefined, { signal: retirementSignal });
					}
				}
			}
			const credentials = await this.#credentials(acquisitionId);
			if (current) {
				if (current.workSha256 !== digest) {
					console.error(
						`acquire refusal: acquisition=${acquisitionId} journaled=${current.workSha256.slice(0, 12)} incoming=${digest.slice(0, 12)} state=${current.physicalState}`,
					);
					throw new Error("LXD provider acquisition id is bound to another immutable work request");
				}
				this.#validateCredentialHashes(current, credentials);
				if (
					current.physicalState === "stopping" ||
					current.physicalState === "stopped" ||
					current.physicalState === "lost"
				) {
					throw new Error(`LXD provider acquisition is ${current.physicalState} and cannot be replayed`);
				}
				current = await this.#ensureReady(current, credentials, signal);
				return current.runner;
			}

			const runner = exactRunner(
				await this.#rpc(
					"qorpera_provision_execution_runner",
					{
						p_run_id: work.runId,
						p_client_runner_id: acquisitionId,
						p_provider_adapter: this.adapterId,
						p_activation_token_sha256: sha256(credentials.activationToken),
					},
					signal,
				),
				work,
				this.adapterId,
			);
			const bootstrapFiles = this.#bootstrapFiles(
				{
					runId: work.runId,
					profileId: work.profileId,
					environmentId: work.environmentId,
					runner,
					computeIdentityId: work.computeIdentityId,
					computeTemplateKey: work.computeTemplateKey,
					computeTemplateVersion: work.computeTemplateVersion,
					computePolicySha256: work.computePolicySha256,
					jobType: work.jobType,
				},
				credentials,
			);
			const now = new Date().toISOString();
			current = {
				schema: this.#config.nativeCompanyRuntime ? COMPANY_JOURNAL_SCHEMA : JOURNAL_SCHEMA,
				acquisitionId,
				...(this.#config.nativeCompanyRuntime ? { runId: work.runId, attempt: work.attempt } : {}),
				workSha256: digest,
				jobType: work.jobType,
				instanceName: this.#instanceName(acquisitionId),
				runner,
				physicalState: "reserving",
				lxd: {
					project: this.#config.project,
					type: "virtual-machine",
					imageServer: this.#config.imageServer,
					imageFingerprint: this.#config.imageFingerprint,
					profiles: [this.#config.jobProfile],
					storagePool: this.#config.storagePool,
					identityVolume: `${this.#config.identityVolumePrefix}${work.computeIdentityId}`,
					identityVolumeSize: this.#config.identityVolumeSize,
					rootDiskSize: this.#config.rootDiskSize,
					bootstrapSha256: bootstrapSha256(bootstrapFiles),
					policySha256: work.computePolicySha256,
					...(this.#config.nativeCompanyRuntime
						? {
								companyRuntime: companyRuntimeAuthority(
									this.#config,
									acquisitionId,
									work.profileId,
									work.environmentId,
								),
							}
						: {}),
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
			current = await this.#ensureReady(current, credentials, signal);
			return current.runner;
		});
	}

	async deliver(
		runner: CloudRunnerInstance,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#exclusive(async () => {
			validateCloudRunnerWork(delivery.work);
			const acquisitionId = this.#config.nativeCompanyRuntime
				? runAttemptAcquisitionId(delivery.work.runId, delivery.work.attempt)
				: delivery.work.runId;
			const current = await this.#readJournal(acquisitionId);
			if (
				!current ||
				current.runner.runnerId !== runner.runnerId ||
				current.runner.runnerId !== delivery.assignment.runnerId ||
				current.workSha256 !== workSha256(delivery.work) ||
				(current.physicalState !== "registered" && current.physicalState !== "assigned")
			) {
				throw new Error("LXD guest is unavailable for this assignment");
			}
			if (current.assignmentId && current.assignmentId !== delivery.assignment.assignmentId) {
				throw new Error("LXD guest is already fenced to another assignment");
			}
			const credentials = await this.#credentials(current.acquisitionId);
			this.#validateCredentialHashes(current, credentials);
			if (current.lxd.companyRuntime) {
				const instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
				if (!instance || instance.status !== "Running") throw new Error("Governed native guest is unavailable");
				this.#assertInstanceAuthority(current, instance);
				await this.#ensureRecoveryVolume(current, signal);
			}
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
				physicalState: "assigned",
				guestAddress: address,
				assignmentId: delivery.assignment.assignmentId,
			});
		});
	}

	async stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void> {
		await this.#exclusive(async () => {
			const current = await this.#findJournalByRunner(runner.runnerId);
			if (!current || current.physicalState === "stopped" || current.physicalState === "lost") return;
			await this.#writeJournal({ ...current, physicalState: "stopping", stopReason: reason });
			const instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
			if (!instance) {
				if (
					current.deletionConfirmed ||
					current.physicalState === "reserving" ||
					current.physicalState === "registered" ||
					current.physicalState === "assigned"
				) {
					await this.#writeJournal({ ...current, physicalState: "stopping", deletionConfirmed: true });
					await this.#releaseMachine(current, signal);
				}
				await this.#writeJournal({ ...current, physicalState: "lost", stopReason: reason });
				return;
			}
			this.#assertInstanceAuthority(current, instance);
			await this.#retire(current, instance.status, signal);
			await this.#writeJournal({ ...current, physicalState: "stopped", stopReason: reason });
		});
	}

	/** A job guest serves exactly one run. Once it is done the guest has no further
	 * purpose: the canonical transcript and the provider session live in the cloud
	 * and on the identity host, so the guest is deleted rather than left behind.
	 * Retained custom volumes (identity, recovery) are devices and survive. */
	async #retire(current: LxdProviderJournal, status: string, signal?: AbortSignal): Promise<void> {
		if (status !== "Stopped") {
			await this.#lxd.setInstancePower(current.lxd.project, current.instanceName, "stop", signal);
		}
		await this.#lxd.deleteInstance(current.lxd.project, current.instanceName, signal);
		if (await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal)) {
			throw new Error("Machine capacity remains occupied until physical deletion is confirmed");
		}
		await this.#writeJournal({ ...current, physicalState: "stopping", deletionConfirmed: true });
		await this.#releaseMachine(current, signal);
	}

	async #retirePoweredOff(current: LxdProviderJournal, signal?: AbortSignal): Promise<void> {
		const stopReason =
			current.physicalState === "registered" || current.physicalState === "assigned" ? "idle" : "delivery_failed";
		await this.#writeJournal({ ...current, physicalState: "stopping", stopReason });
		await this.#retire(current, "Stopped", signal);
		await this.#writeJournal({ ...current, physicalState: "stopped", stopReason });
	}

	async #ensureReady(
		current: LxdProviderJournal,
		credentials: ProviderCredentials,
		signal?: AbortSignal,
	): Promise<LxdProviderJournal> {
		const computeIdentityId = current.runner.computeIdentityId;
		if (!computeIdentityId) throw new Error("Journaled LXD guest is missing Compute Identity authority");
		await this.#reserveMachine(current, signal);
		if (current.physicalState === "reserving") {
			current = { ...current, physicalState: "creating", capacityRegistered: true };
			await this.#writeJournal(current);
		}
		await this.#ensureIdentityVolume(current, computeIdentityId, signal);
		await this.#ensureRecoveryVolume(current, signal);
		let instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
		if (!instance) {
			if (current.physicalState !== "creating") {
				if (current.physicalState === "registered" || current.physicalState === "assigned")
					await this.#releaseMachine(current, signal);
				const lost = { ...current, physicalState: "lost" as const };
				await this.#writeJournal(lost);
				throw new Error("Journaled LXD guest is missing");
			}
			const bootstrapFiles = this.#bootstrapFiles(this.#bootstrapAuthority(current), credentials);
			if (bootstrapSha256(bootstrapFiles) !== current.lxd.bootstrapSha256) {
				throw new Error("LXD guest bootstrap no longer matches its durable journal");
			}
			const admitted = await this.#reserveMachine(current, signal);
			admitted.throwIfAborted();
			await this.#lxd.createInstance(current.lxd.project, this.#createRequest(current), signal, admitted);
			instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
			if (!instance) throw new Error("LXD did not persist the created guest");
		}
		this.#assertInstanceAuthority(current, instance);
		if (instance.status === "Stopped" && current.physicalState !== "creating") {
			await this.#retirePoweredOff(current, signal);
			throw new Error("LXD provider acquisition has powered off and cannot be replayed");
		}
		// A refused start has no physical intent. Keep the created, stopped VM
		// and its charged allocation retryable until a fresh admission succeeds.
		const startAdmission = instance.status === "Stopped" ? await this.#reserveMachine(current, signal) : undefined;
		let address: string;
		try {
			if (instance.status !== "Running") {
				if (instance.status !== "Stopped") throw new Error("LXD guest is unavailable for startup");
				current = { ...current, physicalState: "starting" };
				await this.#writeJournal(current);
				startAdmission!.throwIfAborted();
				await this.#lxd.setInstancePower(
					current.lxd.project,
					current.instanceName,
					"start",
					signal,
					startAdmission,
				);
			}
			if (current.physicalState === "creating" || current.physicalState === "starting") {
				await this.#prepareBootstrap(current, credentials, signal);
				// Record the one-shot activation intent before invoking systemd. After
				// a provider crash, observe readiness without starting the unit again.
				current = { ...current, physicalState: "bootstrapping" };
				await this.#writeJournal(current);
				await this.#lxd.execInstance(
					current.lxd.project,
					current.instanceName,
					[
						"/usr/bin/systemctl",
						"enable",
						"--now",
						this.#config.guestBootstrapService ?? "qorpera-lxd-runner-bootstrap.service",
					],
					signal,
				);
			}
			address = await this.#readyAddress(current, signal);
		} catch (error) {
			if (
				current.physicalState === "creating" ||
				current.physicalState === "starting" ||
				current.physicalState === "bootstrapping"
			) {
				// The caller may already have cancelled. Persist cleanup without its
				// signal so reconciliation cannot revive the failed acquisition.
				await this.#writeJournal({ ...current, physicalState: "stopping", stopReason: "delivery_failed" });
			}
			throw error;
		}
		current = {
			...current,
			physicalState: current.physicalState === "assigned" ? "assigned" : "registered",
			guestAddress: address,
		};
		await this.#writeJournal(current);
		return current;
	}

	async #readyAddress(current: LxdProviderJournal, signal?: AbortSignal): Promise<string> {
		return this.#guest.waitReady(
			current.lxd.project,
			current.instanceName,
			this.#config.networkInterface,
			this.#config.guestAssignmentPort,
			this.#config.guestReadyTimeoutMs ?? 300_000,
			signal,
		);
	}

	#createRequest(current: LxdProviderJournal): LxdCreateInstanceRequest {
		const liveCompany = liveCompanyAuthority(this.#config, current.jobType);
		const companyRuntime = current.lxd.companyRuntime;
		const placement = current.nodeCapacity ?? this.#registeredNodeCapacity.get(current.acquisitionId);
		return {
			name: current.instanceName,
			type: "virtual-machine",
			profiles: current.lxd.profiles,
			config: {
				"boot.mode": "uefi-secureboot",
				"limits.cpu": String(this.#config.cpuLimit),
				"limits.memory": this.#config.memoryLimit,
				"user.qorpera.acquisition_id": current.acquisitionId,
				...(placement
					? {
							"user.qorpera.schema": "qorpera.native-job-vm/v1",
							"user.qorpera.provider_adapter": this.adapterId,
							"user.qorpera.provider_policy_sha256": placement.policySha256,
							"user.qorpera.instance_sha256": this.#machineIdentity(current).p_instance_sha256,
						}
					: {}),
				"user.qorpera.bootstrap_sha256": current.lxd.bootstrapSha256,
				"user.qorpera.compute_policy_sha256": current.lxd.policySha256,
				"user.qorpera.runner_id": current.runner.runnerId,
				...(current.runner.logicalComputerId
					? { "user.qorpera.logical_computer_id": current.runner.logicalComputerId }
					: {}),
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
				...(companyRuntime && this.#config.nativeCompanyRuntime
					? {
							"runner-recovery": {
								type: "disk",
								path: "/var/lib/qorpera-runner",
								pool: current.lxd.storagePool,
								source: companyRuntime.recoveryVolume,
							},
							[this.#config.networkInterface]: {
								type: "nic",
								name: this.#config.networkInterface,
								network: this.#config.nativeCompanyRuntime.network,
								"security.ipv4_filtering": "true",
								"security.ipv6_filtering": "true",
								"security.mac_filtering": "true",
								"security.port_isolation": "true",
							},
						}
					: {}),
				/* No uid shifting: idmapped mounts are unreliable over NFS. The
				 * NAS export squashes every writer to one owner and the tree
				 * carries open modes, so guest uids need no translation. No
				 * fallback either: a configured live tree whose host mount is
				 * gone fails instance creation loudly (founder ruling — the
				 * copy model must not silently come back). */
				...(liveCompany
					? {
							"company-live": {
								type: "disk",
								source: liveCompany.root,
								path: LXD_LIVE_COMPANY_GUEST_PATH,
							},
						}
					: {}),
			},
			source:
				current.lxd.imageServer === "local"
					? { type: "image", fingerprint: current.lxd.imageFingerprint }
					: {
							type: "image",
							mode: "pull",
							protocol: "simplestreams",
							server: current.lxd.imageServer,
							fingerprint: current.lxd.imageFingerprint,
						},
		};
	}

	#bootstrapAuthority(journal: LxdProviderJournal): LxdGuestBootstrapAuthority {
		if (!journal.runner.computeIdentityId) {
			throw new Error("Journaled LXD guest is missing Compute Identity authority");
		}
		return {
			runId: journal.runId ?? journal.acquisitionId,
			...(journal.lxd.companyRuntime ? { profileId: journal.lxd.companyRuntime.profileId } : {}),
			...(journal.lxd.companyRuntime?.office
				? { environmentId: journal.lxd.companyRuntime.office.environmentId }
				: {}),
			runner: journal.runner,
			computeIdentityId: journal.runner.computeIdentityId,
			computeTemplateKey: journal.runner.templateKey,
			computeTemplateVersion: journal.runner.templateVersion,
			computePolicySha256: journal.runner.policySha256,
			jobType: journal.jobType,
		};
	}

	#bootstrapFiles(authority: LxdGuestBootstrapAuthority, credentials: ProviderCredentials): LxdGuestBootstrapFile[] {
		const liveCompany = liveCompanyAuthority(this.#config, authority.jobType);
		const runtime = this.#config.nativeCompanyRuntime;
		const office = runtime?.offices?.find(
			(route) => route.companyId === authority.profileId && route.environmentId === authority.environmentId,
		);
		if (office && Object.values(credentials).includes(office.token))
			throw new Error("Governed native office credential must be independent");
		if (
			runtime &&
			(runtime.objectGatewayToken === credentials.nativeBridgeToken ||
				runtime.objectGatewayToken === credentials.activationToken ||
				runtime.objectGatewayToken === credentials.assignmentToken ||
				runtime.secretBroker.runtimeToken === credentials.nativeBridgeToken ||
				runtime.secretBroker.runtimeToken === credentials.activationToken ||
				runtime.secretBroker.runtimeToken === credentials.assignmentToken)
		) {
			throw new Error("Governed native runtime credentials must be independent");
		}
		const runnerConfig = JSON.stringify(
			{
				schema: "qorpera.ephemeral-runner-service/v1",
				base_url: this.#config.supabaseUrl,
				publishable_key: this.#config.supabasePublishableKey,
				runner_id: authority.runner.runnerId,
				authority_state_path: "/var/lib/qorpera-runner/.local/state/qorpera-runner/authority.json",
				temporary_root: "/var/lib/qorpera-native-workspace",
				image: this.#config.runnerImage,
				podman_path: this.#config.runnerPodmanPath,
				entrypoint: this.#config.runnerEntrypoint,
				capabilities: [...authority.runner.capabilities],
				job_types: [authority.jobType],
				platform: "linux-x64",
				runner_version: this.#config.runnerVersion,
				native_bridge_url: `http://127.0.0.1:${this.#config.nativeBridgePort}/`,
				native_bridge_boundary: "virtual_machine",
				...(!runtime ? { native_bridge_shared_gid: this.#config.nativeExecutionGid } : {}),
				assignment_host: "0.0.0.0",
				assignment_port: this.#config.guestAssignmentPort,
				assignment_trusted_source: this.#config.guestAssignmentSource,
				max_assignments: 1,
				environment: liveCompany
					? {
							QORPERA_LIVE_COMPANY_ROOT: LXD_LIVE_COMPANY_GUEST_PATH,
							QORPERA_LIVE_COMPANY_PROFILE_ID: liveCompany.profileId,
						}
					: {},
			},
			null,
			2,
		);
		const bootstrap = JSON.stringify(
			{
				schema: runtime ? "qorpera.lxd-company-runner-bootstrap/v1" : BOOTSTRAP_SCHEMA,
				...(runtime
					? {
							company_runtime: {
								mode: "company-path-v1",
								run_id: authority.runId,
								profile_id: authority.profileId,
								runner_id: authority.runner.runnerId,
								codex_path: runtime.codexPath,
								binary_sha256: runtime.binarySha256,
								object_gateway_url: runtime.objectGatewayUrl,
								secret_broker_url: runtime.secretBroker.origin,
								secret_broker_ca_sha256: runtime.secretBroker.caSha256,
								...(office
									? {
											office: {
												environment_id: office.environmentId,
												url: office.url,
												token_sha256: sha256(office.token),
											},
										}
									: {}),
								recovery_volume_path: "/var/lib/qorpera-runner",
							},
						}
					: {}),
				compute_identity_id: authority.computeIdentityId,
				compute_template_key: authority.computeTemplateKey,
				compute_template_version: authority.computeTemplateVersion,
				compute_policy_sha256: authority.computePolicySha256,
				...(authority.runner.logicalComputerId ? { logical_computer_id: authority.runner.logicalComputerId } : {}),
				runner_config_path: "/var/lib/qorpera-bootstrap/runner-config.json",
				native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
				credential_source: "/var/lib/qorpera-bootstrap/credentials",
				identity_volume_path: "/var/lib/qorpera/identity",
			},
			null,
			2,
		);
		const nativeProviderEnvironment = [
			`QORPERA_SUPABASE_URL=${this.#config.supabaseUrl}`,
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${authority.computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=127.0.0.1",
			`QORPERA_NATIVE_PROVIDER_PORT=${this.#config.nativeBridgePort}`,
			"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=/var/lib/qorpera-native-provider/tmp",
			`QORPERA_CODEX_PATH=${this.#config.codexPath}`,
			`QORPERA_CLAUDE_PATH=${this.#config.claudePath}`,
			...(runtime
				? [
						"QORPERA_NATIVE_RUNTIME=company-path-v1",
						`QORPERA_NATIVE_CODEX_FENCE_PATH=${runtime.codexPath}`,
						`QORPERA_NATIVE_CODEX_FENCE_SHA256=${runtime.binarySha256}`,
						`QORPERA_NATIVE_OBJECT_GATEWAY_URL=${runtime.objectGatewayUrl}`,
						`QORPERA_CLOUD_SECRET_BROKER_URL=${runtime.secretBroker.origin}`,
						...(office ? [`QORPERA_COMPANY_COMPUTER_URL=${office.url}`] : []),
					]
				: []),
			"",
		].join("\n");
		return [
			{ path: "/var/lib/qorpera-bootstrap/bootstrap.json", content: `${bootstrap}\n` },
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
			...(runtime
				? [
						{
							path: "/var/lib/qorpera-bootstrap/credentials/qorpera-office-native",
							// An unconfigured route has no authority. The fixed systemd
							// credential source still exists and contains zero bytes.
							content: office ? `${office.token}\n` : "",
						},
						{
							path: "/var/lib/qorpera-bootstrap/credentials/qorpera-native-object-token",
							content: `${runtime.objectGatewayToken}\n`,
						},
						{
							path: "/var/lib/qorpera-bootstrap/credentials/qorpera-cloud-secret-runtime",
							content: `${runtime.secretBroker.runtimeToken}\n`,
						},
						{
							path: "/var/lib/qorpera-bootstrap/credentials/qorpera-cloud-secret-ca",
							content: runtime.secretBroker.caCertificate,
						},
					]
				: []),
		];
	}

	async #prepareBootstrap(
		journal: LxdProviderJournal,
		credentials: ProviderCredentials,
		signal?: AbortSignal,
	): Promise<void> {
		const files = this.#bootstrapFiles(this.#bootstrapAuthority(journal), credentials);
		if (bootstrapSha256(files) !== journal.lxd.bootstrapSha256) {
			throw new Error("LXD guest bootstrap no longer matches its durable journal");
		}
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
	}

	async #waitForGuestAgent(journal: LxdProviderJournal, signal?: AbortSignal): Promise<void> {
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
		throw new Error("LXD guest agent did not become ready for private bootstrap injection", { cause: lastError });
	}

	#assertInstanceAuthority(journal: LxdProviderJournal, instance: LxdInstanceRecord): void {
		const root = instance.devices.root;
		const identity = instance.devices["compute-identity"];
		const liveCompany = liveCompanyAuthority(this.#config, journal.jobType);
		const liveCompanyDevice = instance.devices["company-live"];
		const expectedLiveCompanyDevice = liveCompany
			? { type: "disk", source: liveCompany.root, path: LXD_LIVE_COMPANY_GUEST_PATH }
			: undefined;
		if (
			instance.name !== journal.instanceName ||
			instance.type !== "virtual-machine" ||
			JSON.stringify(instance.profiles) !== JSON.stringify(journal.lxd.profiles) ||
			instance.config["boot.mode"] !== "uefi-secureboot" ||
			instance.config["limits.cpu"] !== String(this.#config.cpuLimit) ||
			instance.expandedConfig["limits.cpu"] !== String(this.#config.cpuLimit) ||
			instance.config["limits.memory"] !== this.#config.memoryLimit ||
			instance.expandedConfig["limits.memory"] !== this.#config.memoryLimit ||
			instance.config["user.qorpera.acquisition_id"] !== journal.acquisitionId ||
			instance.config["cloud-init.user-data"] !== undefined ||
			instance.config["user.qorpera.bootstrap_sha256"] !== journal.lxd.bootstrapSha256 ||
			instance.config["user.qorpera.compute_policy_sha256"] !== journal.lxd.policySha256 ||
			instance.config["user.qorpera.runner_id"] !== journal.runner.runnerId ||
			instance.config["user.qorpera.logical_computer_id"] !== journal.runner.logicalComputerId ||
			root?.type !== "disk" ||
			root.path !== "/" ||
			root.pool !== journal.lxd.storagePool ||
			root.size !== journal.lxd.rootDiskSize ||
			identity?.type !== "disk" ||
			identity.path !== "/var/lib/qorpera/identity" ||
			identity.pool !== journal.lxd.storagePool ||
			identity.source !== journal.lxd.identityVolume ||
			JSON.stringify(canonical(liveCompanyDevice)) !== JSON.stringify(canonical(expectedLiveCompanyDevice))
		) {
			throw new Error("LXD guest drifted from immutable provider authority");
		}
		if (journal.lxd.companyRuntime) {
			const expected = this.#createRequest(journal);
			if (
				JSON.stringify(canonical(instance.devices)) !== JSON.stringify(canonical(expected.devices)) ||
				JSON.stringify(canonical(instance.expandedDevices)) !== JSON.stringify(canonical(expected.devices)) ||
				Object.entries(expected.config).some(([key, value]) => instance.expandedConfig[key] !== value) ||
				Object.keys(instance.expandedConfig).some(
					(key) =>
						!Object.hasOwn(expected.config, key) && !key.startsWith("image.") && !key.startsWith("volatile."),
				)
			) {
				throw new Error("Governed native guest has drifted mounts, network, or expanded configuration");
			}
		}
	}

	async #reconcileJournal(current: LxdProviderJournal, signal?: AbortSignal): Promise<void> {
		if (!current.runner.computeIdentityId) {
			throw new Error("Journaled LXD guest is missing Compute Identity authority");
		}
		if (current.physicalState === "reserving") {
			await this.#ensureReady(current, await this.#credentials(current.acquisitionId), signal);
			return;
		}
		await this.#ensureIdentityVolume(current, current.runner.computeIdentityId, signal);
		await this.#ensureRecoveryVolume(current, signal);
		const instance = await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal);
		if (!instance) {
			// A timed-out create/start may still be pending in LXD. Missing is
			// deletion proof only after a fully registered or retired guest.
			if (current.deletionConfirmed || ["registered", "assigned", "stopped"].includes(current.physicalState))
				await this.#releaseMachine(current, signal);
			if (current.physicalState !== "stopped" && current.physicalState !== "lost") {
				await this.#writeJournal({ ...current, physicalState: "lost" });
			}
			return;
		}
		this.#assertInstanceAuthority(current, instance);
		if (current.physicalState === "stopped") {
			if (instance.status !== "Stopped") throw new Error("Stopped LXD journal names a running guest");
			// A guest left behind by an earlier provider build is removed on sight.
			await this.#lxd.deleteInstance(current.lxd.project, current.instanceName, signal);
			await this.#releaseMachine(current, signal);
			return;
		}
		if (current.physicalState === "stopping") {
			await this.#retire(current, instance.status, signal);
			await this.#writeJournal({ ...current, physicalState: "stopped" });
			return;
		}
		if (instance.status === "Stopped" && current.physicalState !== "creating") {
			// Only a guest with no start intent can be started. A one-run guest
			// that powered off before registration has still used its one attempt.
			await this.#retirePoweredOff(current, signal);
			return;
		}
		if (
			current.physicalState === "creating" ||
			current.physicalState === "starting" ||
			current.physicalState === "bootstrapping"
		) {
			const credentials = await this.#credentials(current.acquisitionId);
			this.#validateCredentialHashes(current, credentials);
			await this.#ensureReady(current, credentials, signal);
			return;
		}
		if (instance.status !== "Running") {
			await this.#writeJournal({ ...current, physicalState: "lost" });
			return;
		}
		if (!current.capacityRegistered) await this.#reserveMachine(current, signal);
		else if (!current.nodeCapacity) await this.#reserveNodeMachine(current, signal);
	}

	async #ensureIdentityVolume(
		journal: LxdProviderJournal,
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
			if (journal.lxd.companyRuntime && journal.physicalState !== "creating") {
				throw new Error("Governed native identity volume is missing; recovery requires operator reconciliation");
			}
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
		this.#assertIdentityVolumeAuthority(journal, computeIdentityId, volume);
	}

	async #ensureRecoveryVolume(journal: LxdProviderJournal, signal?: AbortSignal): Promise<void> {
		const company = journal.lxd.companyRuntime;
		if (!company) return;
		const expected = {
			size: company.recoveryVolumeSize,
			"user.qorpera.schema": RECOVERY_VOLUME_SCHEMA,
			"user.qorpera.run_id": journal.runId ?? journal.acquisitionId,
			"user.qorpera.profile_id": company.profileId,
			"user.qorpera.runner_id": journal.runner.runnerId,
			...(journal.runner.logicalComputerId
				? { "user.qorpera.logical_computer_id": journal.runner.logicalComputerId }
				: {}),
			"user.qorpera.compute_identity_id": journal.runner.computeIdentityId,
			"user.qorpera.provider_adapter": this.adapterId,
		};
		let volume = await this.#lxd.getStorageVolume(
			journal.lxd.project,
			journal.lxd.storagePool,
			company.recoveryVolume,
			signal,
		);
		if (!volume) {
			if (journal.physicalState !== "creating") {
				throw new Error("Native recovery volume is missing; execution cannot restart with empty recovery state");
			}
			if (!expected["user.qorpera.compute_identity_id"]) throw new Error("Native recovery identity is missing");
			await this.#lxd.createStorageVolume(
				journal.lxd.project,
				journal.lxd.storagePool,
				{
					name: company.recoveryVolume,
					type: "custom",
					content_type: "filesystem",
					description: `Qorpera retained native recovery ${journal.acquisitionId}`,
					config: {
						...expected,
						"user.qorpera.compute_identity_id": expected["user.qorpera.compute_identity_id"],
					},
				},
				signal,
			);
			volume = await this.#lxd.getStorageVolume(
				journal.lxd.project,
				journal.lxd.storagePool,
				company.recoveryVolume,
				signal,
			);
		}
		if (
			!volume ||
			volume.name !== company.recoveryVolume ||
			volume.type !== "custom" ||
			volume.contentType !== "filesystem" ||
			Object.entries(expected).some(([key, value]) => volume?.config[key] !== value)
		) {
			throw new Error("Native recovery volume drifted from immutable company and run authority");
		}
	}

	#assertIdentityVolumeAuthority(
		journal: LxdProviderJournal,
		computeIdentityId: string,
		volume: LxdStorageVolumeRecord,
	): void {
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

	async #credentials(acquisitionId: string): Promise<ProviderCredentials> {
		const root = join(this.#config.stateRoot, acquisitionId, "credentials");
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
			if (!TOKEN_PATTERN.test(existing)) throw new Error("Stored LXD provider credential is invalid");
			return existing;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			const value = token();
			await writeFile(path, `${value}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
			return value;
		}
	}

	#validateCredentialHashes(journal: LxdProviderJournal, credentials: ProviderCredentials): void {
		if (
			sha256(credentials.activationToken) !== journal.credentials.activationSha256 ||
			sha256(credentials.assignmentToken) !== journal.credentials.assignmentSha256 ||
			sha256(credentials.nativeBridgeToken) !== journal.credentials.nativeBridgeSha256
		) {
			throw new Error("LXD provider credentials do not match their durable journal");
		}
	}

	async #readJournal(acquisitionId: string): Promise<LxdProviderJournal | undefined> {
		try {
			const journal = journalFromJson(
				JSON.parse(await readFile(this.#journalPath(acquisitionId), "utf-8")) as unknown,
			);
			const expected = companyRuntimeAuthority(
				this.#config,
				acquisitionId,
				journal.lxd.companyRuntime?.profileId,
				journal.lxd.companyRuntime?.office?.environmentId,
			);
			if (
				journal.acquisitionId !== acquisitionId ||
				JSON.stringify(canonical(journal.lxd.companyRuntime)) !== JSON.stringify(canonical(expected))
			) {
				throw new Error(
					"LXD journal cannot switch runtime mode or governed configuration; use a separate rollout lane",
				);
			}
			return journal;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async #writeJournal(journal: LxdProviderJournal): Promise<void> {
		const root = join(this.#config.stateRoot, journal.acquisitionId);
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		const updated: LxdProviderJournal = {
			...journal,
			...(this.#registeredCapacity.has(journal.acquisitionId) ? { capacityRegistered: true as const } : {}),
			...(this.#registeredNodeCapacity.has(journal.acquisitionId)
				? { nodeCapacity: this.#registeredNodeCapacity.get(journal.acquisitionId)! }
				: {}),
			updatedAt: new Date().toISOString(),
		};
		const path = this.#journalPath(journal.acquisitionId);
		const temporary = join(root, `.journal-${process.pid}-${randomUUID()}.tmp`);
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf-8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		await chmod(path, 0o600);
		const directory = await open(root, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	async #findJournalByRunner(runnerId: string): Promise<LxdProviderJournal | undefined> {
		await mkdir(this.#config.stateRoot, { recursive: true, mode: 0o700 });
		for (const entry of await readdir(this.#config.stateRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
			const journal = await this.#readJournal(entry.name);
			if (journal?.runner.runnerId === runnerId) return journal;
		}
		return undefined;
	}

	#journalPath(acquisitionId: string): string {
		return join(this.#config.stateRoot, acquisitionId, "journal.json");
	}

	#instanceName(acquisitionId: string): string {
		return `qorpera-${acquisitionId.replaceAll("-", "")}`;
	}

	async #assertCapacityInventory(signal: AbortSignal): Promise<void> {
		await mkdir(this.#config.stateRoot, { recursive: true, mode: 0o700 });
		for (const entry of await readdir(this.#config.stateRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
			const journal = await this.#readJournal(entry.name);
			if (!journal || (journal.capacityRegistered && journal.nodeCapacity) || journal.physicalState === "reserving")
				continue;
			if (
				(journal.deletionConfirmed || journal.physicalState === "stopped") &&
				!(await this.#lxd.getInstance(journal.lxd.project, journal.instanceName, signal))
			)
				continue;
			throw new Error("Existing LXD journal requires confirmed machine-capacity inventory before new starts");
		}
	}

	#machineIdentity(current: LxdProviderJournal): {
		p_allocation_id: string;
		p_provider_adapter: string;
		p_instance_sha256: string;
	} {
		return {
			p_allocation_id: current.acquisitionId,
			p_provider_adapter: this.adapterId,
			p_instance_sha256: sha256(
				JSON.stringify(
					canonical({
						project: current.lxd.project,
						instanceName: current.instanceName,
						image: current.lxd.imageFingerprint,
						bootstrap: current.lxd.bootstrapSha256,
						work: current.workSha256,
					}),
				),
			),
		};
	}

	async #reserveMachine(current: LxdProviderJournal, signal?: AbortSignal): Promise<AbortSignal> {
		const identity = this.#machineIdentity(current);
		const result = record(
			await this.#rpc(
				"qorpera_reserve_runtime_machine",
				{
					...identity,
					p_run_id: current.runId ?? current.acquisitionId,
					p_runner_id: current.runner.runnerId,
				},
				signal,
			),
			"Machine reservation",
		);
		if (
			Object.keys(result).sort().join() !== "allocationId,instanceSha256,state" ||
			result.state !== "reserved" ||
			result.allocationId !== identity.p_allocation_id ||
			result.instanceSha256 !== identity.p_instance_sha256
		) {
			throw new Error("Machine start was not admitted by the company ceiling");
		}
		signal?.throwIfAborted();
		this.#registeredCapacity.add(current.acquisitionId);
		await this.#writeJournal(current);
		return this.#reserveNodeMachine(current, signal);
	}

	async #reserveNodeMachine(current: LxdProviderJournal, caller?: AbortSignal): Promise<AbortSignal> {
		const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(5000)]);
		const host = await readRuntimeNodeHost(signal),
			{ policy, policySha256 } = lxdNativeNodePolicy(this.#config, host.machineIdSha256);
		const prior = current.nodeCapacity ?? this.#registeredNodeCapacity.get(current.acquisitionId);
		if (
			prior &&
			(prior.policySha256 !== policySha256 ||
				prior.machineIdSha256 !== host.machineIdSha256 ||
				prior.cpuMillis !== policy.cpuMillis ||
				prior.memoryBytes !== policy.memoryBytes)
		)
			throw new Error("LXD node placement cannot be changed");
		const identity = this.#machineIdentity(current);
		const admission = await reserveRuntimeNodeMachine(
			{
				allocationId: current.acquisitionId,
				providerKind: "native",
				providerId: this.adapterId,
				policySha256,
				instanceSha256: identity.p_instance_sha256,
				machineIdSha256: host.machineIdSha256,
				cpuMillis: policy.cpuMillis,
				memoryBytes: policy.memoryBytes,
			},
			{ call: (method, args, checked) => this.#rpc(method, args, checked) },
			signal,
		);
		if (admission.state === "refused") throw new Error(admission.reason);
		if (prior && prior.nodeId !== admission.nodeId) throw new Error("LXD node placement cannot be changed");
		this.#registeredNodeCapacity.set(current.acquisitionId, {
			nodeId: admission.nodeId,
			policySha256,
			machineIdSha256: host.machineIdSha256,
			cpuMillis: policy.cpuMillis,
			memoryBytes: policy.memoryBytes,
		});
		await this.#writeJournal(current);
		admission.signal.throwIfAborted();
		return admission.signal;
	}

	async #releaseMachine(current: LxdProviderJournal, signal?: AbortSignal): Promise<void> {
		if (await this.#lxd.getInstance(current.lxd.project, current.instanceName, signal)) {
			throw new Error("Machine capacity remains occupied until physical deletion is confirmed");
		}
		const identity = this.#machineIdentity(current);
		const result = record(await this.#rpc("qorpera_release_runtime_machine", identity, signal), "Machine release");
		if (
			Object.keys(result).sort().join() !== "allocationId,instanceSha256,state" ||
			result.state !== "released" ||
			result.allocationId !== identity.p_allocation_id ||
			result.instanceSha256 !== identity.p_instance_sha256
		) {
			throw new Error("Machine capacity release was not confirmed");
		}
	}

	async #rpc(name: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const response = await this.#fetch(new URL(`/rest/v1/rpc/${name}`, this.#config.supabaseUrl), {
			method: "POST",
			redirect: "error",
			headers: {
				...supabaseServiceHeaders(this.#config.supabaseServiceKey),
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`Runner provisioning failed (${response.status})`);
		}
		return response.json() as Promise<unknown>;
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
