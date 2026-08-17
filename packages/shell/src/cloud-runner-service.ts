import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { SupabaseCloudRunnerBrokerTransport } from "./cloud-runner-broker.ts";
import {
	CLOUD_RUNNER_CAPABILITIES,
	type CloudRunnerCapability,
	DisposableCloudRunner,
	SupabaseCloudRunnerControlTransport,
} from "./cloud-runner-control.ts";
import { RootlessPodmanSandboxBackend } from "./cloud-runner-podman.ts";
import type { CloudRunnerSandboxLimits } from "./cloud-runner-sandbox.ts";
import { EphemeralCloudRunnerWorker } from "./cloud-runner-worker.ts";
import { FileCloudRunnerAuthorityStore } from "./cloud-runner-worker-state.ts";

const CONFIG_SCHEMA = "qorpera.ephemeral-runner-service/v1";
const ACTIVATION_CREDENTIAL_NAME = "qorpera-runner-activation";
const REPAIR_CREDENTIAL_NAME = "qorpera-runner-repair";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;

export interface EphemeralCloudRunnerServiceConfig {
	schema: typeof CONFIG_SCHEMA;
	baseUrl: string;
	publishableKey: string;
	runnerId: string;
	authorityStatePath: string;
	temporaryRoot: string;
	image: string;
	podmanPath: string;
	entrypoint: string;
	capabilities: readonly CloudRunnerCapability[];
	jobTypes: readonly string[];
	platform: string;
	runnerVersion: string;
	environment: Readonly<Record<string, string>>;
	limits?: Partial<CloudRunnerSandboxLimits>;
	idlePollMs?: number;
	leaseRenewalMs?: number;
	heartbeatMs?: number;
}

export interface RunEphemeralCloudRunnerServiceOptions {
	config: EphemeralCloudRunnerServiceConfig;
	credentialsDirectory?: string;
	signal: AbortSignal;
	runWorker?: (worker: EphemeralCloudRunnerWorker, signal: AbortSignal) => Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error(`${label} contains an unknown setting`);
}

function requiredText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
	const path = requiredText(value, label, 4096);
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
	return resolve(path);
}

