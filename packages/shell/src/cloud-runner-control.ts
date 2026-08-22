import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@qorpera/pi-protocol";
import { type CloudRunnerBrokerTransport, CloudRunnerJobBroker } from "./cloud-runner-broker.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_JSON_BYTES = 64 * 1024;
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

export const CLOUD_RUNNER_CAPABILITIES = ["agent_turn", "git_worktree", "company_substrate"] as const;
export type CloudRunnerCapability = (typeof CLOUD_RUNNER_CAPABILITIES)[number];
export type CloudRunnerStatus = "pending" | "active" | "revoked";
export type CloudRunnerJobStatus = "queued" | "leased" | "completed" | "failed" | "cancelled";

export interface CloudRunner {
	runnerId: string;
	profileId: string;
	clientRunnerId: string;
	displayName: string;
	runnerKind: "local" | "qorpera_computer";
	capabilities: CloudRunnerCapability[];
	maxConcurrency: number;
	status: CloudRunnerStatus;
	online: boolean;
	platform?: string;
	runnerVersion?: string;
	activationExpiresAt: string;
	sessionExpiresAt?: string;
	registeredByUserId: string;
	createdAt: string;
	activatedAt?: string;
	lastSeenAt?: string;
	revokedByUserId?: string;
	revokedAt?: string;
	activeLeaseCount: number;
}

export interface CloudRunnerJob {
	jobId: string;
	runId?: string;
	profileId: string;
	environmentId: string;
	sessionId?: string;
	substrateVersionId: string;
	clientJobId: string;
	assignmentId?: string;
	requiredCapability: CloudRunnerCapability;
	jobType: string;
	payload: JsonValue;
	status: CloudRunnerJobStatus;
	attemptCount: number;
	runnerId?: string;
	result?: JsonValue;
	outputArtifactCount: number;
	outputArtifactIndexId?: string;
	outputSubstrateVersionId?: string;
	lastError?: string;
	createdByUserId: string;
	createdAt: string;
	startedAt?: string;
	leaseExpiresAt?: string;
	finishedAt?: string;
	cancelledByUserId?: string;
	cancelledAt?: string;
}

export const CLOUD_RUNNER_AUDIT_EVENTS = [
	"runner_registered",
	"runner_activated",
	"runner_revoked",
	"job_queued",
	"job_leased",
	"job_lease_renewed",
	"job_requeued",
	"job_completed",
	"job_failed",
	"job_cancelled",
] as const;
export type CloudRunnerAuditEvent = (typeof CLOUD_RUNNER_AUDIT_EVENTS)[number];

export interface CloudRunnerAuditReceipt {
	receiptId: number;
	profileId: string;
	runnerId?: string;
	jobId?: string;
	eventType: CloudRunnerAuditEvent;
	payload: JsonValue;
	actorUserId?: string;
	createdAt: string;
}

export interface CloudRunnerPairingSecret {
	activationToken: string;
	activationTokenSha256: string;
}

export type CloudRunnerControlRequest =
	| {
			action: "activate";
			runnerId: string;
			nextSessionToken: string;
			platform: string;
			runnerVersion: string;
	  }
	| { action: "heartbeat"; runnerId: string; nextSessionToken: string; renewalId: string }
	| {
			action: "accept";
			runnerId: string;
			assignmentId: string;
			jobId: string;
			assignmentCapability: string;
	  }
	| { action: "renew"; runnerId: string; jobId: string; leaseToken: string }
	| {
			action: "complete";
			runnerId: string;
			jobId: string;
			leaseToken: string;
			clientArtifactIndexId: string;
			clientSubstrateVersionId: string;
			outputSnapshotId?: string;
			result: JsonValue;
	  }
	| {
			action: "fail";
			runnerId: string;
			jobId: string;
			leaseToken: string;
			error: string;
			retryable: boolean;
	  };

export interface CloudRunnerControlTransport {
	request(token: string, body: CloudRunnerControlRequest): Promise<unknown>;
}

export interface CloudRunnerAssignmentAcceptance {
	assignmentId: string;
	jobId: string;
	capability: string;
}

export class CloudRunnerControlRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Runner control request failed (${status})`);
		this.name = "CloudRunnerControlRequestError";
		this.status = status;
	}
}

export function cloudRunnerControlRequestStatus(error: unknown): number | undefined {
	return error instanceof CloudRunnerControlRequestError ? error.status : undefined;
}

export interface CloudRunnerAuthorityStore {
	load(): Promise<unknown | undefined>;
	save(value: JsonValue): Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Runner control returned invalid ${label}`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value))
		throw new Error(`Runner control returned invalid ${label}`);
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return new Date(value).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : timestamp(value, label);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return value as number;
}

function capability(value: unknown): CloudRunnerCapability {
	if (!CLOUD_RUNNER_CAPABILITIES.some((candidate) => candidate === value)) {
		throw new Error("Runner control returned invalid capability");
	}
	return value as CloudRunnerCapability;
}

