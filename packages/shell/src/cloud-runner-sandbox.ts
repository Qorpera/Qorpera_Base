import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@qorpera/pi-protocol";
import { currentCloudCompanyTreeReference, materializeCloudCompanyTree } from "./cloud-company-snapshot.ts";
import type { ResolvedCompanySubstrateReference } from "./cloud-company-substrate.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { CloudRunnerCapability, CloudRunnerJob } from "./cloud-runner-control.ts";
import type {
	HostedArtifactIndex,
	HostedArtifactIndexEntry,
	HostedCompanyOperation,
	HostedCompanySubstrateVersion,
} from "./hosted-primary.ts";

const EXECUTION_INPUT_SCHEMA = "qorpera.runner-input/v1";
const EXECUTION_RESULT_SCHEMA = "qorpera.runner-result/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_OUTPUT_ENTRIES = 10_000;
const MAX_OPERATION_LINE_BYTES = 64 * 1024;

export interface CloudRunnerSandboxLimits {
	wallTimeMs: number;
	memoryBytes: number;
	cpuCount: number;
	maxPids: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	maxResultBytes: number;
}

export const DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS: Readonly<CloudRunnerSandboxLimits> = Object.freeze({
	wallTimeMs: 30 * 60 * 1000,
	memoryBytes: 2 * 1024 * 1024 * 1024,
	cpuCount: 2,
	maxPids: 256,
	maxInputBytes: 16 * 1024 * 1024 * 1024,
	maxOutputBytes: 256 * 1024 * 1024,
	maxResultBytes: 32 * 1024,
});

export interface CloudRunnerSandboxGuarantees {
	boundary: "test" | "rootless_container" | "microvm";
	hostFilesystem: "none";
	inputFilesystem: "read_only";
	outputFilesystem: "job_private";
	network: "deny_by_default";
	environment: "allowlist_only";
	privileges: "unprivileged";
	resourceLimits: "kernel_enforced";
	termination: "boundary_destroyed";
}

export interface CloudRunnerSandboxInput {
	companyRoot: string;
	substrateManifestPath: string;
	operationsPath: string;
	artifactsRoot: string;
}

export interface CloudRunnerSandboxRequest {
	job: {
		jobId: string;
		jobType: string;
		requiredCapability: CloudRunnerCapability;
		attemptCount: number;
		payload: JsonValue;
	};
	substrate: {
		versionId: string;
		contentSha256: string;
		operationSequence: number;
		operationCount: number;
		artifactCount: number;
	};
	input: CloudRunnerSandboxInput;
	outputRoot: string;
	environment: Readonly<Record<string, string>>;
	limits: Readonly<CloudRunnerSandboxLimits>;
}

export interface CloudRunnerSandboxProcess {
	readonly result: Promise<JsonValue>;
	terminate(reason: "cancelled" | "deadline_exceeded"): Promise<void>;
}

