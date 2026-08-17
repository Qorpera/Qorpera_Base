import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@qorpera/pi-protocol";
import type { ResolvedCompanySubstrateReference } from "./cloud-company-substrate.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "./cloud-object-store.ts";
import type { CloudRunnerCapability, CloudRunnerJob } from "./cloud-runner-control.ts";
import type {
	CloudRunnerOutputPublicationInput,
	CloudRunnerOutputPublisher,
	CloudRunnerSubstrateResolver,
} from "./cloud-runner-sandbox.ts";
import type {
	HostedArtifact,
	HostedArtifactIndex,
	HostedArtifactIndexEntry,
	HostedCompanyOperation,
	HostedCompanyOperationType,
	HostedCompanySnapshot,
	HostedCompanySubstrateVersion,
} from "./hosted-primary.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_OBJECTS = 100;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CloudRunnerBrokerAuthority {
	runnerId: string;
	jobId: string;
	sessionToken: string;
	leaseToken: string;
}

export interface CloudRunnerBrokerDescription {
	job: CloudRunnerJob;
	version: HostedCompanySubstrateVersion;
	snapshot: HostedCompanySnapshot;
	artifactIndex?: HostedArtifactIndex;
	outputLimits: {
		maxObjectBytes: number;
		maxObjectCount: number;
		maxTotalBytes: number;
		rootContract: "qorpera.object/v1";
	};
}

export interface RegisterCloudRunnerArtifactInput {
	clientArtifactId: string;
	artifactType: string;
	name: string;
	objectSha256: string;
	bytes: number;
	mediaType: string;
}

export interface CloudRunnerBrokerTransport {
	describe(authority: CloudRunnerBrokerAuthority): Promise<unknown>;
	listOperations(authority: CloudRunnerBrokerAuthority, afterSequence: number, limit: number): Promise<unknown>;
	listArtifacts(authority: CloudRunnerBrokerAuthority, afterOrdinal: number, limit: number): Promise<unknown>;
	getObject(authority: CloudRunnerBrokerAuthority, sha256: string): Promise<Uint8Array>;
	putObject(
		authority: CloudRunnerBrokerAuthority,
		sha256: string,
		bytes: Uint8Array,
		mediaType: string,
	): Promise<"exists" | "stored">;
	registerArtifact(authority: CloudRunnerBrokerAuthority, input: RegisterCloudRunnerArtifactInput): Promise<unknown>;
}

