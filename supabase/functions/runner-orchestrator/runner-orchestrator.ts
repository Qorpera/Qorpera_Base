import { DEFAULT_BODY_READ_TIMEOUT_MS, readBoundedText } from "../_shared/http-guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 128 * 1024;
const SURFACE_PREVIEW_COMPLETION_STATUSES = new Set(["ready", "conflicted", "failed"]);
const SURFACE_SESSION_COMPLETION_STATES = new Set(["needs_input", "ready", "completed", "failed"]);
const SURFACE_MERGE_COMPLETION_STATUSES = new Set(["landed", "conflicted", "failed"]);
const SURFACE_PUBLISH_COMPLETION_STATUSES = new Set(["published", "failed"]);
const SURFACE_LEASE_KINDS = new Set(["session", "preview", "job"]);
const SURFACE_CLAIM_LANES = new Set(["all", "sessions", "folder", "code_repo"]);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The per-company folder drains (folder core C4, P29: deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9): each name
 * the orchestrator may ask for, its due list's and one company's RPC (`(p_after_environment uuid, p_limit integer)` and
 * `(p_environment_id uuid, p_limit integer)`), and the most one company's request may take. A drain plugs in here and in
 * the orchestrator's list; an edge function without its entry answers 400, which pauses that drain alone. It may also
 * join qorpera_orchestrator_due_summary, which spares the idle pass its list; a drain not named there is listed as before. */
export const FOLDER_DRAINS: Readonly<Record<string, Readonly<{ due: string; company: string; maximum: number }>>> = Object.freeze({
	listen: Object.freeze({ due: "qorpera_folder_listen_due", company: "qorpera_folder_listen_company", maximum: 256 }),
	// F2's worker drain (F2-5b-3): starts dispatched workers and revives their parents.
	workers: Object.freeze({ due: "qorpera_folder_workers_due", company: "qorpera_folder_workers_company", maximum: 32 }),
	// F2's human-task wakes (H2c, P31): a task's changes the listener marked, and overdue tasks.
	human_tasks: Object.freeze({
		due: "qorpera_folder_human_tasks_due",
		company: "qorpera_folder_human_tasks_company",
		maximum: 32,
	}),
	// A company machine's events, delivered to the runs that started the work (C1c-3i-b).
	machine_events: Object.freeze({
		due: "qorpera_folder_machine_events_due",
		company: "qorpera_folder_machine_events_company",
		maximum: 64,
	}),
	// C1c-3l part 2: wake an agent once the Company Computer it started is up (RUNTIME-COMPANY-FOLDER-C1C.md §6.18).
	office_wakes: Object.freeze({
		due: "qorpera_folder_office_wakes_due",
		company: "qorpera_folder_office_wakes_company",
		maximum: 40,
	}),
	// The one idle rule's check-ins (2026-10-03 amendment, item 5): busy programs' agents asked, in the runs' conversations.
	machine_checkins: Object.freeze({
		due: "qorpera_folder_machine_checkins_due",
		company: "qorpera_folder_machine_checkins_company",
		maximum: 64,
	}),
	// A quiet coding session's check-in question, to the run that started it (C3c).
	coding_checkins: Object.freeze({
		due: "qorpera_folder_coding_checkins_due",
		company: "qorpera_folder_coding_checkins_company",
		maximum: 32,
	}),
	// Event wakes (E2): a verified delivery to a hook or mailbox wakes the routines that listen to it.
	events: Object.freeze({
		due: "qorpera_folder_event_wakes_due",
		company: "qorpera_folder_event_wakes_company",
		maximum: 64,
	}),
});

