import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import { currentCloudCompanyTreeReference, materializeCloudCompanyTree } from "./cloud-company-snapshot.ts";
import type { ResolvedCompanySubstrateReference } from "./cloud-company-substrate.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { CloudRunnerCapability, CloudRunnerJob } from "./cloud-runner-control.ts";
import type { CloudRunnerModelBroker } from "./cloud-runner-model-socket.ts";
import { type CloudRunnerExecutionUsage, serializeCloudRunnerExecutionUsage } from "./cloud-runner-usage.ts";
import type {
	HostedArtifactIndex,
	HostedArtifactIndexEntry,
	HostedCompanyOperation,
	HostedCompanySnapshot,
	HostedCompanySubstrateVersion,
	HostedSessionEventType,
	HostedSessionExecutionIdentity,
} from "./hosted-primary.ts";

const EXECUTION_INPUT_SCHEMA = "qorpera.runner-input/v1";
const EXECUTION_CONTEXT_SCHEMA = "qorpera.runner-execution-context/v1";
const EXECUTION_RESULT_SCHEMA = "qorpera.runner-result/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_OUTPUT_ENTRIES = 10_000;
const MAX_OPERATION_LINE_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 512 * 1024;
const MAX_QUEUED_INPUT_LINE_BYTES = 256 * 1024;
const MAX_QUEUED_INPUT_IMAGES = 5;
const MAX_QUEUED_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const CONTAINER_INPUT_ROOT = "/qorpera/input";

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
	boundary: "test" | "rootless_container" | "virtual_machine" | "microvm";
	hostFilesystem: "none";
	inputFilesystem: "read_only";
	companyCheckout: "job_private";
	outputFilesystem: "job_private";
	network: "deny_by_default";
	environment: "allowlist_only";
	privileges: "unprivileged";
	resourceLimits: "kernel_enforced";
	termination: "boundary_destroyed";
}

export interface CloudRunnerSandboxInput {
	companyBaseRoot: string;
	companyRoot: string;
	proposalRoot?: string;
	executionContextPath: string;
	queuedInputsPath: string;
	transcriptPath: string;
	substrateManifestPath: string;
	operationsPath: string;
	artifactsRoot: string;
	attachmentsRoot: string;
}

export interface ResolvedCloudRunnerExecutionRun {
	runId: string;
	profileId: string;
	environmentId: string;
	sourceKind: "session_turn" | "wake" | "manual" | "room_delivery" | "proposal_review" | "system";
	sourceId: string;
	sessionId?: string;
	jobId: string;
	substrateVersionId: string;
	companySnapshotId: string;
	staffAgentId: string;
	staffVersion: number;
	inputIds: readonly string[];
	sponsorBindingId: string;
	sponsorVersion: number;
	requiredCapability: CloudRunnerCapability;
	jobType: string;
	payloadSha256: string;
	publicationMode: "automatic" | "review";
	reviewPolicyKey?: string;
	reviewerStaffIds: readonly string[];
	logicalComputerId?: string;
	computeIdentityId?: string;
	computeIdentityOwnershipKind?: "member" | "company" | "department" | "security_boundary";
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	workerClass?: "managed_sandbox" | "company_computer";
	transcriptStartSequence: number;
	status: string;
	createdByUserId: string;
	requestedByUserId?: string;
	sponsoredByUserId?: string;
	createdAt: string;
}

export interface ResolvedCloudRunnerExecutionSponsor {
	bindingId: string;
	version: number;
	kind: "member_connection" | "company_service_account" | "company_api_billing";
	providerConnectionId: string;
	providerConnectionVersion: number;
	provider: string;
	authenticationMode: "native_subscription" | "enterprise_access_token" | "api_key" | "cloud_service_account";
	nativeHarness: string;
	allowAutonomous: boolean;
}

export interface ResolvedCloudRunnerExecutionContext {
	run: ResolvedCloudRunnerExecutionRun;
	sponsor: ResolvedCloudRunnerExecutionSponsor;
	proposalSnapshot?: HostedCompanySnapshot;
}