export interface CloudRunnerJobBrokerOptions {
	job: CloudRunnerJob;
	runnerId: string;
	credentials: () => { sessionToken: string; leaseToken: string };
	transport: CloudRunnerBrokerTransport;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Runner broker returned invalid ${label}`);
	return value as Record<string, unknown>;
}

function array(value: unknown, label: string, maximum = 500): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`Runner broker returned invalid ${label}`);
	return value;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new Error(`Runner broker returned invalid ${label}`);
	}
	return value;
}

function sha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`Runner broker returned invalid ${label}`);
	}
	return value;
}

function text(value: unknown, label: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		value.length < 1 ||
		value.length > maximum ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error(`Runner broker returned invalid ${label}`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner broker returned invalid ${label}`);
	}
	return value as number;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Runner broker returned invalid ${label}`);
	}
	return new Date(value).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : timestamp(value, label);
}

function optionalUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : uuid(value, label);
}

function operationType(value: unknown): HostedCompanyOperationType {
	if (value !== "staff_state" && value !== "session_state" && value !== "session_event") {
		throw new Error("Runner broker returned invalid company operation type");
	}
	return value;
}

function capability(value: unknown): CloudRunnerCapability {
	if (value !== "agent_turn" && value !== "git_worktree" && value !== "company_substrate") {
		throw new Error("Runner broker returned invalid job capability");
	}
	return value;
}

function json(value: unknown, label: string): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) {
		throw new Error(`Runner broker returned invalid ${label}`);
	}
	return value as JsonValue;
}

function parseBrokerJob(value: unknown): CloudRunnerJob {
	const input = record(value, "job");
	if (input.status !== "leased") throw new Error("Runner broker returned an inactive job");
	const payload = json(input.payload, "job payload");
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Runner broker returned invalid job payload");
	}
	const jobType = text(input.job_type, "job type", 64);
	if (!TYPE_PATTERN.test(jobType)) throw new Error("Runner broker returned invalid job type");
	const sessionId = optionalUuid(input.session_id, "job session id");
	const startedAt = optionalTimestamp(input.started_at, "job start time");
	if (
		integer(input.output_artifact_count, "job output artifact count", 0, 100) !== 0 ||
		input.output_artifact_index_id !== null ||
		input.output_substrate_version_id !== null
	) {
		throw new Error("Runner broker returned an already published job");
	}
	return {
		jobId: uuid(input.job_id, "job id"),
		profileId: uuid(input.profile_id, "job profile id"),
		environmentId: uuid(input.environment_id, "job environment id"),
		...(sessionId ? { sessionId } : {}),
		substrateVersionId: uuid(input.substrate_version_id, "job substrate id"),
		clientJobId: uuid(input.client_job_id, "job client id"),
		requiredCapability: capability(input.required_capability),
		jobType,
		payload,
		status: "leased",
		attemptCount: integer(input.attempt_count, "job attempt count", 1, 1000),
		runnerId: uuid(input.runner_id, "job runner id"),
		outputArtifactCount: 0,
		createdByUserId: uuid(input.created_by_user_id, "job creator id"),
		createdAt: timestamp(input.created_at, "job creation time"),
		...(startedAt ? { startedAt } : {}),
		leaseExpiresAt: timestamp(input.lease_expires_at, "job lease expiry"),
	};
}

function parseVersion(value: unknown): HostedCompanySubstrateVersion {
	const input = record(value, "substrate version");
	return {
		versionId: uuid(input.version_id, "substrate version id"),
		profileId: uuid(input.profile_id, "substrate profile id"),
		environmentId: uuid(input.environment_id, "substrate environment id"),
		companySnapshotId: uuid(input.company_snapshot_id, "substrate snapshot id"),
		clientVersionId: uuid(input.client_version_id, "substrate client version id"),
		contractVersion: integer(input.contract_version, "substrate contract version", 1, 1),
		operationSequence: integer(input.operation_sequence, "substrate operation sequence", 0, Number.MAX_SAFE_INTEGER),
		operationCount: integer(input.operation_count, "substrate operation count", 0, Number.MAX_SAFE_INTEGER),
		...(optionalUuid(input.artifact_index_id, "substrate artifact index id")
			? { artifactIndexId: uuid(input.artifact_index_id, "substrate artifact index id") }
			: {}),
		...(input.artifact_manifest_sha256 === null || input.artifact_manifest_sha256 === undefined
			? {}
			: { artifactManifestSha256: sha256(input.artifact_manifest_sha256, "substrate artifact manifest hash") }),
		contentSha256: sha256(input.content_sha256, "substrate content hash"),
		createdByUserId: uuid(input.created_by_user_id, "substrate creator id"),
		createdAt: timestamp(input.created_at, "substrate creation time"),
	};
}

function parseSnapshot(value: unknown): HostedCompanySnapshot {
	const input = record(value, "company snapshot");
	const parentSnapshotId = optionalUuid(input.parent_snapshot_id, "company parent snapshot id");
	return {
		snapshotId: uuid(input.snapshot_id, "company snapshot id"),
		profileId: uuid(input.profile_id, "company snapshot profile id"),
		environmentId: uuid(input.environment_id, "company snapshot environment id"),
		workspaceId: uuid(input.workspace_id, "company snapshot workspace id"),
		clientSnapshotId: uuid(input.client_snapshot_id, "company client snapshot id"),
		...(parentSnapshotId ? { parentSnapshotId } : {}),
		tree: {
			manifestSha256: sha256(input.tree_manifest_sha256, "company tree manifest hash"),
			manifestBytes: integer(input.tree_manifest_bytes, "company tree manifest bytes", 1, 8 * 1024 * 1024),
			contractVersion: integer(input.tree_contract_version, "company tree contract version", 1, 1),
			fileCount: integer(input.file_count, "company tree file count", 0, 50_000),
			totalBytes: integer(input.total_bytes, "company tree total bytes", 0, Number.MAX_SAFE_INTEGER),
		},
		createdByUserId: uuid(input.created_by_user_id, "company snapshot creator id"),
		createdAt: timestamp(input.created_at, "company snapshot creation time"),
	};
}

function parseArtifactIndex(value: unknown): HostedArtifactIndex {
	const input = record(value, "artifact index");
	integer(input.contract_version, "artifact index contract version", 1, 1);
	return {
		indexId: uuid(input.index_id, "artifact index id"),
		profileId: uuid(input.profile_id, "artifact index profile id"),
		environmentId: uuid(input.environment_id, "artifact index environment id"),
		clientIndexId: uuid(input.client_index_id, "artifact index client id"),
		contractVersion: 1,
		contentSha256: sha256(input.content_sha256, "artifact index content hash"),
		artifactCount: integer(input.artifact_count, "artifact index count", 0, 5000),
		totalBytes: integer(input.total_bytes, "artifact index bytes", 0, Number.MAX_SAFE_INTEGER),
		createdByUserId: uuid(input.created_by_user_id, "artifact index creator id"),
		createdAt: timestamp(input.created_at, "artifact index creation time"),
	};
}

function parseArtifact(value: unknown): HostedArtifact {
	const input = record(value, "artifact");
	const rootContract = input.root_contract;
	if (rootContract !== "qorpera.object/v1" && rootContract !== "qorpera.cloud-file-manifest/v1") {
		throw new Error("Runner broker returned invalid artifact root contract");
	}
	const artifactType = text(input.artifact_type, "artifact type", 64);
	if (!TYPE_PATTERN.test(artifactType)) throw new Error("Runner broker returned invalid artifact type");
	const mediaType = text(input.media_type, "artifact media type", 256).toLowerCase();
	if (!mediaType.includes("/") || mediaType !== input.media_type) {
		throw new Error("Runner broker returned invalid artifact media type");
	}
	const sessionId = optionalUuid(input.session_id, "artifact session id");
	return {
		artifactId: uuid(input.artifact_id, "artifact id"),
		profileId: uuid(input.profile_id, "artifact profile id"),
		environmentId: uuid(input.environment_id, "artifact environment id"),
		clientArtifactId: uuid(input.client_artifact_id, "artifact client id"),
		...(sessionId ? { sessionId } : {}),
		artifactType,
		name: text(input.name, "artifact name", 256),
		rootObjectSha256: sha256(input.root_object_sha256, "artifact root hash"),
		rootContract,
		contentSha256: sha256(input.content_sha256, "artifact content hash"),
		bytes: integer(input.bytes, "artifact bytes", 0, Number.MAX_SAFE_INTEGER),
		mediaType,
		createdByUserId: uuid(input.created_by_user_id, "artifact creator id"),
		createdAt: timestamp(input.created_at, "artifact creation time"),
		eligibleForGcAt: timestamp(input.eligible_for_gc_at, "artifact recovery expiry"),
	};
}

function parseOperation(value: unknown): HostedCompanyOperation {
	const input = record(value, "company operation");
	const environmentId = optionalUuid(input.environment_id, "company operation environment id");
	return {
		profileId: uuid(input.profile_id, "company operation profile id"),
		sequence: integer(input.sequence, "company operation sequence", 1, Number.MAX_SAFE_INTEGER),
		...(environmentId ? { environmentId } : {}),
		operationType: operationType(input.operation_type),
		entityId: uuid(input.entity_id, "company operation entity id"),
		entityVersion: integer(input.entity_version, "company operation entity version", 1, Number.MAX_SAFE_INTEGER),
		contentSha256: sha256(input.content_sha256, "company operation content hash"),
		payload: json(input.payload, "company operation payload"),
		actorUserId: uuid(input.actor_user_id, "company operation actor id"),
		createdAt: timestamp(input.created_at, "company operation creation time"),
	};
}

export function parseCloudRunnerBrokerDescription(value: unknown): CloudRunnerBrokerDescription {
	const input = record(value, "description");
	const limits = record(input.output_limits, "output limits");
	if (limits.root_contract !== "qorpera.object/v1") {
		throw new Error("Runner broker returned unsupported output root contract");
	}
	return {
		job: parseBrokerJob(input.job),
		version: parseVersion(input.version),
		snapshot: parseSnapshot(input.snapshot),
		...(input.artifact_index === null || input.artifact_index === undefined
			? {}
			: { artifactIndex: parseArtifactIndex(input.artifact_index) }),
		outputLimits: {
			maxObjectBytes: integer(limits.max_object_bytes, "output object bytes", 0, MAX_OBJECT_BYTES),
			maxObjectCount: integer(limits.max_object_count, "output object count", 0, MAX_OUTPUT_OBJECTS),
			maxTotalBytes: integer(limits.max_total_bytes, "output total bytes", 0, MAX_OUTPUT_BYTES),
			rootContract: limits.root_contract,
		},
	};
}

function requiredAuthority(authority: CloudRunnerBrokerAuthority): void {
	if (!UUID_PATTERN.test(authority.runnerId) || !UUID_PATTERN.test(authority.jobId)) {
		throw new Error("Runner broker authority has an invalid identity");
	}
	if (!TOKEN_PATTERN.test(authority.sessionToken) || !TOKEN_PATTERN.test(authority.leaseToken)) {
		throw new Error("Runner broker authority has an invalid credential");
	}
}

function requiredMediaType(mediaType: string): string {
	const normalized = mediaType.trim().toLowerCase();
	if (!normalized || normalized.length > 256 || !normalized.includes("/") || /[\0\r\n]/.test(normalized)) {
		throw new Error("Runner broker media type is invalid");
	}
	return normalized;
}

export class SupabaseCloudRunnerBrokerTransport implements CloudRunnerBrokerTransport {
	readonly #url: string;
	readonly #publishableKey: string;
	readonly #fetch: typeof fetch;

	constructor(baseUrl: string, publishableKey: string, fetchImplementation: typeof fetch = fetch) {
		const url = new URL("/functions/v1/runner-broker", baseUrl);
		if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
			throw new Error("Runner broker URL must use HTTPS");
		}
		if (!publishableKey.trim()) throw new Error("Runner broker publishable key is required");
		this.#url = url.href;
		this.#publishableKey = publishableKey;
		this.#fetch = fetchImplementation;
	}

	async describe(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		return this.#post(authority, { action: "describe" });
	}

	async listOperations(authority: CloudRunnerBrokerAuthority, afterSequence: number, limit: number): Promise<unknown> {
		return this.#post(authority, { action: "operations", afterSequence, limit });
	}

	async listArtifacts(authority: CloudRunnerBrokerAuthority, afterOrdinal: number, limit: number): Promise<unknown> {
		return this.#post(authority, { action: "artifacts", afterOrdinal, limit });
	}

	async getObject(authority: CloudRunnerBrokerAuthority, objectSha256: string): Promise<Uint8Array> {
		requiredAuthority(authority);
		sha256(objectSha256, "object hash");
		const response = await this.#fetch(this.#url, {
			method: "GET",
			headers: this.#headers(authority, objectSha256),
		});
		if (!response.ok) throw new Error(`Runner broker object read failed (${response.status})`);
		if (response.headers.get("x-qorpera-object-sha256") !== objectSha256) {
			throw new Error("Runner broker object read returned an inconsistent hash");
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async putObject(
		authority: CloudRunnerBrokerAuthority,
		objectSha256: string,
		bytes: Uint8Array,
		mediaType: string,
	): Promise<"exists" | "stored"> {
		requiredAuthority(authority);
		sha256(objectSha256, "object hash");
		if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error("Runner broker output object exceeds 8 MiB");
		const response = await this.#fetch(this.#url, {
			method: "PUT",
			headers: {
				...this.#headers(authority, objectSha256),
				"content-length": String(bytes.byteLength),
				"content-type": requiredMediaType(mediaType),
			},
			body: Uint8Array.from(bytes).buffer,
		});
		if (!response.ok) throw new Error(`Runner broker object write failed (${response.status})`);
		const envelope = record(await response.json(), "object write response");
		const value = record(envelope.value, "object write result");
		if (value.status !== "exists" && value.status !== "stored") {
			throw new Error("Runner broker object write returned invalid status");
		}
		if (value.sha256 !== objectSha256 || value.bytes !== bytes.byteLength) {
			throw new Error("Runner broker object write returned inconsistent metadata");
		}
		return value.status;
	}

	async registerArtifact(
		authority: CloudRunnerBrokerAuthority,
		input: RegisterCloudRunnerArtifactInput,
	): Promise<unknown> {
		return this.#post(authority, {
			action: "register_artifact",
			clientArtifactId: input.clientArtifactId,
			artifactType: input.artifactType,
			name: input.name,
			objectSha256: input.objectSha256,
			bytes: input.bytes,
			mediaType: input.mediaType,
		});
	}

	#headers(authority: CloudRunnerBrokerAuthority, objectSha256?: string): Record<string, string> {
		requiredAuthority(authority);
		return {
			accept: "application/json",
			apikey: this.#publishableKey,
			authorization: `Bearer ${authority.sessionToken}`,
			"x-qorpera-job-id": authority.jobId,
			"x-qorpera-lease-token": authority.leaseToken,
			...(objectSha256 ? { "x-qorpera-object-sha256": objectSha256 } : {}),
			"x-qorpera-runner-id": authority.runnerId,
		};
	}

	async #post(authority: CloudRunnerBrokerAuthority, body: Record<string, unknown>): Promise<unknown> {
		const response = await this.#fetch(this.#url, {
			method: "POST",
			headers: { ...this.#headers(authority), "content-type": "application/json" },
			body: JSON.stringify({ ...body, runnerId: authority.runnerId, jobId: authority.jobId }),
		});
		if (!response.ok) throw new Error(`Runner broker request failed (${response.status})`);
		return record(await response.json(), "response").value;
	}
}

export class CloudRunnerJobBroker implements CloudRunnerSubstrateResolver {
	readonly #options: CloudRunnerJobBrokerOptions;
	#description?: CloudRunnerBrokerDescription;
	readonly objects: CloudContentAddressedStore;

	constructor(options: CloudRunnerJobBrokerOptions) {
		if (
			options.job.status !== "leased" ||
			options.job.runnerId !== options.runnerId ||
			!options.job.leaseExpiresAt ||
			!UUID_PATTERN.test(options.runnerId)
		) {
			throw new Error("Runner broker requires an actively leased job");
		}
		this.#options = options;
		this.objects = new CloudContentAddressedStore(new CloudRunnerBrokerObjectTransport(this));
	}

	async describe(): Promise<CloudRunnerBrokerDescription> {
		if (this.#description) return this.#description;
		const description = parseCloudRunnerBrokerDescription(await this.#options.transport.describe(this.#authority()));
		if (
			description.job.jobId !== this.#options.job.jobId ||
			description.job.runnerId !== this.#options.runnerId ||
			description.job.status !== "leased" ||
			description.version.versionId !== this.#options.job.substrateVersionId ||
			description.version.profileId !== this.#options.job.profileId ||
			description.version.environmentId !== this.#options.job.environmentId ||
			description.snapshot.snapshotId !== description.version.companySnapshotId ||
			description.snapshot.profileId !== description.version.profileId ||
			description.snapshot.environmentId !== description.version.environmentId ||
			description.version.artifactIndexId !== description.artifactIndex?.indexId ||
			description.version.artifactManifestSha256 !== description.artifactIndex?.contentSha256
		) {
			throw new Error("Runner broker returned another job substrate");
		}
		this.#description = description;
		return description;
	}

	async resolve(versionId: string): Promise<ResolvedCompanySubstrateReference> {
		const description = await this.describe();
		if (versionId !== description.version.versionId)
			throw new Error("Runner broker cannot resolve another substrate");
		return {
			version: description.version,
			snapshot: description.snapshot,
			...(description.artifactIndex ? { artifactIndex: description.artifactIndex } : {}),
		};
	}

	async listOperations(
		version: HostedCompanySubstrateVersion,
		afterSequence = 0,
		limit = 200,
	): Promise<HostedCompanyOperation[]> {
		const description = await this.describe();
		if (version.versionId !== description.version.versionId) {
			throw new Error("Runner broker cannot list operations for another substrate");
		}
		return array(
			await this.#options.transport.listOperations(this.#authority(), afterSequence, limit),
			"company operation page",
		).map(parseOperation);
	}

	async listArtifacts(index: HostedArtifactIndex, afterOrdinal = 0, limit = 200): Promise<HostedArtifactIndexEntry[]> {
		const description = await this.describe();
		if (index.indexId !== description.artifactIndex?.indexId) {
			throw new Error("Runner broker cannot list another artifact index");
		}
		return array(
			await this.#options.transport.listArtifacts(this.#authority(), afterOrdinal, limit),
			"artifact page",
		).map((value) => {
			const input = record(value, "artifact index entry");
			return { ...parseArtifact(input), ordinal: integer(input.ordinal, "artifact ordinal", 1, 5000) };
		});
	}

	async registerArtifact(input: RegisterCloudRunnerArtifactInput): Promise<HostedArtifact> {
		const artifact = parseArtifact(await this.#options.transport.registerArtifact(this.#authority(), input));
		if (
			artifact.profileId !== this.#options.job.profileId ||
			artifact.environmentId !== this.#options.job.environmentId ||
			artifact.clientArtifactId !== input.clientArtifactId ||
			artifact.rootObjectSha256 !== input.objectSha256 ||
			artifact.rootContract !== "qorpera.object/v1" ||
			artifact.contentSha256 !== input.objectSha256 ||
			artifact.bytes !== input.bytes
		) {
			throw new Error("Runner broker registered an inconsistent artifact");
		}
		return artifact;
	}

	async profileId(): Promise<string> {
		return (await this.describe()).version.profileId;
	}

	async readObject(objectSha256: string): Promise<Uint8Array> {
		return this.#options.transport.getObject(this.#authority(), objectSha256);
	}

	async writeObject(objectSha256: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored"> {
		return this.#options.transport.putObject(this.#authority(), objectSha256, bytes, mediaType);
	}

	#authority(): CloudRunnerBrokerAuthority {
		const credentials = this.#options.credentials();
		const authority = {
			runnerId: this.#options.runnerId,
			jobId: this.#options.job.jobId,
			sessionToken: credentials.sessionToken,
			leaseToken: credentials.leaseToken,
		};
		requiredAuthority(authority);
		return authority;
	}
}

class CloudRunnerBrokerObjectTransport implements CloudObjectTransport {
	readonly #broker: CloudRunnerJobBroker;

	constructor(broker: CloudRunnerJobBroker) {
		this.#broker = broker;
	}

	async put(path: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored"> {
		const sha = await this.#pathSha(path);
		return this.#broker.writeObject(sha, bytes, mediaType);
	}

	async get(path: string): Promise<Uint8Array> {
		const sha = await this.#pathSha(path);
		return this.#broker.readObject(sha);
	}

	async #pathSha(path: string): Promise<string> {
		const profileId = await this.#broker.profileId();
		const prefix = `${profileId}/`;
		if (!path.startsWith(prefix) || path.indexOf("/", prefix.length) !== -1) {
			throw new Error("Runner broker object path is outside its job profile");
		}
		return sha256(path.slice(prefix.length), "object path hash");
	}
}

function deterministicArtifactId(jobId: string, path: string, contentSha256: string): string {
	const bytes = createHash("sha256").update(`qorpera.runner-output/v1:${jobId}:${path}:${contentSha256}`).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex", 0, 16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function outputPath(root: string, path: string): string {
	if (!path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Runner output publication path is invalid");
	}
	const absolute = resolve(root, ...path.split("/"));
	const child = relative(resolve(root), absolute);
	if (!child || child === ".." || child.startsWith(`..${sep}`)) {
		throw new Error("Runner output publication path escapes its root");
	}
	return absolute;
}

export class CloudRunnerBrokerOutputPublisher implements CloudRunnerOutputPublisher {
	readonly #broker: CloudRunnerJobBroker;

	constructor(broker: CloudRunnerJobBroker) {
		this.#broker = broker;
	}

	async publish(input: CloudRunnerOutputPublicationInput): Promise<JsonValue> {
		const description = await this.#broker.describe();
		if (
			input.profileId !== description.version.profileId ||
			input.environmentId !== description.version.environmentId ||
			input.jobId !== description.job.jobId ||
			input.substrateVersionId !== description.version.versionId ||
			input.files.length > description.outputLimits.maxObjectCount
		) {
			throw new Error("Runner output publication is outside its leased job");
		}
		const physicalRoot = await realpath(input.outputRoot);
		let totalBytes = 0;
		const artifacts: HostedArtifact[] = [];
		for (const file of input.files) {
			if (file.bytes > description.outputLimits.maxObjectBytes) {
				throw new Error("Runner output file exceeds the broker object limit");
			}
			totalBytes += file.bytes;
			if (!Number.isSafeInteger(totalBytes) || totalBytes > description.outputLimits.maxTotalBytes) {
				throw new Error("Runner output exceeds the broker job limit");
			}
			const absolutePath = outputPath(physicalRoot, file.path);
			const entryStat = await lstat(absolutePath);
			if (
				!entryStat.isFile() ||
				entryStat.isSymbolicLink() ||
				entryStat.nlink !== 1 ||
				entryStat.size !== file.bytes
			) {
				throw new Error("Runner output changed before publication");
			}
			const bytes = await readFile(absolutePath);
			if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
				throw new Error("Runner output changed before publication");
			}
			const object = await this.#broker.objects.putObject(input.profileId, bytes, "application/octet-stream");
			const outputName = basename(file.path).slice(0, 256);
			artifacts.push(
				await this.#broker.registerArtifact({
					clientArtifactId: deterministicArtifactId(input.jobId, file.path, object.sha256),
					artifactType: "runner_output",
					name: outputName,
					objectSha256: object.sha256,
					bytes: object.bytes,
					mediaType: object.mediaType,
				}),
			);
		}
		return {
			artifacts: artifacts.map((artifact) => ({
				artifact_id: artifact.artifactId,
				name: artifact.name,
				content_sha256: artifact.contentSha256,
				bytes: artifact.bytes,
			})),
		};
	}
}
