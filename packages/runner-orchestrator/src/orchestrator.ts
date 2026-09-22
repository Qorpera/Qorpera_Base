import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import type { ServiceHttpFetch } from "./http-transport.ts";
import { CloudRunnerProviderRequestError } from "./provider-http.ts";

export type CloudRunnerCapability = "agent_turn" | "git_worktree" | "company_substrate";
export type CloudComputeIdentityOwnershipKind = "member" | "company" | "department" | "security_boundary";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

export type CloudExecutionSourceKind =
	| "session_turn"
	| "wake"
	| "manual"
	| "room_delivery"
	| "proposal_review"
	| "system";
export type CloudExecutionSponsorKind = "member_connection" | "company_service_account" | "company_api_billing";
export type CloudProviderAuthenticationMode =
	| "native_subscription"
	| "enterprise_access_token"
	| "api_key"
	| "cloud_service_account";

export interface CloudExecutionSponsorPin {
	bindingId: string;
	version: number;
	kind: CloudExecutionSponsorKind;
	providerConnectionId: string;
	providerConnectionVersion: number;
	provider: string;
	authenticationMode: CloudProviderAuthenticationMode;
	nativeHarness: string;
	allowAutonomous: boolean;
}

export interface CloudRunnerModelPolicyPin {
	provider: string;
	model: string;
	maxCalls: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxCostMicrousd: number;
}

export interface CloudRunnerWork {
	runId: string;
	jobId: string;
	profileId: string;
	environmentId: string;
	sourceKind: CloudExecutionSourceKind;
	sourceId: string;
	sessionId?: string;
	substrateVersionId: string;
	companySnapshotId: string;
	staffAgentId: string;
	staffVersion: number;
	inputIds: readonly string[];
	transcriptStartSequence: number;
	deadlineAt: string;
	requiredCapability: CloudRunnerCapability;
	jobType: string;
	payload: JsonValue;
	publicationMode: "automatic" | "review";
	reviewPolicyKey?: string;
	reviewerStaffIds: readonly string[];
	logicalComputerId?: string;
	computeIdentityId?: string;
	computeIdentityOwnershipKind?: CloudComputeIdentityOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	computeTemplateKey?: string;
	computeTemplateVersion?: string;
	computePolicySha256?: string;
	workerClass: "managed_sandbox" | "company_computer";
	requestedByUserId: string;
	sponsoredByUserId?: string;
	sponsor: CloudExecutionSponsorPin;
	modelPolicy: CloudRunnerModelPolicyPin;
	attempt: number;
}

export interface CloudRunnerOrchestrationClaim {
	claimId: string;
	orchestratorId: string;
	status: "claimed" | "assigned";
	work: CloudRunnerWork;
	leaseExpiresAt: string;
}

export interface CloudRunnerInstance {
	runnerId: string;
	logicalComputerId?: string;
	computeIdentityId?: string;
	workerClass: "managed_sandbox" | "company_computer";
	providerAdapter: string;
	capabilities: readonly CloudRunnerCapability[];
	templateKey: string;
	templateVersion: string;
	policySha256: string;
}

export interface CloudRunnerAssignment {
	assignmentId: string;
	claimId: string;
	runId: string;
	jobId: string;
	runnerId: string;
	capabilitySha256: string;
	expiresAt: string;
}

export interface CloudRunnerAssignmentDelivery {
	assignment: CloudRunnerAssignment;
	capability: string;
	work: CloudRunnerWork;
}

export interface CloudRoutineScheduleHead {
	routineId: string;
	profileId: string;
	environmentId: string;
	version: number;
	staffAgentId: string;
	triggers: JsonValue;
	scheduleCursors: readonly CloudRoutineScheduleCursor[];
	contentSha256: string;
	effectiveAt: string;
	updatedAt: string;
}

export interface CloudRoutineScheduleCursor {
	triggerId: string;
	lastScheduledFor?: string;
	nextDueAt?: string;
}

export interface CloudRoutineSchedulePage {
	items: readonly CloudRoutineScheduleHead[];
	hasMore: boolean;
	nextAfterRoutineId?: string;
}

export interface EnqueueCloudRoutineWakeInput {
	routineId: string;
	expectedVersion: number;
	occurrenceId: string;
	occurrenceKey: string;
	triggerId: string;
	scheduledFor: string;
	expectedLastScheduledFor?: string;
	nextDueAt: string;
	payload: JsonValue;
}

export interface CloudRoutineWakeOccurrence {
	occurrenceId: string;
	status: "queued" | "materialized" | "completed" | "failed" | "requires_review" | "cancelled";
	runId?: string;
	scheduledFor: string;
}

export interface CloudRunnerOrchestratorControlPlane {
	renewControl?(signal?: AbortSignal): Promise<void>;
	listRoutineScheduleHeads(
		afterRoutineId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudRoutineSchedulePage>;
	enqueueRoutineWake(input: EnqueueCloudRoutineWakeInput, signal?: AbortSignal): Promise<CloudRoutineWakeOccurrence>;
	reconcileExpired(orchestratorId: string, signal?: AbortSignal): Promise<void>;
	retainedClaims(orchestratorId: string, signal?: AbortSignal): Promise<readonly CloudRunnerOrchestrationClaim[]>;
	claimNext(
		orchestratorId: string,
		clientClaimId: string,
		leaseSeconds: number,
		signal?: AbortSignal,
	): Promise<CloudRunnerOrchestrationClaim | undefined>;
	renewClaim(
		claim: CloudRunnerOrchestrationClaim,
		leaseSeconds: number,
		signal?: AbortSignal,
	): Promise<CloudRunnerOrchestrationClaim>;
	assign(
		claim: CloudRunnerOrchestrationClaim,
		runner: CloudRunnerInstance,
		clientAssignmentId: string,
		capabilitySha256: string,
		assignmentSeconds: number,
		signal?: AbortSignal,
	): Promise<CloudRunnerAssignment>;
	releaseClaim(
		claim: CloudRunnerOrchestrationClaim,
		clientAssignmentId: string,
		error: string,
		signal?: AbortSignal,
	): Promise<void>;
}

export interface CloudRunnerOccurrenceReconciler {
	reconcile(controlPlane: CloudRunnerOrchestratorControlPlane, signal?: AbortSignal): Promise<void>;
}

export interface CloudRoutineScheduleReconcilerOptions {
	now?: () => Date;
	pageSize?: number;
	catchUpLimit?: number;
}

export interface CloudRunnerProviderAdapter {
	readonly adapterId: string;
	reconcile(signal?: AbortSignal): Promise<void>;
	acquire(work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance>;
	deliver(runner: CloudRunnerInstance, delivery: CloudRunnerAssignmentDelivery, signal?: AbortSignal): Promise<void>;
	stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void>;
}

export type CloudRunnerOrchestratorResult = (
	| { status: "idle" }
	| { status: "awaiting_assignment"; claim: CloudRunnerOrchestrationClaim }
	| {
			status: "assigned";
			claim: CloudRunnerOrchestrationClaim;
			runner: CloudRunnerInstance;
			assignment: CloudRunnerAssignment;
	  }
) & { reconciliationErrors?: readonly unknown[] };

export interface CloudRunnerOrchestratorOptions {
	orchestratorId: string;
	controlPlane: CloudRunnerOrchestratorControlPlane;
	providerAdapter: CloudRunnerProviderAdapter;
	occurrenceReconcilers?: readonly CloudRunnerOccurrenceReconciler[];
	claimLeaseSeconds?: number;
	claimRenewalIntervalMs?: number;
	assignmentSeconds?: number;
	dispatchConcurrency?: number;
	clientClaimId?: () => string;
	clientAssignmentId?: () => string;
	createCapability?: () => string;
}

export interface CloudRunnerOrchestratorLoopOptions {
	pollIntervalMs?: number;
	shutdownGraceMs?: number;
	onError?: (error: unknown) => void;
}

type CloudRunnerOrchestratorRequest =
	| {
			action: "rotate_control";
			orchestratorId: string;
			nextControlTokenSha256: string;
			controlTokenSeconds: number;
	  }
	| { action: "routine_heads"; orchestratorId: string; afterRoutineId?: string; limit: number }
	| {
			action: "enqueue_wake";
			orchestratorId: string;
			routineId: string;
			expectedVersion: number;
			occurrenceId: string;
			occurrenceKey: string;
			triggerId: string;
			scheduledFor: string;
			expectedLastScheduledFor?: string;
			nextDueAt: string;
			payload: JsonValue;
	  }
	| { action: "reconcile"; orchestratorId: string }
	| { action: "retained"; orchestratorId: string }
	| { action: "claim"; orchestratorId: string; clientClaimId: string; leaseSeconds: number }
	| { action: "renew_claim"; orchestratorId: string; claimId: string; leaseSeconds: number }
	| {
			action: "assign";
			orchestratorId: string;
			claimId: string;
			runnerId: string;
			clientAssignmentId: string;
			capabilitySha256: string;
			assignmentSeconds: number;
	  }
	| {
			action: "release_claim";
			orchestratorId: string;
			claimId: string;
			clientAssignmentId: string;
			error: string;
	  };

function requiredUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function requiredSeconds(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 30 || value > maximum) {
		throw new Error(`${label} is outside the supported range`);
	}
	return value;
}

/* A rejection that carries a numeric status came back as an actual response
 * from the provider or control plane and is definitive; timeouts, aborts, and
 * transport faults carry none and leave the operation's outcome unknown. */
function definitiveRejectionStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

/** A typed admission refusal is reported by its reason code so the control plane can defer the job
 * instead of counting an infrastructure failure; everything else stays a redacted message. */
function deliveryFailure(error: unknown): string {
	if (error instanceof CloudRunnerProviderRequestError && error.admission)
		return `ADMISSION_REFUSED:${error.admission.reason}`;
	return safeDeliveryFailure(error);
}

function safeDeliveryFailure(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]")
			.slice(0, 1000)
			.trim() || "Runner assignment delivery failed"
	);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function responseUuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value;
}