function json(value: unknown, label: string): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > MAX_JSON_BYTES) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return value as JsonValue;
}

function objectJson(value: unknown, label: string): JsonValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return json(value, label);
}

function optionalUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : uuid(value, label);
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return value;
}

export function parseCloudRunner(value: unknown): CloudRunner {
	const input = record(value, "runner");
	const capabilities = input.capabilities;
	if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 8) {
		throw new Error("Runner control returned invalid capabilities");
	}
	const parsedCapabilities = capabilities.map(capability);
	if (new Set(parsedCapabilities).size !== parsedCapabilities.length) {
		throw new Error("Runner control returned duplicate capabilities");
	}
	if (input.runner_kind !== "local" && input.runner_kind !== "qorpera_computer") {
		throw new Error("Runner control returned invalid kind");
	}
	if (input.status !== "pending" && input.status !== "active" && input.status !== "revoked") {
		throw new Error("Runner control returned invalid status");
	}
	if (typeof input.online !== "boolean") throw new Error("Runner control returned invalid online state");
	const sessionExpiresAt = optionalTimestamp(input.session_expires_at, "runner session expiry");
	if (input.online && (input.status !== "active" || !sessionExpiresAt)) {
		throw new Error("Runner control returned inconsistent online state");
	}
	return {
		runnerId: uuid(input.runner_id, "runner id"),
		profileId: uuid(input.profile_id, "runner profile id"),
		clientRunnerId: uuid(input.client_runner_id, "runner client id"),
		displayName: optionalText(input.display_name, "runner display name", 120) as string,
		runnerKind: input.runner_kind,
		capabilities: parsedCapabilities,
		maxConcurrency: boundedInteger(input.max_concurrency, "runner concurrency", 1, 16),
		status: input.status,
		online: input.online,
		...(optionalText(input.platform, "runner platform", 80) ? { platform: input.platform as string } : {}),
		...(optionalText(input.runner_version, "runner version", 80)
			? { runnerVersion: input.runner_version as string }
			: {}),
		activationExpiresAt: timestamp(input.activation_expires_at, "runner activation expiry"),
		...(sessionExpiresAt ? { sessionExpiresAt } : {}),
		registeredByUserId: uuid(input.registered_by_user_id, "runner registering user id"),
		createdAt: timestamp(input.created_at, "runner creation time"),
		...(optionalTimestamp(input.activated_at, "runner activation time")
			? { activatedAt: timestamp(input.activated_at, "runner activation time") }
			: {}),
		...(optionalTimestamp(input.last_seen_at, "runner last seen time")
			? { lastSeenAt: timestamp(input.last_seen_at, "runner last seen time") }
			: {}),
		...(optionalUuid(input.revoked_by_user_id, "runner revoking user id")
			? { revokedByUserId: uuid(input.revoked_by_user_id, "runner revoking user id") }
			: {}),
		...(optionalTimestamp(input.revoked_at, "runner revocation time")
			? { revokedAt: timestamp(input.revoked_at, "runner revocation time") }
			: {}),
		activeLeaseCount: boundedInteger(input.active_lease_count, "runner active lease count", 0, 16),
	};
}

