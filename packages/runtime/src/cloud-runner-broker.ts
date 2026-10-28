import type { CloudRunnerCapability, CloudRunnerJob } from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_OBJECTS = 100;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const BROKER_REQUEST_TIMEOUT_MS = 5 * 60_000;
/* Wall-clock budgets for transient broker retries. The short budget keeps
 * cadence-sensitive calls (the native authority's) inside their renewal rhythm;
 * the durable budget lets the execution and completion paths ride out a
 * platform incident measured in minutes rather than losing a finished
 * attempt to it. */
const TRANSIENT_RETRY_BUDGET_MS = 20_000;
/* Sized from the 2026-08-25 incident record: platform shedding waves ran two
 * to five minutes, and a completion-path call (verify_company_revision, since
 * removed) that had survived the whole pipeline died after exhausting a
 * 150-second budget mid-wave. Six
 * minutes spans every observed wave and stays serviceable because lease
 * renewals run in parallel against the six-minute rolling job lease. */
const DURABLE_RETRY_BUDGET_MS = 360_000;

/** A broker request the transport gave up on. `transient` says its last failure was a lost or late answer (no
 * answer, 429, 502, 503 or 504) that outlived the transport's own retries, not a refusal; `status` is absent when no
 * answer came. A worker asks a transient renewal again for as long as its lease allows (WB-001, 28 Oct 2026). */
export class CloudRunnerBrokerRequestError extends Error {
	readonly status: number | undefined;
	readonly transient: boolean;

	constructor(message: string, status: number | undefined, transient: boolean, options?: ErrorOptions) {
		super(message, options);
		this.name = "CloudRunnerBrokerRequestError";
		this.status = status;
		this.transient = transient;
	}
}

export interface CloudRunnerBrokerAuthority {
	runnerId: string;
	jobId: string;
	sessionToken: string;
	leaseToken: string;
	signal?: AbortSignal;
}

/** A folder-v2 run, which the broker describes in the path lane with no Company File substrate anywhere (folder core
 * C3, P23): no version, snapshot, proposal snapshot, artifact index or Company File output limits. */
export interface CloudRunnerBrokerDescription {
	companyRuntime: "company-path-v1";
	job: CloudRunnerJob;
	run: CloudRunnerExecutionRun;
	sponsor: CloudRunnerExecutionSponsor;
	outputLimits: {
		maxObjectBytes: number;
		maxObjectCount: number;
		maxTotalBytes: number;
		rootContract: "qorpera.object/v1";
	};
}

export type CloudComputeIdentityOwnershipKind = "member" | "company" | "department" | "security_boundary";

export interface CloudRunnerExecutionRun {
	runId: string;
	profileId: string;
	environmentId: string;
	sourceKind: "session_turn" | "wake" | "manual" | "room_delivery" | "proposal_review" | "system";
	sourceId: string;
	sessionId?: string;
	jobId: string;
	/** Both or neither: a folder-v2 run has no Company File substrate. */
	substrateVersionId?: string;
	companySnapshotId?: string;
	/** A folder-v2 run's pin instead of a snapshot: the folder clock's last_seq when it was materialized (folder core
	 * C4, P28). Never beside a snapshot. */
	companySeq?: number;
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
	computeIdentityOwnershipKind?: CloudComputeIdentityOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	workerClass: "managed_sandbox" | "company_computer";
	transcriptStartSequence: number;
	status: string;
	createdByUserId: string;
	requestedByUserId: string;
	sponsoredByUserId?: string;
	createdAt: string;
}