function responseText(value: unknown, label: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		value.length < 1 ||
		value.length > maximum ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value;
}

function responseTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return new Date(value).toISOString();
}

function responseInteger(value: unknown, label: string, minimum = 1, maximum = 1_000_000): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value as number;
}

function responseSequence(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value as number;
}

function responseSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value;
}

function parseRoutineScheduleHead(value: unknown): CloudRoutineScheduleHead {
	const input = record(value, "routine schedule head");
	if (!Array.isArray(input.triggers) || input.triggers.length < 1 || input.triggers.length > 12) {
		throw new Error("Runner orchestrator returned invalid routine triggers");
	}
	if (!Array.isArray(input.schedule_cursors) || input.schedule_cursors.length > 12) {
		throw new Error("Runner orchestrator returned invalid routine schedule cursors");
	}
	return {
		routineId: responseUuid(input.routine_id, "routine id"),
		profileId: responseUuid(input.profile_id, "routine profile id"),
		environmentId: responseUuid(input.environment_id, "routine environment id"),
		version: responseInteger(input.version, "routine version"),
		staffAgentId: responseUuid(input.staff_agent_id, "routine staff agent id"),
		triggers: structuredClone(input.triggers) as JsonValue,
		scheduleCursors: input.schedule_cursors.map((value) => {
			const cursor = record(value, "routine schedule cursor");
			const lastScheduledFor =
				cursor.last_scheduled_for === null || cursor.last_scheduled_for === undefined
					? undefined
					: responseTimestamp(cursor.last_scheduled_for, "routine last scheduled time");
			const nextDueAt =
				cursor.next_due_at === null || cursor.next_due_at === undefined
					? undefined
					: responseTimestamp(cursor.next_due_at, "routine next due time");
			if ((lastScheduledFor === undefined) !== (nextDueAt === undefined)) {
				throw new Error("Runner orchestrator returned inconsistent routine schedule cursor");
			}
			return {
				triggerId: responseText(cursor.trigger_id, "routine trigger id", 160),
				...(lastScheduledFor ? { lastScheduledFor } : {}),
				...(nextDueAt ? { nextDueAt } : {}),
			};
		}),
		contentSha256: responseSha256(input.content_sha256, "routine content hash"),
		effectiveAt: responseTimestamp(input.effective_at, "routine version effective time"),
		updatedAt: responseTimestamp(input.updated_at, "routine update time"),
	};
}

function parseRoutineSchedulePage(value: unknown): CloudRoutineSchedulePage {
	const input = record(value, "routine schedule page");
	if (!Array.isArray(input.items) || typeof input.has_more !== "boolean") {
		throw new Error("Runner orchestrator returned invalid routine schedule page");
	}
	const nextAfterRoutineId =
		input.next_after_routine_id === null || input.next_after_routine_id === undefined
			? undefined
			: responseUuid(input.next_after_routine_id, "routine schedule cursor");
	if (input.has_more !== (nextAfterRoutineId !== undefined)) {
		throw new Error("Runner orchestrator returned inconsistent routine schedule pagination");
	}
	return {
		items: input.items.map(parseRoutineScheduleHead),
		hasMore: input.has_more,
		...(nextAfterRoutineId ? { nextAfterRoutineId } : {}),
	};
}

function parseRoutineWakeOccurrence(value: unknown): CloudRoutineWakeOccurrence {
	const input = record(value, "routine wake occurrence");
	if (
		input.status !== "queued" &&
		input.status !== "materialized" &&
		input.status !== "completed" &&
		input.status !== "failed" &&
		input.status !== "requires_review" &&
		input.status !== "cancelled"
	) {
		throw new Error("Runner orchestrator returned invalid wake occurrence status");
	}
	const runId =
		input.run_id === null || input.run_id === undefined
			? undefined
			: responseUuid(input.run_id, "wake occurrence run id");
	return {
		occurrenceId: responseUuid(input.occurrence_id, "wake occurrence id"),
		status: input.status,
		...(runId ? { runId } : {}),
		scheduledFor: responseTimestamp(input.scheduled_for, "wake occurrence schedule"),
	};
}

function parseExecutionSponsor(value: unknown): CloudExecutionSponsorPin {
	const input = record(value, "execution sponsor");
	if (
		input.kind !== "member_connection" &&
		input.kind !== "company_service_account" &&
		input.kind !== "company_api_billing"
	) {
		throw new Error("Runner orchestrator returned invalid sponsor kind");
	}
	if (
		input.authentication_mode !== "native_subscription" &&
		input.authentication_mode !== "enterprise_access_token" &&
		input.authentication_mode !== "api_key" &&
		input.authentication_mode !== "cloud_service_account"
	) {
		throw new Error("Runner orchestrator returned invalid provider authentication mode");
	}
	if (
		typeof input.provider !== "string" ||
		!PROVIDER_ID_PATTERN.test(input.provider) ||
		typeof input.native_harness !== "string" ||
		!input.native_harness.trim() ||
		input.native_harness.length > 120 ||
		typeof input.allow_autonomous !== "boolean"
	) {
		throw new Error("Runner orchestrator returned invalid provider authority");
	}
	return {
		bindingId: responseUuid(input.binding_id, "sponsor binding id"),
		version: responseInteger(input.version, "sponsor version"),
		kind: input.kind,
		providerConnectionId: responseUuid(input.provider_connection_id, "provider connection id"),
		providerConnectionVersion: responseInteger(input.provider_connection_version, "provider connection version"),
		provider: input.provider,
		authenticationMode: input.authentication_mode,
		nativeHarness: input.native_harness,
		allowAutonomous: input.allow_autonomous,
	};
}

function parseRunnerModelPolicy(value: unknown): CloudRunnerModelPolicyPin {
	const input = record(value, "runner model policy");
	if (!Array.isArray(input.allowed_models) || input.allowed_models.length !== 1) {
		throw new Error("Runner orchestrator returned invalid model authority");
	}
	const allowed = record(input.allowed_models[0], "allowed runner model");
	const provider = responseText(allowed.provider, "model provider", 64);
	const model = responseText(allowed.model, "model id", 160);
	if (!PROVIDER_ID_PATTERN.test(provider)) throw new Error("Runner orchestrator returned invalid model provider");
	return {
		provider,
		model,
		maxCalls: responseInteger(input.max_calls, "model call budget"),
		maxInputTokens: responseInteger(input.max_input_tokens, "model input budget", 1, 100_000_000),
		maxOutputTokens: responseInteger(input.max_output_tokens, "model output budget", 1, 100_000_000),
		maxCostMicrousd: responseInteger(input.max_cost_microusd, "model cost budget", 1, Number.MAX_SAFE_INTEGER),
	};
}