export interface CloudRunnerSandboxBackend {
	readonly backendId: string;
	readonly guarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly capabilities: readonly CloudRunnerCapability[];
	readonly jobTypes: readonly string[];
	prepare?(): Promise<void>;
	start(request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess>;
}

export interface CloudRunnerSubstrateResolver {
	resolve(versionId: string): Promise<ResolvedCompanySubstrateReference>;
	listOperations(
		version: HostedCompanySubstrateVersion,
		afterSequence?: number,
		limit?: number,
	): Promise<HostedCompanyOperation[]>;
	listArtifacts(
		index: HostedArtifactIndex,
		afterOrdinal?: number,
		limit?: number,
	): Promise<HostedArtifactIndexEntry[]>;
}

export interface CloudRunnerOutputFile {
	path: string;
	sha256: string;
	bytes: number;
	executable: boolean;
}

export interface CloudRunnerOutputPublicationInput {
	profileId: string;
	environmentId: string;
	jobId: string;
	substrateVersionId: string;
	outputRoot: string;
	files: readonly CloudRunnerOutputFile[];
}

export interface CloudRunnerOutputPublisher {
	publish(input: CloudRunnerOutputPublicationInput): Promise<JsonValue>;
}

export interface ExecuteCloudRunnerJobOptions {
	job: CloudRunnerJob;
	substrate: CloudRunnerSubstrateResolver;
	objects: CloudContentAddressedStore;
	backend: CloudRunnerSandboxBackend;
	outputPublisher?: CloudRunnerOutputPublisher;
	limits?: Partial<CloudRunnerSandboxLimits>;
	environment?: Readonly<Record<string, string>>;
	temporaryRoot?: string;
	signal?: AbortSignal;
	allowTestBackend?: boolean;
}

export interface CloudRunnerExecutionResult {
	result: JsonValue;
	outputFiles: readonly CloudRunnerOutputFile[];
	outputBytes: number;
}

interface MaterializedCloudRunnerInput {
	input: CloudRunnerSandboxInput;
	version: HostedCompanySubstrateVersion;
	artifactCount: number;
}

function requiredSafeInteger(value: number, label: string, minimum: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} is outside the supported range`);
	}
}

function resolvedLimits(overrides: Partial<CloudRunnerSandboxLimits> | undefined): CloudRunnerSandboxLimits {
	const limits = { ...DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS, ...overrides };
	requiredSafeInteger(limits.wallTimeMs, "Sandbox wall time", 10, 24 * 60 * 60 * 1000);
	requiredSafeInteger(limits.memoryBytes, "Sandbox memory", 64 * 1024 * 1024, 256 * 1024 * 1024 * 1024);
	if (!Number.isFinite(limits.cpuCount) || limits.cpuCount < 0.1 || limits.cpuCount > 64) {
		throw new Error("Sandbox CPU count is outside the supported range");
	}
	requiredSafeInteger(limits.maxPids, "Sandbox process count", 1, 4096);
	requiredSafeInteger(limits.maxInputBytes, "Sandbox input bytes", 1, Number.MAX_SAFE_INTEGER);
	requiredSafeInteger(limits.maxOutputBytes, "Sandbox output bytes", 0, Number.MAX_SAFE_INTEGER);
	requiredSafeInteger(limits.maxResultBytes, "Sandbox result bytes", 2, 64 * 1024);
	return limits;
}

function assertBackend(options: ExecuteCloudRunnerJobOptions): void {
	const { backend, job } = options;
	if (!BACKEND_ID_PATTERN.test(backend.backendId)) throw new Error("Sandbox backend id is invalid");
	if (!backend.capabilities.includes(job.requiredCapability) || !backend.jobTypes.includes(job.jobType)) {
		throw new Error("Sandbox backend does not support this runner job");
	}
	if (
		new Set(backend.capabilities).size !== backend.capabilities.length ||
		new Set(backend.jobTypes).size !== backend.jobTypes.length
	) {
		throw new Error("Sandbox backend declares duplicate support entries");
	}
	if (backend.jobTypes.some((jobType) => !JOB_TYPE_PATTERN.test(jobType))) {
		throw new Error("Sandbox backend declares an invalid job type");
	}
	const guarantees = backend.guarantees;
	if (
		guarantees.hostFilesystem !== "none" ||
		guarantees.inputFilesystem !== "read_only" ||
		guarantees.outputFilesystem !== "job_private" ||
		guarantees.network !== "deny_by_default" ||
		guarantees.environment !== "allowlist_only" ||
		guarantees.privileges !== "unprivileged" ||
		guarantees.resourceLimits !== "kernel_enforced" ||
		guarantees.termination !== "boundary_destroyed"
	) {
		throw new Error("Sandbox backend does not provide the required isolation guarantees");
	}
	if (guarantees.boundary === "test") {
		if (!options.allowTestBackend) throw new Error("Test sandbox backend cannot execute untrusted runner work");
		return;
	}
	if (guarantees.boundary !== "rootless_container" && guarantees.boundary !== "microvm") {
		throw new Error("Sandbox backend does not provide a supported containment boundary");
	}
}

function assertJob(job: CloudRunnerJob): void {
	if (job.status !== "leased" || !job.runnerId || !job.leaseExpiresAt) {
		throw new Error("Runner job must hold an active lease before execution");
	}
	if (!JOB_TYPE_PATTERN.test(job.jobType)) throw new Error("Runner job type is invalid");
	const encodedPayload = JSON.stringify(job.payload);
	if (
		!job.payload ||
		typeof job.payload !== "object" ||
		Array.isArray(job.payload) ||
		encodedPayload === undefined ||
		Buffer.byteLength(encodedPayload) > 64 * 1024
	) {
		throw new Error("Runner job payload is invalid");
	}
}

function assertEnvironment(environment: Readonly<Record<string, string>>): void {
	for (const [key, value] of Object.entries(environment)) {
		if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || value.length > 4096 || /[\0\r\n]/.test(value)) {
			throw new Error("Sandbox environment contains an invalid entry");
		}
		if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|API_KEY/.test(key)) {
			throw new Error("Sandbox environment cannot contain credentials");
		}
	}
}

function assertInputBudget(currentBytes: number, addedBytes: number, maximum: number): number {
	const next = currentBytes + addedBytes;
	if (!Number.isSafeInteger(next) || next > maximum) throw new Error("Runner input exceeds its byte limit");
	return next;
}

function artifactFileReference(artifact: HostedArtifactIndexEntry): {
	manifestSha256: string;
	fileSha256: string;
	bytes: number;
	mediaType: string;
} {
	return {
		manifestSha256: artifact.rootObjectSha256,
		fileSha256: artifact.contentSha256,
		bytes: artifact.bytes,
		mediaType: artifact.mediaType,
	};
}

async function writeOperationJournal(
	path: string,
	version: HostedCompanySubstrateVersion,
	resolver: CloudRunnerSubstrateResolver,
	initialInputBytes: number,
	maxInputBytes: number,
): Promise<number> {
	const file = await open(path, "wx", 0o400);
	let inputBytes = initialInputBytes;
	let count = 0;
	let afterSequence = 0;
	try {
		while (count < version.operationCount) {
			const page = await resolver.listOperations(version, afterSequence, 200);
			if (page.length === 0) throw new Error("Runner substrate operation journal is incomplete");
			for (const operation of page) {
				if (operation.sequence <= afterSequence || operation.sequence > version.operationSequence) {
					throw new Error("Runner substrate operation journal is out of order");
				}
				const line = `${JSON.stringify(operation)}\n`;
				const lineBytes = Buffer.byteLength(line);
				if (lineBytes > MAX_OPERATION_LINE_BYTES)
					throw new Error("Runner substrate operation exceeds its byte limit");
				inputBytes = assertInputBudget(inputBytes, lineBytes, maxInputBytes);
				await file.write(line);
				afterSequence = operation.sequence;
				count++;
				if (count > version.operationCount) throw new Error("Runner substrate operation count is inconsistent");
			}
		}
	} finally {
		await file.close();
	}
	if (count !== version.operationCount) throw new Error("Runner substrate operation count is inconsistent");
	return inputBytes;
}

async function materializeArtifacts(
	root: string,
	profileId: string,
	environmentId: string,
	index: HostedArtifactIndex | undefined,
	resolver: CloudRunnerSubstrateResolver,
	objects: Pick<CloudContentAddressedStore, "getFile" | "getObject">,
	initialInputBytes: number,
	maxInputBytes: number,
): Promise<{ artifactCount: number; inputBytes: number }> {
	await mkdir(root, { recursive: true });
	if (!index) {
		await writeFile(join(root, "index.json"), "[]\n", { encoding: "utf-8", mode: 0o400, flag: "wx" });
		return { artifactCount: 0, inputBytes: initialInputBytes };
	}
	let inputBytes = initialInputBytes;
	let artifactBytes = 0;
	let afterOrdinal = 0;
	const metadata: Array<{
		ordinal: number;
		artifactId: string;
		artifactType: string;
		name: string;
		bytes: number;
		mediaType: string;
		contentSha256: string;
		path: string;
	}> = [];
	while (metadata.length < index.artifactCount) {
		const page = await resolver.listArtifacts(index, afterOrdinal, 200);
		if (page.length === 0) throw new Error("Runner substrate artifact index is incomplete");
		for (const artifact of page) {
			const expectedOrdinal = metadata.length + 1;
			if (
				artifact.ordinal !== expectedOrdinal ||
				artifact.profileId !== profileId ||
				artifact.environmentId !== environmentId ||
				!SHA256_PATTERN.test(artifact.rootObjectSha256) ||
				!SHA256_PATTERN.test(artifact.contentSha256)
			) {
				throw new Error("Runner substrate artifact index is inconsistent");
			}
			inputBytes = assertInputBudget(inputBytes, artifact.bytes, maxInputBytes);
			const bytes =
				artifact.rootContract === "qorpera.object/v1"
					? await objects.getObject(profileId, {
							sha256: artifact.rootObjectSha256,
							bytes: artifact.bytes,
							mediaType: artifact.mediaType,
						})
					: await objects.getFile(profileId, artifactFileReference(artifact));
			if (createHash("sha256").update(bytes).digest("hex") !== artifact.contentSha256) {
				throw new Error("Runner substrate artifact failed content verification");
			}
			const relativePath = `${String(artifact.ordinal).padStart(6, "0")}/content`;
			const contentPath = join(root, ...relativePath.split("/"));
			await mkdir(dirname(contentPath), { recursive: true });
			await writeFile(contentPath, bytes, { mode: 0o400, flag: "wx" });
			artifactBytes += bytes.byteLength;
			metadata.push({
				ordinal: artifact.ordinal,
				artifactId: artifact.artifactId,
				artifactType: artifact.artifactType,
				name: artifact.name,
				bytes: artifact.bytes,
				mediaType: artifact.mediaType,
				contentSha256: artifact.contentSha256,
				path: relativePath,
			});
			afterOrdinal = artifact.ordinal;
			if (metadata.length > index.artifactCount) throw new Error("Runner substrate artifact count is inconsistent");
		}
	}
	if (metadata.length !== index.artifactCount || artifactBytes !== index.totalBytes) {
		throw new Error("Runner substrate artifact index totals are inconsistent");
	}
	const encoded = `${JSON.stringify(metadata)}\n`;
	inputBytes = assertInputBudget(inputBytes, Buffer.byteLength(encoded), maxInputBytes);
	await writeFile(join(root, "index.json"), encoded, { encoding: "utf-8", mode: 0o400, flag: "wx" });
	return { artifactCount: metadata.length, inputBytes };
}

async function materializeInput(
	executionRoot: string,
	options: ExecuteCloudRunnerJobOptions,
	limits: CloudRunnerSandboxLimits,
): Promise<MaterializedCloudRunnerInput> {
	const { job } = options;
	const resolvedSubstrate = await options.substrate.resolve(job.substrateVersionId);
	const { version, snapshot, artifactIndex } = resolvedSubstrate;
	if (
		version.versionId !== job.substrateVersionId ||
		version.profileId !== job.profileId ||
		version.environmentId !== job.environmentId ||
		snapshot.snapshotId !== version.companySnapshotId ||
		snapshot.profileId !== job.profileId ||
		snapshot.environmentId !== job.environmentId ||
		version.contractVersion !== 1 ||
		!SHA256_PATTERN.test(version.contentSha256) ||
		version.artifactIndexId !== artifactIndex?.indexId ||
		version.artifactManifestSha256 !== artifactIndex?.contentSha256 ||
		(artifactIndex !== undefined &&
			(artifactIndex.profileId !== job.profileId || artifactIndex.environmentId !== job.environmentId))
	) {
		throw new Error("Runner job substrate is outside its immutable profile environment");
	}
	let inputBytes = assertInputBudget(0, snapshot.tree.totalBytes, limits.maxInputBytes);
	const inputRoot = join(executionRoot, "input");
	const companyRoot = join(inputRoot, "company");
	const artifactsRoot = join(inputRoot, "artifacts");
	const operationsPath = join(inputRoot, "operations.jsonl");
	const substrateManifestPath = join(inputRoot, "substrate.json");
	await mkdir(inputRoot, { recursive: true });
	await materializeCloudCompanyTree(
		companyRoot,
		job.profileId,
		currentCloudCompanyTreeReference(snapshot.tree),
		options.objects,
	);
	inputBytes = await writeOperationJournal(
		operationsPath,
		version,
		options.substrate,
		inputBytes,
		limits.maxInputBytes,
	);
	const artifacts = await materializeArtifacts(
		artifactsRoot,
		job.profileId,
		job.environmentId,
		artifactIndex,
		options.substrate,
		options.objects,
		inputBytes,
		limits.maxInputBytes,
	);
	const manifest = {
		schema: EXECUTION_INPUT_SCHEMA,
		profileId: job.profileId,
		environmentId: job.environmentId,
		jobId: job.jobId,
		versionId: version.versionId,
		contentSha256: version.contentSha256,
		snapshotId: snapshot.snapshotId,
		treeManifestSha256: snapshot.tree.manifestSha256,
		operationSequence: version.operationSequence,
		operationCount: version.operationCount,
		artifactIndexId: artifactIndex?.indexId ?? null,
		artifactCount: artifacts.artifactCount,
	};
	const encodedManifest = `${JSON.stringify(manifest)}\n`;
	assertInputBudget(artifacts.inputBytes, Buffer.byteLength(encodedManifest), limits.maxInputBytes);
	await writeFile(substrateManifestPath, encodedManifest, { encoding: "utf-8", mode: 0o400, flag: "wx" });
	return {
		input: { companyRoot, substrateManifestPath, operationsPath, artifactsRoot },
		version,
		artifactCount: artifacts.artifactCount,
	};
}

function normalizedOutputPath(path: string): string {
	const normalized = path.split(sep).join("/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		normalized.includes("\\") ||
		normalized.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("Sandbox output path is invalid");
	}
	return normalized;
}

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function collectOutputs(root: string, maximumBytes: number): Promise<CloudRunnerOutputFile[]> {
	const physicalRoot = await realpath(root);
	const files: CloudRunnerOutputFile[] = [];
	let totalBytes = 0;
	const visit = async (directory: string): Promise<void> => {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name, "en"),
		);
		for (const entry of entries) {
			const absolutePath = join(directory, entry.name);
			const entryStat = await lstat(absolutePath);
			if (entryStat.isSymbolicLink()) throw new Error("Sandbox output cannot contain links");
			const outputRelative = relative(physicalRoot, absolutePath);
			if (!outputRelative || outputRelative === ".." || outputRelative.startsWith(`..${sep}`)) {
				throw new Error("Sandbox output escapes its private directory");
			}
			if (entry.isDirectory() && entryStat.isDirectory()) {
				await visit(absolutePath);
				continue;
			}
			if (!entry.isFile() || !entryStat.isFile() || entryStat.nlink !== 1) {
				throw new Error("Sandbox output can contain only private physical files and directories");
			}
			totalBytes += entryStat.size;
			if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
				throw new Error("Sandbox output exceeds its byte limit");
			}
			files.push({
				path: normalizedOutputPath(outputRelative),
				sha256: await fileSha256(absolutePath),
				bytes: entryStat.size,
				executable: (entryStat.mode & 0o111) !== 0,
			});
			if (files.length > MAX_OUTPUT_ENTRIES) throw new Error("Sandbox output has too many files");
		}
	};
	await visit(root);
	return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function assertJsonBytes(value: JsonValue, label: string, maximum: number): void {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > maximum)
		throw new Error(`${label} exceeds its byte limit`);
}

async function waitForSandbox(
	processHandle: CloudRunnerSandboxProcess,
	wallTimeMs: number,
	signal: AbortSignal | undefined,
): Promise<JsonValue> {
	if (signal?.aborted) {
		await processHandle.terminate("cancelled");
		await processHandle.result.catch(() => undefined);
		throw new Error("Runner execution was cancelled");
	}
	let stopReason: "cancelled" | "deadline_exceeded" | undefined;
	let rejectStop: ((error: Error) => void) | undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		rejectStop = reject;
	});
	const timer = setTimeout(() => {
		stopReason = "deadline_exceeded";
		rejectStop?.(new Error("Runner execution exceeded its wall-time limit"));
	}, wallTimeMs);
	const abort = (): void => {
		stopReason = "cancelled";
		rejectStop?.(new Error("Runner execution was cancelled"));
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([processHandle.result, stopped]);
	} catch (error) {
		if (stopReason) {
			await processHandle.terminate(stopReason);
			await processHandle.result.catch(() => undefined);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

function assertDisposableRoot(base: string, root: string): void {
	const resolvedBase = resolve(base);
	const resolvedRoot = resolve(root);
	const child = relative(resolvedBase, resolvedRoot);
	if (
		!child ||
		child === ".." ||
		child.startsWith(`..${sep}`) ||
		basename(resolvedRoot).length <= "qorpera-runner-".length ||
		!basename(resolvedRoot).startsWith("qorpera-runner-")
	) {
		throw new Error("Runner disposable workspace path is invalid");
	}
}

export async function executeCloudRunnerJob(
	options: ExecuteCloudRunnerJobOptions,
): Promise<CloudRunnerExecutionResult> {
	assertJob(options.job);
	assertBackend(options);
	const environment = options.environment ?? {};
	assertEnvironment(environment);
	const limits = resolvedLimits(options.limits);
	if (options.signal?.aborted) throw new Error("Runner execution was cancelled");
	const temporaryBase = resolve(options.temporaryRoot ?? tmpdir());
	const baseStat = await stat(temporaryBase);
	if (!baseStat.isDirectory()) throw new Error("Runner temporary root must be a directory");
	const executionRoot = await mkdtemp(join(temporaryBase, "qorpera-runner-"));
	assertDisposableRoot(temporaryBase, executionRoot);
	try {
		const materialized = await materializeInput(executionRoot, options, limits);
		const outputRoot = join(executionRoot, "output");
		await mkdir(outputRoot, { recursive: true });
		const processHandle = await options.backend.start({
			job: {
				jobId: options.job.jobId,
				jobType: options.job.jobType,
				requiredCapability: options.job.requiredCapability,
				attemptCount: options.job.attemptCount,
				payload: structuredClone(options.job.payload),
			},
			substrate: {
				versionId: materialized.version.versionId,
				contentSha256: materialized.version.contentSha256,
				operationSequence: materialized.version.operationSequence,
				operationCount: materialized.version.operationCount,
				artifactCount: materialized.artifactCount,
			},
			input: materialized.input,
			outputRoot,
			environment: Object.freeze({ ...environment }),
			limits: Object.freeze({ ...limits }),
		});
		const backendResult = await waitForSandbox(processHandle, limits.wallTimeMs, options.signal);
		assertJsonBytes(backendResult, "Sandbox result", limits.maxResultBytes);
		const outputFiles = await collectOutputs(outputRoot, limits.maxOutputBytes);
		const outputBytes = outputFiles.reduce((total, file) => total + file.bytes, 0);
		const publication = options.outputPublisher
			? await options.outputPublisher.publish({
					profileId: options.job.profileId,
					environmentId: options.job.environmentId,
					jobId: options.job.jobId,
					substrateVersionId: materialized.version.versionId,
					outputRoot,
					files: outputFiles,
				})
			: null;
		const result: JsonValue = {
			schema: EXECUTION_RESULT_SCHEMA,
			backend: options.backend.backendId,
			substrate_version_id: materialized.version.versionId,
			backend_result: backendResult,
			output_count: outputFiles.length,
			output_bytes: outputBytes,
			publication,
		};
		assertJsonBytes(result, "Runner completion result", 64 * 1024);
		return { result, outputFiles, outputBytes };
	} finally {
		assertDisposableRoot(temporaryBase, executionRoot);
		await rm(executionRoot, { recursive: true, force: true });
	}
}