export function parseCloudRunnerJob(value: unknown): CloudRunnerJob {
	const input = record(value, "runner job");
	if (
		input.status !== "queued" &&
		input.status !== "leased" &&
		input.status !== "completed" &&
		input.status !== "failed" &&
		input.status !== "cancelled"
	) {
		throw new Error("Runner control returned invalid job status");
	}
	if (typeof input.job_type !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.job_type)) {
		throw new Error("Runner control returned invalid job type");
	}
	const leaseExpiresAt = optionalTimestamp(input.lease_expires_at, "runner job lease expiry");
	if ((input.status === "leased") !== Boolean(leaseExpiresAt)) {
		throw new Error("Runner control returned inconsistent job lease");
	}
	const result =
		input.result === null || input.result === undefined ? undefined : objectJson(input.result, "runner job result");
	if ((input.status === "completed") !== Boolean(result)) {
		throw new Error("Runner control returned inconsistent job result");
	}
	const outputArtifactCount = boundedInteger(input.output_artifact_count, "runner job output artifact count", 0, 100);
	const outputArtifactIndexId = optionalUuid(input.output_artifact_index_id, "runner job output artifact index id");
	const outputSubstrateVersionId = optionalUuid(
		input.output_substrate_version_id,
		"runner job output substrate version id",
	);
	if (
		(outputArtifactCount === 0) !== (!outputArtifactIndexId && !outputSubstrateVersionId) ||
		(outputArtifactCount > 0 && (input.status !== "completed" || !outputArtifactIndexId || !outputSubstrateVersionId))
	) {
		throw new Error("Runner control returned inconsistent output substrate");
	}
	return {
		jobId: uuid(input.job_id, "runner job id"),
		...(optionalUuid(input.run_id, "runner execution run id")
			? { runId: uuid(input.run_id, "runner execution run id") }
			: {}),
		profileId: uuid(input.profile_id, "runner job profile id"),
		environmentId: uuid(input.environment_id, "runner job environment id"),
		...(optionalUuid(input.session_id, "runner job session id")
			? { sessionId: uuid(input.session_id, "runner job session id") }
			: {}),
		substrateVersionId: uuid(input.substrate_version_id, "runner job substrate id"),
		clientJobId: uuid(input.client_job_id, "runner client job id"),
		...(optionalUuid(input.assignment_id, "runner assignment id")
			? { assignmentId: uuid(input.assignment_id, "runner assignment id") }
			: {}),
		requiredCapability: capability(input.required_capability),
		jobType: input.job_type,
		payload: objectJson(input.payload, "runner job payload"),
		status: input.status,
		attemptCount: boundedInteger(input.attempt_count, "runner job attempt count", 0, 1000),
		...(optionalUuid(input.runner_id, "runner job runner id")
			? { runnerId: uuid(input.runner_id, "runner job runner id") }
			: {}),
		...(result ? { result } : {}),
		outputArtifactCount,
		...(outputArtifactIndexId ? { outputArtifactIndexId } : {}),
		...(outputSubstrateVersionId ? { outputSubstrateVersionId } : {}),
		...(optionalText(input.last_error, "runner job error", 1000) ? { lastError: input.last_error as string } : {}),
		createdByUserId: uuid(input.created_by_user_id, "runner job creating user id"),
		createdAt: timestamp(input.created_at, "runner job creation time"),
		...(optionalTimestamp(input.started_at, "runner job start time")
			? { startedAt: timestamp(input.started_at, "runner job start time") }
			: {}),
		...(leaseExpiresAt ? { leaseExpiresAt } : {}),
		...(optionalTimestamp(input.finished_at, "runner job finish time")
			? { finishedAt: timestamp(input.finished_at, "runner job finish time") }
			: {}),
		...(optionalUuid(input.cancelled_by_user_id, "runner job cancelling user id")
			? { cancelledByUserId: uuid(input.cancelled_by_user_id, "runner job cancelling user id") }
			: {}),
		...(optionalTimestamp(input.cancelled_at, "runner job cancellation time")
			? { cancelledAt: timestamp(input.cancelled_at, "runner job cancellation time") }
			: {}),
	};
}

export function parseCloudRunnerAuditReceipt(value: unknown): CloudRunnerAuditReceipt {
	const input = record(value, "runner audit receipt");
	if (!CLOUD_RUNNER_AUDIT_EVENTS.some((candidate) => candidate === input.event_type)) {
		throw new Error("Runner control returned invalid audit event");
	}
	return {
		receiptId: boundedInteger(input.receipt_id, "runner audit receipt id", 1, Number.MAX_SAFE_INTEGER),
		profileId: uuid(input.profile_id, "runner audit profile id"),
		...(optionalUuid(input.runner_id, "runner audit runner id")
			? { runnerId: uuid(input.runner_id, "runner audit runner id") }
			: {}),
		...(optionalUuid(input.job_id, "runner audit job id")
			? { jobId: uuid(input.job_id, "runner audit job id") }
			: {}),
		eventType: input.event_type as CloudRunnerAuditEvent,
		payload: objectJson(input.payload, "runner audit payload"),
		...(optionalUuid(input.actor_user_id, "runner audit actor id")
			? { actorUserId: uuid(input.actor_user_id, "runner audit actor id") }
			: {}),
		createdAt: timestamp(input.created_at, "runner audit creation time"),
	};
}

export function createCloudRunnerPairingSecret(): CloudRunnerPairingSecret {
	const activationToken = randomBytes(32).toString("base64url");
	return {
		activationToken,
		activationTokenSha256: createHash("sha256").update(activationToken).digest("hex"),
	};
}

function createToken(): string {
	return randomBytes(32).toString("base64url");
}

function deterministicCompletionUuid(scope: "artifact-index" | "substrate-version", jobId: string): string {
	const bytes = createHash("sha256").update(`qorpera.runner-completion/v1:${scope}:${jobId}`).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex", 0, 16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requiredToken(value: string, label: string): void {
	if (!TOKEN_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

export class SupabaseCloudRunnerControlTransport implements CloudRunnerControlTransport {
	readonly #url: string;
	readonly #publishableKey: string;
	readonly #fetch: typeof fetch;
	readonly #signal?: AbortSignal;
	readonly #requestTimeoutMs: number;

	constructor(
		baseUrl: string,
		publishableKey: string,
		fetchImplementation: typeof fetch = fetch,
		options: { signal?: AbortSignal; requestTimeoutMs?: number } = {},
	) {
		const url = new URL("/functions/v1/runner-control", baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Runner control URL must use HTTPS");
		}
		if (!publishableKey.trim()) throw new Error("Runner control publishable key is required");
		this.#url = url.href;
		this.#publishableKey = publishableKey;
		this.#fetch = fetchImplementation;
		this.#signal = options.signal;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
			throw new Error("Runner control request timeout is invalid");
		}
	}

	async request(token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		requiredToken(token, "Runner token");
		const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
		const response = await this.#fetch(this.#url, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				apikey: this.#publishableKey,
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			signal: this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout,
		});
		if (!response.ok) throw new CloudRunnerControlRequestError(response.status);
		const envelope = record(await response.json(), "response");
		return envelope.value;
	}
}