function parseRunnerWork(value: unknown): CloudRunnerWork {
	const input = record(value, "runner work");
	if (
		input.source_kind !== "session_turn" &&
		input.source_kind !== "wake" &&
		input.source_kind !== "manual" &&
		input.source_kind !== "room_delivery" &&
		input.source_kind !== "proposal_review" &&
		input.source_kind !== "system"
	) {
		throw new Error("Runner orchestrator returned invalid execution source");
	}
	if (
		input.required_capability !== "agent_turn" &&
		input.required_capability !== "git_worktree" &&
		input.required_capability !== "company_substrate"
	) {
		throw new Error("Runner orchestrator returned invalid runner capability");
	}
	if (typeof input.job_type !== "string" || typeof input.payload !== "object" || input.payload === null) {
		throw new Error("Runner orchestrator returned invalid work payload");
	}
	if (input.publication_mode !== "automatic" && input.publication_mode !== "review") {
		throw new Error("Runner orchestrator returned invalid publication mode");
	}
	if (!Array.isArray(input.input_ids) || input.input_ids.length > 32) {
		throw new Error("Runner orchestrator returned invalid execution inputs");
	}
	if (!Array.isArray(input.reviewer_staff_ids) || input.reviewer_staff_ids.length > 20) {
		throw new Error("Runner orchestrator returned invalid execution reviewers");
	}
	if (input.worker_class !== "managed_sandbox" && input.worker_class !== "company_computer") {
		throw new Error("Runner orchestrator returned invalid worker class");
	}
	if (
		input.compute_identity_ownership_kind !== null &&
		input.compute_identity_ownership_kind !== undefined &&
		input.compute_identity_ownership_kind !== "member" &&
		input.compute_identity_ownership_kind !== "company" &&
		input.compute_identity_ownership_kind !== "department" &&
		input.compute_identity_ownership_kind !== "security_boundary"
	) {
		throw new Error("Runner orchestrator returned invalid compute identity ownership");
	}
	const work: CloudRunnerWork = {
		runId: responseUuid(input.run_id, "run id"),
		jobId: responseUuid(input.job_id, "job id"),
		profileId: responseUuid(input.profile_id, "profile id"),
		environmentId: responseUuid(input.environment_id, "environment id"),
		sourceKind: input.source_kind,
		sourceId: responseUuid(input.source_id, "source id"),
		...(input.session_id === null || input.session_id === undefined
			? {}
			: { sessionId: responseUuid(input.session_id, "session id") }),
		substrateVersionId: responseUuid(input.substrate_version_id, "substrate version id"),
		companySnapshotId: responseUuid(input.company_snapshot_id, "Company File snapshot id"),
		staffAgentId: responseUuid(input.staff_agent_id, "staff agent id"),
		staffVersion: responseInteger(input.staff_version, "staff version"),
		inputIds: input.input_ids.map((value) => responseUuid(value, "input id")),
		transcriptStartSequence: responseSequence(input.transcript_start_sequence, "transcript start sequence"),
		deadlineAt: responseTimestamp(input.deadline_at, "run deadline"),
		requiredCapability: input.required_capability,
		jobType: input.job_type,
		payload: structuredClone(input.payload) as JsonValue,
		publicationMode: input.publication_mode,
		...(input.review_policy_key === null || input.review_policy_key === undefined
			? {}
			: { reviewPolicyKey: responseText(input.review_policy_key, "review policy key", 128) }),
		reviewerStaffIds: input.reviewer_staff_ids.map((value) => responseUuid(value, "reviewer staff id")),
		...(input.logical_computer_id === null || input.logical_computer_id === undefined
			? {}
			: { logicalComputerId: responseUuid(input.logical_computer_id, "logical computer id") }),
		...(input.compute_identity_id === null || input.compute_identity_id === undefined
			? {}
			: { computeIdentityId: responseUuid(input.compute_identity_id, "compute identity id") }),
		...(input.compute_identity_ownership_kind === null || input.compute_identity_ownership_kind === undefined
			? {}
			: { computeIdentityOwnershipKind: input.compute_identity_ownership_kind }),
		...(input.compute_identity_owner_user_id === null || input.compute_identity_owner_user_id === undefined
			? {}
			: {
					computeIdentityOwnerUserId: responseUuid(
						input.compute_identity_owner_user_id,
						"compute identity owner user id",
					),
				}),
		...(input.compute_identity_owner_scope_key === null || input.compute_identity_owner_scope_key === undefined
			? {}
			: {
					computeIdentityOwnerScopeKey: responseText(
						input.compute_identity_owner_scope_key,
						"compute identity owner scope",
						160,
					),
				}),
		...(input.compute_template_key === null || input.compute_template_key === undefined
			? {}
			: { computeTemplateKey: responseText(input.compute_template_key, "compute template key", 120) }),
		...(input.compute_template_version === null || input.compute_template_version === undefined
			? {}
			: {
					computeTemplateVersion: responseText(input.compute_template_version, "compute template version", 120),
				}),
		...(input.compute_policy_sha256 === null || input.compute_policy_sha256 === undefined
			? {}
			: { computePolicySha256: responseSha256(input.compute_policy_sha256, "compute policy hash") }),
		workerClass: input.worker_class,
		requestedByUserId: responseUuid(input.requested_by_user_id, "execution requester id"),
		...(input.sponsored_by_user_id === null || input.sponsored_by_user_id === undefined
			? {}
			: { sponsoredByUserId: responseUuid(input.sponsored_by_user_id, "execution sponsor user id") }),
		sponsor: parseExecutionSponsor(input.sponsor),
		modelPolicy: parseRunnerModelPolicy(input.model_policy),
		attempt: responseInteger(input.attempt, "runner attempt"),
	};
	validateCloudRunnerWork(work);
	return work;
}

function parseOrchestrationClaim(value: unknown): CloudRunnerOrchestrationClaim {
	const input = record(value, "orchestration claim");
	if (input.status !== "claimed" && input.status !== "assigned") {
		throw new Error("Runner orchestrator returned invalid claim status");
	}
	return {
		claimId: responseUuid(input.claim_id, "orchestration claim id"),
		orchestratorId: responseUuid(input.orchestrator_id, "orchestrator id"),
		status: input.status,
		work: parseRunnerWork(input.work),
		leaseExpiresAt: responseTimestamp(input.lease_expires_at, "orchestration lease expiry"),
	};
}

type RoutineScheduleTrigger =
	| { id: string; kind: "schedule"; intervalMinutes: number; startAt?: string }
	| {
			id: string;
			kind: "schedule";
			intervalMinutes: number;
			startAt?: string;
			weekdays: readonly string[];
			localTime: string;
			timeZone: string;
	  }
	| {
			id: string;
			kind: "schedule";
			intervalMinutes: number;
			months?: readonly number[];
			weekdays?: readonly string[];
			windowStart: string;
			windowEnd: string;
			timeZone: string;
	  };

interface DueRoutineOccurrence {
	triggerId: string;
	occurrenceKey: string;
	occurrenceId: string;
	scheduledFor: string;
}

interface ScheduledRoutineWake extends DueRoutineOccurrence {
	expectedLastScheduledFor?: string;
	nextDueAt: string;
	coalesced: number;
}

const ROUTINE_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

function deterministicUuid(seed: string): string {
	const digest = createHash("sha256").update(seed).digest("hex");
	const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	return [
		digest.slice(0, 8),
		digest.slice(8, 12),
		`4${digest.slice(13, 16)}`,
		`${variant}${digest.slice(17, 20)}`,
		digest.slice(20, 32),
	].join("-");
}

function parseScheduleTrigger(value: unknown): RoutineScheduleTrigger | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		input.kind !== "schedule" ||
		(Object.hasOwn(input, "replyPolicy") &&
			input.replyPolicy !== "optional" &&
			input.replyPolicy !== "required" &&
			input.replyPolicy !== "silent") ||
		typeof input.id !== "string" ||
		input.id !== input.id.trim() ||
		input.id.length < 1 ||
		input.id.length > 160 ||
		/[\0\r\n]/.test(input.id) ||
		!Number.isSafeInteger(input.intervalMinutes) ||
		(input.intervalMinutes as number) < 5 ||
		(input.intervalMinutes as number) > 10_080
	) {
		return undefined;
	}
	const hasAdvancedWindow =
		input.months !== undefined || input.windowStart !== undefined || input.windowEnd !== undefined;
	if (hasAdvancedWindow) {
		if (
			Object.keys(input).some(
				(key) =>
					![
						"id",
						"kind",
						"intervalMinutes",
						"months",
						"weekdays",
						"windowStart",
						"windowEnd",
						"timeZone",
						"replyPolicy",
					].includes(key),
			) ||
			input.startAt !== undefined ||
			input.localTime !== undefined ||
			(input.months !== undefined &&
				(!Array.isArray(input.months) ||
					input.months.length < 1 ||
					input.months.length > 12 ||
					new Set(input.months).size !== input.months.length ||
					!input.months.every(
						(month) => Number.isSafeInteger(month) && (month as number) >= 1 && (month as number) <= 12,
					))) ||
			(input.weekdays !== undefined &&
				(!Array.isArray(input.weekdays) ||
					input.weekdays.length < 1 ||
					input.weekdays.length > 7 ||
					new Set(input.weekdays).size !== input.weekdays.length ||
					!input.weekdays.every(
						(weekday) =>
							typeof weekday === "string" && ROUTINE_WEEKDAYS.some((candidate) => candidate === weekday),
					))) ||
			typeof input.windowStart !== "string" ||
			typeof input.windowEnd !== "string" ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.windowStart) ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.windowEnd) ||
			typeof input.timeZone !== "string" ||
			input.timeZone === "auto"
		) {
			return undefined;
		}
		const start = Number(input.windowStart.slice(0, 2)) * 60 + Number(input.windowStart.slice(3));
		const end = Number(input.windowEnd.slice(0, 2)) * 60 + Number(input.windowEnd.slice(3));
		if (start > end) return undefined;
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(0);
		} catch {
			return undefined;
		}
		return {
			id: input.id,
			kind: "schedule",
			intervalMinutes: input.intervalMinutes as number,
			...(Array.isArray(input.months) ? { months: input.months as number[] } : {}),
			...(Array.isArray(input.weekdays) ? { weekdays: input.weekdays as string[] } : {}),
			windowStart: input.windowStart,
			windowEnd: input.windowEnd,
			timeZone: input.timeZone,
		};
	}
	if (input.weekdays === undefined && input.localTime === undefined && input.timeZone === undefined) {
		if (
			Object.keys(input).some((key) => !["id", "kind", "intervalMinutes", "startAt", "replyPolicy"].includes(key)) ||
			(input.startAt !== undefined &&
				(typeof input.startAt !== "string" ||
					!Number.isFinite(Date.parse(input.startAt)) ||
					new Date(input.startAt).toISOString() !== input.startAt))
		) {
			return undefined;
		}
		return {
			id: input.id,
			kind: "schedule",
			intervalMinutes: input.intervalMinutes as number,
			...(typeof input.startAt === "string" ? { startAt: new Date(input.startAt).toISOString() } : {}),
		};
	}
	if (
		Object.keys(input).some(
			(key) =>
				!["id", "kind", "intervalMinutes", "startAt", "weekdays", "localTime", "timeZone", "replyPolicy"].includes(
					key,
				),
		) ||
		(input.startAt !== undefined &&
			(typeof input.startAt !== "string" ||
				!Number.isFinite(Date.parse(input.startAt)) ||
				new Date(input.startAt).toISOString() !== input.startAt)) ||
		!Array.isArray(input.weekdays) ||
		input.weekdays.length < 1 ||
		input.weekdays.length > 7 ||
		new Set(input.weekdays).size !== input.weekdays.length ||
		!input.weekdays.every(
			(weekday) => typeof weekday === "string" && ROUTINE_WEEKDAYS.some((candidate) => candidate === weekday),
		) ||
		typeof input.localTime !== "string" ||
		!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime) ||
		typeof input.timeZone !== "string" ||
		input.timeZone === "auto"
	) {
		return undefined;
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(0);
	} catch {
		return undefined;
	}
	return {
		id: input.id,
		kind: "schedule",
		intervalMinutes: input.intervalMinutes as number,
		...(typeof input.startAt === "string" ? { startAt: new Date(input.startAt).toISOString() } : {}),
		weekdays: input.weekdays as string[],
		localTime: input.localTime,
		timeZone: input.timeZone,
	};
}

