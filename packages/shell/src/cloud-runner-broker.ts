import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CapturedCloudCompanyTree,
	type CloudCompanyTreeReference,
	captureCloudCompanyTreeWithReachability,
} from "./cloud-company-snapshot.ts";
import type { ResolvedCompanySubstrateReference } from "./cloud-company-substrate.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "./cloud-object-store.ts";
import type { CloudRunnerCapability, CloudRunnerJob } from "./cloud-runner-control.ts";
import {
	type CloudRunnerModelRequest,
	type CloudRunnerModelResponse,
	parseCloudRunnerModelResponse,
	validateCloudRunnerModelRequest,
} from "./cloud-runner-model.ts";
import type {
	CloudRunnerCompanyFilePublicationInput,
	CloudRunnerCompanyFilePublisher,
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
	HostedSessionEventType,
	HostedSessionExecutionIdentity,
} from "./hosted-primary.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_OBJECTS = 100;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_COMPANY_FILE_OUTPUT_OBJECTS = 8_500_000;
const MAX_COMPANY_FILE_OUTPUT_BYTES = 1_099_511_627_776;
const RUNNER_TRANSCRIPT_ENTRY_SCHEMA = "qorpera.runner-transcript-entry/v1";
const REACHABILITY_BATCH_SIZE = 500;
const VERIFICATION_RETRY_DELAY_MS = 25;
const BROKER_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface CloudRunnerBrokerAuthority {
	runnerId: string;
	jobId: string;
	sessionToken: string;
	leaseToken: string;
	signal?: AbortSignal;
}

export interface CloudRunnerBrokerDescription {
	job: CloudRunnerJob;
	run: CloudRunnerExecutionRun;
	sponsor: CloudRunnerExecutionSponsor;
	version: HostedCompanySubstrateVersion;
	snapshot: HostedCompanySnapshot;
	proposalSnapshot?: HostedCompanySnapshot;
	artifactIndex?: HostedArtifactIndex;
	outputLimits: {
		maxObjectBytes: number;
		maxObjectCount: number;
		maxTotalBytes: number;
		rootContract: "qorpera.object/v1";
	};
	companyFileOutputLimits: {
		maxObjectBytes: number;
		maxObjectCount: number;
		maxTotalBytes: number;
		treeContractVersion: 3;
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

export interface CloudRunnerQueuedInput {
	inputId: string;
	position: number;
	kind: "kickoff" | "user_message";
	authorUserId: string;
	authorDisplayName: string;
	body: JsonValue;
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

export interface RegisterCloudRunnerArtifactInput {
	clientArtifactId: string;
	artifactType: string;
	name: string;
	objectSha256: string;
	bytes: number;
	mediaType: string;
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

export interface BindCloudRunnerProviderSessionInput {
	providerSessionId: string;
	contextCheckpointObjectSha256?: string;
}

export interface PrepareCloudRunnerCompanyRevisionInput {
	clientRevisionId: string;
	treeManifestSha256: string;
	treeManifestBytes: number;
	treeContractVersion: 3;
	fileCount: number;
	totalBytes: number;
}

export interface BeginCloudRunnerCompanyRevisionGraphInput {
	snapshotId: string;
	clientGraphId: string;
	rootObjectSha256: string;
	contentSha256: string;
	objectCount: number;
	storageBytes: number;
}

export interface AppendCloudRunnerCompanyRevisionGraphInput {
	graphId: string;
	entries: readonly { sha256: string; bytes: number }[];
}

export interface CloudRunnerCompanyRevisionGraph {
	graphId: string;
	snapshotId: string;
	clientGraphId: string;
	rootObjectSha256: string;
	contentSha256: string;
	objectCount: number;
	storageBytes: number;
	status: "uploading" | "complete";
	closureVerified: boolean;
}

export interface CloudRunnerCompanyRevisionVerification {
	verified: boolean;
	pending: boolean;
}

export interface AppendCloudRunnerTranscriptEventInput {
	eventId: string;
	eventType: "message" | "run_receipt" | "artifact_receipt" | "authorization_request" | "authorization_decision";
	entry: JsonValue;
	expectedSequence?: number;
}

export interface CloudRunnerOperationReceipt {
	state: "executing" | "completed" | "ambiguous" | "cancelled";
	receiptId: string;
	result?: JsonValue;
	outputSnapshotId?: string;
	proposalId?: string;
}

export interface CloudRunnerProviderSessionBinding {
	runId: string;
	providerConnectionId: string;
	providerSessionId: string;
}

export interface CloudRunnerTranscriptEvent {
	sessionId: string;
	sequence: number;
	eventId: string;
	eventType: AppendCloudRunnerTranscriptEventInput["eventType"];
	entry: JsonValue;
	eventHash: string;
	previousHash?: string;
	executionRunId: string;
	assignmentId: string;
	createdAt: string;
}

export interface CloudRunnerTranscriptContextEvent {
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
	listInputs(authority: CloudRunnerBrokerAuthority): Promise<unknown>;
	listTranscript(authority: CloudRunnerBrokerAuthority, afterSequence: number, limit: number): Promise<unknown>;
	listOperations(authority: CloudRunnerBrokerAuthority, afterSequence: number, limit: number): Promise<unknown>;
	listArtifacts(authority: CloudRunnerBrokerAuthority, afterOrdinal: number, limit: number): Promise<unknown>;
	getObject(authority: CloudRunnerBrokerAuthority, sha256: string): Promise<Uint8Array>;
	putObject(
		authority: CloudRunnerBrokerAuthority,
		sha256: string,
		bytes: Uint8Array,
		mediaType: string,
		purpose: "artifact" | "company_file",
	): Promise<"exists" | "stored">;
	registerArtifact(authority: CloudRunnerBrokerAuthority, input: RegisterCloudRunnerArtifactInput): Promise<unknown>;
	requestModel(authority: CloudRunnerBrokerAuthority, input: CloudRunnerModelRequest): Promise<unknown>;
	beginOperation(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: BeginCloudRunnerOperationInput,
	): Promise<unknown>;
	completeOperation(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: CompleteCloudRunnerOperationInput,
	): Promise<unknown>;
	bindProviderSession(
		authority: CloudRunnerBrokerAuthority,
		input: BindCloudRunnerProviderSessionInput,
	): Promise<unknown>;
	prepareCompanyRevision(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: PrepareCloudRunnerCompanyRevisionInput,
	): Promise<unknown>;
	beginCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: BeginCloudRunnerCompanyRevisionGraphInput,
	): Promise<unknown>;
	appendCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: AppendCloudRunnerCompanyRevisionGraphInput,
	): Promise<unknown>;
	completeCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		graphId: string,
	): Promise<unknown>;
	verifyCompanyRevision(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		snapshotId: string,
		graphId: string,
	): Promise<unknown>;
	appendTranscriptEvent(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: AppendCloudRunnerTranscriptEventInput,
	): Promise<unknown>;
}

export interface CloudRunnerJobBrokerOptions {
	job: CloudRunnerJob;
	runnerId: string;
	credentials: () => { sessionToken: string; leaseToken: string };
	transport: CloudRunnerBrokerTransport;
	signal?: AbortSignal;
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

function objectJson(value: unknown, label: string, maximumBytes = 64 * 1024): JsonValue {
	const encoded = JSON.stringify(value);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		encoded === undefined ||
		Buffer.byteLength(encoded) > maximumBytes
	) {
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
		substrateVersionId: uuid(input.substrate_version_id, "job substrate id"),
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
		substrateVersionId: uuid(input.substrate_version_id, "execution substrate id"),
		companySnapshotId: uuid(input.company_snapshot_id, "execution Company File snapshot id"),
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
			contractVersion: integer(input.tree_contract_version, "company tree contract version", 1, 3),
			fileCount: integer(input.file_count, "company tree file count", 0, 50_000),
			totalBytes: integer(input.total_bytes, "company tree total bytes", 0, Number.MAX_SAFE_INTEGER),
		},
		createdByUserId: uuid(input.created_by_user_id, "company snapshot creator id"),
		createdAt: timestamp(input.created_at, "company snapshot creation time"),
	};
}