interface PendingHeartbeat {
	nextToken: string;
	renewalId: string;
}

interface PendingAssignment {
	assignmentId: string;
	jobId: string;
	capability: string;
}

interface ActiveRunnerLease {
	job: CloudRunnerJob;
	leaseToken: string;
	pendingCompletion?: CloudRunnerCompletion;
}

export interface CloudRunnerCompletion {
	result: JsonValue;
	outputSnapshotId?: string;
}

interface RestoredRunnerAuthority {
	activationToken?: string;
	sessionToken?: string;
	pendingActivationToken?: string;
	pendingHeartbeat?: PendingHeartbeat;
	pendingAssignment?: PendingAssignment;
	runner?: CloudRunner;
	leases: ActiveRunnerLease[];
	consumedRepairSha256?: string;
}

function optionalToken(value: unknown, label: string): string | undefined {
	if (value === null || value === undefined) return undefined;
	return stateToken(value, label);
}

function stateToken(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Runner authority state contains invalid ${label}`);
	requiredToken(value, `Runner authority ${label}`);
	return value;
}

function storedRunner(runner: CloudRunner): JsonValue {
	return {
		runner_id: runner.runnerId,
		profile_id: runner.profileId,
		client_runner_id: runner.clientRunnerId,
		display_name: runner.displayName,
		runner_kind: runner.runnerKind,
		capabilities: [...runner.capabilities],
		max_concurrency: runner.maxConcurrency,
		status: runner.status,
		online: runner.online,
		platform: runner.platform ?? null,
		runner_version: runner.runnerVersion ?? null,
		activation_expires_at: runner.activationExpiresAt,
		session_expires_at: runner.sessionExpiresAt ?? null,
		registered_by_user_id: runner.registeredByUserId,
		created_at: runner.createdAt,
		activated_at: runner.activatedAt ?? null,
		last_seen_at: runner.lastSeenAt ?? null,
		revoked_by_user_id: runner.revokedByUserId ?? null,
		revoked_at: runner.revokedAt ?? null,
		active_lease_count: runner.activeLeaseCount,
	};
}

function storedJob(job: CloudRunnerJob): JsonValue {
	return {
		job_id: job.jobId,
		profile_id: job.profileId,
		environment_id: job.environmentId,
		session_id: job.sessionId ?? null,
		substrate_version_id: job.substrateVersionId,
		client_job_id: job.clientJobId,
		required_capability: job.requiredCapability,
		job_type: job.jobType,
		payload: structuredClone(job.payload),
		status: job.status,
		attempt_count: job.attemptCount,
		runner_id: job.runnerId ?? null,
		result: job.result !== undefined ? structuredClone(job.result) : null,
		output_artifact_count: job.outputArtifactCount,
		output_artifact_index_id: job.outputArtifactIndexId ?? null,
		output_substrate_version_id: job.outputSubstrateVersionId ?? null,
		last_error: job.lastError ?? null,
		created_by_user_id: job.createdByUserId,
		created_at: job.createdAt,
		started_at: job.startedAt ?? null,
		lease_expires_at: job.leaseExpiresAt ?? null,
		finished_at: job.finishedAt ?? null,
		cancelled_by_user_id: job.cancelledByUserId ?? null,
		cancelled_at: job.cancelledAt ?? null,
	};
}

function parseRunnerAuthorityState(value: unknown, runnerId: string): RestoredRunnerAuthority {
	const input = record(value, "authority state");
	if (input.schema !== "qorpera.runner-authority/v3" || uuid(input.runner_id, "authority runner id") !== runnerId) {
		throw new Error("Runner authority state has an invalid identity");
	}
	const activationToken = optionalToken(input.activation_token, "activation token");
	const sessionToken = optionalToken(input.session_token, "session token");
	const pendingActivationToken = optionalToken(input.pending_activation_token, "pending activation token");
	let pendingHeartbeat: PendingHeartbeat | undefined;
	if (input.pending_heartbeat !== null && input.pending_heartbeat !== undefined) {
		const pending = record(input.pending_heartbeat, "pending heartbeat");
		pendingHeartbeat = {
			nextToken: stateToken(pending.next_token, "pending heartbeat token"),
			renewalId: uuid(pending.renewal_id, "pending heartbeat renewal id"),
		};
	}
	let pendingAssignment: PendingAssignment | undefined;
	if (input.pending_assignment !== null && input.pending_assignment !== undefined) {
		const pending = record(input.pending_assignment, "pending assignment");
		pendingAssignment = {
			assignmentId: uuid(pending.assignment_id, "pending assignment id"),
			jobId: uuid(pending.job_id, "pending assignment job id"),
			capability: stateToken(pending.capability, "pending assignment capability"),
		};
	}
	let consumedRepairSha256: string | undefined;
	if (input.consumed_repair_sha256 !== null && input.consumed_repair_sha256 !== undefined) {
		if (typeof input.consumed_repair_sha256 !== "string" || !SHA256_PATTERN.test(input.consumed_repair_sha256)) {
			throw new Error("Runner authority state has an invalid repair record");
		}
		consumedRepairSha256 = input.consumed_repair_sha256;
	}
	const runner = input.runner === null || input.runner === undefined ? undefined : parseCloudRunner(input.runner);
	if (!Array.isArray(input.leases)) throw new Error("Runner authority state contains invalid leases");
	const leases = input.leases.map((value): ActiveRunnerLease => {
		const lease = record(value, "stored lease");
		const job = parseCloudRunnerJob(lease.job);
		let pendingCompletion: CloudRunnerCompletion | undefined;
		if (lease.pending_completion !== null && lease.pending_completion !== undefined) {
			const pending = record(lease.pending_completion, "stored completion");
			pendingCompletion = {
				result: objectJson(pending.result, "stored completion result"),
				...(optionalUuid(pending.output_snapshot_id, "stored completion snapshot id")
					? { outputSnapshotId: uuid(pending.output_snapshot_id, "stored completion snapshot id") }
					: {}),
			};
		}
		return {
			job,
			leaseToken: stateToken(lease.lease_token, "stored lease token"),
			...(pendingCompletion ? { pendingCompletion } : {}),
		};
	});
	if (
		Boolean(activationToken) === Boolean(sessionToken) ||
		(Boolean(pendingActivationToken) && !activationToken) ||
		(Boolean(pendingHeartbeat) || Boolean(pendingAssignment) || Boolean(runner) || leases.length > 0) !==
			Boolean(sessionToken) ||
		(runner !== undefined && runner.runnerId !== runnerId) ||
		new Set(leases.map((lease) => lease.job.jobId)).size !== leases.length ||
		leases.some(
			(lease) =>
				lease.job.status !== "leased" ||
				lease.job.runnerId !== runnerId ||
				!lease.job.leaseExpiresAt ||
				(lease.pendingCompletion !== undefined && !lease.job.leaseExpiresAt),
		)
	) {
		throw new Error("Runner authority state is inconsistent");
	}
	return {
		...(activationToken ? { activationToken } : {}),
		...(sessionToken ? { sessionToken } : {}),
		...(pendingActivationToken ? { pendingActivationToken } : {}),
		...(pendingHeartbeat ? { pendingHeartbeat } : {}),
		...(pendingAssignment ? { pendingAssignment } : {}),
		...(runner ? { runner } : {}),
		leases,
		...(consumedRepairSha256 ? { consumedRepairSha256 } : {}),
	};
}

export interface DisposableCloudRunnerSnapshot {
	runnerId: string;
	active: boolean;
	sessionExpiresAt?: string;
	activeJobIds: string[];
}

export class DisposableCloudRunner {
	readonly #transport: CloudRunnerControlTransport;
	readonly #runnerId: string;
	readonly #authorityStore?: CloudRunnerAuthorityStore;
	#activationToken?: string;
	#sessionToken?: string;
	#pendingActivationToken?: string;
	#pendingHeartbeat?: PendingHeartbeat;
	#pendingAssignment?: PendingAssignment;
	#runner?: CloudRunner;
	#consumedRepairSha256?: string;
	readonly #leases = new Map<string, ActiveRunnerLease>();
	#persistTail: Promise<void> = Promise.resolve();

	constructor(
		transport: CloudRunnerControlTransport,
		runnerId: string,
		activationToken: string,
		authorityStore?: CloudRunnerAuthorityStore,
	) {
		if (!UUID_PATTERN.test(runnerId)) throw new Error("Runner id is invalid");
		requiredToken(activationToken, "Runner activation token");
		this.#transport = transport;
		this.#runnerId = runnerId;
		this.#activationToken = activationToken;
		this.#authorityStore = authorityStore;
	}

	static async open(
		transport: CloudRunnerControlTransport,
		runnerId: string,
		authorityStore: CloudRunnerAuthorityStore,
		activationToken?: string,
	): Promise<DisposableCloudRunner> {
		if (!UUID_PATTERN.test(runnerId)) throw new Error("Runner id is invalid");
		const stored = await authorityStore.load();
		if (stored === undefined) {
			if (!activationToken) throw new Error("Runner activation token is required for initial setup");
			const created = new DisposableCloudRunner(transport, runnerId, activationToken, authorityStore);
			await created.#persist();
			return created;
		}
		if (activationToken) throw new Error("Runner authority is already initialized");
		const restored = parseRunnerAuthorityState(stored, runnerId);
		const instance = new DisposableCloudRunner(
			transport,
			runnerId,
			restored.activationToken ?? createToken(),
			authorityStore,
		);
		instance.#activationToken = restored.activationToken;
		instance.#sessionToken = restored.sessionToken;
		instance.#pendingActivationToken = restored.pendingActivationToken;
		instance.#pendingHeartbeat = restored.pendingHeartbeat;
		instance.#pendingAssignment = restored.pendingAssignment;
		instance.#runner = restored.runner;
		instance.#consumedRepairSha256 = restored.consumedRepairSha256;
		for (const lease of restored.leases) instance.#leases.set(lease.job.jobId, lease);
		return instance;
	}

	static async repair(
		transport: CloudRunnerControlTransport,
		runnerId: string,
		authorityStore: CloudRunnerAuthorityStore,
		activationToken: string,
	): Promise<DisposableCloudRunner> {
		const stored = await authorityStore.load();
		if (stored === undefined) {
			throw new Error("Runner authority repair requires existing state");
		}
		// A repair credential can outlive the repair it authorized (the operator
		// deletes it out of band). Once its hash is recorded in the authority
		// state, the stored rotating authority is current and must not be wiped
		// again — re-running the wipe would regenerate the activation replay
		// token and permanently diverge from the server's consumed binding.
		const restored = parseRunnerAuthorityState(stored, runnerId);
		if (restored.consumedRepairSha256 === runnerActivationTokenSha256(activationToken)) {
			return DisposableCloudRunner.open(transport, runnerId, authorityStore);
		}
		const repaired = new DisposableCloudRunner(transport, runnerId, activationToken, authorityStore);
		repaired.#consumedRepairSha256 = runnerActivationTokenSha256(activationToken);
		await repaired.#persist();
		return repaired;
	}

	async activate(platform: string, runnerVersion: string): Promise<CloudRunner> {
		if (!this.#activationToken) {
			if (!this.#runner) throw new Error("Runner activation is unavailable");
			return this.#runner;
		}
		if (!this.#pendingActivationToken) {
			this.#pendingActivationToken = createToken();
			await this.#persist();
		}
		const activationToken = this.#activationToken;
		const pendingActivationToken = this.#pendingActivationToken;
		const runner = parseCloudRunner(
			await this.#transport.request(activationToken, {
				action: "activate",
				runnerId: this.#runnerId,
				nextSessionToken: pendingActivationToken,
				platform,
				runnerVersion,
			}),
		);
		if (runner.runnerId !== this.#runnerId || runner.status !== "active") {
			throw new Error("Runner activation returned an inconsistent runner");
		}
		this.#sessionToken = pendingActivationToken;
		this.#pendingActivationToken = undefined;
		this.#activationToken = undefined;
		this.#runner = runner;
		try {
			await this.#persist();
		} catch (error) {
			this.#sessionToken = undefined;
			this.#pendingActivationToken = pendingActivationToken;
			this.#activationToken = activationToken;
			this.#runner = undefined;
			throw error;
		}
		return runner;
	}

	async heartbeat(): Promise<CloudRunner> {
		let recoverCommittedRotation = true;
		while (true) {
			const token = this.#sessionToken;
			if (!token) throw new Error("Runner is not active");
			if (!this.#pendingHeartbeat) {
				this.#pendingHeartbeat = { nextToken: createToken(), renewalId: randomUUID() };
				await this.#persist();
			}
			const pendingHeartbeat = this.#pendingHeartbeat;
			let value: unknown;
			try {
				value = await this.#transport.request(token, {
					action: "heartbeat",
					runnerId: this.#runnerId,
					nextSessionToken: pendingHeartbeat.nextToken,
					renewalId: pendingHeartbeat.renewalId,
				});
			} catch (error) {
				if (!recoverCommittedRotation || cloudRunnerControlRequestStatus(error) !== 401) throw error;
				const recoveryHeartbeat = { nextToken: createToken(), renewalId: randomUUID() };
				this.#sessionToken = pendingHeartbeat.nextToken;
				this.#pendingHeartbeat = recoveryHeartbeat;
				try {
					await this.#persist();
				} catch (persistError) {
					this.#sessionToken = token;
					this.#pendingHeartbeat = pendingHeartbeat;
					throw persistError;
				}
				recoverCommittedRotation = false;
				continue;
			}
			const runner = parseCloudRunner(value);
			if (runner.runnerId !== this.#runnerId || runner.status !== "active") {
				throw new Error("Runner heartbeat returned an inconsistent runner");
			}
			this.#sessionToken = pendingHeartbeat.nextToken;
			this.#pendingHeartbeat = undefined;
			const previousRunner = this.#runner;
			this.#runner = runner;
			try {
				await this.#persist();
			} catch (error) {
				this.#sessionToken = token;
				this.#pendingHeartbeat = pendingHeartbeat;
				this.#runner = previousRunner;
				throw error;
			}
			return runner;
		}
	}

	async acceptAssignment(assignment: CloudRunnerAssignmentAcceptance): Promise<CloudRunnerJob> {
		const token = this.#sessionToken;
		if (!token) throw new Error("Runner is not active");
		if (!UUID_PATTERN.test(assignment.assignmentId) || !UUID_PATTERN.test(assignment.jobId)) {
			throw new Error("Runner assignment is invalid");
		}
		requiredToken(assignment.capability, "Runner assignment capability");
		const received: PendingAssignment = {
			assignmentId: assignment.assignmentId,
			jobId: assignment.jobId,
			capability: assignment.capability,
		};
		if (this.#pendingAssignment && !isDeepStrictEqual(this.#pendingAssignment, received)) {
			throw new Error("Runner already has another assignment awaiting acceptance");
		}
		if (!this.#pendingAssignment) {
			this.#pendingAssignment = received;
			await this.#persist();
		}
		const job = parseCloudRunnerJob(
			await this.#transport.request(token, {
				action: "accept",
				runnerId: this.#runnerId,
				assignmentId: received.assignmentId,
				jobId: received.jobId,
				assignmentCapability: received.capability,
			}),
		);
		if (job.jobId !== received.jobId || job.runnerId !== this.#runnerId || job.status !== "leased") {
			throw new Error("Runner assignment returned an inconsistent lease");
		}
		const prior = this.#leases.get(job.jobId);
		if (prior && prior.leaseToken !== received.capability) {
			throw new Error("Runner assignment conflicts with retained job authority");
		}
		this.#leases.set(job.jobId, { job, leaseToken: received.capability });
		this.#pendingAssignment = undefined;
		try {
			await this.#persist();
		} catch (error) {
			if (prior) this.#leases.set(job.jobId, prior);
			else this.#leases.delete(job.jobId);
			this.#pendingAssignment = received;
			throw error;
		}
		return job;
	}

	async renew(jobId: string): Promise<CloudRunnerJob> {
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		const previousJob = active.job;
		const job = await this.#jobRequest("renew", jobId);
		active.job = job;
		try {
			await this.#persist();
		} catch (error) {
			active.job = previousJob;
			throw error;
		}
		return job;
	}

	broker(job: CloudRunnerJob, transport: CloudRunnerBrokerTransport, signal?: AbortSignal): CloudRunnerJobBroker {
		if (job.runnerId !== this.#runnerId || job.status !== "leased" || !this.#leases.has(job.jobId)) {
			throw new Error("Runner job lease is unavailable");
		}
		return new CloudRunnerJobBroker({
			job,
			runnerId: this.#runnerId,
			transport,
			...(signal ? { signal } : {}),
			credentials: () => {
				const sessionToken = this.#sessionToken;
				const lease = this.#leases.get(job.jobId);
				if (!sessionToken || !lease) throw new Error("Runner job lease is unavailable");
				return { sessionToken, leaseToken: lease.leaseToken };
			},
		});
	}

	async complete(jobId: string, result: JsonValue, outputSnapshotId?: string): Promise<CloudRunnerJob> {
		const encoded = JSON.stringify(result);
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			encoded === undefined ||
			Buffer.byteLength(encoded) > MAX_JSON_BYTES
		) {
			throw new Error("Runner job result is invalid");
		}
		if (outputSnapshotId !== undefined && !UUID_PATTERN.test(outputSnapshotId)) {
			throw new Error("Runner output Company File snapshot is invalid");
		}
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		const completion: CloudRunnerCompletion = {
			result: structuredClone(result),
			...(outputSnapshotId ? { outputSnapshotId } : {}),
		};
		if (active.pendingCompletion) {
			if (!isDeepStrictEqual(active.pendingCompletion, completion)) {
				throw new Error("Runner job completion changed after it was staged");
			}
		} else {
			active.pendingCompletion = completion;
			try {
				await this.#persist();
			} catch (error) {
				active.pendingCompletion = undefined;
				throw error;
			}
		}
		const stagedCompletion = active.pendingCompletion;
		if (!stagedCompletion) throw new Error("Runner job completion could not be staged");
		const job = await this.#jobRequest("complete", jobId, stagedCompletion);
		this.#leases.delete(jobId);
		try {
			await this.#persist();
		} catch (error) {
			this.#leases.set(jobId, active);
			throw error;
		}
		return job;
	}

	async fail(jobId: string, error: string, retryable: boolean): Promise<CloudRunnerJob> {
		const message = error.trim();
		if (!message || message.length > 1000) throw new Error("Runner job failure is invalid");
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		const job = await this.#jobRequest("fail", jobId, { error: message, retryable });
		this.#leases.delete(jobId);
		try {
			await this.#persist();
		} catch (error) {
			this.#leases.set(jobId, active);
			throw error;
		}
		return job;
	}

	leasedJobs(): CloudRunnerJob[] {
		return [...this.#leases.values()]
			.map((lease) => structuredClone(lease.job))
			.sort((left, right) => left.jobId.localeCompare(right.jobId, "en"));
	}

	pendingCompletion(jobId: string): JsonValue | undefined {
		const completion = this.#leases.get(jobId)?.pendingCompletion;
		return completion === undefined ? undefined : structuredClone(completion.result);
	}

	stagedCompletion(jobId: string): CloudRunnerCompletion | undefined {
		const completion = this.#leases.get(jobId)?.pendingCompletion;
		return completion === undefined ? undefined : structuredClone(completion);
	}

	async discardJobAuthority(jobId: string): Promise<void> {
		const active = this.#leases.get(jobId);
		if (!active) return;
		this.#leases.delete(jobId);
		try {
			await this.#persist();
		} catch (error) {
			this.#leases.set(jobId, active);
			throw error;
		}
	}

	snapshot(): DisposableCloudRunnerSnapshot {
		return {
			runnerId: this.#runnerId,
			active: Boolean(this.#sessionToken),
			...(this.#runner?.sessionExpiresAt ? { sessionExpiresAt: this.#runner.sessionExpiresAt } : {}),
			activeJobIds: [...this.#leases.keys()].sort(),
		};
	}

	async #jobRequest(
		action: "renew" | "complete" | "fail",
		jobId: string,
		extra: CloudRunnerCompletion | { error: string; retryable: boolean } | undefined = undefined,
	): Promise<CloudRunnerJob> {
		const token = this.#sessionToken;
		const lease = this.#leases.get(jobId);
		if (!token || !lease || !UUID_PATTERN.test(jobId)) throw new Error("Runner job lease is unavailable");
		const leaseToken = lease.leaseToken;
		let request: CloudRunnerControlRequest;
		if (action === "complete") {
			const completion = extra as CloudRunnerCompletion;
			request = {
				action,
				runnerId: this.#runnerId,
				jobId,
				leaseToken,
				clientArtifactIndexId: deterministicCompletionUuid("artifact-index", jobId),
				clientSubstrateVersionId: deterministicCompletionUuid("substrate-version", jobId),
				...(completion.outputSnapshotId ? { outputSnapshotId: completion.outputSnapshotId } : {}),
				result: completion.result,
			};
		} else if (action === "fail") {
			const failure = extra as { error: string; retryable: boolean };
			request = { action, runnerId: this.#runnerId, jobId, leaseToken, ...failure };
		} else {
			request = { action, runnerId: this.#runnerId, jobId, leaseToken };
		}
		const job = parseCloudRunnerJob(await this.#transport.request(token, request));
		if (job.jobId !== jobId) throw new Error("Runner request returned another job");
		if (
			(action === "renew" && job.status !== "leased") ||
			(action === "complete" && job.status !== "completed") ||
			(action === "fail" && job.status !== "queued" && job.status !== "failed")
		) {
			throw new Error("Runner request returned an inconsistent job state");
		}
		return job;
	}

	async #persist(): Promise<void> {
		if (!this.#authorityStore) return;
		const state: JsonValue = {
			schema: "qorpera.runner-authority/v3",
			runner_id: this.#runnerId,
			activation_token: this.#activationToken ?? null,
			session_token: this.#sessionToken ?? null,
			pending_activation_token: this.#pendingActivationToken ?? null,
			pending_heartbeat: this.#pendingHeartbeat
				? {
						next_token: this.#pendingHeartbeat.nextToken,
						renewal_id: this.#pendingHeartbeat.renewalId,
					}
				: null,
			pending_assignment: this.#pendingAssignment
				? {
						assignment_id: this.#pendingAssignment.assignmentId,
						job_id: this.#pendingAssignment.jobId,
						capability: this.#pendingAssignment.capability,
					}
				: null,
			runner: this.#runner ? storedRunner(this.#runner) : null,
			consumed_repair_sha256: this.#consumedRepairSha256 ?? null,
			leases: [...this.#leases.values()]
				.sort((left, right) => left.job.jobId.localeCompare(right.job.jobId, "en"))
				.map((lease) => ({
					job: storedJob(lease.job),
					lease_token: lease.leaseToken,
					pending_completion:
						lease.pendingCompletion !== undefined
							? {
									result: structuredClone(lease.pendingCompletion.result),
									output_snapshot_id: lease.pendingCompletion.outputSnapshotId ?? null,
								}
							: null,
				})),
		};
		const store = this.#authorityStore;
		const operation = this.#persistTail.then(
			() => store.save(state),
			() => store.save(state),
		);
		this.#persistTail = operation;
		await operation;
	}
}

export function runnerActivationTokenSha256(value: string): string {
	requiredToken(value, "Runner activation token");
	const digest = createHash("sha256").update(value).digest("hex");
	if (!SHA256_PATTERN.test(digest)) throw new Error("Runner activation token hash is invalid");
	return digest;
}