function calendarParts(
	instant: Date,
	timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
	const values = new Map(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(instant)
			.map((part) => [part.type, part.value]),
	);
	return {
		year: Number(values.get("year")),
		month: Number(values.get("month")),
		day: Number(values.get("day")),
		hour: Number(values.get("hour")),
		minute: Number(values.get("minute")),
	};
}

function zonedInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): Date | undefined {
	const target = Date.UTC(year, month - 1, day, hour, minute);
	let candidate = target;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const actual = calendarParts(new Date(candidate), timeZone);
		const delta = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
		if (delta === 0) break;
		candidate += delta;
	}
	const actual = calendarParts(new Date(candidate), timeZone);
	return actual.year === year &&
		actual.month === month &&
		actual.day === day &&
		actual.hour === hour &&
		actual.minute === minute
		? new Date(candidate)
		: undefined;
}

function advancedCalendarDateMatches(
	trigger: Extract<RoutineScheduleTrigger, { windowStart: string }>,
	year: number,
	month: number,
	day: number,
): boolean {
	if (trigger.months && !trigger.months.includes(month)) return false;
	if (!trigger.weekdays) return true;
	const weekday = ROUTINE_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
	return weekday !== undefined && trigger.weekdays.includes(weekday);
}

function advancedCalendarOccurrences(
	trigger: Extract<RoutineScheduleTrigger, { windowStart: string }>,
	year: number,
	month: number,
	day: number,
): Date[] {
	if (!advancedCalendarDateMatches(trigger, year, month, day)) return [];
	const start = Number(trigger.windowStart.slice(0, 2)) * 60 + Number(trigger.windowStart.slice(3));
	const end = Number(trigger.windowEnd.slice(0, 2)) * 60 + Number(trigger.windowEnd.slice(3));
	const occurrences: Date[] = [];
	for (let minute = start; minute <= end; minute += trigger.intervalMinutes) {
		const occurrence = zonedInstant(year, month, day, Math.floor(minute / 60), minute % 60, trigger.timeZone);
		if (occurrence) occurrences.push(occurrence);
	}
	return occurrences;
}

function nearestAdvancedRoutineOccurrence(
	trigger: Extract<RoutineScheduleTrigger, { windowStart: string }>,
	instant: Date,
	direction: "before-or-at" | "after",
): Date | undefined {
	const local = calendarParts(instant, trigger.timeZone);
	for (let distance = 0; distance <= 370; distance += 1) {
		const shifted = new Date(
			Date.UTC(local.year, local.month - 1, local.day + (direction === "before-or-at" ? -distance : distance)),
		);
		const occurrences = advancedCalendarOccurrences(
			trigger,
			shifted.getUTCFullYear(),
			shifted.getUTCMonth() + 1,
			shifted.getUTCDate(),
		);
		if (direction === "before-or-at") {
			for (let index = occurrences.length - 1; index >= 0; index -= 1) {
				const occurrence = occurrences[index];
				if (occurrence && occurrence.getTime() <= instant.getTime()) return occurrence;
			}
		} else {
			for (const occurrence of occurrences) {
				if (occurrence.getTime() > instant.getTime()) return occurrence;
			}
		}
	}
	return undefined;
}

function latestRoutineOccurrence(trigger: RoutineScheduleTrigger, now: Date): Date | undefined {
	if ("windowStart" in trigger) return nearestAdvancedRoutineOccurrence(trigger, now, "before-or-at");
	if ("localTime" in trigger) {
		const startAt = trigger.startAt ? Date.parse(trigger.startAt) : Number.NaN;
		if (Number.isFinite(startAt) && now.getTime() < startAt) return undefined;
		const localNow = calendarParts(now, trigger.timeZone);
		const [hour, minute] = trigger.localTime.split(":").map(Number);
		for (let offset = 0; offset <= 14; offset += 1) {
			const day = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day - offset));
			if (!trigger.weekdays.includes(ROUTINE_WEEKDAYS[day.getUTCDay()] ?? "")) continue;
			const candidate = zonedInstant(
				day.getUTCFullYear(),
				day.getUTCMonth() + 1,
				day.getUTCDate(),
				hour ?? 0,
				minute ?? 0,
				trigger.timeZone,
			);
			if (
				candidate &&
				candidate.getTime() <= now.getTime() &&
				(!Number.isFinite(startAt) || candidate.getTime() >= startAt)
			) {
				return candidate;
			}
		}
		return undefined;
	}
	const intervalMs = trigger.intervalMinutes * 60_000;
	const anchor = trigger.startAt ? Date.parse(trigger.startAt) : 0;
	if (now.getTime() < anchor) return undefined;
	const slot = Math.floor((now.getTime() - anchor) / intervalMs);
	return new Date(anchor + slot * intervalMs);
}

function nextRoutineOccurrence(trigger: RoutineScheduleTrigger, after: Date): Date | undefined {
	if ("windowStart" in trigger) return nearestAdvancedRoutineOccurrence(trigger, after, "after");
	if ("localTime" in trigger) {
		const startAt = trigger.startAt ? Date.parse(trigger.startAt) : Number.NaN;
		const searchAfter = Number.isFinite(startAt) && after.getTime() < startAt ? new Date(startAt - 1) : after;
		const localAfter = calendarParts(searchAfter, trigger.timeZone);
		const [hour, minute] = trigger.localTime.split(":").map(Number);
		for (let offset = 0; offset <= 14; offset += 1) {
			const day = new Date(Date.UTC(localAfter.year, localAfter.month - 1, localAfter.day + offset));
			if (!trigger.weekdays.includes(ROUTINE_WEEKDAYS[day.getUTCDay()] ?? "")) continue;
			const candidate = zonedInstant(
				day.getUTCFullYear(),
				day.getUTCMonth() + 1,
				day.getUTCDate(),
				hour ?? 0,
				minute ?? 0,
				trigger.timeZone,
			);
			if (
				candidate &&
				candidate.getTime() > after.getTime() &&
				(!Number.isFinite(startAt) || candidate.getTime() >= startAt)
			) {
				return candidate;
			}
		}
		return undefined;
	}
	const intervalMs = trigger.intervalMinutes * 60_000;
	const anchor = trigger.startAt ? Date.parse(trigger.startAt) : 0;
	const slot = Math.floor((after.getTime() - anchor) / intervalMs) + 1;
	return new Date(anchor + Math.max(0, slot) * intervalMs);
}

function routineOccurrence(
	head: CloudRoutineScheduleHead,
	trigger: RoutineScheduleTrigger,
	scheduledFor: Date,
): DueRoutineOccurrence {
	const occurrenceKey = ["routine", head.routineId, `v${head.version}`, trigger.id, scheduledFor.toISOString()].join(
		":",
	);
	return {
		triggerId: trigger.id,
		occurrenceKey,
		occurrenceId: deterministicUuid(`qorpera.routine-occurrence/v1:${occurrenceKey}`),
		scheduledFor: scheduledFor.toISOString(),
	};
}

function dueRoutineWakes(
	head: CloudRoutineScheduleHead,
	trigger: RoutineScheduleTrigger,
	now: Date,
	catchUpLimit: number,
): readonly ScheduledRoutineWake[] {
	const cursor = head.scheduleCursors.find((candidate) => candidate.triggerId === trigger.id);
	if (!cursor) throw new Error(`Routine schedule cursor is missing for ${trigger.id}`);
	if (!cursor.lastScheduledFor) {
		const scheduledFor = latestRoutineOccurrence(trigger, now);
		if (!scheduledFor || scheduledFor.getTime() < Date.parse(head.effectiveAt)) return [];
		const nextDueAt = nextRoutineOccurrence(trigger, scheduledFor);
		if (!nextDueAt) throw new Error(`Routine schedule has no future occurrence for ${trigger.id}`);
		return [{ ...routineOccurrence(head, trigger, scheduledFor), nextDueAt: nextDueAt.toISOString(), coalesced: 0 }];
	}
	const lastScheduledFor = new Date(cursor.lastScheduledFor);
	let candidate = nextRoutineOccurrence(trigger, lastScheduledFor);
	const due: Date[] = [];
	let dueCount = 0;
	let latest: Date | undefined;
	while (candidate && candidate.getTime() <= now.getTime()) {
		dueCount += 1;
		latest = candidate;
		if (dueCount <= catchUpLimit) due.push(candidate);
		candidate = nextRoutineOccurrence(trigger, candidate);
	}
	if (!latest || !candidate) return [];
	if (dueCount > catchUpLimit) {
		return [
			{
				...routineOccurrence(head, trigger, latest),
				expectedLastScheduledFor: cursor.lastScheduledFor,
				nextDueAt: candidate.toISOString(),
				coalesced: dueCount - 1,
			},
		];
	}
	return due.map((scheduledFor, index) => {
		const nextDueAt = nextRoutineOccurrence(trigger, scheduledFor);
		if (!nextDueAt) throw new Error(`Routine schedule has no future occurrence for ${trigger.id}`);
		return {
			...routineOccurrence(head, trigger, scheduledFor),
			expectedLastScheduledFor: (due[index - 1] ?? lastScheduledFor).toISOString(),
			nextDueAt: nextDueAt.toISOString(),
			coalesced: 0,
		};
	});
}

