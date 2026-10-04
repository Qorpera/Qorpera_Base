const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 128 * 1024;

/** The per-company folder drains (folder core C4, P29: deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9): each name
 * the orchestrator may ask for, its due list's and one company's RPC (`(p_after_environment uuid, p_limit integer)` and
 * `(p_environment_id uuid, p_limit integer)`), and the most one company's request may take. A drain plugs in here and in
 * the orchestrator's list; an edge function without its entry answers 400, which pauses that drain alone. */
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
		default:
			throw new Error("Invalid orchestrator action");
	}
}

export async function readRunnerOrchestratorRequest(request: Request): Promise<RunnerOrchestratorRequest> {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
		throw new Error("Invalid orchestrator request size");
	}
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
		throw new Error("Invalid orchestrator request size");
	}
	return parseRunnerOrchestratorRequest(JSON.parse(text));
}

export function runnerOrchestratorRpcStatus(error: { code?: string }): number {
	if (error.code === "42501") return 401;
	if (error.code === "40001" || error.code === "23505") return 409;
	if (error.code === "55000") return 423;
	return 503;
}