export interface CloudRunnerExecutionSponsor {
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

export interface CloudRunnerNativeAuthority {
	leaseId: string;
	runId: string;
	providerConnectionId: string;
	providerConnectionVersion: number;
	credentialCapsuleId: string;
	encryptedCapsuleReference: string;
	attestationPolicySha256: string;
	computeIdentityId: string;
	computeIdentityOwnershipKind: CloudComputeIdentityOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	credentialOwnershipKind: CloudComputeIdentityOwnershipKind;
	credentialOwnerUserId?: string;
	credentialOwnerScopeKey?: string;
	provider: string;
	authenticationMode: "native_subscription";
	nativeHarness: "codex-cli" | "claude-code";
	model: string;
	runnerId: string;
	assignmentId: string;
	expiresAt: string;
}

export interface BeginCloudRunnerOperationInput {
	receiptId: string;
	logicalOperationKey: string;
	operationKind: string;
	inputSha256: string;
	downstreamIdempotencyKey: string;
	requiresCompanyRevision: boolean;
}

export interface CompleteCloudRunnerOperationInput {
	receiptId: string;
	inputSha256: string;
	result: JsonValue;
	outputSnapshotId?: string;
	proposalId?: string;
}

export interface CloudRunnerBrokerTransport {
	describe(authority: CloudRunnerBrokerAuthority): Promise<unknown>;
	acquireNativeAuthority?(
		authority: CloudRunnerBrokerAuthority,
		runId: string,
		assignmentId: string,
		leaseSeconds: number,
	): Promise<unknown>;
	renewNativeAuthority?(
		authority: CloudRunnerBrokerAuthority,
		leaseId: string,
		leaseSeconds: number,
	): Promise<unknown>;
	releaseNativeAuthority?(
		authority: CloudRunnerBrokerAuthority,
		leaseId: string,
		status: "released" | "revoked" | "expired",
	): Promise<unknown>;
}

/** The native authority lease a runner asks for, at acquisition and at every renewal. */
export const NATIVE_AUTHORITY_LEASE_SECONDS = 120;

/** What a runner start (qorpera_start_runner_assignment) read in the acceptance's own transaction:
 * the broker description and, when asked for and the sponsor is native, the native authority. Both
 * are raw responses; the broker validates them exactly as it validates the separate calls. */
export interface CloudRunnerStart {
	description: unknown;
	nativeAuthority?: { value: unknown; leaseSeconds: number };
}

export interface CloudRunnerJobBrokerOptions {
	job: CloudRunnerJob;
	runnerId: string;
	credentials: () => { sessionToken: string; leaseToken: string };
	transport: CloudRunnerBrokerTransport;
	signal?: AbortSignal;
	/** Served once in place of the describe and native authority round trips. */
	start?: CloudRunnerStart;
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
		...(optionalUuid(input.run_id, "job execution run id")
			? { runId: uuid(input.run_id, "job execution run id") }
			: {}),
		profileId: uuid(input.profile_id, "job profile id"),
		environmentId: uuid(input.environment_id, "job environment id"),
		...(sessionId ? { sessionId } : {}),
		...(optionalUuid(input.substrate_version_id, "job substrate id")
			? { substrateVersionId: uuid(input.substrate_version_id, "job substrate id") }
			: {}),
		clientJobId: uuid(input.client_job_id, "job client id"),
		...(optionalUuid(input.assignment_id, "job assignment id")
			? { assignmentId: uuid(input.assignment_id, "job assignment id") }
			: {}),
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

function parseExecutionRun(value: unknown): CloudRunnerExecutionRun {
	const input = record(value, "execution run");
	if (
		input.source_kind !== "session_turn" &&
		input.source_kind !== "wake" &&
		input.source_kind !== "manual" &&
		input.source_kind !== "room_delivery" &&
		input.source_kind !== "proposal_review" &&
		input.source_kind !== "system"
	) {
		throw new Error("Runner broker returned invalid execution source");
	}
	const jobType = text(input.job_type, "execution job type", 64);
	if (!TYPE_PATTERN.test(jobType)) throw new Error("Runner broker returned invalid execution job type");
	if (input.publication_mode !== "automatic" && input.publication_mode !== "review") {
		throw new Error("Runner broker returned invalid publication mode");
	}
	const workerClass = input.worker_class ?? "managed_sandbox";
	if (workerClass !== "managed_sandbox" && workerClass !== "company_computer") {
		throw new Error("Runner broker returned invalid worker class");
	}
	const inputIds = array(input.input_ids, "execution input ids", 32).map((value) => uuid(value, "execution input id"));
	const reviewerStaffIds = array(input.reviewer_staff_ids, "execution reviewer staff ids", 20).map((value) =>
		uuid(value, "execution reviewer staff id"),
	);
	const reviewPolicyKey =
		input.review_policy_key === null || input.review_policy_key === undefined
			? undefined
			: text(input.review_policy_key, "execution review policy key", 128);
	const computeIdentityId = optionalUuid(input.compute_identity_id, "execution compute identity id");
	const computeOwnership = computeIdentityId
		? parseComputeOwnership(
				input.compute_identity_ownership_kind,
				input.compute_identity_owner_user_id,
				input.compute_identity_owner_scope_key,
				"execution compute identity",
			)
		: undefined;
	if (
		(!computeIdentityId &&
			input.compute_identity_ownership_kind !== null &&
			input.compute_identity_ownership_kind !== undefined) ||
		(!computeIdentityId &&
			input.compute_identity_owner_user_id !== null &&
			input.compute_identity_owner_user_id !== undefined) ||
		(!computeIdentityId &&
			input.compute_identity_owner_scope_key !== null &&
			input.compute_identity_owner_scope_key !== undefined)
	) {
		throw new Error("Runner broker returned compute ownership without an identity");
	}
	if (
		new Set(inputIds).size !== inputIds.length ||
		new Set(reviewerStaffIds).size !== reviewerStaffIds.length ||
		(input.source_kind === "session_turn") !== inputIds.length > 0 ||
		(input.publication_mode === "automatic" && (reviewPolicyKey !== undefined || reviewerStaffIds.length > 0)) ||
		(input.publication_mode === "review" && (reviewPolicyKey === undefined || reviewerStaffIds.length === 0))
	) {
		throw new Error("Runner broker returned inconsistent execution policy");
	}
	if (
		input.company_seq !== null &&
		input.company_seq !== undefined &&
		input.company_snapshot_id !== null &&
		input.company_snapshot_id !== undefined
	) {
		throw new Error("Runner broker returned a run with both a snapshot and a folder sequence");
	}
	return {
		runId: uuid(input.run_id, "execution run id"),
		profileId: uuid(input.profile_id, "execution profile id"),
		environmentId: uuid(input.environment_id, "execution environment id"),
		sourceKind: input.source_kind,
		sourceId: uuid(input.source_id, "execution source id"),
		...(optionalUuid(input.session_id, "execution session id")
			? { sessionId: uuid(input.session_id, "execution session id") }
			: {}),
		jobId: uuid(input.job_id, "execution job id"),
		...((input.substrate_version_id === null || input.substrate_version_id === undefined) &&
		(input.company_snapshot_id === null || input.company_snapshot_id === undefined)
			? {}
			: {
					substrateVersionId: uuid(input.substrate_version_id, "execution substrate id"),
					companySnapshotId: uuid(input.company_snapshot_id, "execution Company File snapshot id"),
				}),
		...(input.company_seq === null || input.company_seq === undefined
			? {}
			: { companySeq: integer(input.company_seq, "execution folder sequence", 0, Number.MAX_SAFE_INTEGER) }),
		staffAgentId: uuid(input.staff_agent_id, "execution staff agent id"),
		staffVersion: integer(input.staff_version, "execution staff version", 1, Number.MAX_SAFE_INTEGER),
		inputIds,
		sponsorBindingId: uuid(input.sponsor_binding_id, "execution sponsor binding id"),
		sponsorVersion: integer(input.sponsor_version, "execution sponsor version", 1, Number.MAX_SAFE_INTEGER),
		requiredCapability: capability(input.required_capability),
		jobType,
		payloadSha256: sha256(input.payload_sha256, "execution payload hash"),
		publicationMode: input.publication_mode,
		...(reviewPolicyKey ? { reviewPolicyKey } : {}),
		reviewerStaffIds,
		...(optionalUuid(input.logical_computer_id, "execution logical computer id")
			? { logicalComputerId: uuid(input.logical_computer_id, "execution logical computer id") }
			: {}),
		...(computeIdentityId ? { computeIdentityId, ...computeOwnership } : {}),
		workerClass,
		transcriptStartSequence: integer(
			input.transcript_start_sequence,
			"execution transcript cursor",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		status: text(input.status, "execution status", 64),
		createdByUserId: uuid(input.created_by_user_id, "execution creator id"),
		requestedByUserId: uuid(input.requested_by_user_id ?? input.created_by_user_id, "execution requester id"),
		...(optionalUuid(input.sponsored_by_user_id, "execution sponsor user id")
			? { sponsoredByUserId: uuid(input.sponsored_by_user_id, "execution sponsor user id") }
			: {}),
		createdAt: timestamp(input.created_at, "execution creation time"),
	};
}

function parseComputeOwnership(
	kindValue: unknown,
	ownerUserValue: unknown,
	ownerScopeValue: unknown,
	label: string,
): {
	computeIdentityOwnershipKind: CloudComputeIdentityOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
} {
	if (
		kindValue !== "member" &&
		kindValue !== "company" &&
		kindValue !== "department" &&
		kindValue !== "security_boundary"
	) {
		throw new Error(`Runner broker returned invalid ${label} ownership`);
	}
	const ownerUserId = optionalUuid(ownerUserValue, `${label} owner user id`);
	const ownerScopeKey =
		ownerScopeValue === null || ownerScopeValue === undefined
			? undefined
			: text(ownerScopeValue, `${label} owner scope`, 160);
	if (
		(kindValue === "member" && (!ownerUserId || ownerScopeKey)) ||
		(kindValue === "company" && (ownerUserId || ownerScopeKey)) ||
		((kindValue === "department" || kindValue === "security_boundary") && (ownerUserId || !ownerScopeKey))
	) {
		throw new Error(`Runner broker returned inconsistent ${label} ownership`);
	}
	return {
		computeIdentityOwnershipKind: kindValue,
		...(ownerUserId ? { computeIdentityOwnerUserId: ownerUserId } : {}),
		...(ownerScopeKey ? { computeIdentityOwnerScopeKey: ownerScopeKey } : {}),
	};
}

function parseExecutionSponsor(value: unknown): CloudRunnerExecutionSponsor {
	const input = record(value, "execution sponsor");
	if (
		input.kind !== "member_connection" &&
		input.kind !== "company_service_account" &&
		input.kind !== "company_api_billing"
	) {
		throw new Error("Runner broker returned invalid execution sponsor kind");
	}
	if (
		input.authentication_mode !== "native_subscription" &&
		input.authentication_mode !== "enterprise_access_token" &&
		input.authentication_mode !== "api_key" &&
		input.authentication_mode !== "cloud_service_account"
	) {
		throw new Error("Runner broker returned invalid execution sponsor authentication");
	}
	const provider = text(input.provider, "execution sponsor provider", 64);
	if (!TYPE_PATTERN.test(provider) || typeof input.allow_autonomous !== "boolean") {
		throw new Error("Runner broker returned invalid execution sponsor");
	}
	return {
		bindingId: uuid(input.binding_id, "execution sponsor binding id"),
		version: integer(input.version, "execution sponsor version", 1, Number.MAX_SAFE_INTEGER),
		kind: input.kind,
		providerConnectionId: uuid(input.provider_connection_id, "execution provider connection id"),
		providerConnectionVersion: integer(
			input.provider_connection_version,
			"execution provider connection version",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		provider,
		authenticationMode: input.authentication_mode,
		nativeHarness: text(input.native_harness, "execution native harness", 120),
		allowAutonomous: input.allow_autonomous,
	};
}

function parseNativeAuthority(value: unknown): CloudRunnerNativeAuthority {
	const input = record(value, "native provider authority");
	if (
		input.authentication_mode !== "native_subscription" ||
		(input.native_harness !== "codex-cli" && input.native_harness !== "claude-code")
	) {
		throw new Error("Runner broker returned invalid native provider authority");
	}
	const provider = text(input.provider, "native provider", 64);
	if (!TYPE_PATTERN.test(provider)) throw new Error("Runner broker returned invalid native provider");
	const nativeModel = record(input.model, "native model authority");
	if (nativeModel.provider !== provider) throw new Error("Runner broker returned a model for another provider");
	const computeOwnership = parseComputeOwnership(
		input.compute_identity_ownership_kind,
		input.compute_identity_owner_user_id,
		input.compute_identity_owner_scope_key,
		"native compute identity",
	);
	const credentialOwnership = parseComputeOwnership(
		input.credential_ownership_kind,
		input.credential_owner_user_id,
		input.credential_owner_scope_key,
		"native credential",
	);
	if (
		computeOwnership.computeIdentityOwnershipKind !== credentialOwnership.computeIdentityOwnershipKind ||
		computeOwnership.computeIdentityOwnerUserId !== credentialOwnership.computeIdentityOwnerUserId ||
		computeOwnership.computeIdentityOwnerScopeKey !== credentialOwnership.computeIdentityOwnerScopeKey
	) {
		throw new Error("Runner broker returned mismatched native credential ownership");
	}
	return {
		leaseId: uuid(input.lease_id, "native provider lease id"),
		runId: uuid(input.run_id, "native provider run id"),
		providerConnectionId: uuid(input.provider_connection_id, "native provider connection id"),
		providerConnectionVersion: integer(
			input.provider_connection_version,
			"native provider connection version",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		credentialCapsuleId: uuid(input.credential_capsule_id, "native credential capsule id"),
		encryptedCapsuleReference: text(input.encrypted_capsule_reference, "native credential capsule reference", 512),
		attestationPolicySha256: sha256(input.attestation_policy_sha256, "native credential attestation policy"),
		computeIdentityId: uuid(input.compute_identity_id, "native compute identity id"),
		...computeOwnership,
		credentialOwnershipKind: credentialOwnership.computeIdentityOwnershipKind,
		...(credentialOwnership.computeIdentityOwnerUserId
			? { credentialOwnerUserId: credentialOwnership.computeIdentityOwnerUserId }
			: {}),
		...(credentialOwnership.computeIdentityOwnerScopeKey
			? { credentialOwnerScopeKey: credentialOwnership.computeIdentityOwnerScopeKey }
			: {}),
		provider,
		authenticationMode: input.authentication_mode,
		nativeHarness: input.native_harness,
		model: text(nativeModel.model, "native model", 160),
		runnerId: uuid(input.runner_id, "native provider runner id"),
		assignmentId: uuid(input.assignment_id, "native provider assignment id"),
		expiresAt: timestamp(input.expires_at, "native provider lease expiry"),
	};
}

/** A run's description. Only a folder-v2 run's is accepted: the path lane with no Company File substrate anywhere
 * (folder core C3, P23). A description naming a substrate (the whole-tree lane's, or a version, snapshot, proposal
 * snapshot, artifact index, Company File output limits, or a substrate on the job or the run) is refused. */
export function parseCloudRunnerBrokerDescription(value: unknown): CloudRunnerBrokerDescription {
	const input = record(value, "description");
	if (input.company_runtime !== "company-path-v1") {
		throw new Error("Runner broker returned an invalid Company File runtime selection");
	}
	const limits = record(input.output_limits, "output limits");
	if (limits.root_contract !== "qorpera.object/v1") {
		throw new Error("Runner broker returned unsupported output root contract");
	}
	const job = parseBrokerJob(input.job);
	const run = parseExecutionRun(input.run);
	const absent = (value: unknown) => value === null || value === undefined;
	if (
		!absent(input.version) ||
		!absent(input.snapshot) ||
		!absent(input.proposal_snapshot) ||
		!absent(input.artifact_index) ||
		!absent(input.company_file_output_limits) ||
		job.substrateVersionId !== undefined ||
		run.substrateVersionId !== undefined
	) {
		throw new Error("Runner broker returned a run with a Company File substrate");
	}
	return {
		companyRuntime: input.company_runtime,
		job,
		run,
		sponsor: parseExecutionSponsor(input.sponsor),
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

export class SupabaseCloudRunnerBrokerTransport implements CloudRunnerBrokerTransport {
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
		const url = new URL("/functions/v1/runner-broker", baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Runner broker URL must use HTTPS");
		}
		if (!publishableKey.trim()) throw new Error("Runner broker publishable key is required");
		this.#url = url.href;
		this.#publishableKey = publishableKey;
		this.#fetch = fetchImplementation;
		this.#signal = options.signal;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? BROKER_REQUEST_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
			throw new Error("Runner broker request timeout is invalid");
		}
	}

	async describe(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		return this.#post(authority, { action: "describe" });
	}

	async acquireNativeAuthority(
		authority: CloudRunnerBrokerAuthority,
		runId: string,
		assignmentId: string,
		leaseSeconds: number,
	): Promise<unknown> {
		uuid(runId, "native authority run id");
		uuid(assignmentId, "native authority assignment id");
		integer(leaseSeconds, "native authority lease seconds", 30, 900);
		return this.#post(authority, { action: "native_authority", runId, assignmentId, leaseSeconds });
	}

	async releaseNativeAuthority(
		authority: CloudRunnerBrokerAuthority,
		leaseId: string,
		status: "released" | "revoked" | "expired",
	): Promise<unknown> {
		uuid(leaseId, "native authority lease id");
		return this.#post(authority, { action: "release_native_authority", leaseId, status });
	}

	async renewNativeAuthority(
		authority: CloudRunnerBrokerAuthority,
		leaseId: string,
		leaseSeconds: number,
	): Promise<unknown> {
		uuid(leaseId, "native authority lease id");
		integer(leaseSeconds, "native authority lease seconds", 30, 900);
		return this.#post(authority, { action: "renew_native_authority", leaseId, leaseSeconds });
	}

	#headers(authority: CloudRunnerBrokerAuthority): Record<string, string> {
		requiredAuthority(authority);
		return {
			accept: "application/json",
			apikey: this.#publishableKey,
			authorization: `Bearer ${authority.sessionToken}`,
			"x-qorpera-job-id": authority.jobId,
			"x-qorpera-lease-token": authority.leaseToken,
			"x-qorpera-runner-id": authority.runnerId,
		};
	}

	async #post(authority: CloudRunnerBrokerAuthority, body: Record<string, unknown>): Promise<unknown> {
		/* Authority renewals must fail fast enough to keep their renewal
		 * cadence; every other action sits on an execution or completion
		 * path where losing a live attempt costs far more than waiting out
		 * a platform incident. The action name rides in the failure message
		 * so a terminal error attributes the exact call that died. */
		const action = String(body.action);
		const cadenceSensitive =
			action === "native_authority" || action === "renew_native_authority" || action === "release_native_authority";
		const response = await this.#transientFetch(
			`Runner broker request (${action})`,
			authority,
			() =>
				this.#fetch(this.#url, {
					method: "POST",
					headers: { ...this.#headers(authority), "content-type": "application/json" },
					body: JSON.stringify({ ...body, runnerId: authority.runnerId, jobId: authority.jobId }),
					signal: this.#requestSignal(authority),
				}),
			cadenceSensitive ? TRANSIENT_RETRY_BUDGET_MS : DURABLE_RETRY_BUDGET_MS,
		);
		return record(await response.json(), "response").value;
	}

