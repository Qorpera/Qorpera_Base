import { createHash, X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES,
	COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_INSTANCE_FILE_BYTES = 256 * 1024;

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
	execInstance(project: string, name: string, command: readonly string[], signal?: AbortSignal): Promise<void>;
	/** Deletes a stopped guest and its root disk; custom volumes attached as devices stay. */
	deleteInstance(project: string, name: string, signal?: AbortSignal): Promise<void>;
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
	| { action: "start" | "stop" | "delete"; name: string };

export interface LxdOperationReference {
	project: string;
	instanceName: string;
	operationId: string;
}

export type LxdOperationState = "pending" | "succeeded" | "failed";

/** Submission and observation are separate so an office provider can persist
 * the operation ID before polling. A rejected submission has an UNKNOWN
 * physical outcome; neither a timeout nor a 404 authorizes a retry/release. */
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
export interface LxdOfficeImageRecord {
	fingerprint: string;
	architecture: string;
	size: number;
}
export interface LxdOfficeInfrastructure {
	project: { name: string; config: Record<string, string>; replicaMode: string };
	network: {
		name: string;
		project: string;
		type: "bridge";
		managed: true;
		status: "Created";
		config: Record<string, string>;
	};
	storagePool: { name: string; driver: string; status: "Created"; config: Record<string, string> };
}
/** Read-only prerequisites for the separate office provider. These attest
 * daemon-reported identity and a pinned local VM image, not guest readiness. */
export interface LxdOfficeInspectableClient extends LxdTrackedClient {
	inspectOfficeServer(project: string, signal: AbortSignal): Promise<LxdOfficeServerIdentity>;
	inspectOfficeImage(project: string, fingerprint: string, signal: AbortSignal): Promise<LxdOfficeImageRecord>;
	inspectOfficeInfrastructure(
		project: string,
		network: string,
		storagePool: string,
		signal: AbortSignal,
	): Promise<LxdOfficeInfrastructure>;
}

/** Bounded staging and fixed-purpose tracked preparation execution, separate
 * from generic runner bootstrap. The pinned image must supply the protected
 * root inbox and helper; callers require the exact VM/boot and current provider
 * authority. Staging alone does not install or invoke the active request, and
 * command completion never grants office activation. */
export interface LxdOfficePreparationClient extends LxdOfficeInspectableClient {
	submitOfficePreparation(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficePreparation(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficePreparationRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficePreparationRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}

/** Confidential configuration staging uses its own fixed path/helper and
 * smaller bound. It grants no command selection or cloud activation. */
export interface LxdOfficeConfigurationClient extends LxdOfficePreparationClient {
	submitOfficeConfiguration(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeConfiguration(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
/** Retained-boot configuration has its own fixed helper and bounded packet. */
export interface LxdOfficeBootConfigurationClient extends LxdOfficeServiceStartClient {
	submitOfficeBootConfiguration(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeBootConfiguration(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeBootConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeBootConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
/** Fixed ordinary-service control. Inspection uses a fresh caller-owned nonce,
 * never a different start command or arbitrary executable. */
export interface LxdOfficeServiceStartClient extends LxdOfficeInspectableClient {
	submitOfficeServiceStart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	submitOfficeServiceInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeServiceStart(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
/** First service invocation after retained-boot configuration and SQL admission. */
export interface LxdOfficeBootServiceStartClient extends LxdOfficeInspectableClient {
	submitOfficeBootServiceStart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	submitOfficeBootServiceInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeBootServiceStart(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeBootServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeBootServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
/** Stop and its read-only inspection use a separate fixed root helper. The
 * owning lifecycle worker must retain SQL revocation before submitting stop. */
export interface LxdOfficeServiceStopClient extends LxdOfficeInspectableClient {
	submitOfficeServiceStop(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	submitOfficeServiceStopInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeServiceStop(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeServiceStopRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeServiceStopRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
/** Same-boot successor execution is distinct from initial service start. */
export interface LxdOfficeServiceRestartClient extends LxdOfficeInspectableClient {
	submitOfficeServiceRestart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	submitOfficeServiceRestartInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeServiceRestart(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
export interface LxdOfficeBootServiceRestartClient extends LxdOfficeInspectableClient {
	submitOfficeBootServiceRestart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	submitOfficeBootServiceRestartInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspectOfficeBootServiceRestart(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	pushOfficeBootServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void>;
	readOfficeBootServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
type OfficeControlPurpose =
	| "preparation"
	| "configuration"
	| "boot-configuration"
	| "boot-service-restart"
	| "boot-service-start"
	| "service-start"
	| "service-stop"
	| "service-restart";
const officeControlMaximum = (purpose: OfficeControlPurpose) =>
	purpose === "boot-service-restart"
		? COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES
		: purpose === "boot-service-start"
			? COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES
			: purpose === "boot-configuration"
				? COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES
				: purpose === "preparation"
					? COMPANY_COMPUTER_PREPARATION_MAX_BYTES
					: purpose === "configuration"
						? COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES
						: purpose === "service-start"
							? COMPANY_COMPUTER_SERVICE_START_MAX_BYTES
							: purpose === "service-stop"
								? COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES
								: COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES;
const officeControlError = (purpose: OfficeControlPurpose, operation: string) =>
	new Error(`LXD_OFFICE_${purpose.replaceAll("-", "_").toUpperCase()}_${operation}_UNCONFIRMED`);

export type LxdOfficePreparationCommand = CompanyComputerPreparationCommand;

/** Only this pinned-image helper is executable through the preparation lane.
 * The helper must independently validate the protected request, current boot,
 * kernel lock and systemd invocation. A zero exit is not office admission. */
export function lxdOfficePreparationCommand(value: LxdOfficePreparationCommand): readonly string[] {
	return officeControlCommand(value, "preparation");
}
export function lxdOfficeConfigurationCommand(value: LxdOfficePreparationCommand): readonly string[] {
	return officeControlCommand(value, "configuration");
}
export function lxdOfficeBootConfigurationCommand(value: LxdOfficePreparationCommand): readonly string[] {
	return officeControlCommand(value, "boot-configuration");
}
function officeControlCommand(
	value: LxdOfficePreparationCommand,
	purpose: OfficeControlPurpose,
	inspectionId?: string,
): readonly string[] {
	const command = parseCompanyComputerPreparationCommand(value);
	if (
		inspectionId !== undefined &&
		((purpose !== "boot-service-restart" &&
			purpose !== "boot-service-start" &&
			purpose !== "service-start" &&
			purpose !== "service-stop" &&
			purpose !== "service-restart") ||
			parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId }).commandId ===
				command.commandId)
	)
		throw new Error("INVALID_OFFICE_SERVICE_INSPECTION");
	return Object.freeze([
		"/usr/bin/env",
		"-i",
		"/usr/bin/node",
		`/opt/qorpera-office/qorpera-company-computer-${purpose}-control.mjs`,
		command.commandId,
		command.requestSha256,
		command.bootId,
		...(inspectionId === undefined ? [] : [inspectionId]),
	]);
}

function officeControlPath(
	project: string,
	name: string,
	requestSha256: string,
	purpose: OfficeControlPurpose,
): string {
	if (
		![project, name].every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)) ||
		typeof requestSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(requestSha256)
	)
		throw new Error("INVALID_OFFICE_PREPARATION_STAGING");
	return `/run/qorpera-office-preparation/${purpose === "preparation" ? "" : `${purpose}-`}incoming-${requestSha256}.json`;
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
	status: number;
	body: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	const input = record(value, label);
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(input)) {
		if (typeof entry !== "string") throw new Error(`${label} is invalid`);
		output[key] = entry;
	}
	return output;
}

function devices(value: unknown): Record<string, Readonly<Record<string, string>>> {
	const input = record(value, "LXD instance devices");
	const output: Record<string, Readonly<Record<string, string>>> = {};
	for (const [name, device] of Object.entries(input)) output[name] = stringRecord(device, "LXD instance device");
	return output;
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

function instanceState(value: unknown): LxdInstanceStateRecord {
	const input = record(value, "LXD instance state");
	if (typeof input.status !== "string" || typeof input.status_code !== "number") {
		throw new Error("LXD instance state is invalid");
	}
	// A stopped VM has no network map. Preserve its status so readiness can
	// recognize shutdown instead of treating every poll as a malformed response.
	const networkInput =
		input.status === "Stopped" && input.network === null ? {} : record(input.network, "LXD instance network state");
	const network: Record<string, { addresses: readonly { family: string; address: string; scope: string }[] }> = {};
	for (const [name, rawInterface] of Object.entries(networkInput)) {
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
		network[name] = { addresses };
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

function lxdError(result: HttpResult, fallback: string): Error {
	try {
		const envelope = record(result.body, "LXD response");
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

export class LxdUnixClient
	implements
		LxdOfficeConfigurationClient,
		LxdOfficeServiceStartClient,
		LxdOfficeBootServiceStartClient,
		LxdOfficeServiceStopClient,
		LxdOfficeServiceRestartClient,
		LxdOfficeBootServiceRestartClient
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

	async #officeMetadata(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
		checked.throwIfAborted();
		const result = await this.#requestPayload("GET", path, undefined, undefined, checked, 65536);
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
			const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
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
		} catch {
			throw new Error("LXD_HOST_INVENTORY_UNCONFIRMED");
		}
	}

	async inspectOfficeImage(project: string, fingerprint: string, signal: AbortSignal): Promise<LxdOfficeImageRecord> {
		try {
			if (!/^[a-z][a-z0-9-]{0,62}$/.test(project) || !/^[0-9a-f]{64}$/.test(fingerprint))
				throw new Error("invalid image identity");
			const value = await this.#officeMetadata(projectPath(`/1.0/images/${fingerprint}`, project), signal);
			if (
				value.fingerprint !== fingerprint ||
				value.type !== "virtual-machine" ||
				value.public !== false ||
				value.auto_update !== false ||
				(value.architecture !== "x86_64" && value.architecture !== "aarch64") ||
				!Number.isSafeInteger(value.size) ||
				(value.size as number) < 1 ||
				(value.size as number) > 1024 ** 4 ||
				strings(value.profiles, "image profiles").length !== 0
			)
				throw new Error("unsupported office image");
			return { fingerprint, architecture: value.architecture, size: value.size as number };
		} catch {
			throw new Error("LXD_OFFICE_IMAGE_UNCONFIRMED");
		}
	}

	async inspectOfficeInfrastructure(
		project: string,
		network: string,
		storagePool: string,
		signal: AbortSignal,
	): Promise<LxdOfficeInfrastructure> {
		try {
			if (![project, network, storagePool].every((name) => /^[a-z][a-z0-9-]{0,62}$/.test(name)))
				throw new Error("invalid infrastructure identity");
			const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			const p = await this.#officeMetadata(`/1.0/projects/${project}`, checked);
			const n = await this.#officeMetadata(projectPath(`/1.0/networks/${network}`, project), checked);
			const s = await this.#officeMetadata(`/1.0/storage-pools/${storagePool}`, checked);
			const pc = stringRecord(p.config, "project config");
			const nc = stringRecord(n.config, "network config");
			const sc = stringRecord(s.config, "storage pool config");
			const networkProject = n.project ?? "";
			const replicaMode = p.replica_mode ?? "";
			if (
				p.name !== project ||
				replicaMode !== "" ||
				n.name !== network ||
				n.type !== "bridge" ||
				n.managed !== true ||
				n.status !== "Created" ||
				!["", "default", project].includes(networkProject as string) ||
				nc["ipv4.nat"] !== "true" ||
				nc["ipv6.address"] !== "none" ||
				nc["ipv4.firewall"] === "false" ||
				nc["bridge.external_interfaces"] ||
				nc["security.acls"] ||
				s.name !== storagePool ||
				s.status !== "Created" ||
				!["dir", "btrfs", "lvm", "zfs"].includes(s.driver as string)
			)
				throw new Error("unsupported office infrastructure");
			checked.throwIfAborted();
			return {
				project: { name: project, config: pc, replicaMode },
				network: {
					name: network,
					project: networkProject as string,
					type: "bridge",
					managed: true,
					status: "Created",
					config: nc,
				},
				storagePool: { name: storagePool, driver: s.driver as string, status: "Created", config: sc },
			};
		} catch {
			throw new Error("LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED");
		}
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

	async createInstance(
		project: string,
		request: LxdCreateInstanceRequest,
		signal?: AbortSignal,
		dispatchSignal?: AbortSignal,
	): Promise<void> {
		if (request.type !== "virtual-machine") throw new Error("LXD provider only creates full virtual machines");
		const dispatch = dispatchSignal ? AbortSignal.any([dispatchSignal, ...(signal ? [signal] : [])]) : signal;
		dispatch?.throwIfAborted();
		const result = await this.#request("POST", projectPath("/1.0/instances", project), request, dispatch);
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
			const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			checked.throwIfAborted();
			let result: HttpResult;
			if (action.action === "create") {
				result = await this.#request("POST", projectPath("/1.0/instances", project), action.request, checked);
			} else if (action.action === "delete") {
				result = await this.#request("DELETE", projectPath(`/1.0/instances/${name}`, project), undefined, checked);
			} else if (action.action === "start" || action.action === "stop") {
				result = await this.#request(
					"PUT",
					projectPath(`/1.0/instances/${name}/state`, project),
					{ action: action.action, timeout: this.#operationTimeoutSeconds, force: false, stateful: false },
					checked,
				);
			} else throw new Error("invalid action");
			checked.throwIfAborted();
			const envelope = record(result.body, "LXD response");
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
		} catch {
			throw new Error("LXD_OPERATION_SUBMISSION_UNCONFIRMED");
		}
	}

	async inspectInstanceOperation(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
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
			if (result.status !== 200 || envelope.type !== "sync" || envelope.status_code !== 200)
				throw new Error("operation unavailable");
			return trackedOperation(envelope.metadata, reference);
		} catch {
			throw new Error("LXD_OPERATION_UNCONFIRMED");
		}
	}

	/** Return the accepted identity immediately. Timeouts and malformed replies
	 * have unknown physical outcomes; callers journal BEFORE calling this. */
	async submitOfficePreparation(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "preparation");
	}
	async submitOfficeConfiguration(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "configuration");
	}
	async submitOfficeBootConfiguration(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "boot-configuration");
	}
	async submitOfficeServiceStart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "service-start");
	}
	async submitOfficeBootServiceStart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "boot-service-start");
	}
	async submitOfficeServiceInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		// Undefined must never degrade an inspection into the effectful start mode.
		if (typeof inspectionId !== "string") throw officeControlError("service-start", "SUBMISSION");
		return this.#submitOfficeControl(project, name, command, signal, "service-start", inspectionId);
	}
	async submitOfficeBootServiceInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		// Undefined must never degrade an inspection into the effectful start mode.
		if (typeof inspectionId !== "string") throw officeControlError("boot-service-start", "SUBMISSION");
		return this.#submitOfficeControl(project, name, command, signal, "boot-service-start", inspectionId);
	}
	async submitOfficeServiceStop(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "service-stop");
	}
	async submitOfficeServiceRestart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "service-restart");
	}
	async submitOfficeBootServiceRestart(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#submitOfficeControl(project, name, command, signal, "boot-service-restart");
	}
	async submitOfficeServiceStopInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		if (typeof inspectionId !== "string") throw officeControlError("service-stop", "SUBMISSION");
		return this.#submitOfficeControl(project, name, command, signal, "service-stop", inspectionId);
	}
	async submitOfficeServiceRestartInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		if (typeof inspectionId !== "string") throw officeControlError("service-restart", "SUBMISSION");
		return this.#submitOfficeControl(project, name, command, signal, "service-restart", inspectionId);
	}
	async submitOfficeBootServiceRestartInspection(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		if (typeof inspectionId !== "string") throw officeControlError("boot-service-restart", "SUBMISSION");
		return this.#submitOfficeControl(project, name, command, signal, "boot-service-restart", inspectionId);
	}
	async #submitOfficeControl(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
		purpose: OfficeControlPurpose,
		inspectionId?: string,
	): Promise<LxdOperationReference> {
		try {
			officeControlPath(project, name, command.requestSha256, purpose);
			const argv = officeControlCommand(command, purpose, inspectionId);
			const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			checked.throwIfAborted();
			const result = await this.#request(
				"POST",
				projectPath(`/1.0/instances/${name}/exec`, project),
				{
					command: argv,
					interactive: false,
					"wait-for-websocket": false,
					"record-output": false,
					user: 0,
					group: 0,
					cwd: "/",
					environment: {},
				},
				checked,
			);
			checked.throwIfAborted();
			const envelope = record(result.body, "LXD response");
			if (
				result.status !== 202 ||
				envelope.type !== "async" ||
				envelope.status_code !== 100 ||
				(envelope.status !== undefined && envelope.status !== "Operation created") ||
				(envelope.error_code !== undefined && envelope.error_code !== 0) ||
				(envelope.error !== undefined && envelope.error !== "") ||
				typeof envelope.operation !== "string" ||
				!envelope.operation.startsWith("/1.0/operations/")
			)
				throw new Error("operation not accepted");
			const operationId = envelope.operation.slice("/1.0/operations/".length);
			if (!OPERATION_UUID.test(operationId)) throw new Error("invalid operation identity");
			const reference = { project, instanceName: name, operationId };
			trackedOperation(envelope.metadata, reference);
			return reference;
		} catch {
			throw officeControlError(purpose, "SUBMISSION");
		}
	}

	async inspectOfficePreparation(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "preparation");
	}
	async inspectOfficeConfiguration(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "configuration");
	}
	async inspectOfficeBootConfiguration(
		reference: LxdOperationReference,
		signal: AbortSignal,
	): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "boot-configuration");
	}
	async inspectOfficeServiceStart(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "service-start");
	}
	async inspectOfficeBootServiceStart(
		reference: LxdOperationReference,
		signal: AbortSignal,
	): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "boot-service-start");
	}
	async inspectOfficeServiceStop(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "service-stop");
	}
	async inspectOfficeServiceRestart(
		reference: LxdOperationReference,
		signal: AbortSignal,
	): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "service-restart");
	}
	async inspectOfficeBootServiceRestart(
		reference: LxdOperationReference,
		signal: AbortSignal,
	): Promise<LxdOperationState> {
		return this.#inspectOfficeControl(reference, signal, "boot-service-restart");
	}
	async #inspectOfficeControl(
		reference: LxdOperationReference,
		signal: AbortSignal,
		purpose: OfficeControlPurpose,
	): Promise<LxdOperationState> {
		try {
			if (
				![reference.project, reference.instanceName].every(
					(value) => typeof value === "string" && INSTANCE_NAME.test(value),
				) ||
				typeof reference.operationId !== "string" ||
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
			if (
				result.status !== 200 ||
				envelope.type !== "sync" ||
				envelope.status_code !== 200 ||
				(envelope.status !== undefined && envelope.status !== "Success") ||
				(envelope.error_code !== undefined && envelope.error_code !== 0) ||
				(envelope.error !== undefined && envelope.error !== "")
			)
				throw new Error("operation unavailable");
			const state = trackedOperation(envelope.metadata, reference);
			if (state !== "succeeded") return state;
			// LXD task Success means the exec operation completed, even when the
			// guest process exited nonzero. Missing/invalid exit metadata is unknown.
			const resultMetadata = record(record(envelope.metadata, "operation").metadata, "exec result");
			const exitCode = resultMetadata.return;
			if (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255)
				throw new Error("exit status unavailable");
			return exitCode === 0 ? "succeeded" : "failed";
		} catch {
			throw officeControlError(purpose, "OPERATION");
		}
	}

	async setInstancePower(
		project: string,
		name: string,
		action: LxdInstancePowerAction,
		signal?: AbortSignal,
		dispatchSignal?: AbortSignal,
	): Promise<void> {
		const dispatch = dispatchSignal ? AbortSignal.any([dispatchSignal, ...(signal ? [signal] : [])]) : signal;
		dispatch?.throwIfAborted();
		const result = await this.#request(
			"PUT",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/state`, project),
			{ action, timeout: this.#operationTimeoutSeconds, force: action === "stop", stateful: false },
			dispatch,
		);
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

	/** Provider-only metadata read, never a model/member filesystem tool. A file
	 * response does not attest the VM, its parent paths, or cloud activation. */
	async readInstanceFile(
		project: string,
		name: string,
		path: string,
		maximumBytes: number,
		signal?: AbortSignal,
	): Promise<LxdInstanceFile> {
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 65536)
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		const file = await this.#readInstanceFile(project, name, path, maximumBytes, signal);
		// LXD 6.9 serves procfs using its zero stat size. Preserve the real file
		// metadata, but obtain this one public kernel value through a fixed,
		// unprivileged read. Ordinary files never gain an execution fallback.
		if (path !== "/proc/sys/kernel/random/boot_id" || file.content.length !== 0) return file;
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444 || maximumBytes < 37)
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		const content = await this.#readProcBootId(project, name, signal);
		const after = await this.#readInstanceFile(project, name, path, maximumBytes, signal);
		if (
			after.uid !== file.uid ||
			after.gid !== file.gid ||
			after.mode !== file.mode ||
			(after.content.length !== 0 && !after.content.equals(content))
		)
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		return { ...after, content };
	}

	async #readProcBootId(project: string, name: string, signal?: AbortSignal): Promise<Buffer> {
		try {
			const checked = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
			checked.throwIfAborted();
			const result = await this.#request(
				"POST",
				projectPath(`/1.0/instances/${name}/exec`, project),
				{
					command: ["/usr/bin/cat", "--", "/proc/sys/kernel/random/boot_id"],
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
				64,
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
				!/^[0-9a-f-]{36}\n$/.test(stdout.body) ||
				!OPERATION_UUID.test(stdout.body.slice(0, -1))
			)
				throw new Error("invalid boot read");
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
		} catch {
			throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
		}
	}

	async pushOfficePreparationRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "preparation");
	}
	async pushOfficeConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "configuration");
	}
	async pushOfficeBootConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "boot-configuration");
	}
	async pushOfficeServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "service-start");
	}
	async pushOfficeBootServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "boot-service-start");
	}
	async pushOfficeServiceStopRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "service-stop");
	}
	async pushOfficeServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "service-restart");
	}
	async pushOfficeBootServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
	): Promise<void> {
		return this.#pushOfficeControlRequest(project, name, requestSha256, content, signal, "boot-service-restart");
	}
	async #pushOfficeControlRequest(
		project: string,
		name: string,
		requestSha256: string,
		content: Buffer,
		signal: AbortSignal,
		purpose: OfficeControlPurpose,
	): Promise<void> {
		let payload: Buffer | undefined;
		try {
			const path = officeControlPath(project, name, requestSha256, purpose);
			if (!Buffer.isBuffer(content) || content.length < 1 || content.length > officeControlMaximum(purpose))
				throw new Error("invalid request size");
			// Retain exact bytes across awaits even if the caller changes its buffer.
			payload = Buffer.from(content);
			if (createHash("sha256").update(payload).digest("hex") !== requestSha256)
				throw new Error("request digest mismatch");
			const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			checked.throwIfAborted();
			const result = await this.#requestPayload(
				"POST",
				projectPath(`/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, project),
				payload,
				{
					"content-type": "application/octet-stream",
					"x-lxd-type": "file",
					"x-lxd-uid": "0",
					"x-lxd-gid": "0",
					"x-lxd-mode": "0400",
					"x-lxd-modify-perm": "uid,gid,mode",
				},
				checked,
			);
			checked.throwIfAborted();
			const envelope = record(result.body, "LXD preparation staging response");
			if (
				result.status !== 200 ||
				envelope.type !== "sync" ||
				envelope.status_code !== 200 ||
				(envelope.status !== undefined && envelope.status !== "Success") ||
				(envelope.error_code !== undefined && envelope.error_code !== 0) ||
				(envelope.error !== undefined && envelope.error !== "")
			)
				throw new Error("staging upload unconfirmed");
		} catch {
			throw officeControlError(purpose, "UPLOAD");
		} finally {
			payload?.fill(0);
		}
	}

	async readOfficePreparationRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "preparation");
	}
	async readOfficeConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "configuration");
	}
	async readOfficeBootConfigurationRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "boot-configuration");
	}
	async readOfficeServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "service-start");
	}
	async readOfficeBootServiceStartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "boot-service-start");
	}
	async readOfficeServiceStopRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "service-stop");
	}
	async readOfficeServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "service-restart");
	}
	async readOfficeBootServiceRestartRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile> {
		return this.#readOfficeControlRequest(project, name, requestSha256, bytes, signal, "boot-service-restart");
	}
	async #readOfficeControlRequest(
		project: string,
		name: string,
		requestSha256: string,
		bytes: number,
		signal: AbortSignal,
		purpose: OfficeControlPurpose,
	): Promise<LxdInstanceFile> {
		try {
			const path = officeControlPath(project, name, requestSha256, purpose);
			if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > officeControlMaximum(purpose))
				throw new Error("size");
			const file = await this.#readInstanceFile(project, name, path, bytes, signal);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== 0o400 ||
				file.content.length !== bytes ||
				createHash("sha256").update(file.content).digest("hex") !== requestSha256
			)
				throw new Error("staged request mismatch");
			signal.throwIfAborted();
			return file;
		} catch {
			throw officeControlError(purpose, "READBACK");
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
				maximumBytes > COMPANY_COMPUTER_PREPARATION_MAX_BYTES
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

	async execInstance(project: string, name: string, command: readonly string[], signal?: AbortSignal): Promise<void> {
		if (
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
		const operation = await this.#waitForOperation(result, signal);
		const metadata = record(operation.metadata, "LXD exec operation metadata");
		if (metadata.return !== 0) throw new Error("LXD instance command failed");
	}

	async #waitForOperation(result: HttpResult, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
		const waitPath = `${envelope.operation}/wait?timeout=${this.#operationTimeoutSeconds}`;
		const wait = await this.#request("GET", waitPath, undefined, signal);
		const operation = record(envelopeMetadata(wait), "LXD operation");
		if (
			typeof operation.status_code !== "number" ||
			operation.status_code < 200 ||
			operation.status_code >= 300 ||
			(typeof operation.err === "string" && operation.err.length > 0)
		) {
			throw new Error("LXD operation failed");
		}
		return operation;
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
