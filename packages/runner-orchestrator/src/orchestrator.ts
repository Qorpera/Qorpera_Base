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
	/** Both or neither: a folder-v2 run pins no Company File snapshot (folder core C4; its pin becomes companySeq). */
	substrateVersionId?: string;
	companySnapshotId?: string;
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

/** Raises a listed cursor's next due time to the first slot it waits for. The
 * position (`expectedLastScheduledFor`, absent for a fresh cursor) is compared
 * exactly and never moves; no occurrence is created. */
export interface AdvanceCloudRoutineNextDueInput {
	routineId: string;
	expectedVersion: number;
	triggerId: string;
	expectedLastScheduledFor?: string;
	nextDueAt: string;
}

export interface CloudRoutineNextDue {
	status: "advanced" | "unchanged" | "stale";
	nextDueAt?: string;
}

/** A folder-v2 company's dynamic routine that may be missing its next run (folder core C1c-3e). */
export interface CloudFolderDynamicRoutine {
	routineId: string;
	version: number;
}

export interface CloudFolderDynamicRoutinePage {
	items: readonly CloudFolderDynamicRoutine[];
	hasMore: boolean;
	nextAfterRoutineId?: string;
}

/** What the per-routine restore did: `inserted` its next run, or why it inserted none. */
export interface CloudFolderDynamicRoutineRun {
	status:
		| "inserted"
		| "pending"
		| "running"
		| "changed"
		| "gone"
		| "not_folder"
		| "paused"
		| "busy"
		| "stopped"
		| "ended"
		| "suspended";
	occurrenceId?: string;
}

/** A page of folder-v2 companies with work to turn into runs (folder core C4, P28). */
export interface CloudFolderMaterializationPage {
	items: readonly string[];
	hasMore: boolean;
	nextAfterProfileId?: string;
}

/** A per-company folder drain (folder core C4, P29, deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9): a due list
 * of environments and one company's step, each its own request and transaction, run before the folder materializer.
 * The edge function maps the name to its two RPCs. */
export interface CloudFolderDrainSpec {
	/** The drain's name, as the edge function knows it. */
	name: string;
	/** The most one company's request may do (1 to 256). */
	companyLimit: number;
}

/** The drains the orchestrator runs, in order. Another drain adds its entry here and in the edge function's table. */
export const CLOUD_FOLDER_DRAINS: readonly CloudFolderDrainSpec[] = Object.freeze([
	// F2's worker drain first (core §11 C4): a worker started or a parent revived this pass is materialized this pass too.
	Object.freeze({ name: "workers", companyLimit: 32 }),
	Object.freeze({ name: "listen", companyLimit: 32 }),
	// F2's human-task wakes (H2c) after the listener, which marks the task changes they wake for.
	Object.freeze({ name: "human_tasks", companyLimit: 32 }),
	// A company machine's events, to the runs that started the work (C1c-3i-b): up to 8 parents a step.
	Object.freeze({ name: "machine_events", companyLimit: 8 }),
	// C1c-3l part 2: an agent's waiters for a Company Computer it started (RUNTIME-COMPANY-FOLDER-C1C.md §6.18).
	Object.freeze({ name: "office_wakes", companyLimit: 16 }),
	// The one idle rule's check-ins: it asks about busy programs, then continues up to 8 parents a step.
	Object.freeze({ name: "machine_checkins", companyLimit: 8 }),
	// A quiet coding session's check-in question, to the run that started it (C3c): up to 8 sessions a step.
	Object.freeze({ name: "coding_checkins", companyLimit: 8 }),
	// Event wakes (E2): W2's listeners on hooks and mailboxes, up to 16 a step, as qorpera_drain_event_wakes took them.
	Object.freeze({ name: "events", companyLimit: 16 }),
]);

/** A page of folder-v2 environments with work for one drain. */
export interface CloudFolderDrainPage {
	items: readonly string[];
	hasMore: boolean;
	nextAfterEnvironmentId?: string;
}

/** What one company's drain step did: its own state word (`done`, `idle`, `busy`, `paused` …). */
export interface CloudFolderDrainResult {
	state: string;
}

/** What one company's materialization did: `done` with the runs it made, or why it made none. */
export interface CloudFolderMaterialization {
	state: "done" | "idle" | "paused" | "at_zero" | "not_folder";
	runIds: readonly string[];
}

