import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	isRecord,
	type JsonValue,
	SURFACE_AUTOMATION_OUTPUT_MODES,
	SURFACE_CHANGE_STATUSES,
	SURFACE_SESSION_STATES,
	SURFACE_SOURCE_KINDS,
	type SurfaceAutomationOutputMode,
	type SurfaceChangeStatus,
	type SurfacePreviewConflict,
	type SurfaceSessionQuestion,
	type SurfaceSessionState,
	type SurfaceSourceKind,
	UUID_ANY_CASE_PATTERN,
} from "@qorpera/contracts";
import type { ServiceHttpFetch } from "./http-transport.ts";
import { CloudRunnerProviderRequestError } from "./provider-http.ts";
import {
	parseRoutineCheckBeforeWake,
	type RoutineCheckBeforeWake,
	type RoutineCheckGateOptions,
	runRoutineCheckBeforeWake,
} from "./routine-check-gate.ts";
import type {
	ClaimedSurfaceApprovedChange,
	ClaimedSurfaceAutomationJob,
	ClaimedSurfaceChangeRange,
	ClaimedSurfaceCleanupJob,
	ClaimedSurfaceJobs,
	ClaimedSurfaceMergeJob,
	ClaimedSurfacePeerSession,
	ClaimedSurfacePreviewExploration,
	ClaimedSurfacePreviewJob,
	ClaimedSurfacePublishJob,
	ClaimedSurfaceSessionJob,
	ClaimedSurfaceSessionSponsor,
	SurfaceClaimLane,
	SurfaceMachinePlacementHint,
} from "./surface-worker-loop.ts";

export type CloudRunnerCapability = "agent_turn" | "git_worktree" | "company_substrate";
export type CloudComputeIdentityOwnershipKind = "member" | "company" | "department" | "security_boundary";

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

export interface CheckCloudRoutineWakeInput {
	readonly routineId: string;
	readonly expectedVersion: number;
	readonly triggerId: string;
	readonly scheduledFor: string;
	readonly expectedLastScheduledFor?: string;
	readonly nextDueAt: string;
	readonly healthy: boolean;
	readonly summary: string;
	readonly detail: string | null;
}

export interface CloudRoutineCheckWakeDecision {
	readonly status: "skipped" | "wake_required" | "stale";
	readonly shouldWake: boolean;
	readonly previousHealthy: boolean | null;
	readonly stateChanged: boolean;
	readonly consecutiveFailures: number;
}

export interface CloudRoutineCodeChecksResult {
	readonly ok: boolean;
	readonly summary: string;
	readonly detail: string | null;
}

export interface RenewSurfaceLeaseInput {
	readonly kind: "session" | "preview" | "job";
	readonly id: string;
	readonly leaseToken: string;
	readonly extendSeconds?: number;
}

export interface RenewSurfaceLeaseResult {
	readonly renewed: boolean;
	readonly leaseExpiresAt: string | null;
}

export interface ReleaseSurfaceSessionClaimInput {
	readonly sessionId: string;
	readonly leaseToken: string;
}

export interface ReleaseSurfaceSessionClaimResult {
	readonly sessionId: string;
	readonly released: boolean;
	readonly state: "queued" | "reconciling";
}

export interface EnqueueSurfaceSessionRunInput {
	readonly sessionId: string;
	readonly leaseToken: string;
}

export type EnqueueSurfaceSessionRunResult =
	| {
			readonly status: "enqueued";
			readonly wakeId: string | null;
			readonly runId: string | null;
			readonly workerId?: string | null;
	  }
	| { readonly status: "deferred"; readonly reason: string; readonly retryAfterSeconds: number }
	| { readonly status: "unavailable"; readonly reason: string };

export interface TriggerSurfaceAutomationResult {
	readonly status: "started" | "skipped";
	readonly reason?: string;
	readonly sessionId?: string | null;
}

export interface CompleteSurfacePreviewInput {
	readonly previewId: string;
	readonly status: "ready" | "conflicted" | "failed";
	readonly compositeTreeSha?: string | null;
	readonly siteVersionId?: string | null;
	readonly conflictReport?: SurfacePreviewConflict | Readonly<Record<string, unknown>> | null;
	readonly errorDetail?: string | null;
	readonly leaseToken?: string | null;
}

export interface CompleteSurfacePreviewResult {
	readonly previewId: string;
	readonly status: "ready" | "reconciling" | "conflicted" | "failed";
	readonly shortHostId: string;
	readonly compositeTreeSha: string | null;
}

export interface CompleteSurfaceSessionTurnInput {
	readonly sessionId: string;
	readonly state: "ready" | "needs_input" | "failed" | "completed";
	readonly replyText?: string | null;
	readonly question?: SurfaceSessionQuestion | Readonly<Record<string, unknown>> | null;
	readonly notePaths?: readonly string[] | null;
	readonly branchHeadSha?: string | null;
	readonly leaseToken?: string | null;
}

export interface CompleteSurfaceSessionTurnResult {
	readonly id: string;
	readonly state: SurfaceSessionState;
	readonly [key: string]: unknown;
}

export interface CompleteSurfaceMergeInput {
	readonly jobId: string;
	readonly status: "landed" | "conflicted" | "failed";
	readonly mainBefore?: string | null;
	readonly mainAfter?: string | null;
	readonly conflictChangeId?: string | null;
	readonly conflictPaths?: readonly string[] | null;
	readonly errorDetail?: string | null;
	readonly preMergeSnapshot?: Readonly<Record<string, unknown>> | null;
	readonly leaseToken?: string | null;
}

export interface CompleteSurfaceMergeResult {
	readonly jobId: string;
	readonly status: "landed" | "conflicted" | "failed";
}

export interface CompleteSurfacePublishInput {
	readonly jobId: string;
	readonly status: "published" | "failed";
	readonly publishedHeadSha?: string | null;
	readonly errorDetail?: string | null;
	readonly leaseToken?: string | null;
}

export interface CompleteSurfacePublishResult {
	readonly jobId: string;
	readonly status: "published" | "failed";
}