class RoutineWakeAdmissionErrors extends AggregateError {
	readonly failures: readonly unknown[];

	constructor(failures: readonly unknown[]) {
		super(failures, "Routine wake admissions failed");
		this.name = "RoutineWakeAdmissionErrors";
		this.failures = Object.freeze([...failures]);
	}
}

/** Reconciles due deterministic occurrences from durable per-trigger cursors. */
export class CloudRoutineScheduleReconciler implements CloudRunnerOccurrenceReconciler {
	readonly #now: () => Date;
	readonly #pageSize: number;
	readonly #catchUpLimit: number;

	constructor(options: CloudRoutineScheduleReconcilerOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = options.pageSize ?? 250;
		this.#catchUpLimit = options.catchUpLimit ?? 32;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
			throw new Error("Routine schedule page size is outside the supported range");
		}
		if (!Number.isSafeInteger(this.#catchUpLimit) || this.#catchUpLimit < 1 || this.#catchUpLimit > 256) {
			throw new Error("Routine schedule catch-up limit is outside the supported range");
		}
	}

	async reconcile(controlPlane: CloudRunnerOrchestratorControlPlane, signal?: AbortSignal): Promise<void> {
		const failures: unknown[] = [];
		let afterRoutineId: string | undefined;
		do {
			const page = signal
				? await controlPlane.listRoutineScheduleHeads(afterRoutineId, this.#pageSize, signal)
				: await controlPlane.listRoutineScheduleHeads(afterRoutineId, this.#pageSize);
			for (const head of page.items) {
				if (!Array.isArray(head.triggers)) continue;
				for (const value of head.triggers) {
					const trigger = parseScheduleTrigger(value);
					if (!trigger) continue;
					for (const occurrence of dueRoutineWakes(head, trigger, this.#now(), this.#catchUpLimit)) {
						const input: EnqueueCloudRoutineWakeInput = {
							routineId: head.routineId,
							expectedVersion: head.version,
							...occurrence,
							payload: {
								schema: "qorpera.routine-schedule-occurrence/v1",
								coalesced: occurrence.coalesced,
							},
						};
						try {
							if (signal) await controlPlane.enqueueRoutineWake(input, signal);
							else await controlPlane.enqueueRoutineWake(input);
						} catch (error) {
							if (signal?.aborted) throw error;
							failures.push(error);
							// Later slots depend on this trigger's successful cursor advance.
							// Other triggers and heads have independent durable cursors.
							break;
						}
					}
				}
			}
			afterRoutineId = page.hasMore ? page.nextAfterRoutineId : undefined;
			if (page.hasMore && !afterRoutineId) throw new Error("Routine schedule pagination lost its cursor");
		} while (afterRoutineId);
		if (failures.length > 0) throw new RoutineWakeAdmissionErrors(failures);
	}
}

function waitForPoll(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolveWait) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolveWait();
		}, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			resolveWait();
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function parseRunnerAssignment(value: unknown): CloudRunnerAssignment {
	const input = record(value, "runner assignment");
	if (typeof input.capability_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.capability_sha256)) {
		throw new Error("Runner orchestrator returned invalid assignment capability hash");
	}
	return {
		assignmentId: responseUuid(input.assignment_id, "assignment id"),
		claimId: responseUuid(input.claim_id, "assignment claim id"),
		runId: responseUuid(input.run_id, "assignment run id"),
		jobId: responseUuid(input.job_id, "assignment job id"),
		runnerId: responseUuid(input.runner_id, "assignment runner id"),
		capabilitySha256: input.capability_sha256,
		expiresAt: responseTimestamp(input.expires_at, "assignment expiry"),
	};
}

export class CloudRunnerOrchestratorRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Runner orchestrator request failed (${status})`);
		this.name = "CloudRunnerOrchestratorRequestError";
		this.status = status;
	}
}

export function cloudRunnerAssignmentCapabilitySha256(capability: string): string {
	if (!TOKEN_PATTERN.test(capability)) throw new Error("Runner assignment capability is invalid");
	return createHash("sha256").update(capability).digest("hex");
}

export function validateCloudRunnerWork(work: CloudRunnerWork): void {
	for (const [label, value] of [
		["Run id", work.runId],
		["Job id", work.jobId],
		["Profile id", work.profileId],
		["Environment id", work.environmentId],
		["Source id", work.sourceId],
		["Substrate version id", work.substrateVersionId],
		["Company snapshot id", work.companySnapshotId],
		["Staff agent id", work.staffAgentId],
		["Sponsor binding id", work.sponsor.bindingId],
		["Provider connection id", work.sponsor.providerConnectionId],
	] as const) {
		requiredUuid(value, label);
	}
	if (work.sessionId !== undefined) requiredUuid(work.sessionId, "Session id");
	if (work.logicalComputerId !== undefined) requiredUuid(work.logicalComputerId, "Logical computer id");
	if (work.computeIdentityId !== undefined) requiredUuid(work.computeIdentityId, "Compute identity id");
	if (work.computeIdentityOwnerUserId !== undefined) {
		requiredUuid(work.computeIdentityOwnerUserId, "Compute identity owner user id");
	}
	requiredUuid(work.requestedByUserId, "Execution requester id");
	if (work.sponsoredByUserId !== undefined) requiredUuid(work.sponsoredByUserId, "Execution sponsor user id");
	for (const inputId of work.inputIds) requiredUuid(inputId, "Input id");
	for (const reviewerStaffId of work.reviewerStaffIds) requiredUuid(reviewerStaffId, "Reviewer staff id");
	if (
		work.inputIds.length > 32 ||
		new Set(work.inputIds).size !== work.inputIds.length ||
		work.reviewerStaffIds.length > 20 ||
		new Set(work.reviewerStaffIds).size !== work.reviewerStaffIds.length
	) {
		throw new Error("Execution input or reviewer set is invalid");
	}
	if (work.sourceKind === "session_turn" && work.sessionId === undefined) {
		throw new Error("Session turn has no durable company session");
	}
	if ((work.sourceKind === "session_turn") !== work.inputIds.length > 0) {
		throw new Error("Execution input set does not match its source");
	}
	if (work.sessionId === undefined && work.transcriptStartSequence !== 0) {
		throw new Error("Sessionless work has a transcript cursor");
	}
	if (!Number.isSafeInteger(work.transcriptStartSequence) || work.transcriptStartSequence < 0) {
		throw new Error("Transcript start sequence is invalid");
	}
	if (!Number.isSafeInteger(work.staffVersion) || work.staffVersion < 1) {
		throw new Error("Staff version is invalid");
	}
	if (!Number.isSafeInteger(work.sponsor.version) || work.sponsor.version < 1) {
		throw new Error("Sponsor version is invalid");
	}
	if (!Number.isSafeInteger(work.sponsor.providerConnectionVersion) || work.sponsor.providerConnectionVersion < 1) {
		throw new Error("Provider connection version is invalid");
	}
	if (!Number.isSafeInteger(work.attempt) || work.attempt < 1 || work.attempt > 1000) {
		throw new Error("Runner attempt is invalid");
	}
	if (!PROVIDER_ID_PATTERN.test(work.sponsor.provider)) throw new Error("Sponsor provider is invalid");
	if (work.modelPolicy.provider !== work.sponsor.provider) {
		throw new Error("Runner model authority does not match its sponsor");
	}
	if (work.workerClass === "company_computer" && work.logicalComputerId === undefined) {
		throw new Error("Company-computer work has no logical computer");
	}
	if (work.computeIdentityId === undefined) {
		if (
			work.computeIdentityOwnershipKind !== undefined ||
			work.computeIdentityOwnerUserId !== undefined ||
			work.computeIdentityOwnerScopeKey !== undefined ||
			work.computeTemplateKey !== undefined ||
			work.computeTemplateVersion !== undefined ||
			work.computePolicySha256 !== undefined
		) {
			throw new Error("Compute identity ownership has no compute identity");
		}
	} else if (
		!work.computeTemplateKey ||
		!/^[a-z][a-z0-9._-]{0,119}$/.test(work.computeTemplateKey) ||
		!work.computeTemplateVersion ||
		work.computeTemplateVersion !== work.computeTemplateVersion.trim() ||
		work.computeTemplateVersion.length > 120 ||
		!work.computePolicySha256 ||
		!/^[0-9a-f]{64}$/.test(work.computePolicySha256)
	) {
		throw new Error("Compute identity has no immutable template authority");
	} else if (work.computeIdentityOwnershipKind === "member") {
		if (
			work.computeIdentityOwnerUserId === undefined ||
			work.computeIdentityOwnerScopeKey !== undefined ||
			work.sponsor.kind !== "member_connection" ||
			work.sponsoredByUserId !== work.computeIdentityOwnerUserId
		) {
			throw new Error("Member compute authority has inconsistent ownership or sponsorship");
		}
	} else if (work.computeIdentityOwnershipKind === "company") {
		if (
			work.computeIdentityOwnerUserId !== undefined ||
			work.computeIdentityOwnerScopeKey !== undefined ||
			work.sponsor.kind === "member_connection"
		) {
			throw new Error("Company compute authority has inconsistent ownership or sponsorship");
		}
	} else if (
		work.computeIdentityOwnershipKind === "department" ||
		work.computeIdentityOwnershipKind === "security_boundary"
	) {
		if (
			work.computeIdentityOwnerUserId !== undefined ||
			work.computeIdentityOwnerScopeKey === undefined ||
			work.sponsor.kind === "member_connection"
		) {
			throw new Error("Scoped compute authority has inconsistent ownership or sponsorship");
		}
	} else {
		throw new Error("Compute identity has no ownership provenance");
	}
	if (work.sponsor.authenticationMode === "native_subscription" && work.computeIdentityId === undefined) {
		throw new Error("Native subscription work has no compute authority");
	}
	if (
		!work.sponsor.nativeHarness.trim() ||
		work.sponsor.nativeHarness.length > 120 ||
		/[\0\r\n]/.test(work.sponsor.nativeHarness)
	) {
		throw new Error("Sponsor native harness is invalid");
	}
	if (
		work.sourceKind !== "session_turn" &&
		work.sourceKind !== "wake" &&
		work.sourceKind !== "manual" &&
		work.sourceKind !== "room_delivery" &&
		work.sourceKind !== "proposal_review" &&
		work.sourceKind !== "system"
	) {
		throw new Error("Execution source kind is invalid");
	}
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(work.jobType)) throw new Error("Runner job type is invalid");
	if (
		(work.publicationMode !== "automatic" && work.publicationMode !== "review") ||
		(work.publicationMode === "automatic" &&
			(work.reviewPolicyKey !== undefined || work.reviewerStaffIds.length > 0)) ||
		(work.publicationMode === "review" &&
			(!work.reviewPolicyKey ||
				work.reviewPolicyKey !== work.reviewPolicyKey.trim() ||
				/[\0\r\n]/.test(work.reviewPolicyKey) ||
				work.reviewerStaffIds.length === 0 ||
				work.reviewPolicyKey.length > 128))
	) {
		throw new Error("Execution publication policy is invalid");
	}
	const encoded = JSON.stringify(work.payload);
	if (
		!work.payload ||
		typeof work.payload !== "object" ||
		Array.isArray(work.payload) ||
		encoded === undefined ||
		Buffer.byteLength(encoded) > 64 * 1024
	) {
		throw new Error("Runner job payload is invalid");
	}
	// A room delivery is caused by a member post, like a session turn; only autonomous kinds need consent.
	if (work.sourceKind !== "session_turn" && work.sourceKind !== "room_delivery" && !work.sponsor.allowAutonomous) {
		throw new Error("Execution sponsor does not permit autonomous work");
	}
}

export class CloudRunnerOrchestrator {
	readonly #orchestratorId: string;
	readonly #controlPlane: CloudRunnerOrchestratorControlPlane;
	readonly #providerAdapter: CloudRunnerProviderAdapter;
	readonly #occurrenceReconcilers: readonly CloudRunnerOccurrenceReconciler[];
	readonly #claimLeaseSeconds: number;
	readonly #claimRenewalIntervalMs: number;
	readonly #assignmentSeconds: number;
	readonly #dispatchConcurrency: number;
	readonly #clientClaimId: () => string;
	readonly #clientAssignmentId: () => string;
	readonly #createCapability: () => string;

	constructor(options: CloudRunnerOrchestratorOptions) {
		requiredUuid(options.orchestratorId, "Orchestrator id");
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.providerAdapter.adapterId)) {
			throw new Error("Runner provider adapter id is invalid");
		}
		this.#orchestratorId = options.orchestratorId;
		this.#controlPlane = options.controlPlane;
		this.#providerAdapter = options.providerAdapter;
		this.#occurrenceReconcilers = [new CloudRoutineScheduleReconciler(), ...(options.occurrenceReconcilers ?? [])];
		this.#claimLeaseSeconds = requiredSeconds(options.claimLeaseSeconds ?? 120, "Orchestration lease", 900);
		this.#claimRenewalIntervalMs =
			options.claimRenewalIntervalMs ?? Math.max(10_000, Math.floor((this.#claimLeaseSeconds * 1000) / 3));
		if (
			!Number.isSafeInteger(this.#claimRenewalIntervalMs) ||
			this.#claimRenewalIntervalMs < 10 ||
			this.#claimRenewalIntervalMs >= this.#claimLeaseSeconds * 1000
		) {
			throw new Error("Orchestration claim renewal interval is outside the supported range");
		}
		this.#assignmentSeconds = requiredSeconds(options.assignmentSeconds ?? 120, "Assignment lifetime", 900);
		this.#dispatchConcurrency = options.dispatchConcurrency ?? 1;
		if (
			!Number.isSafeInteger(this.#dispatchConcurrency) ||
			this.#dispatchConcurrency < 1 ||
			this.#dispatchConcurrency > 64
		) {
			throw new Error("Orchestrator dispatch concurrency is outside the supported range");
		}
		this.#clientClaimId = options.clientClaimId ?? randomUUID;
		this.#clientAssignmentId = options.clientAssignmentId ?? randomUUID;
		this.#createCapability = options.createCapability ?? (() => randomBytes(32).toString("base64url"));
	}

	async #reconcileControlPlane(signal?: AbortSignal): Promise<readonly unknown[]> {
		const reconciliationErrors: unknown[] = [];
		if (this.#controlPlane.renewControl) {
			if (signal) await this.#controlPlane.renewControl(signal);
			else await this.#controlPlane.renewControl();
		}
		for (const reconciler of this.#occurrenceReconcilers) {
			try {
				if (signal) await reconciler.reconcile(this.#controlPlane, signal);
				else await reconciler.reconcile(this.#controlPlane);
			} catch (error) {
				if (!(error instanceof RoutineWakeAdmissionErrors)) throw error;
				reconciliationErrors.push(...error.failures);
			}
		}
		if (signal) {
			await this.#controlPlane.reconcileExpired(this.#orchestratorId, signal);
			await this.#providerAdapter.reconcile(signal);
		} else {
			await this.#controlPlane.reconcileExpired(this.#orchestratorId);
			await this.#providerAdapter.reconcile();
		}
		return reconciliationErrors;
	}

	async #claimBatch(
		limit: number,
		signal?: AbortSignal,
		excludedClaimIds: ReadonlySet<string> = new Set(),
	): Promise<readonly CloudRunnerOrchestrationClaim[]> {
		const retained = signal
			? await this.#controlPlane.retainedClaims(this.#orchestratorId, signal)
			: await this.#controlPlane.retainedClaims(this.#orchestratorId);
		const claims = retained.filter((claim) => !excludedClaimIds.has(claim.claimId)).slice(0, limit);
		while (claims.length < limit) {
			const clientClaimId = this.#clientClaimId();
			const claim = signal
				? await this.#controlPlane.claimNext(this.#orchestratorId, clientClaimId, this.#claimLeaseSeconds, signal)
				: await this.#controlPlane.claimNext(this.#orchestratorId, clientClaimId, this.#claimLeaseSeconds);
			if (!claim) break;
			claims.push(claim);
		}
		return claims;
	}

	async #dispatchClaim(
		initialClaim: CloudRunnerOrchestrationClaim,
		signal?: AbortSignal,
	): Promise<CloudRunnerOrchestratorResult> {
		let claim = initialClaim;
		if (claim.orchestratorId !== this.#orchestratorId) {
			throw new Error("Control plane returned another orchestrator's claim");
		}
		validateCloudRunnerWork(claim.work);
		if (claim.status === "assigned") return { status: "awaiting_assignment", claim };
		const clientAssignmentId = this.#clientAssignmentId();
		requiredUuid(clientAssignmentId, "Client assignment id");
		const acquisitionController = new AbortController();
		let rejectRenewal: (error: unknown) => void = () => undefined;
		const renewalFailure = new Promise<never>((_resolve, reject) => {
			rejectRenewal = reject;
		});
		const renewalLoop = (async (): Promise<void> => {
			while (!acquisitionController.signal.aborted) {
				await waitForPoll(this.#claimRenewalIntervalMs, acquisitionController.signal);
				if (acquisitionController.signal.aborted) return;
				/* A guest boot can briefly saturate the host and stall one
				 * renewal round trip; the lease outlives the renewal interval
				 * by design, so retry inside the current lease window before
				 * abandoning an otherwise healthy acquisition. */
				for (let renewAttempt = 1; ; renewAttempt++) {
					try {
						claim = signal
							? await this.#controlPlane.renewClaim(claim, this.#claimLeaseSeconds, signal)
							: await this.#controlPlane.renewClaim(claim, this.#claimLeaseSeconds);
						break;
					} catch (error) {
						if (renewAttempt >= 3 || acquisitionController.signal.aborted) {
							acquisitionController.abort();
							rejectRenewal(error);
							return;
						}
						await waitForPoll(5_000, acquisitionController.signal);
						if (acquisitionController.signal.aborted) return;
					}
				}
			}
		})();
		const acquisitionSignal = signal
			? AbortSignal.any([acquisitionController.signal, signal])
			: acquisitionController.signal;
		const acquisition = this.#providerAdapter.acquire(claim.work, acquisitionSignal);
		let runner: CloudRunnerInstance;
		try {
			runner = await Promise.race([acquisition, renewalFailure]);
			acquisitionController.abort();
			await renewalLoop;
		} catch (error) {
			acquisitionController.abort();
			await renewalLoop;
			void acquisition
				.then((lateRunner) => this.#providerAdapter.stop(lateRunner, "delivery_failed"))
				.catch(() => undefined);
			await this.#controlPlane
				.releaseClaim(claim, clientAssignmentId, deliveryFailure(error))
				.catch(() => undefined);
			throw error;
		}
		if (
			!runner.capabilities.includes(claim.work.requiredCapability) ||
			runner.providerAdapter !== this.#providerAdapter.adapterId ||
			runner.workerClass !== claim.work.workerClass ||
			(claim.work.computeIdentityId !== undefined && runner.computeIdentityId !== claim.work.computeIdentityId) ||
			(claim.work.logicalComputerId !== undefined && runner.logicalComputerId !== claim.work.logicalComputerId) ||
			(claim.work.computeTemplateKey !== undefined && runner.templateKey !== claim.work.computeTemplateKey) ||
			(claim.work.computeTemplateVersion !== undefined &&
				runner.templateVersion !== claim.work.computeTemplateVersion) ||
			(claim.work.computePolicySha256 !== undefined && runner.policySha256 !== claim.work.computePolicySha256)
		) {
			await this.#providerAdapter.stop(runner, "delivery_failed");
			await this.#controlPlane.releaseClaim(
				claim,
				clientAssignmentId,
				"Runner provider returned an incompatible computer",
			);
			throw new Error("Runner provider returned an incompatible computer");
		}
		const capability = this.#createCapability();
		let assignment: CloudRunnerAssignment;
		try {
			const capabilitySha256 = cloudRunnerAssignmentCapabilitySha256(capability);
			/* The guest activates its runner session concurrently with
			 * acquisition, so an assign issued immediately after acquire can
			 * race the activation and fail its prerequisite check (423). The
			 * worker is healthy and freshly booted; retry inside the claim
			 * window instead of destroying it. */
			for (let assignAttempt = 1; ; assignAttempt++) {
				try {
					assignment = signal
						? await this.#controlPlane.assign(
								claim,
								runner,
								clientAssignmentId,
								capabilitySha256,
								this.#assignmentSeconds,
								signal,
							)
						: await this.#controlPlane.assign(
								claim,
								runner,
								clientAssignmentId,
								capabilitySha256,
								this.#assignmentSeconds,
							);
					break;
				} catch (error) {
					if (
						!(error instanceof CloudRunnerOrchestratorRequestError) ||
						error.status !== 423 ||
						assignAttempt >= 10 ||
						signal?.aborted
					) {
						throw error;
					}
					await waitForPoll(3_000, signal ?? new AbortController().signal);
				}
			}
		} catch (error) {
			/* A rejection that carries a status is definitive: the control
			 * plane refused the assignment and the worker is provably idle,
			 * so reclaim it. A timeout or transport fault leaves the outcome
			 * unknown — the assignment may be recorded server-side — so the
			 * worker must stay up: an unclaimed assignment expires and
			 * reconciliation requeues the job, and the provider replays the
			 * still-live acquisition on the next dispatch. */
			if (definitiveRejectionStatus(error) !== undefined) {
				await this.#providerAdapter.stop(runner, "delivery_failed");
				await this.#controlPlane
					.releaseClaim(claim, clientAssignmentId, safeDeliveryFailure(error))
					.catch(() => undefined);
			}
			throw error;
		}
		if (
			assignment.claimId !== claim.claimId ||
			assignment.runId !== claim.work.runId ||
			assignment.jobId !== claim.work.jobId ||
			assignment.runnerId !== runner.runnerId ||
			assignment.capabilitySha256 !== cloudRunnerAssignmentCapabilitySha256(capability)
		) {
			await this.#providerAdapter.stop(runner, "delivery_failed");
			await this.#controlPlane.releaseClaim(
				claim,
				clientAssignmentId,
				"Control plane returned an inconsistent runner assignment",
			);
			throw new Error("Control plane returned an inconsistent runner assignment");
		}
		try {
			const delivery = { assignment, capability, work: claim.work };
			if (signal) await this.#providerAdapter.deliver(runner, delivery, signal);
			else await this.#providerAdapter.deliver(runner, delivery);
		} catch (error) {
			/* A definitive provider rejection proves the guest never received
			 * the assignment capability, so the worker is idle and safe to
			 * reclaim. A timeout or transport fault proves nothing: the guest
			 * can already be executing under the recorded assignment while
			 * only the acknowledgment leg was lost — destroying the worker
			 * then kills a live attempt (observed as lease expiries with zero
			 * renewals). On unknown outcomes leave the worker running; an
			 * undelivered assignment expires server-side and reconciliation
			 * requeues the job, while a delivered one simply keeps going. */
			const failure = safeDeliveryFailure(error);
			if (definitiveRejectionStatus(error) !== undefined) {
				await this.#controlPlane.releaseClaim(claim, clientAssignmentId, failure);
				await this.#providerAdapter.stop(runner, "delivery_failed");
			}
			throw new Error(failure, { cause: error });
		}
		return { status: "assigned", claim, runner, assignment };
	}

	async runOnce(signal?: AbortSignal): Promise<CloudRunnerOrchestratorResult> {
		const reconciliationErrors = await this.#reconcileControlPlane(signal);
		const [claim] = await this.#claimBatch(1, signal);
		const result: CloudRunnerOrchestratorResult = claim
			? await this.#dispatchClaim(claim, signal)
			: { status: "idle" };
		return reconciliationErrors.length > 0 ? { ...result, reconciliationErrors } : result;
	}

	async run(signal: AbortSignal, options: CloudRunnerOrchestratorLoopOptions = {}): Promise<void> {
		const pollIntervalMs = options.pollIntervalMs ?? 250;
		if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
			throw new Error("Orchestrator poll interval is outside the supported range");
		}
		const shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
		if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 10 || shutdownGraceMs > 60_000) {
			throw new Error("Orchestrator shutdown grace is outside the supported range");
		}
		const inFlight = new Set<Promise<void>>();
		const inFlightClaimIds = new Set<string>();
		while (!signal.aborted) {
			try {
				const reconciliationErrors = await this.#reconcileControlPlane(signal);
				for (const error of reconciliationErrors) options.onError?.(error);
				const available = this.#dispatchConcurrency - inFlight.size;
				if (available > 0) {
					const claims = await this.#claimBatch(available, signal, inFlightClaimIds);
					for (const claim of claims) {
						if (inFlightClaimIds.has(claim.claimId)) continue;
						inFlightClaimIds.add(claim.claimId);
						let dispatch: Promise<void>;
						dispatch = this.#dispatchClaim(claim, signal)
							.then(() => undefined)
							.catch((error: unknown) => options.onError?.(error))
							.finally(() => {
								inFlight.delete(dispatch);
								inFlightClaimIds.delete(claim.claimId);
							});
						inFlight.add(dispatch);
					}
				}
			} catch (error) {
				options.onError?.(error);
			}
			if (!signal.aborted) await waitForPoll(pollIntervalMs, signal);
		}
		if (inFlight.size > 0) {
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				Promise.allSettled([...inFlight]),
				new Promise<void>((resolveWait) => {
					timer = setTimeout(resolveWait, shutdownGraceMs);
				}),
			]);
			if (timer) clearTimeout(timer);
		}
	}
}

export class SupabaseCloudRunnerOrchestratorControlPlane implements CloudRunnerOrchestratorControlPlane {
	readonly #orchestratorId: string;
	readonly #url: string;
	readonly #publishableKey: string;
	#controlToken: string;
	#pendingControlToken?: string;
	readonly #persistControlTokens?: (state: { current: string; pending?: string }) => Promise<void>;
	readonly #controlTokenSeconds: number;
	readonly #now: () => number;
	#nextControlRotationAt = 0;
	readonly #fetch: ServiceHttpFetch;

	constructor(
		baseUrl: string,
		publishableKey: string,
		orchestratorId: string,
		controlToken: string,
		fetchImplementation: ServiceHttpFetch = fetch,
		options: {
			pendingControlToken?: string;
			persistControlTokens?: (state: { current: string; pending?: string }) => Promise<void>;
			controlTokenSeconds?: number;
			now?: () => number;
		} = {},
	) {
		const url = new URL("/functions/v1/runner-orchestrator", baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Runner orchestrator URL must use HTTPS");
		}
		if (!publishableKey.trim()) throw new Error("Runner orchestrator publishable key is required");
		requiredUuid(orchestratorId, "Orchestrator id");
		if (!TOKEN_PATTERN.test(controlToken)) throw new Error("Runner orchestrator control token is invalid");
		if (options.pendingControlToken !== undefined && !TOKEN_PATTERN.test(options.pendingControlToken)) {
			throw new Error("Runner orchestrator pending control token is invalid");
		}
		const controlTokenSeconds = options.controlTokenSeconds ?? 604_800;
		if (!Number.isSafeInteger(controlTokenSeconds) || controlTokenSeconds < 300 || controlTokenSeconds > 604_800) {
			throw new Error("Runner orchestrator control lifetime is outside the supported range");
		}
		this.#orchestratorId = orchestratorId;
		this.#url = url.href;
		this.#publishableKey = publishableKey;
		this.#controlToken = controlToken;
		this.#pendingControlToken = options.pendingControlToken;
		this.#persistControlTokens = options.persistControlTokens;
		this.#controlTokenSeconds = controlTokenSeconds;
		this.#now = options.now ?? Date.now;
		this.#fetch = fetchImplementation;
	}

	async renewControl(signal?: AbortSignal): Promise<void> {
		const now = this.#now();
		if (now < this.#nextControlRotationAt) return;
		const previous = this.#controlToken;
		const next = this.#pendingControlToken ?? randomBytes(32).toString("base64url");
		if (!this.#pendingControlToken) {
			this.#pendingControlToken = next;
			await this.#persistControlTokens?.({ current: previous, pending: next });
		}
		const request: CloudRunnerOrchestratorRequest = {
			action: "rotate_control",
			orchestratorId: this.#orchestratorId,
			nextControlTokenSha256: cloudRunnerAssignmentCapabilitySha256(next),
			controlTokenSeconds: this.#controlTokenSeconds,
		};
		try {
			await this.#request(request, signal, previous);
		} catch (firstError) {
			try {
				await this.#request(request, signal, next);
			} catch (replayError) {
				throw new AggregateError([firstError, replayError], "Runner orchestrator control rotation failed");
			}
		}
		this.#controlToken = next;
		this.#pendingControlToken = undefined;
		await this.#persistControlTokens?.({ current: next });
		this.#nextControlRotationAt = now + Math.floor((this.#controlTokenSeconds * 1000) / 2);
	}

	async listRoutineScheduleHeads(
		afterRoutineId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudRoutineSchedulePage> {
		if (afterRoutineId !== undefined) requiredUuid(afterRoutineId, "Routine schedule cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Routine schedule page limit is outside the supported range");
		}
		return parseRoutineSchedulePage(
			await this.#request(
				{
					action: "routine_heads",
					orchestratorId: this.#orchestratorId,
					...(afterRoutineId ? { afterRoutineId } : {}),
					limit,
				},
				signal,
			),
		);
	}

	async enqueueRoutineWake(
		input: EnqueueCloudRoutineWakeInput,
		signal?: AbortSignal,
	): Promise<CloudRoutineWakeOccurrence> {
		requiredUuid(input.routineId, "Routine id");
		requiredUuid(input.occurrenceId, "Wake occurrence id");
		if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
			throw new Error("Routine version is invalid");
		}
		if (
			input.occurrenceKey !== input.occurrenceKey.trim() ||
			Buffer.byteLength(input.occurrenceKey, "utf-8") < 1 ||
			Buffer.byteLength(input.occurrenceKey, "utf-8") > 256 ||
			/[\0\r\n]/.test(input.occurrenceKey) ||
			input.triggerId !== input.triggerId.trim() ||
			Buffer.byteLength(input.triggerId, "utf-8") < 1 ||
			Buffer.byteLength(input.triggerId, "utf-8") > 160 ||
			/[\0\r\n]/.test(input.triggerId) ||
			!Number.isFinite(Date.parse(input.scheduledFor)) ||
			(input.expectedLastScheduledFor !== undefined &&
				!Number.isFinite(Date.parse(input.expectedLastScheduledFor))) ||
			!Number.isFinite(Date.parse(input.nextDueAt)) ||
			Date.parse(input.nextDueAt) <= Date.parse(input.scheduledFor) ||
			!input.payload ||
			typeof input.payload !== "object" ||
			Array.isArray(input.payload) ||
			Buffer.byteLength(JSON.stringify(input.payload), "utf-8") > 8 * 1024
		) {
			throw new Error("Wake occurrence is invalid");
		}
		return parseRoutineWakeOccurrence(
			await this.#request(
				{
					action: "enqueue_wake",
					orchestratorId: this.#orchestratorId,
					routineId: input.routineId,
					expectedVersion: input.expectedVersion,
					occurrenceId: input.occurrenceId,
					occurrenceKey: input.occurrenceKey,
					triggerId: input.triggerId,
					scheduledFor: new Date(input.scheduledFor).toISOString(),
					...(input.expectedLastScheduledFor
						? { expectedLastScheduledFor: new Date(input.expectedLastScheduledFor).toISOString() }
						: {}),
					nextDueAt: new Date(input.nextDueAt).toISOString(),
					payload: structuredClone(input.payload),
				},
				signal,
			),
		);
	}

	async reconcileExpired(orchestratorId: string, signal?: AbortSignal): Promise<void> {
		this.#assertIdentity(orchestratorId);
		await this.#request({ action: "reconcile", orchestratorId }, signal);
	}

	async retainedClaims(
		orchestratorId: string,
		signal?: AbortSignal,
	): Promise<readonly CloudRunnerOrchestrationClaim[]> {
		this.#assertIdentity(orchestratorId);
		const value = await this.#request({ action: "retained", orchestratorId }, signal);
		if (!Array.isArray(value)) throw new Error("Runner orchestrator returned invalid retained claims");
		return value.map(parseOrchestrationClaim);
	}

	async claimNext(
		orchestratorId: string,
		clientClaimId: string,
		leaseSeconds: number,
		signal?: AbortSignal,
	): Promise<CloudRunnerOrchestrationClaim | undefined> {
		this.#assertIdentity(orchestratorId);
		requiredUuid(clientClaimId, "Client claim id");
		requiredSeconds(leaseSeconds, "Orchestration lease", 900);
		const value = await this.#request({ action: "claim", orchestratorId, clientClaimId, leaseSeconds }, signal);
		return value === null ? undefined : parseOrchestrationClaim(value);
	}

	async assign(
		claim: CloudRunnerOrchestrationClaim,
		runner: CloudRunnerInstance,
		clientAssignmentId: string,
		capabilitySha256: string,
		assignmentSeconds: number,
		signal?: AbortSignal,
	): Promise<CloudRunnerAssignment> {
		this.#assertIdentity(claim.orchestratorId);
		requiredUuid(clientAssignmentId, "Client assignment id");
		requiredUuid(runner.runnerId, "Runner id");
		if (!/^[0-9a-f]{64}$/.test(capabilitySha256)) throw new Error("Assignment capability hash is invalid");
		requiredSeconds(assignmentSeconds, "Assignment lifetime", 900);
		return parseRunnerAssignment(
			await this.#request(
				{
					action: "assign",
					orchestratorId: this.#orchestratorId,
					claimId: claim.claimId,
					runnerId: runner.runnerId,
					clientAssignmentId,
					capabilitySha256,
					assignmentSeconds,
				},
				signal,
			),
		);
	}

	async renewClaim(
		claim: CloudRunnerOrchestrationClaim,
		leaseSeconds: number,
		signal?: AbortSignal,
	): Promise<CloudRunnerOrchestrationClaim> {
		this.#assertIdentity(claim.orchestratorId);
		requiredSeconds(leaseSeconds, "Orchestration lease", 900);
		return parseOrchestrationClaim(
			await this.#request(
				{
					action: "renew_claim",
					orchestratorId: this.#orchestratorId,
					claimId: claim.claimId,
					leaseSeconds,
				},
				signal,
			),
		);
	}

	async releaseClaim(
		claim: CloudRunnerOrchestrationClaim,
		clientAssignmentId: string,
		error: string,
		signal?: AbortSignal,
	): Promise<void> {
		this.#assertIdentity(claim.orchestratorId);
		requiredUuid(clientAssignmentId, "Client assignment id");
		const failure = safeDeliveryFailure(error);
		await this.#request(
			{
				action: "release_claim",
				orchestratorId: this.#orchestratorId,
				claimId: claim.claimId,
				clientAssignmentId,
				error: failure,
			},
			signal,
		);
	}

	#assertIdentity(orchestratorId: string): void {
		if (orchestratorId !== this.#orchestratorId) throw new Error("Runner orchestrator identity changed");
	}

	async #request(
		body: CloudRunnerOrchestratorRequest,
		signal?: AbortSignal,
		controlToken = this.#controlToken,
	): Promise<unknown> {
		const requestSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(CONTROL_PLANE_REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(CONTROL_PLANE_REQUEST_TIMEOUT_MS);
		const response = await this.#fetch(this.#url, {
			method: "POST",
			headers: {
				apikey: this.#publishableKey,
				authorization: `Bearer ${controlToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: requestSignal,
		});
		if (!response.ok) throw new CloudRunnerOrchestratorRequestError(response.status);
		const encoded = await response.text();
		if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) {
			throw new Error("Runner orchestrator response exceeds its byte limit");
		}
		let value: unknown;
		try {
			value = JSON.parse(encoded) as unknown;
		} catch (error) {
			throw new Error("Runner orchestrator returned invalid JSON", { cause: error });
		}
		const envelope = record(value, "response envelope");
		return envelope.value;
	}
}