export interface CloudRoutineWakeOccurrence {
	occurrenceId: string;
	status: "queued" | "materialized" | "completed" | "failed" | "requires_review" | "cancelled" | "deferred";
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
	advanceRoutineNextDue(input: AdvanceCloudRoutineNextDueInput, signal?: AbortSignal): Promise<CloudRoutineNextDue>;
	/** Folder-v2 dynamic routines (folder core C1c-3e): each next run in its own company's transaction. */
	listFolderDynamicRoutines?(
		afterRoutineId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderDynamicRoutinePage>;
	restoreFolderDynamicRoutineRun?(
		routine: CloudFolderDynamicRoutine,
		signal?: AbortSignal,
	): Promise<CloudFolderDynamicRoutineRun>;
	/** Folder-v2 runs (folder core C4, P28): each company's work in its own transaction. */
	listFolderMaterializationDue?(
		afterProfileId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderMaterializationPage>;
	materializeFolderCompany?(
		profileId: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderMaterialization>;
	/** The per-company folder drains (folder core C4, P29): each company's step in its own transaction. */
	listFolderDrainDue?(
		drain: string,
		afterEnvironmentId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderDrainPage>;
	runFolderDrain?(
		drain: string,
		environmentId: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderDrainResult>;
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
	/** Answers `deferred` when the release left the job waiting by its own deferral, with nothing counted. */
	releaseClaim(
		claim: CloudRunnerOrchestrationClaim,
		clientAssignmentId: string,
		error: string,
		signal?: AbortSignal,
	): Promise<{ deferred: boolean } | undefined>;
}

export interface CloudRunnerOccurrenceReconciler {
	reconcile(controlPlane: CloudRunnerOrchestratorControlPlane, signal?: AbortSignal): Promise<void>;
}

export interface CloudRoutineScheduleReconcilerOptions {
	now?: () => Date;
	pageSize?: number;
	catchUpLimit?: number;
	/** How often the folder-v2 dynamic routines are listed (folder core C1c-3e); default 30 s. */
	folderDynamicIntervalMs?: number;
}

export interface CloudFolderDrainsOptions {
	now?: () => Date;
	pageSize?: number;
	drains?: readonly CloudFolderDrainSpec[];
}

export interface CloudFolderRunMaterializerOptions {
	now?: () => Date;
	pageSize?: number;
	/** At most this many of one company's items per request (1 to 16; default 16). */
	companyLimit?: number;
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

/** Tells the claim loop that claimable work may have appeared. Wake-ups may be lost, late or repeated: the
 * loop still asks for work every backstop interval, and a wake-up only brings a claim forward. */
export interface CloudRunnerWakeSource {
	/** Wake-ups are being delivered right now (for Realtime: the channel is joined). */
	readonly listening: boolean;
	/** Calls `listener` on every wake-up and whenever delivery starts or stops; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/** A backstop claim found new work that no wake-up announced; the loop polls at the fast rate for a while. */
export class CloudRunnerWakeMissed extends Error {
	constructor() {
		super("Work was claimed that no wake-up announced; asking for work at the poll interval for ten minutes");
		this.name = "CloudRunnerWakeMissed";
	}
}

/** How long a wake-up may lag the claim that found its work before it counts as missed. */
const WAKE_GRACE_MS = 2_000;
/** After a missed wake-up, poll at the fast rate this long. */
const WAKE_MISSED_MS = 10 * 60_000;

export interface CloudRunnerOrchestratorLoopOptions {
	/** How often the loop asks for new work. */
	pollIntervalMs?: number;
	/**
	 * How often it renews control, runs the occurrence reconcilers, reconciles
	 * expired claims and the provider, and re-reads its retained claims. These
	 * are several round trips in a lane of their own; asking for new work does
	 * not wait for them, only for the latest pass to have succeeded.
	 */
	reconcileIntervalMs?: number;
	shutdownGraceMs?: number;
	/** Push wake-ups (none unless given). While the source is listening and the loop has been idle for a
	 * while, new work is asked for on a wake-up and every `wakeBackstopMs`; otherwise every `pollIntervalMs`. */
	wake?: CloudRunnerWakeSource;
	/** The slow poll while wake-ups are delivered: the most a lost wake-up delays a claim (default 5 s). */
	wakeBackstopMs?: number;
	/** After a claim that found work or a failed dispatch, how long to keep polling at the fast rate (default
	 * 30 s): retries and placement deferrals (5 and 15 s) end by time and send no wake-up. */
	wakeActiveMs?: number;
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
	| {
			action: "advance_next_due";
			orchestratorId: string;
			routineId: string;
			expectedVersion: number;
			triggerId: string;
			expectedLastScheduledFor?: string;
			nextDueAt: string;
	  }
	| { action: "folder_dynamic_routines"; orchestratorId: string; afterRoutineId?: string; limit: number }
	| { action: "restore_dynamic_routine"; orchestratorId: string; routineId: string; expectedVersion: number }
	| { action: "folder_materialize_due"; orchestratorId: string; afterProfileId?: string; limit: number }
	| { action: "folder_materialize_company"; orchestratorId: string; profileId: string; limit: number }
	| { action: "folder_drain_due"; orchestratorId: string; drain: string; afterEnvironmentId?: string; limit: number }
	| { action: "folder_drain_company"; orchestratorId: string; drain: string; environmentId: string; limit: number }
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

function parseRoutineWakeOccurrence(value: unknown, occurrenceId?: string): CloudRoutineWakeOccurrence {
	const input = record(value, "routine wake occurrence");
	// The company is paused: nothing was admitted and the cursor did not move; the
	// same occurrence is offered again on the next pass.
	if (input.status === "deferred" && input.occurrence_id === null && occurrenceId) {
		return {
			occurrenceId,
			status: "deferred",
			scheduledFor: responseTimestamp(input.scheduled_for, "wake occurrence schedule"),
		};
	}
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

function parseRoutineNextDue(value: unknown): CloudRoutineNextDue {
	const input = record(value, "routine next due time");
	if (input.status !== "advanced" && input.status !== "unchanged" && input.status !== "stale") {
		throw new Error("Runner orchestrator returned invalid routine next due status");
	}
	const nextDueAt =
		input.next_due_at === null || input.next_due_at === undefined
			? undefined
			: responseTimestamp(input.next_due_at, "routine next due time");
	return { status: input.status, ...(nextDueAt ? { nextDueAt } : {}) };
}

function parseFolderDynamicRoutinePage(value: unknown): CloudFolderDynamicRoutinePage {
	const input = record(value, "folder dynamic routine page");
	if (!Array.isArray(input.items) || typeof input.has_more !== "boolean") {
		throw new Error("Runner orchestrator returned invalid folder dynamic routine page");
	}
	const nextAfterRoutineId =
		input.next_after_routine_id === null || input.next_after_routine_id === undefined
			? undefined
			: responseUuid(input.next_after_routine_id, "folder dynamic routine cursor");
	if (input.has_more !== (nextAfterRoutineId !== undefined)) {
		throw new Error("Runner orchestrator returned inconsistent folder dynamic routine pagination");
	}
	return {
		items: input.items.map((value) => {
			const item = record(value, "folder dynamic routine");
			if (
				!Number.isSafeInteger(item.version) ||
				(item.version as number) < 1 ||
				(item.version as number) > 1_000_000
			) {
				throw new Error("Runner orchestrator returned an invalid folder dynamic routine version");
			}
			return {
				routineId: responseUuid(item.routine_id, "folder dynamic routine id"),
				version: item.version as number,
			};
		}),
		hasMore: input.has_more,
		...(nextAfterRoutineId ? { nextAfterRoutineId } : {}),
	};
}

const FOLDER_DYNAMIC_ROUTINE_RUN_STATUSES = new Set<CloudFolderDynamicRoutineRun["status"]>([
	"inserted",
	"pending",
	"running",
	"changed",
	"gone",
	"not_folder",
	"paused",
	"busy",
	"stopped",
	"ended",
	"suspended",
]);

function parseFolderDynamicRoutineRun(value: unknown): CloudFolderDynamicRoutineRun {
	const input = record(value, "folder dynamic routine run");
	const status = input.status as CloudFolderDynamicRoutineRun["status"];
	if (!FOLDER_DYNAMIC_ROUTINE_RUN_STATUSES.has(status)) {
		throw new Error("Runner orchestrator returned an invalid folder dynamic routine status");
	}
	const occurrenceId =
		input.occurrence_id === null || input.occurrence_id === undefined
			? undefined
			: responseUuid(input.occurrence_id, "folder dynamic routine occurrence id");
	if (status === "inserted" && !occurrenceId) {
		throw new Error("Runner orchestrator returned an inserted folder dynamic routine run without its id");
	}
	return { status, ...(occurrenceId ? { occurrenceId } : {}) };
}

const FOLDER_DRAIN_NAME = /^[a-z][a-z0-9_]{0,31}$/;

function folderDrainName(drain: string): void {
	if (!FOLDER_DRAIN_NAME.test(drain)) throw new Error("Folder drain name is invalid");
}

function parseFolderDrainPage(value: unknown): CloudFolderDrainPage {
	const input = record(value, "folder drain page");
	if (!Array.isArray(input.items) || typeof input.has_more !== "boolean") {
		throw new Error("Runner orchestrator returned invalid folder drain page");
	}
	const nextAfterEnvironmentId =
		input.next_after_environment_id === null || input.next_after_environment_id === undefined
			? undefined
			: responseUuid(input.next_after_environment_id, "folder drain cursor");
	if (input.has_more !== (nextAfterEnvironmentId !== undefined)) {
		throw new Error("Runner orchestrator returned inconsistent folder drain pagination");
	}
	return {
		items: input.items.map((item) =>
			responseUuid(record(item, "folder drain company").environment_id, "folder environment id"),
		),
		hasMore: input.has_more,
		...(nextAfterEnvironmentId ? { nextAfterEnvironmentId } : {}),
	};
}

function parseFolderDrainResult(value: unknown): CloudFolderDrainResult {
	const input = record(value, "folder drain result");
	if (typeof input.state !== "string" || !/^[a-z_]{1,32}$/.test(input.state)) {
		throw new Error("Runner orchestrator returned an invalid folder drain state");
	}
	return { state: input.state };
}

function parseFolderMaterializationPage(value: unknown): CloudFolderMaterializationPage {
	const input = record(value, "folder materialization page");
	if (!Array.isArray(input.items) || typeof input.has_more !== "boolean") {
		throw new Error("Runner orchestrator returned invalid folder materialization page");
	}
	const nextAfterProfileId =
		input.next_after_profile_id === null || input.next_after_profile_id === undefined
			? undefined
			: responseUuid(input.next_after_profile_id, "folder materialization cursor");
	if (input.has_more !== (nextAfterProfileId !== undefined)) {
		throw new Error("Runner orchestrator returned inconsistent folder materialization pagination");
	}
	return {
		items: input.items.map((value) => responseUuid(record(value, "folder company").profile_id, "folder company id")),
		hasMore: input.has_more,
		...(nextAfterProfileId ? { nextAfterProfileId } : {}),
	};
}

const FOLDER_MATERIALIZATION_STATES = new Set<CloudFolderMaterialization["state"]>([
	"done",
	"idle",
	"paused",
	"at_zero",
	"not_folder",
]);

function parseFolderMaterialization(value: unknown): CloudFolderMaterialization {
	const input = record(value, "folder materialization");
	const state = input.state as CloudFolderMaterialization["state"];
	if (!FOLDER_MATERIALIZATION_STATES.has(state)) {
		throw new Error("Runner orchestrator returned an invalid folder materialization state");
	}
	if (state === "done" && !Array.isArray(input.run_ids)) {
		throw new Error("Runner orchestrator returned a folder materialization without its runs");
	}
	const runIds = state === "done" ? (input.run_ids as unknown[]) : [];
	return { state, runIds: runIds.map((id) => responseUuid(id, "folder materialized run id")) };
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
		// Both or neither (a folder-v2 run has neither); one alone fails its own check.
		...((input.substrate_version_id === null || input.substrate_version_id === undefined) &&
		(input.company_snapshot_id === null || input.company_snapshot_id === undefined)
			? {}
			: {
					substrateVersionId: responseUuid(input.substrate_version_id, "substrate version id"),
					companySnapshotId: responseUuid(input.company_snapshot_id, "Company File snapshot id"),
				}),
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

/** A routine that has never run runs once as soon as it exists — the kickoff —
 * and then on its cadence, so weekly work set up on a Tuesday starts that day
 * instead of the following Monday. A version's cursor is fresh only when no
 * earlier version advanced it (the kernel carries the position forward), so
 * an edit neither re-runs the routine nor loses a kickoff still owed. The
 * kickoff instant is the version's effective time, which every orchestrator
 * derives identically; a version older than the kickoff window (a routine
 * revived weeks later) takes its next ordinary slot instead. There is no
 * kickoff when the trigger names a later start (that is the agent asking to
 * wait) or when a window bounds the run times. */
const ROUTINE_KICKOFF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function routineKickoffForgone(trigger: RoutineScheduleTrigger, effectiveAt: Date): boolean {
	if ("windowStart" in trigger) return true;
	if (trigger.startAt === undefined) return false;
	const startAt = Date.parse(trigger.startAt);
	return !Number.isFinite(startAt) || startAt > effectiveAt.getTime();
}

function routineKickoff(trigger: RoutineScheduleTrigger, now: Date, effectiveAt: Date): Date | undefined {
	if (routineKickoffForgone(trigger, effectiveAt)) return undefined;
	if (!Number.isFinite(effectiveAt.getTime()) || effectiveAt.getTime() > now.getTime()) return undefined;
	if (now.getTime() - effectiveAt.getTime() > ROUTINE_KICKOFF_WINDOW_MS) return undefined;
	return effectiveAt;
}

interface RoutineFirstSlot {
	expectedLastScheduledFor?: string;
	nextDueAt: string;
}

/** A listed trigger with nothing due waits for its first slot: a restart position
 * (the kernel restarts the schedule at a save or a resume, due one millisecond
 * later so the scheduler lists it) or a fresh cursor whose trigger names a later
 * start or a window. Raising its next due time to that slot takes it off the
 * listing until then and gives it a next run to show. The position is never moved,
 * so a fresh cursor stays fresh: its first run is still the latest slot at or
 * after the version's effective time. A fresh cursor that may still owe its
 * kickoff is left alone. Call only when `dueRoutineWakes` found nothing due. */
function routineFirstSlot(
	head: CloudRoutineScheduleHead,
	trigger: RoutineScheduleTrigger,
	now: Date,
): RoutineFirstSlot | undefined {
	const cursor = head.scheduleCursors.find((candidate) => candidate.triggerId === trigger.id);
	if (!cursor) return undefined;
	if (cursor.lastScheduledFor) {
		const first = nextRoutineOccurrence(trigger, new Date(cursor.lastScheduledFor));
		// Not yet due by this clock, but already the cursor's own next due time (an
		// ordinary position, or a database clock ahead of this one): nothing to raise.
		if (!first || first.getTime() <= now.getTime()) return undefined;
		if (cursor.nextDueAt && first.getTime() <= Date.parse(cursor.nextDueAt)) return undefined;
		return { expectedLastScheduledFor: cursor.lastScheduledFor, nextDueAt: first.toISOString() };
	}
	const effectiveAt = new Date(head.effectiveAt);
	if (!routineKickoffForgone(trigger, effectiveAt)) return undefined;
	const first = nextRoutineOccurrence(trigger, new Date(Math.max(now.getTime(), effectiveAt.getTime() - 1)));
	return first ? { nextDueAt: first.toISOString() } : undefined;
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
		const effectiveAt = new Date(head.effectiveAt);
		let scheduledFor = latestRoutineOccurrence(trigger, now);
		if (!scheduledFor || scheduledFor.getTime() < effectiveAt.getTime()) {
			scheduledFor = routineKickoff(trigger, now, effectiveAt);
			if (!scheduledFor) return [];
		}
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

const ROUTINE_ADVANCE_RETRY_MS = 10 * 60 * 1000;

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
	/** A control plane that answers the first-slot advance with 400 does not know
	 * it yet (its edge function predates this orchestrator): report that and keep
	 * scheduling as before for a while, instead of failing every poll, then ask
	 * again in case the edge function was deployed meanwhile. */
	#advancePausedUntil = 0;
	/** The same for the folder-v2 dynamic routines' actions (folder core C1c-3e). */
	#folderDynamicPausedUntil = 0;
	/** The folder-v2 dynamic routines are listed at most this often, not on every poll. */
	readonly #folderDynamicIntervalMs: number;
	#folderDynamicNextAt = 0;

	constructor(options: CloudRoutineScheduleReconcilerOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = options.pageSize ?? 250;
		this.#catchUpLimit = options.catchUpLimit ?? 32;
		this.#folderDynamicIntervalMs = options.folderDynamicIntervalMs ?? 30_000;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
			throw new Error("Routine schedule page size is outside the supported range");
		}
		if (!Number.isSafeInteger(this.#catchUpLimit) || this.#catchUpLimit < 1 || this.#catchUpLimit > 256) {
			throw new Error("Routine schedule catch-up limit is outside the supported range");
		}
		if (
			!Number.isSafeInteger(this.#folderDynamicIntervalMs) ||
			this.#folderDynamicIntervalMs < 0 ||
			this.#folderDynamicIntervalMs > 3_600_000
		) {
			throw new Error("Folder dynamic routine interval is outside the supported range");
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
					const now = this.#now();
					const wakes = dueRoutineWakes(head, trigger, now, this.#catchUpLimit);
					const firstSlot =
						wakes.length === 0 && now.getTime() >= this.#advancePausedUntil
							? routineFirstSlot(head, trigger, now)
							: undefined;
					if (firstSlot) {
						const input: AdvanceCloudRoutineNextDueInput = {
							routineId: head.routineId,
							expectedVersion: head.version,
							triggerId: trigger.id,
							...firstSlot,
						};
						try {
							// A stale answer is not a failure: the next poll reads the cursor again.
							if (signal) await controlPlane.advanceRoutineNextDue(input, signal);
							else await controlPlane.advanceRoutineNextDue(input);
						} catch (error) {
							if (signal?.aborted) throw error;
							if (error instanceof CloudRunnerOrchestratorRequestError && error.status === 400) {
								this.#advancePausedUntil = now.getTime() + ROUTINE_ADVANCE_RETRY_MS;
							}
							failures.push(error);
						}
					}
					for (const occurrence of wakes) {
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
		await this.#restoreFolderDynamicRoutines(controlPlane, failures, signal);
		if (failures.length > 0) throw new RoutineWakeAdmissionErrors(failures);
	}

	/** A folder-v2 dynamic routine's next run: one restore per listed routine, each in its own company's transaction
	 * (the legacy tick inside `reconcile` skips folder-v2). One routine's failure never stops the others. */
	async #restoreFolderDynamicRoutines(
		controlPlane: CloudRunnerOrchestratorControlPlane,
		failures: unknown[],
		signal?: AbortSignal,
	): Promise<void> {
		if (!controlPlane.listFolderDynamicRoutines || !controlPlane.restoreFolderDynamicRoutineRun) return;
		const now = this.#now().getTime();
		if (now < this.#folderDynamicPausedUntil || now < this.#folderDynamicNextAt) return;
		this.#folderDynamicNextAt = now + this.#folderDynamicIntervalMs;
		let afterRoutineId: string | undefined;
		do {
			let page: CloudFolderDynamicRoutinePage;
			try {
				page = signal
					? await controlPlane.listFolderDynamicRoutines(afterRoutineId, this.#pageSize, signal)
					: await controlPlane.listFolderDynamicRoutines(afterRoutineId, this.#pageSize);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (error instanceof CloudRunnerOrchestratorRequestError && error.status === 400) {
					this.#folderDynamicPausedUntil = now + ROUTINE_ADVANCE_RETRY_MS;
				}
				failures.push(error);
				return;
			}
			for (const routine of page.items) {
				try {
					if (signal) await controlPlane.restoreFolderDynamicRoutineRun(routine, signal);
					else await controlPlane.restoreFolderDynamicRoutineRun(routine);
				} catch (error) {
					if (signal?.aborted) throw error;
					failures.push(error);
				}
			}
			afterRoutineId = page.hasMore ? page.nextAfterRoutineId : undefined;
			if (page.hasMore && !afterRoutineId) throw new Error("Folder dynamic routine pagination lost its cursor");
		} while (afterRoutineId);
	}
}

/** A drain whose list fails, or a company whose step fails, is asked again after 1 s, then 2 s, 4 s … at most 5 minutes;
 * a drain the edge function does not know (400) after ten minutes. */
const FOLDER_DRAIN_BACKOFF_MS = 1_000;
const FOLDER_DRAIN_BACKOFF_MAX_MS = 5 * 60_000;

interface FolderDrainBackoff {
	until: number;
	failures: number;
}

function folderDrainBackoff(previous: FolderDrainBackoff | undefined, now: number, wait?: number): FolderDrainBackoff {
	const failures = (previous?.failures ?? 0) + 1;
	return {
		failures,
		until:
			now +
			(wait ?? Math.min(FOLDER_DRAIN_BACKOFF_MAX_MS, FOLDER_DRAIN_BACKOFF_MS * 2 ** Math.min(failures - 1, 20))),
	};
}

/** The per-company folder drains (folder core C4, P29: the shared step before the materializer;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9): for each drain in order, every company with due work in its
 * own request and transaction. Each drain has its own pause and backoff, and each of its companies its own: a drain
 * whose list fails, or that the edge function does not know, stops only itself, and one company's failure stops no
 * other. The wakes a drain admits are materialized in the same pass. */
export class CloudFolderDrains implements CloudRunnerOccurrenceReconciler {
	readonly #now: () => Date;
	readonly #pageSize: number;
	readonly #drains: readonly CloudFolderDrainSpec[];
	readonly #drainBackoff = new Map<string, FolderDrainBackoff>();
	/** Keyed by drain name and environment id. */
	readonly #companyBackoff = new Map<string, FolderDrainBackoff>();

	constructor(options: CloudFolderDrainsOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = options.pageSize ?? 100;
		this.#drains = options.drains ?? CLOUD_FOLDER_DRAINS;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
			throw new Error("Folder drain page size is outside the supported range");
		}
		const names = new Set<string>();
		for (const drain of this.#drains) {
			folderDrainName(drain.name);
			if (names.has(drain.name)) throw new Error("Folder drain is listed twice");
			names.add(drain.name);
			if (!Number.isSafeInteger(drain.companyLimit) || drain.companyLimit < 1 || drain.companyLimit > 256) {
				throw new Error("Folder drain company limit is outside the supported range");
			}
		}
	}

	async reconcile(controlPlane: CloudRunnerOrchestratorControlPlane, signal?: AbortSignal): Promise<void> {
		if (!controlPlane.listFolderDrainDue || !controlPlane.runFolderDrain) return;
		const now = this.#now().getTime();
		// A company no longer due is forgotten once its wait has long passed.
		for (const [key, backoff] of this.#companyBackoff) {
			if (backoff.until + FOLDER_DRAIN_BACKOFF_MAX_MS < now) this.#companyBackoff.delete(key);
		}
		const failures: unknown[] = [];
		for (const drain of this.#drains) {
			if (now < (this.#drainBackoff.get(drain.name)?.until ?? 0)) continue;
			const failed = (error: unknown, wait?: number) => {
				failures.push(error);
				this.#drainBackoff.set(
					drain.name,
					folderDrainBackoff(this.#drainBackoff.get(drain.name), this.#now().getTime(), wait),
				);
			};
			let afterEnvironmentId: string | undefined;
			let listed = true;
			do {
				let page: CloudFolderDrainPage;
				try {
					page = signal
						? await controlPlane.listFolderDrainDue(drain.name, afterEnvironmentId, this.#pageSize, signal)
						: await controlPlane.listFolderDrainDue(drain.name, afterEnvironmentId, this.#pageSize);
				} catch (error) {
					if (signal?.aborted) throw error;
					failed(
						error,
						error instanceof CloudRunnerOrchestratorRequestError && error.status === 400
							? ROUTINE_ADVANCE_RETRY_MS
							: undefined,
					);
					listed = false;
					break;
				}
				for (const environmentId of page.items) {
					const key = `${drain.name} ${environmentId}`;
					if (now < (this.#companyBackoff.get(key)?.until ?? 0)) continue;
					try {
						if (signal) await controlPlane.runFolderDrain(drain.name, environmentId, drain.companyLimit, signal);
						else await controlPlane.runFolderDrain(drain.name, environmentId, drain.companyLimit);
						this.#companyBackoff.delete(key);
					} catch (error) {
						if (signal?.aborted) throw error;
						failures.push(error);
						this.#companyBackoff.set(
							key,
							folderDrainBackoff(this.#companyBackoff.get(key), this.#now().getTime()),
						);
					}
				}
				const next = page.hasMore ? page.nextAfterEnvironmentId : undefined;
				if (page.hasMore && !next) {
					failed(new Error(`Folder drain ${drain.name} pagination lost its cursor`));
					listed = false;
					break;
				}
				if (next !== undefined && afterEnvironmentId !== undefined && next <= afterEnvironmentId) {
					failed(new Error(`Folder drain ${drain.name} pagination did not move forward`));
					listed = false;
					break;
				}
				afterEnvironmentId = next;
			} while (afterEnvironmentId);
			if (listed) this.#drainBackoff.delete(drain.name);
		}
		if (failures.length > 0) throw new RoutineWakeAdmissionErrors(failures);
	}
}

/** Folder-v2 runs (folder core C4, P28): every company with due work in its own request, so each is its own
 * transaction (one company per admitting transaction, core §3 step 10). The legacy materializers inside `reconcile`
 * skip folder-v2. One company's failure never stops the others. */
export class CloudFolderRunMaterializer implements CloudRunnerOccurrenceReconciler {
	readonly #now: () => Date;
	readonly #pageSize: number;
	readonly #companyLimit: number;
	/** A control plane that answers the list with 400 does not know it yet (its edge function predates this
	 * orchestrator): report that once and ask again after a while. */
	#pausedUntil = 0;

	constructor(options: CloudFolderRunMaterializerOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = options.pageSize ?? 100;
		this.#companyLimit = options.companyLimit ?? 16;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
			throw new Error("Folder materialization page size is outside the supported range");
		}
		if (!Number.isSafeInteger(this.#companyLimit) || this.#companyLimit < 1 || this.#companyLimit > 16) {
			throw new Error("Folder materialization company limit is outside the supported range");
		}
	}

	async reconcile(controlPlane: CloudRunnerOrchestratorControlPlane, signal?: AbortSignal): Promise<void> {
		if (!controlPlane.listFolderMaterializationDue || !controlPlane.materializeFolderCompany) return;
		const now = this.#now().getTime();
		if (now < this.#pausedUntil) return;
		const failures: unknown[] = [];
		let afterProfileId: string | undefined;
		do {
			let page: CloudFolderMaterializationPage;
			try {
				page = signal
					? await controlPlane.listFolderMaterializationDue(afterProfileId, this.#pageSize, signal)
					: await controlPlane.listFolderMaterializationDue(afterProfileId, this.#pageSize);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (error instanceof CloudRunnerOrchestratorRequestError && error.status === 400) {
					this.#pausedUntil = now + ROUTINE_ADVANCE_RETRY_MS;
				}
				failures.push(error);
				break;
			}
			for (const profileId of page.items) {
				try {
					if (signal) await controlPlane.materializeFolderCompany(profileId, this.#companyLimit, signal);
					else await controlPlane.materializeFolderCompany(profileId, this.#companyLimit);
				} catch (error) {
					if (signal?.aborted) throw error;
					failures.push(error);
				}
			}
			const next = page.hasMore ? page.nextAfterProfileId : undefined;
			if (page.hasMore && !next) throw new Error("Folder materialization pagination lost its cursor");
			if (next !== undefined && afterProfileId !== undefined && next <= afterProfileId)
				throw new Error("Folder materialization pagination did not move forward");
			afterProfileId = next;
		} while (afterProfileId);
		if (failures.length > 0) throw new RoutineWakeAdmissionErrors(failures);
	}
}

/** A poll wait that an event can end early. A wake while no wait runs ends the next one at once. */
class PollTimer {
	#wake?: () => void;
	#woken = false;

	wait(delayMs: number, signal: AbortSignal): Promise<void> {
		if (this.#woken || signal.aborted) {
			this.#woken = false;
			return Promise.resolve();
		}
		return new Promise((resolveWait) => {
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				this.#wake = undefined;
				resolveWait();
			};
			const timer = setTimeout(done, delayMs);
			signal.addEventListener("abort", done, { once: true });
			this.#wake = done;
		});
	}

	wake(): void {
		if (this.#wake) this.#wake();
		else this.#woken = true;
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

/** The private Realtime topic the database broadcasts an orchestrator's wake-ups to. It is derived from the
 * sha256 of the control token, which only the database keeps, so nobody else can name it, and it moves with
 * every control rotation. The database derives the same name from its stored hash. */
export function cloudRunnerOrchestratorWakeTopic(controlToken: string): string {
	const tokenSha256 = createHash("sha256").update(controlToken).digest("hex");
	const wakeId = createHash("sha256").update(`qorpera.orchestrator-wake/v1:${tokenSha256}`).digest("hex");
	return `qorpera-orchestrator-wake-${wakeId}`;
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
		["Staff agent id", work.staffAgentId],
		["Sponsor binding id", work.sponsor.bindingId],
		["Provider connection id", work.sponsor.providerConnectionId],
	] as const) {
		requiredUuid(value, label);
	}
	if ((work.substrateVersionId === undefined) !== (work.companySnapshotId === undefined)) {
		throw new Error("Substrate version id and Company snapshot id go together");
	}
	if (work.substrateVersionId !== undefined) requiredUuid(work.substrateVersionId, "Substrate version id");
	if (work.companySnapshotId !== undefined) requiredUuid(work.companySnapshotId, "Company snapshot id");
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
	/** Failed acquisitions whose release the control plane answered with a deferral: see `reconcile.required`. */
	readonly #deferredDispatches = new WeakSet<object>();
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
		// The folder drains, then the folder materializer (which runs the wakes the drains admitted in the same pass): a
		// routine schedule outage (whose list error ends the pass) never stops runs.
		this.#occurrenceReconcilers = [
			new CloudFolderDrains(),
			new CloudFolderRunMaterializer(),
			new CloudRoutineScheduleReconciler(),
			...(options.occurrenceReconcilers ?? []),
		];
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
		includeRetained = true,
	): Promise<{ claims: readonly CloudRunnerOrchestrationClaim[]; fresh: number }> {
		const retained = !includeRetained
			? []
			: signal
				? await this.#controlPlane.retainedClaims(this.#orchestratorId, signal)
				: await this.#controlPlane.retainedClaims(this.#orchestratorId);
		const claims = retained.filter((claim) => !excludedClaimIds.has(claim.claimId)).slice(0, limit);
		let fresh = 0;
		while (claims.length < limit) {
			const clientClaimId = this.#clientClaimId();
			const claim = signal
				? await this.#controlPlane.claimNext(this.#orchestratorId, clientClaimId, this.#claimLeaseSeconds, signal)
				: await this.#controlPlane.claimNext(this.#orchestratorId, clientClaimId, this.#claimLeaseSeconds);
			if (!claim) break;
			claims.push(claim);
			fresh++;
		}
		return { claims, fresh };
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
			const released = await this.#controlPlane
				.releaseClaim(claim, clientAssignmentId, deliveryFailure(error))
				.catch(() => undefined);
			if (released?.deferred && typeof error === "object" && error !== null) this.#deferredDispatches.add(error);
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
			/* A current runner activates before its inbox answers, but an older
			 * guest activates concurrently with acquisition, so an assign issued
			 * immediately after acquire can race the activation and fail its
			 * prerequisite check (423). The worker is healthy and freshly booted;
			 * retry inside the claim window instead of destroying it. */
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
						assignAttempt >= 20 ||
						signal?.aborted
					) {
						throw error;
					}
					// A sandbox activates within a second; a booting guest within
					// tens. Back off from 50 ms, doubling towards 3 s inside the claim window.
					await waitForPoll(
						Math.min(3_000, 50 * 2 ** (assignAttempt - 1)),
						signal ?? new AbortController().signal,
					);
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
		const {
			claims: [claim],
		} = await this.#claimBatch(1, signal);
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
		const reconcileIntervalMs = options.reconcileIntervalMs ?? 2_000;
		if (!Number.isSafeInteger(reconcileIntervalMs) || reconcileIntervalMs < 10 || reconcileIntervalMs > 60_000) {
			throw new Error("Orchestrator reconcile interval is outside the supported range");
		}
		const shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
		if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 10 || shutdownGraceMs > 60_000) {
			throw new Error("Orchestrator shutdown grace is outside the supported range");
		}
		const wake = options.wake;
		const wakeBackstopMs = options.wakeBackstopMs ?? 5_000;
		const wakeActiveMs = options.wakeActiveMs ?? 30_000;
		if (wake && (!Number.isSafeInteger(wakeActiveMs) || wakeActiveMs < 0 || wakeActiveMs > 600_000)) {
			throw new Error("Orchestrator wake-up activity window is outside the supported range");
		}
		if (
			wake &&
			(!Number.isSafeInteger(wakeBackstopMs) ||
				wakeBackstopMs < 10 ||
				wakeBackstopMs > 60_000 ||
				wakeBackstopMs < pollIntervalMs)
		) {
			throw new Error("Orchestrator wake-up backstop is outside the supported range");
		}
		const inFlight = new Set<Promise<void>>();
		const inFlightClaimIds = new Set<string>();
		// Reconcile runs in its own lane: renewing control, the occurrence reconcilers, expired claims and
		// the provider's reconcile, then again every reconcileIntervalMs. Asking for new work never waits
		// for a pass (a provider's pass can wait on a machine it is starting). New work is asked for only
		// while the latest finished pass succeeded: a failed pass is reported, retried after one poll
		// interval and holds claims until one succeeds.
		const reconcile = {
			/** Passes started, numbered from 1. */
			started: 0,
			/** The latest pass that succeeded. */
			succeeded: 0,
			/** The latest finished pass failed. */
			failed: false,
			/** Claims wait for a successful pass numbered at least this: the first one, and after a failed
			 * dispatch, which can leave a finished sandbox or a retained claim behind, the next to start.
			 * An acquisition the control plane deferred is the exception: see the dispatch's catch below. */
			required: 1,
			/** Retained claims are re-read after each successful pass, as soon as the loop has capacity
			 * for them, and keep that priority until the read succeeds. */
			retainedRead: 0,
		};
		const reconcileTimer = new PollTimer();
		const claimTimer = new PollTimer();
		// With push wake-ups, new work is asked for on a wake-up and every wakeBackstopMs while they are
		// being delivered, and every pollIntervalMs otherwise, exactly as without them. A lost wake-up is
		// found by the next backstop claim. See the wake-up state below.
		const wakes = {
			/** A wake-up arrived since the last claim batch. */
			announced: false,
			/** Wake-ups so far: one that arrives while a claim batch is in flight still counts for it. */
			sequence: 0,
			/** Poll at pollIntervalMs until this time (performance.now()): after activity or a missed wake-up. */
			fastUntil: 0,
			/** The wait before the current claim batch was a backstop wait. */
			slow: false,
			/** When the last claim batch a wake-up brought forward started; those stay pollIntervalMs apart. */
			lastWokenClaimAt: Number.NEGATIVE_INFINITY,
			/** A backstop claim found new work no wake-up had announced, at this time. Realtime delivers a
			 * wake-up just after the enqueue commits, so one may still be on its way for WAKE_GRACE_MS. */
			unannouncedSince: undefined as number | undefined,
		};
		const slowPolling = (): boolean => wake?.listening === true && performance.now() >= wakes.fastUntil;
		const unsubscribe = wake?.subscribe(() => {
			wakes.announced = true;
			wakes.sequence++;
			wakes.unannouncedSince = undefined;
			claimTimer.wake();
		});
		const reconcileLane = (async (): Promise<void> => {
			while (!signal.aborted) {
				const pass = ++reconcile.started;
				let delayMs = reconcileIntervalMs;
				try {
					const claimsWereOpen = !reconcile.failed && reconcile.succeeded >= reconcile.required;
					const reconciliationErrors = await this.#reconcileControlPlane(signal);
					reconcile.succeeded = pass;
					reconcile.failed = false;
					// A pass that opens claims starts them at once. While wake-ups are delivered, a pass does
					// not otherwise bring the next claim forward: retained claims wait for the backstop claim.
					if (!claimsWereOpen || !slowPolling()) claimTimer.wake();
					for (const error of reconciliationErrors) options.onError?.(error);
				} catch (error) {
					reconcile.failed = true;
					delayMs = pollIntervalMs;
					options.onError?.(error);
				}
				await reconcileTimer.wait(delayMs, signal);
			}
		})();
		while (!signal.aborted) {
			try {
				const available = this.#dispatchConcurrency - inFlight.size;
				if (available > 0 && !reconcile.failed && reconcile.succeeded >= reconcile.required) {
					// A wake-up that arrives while every slot is busy waits for the next claim (see below).
					const announced = wakes.announced;
					const sequence = wakes.sequence;
					wakes.announced = false;
					const reconciled = reconcile.succeeded;
					const includeRetained = reconciled > reconcile.retainedRead;
					if (announced) wakes.lastWokenClaimAt = performance.now();
					const { claims, fresh } = await this.#claimBatch(available, signal, inFlightClaimIds, includeRetained);
					if (includeRetained) reconcile.retainedRead = Math.max(reconcile.retainedRead, reconciled);
					if (claims.length > 0) wakes.fastUntil = Math.max(wakes.fastUntil, performance.now() + wakeActiveMs);
					if (wake && fresh > 0 && wakes.slow && !announced && wakes.sequence === sequence)
						wakes.unannouncedSince ??= performance.now();
					for (const claim of claims) {
						if (inFlightClaimIds.has(claim.claimId)) continue;
						inFlightClaimIds.add(claim.claimId);
						let dispatch: Promise<void>;
						dispatch = this.#dispatchClaim(claim, signal)
							.then(() => undefined)
							.catch((error: unknown) => {
								// A failed dispatch can leave a finished sandbox or a retained claim
								// behind: reconcile at once, and claim again after that pass. A deferred or
								// retried job sends no wake-up, so poll at the fast rate for a while.
								// An acquisition the control plane deferred left neither: no machine started,
								// its claim is released and its job waits by its own deferral, whatever
								// row the provider keeps for its next try. That release holds no claims, as
								// a pass that materializes a burst of wakes takes seconds (production, 6 Nov
								// 2026: one refusal held every claim for 11.3 s). A lost release still does.
								if (!this.#deferredDispatches.has(error as object)) reconcile.required = reconcile.started + 1;
								reconcileTimer.wake();
								wakes.fastUntil = Math.max(wakes.fastUntil, performance.now() + wakeActiveMs);
								options.onError?.(error);
							})
							.finally(() => {
								inFlight.delete(dispatch);
								inFlightClaimIds.delete(claim.claimId);
								// A slot is free again: work a wake-up announced meanwhile is claimed now.
								if (wakes.announced) claimTimer.wake();
							});
						inFlight.add(dispatch);
					}
				}
			} catch (error) {
				options.onError?.(error);
			}
			if (signal.aborted) break;
			if (wakes.unannouncedSince !== undefined && performance.now() - wakes.unannouncedSince >= WAKE_GRACE_MS) {
				// New work arrived that no wake-up announced: they are not arriving (the database side is
				// missing, or delivery is broken). Poll as without them for a while, and say so once.
				wakes.unannouncedSince = undefined;
				wakes.fastUntil = performance.now() + WAKE_MISSED_MS;
				options.onError?.(new CloudRunnerWakeMissed());
			}
			wakes.slow = slowPolling();
			await claimTimer.wait(wakes.slow ? wakeBackstopMs : pollIntervalMs, signal);
			// A wake-up brings the next claim forward at once, but claims brought forward stay at least one poll
			// interval apart however many wake-ups arrive: a flood of them costs at most one more claim per interval.
			if (wakes.announced) {
				const gap = pollIntervalMs - (performance.now() - wakes.lastWokenClaimAt);
				if (gap > 0) await waitForPoll(gap, signal);
			}
		}
		unsubscribe?.();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.allSettled([...inFlight, reconcileLane]),
			new Promise<void>((resolveWait) => {
				timer = setTimeout(resolveWait, shutdownGraceMs);
			}),
		]);
		if (timer) clearTimeout(timer);
	}
}

export class SupabaseCloudRunnerOrchestratorControlPlane implements CloudRunnerOrchestratorControlPlane {
	readonly #orchestratorId: string;
	readonly #url: string;
	readonly #publishableKey: string;
	#controlToken: string;
	#pendingControlToken?: string;
	readonly #persistControlTokens?: (state: { current: string; pending?: string }) => Promise<void>;
	readonly #onControlRotated?: () => void;
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
			/** Called after the control token changed, for example to move to its new wake-up topic. */
			onControlRotated?: () => void;
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
		this.#onControlRotated = options.onControlRotated;
		this.#controlTokenSeconds = controlTokenSeconds;
		this.#now = options.now ?? Date.now;
		this.#fetch = fetchImplementation;
	}

	/** This orchestrator's wake-up topic under its current control token. */
	wakeTopic(): string {
		return cloudRunnerOrchestratorWakeTopic(this.#controlToken);
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
		try {
			this.#onControlRotated?.();
		} catch {
			// A listener never holds up rotation.
		}
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
		const enqueued = await this.#request(
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
		);
		return parseRoutineWakeOccurrence(enqueued, input.occurrenceId);
	}

	async advanceRoutineNextDue(
		input: AdvanceCloudRoutineNextDueInput,
		signal?: AbortSignal,
	): Promise<CloudRoutineNextDue> {
		requiredUuid(input.routineId, "Routine id");
		if (
			!Number.isSafeInteger(input.expectedVersion) ||
			input.expectedVersion < 1 ||
			input.expectedVersion > 1_000_000
		) {
			throw new Error("Routine version is invalid");
		}
		if (
			input.triggerId !== input.triggerId.trim() ||
			Buffer.byteLength(input.triggerId, "utf-8") < 1 ||
			Buffer.byteLength(input.triggerId, "utf-8") > 160 ||
			/[\0\r\n]/.test(input.triggerId) ||
			(input.expectedLastScheduledFor !== undefined &&
				(!Number.isFinite(Date.parse(input.expectedLastScheduledFor)) ||
					Date.parse(input.nextDueAt) <= Date.parse(input.expectedLastScheduledFor))) ||
			!Number.isFinite(Date.parse(input.nextDueAt))
		) {
			throw new Error("Routine next due time is invalid");
		}
		const advanced = await this.#request(
			{
				action: "advance_next_due",
				orchestratorId: this.#orchestratorId,
				routineId: input.routineId,
				expectedVersion: input.expectedVersion,
				triggerId: input.triggerId,
				...(input.expectedLastScheduledFor
					? { expectedLastScheduledFor: new Date(input.expectedLastScheduledFor).toISOString() }
					: {}),
				nextDueAt: new Date(input.nextDueAt).toISOString(),
			},
			signal,
		);
		return parseRoutineNextDue(advanced);
	}

	async listFolderDynamicRoutines(
		afterRoutineId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderDynamicRoutinePage> {
		if (afterRoutineId !== undefined) requiredUuid(afterRoutineId, "Folder dynamic routine cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Folder dynamic routine page limit is outside the supported range");
		}
		return parseFolderDynamicRoutinePage(
			await this.#request(
				{
					action: "folder_dynamic_routines",
					orchestratorId: this.#orchestratorId,
					...(afterRoutineId ? { afterRoutineId } : {}),
					limit,
				},
				signal,
			),
		);
	}

	async restoreFolderDynamicRoutineRun(
		routine: CloudFolderDynamicRoutine,
		signal?: AbortSignal,
	): Promise<CloudFolderDynamicRoutineRun> {
		requiredUuid(routine.routineId, "Routine id");
		if (!Number.isSafeInteger(routine.version) || routine.version < 1 || routine.version > 1_000_000) {
			throw new Error("Routine version is invalid");
		}
		return parseFolderDynamicRoutineRun(
			await this.#request(
				{
					action: "restore_dynamic_routine",
					orchestratorId: this.#orchestratorId,
					routineId: routine.routineId,
					expectedVersion: routine.version,
				},
				signal,
			),
		);
	}

	async listFolderMaterializationDue(
		afterProfileId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderMaterializationPage> {
		if (afterProfileId !== undefined) requiredUuid(afterProfileId, "Folder materialization cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Folder materialization page limit is outside the supported range");
		}
		const page = parseFolderMaterializationPage(
			await this.#request(
				{
					action: "folder_materialize_due",
					orchestratorId: this.#orchestratorId,
					...(afterProfileId ? { afterProfileId } : {}),
					limit,
				},
				signal,
			),
		);
		if (page.items.length > limit) throw new Error("Runner orchestrator returned more folder companies than asked");
		return page;
	}

	async materializeFolderCompany(
		profileId: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderMaterialization> {
		requiredUuid(profileId, "Company id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
			throw new Error("Folder materialization limit is outside the supported range");
		}
		return parseFolderMaterialization(
			await this.#request(
				{ action: "folder_materialize_company", orchestratorId: this.#orchestratorId, profileId, limit },
				signal,
			),
		);
	}

	async listFolderDrainDue(
		drain: string,
		afterEnvironmentId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderDrainPage> {
		folderDrainName(drain);
		if (afterEnvironmentId !== undefined) requiredUuid(afterEnvironmentId, "Folder drain cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Folder drain page limit is outside the supported range");
		}
		const page = parseFolderDrainPage(
			await this.#request(
				{
					action: "folder_drain_due",
					orchestratorId: this.#orchestratorId,
					drain,
					...(afterEnvironmentId ? { afterEnvironmentId } : {}),
					limit,
				},
				signal,
			),
		);
		if (page.items.length > limit)
			throw new Error("Runner orchestrator returned more folder drain companies than asked");
		return page;
	}

	async runFolderDrain(
		drain: string,
		environmentId: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudFolderDrainResult> {
		folderDrainName(drain);
		requiredUuid(environmentId, "Folder environment id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
			throw new Error("Folder drain limit is outside the supported range");
		}
		return parseFolderDrainResult(
			await this.#request(
				{ action: "folder_drain_company", orchestratorId: this.#orchestratorId, drain, environmentId, limit },
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
	): Promise<{ deferred: boolean }> {
		this.#assertIdentity(claim.orchestratorId);
		requiredUuid(clientAssignmentId, "Client assignment id");
		const failure = safeDeliveryFailure(error);
		const released = await this.#request(
			{
				action: "release_claim",
				orchestratorId: this.#orchestratorId,
				claimId: claim.claimId,
				clientAssignmentId,
				error: failure,
			},
			signal,
		);
		return { deferred: (released as { deferred?: unknown } | null)?.deferred === true };
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