export type RunnerOrchestratorRequest =
	| {
			action: "rotate_control";
			orchestratorId: string;
			nextControlTokenSha256: string;
			controlTokenSeconds: number;
	  }
	| {
			action: "routine_heads";
			orchestratorId: string;
			afterRoutineId?: string;
			limit: number;
	  }
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
			payload: Record<string, unknown>;
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
			action: "folder_dynamic_routines";
			orchestratorId: string;
			afterRoutineId?: string;
			limit: number;
	  }
	| {
			action: "restore_dynamic_routine";
			orchestratorId: string;
			routineId: string;
			expectedVersion: number;
	  }
	| {
			action: "folder_materialize_due";
			orchestratorId: string;
			afterProfileId?: string;
			limit: number;
	  }
	| {
			action: "folder_drain_due";
			orchestratorId: string;
			drain: string;
			afterEnvironmentId?: string;
			limit: number;
	  }
	| {
			action: "folder_drain_company";
			orchestratorId: string;
			drain: string;
			environmentId: string;
			limit: number;
	  }
	| {
			action: "folder_materialize_company";
			orchestratorId: string;
			profileId: string;
			limit: number;
	  }
	| { action: "due_summary"; orchestratorId: string }
	| { action: "reconcile"; orchestratorId: string }
	| { action: "retained"; orchestratorId: string }
	| {
			action: "claim";
			orchestratorId: string;
			clientClaimId: string;
			leaseSeconds: number;
	  }
	| {
			action: "renew_claim";
			orchestratorId: string;
			claimId: string;
			leaseSeconds: number;
	  }
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
			lane?: "all" | "sessions" | "folder" | "code_repo";
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
			rebasedChanges?: { changeId: string; parentSha: string; headSha: string }[];
			conflictedChangeId?: string;
			conflictPaths?: string[];
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
			state: "needs_input" | "ready" | "completed" | "failed";
			replyText?: string;
			question?: Record<string, unknown>;
			notePaths?: string[];
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
			conflictPaths?: string[];
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

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function seconds(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 30 || (value as number) > 900) {
		throw new Error(`Invalid ${label}`);
	}
	return value as number;
}

function integer(value: unknown, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value as number;
}

function folderDrain(value: unknown): string {
	if (typeof value !== "string" || !Object.hasOwn(FOLDER_DRAINS, value)) throw new Error("Invalid folder drain");
	return value;
}

function text(value: unknown, label: string, maximumBytes: number): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		new TextEncoder().encode(value).byteLength < 1 ||
		new TextEncoder().encode(value).byteLength > maximumBytes ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function errorDetail(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		value.length < 1 ||
		value.length > 1000 ||
		value.includes("\0")
	) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function boundedRecord(value: unknown, label: string, maximumBytes: number): Record<string, unknown> {
	const parsed = record(value, label);
	if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maximumBytes) {
		throw new Error(`Invalid ${label}`);
	}
	return parsed;
}