	/* Every broker action proxies through an Edge Function whose upstream can
	 * shed load transiently mid-attempt, and every mutating action carries a
	 * client-generated identity the control plane dedupes on, so bounded
	 * retries of transient statuses are safe end-to-end. The budget is wall
	 * clock, not an attempt count: platform incidents last minutes, and an
	 * attempt that has already produced durable output must ride them out on
	 * the completion path, while cadence-sensitive calls (lease and authority
	 * renewals) must instead fail fast enough to keep their renewal rhythm. */
	async #transientFetch(
		label: string,
		authority: CloudRunnerBrokerAuthority,
		perform: () => Promise<Response>,
		budgetMs = TRANSIENT_RETRY_BUDGET_MS,
	): Promise<Response> {
		const deadline = Date.now() + budgetMs;
		for (let attempt = 1; ; attempt++) {
			let response: Response | undefined;
			let transportError: unknown;
			try {
				response = await perform();
			} catch (error) {
				transportError = error;
			}
			if (response?.ok) return response;
			const status = response?.status;
			const transient =
				transportError !== undefined || status === 502 || status === 503 || status === 504 || status === 429;
			const delayMs = Math.min(attempt * 2_000, 10_000);
			if (!transient || Date.now() + delayMs >= deadline || this.#requestSignal(authority)?.aborted) {
				if (transportError) {
					if (this.#requestSignal(authority)?.aborted) throw transportError;
					throw new CloudRunnerBrokerRequestError(`${label} failed`, undefined, true, { cause: transportError });
				}
				throw new CloudRunnerBrokerRequestError(`${label} failed (${status})`, status, transient);
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
		}
	}

	#requestSignal(authority: CloudRunnerBrokerAuthority): AbortSignal {
		const signals = [AbortSignal.timeout(this.#requestTimeoutMs)];
		if (this.#signal) signals.push(this.#signal);
		if (authority.signal) signals.push(authority.signal);
		return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
	}
}

export class CloudRunnerJobBroker {
	readonly #options: CloudRunnerJobBrokerOptions;
	#description?: CloudRunnerBrokerDescription;
	#nativeAuthority?: CloudRunnerNativeAuthority;
	#start?: CloudRunnerStart;

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
		this.#start = options.start;
	}

	async describe(): Promise<CloudRunnerBrokerDescription> {
		if (this.#description) return this.#description;
		const authority = this.#authority();
		const started = this.#start?.description;
		if (started !== undefined) authority.signal?.throwIfAborted();
		const description = parseCloudRunnerBrokerDescription(
			started ?? (await this.#options.transport.describe(authority)),
		);
		if (
			description.job.jobId !== this.#options.job.jobId ||
			description.job.runId !== this.#options.job.runId ||
			description.job.assignmentId !== this.#options.job.assignmentId ||
			description.job.runnerId !== this.#options.runnerId ||
			description.job.status !== "leased" ||
			description.run.runId !== description.job.runId ||
			description.run.jobId !== description.job.jobId ||
			description.run.profileId !== description.job.profileId ||
			description.run.environmentId !== description.job.environmentId ||
			description.run.sessionId !== description.job.sessionId ||
			description.job.profileId !== this.#options.job.profileId ||
			description.job.environmentId !== this.#options.job.environmentId ||
			description.run.sponsorBindingId !== description.sponsor.bindingId ||
			description.run.sponsorVersion !== description.sponsor.version ||
			description.run.requiredCapability !== description.job.requiredCapability ||
			description.run.jobType !== description.job.jobType ||
			// A proposal review reads a proposal snapshot, which a folder-v2 run has none of.
			description.run.sourceKind === "proposal_review"
		) {
			throw new Error("Runner broker returned another job substrate");
		}
		this.#description = description;
		return description;
	}

	async acquireNativeAuthority(leaseSeconds = NATIVE_AUTHORITY_LEASE_SECONDS): Promise<CloudRunnerNativeAuthority> {
		const description = await this.describe();
		if (description.sponsor.authenticationMode !== "native_subscription") {
			throw new Error("Runner execution does not use a native subscription");
		}
		// The start's authority serves the first acquisition for the same lease length, once.
		const started = this.#start?.nativeAuthority;
		this.#start = undefined;
		let value: unknown;
		if (started?.leaseSeconds === leaseSeconds) {
			this.#authority().signal?.throwIfAborted();
			value = started.value;
		} else {
			const acquire = this.#options.transport.acquireNativeAuthority;
			if (!acquire) throw new Error("Runner broker does not support native subscription authority");
			value = await acquire.call(
				this.#options.transport,
				this.#authority(),
				description.run.runId,
				this.#assignmentId(),
				leaseSeconds,
			);
		}
		const assignmentId = this.#assignmentId();
		const authority = parseNativeAuthority(value);
		if (
			authority.runId !== description.run.runId ||
			authority.providerConnectionId !== description.sponsor.providerConnectionId ||
			authority.providerConnectionVersion !== description.sponsor.providerConnectionVersion ||
			authority.provider !== description.sponsor.provider ||
			authority.nativeHarness !== description.sponsor.nativeHarness ||
			authority.computeIdentityId !== description.run.computeIdentityId ||
			authority.computeIdentityOwnershipKind !== description.run.computeIdentityOwnershipKind ||
			authority.computeIdentityOwnerUserId !== description.run.computeIdentityOwnerUserId ||
			authority.computeIdentityOwnerScopeKey !== description.run.computeIdentityOwnerScopeKey ||
			authority.runnerId !== this.#options.runnerId ||
			authority.assignmentId !== assignmentId
		) {
			throw new Error("Runner broker returned another native subscription authority");
		}
		this.#nativeAuthority = authority;
		return authority;
	}

	async releaseNativeAuthority(status: "released" | "revoked" | "expired" = "released"): Promise<void> {
		if (!this.#nativeAuthority) return;
		const release = this.#options.transport.releaseNativeAuthority;
		if (!release) throw new Error("Runner broker does not support native subscription authority release");
		const leaseId = this.#nativeAuthority.leaseId;
		const value = record(
			await release.call(this.#options.transport, this.#authority(), leaseId, status),
			"native provider authority release",
		);
		if (value.lease_id !== leaseId || value.status !== status) {
			throw new Error("Runner broker released another native subscription authority");
		}
		this.#nativeAuthority = undefined;
	}

	async renewNativeAuthority(leaseSeconds = NATIVE_AUTHORITY_LEASE_SECONDS): Promise<CloudRunnerNativeAuthority> {
		const current = this.#nativeAuthority;
		if (!current) throw new Error("Runner has no native subscription authority to renew");
		const renew = this.#options.transport.renewNativeAuthority;
		if (!renew) throw new Error("Runner broker does not support native subscription authority renewal");
		const value = record(
			await renew.call(this.#options.transport, this.#authority(), current.leaseId, leaseSeconds),
			"native provider authority renewal",
		);
		if (value.lease_id !== current.leaseId || value.run_id !== current.runId || value.status !== "active") {
			throw new Error("Runner broker renewed another native subscription authority");
		}
		const expiresAt = timestamp(value.expires_at, "native provider lease expiry");
		this.#nativeAuthority = { ...current, expiresAt };
		return this.#nativeAuthority;
	}

	#authority(): CloudRunnerBrokerAuthority {
		const credentials = this.#options.credentials();
		const authority = {
			runnerId: this.#options.runnerId,
			jobId: this.#options.job.jobId,
			sessionToken: credentials.sessionToken,
			leaseToken: credentials.leaseToken,
			...(this.#options.signal ? { signal: this.#options.signal } : {}),
		};
		requiredAuthority(authority);
		return authority;
	}

	#assignmentId(): string {
		if (!this.#options.job.assignmentId) throw new Error("Runner job has no orchestrator assignment");
		return this.#options.job.assignmentId;
	}
}