export interface LocalCloudRunnerLaunch {
	reconcile(signal?: AbortSignal): Promise<void>;
	acquire(work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance>;
	deliver(runner: CloudRunnerInstance, delivery: CloudRunnerAssignmentDelivery, signal?: AbortSignal): Promise<void>;
	stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void>;
}

/** Temporary test/development adapter. It deliberately implements the same
 * out-of-band assignment contract as a future managed-computer provider. */
export class LocalCloudRunnerProviderAdapter implements CloudRunnerProviderAdapter {
	readonly adapterId = "local";
	readonly #launch: LocalCloudRunnerLaunch;

	constructor(launch: LocalCloudRunnerLaunch) {
		this.#launch = launch;
	}

	reconcile(signal?: AbortSignal): Promise<void> {
		return signal ? this.#launch.reconcile(signal) : this.#launch.reconcile();
	}

	acquire(work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		return this.#launch.acquire(work, signal);
	}

	deliver(runner: CloudRunnerInstance, delivery: CloudRunnerAssignmentDelivery, signal?: AbortSignal): Promise<void> {
		return signal ? this.#launch.deliver(runner, delivery, signal) : this.#launch.deliver(runner, delivery);
	}

	stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void> {
		return signal ? this.#launch.stop(runner, reason, signal) : this.#launch.stop(runner, reason);
	}
}