function requiredContainerPath(value: unknown, label: string): string {
	const path = requiredText(value, label, 4096);
	if (
		!path.startsWith("/") ||
		!/^[A-Za-z0-9._/-]+$/.test(path) ||
		path.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error(`${label} is invalid`);
	}
	return path;
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} is outside the supported range`);
	}
	return value as number;
}

function capabilities(value: unknown): readonly CloudRunnerCapability[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > CLOUD_RUNNER_CAPABILITIES.length) {
		throw new Error("Runner capabilities are invalid");
	}
	const parsed = value.map((entry) => {
		if (!CLOUD_RUNNER_CAPABILITIES.some((candidate) => candidate === entry)) {
			throw new Error("Runner capability is invalid");
		}
		return entry as CloudRunnerCapability;
	});
	if (new Set(parsed).size !== parsed.length) throw new Error("Runner capabilities contain duplicates");
	return Object.freeze(parsed);
}

function jobTypes(value: unknown): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > 32 ||
		value.some((entry) => typeof entry !== "string" || !JOB_TYPE_PATTERN.test(entry))
	) {
		throw new Error("Runner job types are invalid");
	}
	const parsed = value as string[];
	if (new Set(parsed).size !== parsed.length) throw new Error("Runner job types contain duplicates");
	return Object.freeze([...parsed]);
}

function environment(value: unknown): Readonly<Record<string, string>> {
	if (value === undefined) return Object.freeze({});
	const input = record(value, "Runner environment");
	const parsed: Record<string, string> = {};
	for (const [key, entry] of Object.entries(input)) {
		if (
			!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) ||
			typeof entry !== "string" ||
			entry.length > 4096 ||
			/[\0\r\n]/.test(entry) ||
			/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|API_KEY/.test(key)
		) {
			throw new Error("Runner environment contains an invalid entry");
		}
		parsed[key] = entry;
	}
	return Object.freeze(parsed);
}

function limits(value: unknown): Partial<CloudRunnerSandboxLimits> | undefined {
	if (value === undefined) return undefined;
	const input = record(value, "Runner limits");
	exactKeys(
		input,
		[
			"wall_time_ms",
			"memory_bytes",
			"cpu_count",
			"max_pids",
			"max_input_bytes",
			"max_output_bytes",
			"max_result_bytes",
		],
		"Runner limits",
	);
	const parsed: Partial<CloudRunnerSandboxLimits> = {};
	const wallTimeMs = optionalInteger(input.wall_time_ms, "Runner wall time", 10, 24 * 60 * 60 * 1000);
	const memoryBytes = optionalInteger(input.memory_bytes, "Runner memory", 64 * 1024 * 1024, 256 * 1024 * 1024 * 1024);
	const maxPids = optionalInteger(input.max_pids, "Runner process count", 1, 4096);
	const maxInputBytes = optionalInteger(input.max_input_bytes, "Runner input bytes", 1, Number.MAX_SAFE_INTEGER);
	const maxOutputBytes = optionalInteger(input.max_output_bytes, "Runner output bytes", 0, Number.MAX_SAFE_INTEGER);
	const maxResultBytes = optionalInteger(input.max_result_bytes, "Runner result bytes", 2, 64 * 1024);
	if (input.cpu_count !== undefined) {
		if (
			typeof input.cpu_count !== "number" ||
			!Number.isFinite(input.cpu_count) ||
			input.cpu_count < 0.1 ||
			input.cpu_count > 64
		) {
			throw new Error("Runner CPU count is outside the supported range");
		}
		parsed.cpuCount = input.cpu_count;
	}
	if (wallTimeMs !== undefined) parsed.wallTimeMs = wallTimeMs;
	if (memoryBytes !== undefined) parsed.memoryBytes = memoryBytes;
	if (maxPids !== undefined) parsed.maxPids = maxPids;
	if (maxInputBytes !== undefined) parsed.maxInputBytes = maxInputBytes;
	if (maxOutputBytes !== undefined) parsed.maxOutputBytes = maxOutputBytes;
	if (maxResultBytes !== undefined) parsed.maxResultBytes = maxResultBytes;
	return Object.freeze(parsed);
}

export function parseEphemeralCloudRunnerServiceConfig(value: unknown): EphemeralCloudRunnerServiceConfig {
	const input = record(value, "Runner service configuration");
	exactKeys(
		input,
		[
			"schema",
			"base_url",
			"publishable_key",
			"runner_id",
			"authority_state_path",
			"temporary_root",
			"image",
			"podman_path",
			"entrypoint",
			"capabilities",
			"job_types",
			"platform",
			"runner_version",
			"environment",
			"limits",
			"idle_poll_ms",
			"lease_renewal_ms",
			"heartbeat_ms",
		],
		"Runner service configuration",
	);
	if (input.schema !== CONFIG_SCHEMA) throw new Error("Runner service configuration schema is unsupported");
	const runnerId = requiredText(input.runner_id, "Runner id", 36);
	if (!UUID_PATTERN.test(runnerId)) throw new Error("Runner id is invalid");
	const image = requiredText(input.image, "Runner image", 512);
	if (!IMAGE_PATTERN.test(image)) throw new Error("Runner image must be pinned by SHA-256 digest");
	const idlePollMs = optionalInteger(input.idle_poll_ms, "Runner idle poll", 10, 60_000);
	const leaseRenewalMs = optionalInteger(input.lease_renewal_ms, "Runner lease renewal", 10, 90_000);
	const heartbeatMs = optionalInteger(input.heartbeat_ms, "Runner heartbeat", 10, 10 * 60_000);
	const parsedLimits = limits(input.limits);
	return {
		schema: CONFIG_SCHEMA,
		baseUrl: requiredText(input.base_url, "Runner base URL", 2048),
		publishableKey: requiredText(input.publishable_key, "Runner publishable key", 4096),
		runnerId,
		authorityStatePath: requiredAbsolutePath(input.authority_state_path, "Runner authority state path"),
		temporaryRoot: requiredAbsolutePath(input.temporary_root, "Runner temporary root"),
		image,
		podmanPath: requiredAbsolutePath(input.podman_path, "Runner Podman path"),
		entrypoint: requiredContainerPath(input.entrypoint, "Runner container entrypoint"),
		capabilities: capabilities(input.capabilities),
		jobTypes: jobTypes(input.job_types),
		platform: requiredText(input.platform, "Runner platform", 80),
		runnerVersion: requiredText(input.runner_version, "Runner version", 80),
		environment: environment(input.environment),
		...(parsedLimits ? { limits: parsedLimits } : {}),
		...(idlePollMs !== undefined ? { idlePollMs } : {}),
		...(leaseRenewalMs !== undefined ? { leaseRenewalMs } : {}),
		...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
	};
}

function secureOpenFlags(flags: number): number {
	return process.platform === "linux" ? flags | constants.O_NOFOLLOW : flags;
}

async function readBoundedFile(path: string, maximum: number, label: string, privateFile: boolean): Promise<string> {
	let handle: FileHandle;
	try {
		handle = await open(path, secureOpenFlags(constants.O_RDONLY));
	} catch (error) {
		throw new Error(`${label} could not be opened`, { cause: error });
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > maximum) throw new Error(`${label} is invalid`);
		if (process.platform === "linux") {
			const currentUid = process.getuid?.();
			if (
				currentUid === undefined ||
				metadata.uid !== currentUid ||
				(privateFile && (metadata.mode & 0o077) !== 0)
			) {
				throw new Error(`${label} has unsafe ownership or permissions`);
			}
			if (!privateFile && (metadata.mode & 0o022) !== 0) throw new Error(`${label} is writable by another account`);
		}
		const encoded = await handle.readFile({ encoding: "utf-8" });
		if (Buffer.byteLength(encoded) > maximum) throw new Error(`${label} exceeds its byte limit`);
		return encoded;
	} finally {
		await handle.close();
	}
}

export async function loadEphemeralCloudRunnerServiceConfig(path: string): Promise<EphemeralCloudRunnerServiceConfig> {
	const resolvedPath = requiredAbsolutePath(path, "Runner configuration path");
	const encoded = await readBoundedFile(resolvedPath, MAX_CONFIG_BYTES, "Runner configuration", false);
	let value: unknown;
	try {
		value = JSON.parse(encoded) as unknown;
	} catch (error) {
		throw new Error("Runner configuration contains invalid JSON", { cause: error });
	}
	return parseEphemeralCloudRunnerServiceConfig(value);
}

async function runnerCredential(
	credentialsDirectory: string | undefined,
	credentialName: string,
	label: string,
): Promise<string | undefined> {
	if (!credentialsDirectory) return undefined;
	const directory = requiredAbsolutePath(credentialsDirectory, "Runner credentials directory");
	let encoded: string;
	try {
		encoded = await readBoundedFile(join(directory, credentialName), MAX_CREDENTIAL_BYTES, label, true);
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return undefined;
		throw error;
	}
	const token = encoded.trim();
	if (!TOKEN_PATTERN.test(token)) throw new Error(`${label} is invalid`);
	return token;
}

export async function runEphemeralCloudRunnerService(options: RunEphemeralCloudRunnerServiceOptions): Promise<void> {
	const { config, signal } = options;
	if (signal.aborted) return;
	const authorityStore = new FileCloudRunnerAuthorityStore(config.authorityStatePath);
	const storedAuthority = await authorityStore.load();
	const activationToken =
		storedAuthority === undefined
			? await runnerCredential(
					options.credentialsDirectory,
					ACTIVATION_CREDENTIAL_NAME,
					"Runner activation credential",
				)
			: undefined;
	const repairToken =
		storedAuthority === undefined
			? undefined
			: await runnerCredential(options.credentialsDirectory, REPAIR_CREDENTIAL_NAME, "Runner repair credential");
	if (storedAuthority === undefined && !activationToken) {
		throw new Error("Runner activation credential is required for initial setup");
	}
	const control = new SupabaseCloudRunnerControlTransport(config.baseUrl, config.publishableKey);
	const runner = repairToken
		? await DisposableCloudRunner.repair(control, config.runnerId, authorityStore, repairToken)
		: await DisposableCloudRunner.open(control, config.runnerId, authorityStore, activationToken);
	const backend = new RootlessPodmanSandboxBackend({
		image: config.image,
		capabilities: config.capabilities,
		jobTypes: config.jobTypes,
		podmanPath: config.podmanPath,
		entrypoint: config.entrypoint,
	});
	const worker = new EphemeralCloudRunnerWorker({
		runner,
		brokerTransport: new SupabaseCloudRunnerBrokerTransport(config.baseUrl, config.publishableKey),
		backend,
		platform: config.platform,
		runnerVersion: config.runnerVersion,
		temporaryRoot: config.temporaryRoot,
		environment: config.environment,
		...(config.limits ? { limits: config.limits } : {}),
		...(config.idlePollMs !== undefined ? { idlePollMs: config.idlePollMs } : {}),
		...(config.leaseRenewalMs !== undefined ? { leaseRenewalMs: config.leaseRenewalMs } : {}),
		...(config.heartbeatMs !== undefined ? { heartbeatMs: config.heartbeatMs } : {}),
	});
	await (options.runWorker ? options.runWorker(worker, signal) : worker.run(signal));
}