function parseCompanyRevisionGraph(value: unknown): CloudRunnerCompanyRevisionGraph {
	const input = record(value, "Company File reachability graph");
	if (input.root_kind !== "company_snapshot" || (input.status !== "uploading" && input.status !== "complete")) {
		throw new Error("Runner broker returned invalid Company File reachability graph");
	}
	return {
		graphId: uuid(input.graph_id, "Company File graph id"),
		snapshotId: uuid(input.root_id, "Company File graph snapshot id"),
		clientGraphId: uuid(input.client_graph_id, "Company File client graph id"),
		rootObjectSha256: sha256(input.root_object_sha256, "Company File graph root hash"),
		contentSha256: sha256(input.content_sha256, "Company File graph content hash"),
		objectCount: integer(input.object_count, "Company File graph object count", 1, 400_000),
		storageBytes: integer(input.storage_bytes, "Company File graph storage bytes", 0, 2_199_023_255_552),
		status: input.status,
		closureVerified: input.closure_verified === true,
	};
}

function parseCompanyRevisionVerification(value: unknown): CloudRunnerCompanyRevisionVerification {
	const input = record(value, "Company File verification");
	if (typeof input.verified !== "boolean" || typeof input.pending !== "boolean" || input.verified === input.pending) {
		throw new Error("Runner broker returned invalid Company File verification");
	}
	return { verified: input.verified, pending: input.pending };
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

function parseOperationReceipt(value: unknown): CloudRunnerOperationReceipt {
	const input = record(value, "operation receipt");
	if (
		input.state !== "executing" &&
		input.state !== "completed" &&
		input.state !== "ambiguous" &&
		input.state !== "cancelled"
	) {
		throw new Error("Runner broker returned invalid operation receipt state");
	}
	const result =
		input.result === null || input.result === undefined ? undefined : objectJson(input.result, "operation result");
	return {
		state: input.state,
		receiptId: uuid(input.receipt_id, "operation receipt id"),
		...(result === undefined ? {} : { result }),
		...(optionalUuid(input.output_snapshot_id, "operation output snapshot id")
			? { outputSnapshotId: uuid(input.output_snapshot_id, "operation output snapshot id") }
			: {}),
		...(optionalUuid(input.proposal_id, "operation proposal id")
			? { proposalId: uuid(input.proposal_id, "operation proposal id") }
			: {}),
	};
}

function parseProviderSessionBinding(value: unknown): CloudRunnerProviderSessionBinding {
	const input = record(value, "provider session binding");
	return {
		runId: uuid(input.run_id, "provider session run id"),
		providerConnectionId: uuid(input.provider_connection_id, "provider session connection id"),
		providerSessionId: text(input.provider_session_id, "provider session id", 1024),
	};
}

function parseTranscriptEvent(value: unknown): CloudRunnerTranscriptEvent {
	const input = record(value, "transcript event");
	if (
		input.event_type !== "message" &&
		input.event_type !== "run_receipt" &&
		input.event_type !== "artifact_receipt" &&
		input.event_type !== "authorization_request" &&
		input.event_type !== "authorization_decision"
	) {
		throw new Error("Runner broker returned invalid transcript event type");
	}
	const body = record(input.body, "transcript event body");
	if (body.schema !== RUNNER_TRANSCRIPT_ENTRY_SCHEMA) {
		throw new Error("Runner broker returned invalid transcript event schema");
	}
	const entry = objectJson(body.entry, "transcript entry", 256 * 1024);
	const previousHash =
		input.previous_hash === null ? undefined : sha256(input.previous_hash, "transcript previous hash");
	return {
		sessionId: uuid(input.session_id, "transcript session id"),
		sequence: integer(input.sequence, "transcript event sequence", 1, Number.MAX_SAFE_INTEGER),
		eventId: uuid(input.event_id, "transcript event id"),
		eventType: input.event_type,
		entry,
		eventHash: sha256(input.event_hash, "transcript event hash"),
		...(previousHash ? { previousHash } : {}),
		executionRunId: uuid(input.execution_id, "transcript execution run id"),
		assignmentId: uuid(input.runner_assignment_id, "transcript runner assignment id"),
		createdAt: timestamp(input.created_at, "transcript event creation time"),
	};
}

function parseTranscriptContextEvent(value: unknown): CloudRunnerTranscriptContextEvent {
	const input = record(value, "transcript context event");
	if (
		input.event_type !== "message" &&
		input.event_type !== "session_info" &&
		input.event_type !== "run_receipt" &&
		input.event_type !== "artifact_receipt" &&
		input.event_type !== "authorization_request" &&
		input.event_type !== "authorization_decision"
	) {
		throw new Error("Runner broker returned invalid transcript context event type");
	}
	const executionKind = input.execution_kind;
	const executionId = input.execution_id;
	const claimantId = input.execution_claimant_id;
	const assignmentId = input.runner_assignment_id;
	if (
		(executionKind === null || executionKind === undefined) !== (executionId === null || executionId === undefined) ||
		(executionKind === null || executionKind === undefined) !== (claimantId === null || claimantId === undefined) ||
		(executionKind !== null &&
			executionKind !== undefined &&
			executionKind !== "turn" &&
			executionKind !== "wake" &&
			executionKind !== "run") ||
		(executionKind === "run") !== (assignmentId !== null && assignmentId !== undefined)
	) {
		throw new Error("Runner broker returned invalid transcript context execution");
	}
	const previousHash =
		input.previous_hash === null || input.previous_hash === undefined
			? undefined
			: sha256(input.previous_hash, "transcript context previous hash");
	const execution: HostedSessionExecutionIdentity | undefined =
		executionKind === "run"
			? {
					kind: "run",
					id: uuid(executionId, "transcript context execution id"),
					claimantId: uuid(claimantId, "transcript context claimant id"),
					runnerAssignmentId: uuid(assignmentId, "transcript context assignment id"),
				}
			: executionKind === "turn" || executionKind === "wake"
				? {
						kind: executionKind,
						id: uuid(executionId, "transcript context execution id"),
						claimantId: uuid(claimantId, "transcript context claimant id"),
					}
				: undefined;
	return {
		sessionId: uuid(input.session_id, "transcript context session id"),
		sequence: integer(input.sequence, "transcript context sequence", 1, Number.MAX_SAFE_INTEGER),
		eventId: uuid(input.event_id, "transcript context event id"),
		eventType: input.event_type,
		actorUserId: uuid(input.actor_user_id, "transcript context actor id"),
		body: json(input.body, "transcript context body"),
		eventHash: sha256(input.event_hash, "transcript context event hash"),
		...(previousHash ? { previousHash } : {}),
		...(execution ? { execution } : {}),
		createdAt: timestamp(input.created_at, "transcript context creation time"),
	};
}

export function parseCloudRunnerBrokerDescription(value: unknown): CloudRunnerBrokerDescription {
	const input = record(value, "description");
	const limits = record(input.output_limits, "output limits");
	const companyFileLimits = record(input.company_file_output_limits, "Company File output limits");
	integer(companyFileLimits.tree_contract_version, "Company File output tree contract", 3, 3);
	if (limits.root_contract !== "qorpera.object/v1") {
		throw new Error("Runner broker returned unsupported output root contract");
	}
	return {
		job: parseBrokerJob(input.job),
		run: parseExecutionRun(input.run),
		sponsor: parseExecutionSponsor(input.sponsor),
		version: parseVersion(input.version),
		snapshot: parseSnapshot(input.snapshot),
		...(input.proposal_snapshot === null || input.proposal_snapshot === undefined
			? {}
			: { proposalSnapshot: parseSnapshot(input.proposal_snapshot) }),
		...(input.artifact_index === null || input.artifact_index === undefined
			? {}
			: { artifactIndex: parseArtifactIndex(input.artifact_index) }),
		outputLimits: {
			maxObjectBytes: integer(limits.max_object_bytes, "output object bytes", 0, MAX_OBJECT_BYTES),
			maxObjectCount: integer(limits.max_object_count, "output object count", 0, MAX_OUTPUT_OBJECTS),
			maxTotalBytes: integer(limits.max_total_bytes, "output total bytes", 0, MAX_OUTPUT_BYTES),
			rootContract: limits.root_contract,
		},
		companyFileOutputLimits: {
			maxObjectBytes: integer(
				companyFileLimits.max_object_bytes,
				"Company File output object bytes",
				1,
				MAX_OBJECT_BYTES,
			),
			maxObjectCount: integer(
				companyFileLimits.max_object_count,
				"Company File output object count",
				1,
				MAX_COMPANY_FILE_OUTPUT_OBJECTS,
			),
			maxTotalBytes: integer(
				companyFileLimits.max_total_bytes,
				"Company File output total bytes",
				1,
				MAX_COMPANY_FILE_OUTPUT_BYTES,
			),
			treeContractVersion: 3,
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

	async listInputs(authority: CloudRunnerBrokerAuthority): Promise<unknown> {
		return this.#post(authority, { action: "inputs" });
	}

	async listTranscript(authority: CloudRunnerBrokerAuthority, afterSequence: number, limit: number): Promise<unknown> {
		integer(afterSequence, "transcript cursor", 0, Number.MAX_SAFE_INTEGER);
		integer(limit, "transcript page size", 1, 500);
		return this.#post(authority, { action: "transcript", afterSequence, limit });
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
			signal: this.#requestSignal(authority),
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
		purpose: "artifact" | "company_file",
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
				"x-qorpera-object-purpose": purpose,
			},
			body: Uint8Array.from(bytes).buffer,
			signal: this.#requestSignal(authority),
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

	async requestModel(authority: CloudRunnerBrokerAuthority, input: CloudRunnerModelRequest): Promise<unknown> {
		const request = validateCloudRunnerModelRequest(input);
		return this.#post(authority, {
			action: "model",
			requestId: request.requestId,
			provider: request.provider,
			model: request.model,
			input: request.input,
			maxOutputTokens: request.maxOutputTokens,
		});
	}

	async beginOperation(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: BeginCloudRunnerOperationInput,
	): Promise<unknown> {
		uuid(assignmentId, "assignment id");
		uuid(input.receiptId, "operation receipt id");
		const logicalOperationKey = text(input.logicalOperationKey, "logical operation key", 256);
		const operationKind = text(input.operationKind, "operation kind", 64);
		if (!TYPE_PATTERN.test(operationKind)) throw new Error("Runner broker operation kind is invalid");
		sha256(input.inputSha256, "operation input hash");
		const downstreamIdempotencyKey = text(input.downstreamIdempotencyKey, "downstream idempotency key", 256);
		if (typeof input.requiresCompanyRevision !== "boolean") {
			throw new Error("Runner broker Company File operation flag is invalid");
		}
		return this.#post(authority, {
			action: "begin_operation",
			assignmentId,
			receiptId: input.receiptId,
			logicalOperationKey,
			operationKind,
			inputSha256: input.inputSha256,
			downstreamIdempotencyKey,
			requiresCompanyRevision: input.requiresCompanyRevision,
		});
	}

	async completeOperation(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: CompleteCloudRunnerOperationInput,
	): Promise<unknown> {
		uuid(assignmentId, "assignment id");
		uuid(input.receiptId, "operation receipt id");
		sha256(input.inputSha256, "operation input hash");
		const result = objectJson(input.result, "operation result");
		if (input.outputSnapshotId) uuid(input.outputSnapshotId, "operation output snapshot id");
		if (input.proposalId) uuid(input.proposalId, "operation proposal id");
		if (input.outputSnapshotId && input.proposalId) {
			throw new Error("Runner broker operation cannot publish a snapshot and proposal together");
		}
		return this.#post(authority, {
			action: "complete_operation",
			assignmentId,
			receiptId: input.receiptId,
			inputSha256: input.inputSha256,
			result,
			...(input.outputSnapshotId ? { outputSnapshotId: input.outputSnapshotId } : {}),
			...(input.proposalId ? { proposalId: input.proposalId } : {}),
		});
	}

	async bindProviderSession(
		authority: CloudRunnerBrokerAuthority,
		input: BindCloudRunnerProviderSessionInput,
	): Promise<unknown> {
		const providerSessionId = text(input.providerSessionId, "provider session id", 1024);
		if (input.contextCheckpointObjectSha256) {
			sha256(input.contextCheckpointObjectSha256, "provider context checkpoint hash");
		}
		return this.#post(authority, {
			action: "bind_provider_session",
			providerSessionId,
			...(input.contextCheckpointObjectSha256
				? { contextCheckpointObjectSha256: input.contextCheckpointObjectSha256 }
				: {}),
		});
	}

	async prepareCompanyRevision(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: PrepareCloudRunnerCompanyRevisionInput,
	): Promise<unknown> {
		uuid(assignmentId, "assignment id");
		uuid(input.clientRevisionId, "client revision id");
		sha256(input.treeManifestSha256, "tree manifest hash");
		integer(input.treeManifestBytes, "tree manifest bytes", 1, 8 * 1024 * 1024);
		integer(input.treeContractVersion, "tree contract version", 3, 3);
		integer(input.fileCount, "tree file count", 0, 50_000);
		integer(input.totalBytes, "tree total bytes", 0, 1_099_511_627_776);
		return this.#post(authority, {
			action: "prepare_company_revision",
			assignmentId,
			clientRevisionId: input.clientRevisionId,
			treeManifestSha256: input.treeManifestSha256,
			treeManifestBytes: input.treeManifestBytes,
			treeContractVersion: input.treeContractVersion,
			fileCount: input.fileCount,
			totalBytes: input.totalBytes,
		});
	}

	async beginCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: BeginCloudRunnerCompanyRevisionGraphInput,
	): Promise<unknown> {
		uuid(assignmentId, "assignment id");
		uuid(input.snapshotId, "Company File snapshot id");
		uuid(input.clientGraphId, "Company File client graph id");
		sha256(input.rootObjectSha256, "Company File graph root hash");
		sha256(input.contentSha256, "Company File graph content hash");
		integer(input.objectCount, "Company File graph object count", 1, 400_000);
		integer(input.storageBytes, "Company File graph storage bytes", 0, 2_199_023_255_552);
		return this.#post(authority, { action: "begin_company_revision_graph", assignmentId, ...input });
	}

	async appendCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: AppendCloudRunnerCompanyRevisionGraphInput,
	): Promise<unknown> {
		uuid(assignmentId, "assignment id");
		uuid(input.graphId, "Company File graph id");
		if (input.entries.length < 1 || input.entries.length > REACHABILITY_BATCH_SIZE) {
			throw new Error("Company File graph page is invalid");
		}
		const entries = input.entries.map((entry) => ({
			sha256: sha256(entry.sha256, "Company File graph object hash"),
			bytes: integer(entry.bytes, "Company File graph object bytes", 0, MAX_OBJECT_BYTES),
		}));
		return this.#post(authority, {
			action: "append_company_revision_graph",
			assignmentId,
			graphId: input.graphId,
			entries,
		});
	}

	async completeCompanyRevisionGraph(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		graphId: string,
	): Promise<unknown> {
		return this.#post(authority, {
			action: "complete_company_revision_graph",
			assignmentId: uuid(assignmentId, "assignment id"),
			graphId: uuid(graphId, "Company File graph id"),
		});
	}

	async verifyCompanyRevision(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		snapshotId: string,
		graphId: string,
	): Promise<unknown> {
		return this.#post(authority, {
			action: "verify_company_revision",
			assignmentId: uuid(assignmentId, "assignment id"),
			snapshotId: uuid(snapshotId, "Company File snapshot id"),
			graphId: uuid(graphId, "Company File graph id"),
		});
	}

	async appendTranscriptEvent(
		authority: CloudRunnerBrokerAuthority,
		assignmentId: string,
		input: AppendCloudRunnerTranscriptEventInput,
	): Promise<unknown> {
		uuid(assignmentId, "assignment id");
		uuid(input.eventId, "transcript event id");
		if (
			input.eventType !== "message" &&
			input.eventType !== "run_receipt" &&
			input.eventType !== "artifact_receipt" &&
			input.eventType !== "authorization_request" &&
			input.eventType !== "authorization_decision"
		) {
			throw new Error("Runner broker transcript event type is invalid");
		}
		const entry = objectJson(input.entry, "transcript entry", 256 * 1024);
		if (input.expectedSequence !== undefined) {
			integer(input.expectedSequence, "transcript event sequence", 0, Number.MAX_SAFE_INTEGER);
		}
		return this.#post(authority, {
			action: "append_transcript",
			assignmentId,
			eventId: input.eventId,
			eventType: input.eventType,
			entry,
			...(input.expectedSequence === undefined ? {} : { expectedSequence: input.expectedSequence }),
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
			signal: this.#requestSignal(authority),
		});
		if (!response.ok) throw new Error(`Runner broker request failed (${response.status})`);
		return record(await response.json(), "response").value;
	}

	#requestSignal(authority: CloudRunnerBrokerAuthority): AbortSignal {
		const signals = [AbortSignal.timeout(this.#requestTimeoutMs)];
		if (this.#signal) signals.push(this.#signal);
		if (authority.signal) signals.push(authority.signal);
		return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
	}
}

export class CloudRunnerJobBroker implements CloudRunnerSubstrateResolver {
	readonly #options: CloudRunnerJobBrokerOptions;
	#description?: CloudRunnerBrokerDescription;
	#nativeAuthority?: CloudRunnerNativeAuthority;
	readonly #canonicalReceiptIds = new Map<string, string>();
	readonly objects: CloudContentAddressedStore;
	readonly companyFileObjects: CloudContentAddressedStore;

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
		this.objects = new CloudContentAddressedStore(new CloudRunnerBrokerObjectTransport(this, "artifact"));
		this.companyFileObjects = new CloudContentAddressedStore(
			new CloudRunnerBrokerObjectTransport(this, "company_file"),
		);
	}

	async describe(): Promise<CloudRunnerBrokerDescription> {
		if (this.#description) return this.#description;
		const description = parseCloudRunnerBrokerDescription(await this.#options.transport.describe(this.#authority()));
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
			description.run.substrateVersionId !== description.job.substrateVersionId ||
			description.run.companySnapshotId !== description.snapshot.snapshotId ||
			description.run.sponsorBindingId !== description.sponsor.bindingId ||
			description.run.sponsorVersion !== description.sponsor.version ||
			description.run.requiredCapability !== description.job.requiredCapability ||
			description.run.jobType !== description.job.jobType ||
			description.version.versionId !== this.#options.job.substrateVersionId ||
			description.version.profileId !== this.#options.job.profileId ||
			description.version.environmentId !== this.#options.job.environmentId ||
			description.snapshot.snapshotId !== description.version.companySnapshotId ||
			description.snapshot.profileId !== description.version.profileId ||
			description.snapshot.environmentId !== description.version.environmentId ||
			description.version.artifactIndexId !== description.artifactIndex?.indexId ||
			description.version.artifactManifestSha256 !== description.artifactIndex?.contentSha256 ||
			(description.run.sourceKind === "proposal_review") !== (description.proposalSnapshot !== undefined) ||
			(description.proposalSnapshot !== undefined &&
				(description.proposalSnapshot.profileId !== description.run.profileId ||
					description.proposalSnapshot.environmentId !== description.run.environmentId ||
					description.proposalSnapshot.tree.contractVersion !== 3))
		) {
			throw new Error("Runner broker returned another job substrate");
		}
		this.#description = description;
		return description;
	}

	async listTranscript(afterSequence = 0, limit = 200): Promise<CloudRunnerTranscriptContextEvent[]> {
		const description = await this.describe();
		integer(afterSequence, "transcript cursor", 0, description.run.transcriptStartSequence);
		integer(limit, "transcript page size", 1, 500);
		const events = array(
			await this.#options.transport.listTranscript(this.#authority(), afterSequence, limit),
			"transcript page",
		).map(parseTranscriptContextEvent);
		if (
			events.some(
				(event, index) =>
					event.sessionId !== description.run.sessionId ||
					event.sequence <= afterSequence ||
					event.sequence > description.run.transcriptStartSequence ||
					(index > 0 && event.sequence <= events[index - 1].sequence),
			)
		) {
			throw new Error("Runner broker returned transcript outside the pinned run context");
		}
		return events;
	}

	async listInputs(): Promise<CloudRunnerQueuedInput[]> {
		const description = await this.describe();
		const inputs = array(await this.#options.transport.listInputs(this.#authority()), "execution inputs", 32).map(
			(value) => {
				const input = record(value, "execution input");
				if (input.kind !== "kickoff" && input.kind !== "user_message") {
					throw new Error("Runner broker returned invalid execution input kind");
				}
				const kind: CloudRunnerQueuedInput["kind"] = input.kind;
				return {
					inputId: uuid(input.input_id, "execution input id"),
					position: integer(input.position, "execution input position", 1, Number.MAX_SAFE_INTEGER),
					kind,
					authorUserId: uuid(input.author_user_id, "execution input author id"),
					authorDisplayName: text(input.author_display_name, "execution input author name", 256),
					body: objectJson(input.body, "execution input body", 128 * 1024),
					createdAt: timestamp(input.created_at, "execution input creation time"),
				};
			},
		);
		if (
			inputs.length !== description.run.inputIds.length ||
			inputs.some((input, index) => input.inputId !== description.run.inputIds[index])
		) {
			throw new Error("Runner broker returned another execution input set");
		}
		return inputs;
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

	async resolveExecution(job: CloudRunnerJob): Promise<{
		run: CloudRunnerExecutionRun;
		sponsor: CloudRunnerExecutionSponsor;
	}> {
		const description = await this.describe();
		if (
			job.jobId !== description.job.jobId ||
			job.runId !== description.run.runId ||
			job.assignmentId !== description.job.assignmentId
		) {
			throw new Error("Runner broker cannot resolve another execution");
		}
		return {
			run: description.run,
			sponsor: description.sponsor,
			...(description.proposalSnapshot ? { proposalSnapshot: description.proposalSnapshot } : {}),
		};
	}

	async acquireNativeAuthority(leaseSeconds = 120): Promise<CloudRunnerNativeAuthority> {
		const description = await this.describe();
		if (description.sponsor.authenticationMode !== "native_subscription") {
			throw new Error("Runner execution does not use a native subscription");
		}
		const acquire = this.#options.transport.acquireNativeAuthority;
		if (!acquire) throw new Error("Runner broker does not support native subscription authority");
		const assignmentId = this.#assignmentId();
		const authority = parseNativeAuthority(
			await acquire.call(
				this.#options.transport,
				this.#authority(),
				description.run.runId,
				assignmentId,
				leaseSeconds,
			),
		);
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

	async renewNativeAuthority(leaseSeconds = 120): Promise<CloudRunnerNativeAuthority> {
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

	async requestModel(input: CloudRunnerModelRequest): Promise<CloudRunnerModelResponse> {
		if ((await this.describe()).sponsor.authenticationMode === "native_subscription") {
			throw new Error("Native subscription traffic must use the provider-native harness");
		}
		const request = validateCloudRunnerModelRequest(input);
		const response = parseCloudRunnerModelResponse(
			await this.#options.transport.requestModel(this.#authority(), request),
		);
		if (
			response.requestId !== request.requestId ||
			response.provider !== request.provider ||
			response.model !== request.model ||
			response.usage.outputTokens > request.maxOutputTokens
		) {
			throw new Error("Runner model broker returned another request");
		}
		return response;
	}

	async beginOperation(input: BeginCloudRunnerOperationInput): Promise<CloudRunnerOperationReceipt> {
		const receipt = parseOperationReceipt(
			await this.#options.transport.beginOperation(this.#authority(), this.#assignmentId(), input),
		);
		this.#canonicalReceiptIds.set(input.receiptId, receipt.receiptId);
		this.#canonicalReceiptIds.set(receipt.receiptId, receipt.receiptId);
		return receipt;
	}

	async completeOperation(input: CompleteCloudRunnerOperationInput): Promise<CloudRunnerOperationReceipt> {
		const receiptId = this.#canonicalReceiptIds.get(input.receiptId) ?? input.receiptId;
		const receipt = parseOperationReceipt(
			await this.#options.transport.completeOperation(this.#authority(), this.#assignmentId(), {
				...input,
				receiptId,
			}),
		);
		if (receipt.receiptId !== receiptId || receipt.state !== "completed") {
			throw new Error("Runner operation broker returned an incomplete receipt");
		}
		return receipt;
	}

	async bindProviderSession(input: BindCloudRunnerProviderSessionInput): Promise<CloudRunnerProviderSessionBinding> {
		const description = await this.describe();
		const providerSessionId = input.providerSessionId.trim();
		const binding = parseProviderSessionBinding(
			await this.#options.transport.bindProviderSession(this.#authority(), { ...input, providerSessionId }),
		);
		if (
			binding.runId !== this.#runId() ||
			binding.providerConnectionId !== description.sponsor.providerConnectionId ||
			binding.providerSessionId !== providerSessionId
		) {
			throw new Error("Runner broker bound another provider session");
		}
		return binding;
	}

	async prepareCompanyRevision(input: PrepareCloudRunnerCompanyRevisionInput): Promise<HostedCompanySnapshot> {
		const description = await this.describe();
		const snapshot = parseSnapshot(
			await this.#options.transport.prepareCompanyRevision(this.#authority(), this.#assignmentId(), input),
		);
		if (
			snapshot.profileId !== description.run.profileId ||
			snapshot.environmentId !== description.run.environmentId ||
			snapshot.clientSnapshotId !== input.clientRevisionId ||
			snapshot.parentSnapshotId !== description.run.companySnapshotId ||
			snapshot.tree.manifestSha256 !== input.treeManifestSha256 ||
			snapshot.tree.manifestBytes !== input.treeManifestBytes ||
			snapshot.tree.contractVersion !== input.treeContractVersion ||
			snapshot.tree.fileCount !== input.fileCount ||
			snapshot.tree.totalBytes !== input.totalBytes
		) {
			throw new Error("Runner broker prepared another Company File revision");
		}
		return snapshot;
	}

	async beginCompanyRevisionGraph(
		input: BeginCloudRunnerCompanyRevisionGraphInput,
	): Promise<CloudRunnerCompanyRevisionGraph> {
		const graph = parseCompanyRevisionGraph(
			await this.#options.transport.beginCompanyRevisionGraph(this.#authority(), this.#assignmentId(), input),
		);
		if (
			graph.snapshotId !== input.snapshotId ||
			graph.clientGraphId !== input.clientGraphId ||
			graph.rootObjectSha256 !== input.rootObjectSha256 ||
			graph.contentSha256 !== input.contentSha256 ||
			graph.objectCount !== input.objectCount ||
			graph.storageBytes !== input.storageBytes
		) {
			throw new Error("Runner broker prepared another Company File reachability graph");
		}
		return graph;
	}

	async appendCompanyRevisionGraph(input: AppendCloudRunnerCompanyRevisionGraphInput): Promise<number> {
		const count = await this.#options.transport.appendCompanyRevisionGraph(
			this.#authority(),
			this.#assignmentId(),
			input,
		);
		return integer(count, "Company File graph uploaded count", input.entries.length, 400_000);
	}

	async completeCompanyRevisionGraph(graphId: string): Promise<CloudRunnerCompanyRevisionGraph> {
		const graph = parseCompanyRevisionGraph(
			await this.#options.transport.completeCompanyRevisionGraph(this.#authority(), this.#assignmentId(), graphId),
		);
		if (graph.graphId !== graphId || graph.status !== "complete") {
			throw new Error("Runner broker did not complete the Company File reachability graph");
		}
		return graph;
	}

	async verifyCompanyRevision(snapshotId: string, graphId: string): Promise<CloudRunnerCompanyRevisionVerification> {
		return parseCompanyRevisionVerification(
			await this.#options.transport.verifyCompanyRevision(
				this.#authority(),
				this.#assignmentId(),
				snapshotId,
				graphId,
			),
		);
	}

	async appendTranscriptEvent(input: AppendCloudRunnerTranscriptEventInput): Promise<CloudRunnerTranscriptEvent> {
		const rawEntry = record(input.entry, "transcript entry");
		const expectedEntryType = input.eventType === "message" ? "message" : "custom";
		if (
			rawEntry.type !== expectedEntryType ||
			(input.eventType !== "message" && rawEntry.customType !== input.eventType) ||
			rawEntry.id !== input.eventId ||
			(rawEntry.parentId !== null && typeof rawEntry.parentId !== "string") ||
			typeof rawEntry.timestamp !== "string" ||
			!Number.isFinite(Date.parse(rawEntry.timestamp)) ||
			rawEntry.execution !== undefined
		) {
			throw new Error("Runner broker transcript entry is invalid");
		}
		const entry = objectJson(
			{
				...rawEntry,
				execution: {
					kind: "run",
					id: this.#runId(),
					claimantId: this.#runId(),
					runnerAssignmentId: this.#assignmentId(),
				},
			},
			"transcript entry",
			256 * 1024,
		);
		const event = parseTranscriptEvent(
			await this.#options.transport.appendTranscriptEvent(this.#authority(), this.#assignmentId(), {
				...input,
				entry,
			}),
		);
		const returnedEntry = record(event.entry, "transcript entry");
		const returnedExecution = record(returnedEntry.execution, "transcript execution identity");
		if (
			event.executionRunId !== this.#runId() ||
			event.assignmentId !== this.#assignmentId() ||
			event.eventId !== input.eventId ||
			event.eventType !== input.eventType ||
			returnedExecution.kind !== "run" ||
			returnedExecution.id !== this.#runId() ||
			returnedExecution.claimantId !== this.#runId() ||
			returnedExecution.runnerAssignmentId !== this.#assignmentId()
		) {
			throw new Error("Runner broker appended another transcript event");
		}
		return event;
	}

	async profileId(): Promise<string> {
		return (await this.describe()).version.profileId;
	}

	async readObject(objectSha256: string): Promise<Uint8Array> {
		return this.#options.transport.getObject(this.#authority(), objectSha256);
	}

	async writeObject(
		objectSha256: string,
		bytes: Uint8Array,
		mediaType: string,
		purpose: "artifact" | "company_file",
	): Promise<"exists" | "stored"> {
		return this.#options.transport.putObject(this.#authority(), objectSha256, bytes, mediaType, purpose);
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

	#runId(): string {
		if (!this.#options.job.runId) throw new Error("Runner job has no durable execution run");
		return this.#options.job.runId;
	}
}

