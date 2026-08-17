import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { JsonValue } from "@qorpera/pi-protocol";

const REQUEST_SCHEMA = "qorpera.ephemeral-container-request/v1";
const RESULT_SCHEMA = "qorpera.sandbox-probe-result/v1";
const PROOF_SCHEMA = "qorpera.sandbox-probe-proof/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_INDEX_BYTES = 1024 * 1024;

export const CLOUD_RUNNER_CONTAINER_PATHS = Object.freeze({
	companyRoot: "/qorpera/input/company",
	substrateManifestPath: "/qorpera/input/substrate.json",
	operationsPath: "/qorpera/input/operations.jsonl",
	artifactsRoot: "/qorpera/input/artifacts",
	outputRoot: "/qorpera/output",
});

export interface CloudRunnerContainerHostPaths {
	companyRoot: string;
	substrateManifestPath: string;
	operationsPath: string;
	artifactsRoot: string;
	outputRoot: string;
}

interface SandboxProbeRequest {
	jobId: string;
	versionId: string;
	contentSha256: string;
	operationCount: number;
	artifactCount: number;
	memoryBytes: number;
	cpuCount: number;
	maxPids: number;
	assertions: {
		inputReadOnly: boolean;
		rootReadOnly: boolean;
		networkIsolated: boolean;
		resourceLimits: boolean;
	};
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function safeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
	return value as number;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const keys = new Set(allowed);
	if (Object.keys(input).some((key) => !keys.has(key))) throw new Error(`${label} contains an unknown field`);
}

function assertion(value: unknown, label: string): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
	return value;
}

function parseRequest(value: unknown): SandboxProbeRequest {
	const input = record(value, "Container request");
	if (input.schema !== REQUEST_SCHEMA) throw new Error("Container request schema is unsupported");
	const job = record(input.job, "Container job");
	const substrate = record(input.substrate, "Container substrate");
	const paths = record(input.paths, "Container paths");
	const limits = record(input.limits, "Container limits");
	const payload = record(job.payload, "Container job payload");
	exactKeys(payload, ["assertions"], "Container job payload");
	const requestedAssertions =
		payload.assertions === undefined ? {} : record(payload.assertions, "Container assertions");
	exactKeys(
		requestedAssertions,
		["input_read_only", "root_read_only", "network_isolated", "resource_limits"],
		"Container assertions",
	);
	if (
		job.jobType !== "sandbox_probe" ||
		job.requiredCapability !== "company_substrate" ||
		typeof job.jobId !== "string" ||
		!UUID_PATTERN.test(job.jobId) ||
		!Number.isSafeInteger(job.attemptCount) ||
		(job.attemptCount as number) < 1 ||
		!job.payload ||
		typeof job.payload !== "object" ||
		Array.isArray(job.payload)
	) {
		throw new Error("Container job is invalid or unsupported");
	}
	const encodedPayload = JSON.stringify(job.payload);
	if (encodedPayload === undefined || Buffer.byteLength(encodedPayload) > 64 * 1024) {
		throw new Error("Container job payload is invalid");
	}
	if (
		paths.companyRoot !== CLOUD_RUNNER_CONTAINER_PATHS.companyRoot ||
		paths.substrateManifestPath !== CLOUD_RUNNER_CONTAINER_PATHS.substrateManifestPath ||
		paths.operationsPath !== CLOUD_RUNNER_CONTAINER_PATHS.operationsPath ||
		paths.artifactsRoot !== CLOUD_RUNNER_CONTAINER_PATHS.artifactsRoot ||
		paths.outputRoot !== CLOUD_RUNNER_CONTAINER_PATHS.outputRoot
	) {
		throw new Error("Container paths are invalid");
	}
	if (
		typeof substrate.versionId !== "string" ||
		!UUID_PATTERN.test(substrate.versionId) ||
		typeof substrate.contentSha256 !== "string" ||
		!SHA256_PATTERN.test(substrate.contentSha256)
	) {
		throw new Error("Container substrate is invalid");
	}
	const maxResultBytes = safeInteger(limits.maxResultBytes, "Container result limit");
	if (maxResultBytes < 2 || maxResultBytes > 64 * 1024) throw new Error("Container result limit is invalid");
	const memoryBytes = safeInteger(limits.memoryBytes, "Container memory limit");
	const maxPids = safeInteger(limits.maxPids, "Container process limit");
	if (
		memoryBytes < 64 * 1024 * 1024 ||
		maxPids < 1 ||
		typeof limits.cpuCount !== "number" ||
		!Number.isFinite(limits.cpuCount) ||
		limits.cpuCount < 0.1 ||
		limits.cpuCount > 64
	) {
		throw new Error("Container resource limits are invalid");
	}
	return {
		jobId: job.jobId,
		versionId: substrate.versionId,
		contentSha256: substrate.contentSha256,
		operationCount: safeInteger(substrate.operationCount, "Container operation count"),
		artifactCount: safeInteger(substrate.artifactCount, "Container artifact count"),
		memoryBytes,
		cpuCount: limits.cpuCount,
		maxPids,
		assertions: {
			inputReadOnly: assertion(requestedAssertions.input_read_only, "Input read-only assertion"),
			rootReadOnly: assertion(requestedAssertions.root_read_only, "Root read-only assertion"),
			networkIsolated: assertion(requestedAssertions.network_isolated, "Network isolation assertion"),
			resourceLimits: assertion(requestedAssertions.resource_limits, "Resource-limit assertion"),
		},
	};
}