export interface CloudRunnerCanonicalTranscriptEvent {
	sessionId: string;
	sequence: number;
	eventId: string;
	eventType: HostedSessionEventType;
	actorUserId: string;
	body: JsonValue;
	eventHash: string;
	previousHash?: string;
	execution?: HostedSessionExecutionIdentity;
	createdAt: string;
}

export interface CloudRunnerQueuedInput {
	inputId: string;
	position: number;
	kind: "kickoff" | "user_message";
	authorUserId: string;
	authorDisplayName: string;
	body: JsonValue;
	createdAt: string;
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
	hostBroker?: Readonly<{
		root: string;
		model: CloudRunnerModelBroker;
	}>;
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
	resolveExecution(job: CloudRunnerJob): Promise<ResolvedCloudRunnerExecutionContext>;
	listInputs(): Promise<CloudRunnerQueuedInput[]>;
	listTranscript(afterSequence?: number, limit?: number): Promise<CloudRunnerCanonicalTranscriptEvent[]>;
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

export interface CloudRunnerCompanyFilePublicationInput {
	profileId: string;
	environmentId: string;
	jobId: string;
	baseSnapshot: HostedCompanySnapshot;
	companyRoot: string;
	signal?: AbortSignal;
}

export interface CloudRunnerCompanyFilePublisher {
	publish(input: CloudRunnerCompanyFilePublicationInput): Promise<string | undefined>;
}

export interface ExecuteCloudRunnerJobOptions {
	job: CloudRunnerJob;
	substrate: CloudRunnerSubstrateResolver;
	objects: CloudContentAddressedStore;
	backend: CloudRunnerSandboxBackend;
	modelBroker?: CloudRunnerModelBroker;
	outputPublisher?: CloudRunnerOutputPublisher;
	companyFilePublisher?: CloudRunnerCompanyFilePublisher;
	limits?: Partial<CloudRunnerSandboxLimits>;
	environment?: Readonly<Record<string, string>>;
	temporaryRoot?: string;
	signal?: AbortSignal;
	allowTestBackend?: boolean;
	monotonicNow?: () => number;
}

export interface CloudRunnerExecutionResult {
	result: JsonValue;
	outputFiles: readonly CloudRunnerOutputFile[];
	outputBytes: number;
	usage: CloudRunnerExecutionUsage;
	outputSnapshotId?: string;
}

interface MaterializedCloudRunnerInput {
	input: CloudRunnerSandboxInput;
	version: HostedCompanySubstrateVersion;
	snapshot: HostedCompanySnapshot;
	sourceKind: ResolvedCloudRunnerExecutionRun["sourceKind"];
	artifactCount: number;
	inputBytes: number;
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
	requiredSafeInteger(
		limits.maxInputBytes,
		"Sandbox input bytes",
		1,
		DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS.maxInputBytes,
	);
	requiredSafeInteger(
		limits.maxOutputBytes,
		"Sandbox output bytes",
		0,
		DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS.maxOutputBytes,
	);
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
		guarantees.companyCheckout !== "job_private" ||
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
	if (
		guarantees.boundary !== "rootless_container" &&
		guarantees.boundary !== "virtual_machine" &&
		guarantees.boundary !== "microvm"
	) {
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

async function writeCanonicalTranscript(
	path: string,
	context: ResolvedCloudRunnerExecutionContext,
	resolver: CloudRunnerSubstrateResolver,
	initialInputBytes: number,
	maxInputBytes: number,
): Promise<number> {
	const file = await open(path, "wx", 0o400);
	let inputBytes = initialInputBytes;
	let sequence = 0;
	try {
		while (sequence < context.run.transcriptStartSequence) {
			const page = await resolver.listTranscript(sequence, 200);
			if (page.length === 0) throw new Error("Runner canonical transcript is incomplete");
			for (const event of page) {
				if (
					context.run.sessionId === undefined ||
					event.sessionId !== context.run.sessionId ||
					event.sequence !== sequence + 1 ||
					event.sequence > context.run.transcriptStartSequence
				) {
					throw new Error("Runner canonical transcript is outside its immutable run prefix");
				}
				const line = `${JSON.stringify(event)}\n`;
				const lineBytes = Buffer.byteLength(line);
				if (lineBytes > MAX_TRANSCRIPT_LINE_BYTES) {
					throw new Error("Runner canonical transcript event exceeds its byte limit");
				}
				inputBytes = assertInputBudget(inputBytes, lineBytes, maxInputBytes);
				await file.write(line);
				sequence = event.sequence;
			}
		}
	} finally {
		await file.close();
	}
	return inputBytes;
}

async function writeQueuedInputs(
	path: string,
	attachmentsRoot: string,
	profileId: string,
	context: ResolvedCloudRunnerExecutionContext,
	resolver: CloudRunnerSubstrateResolver,
	objects: Pick<CloudContentAddressedStore, "getObject">,
	initialInputBytes: number,
	maxInputBytes: number,
): Promise<number> {
	const inputs = await resolver.listInputs();
	if (
		inputs.length !== context.run.inputIds.length ||
		inputs.some((input, index) => input.inputId !== context.run.inputIds[index])
	) {
		throw new Error("Runner queued inputs do not match the immutable run");
	}
	await mkdir(attachmentsRoot, { recursive: true });
	const file = await open(path, "wx", 0o400);
	let inputBytes = initialInputBytes;
	let previousPosition = 0;
	try {
		for (const input of inputs) {
			if (
				input.position <= previousPosition ||
				(input.kind !== "kickoff" && input.kind !== "user_message") ||
				!Number.isFinite(Date.parse(input.createdAt))
			) {
				throw new Error("Runner queued inputs are invalid");
			}
			const body =
				input.body && typeof input.body === "object" && !Array.isArray(input.body)
					? (input.body as Record<string, JsonValue>)
					: undefined;
			const images = body?.images ?? (input.kind === "kickoff" ? [] : undefined);
			if (!Array.isArray(images) || images.length > MAX_QUEUED_INPUT_IMAGES) {
				throw new Error("Runner queued input images are invalid");
			}
			const materializedImages: Array<{
				objectSha256: string;
				bytes: number;
				mediaType: string;
				path: string;
			}> = [];
			for (let index = 0; index < images.length; index++) {
				const candidate = images[index];
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
					throw new Error("Runner queued input image is invalid");
				}
				const image = candidate as Record<string, JsonValue>;
				if (
					typeof image.objectSha256 !== "string" ||
					!SHA256_PATTERN.test(image.objectSha256) ||
					!Number.isSafeInteger(image.bytes) ||
					(image.bytes as number) < 1 ||
					(image.bytes as number) > MAX_QUEUED_INPUT_IMAGE_BYTES ||
					typeof image.mediaType !== "string" ||
					!/^image\/[a-z0-9.+-]{1,64}$/i.test(image.mediaType)
				) {
					throw new Error("Runner queued input image is invalid");
				}
				const relativePath = `${input.inputId}/${String(index + 1).padStart(2, "0")}-${image.objectSha256}`;
				const content = await objects.getObject(profileId, {
					sha256: image.objectSha256,
					bytes: image.bytes as number,
					mediaType: image.mediaType,
				});
				inputBytes = assertInputBudget(inputBytes, content.byteLength, maxInputBytes);
				const physicalPath = join(attachmentsRoot, ...relativePath.split("/"));
				await mkdir(dirname(physicalPath), { recursive: true });
				await writeFile(physicalPath, content, { mode: 0o400, flag: "wx" });
				materializedImages.push({
					objectSha256: image.objectSha256,
					bytes: image.bytes as number,
					mediaType: image.mediaType,
					path: `${CONTAINER_INPUT_ROOT}/attachments/${relativePath}`,
				});
			}
			const line = `${JSON.stringify({ ...input, materializedImages })}\n`;
			const lineBytes = Buffer.byteLength(line);
			if (lineBytes > MAX_QUEUED_INPUT_LINE_BYTES) {
				throw new Error("Runner queued input exceeds its byte limit");
			}
			inputBytes = assertInputBudget(inputBytes, lineBytes, maxInputBytes);
			await file.write(line);
			previousPosition = input.position;
		}
	} finally {
		await file.close();
	}
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
	const [resolvedSubstrate, execution] = await Promise.all([
		options.substrate.resolve(job.substrateVersionId),
		options.substrate.resolveExecution(job),
	]);
	const { version, snapshot, artifactIndex } = resolvedSubstrate;
	const proposalSnapshot = execution.proposalSnapshot;
	const jobPayload = job.payload as Record<string, JsonValue>;
	const proposalPayload =
		jobPayload.proposal_snapshot &&
		typeof jobPayload.proposal_snapshot === "object" &&
		!Array.isArray(jobPayload.proposal_snapshot)
			? (jobPayload.proposal_snapshot as Record<string, JsonValue>)
			: undefined;
	const computeOwnershipIsValid =
		execution.run.computeIdentityId === undefined
			? execution.run.computeIdentityOwnershipKind === undefined &&
				execution.run.computeIdentityOwnerUserId === undefined &&
				execution.run.computeIdentityOwnerScopeKey === undefined
			: execution.run.computeIdentityOwnershipKind === "member"
				? execution.run.computeIdentityOwnerUserId !== undefined &&
					execution.run.computeIdentityOwnerScopeKey === undefined &&
					execution.sponsor.kind === "member_connection" &&
					execution.run.sponsoredByUserId === execution.run.computeIdentityOwnerUserId
				: execution.run.computeIdentityOwnershipKind === "company"
					? execution.run.computeIdentityOwnerUserId === undefined &&
						execution.run.computeIdentityOwnerScopeKey === undefined &&
						execution.sponsor.kind !== "member_connection"
					: (execution.run.computeIdentityOwnershipKind === "department" ||
							execution.run.computeIdentityOwnershipKind === "security_boundary") &&
						execution.run.computeIdentityOwnerUserId === undefined &&
						execution.run.computeIdentityOwnerScopeKey !== undefined &&
						execution.sponsor.kind !== "member_connection";
	if (
		job.runId === undefined ||
		job.assignmentId === undefined ||
		execution.run.runId !== job.runId ||
		execution.run.jobId !== job.jobId ||
		execution.run.profileId !== job.profileId ||
		execution.run.environmentId !== job.environmentId ||
		execution.run.sessionId !== job.sessionId ||
		execution.run.substrateVersionId !== job.substrateVersionId ||
		execution.run.companySnapshotId !== snapshot.snapshotId ||
		!UUID_PATTERN.test(execution.run.staffAgentId) ||
		new Set(execution.run.inputIds).size !== execution.run.inputIds.length ||
		execution.run.inputIds.some((inputId) => !UUID_PATTERN.test(inputId)) ||
		(execution.run.sourceKind === "session_turn") !== execution.run.inputIds.length > 0 ||
		execution.run.requiredCapability !== job.requiredCapability ||
		execution.run.jobType !== job.jobType ||
		execution.run.sponsorBindingId !== execution.sponsor.bindingId ||
		execution.run.sponsorVersion !== execution.sponsor.version ||
		!SHA256_PATTERN.test(execution.run.payloadSha256) ||
		(execution.run.publicationMode !== "automatic" && execution.run.publicationMode !== "review") ||
		(execution.run.publicationMode === "automatic" &&
			(execution.run.reviewPolicyKey !== undefined || execution.run.reviewerStaffIds.length > 0)) ||
		(execution.run.publicationMode === "review" &&
			(!execution.run.reviewPolicyKey || execution.run.reviewerStaffIds.length === 0)) ||
		new Set(execution.run.reviewerStaffIds).size !== execution.run.reviewerStaffIds.length ||
		execution.run.reviewerStaffIds.some((staffAgentId) => !UUID_PATTERN.test(staffAgentId)) ||
		(execution.run.logicalComputerId !== undefined && !UUID_PATTERN.test(execution.run.logicalComputerId)) ||
		(execution.run.computeIdentityId !== undefined && !UUID_PATTERN.test(execution.run.computeIdentityId)) ||
		(execution.run.computeIdentityOwnerUserId !== undefined &&
			!UUID_PATTERN.test(execution.run.computeIdentityOwnerUserId)) ||
		!computeOwnershipIsValid ||
		(execution.run.workerClass !== undefined &&
			execution.run.workerClass !== "managed_sandbox" &&
			execution.run.workerClass !== "company_computer") ||
		(execution.run.requestedByUserId !== undefined && !UUID_PATTERN.test(execution.run.requestedByUserId)) ||
		(execution.run.sponsoredByUserId !== undefined && !UUID_PATTERN.test(execution.run.sponsoredByUserId)) ||
		(execution.sponsor.authenticationMode === "native_subscription" &&
			(execution.run.computeIdentityId === undefined || execution.run.requestedByUserId === undefined)) ||
		!Number.isSafeInteger(execution.run.transcriptStartSequence) ||
		execution.run.transcriptStartSequence < 0 ||
		(execution.run.sessionId === undefined && execution.run.transcriptStartSequence !== 0) ||
		(execution.run.sourceKind === "session_turn" && execution.run.sessionId === undefined) ||
		(execution.run.sourceKind === "proposal_review") !== (proposalSnapshot !== undefined) ||
		(execution.run.sourceKind === "proposal_review" &&
			(jobPayload.schema !== "qorpera.company-proposal-review/v1" ||
				proposalPayload?.snapshot_id !== proposalSnapshot?.snapshotId)) ||
		(proposalSnapshot !== undefined &&
			(proposalSnapshot.profileId !== job.profileId ||
				proposalSnapshot.environmentId !== job.environmentId ||
				proposalSnapshot.tree.contractVersion !== 3)) ||
		(execution.run.sourceKind !== "session_turn" && !execution.sponsor.allowAutonomous) ||
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
	const companyBaseRoot = join(inputRoot, "company");
	const companyRoot = join(executionRoot, "work", "company");
	const proposalRoot = proposalSnapshot ? join(inputRoot, "proposal") : undefined;
	const artifactsRoot = join(inputRoot, "artifacts");
	const attachmentsRoot = join(inputRoot, "attachments");
	const executionContextPath = join(inputRoot, "execution.json");
	const queuedInputsPath = join(inputRoot, "inputs.jsonl");
	const transcriptPath = join(inputRoot, "transcript.jsonl");
	const operationsPath = join(inputRoot, "operations.jsonl");
	const substrateManifestPath = join(inputRoot, "substrate.json");
	await mkdir(inputRoot, { recursive: true });
	await materializeCloudCompanyTree(
		companyBaseRoot,
		job.profileId,
		currentCloudCompanyTreeReference(snapshot.tree),
		options.objects,
	);
	await cp(companyBaseRoot, companyRoot, { recursive: true, force: false, errorOnExist: true });
	if (proposalSnapshot && proposalRoot) {
		inputBytes = assertInputBudget(inputBytes, proposalSnapshot.tree.totalBytes, limits.maxInputBytes);
		await materializeCloudCompanyTree(
			proposalRoot,
			job.profileId,
			currentCloudCompanyTreeReference(proposalSnapshot.tree),
			options.objects,
		);
	}
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
	inputBytes = await writeQueuedInputs(
		queuedInputsPath,
		attachmentsRoot,
		job.profileId,
		execution,
		options.substrate,
		options.objects,
		artifacts.inputBytes,
		limits.maxInputBytes,
	);
	inputBytes = await writeCanonicalTranscript(
		transcriptPath,
		execution,
		options.substrate,
		inputBytes,
		limits.maxInputBytes,
	);
	const encodedExecution = `${JSON.stringify({ schema: EXECUTION_CONTEXT_SCHEMA, ...execution })}\n`;
	inputBytes = assertInputBudget(inputBytes, Buffer.byteLength(encodedExecution), limits.maxInputBytes);
	await writeFile(executionContextPath, encodedExecution, { encoding: "utf-8", mode: 0o400, flag: "wx" });
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
		proposalSnapshotId: proposalSnapshot?.snapshotId ?? null,
		proposalTreeManifestSha256: proposalSnapshot?.tree.manifestSha256 ?? null,
	};
	const encodedManifest = `${JSON.stringify(manifest)}\n`;
	inputBytes = assertInputBudget(inputBytes, Buffer.byteLength(encodedManifest), limits.maxInputBytes);
	await writeFile(substrateManifestPath, encodedManifest, { encoding: "utf-8", mode: 0o400, flag: "wx" });
	return {
		input: {
			companyBaseRoot,
			companyRoot,
			...(proposalRoot ? { proposalRoot } : {}),
			executionContextPath,
			queuedInputsPath,
			transcriptPath,
			substrateManifestPath,
			operationsPath,
			artifactsRoot,
			attachmentsRoot,
		},
		version,
		snapshot,
		sourceKind: execution.run.sourceKind,
		artifactCount: artifacts.artifactCount,
		inputBytes,
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
		const brokerRoot = join(executionRoot, "broker");
		if (options.modelBroker) await mkdir(brokerRoot, { mode: 0o700 });
		const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
		const executionStartedAt = monotonicNow();
		if (!Number.isFinite(executionStartedAt)) throw new Error("Runner monotonic clock is invalid");
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
			...(options.modelBroker
				? { hostBroker: Object.freeze({ root: brokerRoot, model: options.modelBroker }) }
				: {}),
			environment: Object.freeze({ ...environment }),
			limits: Object.freeze({ ...limits }),
		});
		const backendResult = await waitForSandbox(processHandle, limits.wallTimeMs, options.signal);
		const executionFinishedAt = monotonicNow();
		if (!Number.isFinite(executionFinishedAt) || executionFinishedAt < executionStartedAt) {
			throw new Error("Runner monotonic clock is invalid");
		}
		assertJsonBytes(backendResult, "Sandbox result", limits.maxResultBytes);
		const resultBytes = Buffer.byteLength(JSON.stringify(backendResult));
		const outputFiles = await collectOutputs(outputRoot, limits.maxOutputBytes);
		if (materialized.sourceKind === "proposal_review" && outputFiles.length > 0) {
			throw new Error("Proposal review executions cannot publish artifacts");
		}
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
		const outputSnapshotId =
			materialized.sourceKind !== "proposal_review" && options.companyFilePublisher
				? await options.companyFilePublisher.publish({
						profileId: options.job.profileId,
						environmentId: options.job.environmentId,
						jobId: options.job.jobId,
						baseSnapshot: materialized.snapshot,
						companyRoot: materialized.input.companyRoot,
						...(options.signal ? { signal: options.signal } : {}),
					})
				: undefined;
		const usage: CloudRunnerExecutionUsage = {
			executionMs: Math.max(1, Math.ceil(executionFinishedAt - executionStartedAt)),
			inputBytes: materialized.inputBytes,
			outputBytes,
			resultBytes,
			limits: {
				wallTimeMs: limits.wallTimeMs,
				memoryBytes: limits.memoryBytes,
				cpuMillis: Math.ceil(limits.cpuCount * 1000),
				maxPids: limits.maxPids,
				maxInputBytes: limits.maxInputBytes,
				maxOutputBytes: limits.maxOutputBytes,
				maxResultBytes: limits.maxResultBytes,
			},
		};
		const result: JsonValue = {
			schema: EXECUTION_RESULT_SCHEMA,
			backend: options.backend.backendId,
			substrate_version_id: materialized.version.versionId,
			backend_result: backendResult,
			output_count: outputFiles.length,
			output_bytes: outputBytes,
			publication,
			usage: serializeCloudRunnerExecutionUsage(usage),
		};
		assertJsonBytes(result, "Runner completion result", 64 * 1024);
		return { result, outputFiles, outputBytes, usage, ...(outputSnapshotId ? { outputSnapshotId } : {}) };
	} finally {
		assertDisposableRoot(temporaryBase, executionRoot);
		await rm(executionRoot, { recursive: true, force: true });
	}
}