class CloudRunnerBrokerObjectTransport implements CloudObjectTransport {
	readonly #broker: CloudRunnerJobBroker;
	readonly #purpose: "artifact" | "company_file";

	constructor(broker: CloudRunnerJobBroker, purpose: "artifact" | "company_file") {
		this.#broker = broker;
		this.#purpose = purpose;
	}

	async put(path: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored"> {
		const sha = await this.#pathSha(path);
		return this.#broker.writeObject(sha, bytes, mediaType, this.#purpose);
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

function deterministicUuid(value: string): string {
	const bytes = createHash("sha256").update(value).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex", 0, 16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameTree(
	left: CloudCompanyTreeReference,
	right: {
		manifestSha256: string;
		manifestBytes: number;
		contractVersion: number;
		fileCount: number;
		totalBytes: number;
	},
): boolean {
	return (
		left.manifestSha256 === right.manifestSha256 &&
		left.manifestBytes === right.manifestBytes &&
		left.contractVersion === right.contractVersion &&
		left.fileCount === right.fileCount &&
		left.totalBytes === right.totalBytes
	);
}

function canonicalReachability(captured: CapturedCloudCompanyTree): CapturedCloudCompanyTree["restore"]["objects"] {
	const objects = new Map<string, number>();
	for (const object of captured.restore.objects) {
		const existingBytes = objects.get(object.sha256);
		if (existingBytes !== undefined && existingBytes !== object.bytes) {
			throw new Error("Runner Company File reachability contains inconsistent object sizes");
		}
		objects.set(object.sha256, object.bytes);
	}
	return [...objects.entries()]
		.map(([sha256, bytes]) => ({ sha256, bytes }))
		.sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
}

function reachabilityHash(objects: readonly { sha256: string; bytes: number }[]): string {
	return createHash("sha256")
		.update(objects.map((object) => `${object.sha256}:${object.bytes}`).join("\n"))
		.digest("hex");
}

async function verificationDelay(signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Runner execution was cancelled");
	await new Promise<void>((resolveDelay, rejectDelay) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolveDelay();
		}, VERIFICATION_RETRY_DELAY_MS);
		const abort = (): void => {
			clearTimeout(timer);
			rejectDelay(new Error("Runner execution was cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export class CloudRunnerBrokerCompanyFilePublisher implements CloudRunnerCompanyFilePublisher {
	readonly #broker: CloudRunnerJobBroker;

	constructor(broker: CloudRunnerJobBroker) {
		this.#broker = broker;
	}

	async publish(input: CloudRunnerCompanyFilePublicationInput): Promise<string | undefined> {
		const description = await this.#broker.describe();
		if (
			input.profileId !== description.run.profileId ||
			input.environmentId !== description.run.environmentId ||
			input.jobId !== description.job.jobId ||
			input.baseSnapshot.snapshotId !== description.run.companySnapshotId ||
			input.baseSnapshot.profileId !== input.profileId ||
			input.baseSnapshot.environmentId !== input.environmentId
		) {
			throw new Error("Runner Company File publication is outside its leased job");
		}
		const captured = await captureCloudCompanyTreeWithReachability(
			input.companyRoot,
			input.profileId,
			this.#broker.companyFileObjects,
			{ forceFullVerification: true },
		);
		if (sameTree(captured.tree, description.snapshot.tree)) return undefined;
		const objects = canonicalReachability(captured);
		const storageBytes = objects.reduce((total, object) => total + object.bytes, 0);
		if (
			objects.length < 1 ||
			objects.length > 400_000 ||
			objects.length > description.companyFileOutputLimits.maxObjectCount ||
			storageBytes > description.companyFileOutputLimits.maxTotalBytes
		) {
			throw new Error("Runner Company File output exceeds its durable publication limits");
		}
		const clientRevisionId = deterministicUuid(
			`qorpera.runner-company-revision/v1:${description.run.runId}:${captured.tree.manifestSha256}`,
		);
		const snapshot = await this.#broker.prepareCompanyRevision({
			clientRevisionId,
			treeManifestSha256: captured.tree.manifestSha256,
			treeManifestBytes: captured.tree.manifestBytes,
			treeContractVersion: 3,
			fileCount: captured.tree.fileCount,
			totalBytes: captured.tree.totalBytes,
		});
		let graph = await this.#broker.beginCompanyRevisionGraph({
			snapshotId: snapshot.snapshotId,
			clientGraphId: deterministicUuid(`qorpera.runner-company-graph/v1:${snapshot.snapshotId}`),
			rootObjectSha256: captured.tree.manifestSha256,
			contentSha256: reachabilityHash(objects),
			objectCount: objects.length,
			storageBytes,
		});
		if (graph.status === "uploading") {
			for (let offset = 0; offset < objects.length; offset += REACHABILITY_BATCH_SIZE) {
				await this.#broker.appendCompanyRevisionGraph({
					graphId: graph.graphId,
					entries: objects.slice(offset, offset + REACHABILITY_BATCH_SIZE),
				});
			}
			graph = await this.#broker.completeCompanyRevisionGraph(graph.graphId);
		}
		while (true) {
			const verification = await this.#broker.verifyCompanyRevision(snapshot.snapshotId, graph.graphId);
			if (verification.verified) return snapshot.snapshotId;
			await verificationDelay(input.signal);
		}
	}
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