async function regularFile(path: string, maximumBytes: number, label: string): Promise<number> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
		throw new Error(`${label} is invalid`);
	}
	return metadata.size;
}

async function physicalDirectory(path: string, label: string): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
		throw new Error(`${label} is invalid`);
	}
}

async function jsonFile(path: string, maximumBytes: number, label: string): Promise<Record<string, unknown>> {
	await regularFile(path, maximumBytes, label);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(`${label} contains invalid JSON`, { cause: error });
	}
	return record(value, label);
}

async function assertWriteDenied(path: string, label: string): Promise<void> {
	try {
		await writeFile(path, "boundary probe\n", { encoding: "utf-8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS")
		) {
			return;
		}
		throw error;
	}
	await rm(path, { force: true });
	throw new Error(`${label} is writable`);
}

function assertNetworkIsolated(): void {
	for (const addresses of Object.values(networkInterfaces())) {
		if (addresses?.some((address) => !address.internal)) throw new Error("Container network is not isolated");
	}
}

async function assertResourceLimits(request: SandboxProbeRequest): Promise<void> {
	const [memory, processes, cpu] = await Promise.all([
		readFile("/sys/fs/cgroup/memory.max", "utf-8"),
		readFile("/sys/fs/cgroup/pids.max", "utf-8"),
		readFile("/sys/fs/cgroup/cpu.max", "utf-8"),
	]);
	if (memory.trim() !== String(request.memoryBytes) || processes.trim() !== String(request.maxPids)) {
		throw new Error("Container memory or process limit is not enforced");
	}
	const [quotaText, periodText, ...extra] = cpu.trim().split(/\s+/);
	const quota = Number(quotaText);
	const period = Number(periodText);
	if (
		extra.length > 0 ||
		!Number.isSafeInteger(quota) ||
		!Number.isSafeInteger(period) ||
		period < 1 ||
		Math.abs(quota / period - request.cpuCount) > 0.001
	) {
		throw new Error("Container CPU limit is not enforced");
	}
}

export async function runCloudRunnerContainerJob(
	value: unknown,
	hostPaths: CloudRunnerContainerHostPaths = CLOUD_RUNNER_CONTAINER_PATHS,
): Promise<JsonValue> {
	const request = parseRequest(value);
	await Promise.all([
		physicalDirectory(hostPaths.companyRoot, "Company input"),
		physicalDirectory(hostPaths.artifactsRoot, "Artifact input"),
		physicalDirectory(hostPaths.outputRoot, "Runner output"),
	]);
	const manifest = await jsonFile(hostPaths.substrateManifestPath, MAX_MANIFEST_BYTES, "Substrate manifest");
	if (
		manifest.schema !== "qorpera.runner-input/v1" ||
		manifest.versionId !== request.versionId ||
		manifest.contentSha256 !== request.contentSha256 ||
		manifest.operationCount !== request.operationCount ||
		manifest.artifactCount !== request.artifactCount
	) {
		throw new Error("Substrate manifest does not match the immutable job input");
	}
	const operationJournalBytes = await regularFile(
		hostPaths.operationsPath,
		Number.MAX_SAFE_INTEGER,
		"Operation journal",
	);
	const artifactIndexPath = `${hostPaths.artifactsRoot}/index.json`;
	const artifactIndexBytes = await regularFile(artifactIndexPath, MAX_ARTIFACT_INDEX_BYTES, "Artifact index");
	if (request.assertions.inputReadOnly) {
		await assertWriteDenied(`${hostPaths.companyRoot}/.qorpera-boundary-${request.jobId}`, "Container input");
	}
	if (request.assertions.rootReadOnly) {
		await assertWriteDenied(`/qorpera-boundary-${request.jobId}`, "Container root filesystem");
	}
	if (request.assertions.networkIsolated) assertNetworkIsolated();
	if (request.assertions.resourceLimits) await assertResourceLimits(request);
	const proof: JsonValue = {
		schema: PROOF_SCHEMA,
		job_id: request.jobId,
		substrate_version_id: request.versionId,
		company_mounted: true,
		operation_journal_bytes: operationJournalBytes,
		artifact_index_bytes: artifactIndexBytes,
		input_read_only: request.assertions.inputReadOnly ? true : null,
		root_read_only: request.assertions.rootReadOnly ? true : null,
		network_isolated: request.assertions.networkIsolated ? true : null,
		resource_limits: request.assertions.resourceLimits ? true : null,
	};
	await writeFile(`${hostPaths.outputRoot}/sandbox-proof.json`, `${JSON.stringify(proof)}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
	return {
		schema: RESULT_SCHEMA,
		status: "ok",
		job_id: request.jobId,
		substrate_version_id: request.versionId,
		proof_path: "sandbox-proof.json",
	};
}