function textArray(value: unknown, label: string, maximumItems: number, maximumBytes: number): string[] {
	if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Invalid ${label}`);
	return value.map((item) => text(item, label, maximumBytes));
}

function surfaceReplyText(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length > 16_000 || value.includes("\0")) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

export function parseRunnerOrchestratorBearer(value: string | null): string {
	if (!value?.startsWith("Bearer ")) throw new Error("Invalid orchestrator authorization");
	const token = value.slice("Bearer ".length).trim();
	if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid orchestrator authorization");
	return token;
}

export function parseRunnerOrchestratorRequest(value: unknown): RunnerOrchestratorRequest {
	const input = record(value, "orchestrator request");
	const orchestratorId = uuid(input.orchestratorId, "orchestrator id");
	switch (input.action) {
		case "rotate_control":
			if (
				typeof input.nextControlTokenSha256 !== "string" ||
				!SHA256_PATTERN.test(input.nextControlTokenSha256) ||
				!Number.isSafeInteger(input.controlTokenSeconds) ||
				(input.controlTokenSeconds as number) < 300 ||
				(input.controlTokenSeconds as number) > 604_800
			) {
				throw new Error("Invalid orchestrator control rotation");
			}
			return {
				action: input.action,
				orchestratorId,
				nextControlTokenSha256: input.nextControlTokenSha256,
				controlTokenSeconds: input.controlTokenSeconds as number,
			};
		case "routine_heads":
			return {
				action: input.action,
				orchestratorId,
				...(input.afterRoutineId === null || input.afterRoutineId === undefined
					? {}
					: { afterRoutineId: uuid(input.afterRoutineId, "routine cursor") }),
				limit: integer(input.limit, "routine page limit", 500),
			};
		case "enqueue_wake": {
			const payload = record(input.payload, "wake payload");
			if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 8 * 1024) {
				throw new Error("Invalid wake payload");
			}
			if (
				typeof input.scheduledFor !== "string" ||
				!Number.isFinite(Date.parse(input.scheduledFor)) ||
				(input.expectedLastScheduledFor !== undefined &&
					(typeof input.expectedLastScheduledFor !== "string" ||
						!Number.isFinite(Date.parse(input.expectedLastScheduledFor)))) ||
				typeof input.nextDueAt !== "string" ||
				!Number.isFinite(Date.parse(input.nextDueAt)) ||
				Date.parse(input.nextDueAt) <= Date.parse(input.scheduledFor)
			) {
				throw new Error("Invalid wake schedule");
			}
			return {
				action: input.action,
				orchestratorId,
				routineId: uuid(input.routineId, "routine id"),
				expectedVersion: integer(input.expectedVersion, "routine version", 1_000_000),
				occurrenceId: uuid(input.occurrenceId, "occurrence id"),
				occurrenceKey: text(input.occurrenceKey, "occurrence key", 256),
				triggerId: text(input.triggerId, "trigger id", 160),
				scheduledFor: new Date(input.scheduledFor).toISOString(),
				...(typeof input.expectedLastScheduledFor === "string"
					? { expectedLastScheduledFor: new Date(input.expectedLastScheduledFor).toISOString() }
					: {}),
				nextDueAt: new Date(input.nextDueAt).toISOString(),
				payload,
			};
		}
		case "advance_next_due":
			if (
				(input.expectedLastScheduledFor !== undefined &&
					(typeof input.expectedLastScheduledFor !== "string" ||
						!Number.isFinite(Date.parse(input.expectedLastScheduledFor)))) ||
				typeof input.nextDueAt !== "string" ||
				!Number.isFinite(Date.parse(input.nextDueAt)) ||
				(typeof input.expectedLastScheduledFor === "string" &&
					Date.parse(input.nextDueAt) <= Date.parse(input.expectedLastScheduledFor))
			) {
				throw new Error("Invalid routine next due time");
			}
			return {
				action: input.action,
				orchestratorId,
				routineId: uuid(input.routineId, "routine id"),
				expectedVersion: integer(input.expectedVersion, "routine version", 1_000_000),
				triggerId: text(input.triggerId, "trigger id", 160),
				...(typeof input.expectedLastScheduledFor === "string"
					? { expectedLastScheduledFor: new Date(input.expectedLastScheduledFor).toISOString() }
					: {}),
				nextDueAt: new Date(input.nextDueAt).toISOString(),
			};
		// Folder-v2 dynamic routines (folder core C1c-3e).
		case "folder_dynamic_routines":
			return {
				action: input.action,
				orchestratorId,
				...(input.afterRoutineId === null || input.afterRoutineId === undefined
					? {}
					: { afterRoutineId: uuid(input.afterRoutineId, "routine cursor") }),
				limit: integer(input.limit, "routine page limit", 500),
			};
		case "restore_dynamic_routine":
			return {
				action: input.action,
				orchestratorId,
				routineId: uuid(input.routineId, "routine id"),
				expectedVersion: integer(input.expectedVersion, "routine version", 1_000_000),
			};
		// Folder-v2 runs, one company per request (folder core C4, P28).
		case "folder_materialize_due":
			return {
				action: input.action,
				orchestratorId,
				...(input.afterProfileId === null || input.afterProfileId === undefined
					? {}
					: { afterProfileId: uuid(input.afterProfileId, "company cursor") }),
				limit: integer(input.limit, "company page limit", 500),
			};
		case "folder_materialize_company":
			return {
				action: input.action,
				orchestratorId,
				profileId: uuid(input.profileId, "company id"),
				limit: integer(input.limit, "materialization limit", 16),
			};
		// The per-company folder drains, one company per request (folder core C4, P29).
		case "folder_drain_due":
			return {
				action: input.action,
				orchestratorId,
				drain: folderDrain(input.drain),
				...(input.afterEnvironmentId === null || input.afterEnvironmentId === undefined
					? {}
					: { afterEnvironmentId: uuid(input.afterEnvironmentId, "environment cursor") }),
				limit: integer(input.limit, "environment page limit", 500),
			};
		case "folder_drain_company": {
			const drain = folderDrain(input.drain);
			return {
				action: input.action,
				orchestratorId,
				drain,
				environmentId: uuid(input.environmentId, "environment id"),
				limit: integer(input.limit, "folder drain limit", FOLDER_DRAINS[drain].maximum),
			};
		}
		// One answer for the ten lists of an idle pass (20260930612000).
		case "due_summary":
		case "reconcile":
		case "retained":
			return { action: input.action, orchestratorId };
		case "claim":
			return {
				action: input.action,
				orchestratorId,
				clientClaimId: uuid(input.clientClaimId, "client claim id"),
				leaseSeconds: seconds(input.leaseSeconds, "claim lease"),
			};
		case "renew_claim":
			return {
				action: input.action,
				orchestratorId,
				claimId: uuid(input.claimId, "orchestrator claim id"),
				leaseSeconds: seconds(input.leaseSeconds, "claim lease"),
			};
		case "assign":
			if (typeof input.capabilitySha256 !== "string" || !SHA256_PATTERN.test(input.capabilitySha256)) {
				throw new Error("Invalid assignment capability hash");
			}
			return {
				action: input.action,
				orchestratorId,
				claimId: uuid(input.claimId, "orchestrator claim id"),
				runnerId: uuid(input.runnerId, "runner id"),
				clientAssignmentId: uuid(input.clientAssignmentId, "client assignment id"),
				capabilitySha256: input.capabilitySha256,
				assignmentSeconds: seconds(input.assignmentSeconds, "assignment lifetime"),
			};
		case "release_claim": {
			if (
				typeof input.error !== "string" ||
				input.error !== input.error.trim() ||
				input.error.length < 1 ||
				input.error.length > 1000
			) {
				throw new Error("Invalid runner delivery failure");
			}
			return {
				action: input.action,
				orchestratorId,
				claimId: uuid(input.claimId, "orchestrator claim id"),
				clientAssignmentId: uuid(input.clientAssignmentId, "client assignment id"),
				error: input.error,
			};
		}
		case "surface_claim_jobs": {
			let lane: "all" | "sessions" | "folder" | "code_repo" | undefined;
			if (input.lane !== undefined) {
				if (typeof input.lane !== "string" || !SURFACE_CLAIM_LANES.has(input.lane)) {
					throw new Error("Invalid surface claim lane");
				}
				lane = input.lane as "all" | "sessions" | "folder" | "code_repo";
			}
			return {
				action: input.action,
				orchestratorId,
				limit: input.limit === undefined ? 16 : integer(input.limit, "surface job limit", 64),
				...(lane !== undefined ? { lane } : {}),
			};
		}
		case "surface_enqueue_session_run":
			return {
				action: input.action,
				orchestratorId,
				sessionId: uuid(input.sessionId, "surface session id"),
				leaseToken: uuid(input.leaseToken, "surface lease token"),
			};
		case "surface_trigger_automation":
			return {
				action: input.action,
				orchestratorId,
				automationId: uuid(input.automationId, "surface automation id"),
			};
		case "surface_update_rebased_changes": {
			let rebasedChanges: { changeId: string; parentSha: string; headSha: string }[] | undefined;
			if (input.rebasedChanges !== undefined && input.rebasedChanges !== null) {
				if (!Array.isArray(input.rebasedChanges) || input.rebasedChanges.length > 64) {
					throw new Error("Invalid rebased surface changes");
				}
				rebasedChanges = input.rebasedChanges.map((item) => {
					const entry = record(item, "rebased surface change");
					const changeId = uuid(entry.changeId, "rebased change id");
					if (
						typeof entry.parentSha !== "string" ||
						!GIT_SHA_PATTERN.test(entry.parentSha) ||
						typeof entry.headSha !== "string" ||
						!GIT_SHA_PATTERN.test(entry.headSha)
					) {
						throw new Error("Invalid rebased change sha");
					}
					return { changeId, parentSha: entry.parentSha, headSha: entry.headSha };
				});
			}
			let branchHeadSha: string | undefined;
			if (input.branchHeadSha !== undefined && input.branchHeadSha !== null) {
				if (typeof input.branchHeadSha !== "string" || !GIT_SHA_PATTERN.test(input.branchHeadSha)) {
					throw new Error("Invalid surface branch head sha");
				}
				branchHeadSha = input.branchHeadSha;
			}
			return {
				action: input.action,
				orchestratorId,
				surfaceId: uuid(input.surfaceId, "surface id"),
				sessionId: uuid(input.sessionId, "surface session id"),
				...(branchHeadSha !== undefined ? { branchHeadSha } : {}),
				...(rebasedChanges !== undefined ? { rebasedChanges } : {}),
				...(input.conflictedChangeId === null || input.conflictedChangeId === undefined
					? {}
					: { conflictedChangeId: uuid(input.conflictedChangeId, "conflicted change id") }),
				...(input.conflictPaths === null || input.conflictPaths === undefined
					? {}
					: { conflictPaths: textArray(input.conflictPaths, "rebase conflict paths", 256, 512) }),
			};
		}
		case "surface_renew_lease": {
			if (typeof input.kind !== "string" || !SURFACE_LEASE_KINDS.has(input.kind)) {
				throw new Error("Invalid surface lease kind");
			}
			return {
				action: input.action,
				orchestratorId,
				kind: input.kind as "session" | "preview" | "job",
				id: uuid(input.id, "surface lease target id"),
				leaseToken: uuid(input.leaseToken, "surface lease token"),
				extendSeconds: input.extendSeconds === undefined ? 300 : seconds(input.extendSeconds, "surface lease seconds"),
			};
		}
		case "surface_release_session_claim":
			return {
				action: input.action,
				orchestratorId,
				sessionId: uuid(input.sessionId, "surface session id"),
				leaseToken: uuid(input.leaseToken, "surface lease token"),
			};
		case "surface_complete_preview": {
			if (typeof input.status !== "string" || !SURFACE_PREVIEW_COMPLETION_STATUSES.has(input.status)) {
				throw new Error("Invalid surface preview status");
			}
			return {
				action: input.action,
				orchestratorId,
				previewId: uuid(input.previewId, "surface preview id"),
				status: input.status as "ready" | "conflicted" | "failed",
				...(input.compositeTreeSha === null || input.compositeTreeSha === undefined
					? {}
					: { compositeTreeSha: text(input.compositeTreeSha, "composite tree sha", 64) }),
				...(input.siteVersionId === null || input.siteVersionId === undefined
					? {}
					: { siteVersionId: uuid(input.siteVersionId, "site version id") }),
				...(input.conflictReport === null || input.conflictReport === undefined
					? {}
					: { conflictReport: boundedRecord(input.conflictReport, "preview conflict report", 16 * 1024) }),
				...(input.errorDetail === null || input.errorDetail === undefined
					? {}
					: { errorDetail: errorDetail(input.errorDetail, "preview error detail") }),
				...(input.leaseToken === null || input.leaseToken === undefined
					? {}
					: { leaseToken: uuid(input.leaseToken, "surface lease token") }),
			};
		}
		case "surface_complete_session_turn": {
			if (typeof input.state !== "string" || !SURFACE_SESSION_COMPLETION_STATES.has(input.state)) {
				throw new Error("Invalid surface session state");
			}
			return {
				action: input.action,
				orchestratorId,
				sessionId: uuid(input.sessionId, "surface session id"),
				state: input.state as "needs_input" | "ready" | "completed" | "failed",
				...(input.replyText === null || input.replyText === undefined
					? {}
					: { replyText: surfaceReplyText(input.replyText, "surface session reply") }),
				...(input.question === null || input.question === undefined
					? {}
					: { question: boundedRecord(input.question, "surface session question", 8 * 1024) }),
				...(input.notePaths === null || input.notePaths === undefined
					? {}
					: { notePaths: textArray(input.notePaths, "surface session note paths", 64, 512) }),
				...(input.branchHeadSha === null || input.branchHeadSha === undefined
					? {}
					: { branchHeadSha: text(input.branchHeadSha, "surface branch head sha", 64) }),
				...(input.leaseToken === null || input.leaseToken === undefined
					? {}
					: { leaseToken: uuid(input.leaseToken, "surface lease token") }),
			};
		}
		case "surface_complete_merge": {
			if (typeof input.status !== "string" || !SURFACE_MERGE_COMPLETION_STATUSES.has(input.status)) {
				throw new Error("Invalid surface merge status");
			}
			return {
				action: input.action,
				orchestratorId,
				jobId: uuid(input.jobId, "surface merge job id"),
				status: input.status as "landed" | "conflicted" | "failed",
				...(input.mainBefore === null || input.mainBefore === undefined
					? {}
					: { mainBefore: text(input.mainBefore, "merge main before sha", 64) }),
				...(input.mainAfter === null || input.mainAfter === undefined
					? {}
					: { mainAfter: text(input.mainAfter, "merge main after sha", 64) }),
				...(input.conflictChangeId === null || input.conflictChangeId === undefined
					? {}
					: { conflictChangeId: uuid(input.conflictChangeId, "merge conflict change id") }),
				...(input.conflictPaths === null || input.conflictPaths === undefined
					? {}
					: { conflictPaths: textArray(input.conflictPaths, "merge conflict paths", 256, 512) }),
				...(input.errorDetail === null || input.errorDetail === undefined
					? {}
					: { errorDetail: errorDetail(input.errorDetail, "merge error detail") }),
				...(input.preMergeSnapshot === null || input.preMergeSnapshot === undefined
					? {}
					: { preMergeSnapshot: boundedRecord(input.preMergeSnapshot, "merge pre-merge snapshot", 96 * 1024) }),
				...(input.leaseToken === null || input.leaseToken === undefined
					? {}
					: { leaseToken: uuid(input.leaseToken, "surface lease token") }),
			};
		}
		case "surface_complete_publish": {
			if (typeof input.status !== "string" || !SURFACE_PUBLISH_COMPLETION_STATUSES.has(input.status)) {
				throw new Error("Invalid surface publish status");
			}
			return {
				action: input.action,
				orchestratorId,
				jobId: uuid(input.jobId, "surface publish job id"),
				status: input.status as "published" | "failed",
				...(input.publishedHeadSha === null || input.publishedHeadSha === undefined
					? {}
					: { publishedHeadSha: text(input.publishedHeadSha, "published head sha", 64) }),
				...(input.errorDetail === null || input.errorDetail === undefined
					? {}
					: { errorDetail: errorDetail(input.errorDetail, "publish error detail") }),
				...(input.leaseToken === null || input.leaseToken === undefined
					? {}
					: { leaseToken: uuid(input.leaseToken, "surface lease token") }),
			};
		}
		default:
			throw new Error("Invalid orchestrator action");
	}
}

export async function readRunnerOrchestratorRequest(
	request: Request,
	timeoutMs = DEFAULT_BODY_READ_TIMEOUT_MS,
): Promise<RunnerOrchestratorRequest> {
	const text = await readBoundedText(request, MAX_BODY_BYTES, {
		signal: request.signal,
		timeoutMs,
		sizeErrorMessage: "Invalid orchestrator request size",
	});
	return parseRunnerOrchestratorRequest(JSON.parse(text));
}

export function runnerOrchestratorRpcStatus(error: { code?: string }): number {
	if (error.code === "42501") return 401;
	if (error.code === "40001" || error.code === "23505") return 409;
	if (error.code === "55000") return 423;
	return 503;
}

export function orchestratorAuthFailure(
	validationError: { code?: string } | null | undefined,
	valid: unknown,
): { readonly status: number; readonly error: string } | null {
	if (validationError) {
		const status = runnerOrchestratorRpcStatus(validationError);
		return {
			status,
			error: status === 401 ? "Orchestrator authorization was rejected" : "Orchestrator authorization is unavailable",
		};
	}
	if (valid !== true) {
		return { status: 401, error: "Orchestrator authorization was rejected" };
	}
	return null;
}
