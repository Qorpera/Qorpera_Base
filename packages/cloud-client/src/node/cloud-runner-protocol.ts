import { createHash, randomBytes } from "node:crypto";
import { isRecord, isUuidAnyCase, type JsonValue, SHA256_HEX_PATTERN, UUID_ANY_CASE_PATTERN } from "@qorpera/contracts";

export const UUID_PATTERN = UUID_ANY_CASE_PATTERN;
export const SHA256_PATTERN = SHA256_HEX_PATTERN;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_JSON_BYTES = 64 * 1024;
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

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
	/** Absent for a folder-v2 run, which has no Company File substrate (folder core C3, P23). */
	substrateVersionId?: string;
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
	| {
			/** Accept, describe and (with `nativeLeaseSeconds`) native authority in one transaction. */
			action: "start";
			runnerId: string;
			assignmentId: string;
			jobId: string;
			assignmentCapability: string;
			nativeLeaseSeconds?: number;
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

export function runnerRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Runner control returned invalid ${label}`);
	return value;
}

export function runnerUuid(value: unknown, label: string): string {
	if (!isUuidAnyCase(value)) throw new Error(`Runner control returned invalid ${label}`);
	return value;
}

export function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return new Date(value).toISOString();
}

export function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : timestamp(value, label);
}

export function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return value as number;
}

export function capability(value: unknown): CloudRunnerCapability {
	if (!CLOUD_RUNNER_CAPABILITIES.some((candidate) => candidate === value)) {
		throw new Error("Runner control returned invalid capability");
	}
	return value as CloudRunnerCapability;
}

export function json(value: unknown, label: string): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > MAX_JSON_BYTES) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return value as JsonValue;
}

export function objectJson(value: unknown, label: string): JsonValue {
	if (!isRecord(value)) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return json(value, label);
}

export function optionalUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : runnerUuid(value, label);
}

export function optionalText(value: unknown, label: string, maximum: number): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
		throw new Error(`Runner control returned invalid ${label}`);
	}
	return value;
}

export function parseCloudRunner(value: unknown): CloudRunner {
	const input = runnerRecord(value, "runner");
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
		runnerId: runnerUuid(input.runner_id, "runner id"),
		profileId: runnerUuid(input.profile_id, "runner profile id"),
		clientRunnerId: runnerUuid(input.client_runner_id, "runner client id"),
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
		registeredByUserId: runnerUuid(input.registered_by_user_id, "runner registering user id"),
		createdAt: timestamp(input.created_at, "runner creation time"),
		...(optionalTimestamp(input.activated_at, "runner activation time")
			? { activatedAt: timestamp(input.activated_at, "runner activation time") }
			: {}),
		...(optionalTimestamp(input.last_seen_at, "runner last seen time")
			? { lastSeenAt: timestamp(input.last_seen_at, "runner last seen time") }
			: {}),
		...(optionalUuid(input.revoked_by_user_id, "runner revoking user id")
			? { revokedByUserId: runnerUuid(input.revoked_by_user_id, "runner revoking user id") }
			: {}),
		...(optionalTimestamp(input.revoked_at, "runner revocation time")
			? { revokedAt: timestamp(input.revoked_at, "runner revocation time") }
			: {}),
		activeLeaseCount: boundedInteger(input.active_lease_count, "runner active lease count", 0, 16),
	};
}

export function parseCloudRunnerJob(value: unknown): CloudRunnerJob {
	const input = runnerRecord(value, "runner job");
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
		jobId: runnerUuid(input.job_id, "runner job id"),
		...(optionalUuid(input.run_id, "runner execution run id")
			? { runId: runnerUuid(input.run_id, "runner execution run id") }
			: {}),
		profileId: runnerUuid(input.profile_id, "runner job profile id"),
		environmentId: runnerUuid(input.environment_id, "runner job environment id"),
		...(optionalUuid(input.session_id, "runner job session id")
			? { sessionId: runnerUuid(input.session_id, "runner job session id") }
			: {}),
		...(optionalUuid(input.substrate_version_id, "runner job substrate id")
			? { substrateVersionId: runnerUuid(input.substrate_version_id, "runner job substrate id") }
			: {}),
		clientJobId: runnerUuid(input.client_job_id, "runner client job id"),
		...(optionalUuid(input.assignment_id, "runner assignment id")
			? { assignmentId: runnerUuid(input.assignment_id, "runner assignment id") }
			: {}),
		requiredCapability: capability(input.required_capability),
		jobType: input.job_type,
		payload: objectJson(input.payload, "runner job payload"),
		status: input.status,
		attemptCount: boundedInteger(input.attempt_count, "runner job attempt count", 0, 1000),
		...(optionalUuid(input.runner_id, "runner job runner id")
			? { runnerId: runnerUuid(input.runner_id, "runner job runner id") }
			: {}),
		...(result ? { result } : {}),
		outputArtifactCount,
		...(outputArtifactIndexId ? { outputArtifactIndexId } : {}),
		...(outputSubstrateVersionId ? { outputSubstrateVersionId } : {}),
		...(optionalText(input.last_error, "runner job error", 1000) ? { lastError: input.last_error as string } : {}),
		createdByUserId: runnerUuid(input.created_by_user_id, "runner job creating user id"),
		createdAt: timestamp(input.created_at, "runner job creation time"),
		...(optionalTimestamp(input.started_at, "runner job start time")
			? { startedAt: timestamp(input.started_at, "runner job start time") }
			: {}),
		...(leaseExpiresAt ? { leaseExpiresAt } : {}),
		...(optionalTimestamp(input.finished_at, "runner job finish time")
			? { finishedAt: timestamp(input.finished_at, "runner job finish time") }
			: {}),
		...(optionalUuid(input.cancelled_by_user_id, "runner job cancelling user id")
			? { cancelledByUserId: runnerUuid(input.cancelled_by_user_id, "runner job cancelling user id") }
			: {}),
		...(optionalTimestamp(input.cancelled_at, "runner job cancellation time")
			? { cancelledAt: timestamp(input.cancelled_at, "runner job cancellation time") }
			: {}),
	};
}

export function createToken(): string {
	return randomBytes(32).toString("base64url");
}

export function deterministicCompletionUuid(scope: "artifact-index" | "substrate-version", jobId: string): string {
	const bytes = createHash("sha256").update(`qorpera.runner-completion/v1:${scope}:${jobId}`).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex", 0, 16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requiredToken(value: string, label: string): void {
	if (!TOKEN_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

export function runnerActivationTokenSha256(value: string): string {
	requiredToken(value, "Runner activation token");
	const digest = createHash("sha256").update(value).digest("hex");
	if (!SHA256_PATTERN.test(digest)) throw new Error("Runner activation token hash is invalid");
	return digest;
}