export interface CloudRunnerOrchestratorControlPlane {
	renewControl?(signal?: AbortSignal): Promise<void>;
	/** One answer for the lists of an idle pass (migration 20260930612000): spares a pass's list requests, nothing else. */
	readPassDue?(signal?: AbortSignal): Promise<Readonly<Record<string, boolean>>>;
	listRoutineScheduleHeads(
		afterRoutineId: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<CloudRoutineSchedulePage>;
	enqueueRoutineWake(input: EnqueueCloudRoutineWakeInput, signal?: AbortSignal): Promise<CloudRoutineWakeOccurrence>;
	advanceRoutineNextDue(input: AdvanceCloudRoutineNextDueInput, signal?: AbortSignal): Promise<CloudRoutineNextDue>;
	checkRoutineWake?(input: CheckCloudRoutineWakeInput, signal?: AbortSignal): Promise<CloudRoutineCheckWakeDecision>;
	readRoutineCodeChecks?(
		input: { readonly routineId: string; readonly repo?: string },
		signal?: AbortSignal,
	): Promise<CloudRoutineCodeChecksResult>;
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
	claimSurfaceJobs?(limit?: number, signal?: AbortSignal, lane?: SurfaceClaimLane): Promise<ClaimedSurfaceJobs>;
	resolveSharedProductFolderRoots?(profileId: string, signal?: AbortSignal): Promise<readonly string[]>;
	enqueueSurfaceSessionRun?(
		input: EnqueueSurfaceSessionRunInput,
		signal?: AbortSignal,
	): Promise<EnqueueSurfaceSessionRunResult>;
	triggerSurfaceAutomation?(automationId: string, signal?: AbortSignal): Promise<TriggerSurfaceAutomationResult>;
	renewSurfaceLease?(input: RenewSurfaceLeaseInput, signal?: AbortSignal): Promise<RenewSurfaceLeaseResult>;
	completeSurfacePreview?(
		input: CompleteSurfacePreviewInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfacePreviewResult>;
	completeSurfaceSessionTurn?(
		input: CompleteSurfaceSessionTurnInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfaceSessionTurnResult>;
	completeSurfaceMerge?(input: CompleteSurfaceMergeInput, signal?: AbortSignal): Promise<CompleteSurfaceMergeResult>;
	completeSurfacePublish?(
		input: CompleteSurfacePublishInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfacePublishResult>;
}

/** One pass's answer to "which lists have anything?": the drains by name, `materialize` and `routine_heads`. A list may
 * be left out only while the answer says false for it and nothing has run earlier in the pass, since a step that ran may
 * have made a later list due (the listener marks task changes, a drain admits wakes). A list it does not name is asked. */
export class CloudOrchestratorPassDue {
	readonly #answers: Readonly<Record<string, boolean>>;
	#worked = false;

	constructor(answers: Readonly<Record<string, boolean>>) {
		this.#answers = answers;
	}

	/** Nothing is due for this list, and nothing has run yet in this pass. */
	quiet(list: string): boolean {
		return !this.#worked && this.#answers[list] === false;
	}

	/** A step ran: every later list in this pass is asked. */
	worked(): void {
		this.#worked = true;
	}
}

export interface CloudRunnerOccurrenceReconciler {
	reconcile(
		controlPlane: CloudRunnerOrchestratorControlPlane,
		signal?: AbortSignal,
		due?: CloudOrchestratorPassDue,
	): Promise<void>;
}

export interface CloudRoutineScheduleReconcilerOptions {
	now?: () => Date;
	pageSize?: number;
	catchUpLimit?: number;
	/** How often the folder-v2 dynamic routines are listed (folder core C1c-3e); default 30 s. */
	folderDynamicIntervalMs?: number;
	concurrency?: number;
	checkGate?: Pick<RoutineCheckGateOptions, "fetch" | "lookup" | "allowLocalhost">;
}

export interface CloudFolderDrainsOptions {
	now?: () => Date;
	pageSize?: number;
	drains?: readonly CloudFolderDrainSpec[];
	concurrency?: number;
}

export interface CloudFolderRunMaterializerOptions {
	now?: () => Date;
	pageSize?: number;
	/** At most this many of one company's items per request (1 to 16; default 16). */
	companyLimit?: number;
	concurrency?: number;
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
 * loop still asks for work every backstop interval and reconciles every reconcile interval, and a wake-up only
 * brings a claim and a reconcile pass forward. */
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
	/** A wake-up also brings the next reconcile pass forward, since a wake occurrence (a member's room post, a
	 * coworker's message) or a conversation's next input becomes a job only in a pass. A pass it brings forward
	 * starts at least this long after the pass before it ended (default 500 ms), however many wake-ups arrive; while
	 * the pass summary call is failing, no sooner than `reconcileIntervalMs`. */
	wakePassGapMs?: number;
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
	| {
			action: "check_routine_wake";
			orchestratorId: string;
			routineId: string;
			expectedVersion: number;
			triggerId: string;
			scheduledFor: string;
			expectedLastScheduledFor?: string;
			nextDueAt: string;
			healthy: boolean;
			summary: string;
			detail: string | null;
	  }
	| {
			action: "read_routine_code_checks";
			orchestratorId: string;
			routineId: string;
			repo?: string;
	  }
	| { action: "folder_dynamic_routines"; orchestratorId: string; afterRoutineId?: string; limit: number }
	| { action: "restore_dynamic_routine"; orchestratorId: string; routineId: string; expectedVersion: number }
	| { action: "folder_materialize_due"; orchestratorId: string; afterProfileId?: string; limit: number }
	| { action: "folder_materialize_company"; orchestratorId: string; profileId: string; limit: number }
	| { action: "folder_drain_due"; orchestratorId: string; drain: string; afterEnvironmentId?: string; limit: number }
	| { action: "folder_drain_company"; orchestratorId: string; drain: string; environmentId: string; limit: number }
	| { action: "due_summary"; orchestratorId: string }
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
	  }
	| {
			action: "surface_claim_jobs";
			orchestratorId: string;
			limit: number;
			lane?: SurfaceClaimLane;
	  }
	| {
			action: "surface_shared_product_folder_roots";
			orchestratorId: string;
			profileId: string;
	  }
	| {
			action: "surface_enqueue_session_run";
			orchestratorId: string;
			sessionId: string;
			leaseToken: string;
	  }
	| {
			action: "surface_trigger_automation";
			orchestratorId: string;
			automationId: string;
	  }
	| {
			action: "surface_update_rebased_changes";
			orchestratorId: string;
			surfaceId: string;
			sessionId: string;
			branchHeadSha?: string;
			rebasedChanges?: readonly { changeId: string; parentSha: string; headSha: string }[];
			conflictedChangeId?: string;
			conflictPaths?: readonly string[];
	  }
	| {
			action: "surface_renew_lease";
			orchestratorId: string;
			kind: "session" | "preview" | "job";
			id: string;
			leaseToken: string;
			extendSeconds: number;
	  }
	| {
			action: "surface_release_session_claim";
			orchestratorId: string;
			sessionId: string;
			leaseToken: string;
	  }
	| {
			action: "surface_complete_preview";
			orchestratorId: string;
			previewId: string;
			status: "ready" | "conflicted" | "failed";
			compositeTreeSha?: string;
			siteVersionId?: string;
			conflictReport?: Record<string, unknown>;
			errorDetail?: string;
			leaseToken?: string;
	  }
	| {
			action: "surface_complete_session_turn";
			orchestratorId: string;
			sessionId: string;
			state: "ready" | "needs_input" | "failed" | "completed";
			replyText?: string;
			question?: Record<string, unknown>;
			notePaths?: readonly string[];
			branchHeadSha?: string;
			leaseToken?: string;
	  }
	| {
			action: "surface_complete_merge";
			orchestratorId: string;
			jobId: string;
			status: "landed" | "conflicted" | "failed";
			mainBefore?: string;
			mainAfter?: string;
			conflictChangeId?: string;
			conflictPaths?: readonly string[];
			errorDetail?: string;
			preMergeSnapshot?: Record<string, unknown>;
			leaseToken?: string;
	  }
	| {
			action: "surface_complete_publish";
			orchestratorId: string;
			jobId: string;
			status: "published" | "failed";
			publishedHeadSha?: string;
			errorDetail?: string;
			leaseToken?: string;
	  };

function requiredUuid(value: string, label: string): void {
	if (!UUID_ANY_CASE_PATTERN.test(value)) throw new Error(`${label} is invalid`);
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

function responseRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value;
}

function responseUuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_ANY_CASE_PATTERN.test(value)) {
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
	const input = responseRecord(value, "routine schedule head");
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
			const cursor = responseRecord(value, "routine schedule cursor");
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
	const input = responseRecord(value, "routine schedule page");
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
	const input = responseRecord(value, "routine wake occurrence");
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
	const input = responseRecord(value, "routine next due time");
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
	const input = responseRecord(value, "folder dynamic routine page");
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
			const item = responseRecord(value, "folder dynamic routine");
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
	const input = responseRecord(value, "folder dynamic routine run");
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
	const input = responseRecord(value, "folder drain page");
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
			responseUuid(responseRecord(item, "folder drain company").environment_id, "folder environment id"),
		),
		hasMore: input.has_more,
		...(nextAfterEnvironmentId ? { nextAfterEnvironmentId } : {}),
	};
}

function parseFolderDrainResult(value: unknown): CloudFolderDrainResult {
	const input = responseRecord(value, "folder drain result");
	if (typeof input.state !== "string" || !/^[a-z_]{1,32}$/.test(input.state)) {
		throw new Error("Runner orchestrator returned an invalid folder drain state");
	}
	return { state: input.state };
}

function parseFolderMaterializationPage(value: unknown): CloudFolderMaterializationPage {
	const input = responseRecord(value, "folder materialization page");
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
		items: input.items.map((value) =>
			responseUuid(responseRecord(value, "folder company").profile_id, "folder company id"),
		),
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
	const input = responseRecord(value, "folder materialization");
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
	const input = responseRecord(value, "execution sponsor");
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
	const input = responseRecord(value, "runner model policy");
	if (!Array.isArray(input.allowed_models) || input.allowed_models.length !== 1) {
		throw new Error("Runner orchestrator returned invalid model authority");
	}
	const allowed = responseRecord(input.allowed_models[0], "allowed runner model");
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
	const input = responseRecord(value, "runner work");
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
	const input = responseRecord(value, "orchestration claim");
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

const SURFACE_SESSION_STATE_SET: ReadonlySet<string> = new Set(SURFACE_SESSION_STATES);
const SURFACE_SESSION_COMPLETION_STATE_SET: ReadonlySet<string> = new Set([
	"ready",
	"needs_input",
	"failed",
	"completed",
]);
const SURFACE_CHANGE_STATUS_SET: ReadonlySet<string> = new Set(SURFACE_CHANGE_STATUSES);
const SURFACE_SOURCE_KIND_SET: ReadonlySet<string> = new Set(SURFACE_SOURCE_KINDS);
const SURFACE_AUTOMATION_OUTPUT_MODE_SET: ReadonlySet<string> = new Set(SURFACE_AUTOMATION_OUTPUT_MODES);

function optionalResponseString(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new Error(`Runner orchestrator returned invalid ${label}`);
	return value;
}

function validateSurfaceShortText(value: string, label: string, maxBytes: number): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		Buffer.byteLength(value, "utf-8") < 1 ||
		Buffer.byteLength(value, "utf-8") > maxBytes ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function validateSurfaceErrorDetail(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 1000 || trimmed.includes("\0")) {
		throw new Error(`${label} is invalid`);
	}
	return trimmed;
}

function validateSurfaceRecordPayload(
	value: Readonly<Record<string, unknown>>,
	label: string,
	maxBytes: number,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is invalid`);
	}
	const cloned = structuredClone(value) as Record<string, unknown>;
	if (Buffer.byteLength(JSON.stringify(cloned), "utf-8") > maxBytes) {
		throw new Error(`${label} exceeds its byte limit`);
	}
	return cloned;
}

function validateSurfaceStringList(
	values: readonly string[],
	label: string,
	maxItems: number,
	maxBytes: number,
): string[] {
	if (!Array.isArray(values) || values.length > maxItems) throw new Error(`${label} is invalid`);
	return values.map((item) => validateSurfaceShortText(item, label, maxBytes));
}

function parseSurfacePlacementHint(value: unknown): SurfaceMachinePlacementHint {
	const input = responseRecord(value, "surface placement hint");
	if (input.strategy !== "reuse_machine" && input.strategy !== "spawn_overflow_machine") {
		throw new Error("Runner orchestrator returned invalid surface placement strategy");
	}
	const machineId =
		input.machineId === null || input.machineId === undefined
			? null
			: responseUuid(input.machineId, "surface machine id");
	return {
		strategy: input.strategy,
		machineId,
		activeTurns: responseInteger(input.activeTurns, "surface active turns", 0, 100_000),
		targetDensity: responseInteger(input.targetDensity, "surface target density", 1, 10_000),
	};
}

function parseClaimedSurfaceSessionJob(value: unknown): ClaimedSurfaceSessionJob {
	const input = responseRecord(value, "claimed surface session");
	if (input.state !== "queued" && input.state !== "reconciling") {
		throw new Error("Runner orchestrator returned invalid claimed surface session state");
	}
	if (typeof input.prompt !== "string" || typeof input.originKind !== "string") {
		throw new Error("Runner orchestrator returned invalid claimed surface session");
	}
	const folderRoot =
		input.folderRoot === undefined ? undefined : optionalResponseString(input.folderRoot, "surface folder root");
	const surfaceSlug =
		input.surfaceSlug === undefined || input.surfaceSlug === null
			? undefined
			: responseText(input.surfaceSlug, "surface slug", 64);
	const surfaceTitle =
		input.surfaceTitle === undefined || input.surfaceTitle === null
			? undefined
			: (optionalResponseString(input.surfaceTitle, "surface title") ?? undefined);
	const surfaceArchetype =
		input.surfaceArchetype === undefined || input.surfaceArchetype === null
			? undefined
			: responseText(input.surfaceArchetype, "surface archetype", 32);
	let surfaceSourceKind: SurfaceSourceKind | undefined;
	if (input.surfaceSourceKind !== undefined && input.surfaceSourceKind !== null) {
		if (typeof input.surfaceSourceKind !== "string" || !SURFACE_SOURCE_KIND_SET.has(input.surfaceSourceKind)) {
			throw new Error("Runner orchestrator returned invalid surface source kind");
		}
		surfaceSourceKind = input.surfaceSourceKind as SurfaceSourceKind;
	}
	const surfaceKind =
		input.surfaceKind === undefined || input.surfaceKind === null
			? undefined
			: responseText(input.surfaceKind, "surface kind", 64);
	const explorationId =
		input.explorationId === undefined
			? undefined
			: input.explorationId === null
				? null
				: responseUuid(input.explorationId, "surface exploration id");
	const explorationVariantLabel =
		input.explorationVariantLabel === undefined
			? undefined
			: optionalResponseString(input.explorationVariantLabel, "surface exploration variant label");
	const siteSlug =
		input.siteSlug === undefined ? undefined : optionalResponseString(input.siteSlug, "surface site slug");
	const identityFolderRoot =
		input.identityFolderRoot === undefined
			? undefined
			: optionalResponseString(input.identityFolderRoot, "surface identity folder root");
	let productFolderRoots: string[] | undefined;
	if (input.productFolderRoots !== undefined && input.productFolderRoots !== null) {
		if (!Array.isArray(input.productFolderRoots) || input.productFolderRoots.length > 32) {
			throw new Error("Runner orchestrator returned invalid surface product folder roots");
		}
		productFolderRoots = input.productFolderRoots.map((item) =>
			responseText(item, "surface product folder root", 256),
		);
	}
	const briefSummary =
		input.briefSummary === undefined
			? undefined
			: optionalResponseString(input.briefSummary, "surface brief summary");
	const retryCount =
		input.retryCount === undefined || input.retryCount === null
			? undefined
			: responseInteger(input.retryCount, "surface session retry count", 0, 10_000);
	let sponsor: ClaimedSurfaceSessionSponsor | null | undefined;
	if (input.sponsor !== undefined) {
		if (input.sponsor === null) {
			sponsor = null;
		} else {
			const rawSponsor = responseRecord(input.sponsor, "surface session sponsor");
			sponsor = {
				sponsorBindingId: responseUuid(rawSponsor.sponsorBindingId, "surface sponsor binding id"),
				sponsorVersion: responseInteger(rawSponsor.sponsorVersion, "surface sponsor version", 1, 1_000_000),
			};
		}
	}
	const leaseToken =
		input.leaseToken === undefined
			? undefined
			: input.leaseToken === null
				? null
				: responseUuid(input.leaseToken, "surface session lease token");
	return {
		sessionId: responseUuid(input.sessionId, "surface session id"),
		surfaceId: responseUuid(input.surfaceId, "surface id"),
		profileId: responseUuid(input.profileId, "surface profile id"),
		state: input.state,
		prompt: input.prompt,
		originKind: input.originKind,
		originRef: input.originRef ?? null,
		repositoryKey: optionalResponseString(input.repositoryKey, "surface repository key"),
		...(folderRoot !== undefined ? { folderRoot } : {}),
		...(surfaceSlug !== undefined ? { surfaceSlug } : {}),
		...(surfaceTitle !== undefined ? { surfaceTitle } : {}),
		...(surfaceArchetype !== undefined ? { surfaceArchetype } : {}),
		...(surfaceSourceKind !== undefined ? { surfaceSourceKind } : {}),
		...(surfaceKind !== undefined ? { surfaceKind } : {}),
		...(explorationId !== undefined ? { explorationId } : {}),
		...(explorationVariantLabel !== undefined ? { explorationVariantLabel } : {}),
		...(siteSlug !== undefined ? { siteSlug } : {}),
		...(identityFolderRoot !== undefined ? { identityFolderRoot } : {}),
		...(productFolderRoots !== undefined ? { productFolderRoots } : {}),
		...(briefSummary !== undefined ? { briefSummary } : {}),
		...(retryCount !== undefined ? { retryCount } : {}),
		...(sponsor !== undefined ? { sponsor } : {}),
		...(leaseToken !== undefined ? { leaseToken } : {}),
		placement: parseSurfacePlacementHint(input.placement),
	};
}

function parseClaimedSurfaceChangeRange(value: unknown, label: string): ClaimedSurfaceChangeRange {
	const input = responseRecord(value, label);
	if (typeof input.title !== "string") {
		throw new Error(`Runner orchestrator returned invalid ${label} title`);
	}
	const optionGroupKey =
		input.optionGroupKey === undefined
			? undefined
			: optionalResponseString(input.optionGroupKey, `${label} option group key`);
	return {
		changeId: responseUuid(input.changeId, `${label} change id`),
		parentSha: responseText(input.parentSha, `${label} parent sha`, 64),
		headSha: responseText(input.headSha, `${label} head sha`, 64),
		title: input.title,
		...(optionGroupKey !== undefined ? { optionGroupKey } : {}),
	};
}

function parseClaimedSurfacePreviewExploration(value: unknown): ClaimedSurfacePreviewExploration {
	const input = responseRecord(value, "surface preview exploration");
	return {
		sessionId: responseUuid(input.sessionId, "surface exploration session id"),
		baseSha: responseText(input.baseSha, "surface exploration base sha", 64),
		headSha: responseText(input.headSha, "surface exploration head sha", 64),
	};
}

function parseClaimedSurfacePreviewJob(value: unknown): ClaimedSurfacePreviewJob {
	const input = responseRecord(value, "claimed surface preview");
	if (!Array.isArray(input.selectedChangeIds)) {
		throw new Error("Runner orchestrator returned invalid preview change ids");
	}
	const exploration =
		input.exploration === undefined
			? undefined
			: input.exploration === null
				? null
				: parseClaimedSurfacePreviewExploration(input.exploration);
	let changes: ClaimedSurfaceChangeRange[] | undefined;
	if (input.changes !== undefined) {
		if (!Array.isArray(input.changes)) {
			throw new Error("Runner orchestrator returned invalid preview changes");
		}
		changes = input.changes.map((item) => parseClaimedSurfaceChangeRange(item, "preview change"));
	}
	const leaseToken =
		input.leaseToken === undefined
			? undefined
			: input.leaseToken === null
				? null
				: responseUuid(input.leaseToken, "surface preview lease token");
	const environmentId =
		input.environmentId === undefined
			? undefined
			: input.environmentId === null
				? null
				: responseUuid(input.environmentId, "surface preview environment id");
	const reconciledCommitSha =
		input.reconciledCommitSha === undefined
			? undefined
			: optionalResponseString(input.reconciledCommitSha, "surface preview reconciled commit sha");
	return {
		previewId: responseUuid(input.previewId, "surface preview id"),
		surfaceId: responseUuid(input.surfaceId, "surface id"),
		profileId: responseUuid(input.profileId, "surface profile id"),
		...(environmentId !== undefined ? { environmentId } : {}),
		shortHostId: responseText(input.shortHostId, "surface preview host id", 64),
		baseSha: responseText(input.baseSha, "surface preview base sha", 64),
		selectedChangeIds: input.selectedChangeIds.map((id) => responseUuid(id, "surface change id")),
		repositoryKey: optionalResponseString(input.repositoryKey, "surface repository key"),
		...(leaseToken !== undefined ? { leaseToken } : {}),
		...(reconciledCommitSha !== undefined ? { reconciledCommitSha } : {}),
		...(exploration !== undefined ? { exploration } : {}),
		...(changes !== undefined ? { changes } : {}),
	};
}

function parseOptionalBaseFiles(value: unknown): Readonly<Record<string, string | null>> | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Runner orchestrator returned invalid approved change baseFiles");
	}
	const out: Record<string, string | null> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (!key.trim()) continue;
		if (item !== null && typeof item !== "string") {
			throw new Error("Runner orchestrator returned invalid approved change baseFiles entry");
		}
		out[key] = item;
	}
	return out;
}

function parseClaimedSurfaceApprovedChange(value: unknown): ClaimedSurfaceApprovedChange {
	const input = responseRecord(value, "approved surface change");
	if (
		typeof input.kind !== "string" ||
		typeof input.title !== "string" ||
		typeof input.summary !== "string" ||
		!Array.isArray(input.affectedPaths) ||
		!input.affectedPaths.every((item) => typeof item === "string")
	) {
		throw new Error("Runner orchestrator returned invalid approved surface change");
	}
	const baseFiles = parseOptionalBaseFiles(input.baseFiles);
	return {
		changeId: responseUuid(input.changeId, "approved change id"),
		kind: input.kind,
		parentSha: optionalResponseString(input.parentSha, "approved change parent sha"),
		headSha: optionalResponseString(input.headSha, "approved change head sha"),
		title: input.title,
		summary: input.summary,
		patchManifest: input.patchManifest === undefined ? null : structuredClone(input.patchManifest),
		...(baseFiles !== undefined ? { baseFiles } : {}),
		affectedPaths: [...(input.affectedPaths as string[])],
	};
}

function parseOptionalShaList(value: unknown, label: string): readonly string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length > 64) {
		throw new Error(`Runner orchestrator returned invalid ${label}`);
	}
	return value.map((item) => responseText(item, label, 64));
}

function parseClaimedSurfacePeerSession(value: unknown): ClaimedSurfacePeerSession {
	const input = responseRecord(value, "surface peer session");
	if (!Array.isArray(input.remainingChanges)) {
		throw new Error("Runner orchestrator returned invalid surface peer session changes");
	}
	const recordedChangeHeadShas = parseOptionalShaList(
		input.recordedChangeHeadShas,
		"surface peer recorded change head shas",
	);
	return {
		sessionId: responseUuid(input.sessionId, "surface peer session id"),
		workerId: responseUuid(input.workerId, "surface peer worker id"),
		...(recordedChangeHeadShas !== undefined ? { recordedChangeHeadShas } : {}),
		remainingChanges: input.remainingChanges.map((item) => parseClaimedSurfaceChangeRange(item, "peer change")),
	};
}

function parseClaimedSurfaceMergeJob(value: unknown): ClaimedSurfaceMergeJob {
	const input = responseRecord(value, "claimed surface merge");
	if (input.kind !== "land_change" && input.kind !== "undo_change") {
		throw new Error("Runner orchestrator returned invalid surface merge kind");
	}
	const sessionId =
		input.sessionId === null || input.sessionId === undefined
			? null
			: responseUuid(input.sessionId, "surface merge session id");
	const payload =
		input.payload === null || input.payload === undefined
			? {}
			: (structuredClone(responseRecord(input.payload, "surface merge payload")) as Record<string, unknown>);
	let sourceKind: SurfaceSourceKind | undefined;
	if (input.sourceKind !== undefined && input.sourceKind !== null) {
		if (typeof input.sourceKind !== "string" || !SURFACE_SOURCE_KIND_SET.has(input.sourceKind)) {
			throw new Error("Runner orchestrator returned invalid surface source kind");
		}
		sourceKind = input.sourceKind as SurfaceSourceKind;
	}
	let autoPublish: boolean | undefined;
	if (input.autoPublish !== undefined) {
		if (typeof input.autoPublish !== "boolean") {
			throw new Error("Runner orchestrator returned invalid surface autoPublish flag");
		}
		autoPublish = input.autoPublish;
	}
	const expectMainSha =
		input.expectMainSha === undefined ? undefined : optionalResponseString(input.expectMainSha, "surface main sha");
	const sessionWorkerId =
		input.sessionWorkerId === undefined
			? undefined
			: input.sessionWorkerId === null
				? null
				: responseUuid(input.sessionWorkerId, "surface session worker id");
	const sessionBranchHeadSha =
		input.sessionBranchHeadSha === undefined
			? undefined
			: optionalResponseString(input.sessionBranchHeadSha, "surface session branch head sha");
	const sessionRecordedChangeHeadShas = parseOptionalShaList(
		input.sessionRecordedChangeHeadShas,
		"surface session recorded change head shas",
	);
	let sessionState: SurfaceSessionState | null | undefined;
	if (input.sessionState !== undefined) {
		if (input.sessionState === null) {
			sessionState = null;
		} else if (typeof input.sessionState === "string" && SURFACE_SESSION_STATE_SET.has(input.sessionState)) {
			sessionState = input.sessionState as SurfaceSessionState;
		} else {
			throw new Error("Runner orchestrator returned invalid surface session state");
		}
	}
	let sessionHasActiveChat: boolean | undefined;
	if (input.sessionHasActiveChat !== undefined) {
		if (typeof input.sessionHasActiveChat !== "boolean") {
			throw new Error("Runner orchestrator returned invalid surface session chat flag");
		}
		sessionHasActiveChat = input.sessionHasActiveChat;
	}
	let allSessionChangeStatuses: { readonly changeId: string; readonly status: SurfaceChangeStatus }[] | undefined;
	if (input.allSessionChangeStatuses !== undefined) {
		if (!Array.isArray(input.allSessionChangeStatuses)) {
			throw new Error("Runner orchestrator returned invalid session change statuses");
		}
		allSessionChangeStatuses = input.allSessionChangeStatuses.map((item) => {
			const entry = responseRecord(item, "session change status");
			if (typeof entry.status !== "string" || !SURFACE_CHANGE_STATUS_SET.has(entry.status)) {
				throw new Error("Runner orchestrator returned invalid session change status");
			}
			return {
				changeId: responseUuid(entry.changeId, "session change id"),
				status: entry.status as SurfaceChangeStatus,
			};
		});
	}
	let approvedChanges: ClaimedSurfaceApprovedChange[] | undefined;
	if (input.approvedChanges !== undefined) {
		if (!Array.isArray(input.approvedChanges)) {
			throw new Error("Runner orchestrator returned invalid approved changes");
		}
		approvedChanges = input.approvedChanges.map(parseClaimedSurfaceApprovedChange);
	}
	let siblingRemainingChanges: ClaimedSurfaceChangeRange[] | undefined;
	if (input.siblingRemainingChanges !== undefined) {
		if (!Array.isArray(input.siblingRemainingChanges)) {
			throw new Error("Runner orchestrator returned invalid sibling changes");
		}
		siblingRemainingChanges = input.siblingRemainingChanges.map((item) =>
			parseClaimedSurfaceChangeRange(item, "sibling change"),
		);
	}
	let peerSessions: ClaimedSurfacePeerSession[] | undefined;
	if (input.peerSessions !== undefined) {
		if (!Array.isArray(input.peerSessions)) {
			throw new Error("Runner orchestrator returned invalid peer sessions");
		}
		peerSessions = input.peerSessions.map(parseClaimedSurfacePeerSession);
	}
	const leaseToken =
		input.leaseToken === undefined
			? undefined
			: input.leaseToken === null
				? null
				: responseUuid(input.leaseToken, "surface merge lease token");
	const preMergeSnapshot =
		input.preMergeSnapshot === undefined
			? undefined
			: input.preMergeSnapshot === null
				? null
				: (structuredClone(responseRecord(input.preMergeSnapshot, "surface merge pre-merge snapshot")) as Record<
						string,
						unknown
					>);
	const environmentId =
		input.environmentId === undefined
			? undefined
			: input.environmentId === null
				? null
				: responseUuid(input.environmentId, "surface merge environment id");
	const reconciledCommitSha =
		input.reconciledCommitSha === undefined
			? undefined
			: optionalResponseString(input.reconciledCommitSha, "surface merge reconciled commit sha");
	const reconciledPatchManifest =
		input.reconciledPatchManifest === undefined ? undefined : structuredClone(input.reconciledPatchManifest);
	const reconciledConflictPaths =
		input.reconciledConflictPaths === undefined
			? undefined
			: input.reconciledConflictPaths === null
				? null
				: Array.isArray(input.reconciledConflictPaths)
					? input.reconciledConflictPaths.filter((p): p is string => typeof p === "string")
					: undefined;
	return {
		jobId: responseUuid(input.jobId, "surface merge job id"),
		kind: input.kind,
		surfaceId: responseUuid(input.surfaceId, "surface id"),
		sessionId,
		profileId: responseUuid(input.profileId, "surface profile id"),
		...(environmentId !== undefined ? { environmentId } : {}),
		...(leaseToken !== undefined ? { leaseToken } : {}),
		...(sourceKind !== undefined ? { sourceKind } : {}),
		repositoryKey: optionalResponseString(input.repositoryKey, "surface repository key"),
		folderRoot: optionalResponseString(input.folderRoot, "surface folder root"),
		...(autoPublish !== undefined ? { autoPublish } : {}),
		...(expectMainSha !== undefined ? { expectMainSha } : {}),
		...(sessionWorkerId !== undefined ? { sessionWorkerId } : {}),
		...(sessionBranchHeadSha !== undefined ? { sessionBranchHeadSha } : {}),
		...(sessionRecordedChangeHeadShas !== undefined ? { sessionRecordedChangeHeadShas } : {}),
		...(sessionState !== undefined ? { sessionState } : {}),
		...(sessionHasActiveChat !== undefined ? { sessionHasActiveChat } : {}),
		payload,
		...(preMergeSnapshot !== undefined ? { preMergeSnapshot } : {}),
		...(reconciledPatchManifest !== undefined ? { reconciledPatchManifest } : {}),
		...(reconciledConflictPaths !== undefined ? { reconciledConflictPaths } : {}),
		...(reconciledCommitSha !== undefined ? { reconciledCommitSha } : {}),
		...(allSessionChangeStatuses !== undefined ? { allSessionChangeStatuses } : {}),
		...(approvedChanges !== undefined ? { approvedChanges } : {}),
		...(siblingRemainingChanges !== undefined ? { siblingRemainingChanges } : {}),
		...(peerSessions !== undefined ? { peerSessions } : {}),
	};
}

function parseClaimedSurfacePublishJob(value: unknown): ClaimedSurfacePublishJob {
	const input = responseRecord(value, "claimed surface publish");
	const siteId =
		input.siteId === null || input.siteId === undefined ? null : responseUuid(input.siteId, "surface site id");
	const payload =
		input.payload === null || input.payload === undefined
			? {}
			: (structuredClone(responseRecord(input.payload, "surface publish payload")) as Record<string, unknown>);
	const leaseToken =
		input.leaseToken === undefined
			? undefined
			: input.leaseToken === null
				? null
				: responseUuid(input.leaseToken, "surface publish lease token");
	const environmentId =
		input.environmentId === undefined
			? undefined
			: input.environmentId === null
				? null
				: responseUuid(input.environmentId, "surface publish environment id");
	let sourceKind: SurfaceSourceKind | undefined;
	if (input.sourceKind !== undefined && input.sourceKind !== null) {
		if (typeof input.sourceKind !== "string" || !SURFACE_SOURCE_KIND_SET.has(input.sourceKind)) {
			throw new Error("Runner orchestrator returned invalid surface source kind");
		}
		sourceKind = input.sourceKind as SurfaceSourceKind;
	}
	const liveHeadSha =
		input.liveHeadSha === undefined ? undefined : optionalResponseString(input.liveHeadSha, "surface live head sha");
	return {
		jobId: responseUuid(input.jobId, "surface publish job id"),
		surfaceId: responseUuid(input.surfaceId, "surface id"),
		profileId: responseUuid(input.profileId, "surface profile id"),
		...(environmentId !== undefined ? { environmentId } : {}),
		...(sourceKind !== undefined ? { sourceKind } : {}),
		...(liveHeadSha !== undefined ? { liveHeadSha } : {}),
		...(leaseToken !== undefined ? { leaseToken } : {}),
		repositoryKey: optionalResponseString(input.repositoryKey, "surface repository key"),
		siteId,
		payload,
	};
}

function parseClaimedSurfaceAutomationJob(value: unknown): ClaimedSurfaceAutomationJob {
	const input = responseRecord(value, "claimed surface automation");
	if (typeof input.title !== "string" || typeof input.prompt !== "string") {
		throw new Error("Runner orchestrator returned invalid claimed surface automation");
	}
	if (typeof input.outputMode !== "string" || !SURFACE_AUTOMATION_OUTPUT_MODE_SET.has(input.outputMode)) {
		throw new Error("Runner orchestrator returned invalid surface automation output mode");
	}
	const sessionId =
		input.sessionId === null || input.sessionId === undefined
			? null
			: responseUuid(input.sessionId, "surface automation session id");
	const surfaceId =
		input.surfaceId === null || input.surfaceId === undefined
			? null
			: responseUuid(input.surfaceId, "surface automation surface id");
	return {
		automationId: responseUuid(input.automationId, "surface automation id"),
		profileId: responseUuid(input.profileId, "surface automation profile id"),
		key: responseText(input.key, "surface automation key", 80),
		title: input.title,
		prompt: input.prompt,
		targetSurfaceSlug: optionalResponseString(input.targetSurfaceSlug, "surface automation target slug"),
		outputMode: input.outputMode as SurfaceAutomationOutputMode,
		sessionId,
		surfaceId,
	};
}

function parseClaimedSurfaceCleanupJob(value: unknown): ClaimedSurfaceCleanupJob {
	const input = responseRecord(value, "claimed surface cleanup");
	const sessionId =
		input.sessionId === null || input.sessionId === undefined
			? null
			: responseUuid(input.sessionId, "surface cleanup session id");
	const leaseToken =
		input.leaseToken === undefined
			? undefined
			: input.leaseToken === null
				? null
				: responseUuid(input.leaseToken, "surface cleanup lease token");
	const environmentId =
		input.environmentId === undefined
			? undefined
			: input.environmentId === null
				? null
				: responseUuid(input.environmentId, "surface cleanup environment id");
	let sourceKind: SurfaceSourceKind | undefined;
	if (input.sourceKind !== undefined && input.sourceKind !== null) {
		if (typeof input.sourceKind !== "string" || !SURFACE_SOURCE_KIND_SET.has(input.sourceKind)) {
			throw new Error("Runner orchestrator returned invalid surface source kind");
		}
		sourceKind = input.sourceKind as SurfaceSourceKind;
	}
	return {
		jobId: responseUuid(input.jobId, "surface cleanup job id"),
		surfaceId: responseUuid(input.surfaceId, "surface id"),
		sessionId,
		profileId: responseUuid(input.profileId, "surface profile id"),
		...(environmentId !== undefined ? { environmentId } : {}),
		...(sourceKind !== undefined ? { sourceKind } : {}),
		...(leaseToken !== undefined ? { leaseToken } : {}),
		repositoryKey: optionalResponseString(input.repositoryKey, "surface repository key"),
		workerId: responseUuid(input.workerId, "surface cleanup worker id"),
	};
}

export function parseClaimedSurfaceJobs(value: unknown): ClaimedSurfaceJobs {
	const input = responseRecord(value, "claimed surface jobs");
	if (!Array.isArray(input.sessions) || !Array.isArray(input.previews)) {
		throw new Error("Runner orchestrator returned invalid claimed surface jobs");
	}
	const rawMerges = input.merges === undefined || input.merges === null ? [] : input.merges;
	const rawPublishes = input.publishes === undefined || input.publishes === null ? [] : input.publishes;
	const rawCleanups = input.cleanups === undefined || input.cleanups === null ? [] : input.cleanups;
	const rawAutomations = input.automations === undefined || input.automations === null ? [] : input.automations;
	if (
		!Array.isArray(rawMerges) ||
		!Array.isArray(rawPublishes) ||
		!Array.isArray(rawCleanups) ||
		!Array.isArray(rawAutomations)
	) {
		throw new Error("Runner orchestrator returned invalid claimed surface jobs");
	}
	return {
		sessions: input.sessions.map(parseClaimedSurfaceSessionJob),
		previews: input.previews.map(parseClaimedSurfacePreviewJob),
		merges: rawMerges.map(parseClaimedSurfaceMergeJob),
		publishes: rawPublishes.map(parseClaimedSurfacePublishJob),
		cleanups: rawCleanups.map(parseClaimedSurfaceCleanupJob),
		automations: rawAutomations.map(parseClaimedSurfaceAutomationJob),
	};
}

function parseRenewSurfaceLeaseResult(value: unknown): RenewSurfaceLeaseResult {
	const input = responseRecord(value, "surface lease renewal");
	if (typeof input.renewed !== "boolean") {
		throw new Error("Runner orchestrator returned invalid surface lease renewal flag");
	}
	const leaseExpiresAt =
		input.leaseExpiresAt === null || input.leaseExpiresAt === undefined
			? null
			: responseTimestamp(input.leaseExpiresAt, "surface lease expiry");
	return { renewed: input.renewed, leaseExpiresAt };
}

function parseReleaseSurfaceSessionClaimResult(value: unknown): ReleaseSurfaceSessionClaimResult {
	const input = responseRecord(value, "surface session claim release");
	const sessionId = responseUuid(input.sessionId, "surface session id");
	if (typeof input.released !== "boolean") {
		throw new Error("Runner orchestrator returned invalid surface session release flag");
	}
	if (input.state !== "queued" && input.state !== "reconciling") {
		throw new Error("Runner orchestrator returned invalid surface session release state");
	}
	return { sessionId, released: input.released, state: input.state };
}

function parseCompleteSurfacePreviewResult(value: unknown): CompleteSurfacePreviewResult {
	const input = responseRecord(value, "surface preview completion");
	if (
		input.status !== "ready" &&
		input.status !== "reconciling" &&
		input.status !== "conflicted" &&
		input.status !== "failed"
	) {
		throw new Error("Runner orchestrator returned invalid surface preview status");
	}
	const compositeTreeSha =
		input.compositeTreeSha === null || input.compositeTreeSha === undefined
			? null
			: responseText(input.compositeTreeSha, "composite tree sha", 64);
	return {
		previewId: responseUuid(input.previewId, "surface preview id"),
		status: input.status,
		shortHostId: responseText(input.shortHostId, "surface preview host id", 64),
		compositeTreeSha,
	};
}

function parseCompleteSurfaceSessionTurnResult(value: unknown): CompleteSurfaceSessionTurnResult {
	const input = responseRecord(value, "surface session completion");
	if (typeof input.state !== "string" || !SURFACE_SESSION_STATE_SET.has(input.state)) {
		throw new Error("Runner orchestrator returned invalid surface session state");
	}
	return {
		...(structuredClone(input) as Record<string, unknown>),
		id: responseUuid(input.id, "surface session id"),
		state: input.state as SurfaceSessionState,
	};
}

function parseCompleteSurfaceMergeResult(value: unknown): CompleteSurfaceMergeResult {
	const input = responseRecord(value, "surface merge completion");
	if (input.status !== "landed" && input.status !== "conflicted" && input.status !== "failed") {
		throw new Error("Runner orchestrator returned invalid surface merge status");
	}
	return {
		jobId: responseUuid(input.jobId, "surface merge job id"),
		status: input.status,
	};
}

function parseCompleteSurfacePublishResult(value: unknown): CompleteSurfacePublishResult {
	const input = responseRecord(value, "surface publish completion");
	if (input.status !== "published" && input.status !== "failed") {
		throw new Error("Runner orchestrator returned invalid surface publish status");
	}
	return {
		jobId: responseUuid(input.jobId, "surface publish job id"),
		status: input.status,
	};
}

type RoutineScheduleTrigger =
	| {
			id: string;
			kind: "schedule";
			intervalMinutes: number;
			startAt?: string;
			checkBeforeWake?: RoutineCheckBeforeWake;
	  }
	| {
			id: string;
			kind: "schedule";
			intervalMinutes: number;
			startAt?: string;
			weekdays: readonly string[];
			localTime: string;
			timeZone: string;
			checkBeforeWake?: RoutineCheckBeforeWake;
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
			checkBeforeWake?: RoutineCheckBeforeWake;
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
	const hasCheckBeforeWake = Object.hasOwn(input, "checkBeforeWake");
	const checkBeforeWake = hasCheckBeforeWake ? parseRoutineCheckBeforeWake(input.checkBeforeWake) : undefined;
	if (hasCheckBeforeWake && checkBeforeWake === undefined) {
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
						"checkBeforeWake",
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
			calendarFormatter(input.timeZone);
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
			...(checkBeforeWake ? { checkBeforeWake } : {}),
		};
	}
	if (input.weekdays === undefined && input.localTime === undefined && input.timeZone === undefined) {
		if (
			Object.keys(input).some(
				(key) => !["id", "kind", "intervalMinutes", "startAt", "replyPolicy", "checkBeforeWake"].includes(key),
			) ||
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
			...(checkBeforeWake ? { checkBeforeWake } : {}),
		};
	}
	if (
		Object.keys(input).some(
			(key) =>
				![
					"id",
					"kind",
					"intervalMinutes",
					"startAt",
					"weekdays",
					"localTime",
					"timeZone",
					"replyPolicy",
					"checkBeforeWake",
				].includes(key),
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
		calendarFormatter(input.timeZone);
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
		...(checkBeforeWake ? { checkBeforeWake } : {}),
	};
}

const MAX_TIMEZONE_FORMATTERS = 512;
const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = calendarFormatters.get(timeZone);
	if (formatter) return formatter;
	formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	if (calendarFormatters.size >= MAX_TIMEZONE_FORMATTERS) {
		const oldest = calendarFormatters.keys().next().value;
		if (oldest !== undefined) calendarFormatters.delete(oldest);
	}
	calendarFormatters.set(timeZone, formatter);
	return formatter;
}

function calendarParts(
	instant: Date,
	timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
	let year = Number.NaN;
	let month = Number.NaN;
	let day = Number.NaN;
	let hour = Number.NaN;
	let minute = Number.NaN;
	for (const part of calendarFormatter(timeZone).formatToParts(instant)) {
		if (part.type === "year") year = Number(part.value);
		else if (part.type === "month") month = Number(part.value);
		else if (part.type === "day") day = Number(part.value);
		else if (part.type === "hour") hour = Number(part.value);
		else if (part.type === "minute") minute = Number(part.value);
	}
	return { year, month, day, hour, minute };
}

function utcOffsetMs(epochMs: number, timeZone: string): number {
	const actual = calendarParts(new Date(epochMs), timeZone);
	return Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute) - epochMs;
}

function constantDayOffsetMs(year: number, month: number, day: number, timeZone: string): number | undefined {
	const dayStartUtc = Date.UTC(year, month - 1, day, 0, 0);
	const dayEndUtc = Date.UTC(year, month - 1, day, 23, 59);
	const before = utcOffsetMs(dayStartUtc - 15 * 3_600_000, timeZone);
	const mid = utcOffsetMs(dayStartUtc + 12 * 3_600_000, timeZone);
	if (mid !== before) return undefined;
	const after = utcOffsetMs(dayEndUtc + 15 * 3_600_000, timeZone);
	return after === before ? before : undefined;
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
	const start = Number(trigger.windowStart.slice(0, 2)) * 60 + Number(trigger.windowStart.slice(3));
	const end = Number(trigger.windowEnd.slice(0, 2)) * 60 + Number(trigger.windowEnd.slice(3));
	const step = trigger.intervalMinutes;
	const instantMs = instant.getTime();
	for (let distance = 0; distance <= 370; distance += 1) {
		const shifted = new Date(
			Date.UTC(local.year, local.month - 1, local.day + (direction === "before-or-at" ? -distance : distance)),
		);
		const year = shifted.getUTCFullYear();
		const month = shifted.getUTCMonth() + 1;
		const day = shifted.getUTCDate();
		if (!advancedCalendarDateMatches(trigger, year, month, day)) continue;
		const offset = constantDayOffsetMs(year, month, day, trigger.timeZone);
		if (offset !== undefined) {
			const dayStartUtc = Date.UTC(year, month - 1, day, 0, 0);
			const diffMs = instantMs + offset - dayStartUtc;
			let slotMin = -1;
			if (direction === "before-or-at") {
				const maxMin = Math.min(end, Math.floor(diffMs / 60_000));
				if (maxMin >= start) slotMin = start + Math.floor((maxMin - start) / step) * step;
			} else {
				const minMin = Math.max(start, Math.floor(diffMs / 60_000) + 1);
				if (minMin <= end) {
					const candidateMin = start + Math.ceil((minMin - start) / step) * step;
					if (candidateMin <= end) slotMin = candidateMin;
				}
			}
			if (slotMin < 0) continue;
			const candidate = new Date(dayStartUtc + slotMin * 60_000 - offset);
			const actual = calendarParts(candidate, trigger.timeZone);
			if (
				actual.year === year &&
				actual.month === month &&
				actual.day === day &&
				actual.hour === Math.floor(slotMin / 60) &&
				actual.minute === slotMin % 60 &&
				(direction === "before-or-at" ? candidate.getTime() <= instantMs : candidate.getTime() > instantMs)
			) {
				return candidate;
			}
		}
		const occurrences = advancedCalendarOccurrences(trigger, year, month, day);
		if (direction === "before-or-at") {
			for (let index = occurrences.length - 1; index >= 0; index -= 1) {
				const occurrence = occurrences[index];
				if (occurrence && occurrence.getTime() <= instantMs) return occurrence;
			}
		} else {
			for (const occurrence of occurrences) {
				if (occurrence.getTime() > instantMs) return occurrence;
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

function countAdvancedOccurrencesBetween(
	trigger: Extract<RoutineScheduleTrigger, { windowStart: string }>,
	afterMs: number,
	untilMs: number,
): number {
	if (untilMs <= afterMs) return 0;
	const startLocal = calendarParts(new Date(afterMs), trigger.timeZone);
	const endLocal = calendarParts(new Date(untilMs), trigger.timeZone);
	const startDayUtc = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day);
	const endDayUtc = Date.UTC(endLocal.year, endLocal.month - 1, endLocal.day);
	const startMin = Number(trigger.windowStart.slice(0, 2)) * 60 + Number(trigger.windowStart.slice(3));
	const endMin = Number(trigger.windowEnd.slice(0, 2)) * 60 + Number(trigger.windowEnd.slice(3));
	const step = trigger.intervalMinutes;
	const stepMs = step * 60_000;
	const slotsPerFullDay = Math.floor((endMin - startMin) / step) + 1;
	const dayMs = 86_400_000;
	let count = 0;
	for (let dayUtc = startDayUtc - dayMs; dayUtc <= endDayUtc + dayMs; dayUtc += dayMs) {
		const shifted = new Date(dayUtc);
		const year = shifted.getUTCFullYear();
		const month = shifted.getUTCMonth() + 1;
		const day = shifted.getUTCDate();
		if (!advancedCalendarDateMatches(trigger, year, month, day)) continue;
		const offset = constantDayOffsetMs(year, month, day, trigger.timeZone);
		if (offset !== undefined) {
			if (dayUtc > startDayUtc + dayMs && dayUtc < endDayUtc - dayMs) {
				count += slotsPerFullDay;
				continue;
			}
			const firstSlotUtc = dayUtc + startMin * 60_000 - offset;
			const kMin = Math.max(0, Math.floor((afterMs - firstSlotUtc) / stepMs) + 1);
			const kMax = Math.min(slotsPerFullDay - 1, Math.floor((untilMs - firstSlotUtc) / stepMs));
			if (kMax >= kMin) count += kMax - kMin + 1;
			continue;
		}
		for (const occurrence of advancedCalendarOccurrences(trigger, year, month, day)) {
			const ts = occurrence.getTime();
			if (ts > afterMs && ts <= untilMs) count += 1;
		}
	}
	return count;
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
	if (!("windowStart" in trigger) && !("localTime" in trigger)) {
		const intervalMs = trigger.intervalMinutes * 60_000;
		const anchor = trigger.startAt ? Date.parse(trigger.startAt) : 0;
		const firstSlot = Math.max(0, Math.floor((lastScheduledFor.getTime() - anchor) / intervalMs) + 1);
		const firstMs = anchor + firstSlot * intervalMs;
		if (firstMs > now.getTime()) return [];
		const lastSlot = Math.floor((now.getTime() - anchor) / intervalMs);
		const dueCount = lastSlot - firstSlot + 1;
		const latest = new Date(anchor + lastSlot * intervalMs);
		const nextCandidate = new Date(anchor + (lastSlot + 1) * intervalMs);
		if (dueCount > catchUpLimit) {
			return [
				{
					...routineOccurrence(head, trigger, latest),
					expectedLastScheduledFor: cursor.lastScheduledFor,
					nextDueAt: nextCandidate.toISOString(),
					coalesced: dueCount - 1,
				},
			];
		}
		const wakes: ScheduledRoutineWake[] = [];
		for (let i = 0; i < dueCount; i += 1) {
			const scheduledFor = new Date(anchor + (firstSlot + i) * intervalMs);
			const nextDueAt = new Date(anchor + (firstSlot + i + 1) * intervalMs);
			const expectedLast = i === 0 ? lastScheduledFor : new Date(anchor + (firstSlot + i - 1) * intervalMs);
			wakes.push({
				...routineOccurrence(head, trigger, scheduledFor),
				expectedLastScheduledFor: expectedLast.toISOString(),
				nextDueAt: nextDueAt.toISOString(),
				coalesced: 0,
			});
		}
		return wakes;
	}
	let candidate = nextRoutineOccurrence(trigger, lastScheduledFor);
	const due: Date[] = [];
	let dueCount = 0;
	let latest: Date | undefined;
	while (candidate && candidate.getTime() <= now.getTime()) {
		dueCount += 1;
		latest = candidate;
		if (dueCount <= catchUpLimit) {
			due.push(candidate);
			candidate = nextRoutineOccurrence(trigger, candidate);
			continue;
		}
		if ("windowStart" in trigger) {
			const finalLatest = latestRoutineOccurrence(trigger, now);
			if (finalLatest && finalLatest.getTime() > latest.getTime()) {
				dueCount += countAdvancedOccurrencesBetween(trigger, latest.getTime(), finalLatest.getTime());
				latest = finalLatest;
			}
			candidate = nextRoutineOccurrence(trigger, latest);
			break;
		}
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
		const nextDueAt = due[index + 1] ?? candidate;
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
	readonly #concurrency: number;
	readonly #checkGate: Pick<RoutineCheckGateOptions, "fetch" | "lookup" | "allowLocalhost">;
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
		this.#concurrency = options.concurrency ?? DEFAULT_COMPANY_CONCURRENCY;
		this.#checkGate = options.checkGate ?? {};
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
		if (
			!Number.isSafeInteger(this.#concurrency) ||
			this.#concurrency < 1 ||
			this.#concurrency > MAX_COMPANY_CONCURRENCY
		) {
			throw new Error("Routine schedule concurrency is outside the supported range");
		}
	}

	async reconcile(
		controlPlane: CloudRunnerOrchestratorControlPlane,
		signal?: AbortSignal,
		due?: CloudOrchestratorPassDue,
	): Promise<void> {
		const failures: unknown[] = [];
		if (!due?.quiet("routine_heads")) await this.#reconcileDueHeads(controlPlane, failures, signal);
		await this.#restoreFolderDynamicRoutines(controlPlane, failures, signal);
		if (failures.length > 0) throw new RoutineWakeAdmissionErrors(failures);
	}

	async #reconcileDueHeads(
		controlPlane: CloudRunnerOrchestratorControlPlane,
		failures: unknown[],
		signal?: AbortSignal,
	): Promise<void> {
		let afterRoutineId: string | undefined;
		do {
			const page = signal
				? await controlPlane.listRoutineScheduleHeads(afterRoutineId, this.#pageSize, signal)
				: await controlPlane.listRoutineScheduleHeads(afterRoutineId, this.#pageSize);
			const pageFailures: unknown[][] = page.items.map(() => []);
			await runBounded(page.items, this.#concurrency, signal, async (head, headIndex) => {
				if (!Array.isArray(head.triggers)) return;
				const headErrors = pageFailures[headIndex]!;
				for (const value of head.triggers) {
					const trigger = parseScheduleTrigger(value);
					if (!trigger) continue;
					const now = this.#now();
					const wakes = dueRoutineWakes(head, trigger, now, this.#catchUpLimit);
					const firstSlot =
						wakes.length === 0 && now.getTime() >= this.#advancePausedUntil
							? routineFirstSlot(head, trigger, now)
							: undefined;
					if (firstSlot && now.getTime() >= this.#advancePausedUntil) {
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
								const alreadyPaused = now.getTime() < this.#advancePausedUntil;
								this.#advancePausedUntil = Math.max(
									this.#advancePausedUntil,
									now.getTime() + ROUTINE_ADVANCE_RETRY_MS,
								);
								if (!alreadyPaused) headErrors.push(error);
							} else {
								headErrors.push(error);
							}
						}
					}
					for (const occurrence of wakes) {
						let checkPayload: Record<string, JsonValue> | undefined;
						if (trigger.checkBeforeWake) {
							try {
								const gateSignal = signal ?? new AbortController().signal;
								let recordedStatus: "skipped" | "wake_required" | "stale" | undefined;
								const decision = await runRoutineCheckBeforeWake(
									trigger.checkBeforeWake,
									{ healthy: null },
									{
										...this.#checkGate,
										...(controlPlane.readRoutineCodeChecks
											? {
													runCodeChecks: async ({ repo }, checkSignal) =>
														await controlPlane.readRoutineCodeChecks!(
															{ routineId: head.routineId, ...(repo === undefined ? {} : { repo }) },
															checkSignal,
														),
												}
											: {}),
										...(controlPlane.checkRoutineWake
											? {
													recordResult: async (result, checkSignal) => {
														const recorded = await controlPlane.checkRoutineWake!(
															{
																routineId: head.routineId,
																expectedVersion: head.version,
																triggerId: occurrence.triggerId,
																scheduledFor: occurrence.scheduledFor,
																...(occurrence.expectedLastScheduledFor === undefined
																	? {}
																	: { expectedLastScheduledFor: occurrence.expectedLastScheduledFor }),
																nextDueAt: occurrence.nextDueAt,
																healthy: result.healthy,
																summary: result.summary,
																detail: result.detail,
															},
															checkSignal,
														);
														recordedStatus = recorded.status;
														return {
															previousHealthy: recorded.previousHealthy,
															stateChanged: recorded.stateChanged,
															shouldWake: recorded.shouldWake,
															consecutiveFailures: recorded.consecutiveFailures,
														};
													},
												}
											: {}),
									},
									gateSignal,
								);
								if (recordedStatus === "stale") break;
								if (recordedStatus === "skipped") continue;
								if (!decision.shouldWake) {
									const advanceInput: AdvanceCloudRoutineNextDueInput = {
										routineId: head.routineId,
										expectedVersion: head.version,
										triggerId: occurrence.triggerId,
										...(occurrence.expectedLastScheduledFor === undefined
											? {}
											: { expectedLastScheduledFor: occurrence.expectedLastScheduledFor }),
										nextDueAt: occurrence.nextDueAt,
									};
									if (signal) await controlPlane.advanceRoutineNextDue(advanceInput, signal);
									else await controlPlane.advanceRoutineNextDue(advanceInput);
									continue;
								}
								checkPayload = {
									healthy: decision.healthy,
									stateChanged: decision.stateChanged,
									consecutiveFailures: decision.consecutiveFailures,
									status: decision.status,
									summary: decision.summary,
									detail: decision.detail,
								};
							} catch (error) {
								if (signal?.aborted) throw error;
								headErrors.push(error);
								break;
							}
						}
						const input: EnqueueCloudRoutineWakeInput = {
							routineId: head.routineId,
							expectedVersion: head.version,
							...occurrence,
							payload: {
								schema: "qorpera.routine-schedule-occurrence/v1",
								coalesced: occurrence.coalesced,
								...(checkPayload === undefined ? {} : { checkBeforeWake: checkPayload }),
							},
						};
						try {
							if (signal) await controlPlane.enqueueRoutineWake(input, signal);
							else await controlPlane.enqueueRoutineWake(input);
						} catch (error) {
							if (signal?.aborted) throw error;
							headErrors.push(error);
							// Later slots depend on this trigger's successful cursor advance.
							// Other triggers and heads have independent durable cursors.
							break;
						}
					}
				}
			});
			for (const headErrors of pageFailures) failures.push(...headErrors);
			afterRoutineId = page.hasMore ? page.nextAfterRoutineId : undefined;
			if (page.hasMore && !afterRoutineId) throw new Error("Routine schedule pagination lost its cursor");
		} while (afterRoutineId);
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
			const pageFailures: unknown[] = new Array(page.items.length);
			const hasFailure = new Uint8Array(page.items.length);
			await runBounded(page.items, this.#concurrency, signal, async (routine, routineIndex) => {
				try {
					if (signal) await controlPlane.restoreFolderDynamicRoutineRun!(routine, signal);
					else await controlPlane.restoreFolderDynamicRoutineRun!(routine);
				} catch (error) {
					if (signal?.aborted) throw error;
					pageFailures[routineIndex] = error;
					hasFailure[routineIndex] = 1;
				}
			});
			for (let i = 0; i < page.items.length; i++) {
				if (hasFailure[i] === 1) failures.push(pageFailures[i]);
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

const DEFAULT_COMPANY_CONCURRENCY = 4;
const MAX_COMPANY_CONCURRENCY = 16;

// WHY: companies in one drain or materialization page are independent transactions; bounded concurrency cuts multi-company reconcile latency while settling in-flight workers cleanly on abort.
async function runBounded<T>(
	items: readonly T[],
	concurrency: number,
	signal: AbortSignal | undefined,
	run: (item: T, index: number) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	const workerCount = Math.min(concurrency, items.length);
	let nextIndex = 0;
	let abortError: unknown;
	let hasAbortError = false;
	const worker = async (): Promise<void> => {
		while (!hasAbortError && !signal?.aborted) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				await run(items[index]!, index);
			} catch (error) {
				if (!hasAbortError) {
					hasAbortError = true;
					abortError = error;
				}
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	if (hasAbortError) throw abortError;
	signal?.throwIfAborted();
}

/** The per-company folder drains (folder core C4, P29: the shared step before the materializer;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9): for each drain in order, every company with due work in its
 * own request and transaction. Each drain has its own pause and backoff, and each of its companies its own: a drain
 * whose list fails, or that the edge function does not know, stops only itself, and one company's failure stops no
 * other. The wakes a drain admits are materialized in the same pass. */
export class CloudFolderDrains implements CloudRunnerOccurrenceReconciler {
	readonly #now: () => Date;
	readonly #pageSize: number;
	readonly #concurrency: number;
	readonly #drains: readonly CloudFolderDrainSpec[];
	readonly #drainBackoff = new Map<string, FolderDrainBackoff>();
	/** Keyed by drain name and environment id. */
	readonly #companyBackoff = new Map<string, FolderDrainBackoff>();

	constructor(options: CloudFolderDrainsOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = options.pageSize ?? 100;
		this.#concurrency = options.concurrency ?? DEFAULT_COMPANY_CONCURRENCY;
		this.#drains = options.drains ?? CLOUD_FOLDER_DRAINS;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
			throw new Error("Folder drain page size is outside the supported range");
		}
		if (
			!Number.isSafeInteger(this.#concurrency) ||
			this.#concurrency < 1 ||
			this.#concurrency > MAX_COMPANY_CONCURRENCY
		) {
			throw new Error("Folder drain concurrency is outside the supported range");
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

	async reconcile(
		controlPlane: CloudRunnerOrchestratorControlPlane,
		signal?: AbortSignal,
		due?: CloudOrchestratorPassDue,
	): Promise<void> {
		if (!controlPlane.listFolderDrainDue || !controlPlane.runFolderDrain) return;
		const runFolderDrain = controlPlane.runFolderDrain.bind(controlPlane);
		const now = this.#now().getTime();
		// A company no longer due is forgotten once its wait has long passed.
		for (const [key, backoff] of this.#companyBackoff) {
			if (backoff.until + FOLDER_DRAIN_BACKOFF_MAX_MS < now) this.#companyBackoff.delete(key);
		}
		const failures: unknown[] = [];
		for (const drain of this.#drains) {
			if (now < (this.#drainBackoff.get(drain.name)?.until ?? 0)) continue;
			if (due?.quiet(drain.name)) {
				// Its list was read, in the one call, and was empty: as good as a list that answered.
				this.#drainBackoff.delete(drain.name);
				continue;
			}
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
				const runnable = page.items.filter((environmentId) => {
					const key = `${drain.name} ${environmentId}`;
					return now >= (this.#companyBackoff.get(key)?.until ?? 0);
				});
				const pageFailures = new Array<unknown>(runnable.length);
				const hasFailure = new Array<boolean>(runnable.length).fill(false);
				await runBounded(runnable, this.#concurrency, signal, async (environmentId, index) => {
					const key = `${drain.name} ${environmentId}`;
					due?.worked();
					try {
						if (signal) await runFolderDrain(drain.name, environmentId, drain.companyLimit, signal);
						else await runFolderDrain(drain.name, environmentId, drain.companyLimit);
						this.#companyBackoff.delete(key);
					} catch (error) {
						if (signal?.aborted) throw error;
						hasFailure[index] = true;
						pageFailures[index] = error;
						this.#companyBackoff.set(
							key,
							folderDrainBackoff(this.#companyBackoff.get(key), this.#now().getTime()),
						);
					}
				});
				for (let i = 0; i < runnable.length; i++) if (hasFailure[i]) failures.push(pageFailures[i]);
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
	readonly #concurrency: number;
	/** A control plane that answers the list with 400 does not know it yet (its edge function predates this
	 * orchestrator): report that once and ask again after a while. */
	#pausedUntil = 0;

	constructor(options: CloudFolderRunMaterializerOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = options.pageSize ?? 100;
		this.#companyLimit = options.companyLimit ?? 16;
		this.#concurrency = options.concurrency ?? DEFAULT_COMPANY_CONCURRENCY;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
			throw new Error("Folder materialization page size is outside the supported range");
		}
		if (!Number.isSafeInteger(this.#companyLimit) || this.#companyLimit < 1 || this.#companyLimit > 16) {
			throw new Error("Folder materialization company limit is outside the supported range");
		}
		if (
			!Number.isSafeInteger(this.#concurrency) ||
			this.#concurrency < 1 ||
			this.#concurrency > MAX_COMPANY_CONCURRENCY
		) {
			throw new Error("Folder materialization concurrency is outside the supported range");
		}
	}

	async reconcile(
		controlPlane: CloudRunnerOrchestratorControlPlane,
		signal?: AbortSignal,
		due?: CloudOrchestratorPassDue,
	): Promise<void> {
		if (!controlPlane.listFolderMaterializationDue || !controlPlane.materializeFolderCompany) return;
		const materializeFolderCompany = controlPlane.materializeFolderCompany.bind(controlPlane);
		const now = this.#now().getTime();
		if (now < this.#pausedUntil || due?.quiet("materialize")) return;
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
			const pageFailures = new Array<unknown>(page.items.length);
			const hasFailure = new Array<boolean>(page.items.length).fill(false);
			await runBounded(page.items, this.#concurrency, signal, async (profileId, index) => {
				due?.worked();
				try {
					if (signal) await materializeFolderCompany(profileId, this.#companyLimit, signal);
					else await materializeFolderCompany(profileId, this.#companyLimit);
				} catch (error) {
					if (signal?.aborted) throw error;
					hasFailure[index] = true;
					pageFailures[index] = error;
				}
			});
			for (let i = 0; i < page.items.length; i++) if (hasFailure[i]) failures.push(pageFailures[i]);
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
	const input = responseRecord(value, "runner assignment");
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
	/** The one call reads every list, so one bad list fails it. It waits like a failing drain, and while it waits a pass asks
	 * every list itself, each with its own backoff, and never pays for the call. A 400 (an edge function that predates the
	 * call) waits ten minutes. */
	#passDueBackoff?: FolderDrainBackoff;

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
		let due: CloudOrchestratorPassDue | undefined;
		if (this.#controlPlane.readPassDue && Date.now() >= (this.#passDueBackoff?.until ?? 0)) {
			try {
				due = new CloudOrchestratorPassDue(await this.#controlPlane.readPassDue(signal));
				this.#passDueBackoff = undefined;
			} catch (error) {
				if (signal?.aborted) throw error;
				// Reported once per wait, since nothing else says why a pass is back to asking every list.
				this.#passDueBackoff = folderDrainBackoff(
					this.#passDueBackoff,
					Date.now(),
					error instanceof CloudRunnerOrchestratorRequestError && error.status === 400
						? ROUTINE_ADVANCE_RETRY_MS
						: undefined,
				);
				reconciliationErrors.push(error);
			}
		}
		for (const reconciler of this.#occurrenceReconcilers) {
			try {
				if (due) await reconciler.reconcile(this.#controlPlane, signal, due);
				else if (signal) await reconciler.reconcile(this.#controlPlane, signal);
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
		const onOuterAbort = () => acquisitionController.abort(signal?.reason);
		if (signal?.aborted) acquisitionController.abort(signal.reason);
		else signal?.addEventListener("abort", onOuterAbort, { once: true });
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
						// WHY: Pass acquisitionController.signal so an in-flight renewClaim aborts immediately when acquire() succeeds.
						claim = await this.#controlPlane.renewClaim(
							claim,
							this.#claimLeaseSeconds,
							acquisitionController.signal,
						);
						break;
					} catch (error) {
						if (acquisitionController.signal.aborted) return;
						if (renewAttempt >= 3) {
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
		const acquisition = this.#providerAdapter.acquire(claim.work, acquisitionController.signal);
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
		} finally {
			signal?.removeEventListener("abort", onOuterAbort);
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
		const wakePassGapMs = options.wakePassGapMs ?? 500;
		if (wake && (!Number.isSafeInteger(wakePassGapMs) || wakePassGapMs < 0 || wakePassGapMs > 60_000)) {
			throw new Error("Orchestrator wake-up pass gap is outside the supported range");
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
			emptyWokenClaims: 0,
			lastEmptyWokenAt: Number.NEGATIVE_INFINITY,
			/** A backstop claim found new work no wake-up had announced, at this time. Realtime delivers a
			 * wake-up just after the enqueue commits, so one may still be on its way for WAKE_GRACE_MS. */
			unannouncedSince: undefined as number | undefined,
		};
		const slowPolling = (): boolean => wake?.listening === true && performance.now() >= wakes.fastUntil;
		// A wake-up also brings the next pass forward: a wake occurrence (a room post, a coworker's message) or a
		// conversation's next input once its run ended becomes a job only in a pass, which otherwise waits up to
		// reconcileIntervalMs (production, 7 Nov 2026: a room post's job came p50 0.7 s, at most 2.3 s, after its
		// wake occurrence). A pass brought forward starts at least the gap after the pass before it ended, so the lane
		// rests between passes and a flood of wake-ups (each job a pass creates sends one) adds at most one pass per
		// gap. A pass running when a wake-up arrives is followed by another one gap after it ends, since it may have
		// listed before the new row.
		const passes = {
			running: false,
			lastEndedAt: Number.NEGATIVE_INFINITY,
			/** A wake-up arrived during the running pass. */
			wanted: false,
			timer: undefined as NodeJS.Timeout | undefined,
		};
		// While the one summary call is failing, or the control plane has none, every pass asks each list itself
		// (about eleven requests): then a wake-up brings no pass sooner than the reconcile interval would.
		const passGapMs = (): number =>
			this.#controlPlane.readPassDue && this.#passDueBackoff === undefined ? wakePassGapMs : reconcileIntervalMs;
		const bringPassForward = (): void => {
			if (signal.aborted) return;
			if (passes.running) {
				passes.wanted = true;
				return;
			}
			if (passes.timer) return;
			const rest = passGapMs() - (performance.now() - passes.lastEndedAt);
			if (rest <= 0) {
				reconcileTimer.wake();
				return;
			}
			passes.timer = setTimeout(() => {
				passes.timer = undefined;
				reconcileTimer.wake();
			}, rest);
		};
		const unsubscribe = wake?.subscribe(() => {
			wakes.announced = true;
			wakes.sequence++;
			wakes.unannouncedSince = undefined;
			claimTimer.wake();
			bringPassForward();
		});
		const reconcileLane = (async (): Promise<void> => {
			while (!signal.aborted) {
				const pass = ++reconcile.started;
				passes.running = true;
				// This pass starts after every wake-up so far, so one still waiting for its gap needs no pass of its own.
				passes.wanted = false;
				if (passes.timer) {
					clearTimeout(passes.timer);
					passes.timer = undefined;
				}
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
				passes.running = false;
				passes.lastEndedAt = performance.now();
				if (passes.wanted) {
					passes.wanted = false;
					delayMs = Math.min(delayMs, passGapMs());
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
					const claimStartedAt = performance.now();
					const { claims, fresh } = await this.#claimBatch(available, signal, inFlightClaimIds, includeRetained);
					if (includeRetained) reconcile.retainedRead = Math.max(reconcile.retainedRead, reconciled);
					if (claims.length > 0) {
						wakes.emptyWokenClaims = 0;
						if (announced) wakes.lastWokenClaimAt = claimStartedAt;
						wakes.fastUntil = Math.max(wakes.fastUntil, performance.now() + wakeActiveMs);
					} else if (announced) {
						// WHY: Do not throttle Wake #2 (job insert) behind an empty Wake #1 (pre-materialization), while still bounding repeated empty wake bursts to one claim per poll interval.
						if (claimStartedAt - wakes.lastEmptyWokenAt >= pollIntervalMs) wakes.emptyWokenClaims = 0;
						wakes.emptyWokenClaims += 1;
						wakes.lastEmptyWokenAt = claimStartedAt;
						if (wakes.emptyWokenClaims >= 2) wakes.lastWokenClaimAt = claimStartedAt;
					} else {
						wakes.emptyWokenClaims = 0;
					}
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
		if (passes.timer) clearTimeout(passes.timer);
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

	async checkRoutineWake(
		input: CheckCloudRoutineWakeInput,
		signal?: AbortSignal,
	): Promise<CloudRoutineCheckWakeDecision> {
		requiredUuid(input.routineId, "Routine id");
		const answer = await this.#request(
			{
				action: "check_routine_wake",
				orchestratorId: this.#orchestratorId,
				routineId: input.routineId,
				expectedVersion: input.expectedVersion,
				triggerId: input.triggerId,
				scheduledFor: new Date(input.scheduledFor).toISOString(),
				...(input.expectedLastScheduledFor
					? { expectedLastScheduledFor: new Date(input.expectedLastScheduledFor).toISOString() }
					: {}),
				nextDueAt: new Date(input.nextDueAt).toISOString(),
				healthy: input.healthy,
				summary: input.summary,
				detail: input.detail,
			},
			signal,
		);
		const obj = responseRecord(answer, "routine check wake decision");
		if (
			obj.schema !== "qorpera.routine-check-wake/v1" ||
			(obj.status !== "skipped" && obj.status !== "wake_required" && obj.status !== "stale") ||
			typeof obj.shouldWake !== "boolean"
		) {
			throw new Error("Runner orchestrator returned invalid routine check wake decision");
		}
		return {
			status: obj.status,
			shouldWake: obj.shouldWake,
			previousHealthy: typeof obj.previousHealthy === "boolean" ? obj.previousHealthy : null,
			stateChanged: obj.stateChanged === true,
			consecutiveFailures: Number.isSafeInteger(obj.consecutiveFailures) ? (obj.consecutiveFailures as number) : 0,
		};
	}

	async readRoutineCodeChecks(
		input: { readonly routineId: string; readonly repo?: string },
		signal?: AbortSignal,
	): Promise<CloudRoutineCodeChecksResult> {
		requiredUuid(input.routineId, "Routine id");
		const answer = await this.#request(
			{
				action: "read_routine_code_checks",
				orchestratorId: this.#orchestratorId,
				routineId: input.routineId,
				...(input.repo === undefined ? {} : { repo: input.repo }),
			},
			signal,
		);
		const obj = responseRecord(answer, "routine code checks result");
		if (
			obj.schema !== "qorpera.routine-code-checks/v1" ||
			typeof obj.ok !== "boolean" ||
			typeof obj.summary !== "string"
		) {
			throw new Error("Runner orchestrator returned invalid routine code checks result");
		}
		return {
			ok: obj.ok,
			summary: obj.summary,
			detail: typeof obj.detail === "string" ? obj.detail : null,
		};
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

	async readPassDue(signal?: AbortSignal): Promise<Readonly<Record<string, boolean>>> {
		const input = responseRecord(
			await this.#request({ action: "due_summary", orchestratorId: this.#orchestratorId }, signal),
			"due summary",
		);
		const answers: Record<string, boolean> = {};
		for (const [list, answer] of Object.entries(input)) {
			if (typeof answer !== "boolean") throw new Error("Runner orchestrator returned an invalid due summary");
			answers[list] = answer;
		}
		return answers;
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

	async claimSurfaceJobs(limit = 16, signal?: AbortSignal, lane?: SurfaceClaimLane): Promise<ClaimedSurfaceJobs> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
			throw new Error("Surface job claim limit is outside the supported range");
		}
		if (lane !== undefined && lane !== "all" && lane !== "sessions" && lane !== "folder" && lane !== "code_repo") {
			throw new Error("Surface job claim lane is invalid");
		}
		return parseClaimedSurfaceJobs(
			await this.#request(
				{
					action: "surface_claim_jobs",
					orchestratorId: this.#orchestratorId,
					limit,
					...(lane !== undefined ? { lane } : {}),
				},
				signal,
			),
		);
	}

	async resolveSharedProductFolderRoots(profileId: string, signal?: AbortSignal): Promise<readonly string[]> {
		requiredUuid(profileId, "Surface profile id");
		const raw = await this.#request(
			{
				action: "surface_shared_product_folder_roots",
				orchestratorId: this.#orchestratorId,
				profileId,
			},
			signal,
		);
		if (!Array.isArray(raw) || raw.length > 32) {
			throw new Error("Runner orchestrator returned invalid surface product folder roots");
		}
		return raw.map((item) => responseText(item, "surface product folder root", 256));
	}

	async enqueueSurfaceSessionRun(
		input: EnqueueSurfaceSessionRunInput,
		signal?: AbortSignal,
	): Promise<EnqueueSurfaceSessionRunResult> {
		requiredUuid(input.sessionId, "Surface session id");
		requiredUuid(input.leaseToken, "Surface lease token");
		const raw = responseRecord(
			await this.#request(
				{
					action: "surface_enqueue_session_run",
					orchestratorId: this.#orchestratorId,
					sessionId: input.sessionId,
					leaseToken: input.leaseToken,
				},
				signal,
			),
			"surface session run enqueue",
		);
		if (raw.status === "enqueued") {
			const wakeId =
				raw.wakeId === null || raw.wakeId === undefined ? null : responseUuid(raw.wakeId, "surface wake id");
			const workerId =
				raw.workerId === null || raw.workerId === undefined
					? null
					: responseUuid(raw.workerId, "surface worker id");
			if (!wakeId && !workerId) {
				throw new Error("Runner orchestrator returned invalid surface wake id");
			}
			return {
				status: "enqueued",
				wakeId,
				runId: raw.runId === null || raw.runId === undefined ? null : responseUuid(raw.runId, "surface run id"),
				...(workerId ? { workerId } : {}),
			};
		}
		if (raw.status === "deferred") {
			return {
				status: "deferred",
				reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "deferred",
				retryAfterSeconds:
					typeof raw.retryAfterSeconds === "number" && Number.isFinite(raw.retryAfterSeconds)
						? raw.retryAfterSeconds
						: 15,
			};
		}
		if (raw.status === "unavailable") {
			return {
				status: "unavailable",
				reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "unavailable",
			};
		}
		throw new Error("Runner orchestrator returned invalid surface session enqueue status");
	}

	async triggerSurfaceAutomation(automationId: string, signal?: AbortSignal): Promise<TriggerSurfaceAutomationResult> {
		requiredUuid(automationId, "Surface automation id");
		const raw = responseRecord(
			await this.#request(
				{
					action: "surface_trigger_automation",
					orchestratorId: this.#orchestratorId,
					automationId,
				},
				signal,
			),
			"surface automation trigger",
		);
		if (raw.status === "started") {
			const session =
				raw.session && typeof raw.session === "object" ? (raw.session as Record<string, unknown>) : null;
			const sessionId =
				session && typeof session.sessionId === "string"
					? responseUuid(session.sessionId, "surface session id")
					: null;
			return { status: "started", sessionId };
		}
		if (raw.status === "skipped") {
			return {
				status: "skipped",
				...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
			};
		}
		throw new Error("Runner orchestrator returned invalid surface automation trigger status");
	}

	async renewSurfaceLease(input: RenewSurfaceLeaseInput, signal?: AbortSignal): Promise<RenewSurfaceLeaseResult> {
		if (input.kind !== "session" && input.kind !== "preview" && input.kind !== "job") {
			throw new Error("Surface lease kind is invalid");
		}
		requiredUuid(input.id, "Surface lease target id");
		requiredUuid(input.leaseToken, "Surface lease token");
		const extendSeconds = input.extendSeconds ?? 300;
		if (!Number.isSafeInteger(extendSeconds) || extendSeconds < 30 || extendSeconds > 900) {
			throw new Error("Surface lease extendSeconds is outside the supported range");
		}
		return parseRenewSurfaceLeaseResult(
			await this.#request(
				{
					action: "surface_renew_lease",
					orchestratorId: this.#orchestratorId,
					kind: input.kind,
					id: input.id,
					leaseToken: input.leaseToken,
					extendSeconds,
				},
				signal,
			),
		);
	}

	async releaseSurfaceSessionClaim(
		input: ReleaseSurfaceSessionClaimInput,
		signal?: AbortSignal,
	): Promise<ReleaseSurfaceSessionClaimResult> {
		requiredUuid(input.sessionId, "Surface session id");
		requiredUuid(input.leaseToken, "Surface lease token");
		return parseReleaseSurfaceSessionClaimResult(
			await this.#request(
				{
					action: "surface_release_session_claim",
					orchestratorId: this.#orchestratorId,
					sessionId: input.sessionId,
					leaseToken: input.leaseToken,
				},
				signal,
			),
		);
	}

	async completeSurfacePreview(
		input: CompleteSurfacePreviewInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfacePreviewResult> {
		requiredUuid(input.previewId, "Surface preview id");
		if (input.status !== "ready" && input.status !== "conflicted" && input.status !== "failed") {
			throw new Error("Surface preview status is invalid");
		}
		const compositeTreeSha =
			input.compositeTreeSha === null || input.compositeTreeSha === undefined
				? undefined
				: validateSurfaceShortText(input.compositeTreeSha, "Composite tree sha", 64);
		let siteVersionId: string | undefined;
		if (input.siteVersionId !== null && input.siteVersionId !== undefined) {
			requiredUuid(input.siteVersionId, "Site version id");
			siteVersionId = input.siteVersionId;
		}
		const conflictReport =
			input.conflictReport === null || input.conflictReport === undefined
				? undefined
				: validateSurfaceRecordPayload(
						input.conflictReport as Readonly<Record<string, unknown>>,
						"Preview conflict report",
						16 * 1024,
					);
		const errorDetail =
			input.errorDetail === null || input.errorDetail === undefined
				? undefined
				: validateSurfaceErrorDetail(input.errorDetail, "Preview error detail");
		let leaseToken: string | undefined;
		if (input.leaseToken !== null && input.leaseToken !== undefined) {
			requiredUuid(input.leaseToken, "Surface lease token");
			leaseToken = input.leaseToken;
		}
		return parseCompleteSurfacePreviewResult(
			await this.#request(
				{
					action: "surface_complete_preview",
					orchestratorId: this.#orchestratorId,
					previewId: input.previewId,
					status: input.status,
					...(compositeTreeSha !== undefined ? { compositeTreeSha } : {}),
					...(siteVersionId !== undefined ? { siteVersionId } : {}),
					...(conflictReport !== undefined ? { conflictReport } : {}),
					...(errorDetail !== undefined ? { errorDetail } : {}),
					...(leaseToken !== undefined ? { leaseToken } : {}),
				},
				signal,
			),
		);
	}

	async completeSurfaceSessionTurn(
		input: CompleteSurfaceSessionTurnInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfaceSessionTurnResult> {
		requiredUuid(input.sessionId, "Surface session id");
		if (!SURFACE_SESSION_COMPLETION_STATE_SET.has(input.state)) {
			throw new Error("Surface session state is invalid");
		}
		let replyText: string | undefined;
		if (input.replyText !== null && input.replyText !== undefined) {
			if (typeof input.replyText !== "string" || input.replyText.length > 16_000 || input.replyText.includes("\0")) {
				throw new Error("Surface session reply is invalid");
			}
			replyText = input.replyText;
		}
		const question =
			input.question === null || input.question === undefined
				? undefined
				: validateSurfaceRecordPayload(
						input.question as Readonly<Record<string, unknown>>,
						"Surface session question",
						8 * 1024,
					);
		const notePaths =
			input.notePaths === null || input.notePaths === undefined
				? undefined
				: validateSurfaceStringList(input.notePaths, "Surface session note paths", 64, 512);
		const branchHeadSha =
			input.branchHeadSha === null || input.branchHeadSha === undefined
				? undefined
				: validateSurfaceShortText(input.branchHeadSha, "Surface branch head sha", 64);
		let leaseToken: string | undefined;
		if (input.leaseToken !== null && input.leaseToken !== undefined) {
			requiredUuid(input.leaseToken, "Surface lease token");
			leaseToken = input.leaseToken;
		}
		return parseCompleteSurfaceSessionTurnResult(
			await this.#request(
				{
					action: "surface_complete_session_turn",
					orchestratorId: this.#orchestratorId,
					sessionId: input.sessionId,
					state: input.state,
					...(replyText !== undefined ? { replyText } : {}),
					...(question !== undefined ? { question } : {}),
					...(notePaths !== undefined ? { notePaths } : {}),
					...(branchHeadSha !== undefined ? { branchHeadSha } : {}),
					...(leaseToken !== undefined ? { leaseToken } : {}),
				},
				signal,
			),
		);
	}

	async completeSurfaceMerge(
		input: CompleteSurfaceMergeInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfaceMergeResult> {
		requiredUuid(input.jobId, "Surface merge job id");
		if (input.status !== "landed" && input.status !== "conflicted" && input.status !== "failed") {
			throw new Error("Surface merge status is invalid");
		}
		const mainBefore =
			input.mainBefore === null || input.mainBefore === undefined
				? undefined
				: validateSurfaceShortText(input.mainBefore, "Merge main before sha", 64);
		const mainAfter =
			input.mainAfter === null || input.mainAfter === undefined
				? undefined
				: validateSurfaceShortText(input.mainAfter, "Merge main after sha", 64);
		let conflictChangeId: string | undefined;
		if (input.conflictChangeId !== null && input.conflictChangeId !== undefined) {
			requiredUuid(input.conflictChangeId, "Merge conflict change id");
			conflictChangeId = input.conflictChangeId;
		}
		const conflictPaths =
			input.conflictPaths === null || input.conflictPaths === undefined
				? undefined
				: validateSurfaceStringList(input.conflictPaths, "Merge conflict paths", 256, 512);
		const errorDetail =
			input.errorDetail === null || input.errorDetail === undefined
				? undefined
				: validateSurfaceErrorDetail(input.errorDetail, "Merge error detail");
		const preMergeSnapshot =
			input.preMergeSnapshot === null || input.preMergeSnapshot === undefined
				? undefined
				: validateSurfaceRecordPayload(input.preMergeSnapshot, "Merge pre-merge snapshot", 96 * 1024);
		let leaseToken: string | undefined;
		if (input.leaseToken !== null && input.leaseToken !== undefined) {
			requiredUuid(input.leaseToken, "Surface lease token");
			leaseToken = input.leaseToken;
		}
		return parseCompleteSurfaceMergeResult(
			await this.#request(
				{
					action: "surface_complete_merge",
					orchestratorId: this.#orchestratorId,
					jobId: input.jobId,
					status: input.status,
					...(mainBefore !== undefined ? { mainBefore } : {}),
					...(mainAfter !== undefined ? { mainAfter } : {}),
					...(conflictChangeId !== undefined ? { conflictChangeId } : {}),
					...(conflictPaths !== undefined ? { conflictPaths } : {}),
					...(errorDetail !== undefined ? { errorDetail } : {}),
					...(preMergeSnapshot !== undefined ? { preMergeSnapshot } : {}),
					...(leaseToken !== undefined ? { leaseToken } : {}),
				},
				signal,
			),
		);
	}

	async completeSurfacePublish(
		input: CompleteSurfacePublishInput,
		signal?: AbortSignal,
	): Promise<CompleteSurfacePublishResult> {
		requiredUuid(input.jobId, "Surface publish job id");
		if (input.status !== "published" && input.status !== "failed") {
			throw new Error("Surface publish status is invalid");
		}
		const publishedHeadSha =
			input.publishedHeadSha === null || input.publishedHeadSha === undefined
				? undefined
				: validateSurfaceShortText(input.publishedHeadSha, "Published head sha", 64);
		const errorDetail =
			input.errorDetail === null || input.errorDetail === undefined
				? undefined
				: validateSurfaceErrorDetail(input.errorDetail, "Publish error detail");
		let leaseToken: string | undefined;
		if (input.leaseToken !== null && input.leaseToken !== undefined) {
			requiredUuid(input.leaseToken, "Surface lease token");
			leaseToken = input.leaseToken;
		}
		return parseCompleteSurfacePublishResult(
			await this.#request(
				{
					action: "surface_complete_publish",
					orchestratorId: this.#orchestratorId,
					jobId: input.jobId,
					status: input.status,
					...(publishedHeadSha !== undefined ? { publishedHeadSha } : {}),
					...(errorDetail !== undefined ? { errorDetail } : {}),
					...(leaseToken !== undefined ? { leaseToken } : {}),
				},
				signal,
			),
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
		const controller = new AbortController();
		const onOuterAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) controller.abort(signal.reason);
		else signal?.addEventListener("abort", onOuterAbort, { once: true });
		const timer = setTimeout(() => {
			controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		}, CONTROL_PLANE_REQUEST_TIMEOUT_MS);
		let encoded: string;
		try {
			const response = await this.#fetch(this.#url, {
				method: "POST",
				headers: {
					apikey: this.#publishableKey,
					authorization: `Bearer ${controlToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok) {
				// WHY: Cancel non-ok response bodies so Undici releases the pooled socket.
				void response.body?.cancel().catch(() => undefined);
				throw new CloudRunnerOrchestratorRequestError(response.status);
			}
			encoded = await response.text();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onOuterAbort);
		}
		if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) {
			throw new Error("Runner orchestrator response exceeds its byte limit");
		}
		let value: unknown;
		try {
			value = JSON.parse(encoded) as unknown;
		} catch (error) {
			throw new Error("Runner orchestrator returned invalid JSON", { cause: error });
		}
		const envelope = responseRecord(value, "response envelope");
		return envelope.value;
	}
}
