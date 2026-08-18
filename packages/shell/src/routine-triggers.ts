import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
	GitHubRoutineEventType,
	RoutineTrigger,
	ScheduledJob,
} from "@qorpera/pi-coding-agent/company-connections";
import { companyHostStorageFile } from "./company-host-storage.ts";
import { type GitHubCommandRunner, runGitHubCommand } from "./github-connection.ts";

export interface RoutineTriggerEvent {
	id: string;
	source: string;
	type: string;
	repository?: string;
	actor?: string;
	occurredAt: string;
	summary: string;
	payload: Record<string, unknown>;
}

export interface PendingRoutineTrigger {
	id: string;
	jobId: string;
	triggerId: string;
	event: RoutineTriggerEvent;
}

export interface RoutineTriggerState {
	version: 1;
	githubCursors: Record<string, string>;
	pending: PendingRoutineTrigger[];
	completedEventIds?: string[];
	customChecks?: Record<
		string,
		{ lastCheckedAt: string; failureStreak: number; lastError?: string; checkpoint?: string }
	>;
}

const MAX_COMPLETED_EVENT_IDS = 1_000;

interface GitHubRepositoryEvent {
	id: string;
	type: string;
	created_at: string;
	actor?: { login?: string };
	repo?: { name?: string };
	payload?: Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedGitHubEvent(event: GitHubRepositoryEvent): RoutineTriggerEvent | undefined {
	const payload = event.payload ?? {};
	const action = textValue(payload.action);
	let type: GitHubRoutineEventType | undefined;
	if (event.type === "PullRequestEvent") {
		const pullRequest = recordValue(payload.pull_request);
		if (action === "opened") type = "pull_request.opened";
		else if (action === "review_requested") type = "pull_request.review_requested";
		else if (action === "closed" && pullRequest?.merged === true) type = "pull_request.merged";
		else if (["edited", "reopened", "synchronize"].includes(action ?? "")) type = "pull_request.updated";
	} else if (event.type === "PullRequestReviewEvent") {
		const review = recordValue(payload.review);
		const state = textValue(review?.state)?.toLowerCase();
		if (state === "approved") type = "review.approved";
		else if (state === "changes_requested") type = "review.changes_requested";
	} else if (event.type === "IssueCommentEvent" && recordValue(payload.issue)?.pull_request) {
		type = "pull_request.comment";
	} else if (event.type === "PullRequestReviewCommentEvent") {
		type = "pull_request.review_comment";
	} else if (event.type === "CheckRunEvent" && action === "completed") {
		const conclusion = textValue(recordValue(payload.check_run)?.conclusion)?.toLowerCase();
		if (conclusion === "success") type = "check_run.succeeded";
		else if (conclusion) type = "check_run.failed";
	} else if (event.type === "IssuesEvent" && action === "assigned") {
		type = "issue.assigned";
	}
	if (!type || !event.id || !event.created_at) return undefined;
	const actor = textValue(event.actor?.login);
	const repository = textValue(event.repo?.name);
	return {
		id: event.id,
		source: "github",
		type,
		...(repository ? { repository } : {}),
		...(actor ? { actor } : {}),
		occurredAt: event.created_at,
		summary: `${type.replaceAll("_", " ").replace(".", " · ")}${actor ? ` by ${actor}` : ""}`,
		payload,
	};
}

export function parseGitHubRepositoryEvents(raw: string): GitHubRepositoryEvent[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((value) => {
			const record = recordValue(value);
			const id = textValue(record?.id);
			const type = textValue(record?.type);
			const createdAt = textValue(record?.created_at);
			if (!id || !type || !createdAt) return [];
			return [record as unknown as GitHubRepositoryEvent];
		});
	} catch {
		return [];
	}
}

export function routineTriggerStatePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return companyHostStorageFile(userData, id, "routine-triggers.json");
}

export function readRoutineTriggerState(path: string): RoutineTriggerState {
	if (!existsSync(path))
		return { version: 1, githubCursors: {}, pending: [], completedEventIds: [], customChecks: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as RoutineTriggerState;
		if (parsed.version !== 1 || !parsed.githubCursors || !Array.isArray(parsed.pending)) throw new Error("invalid");
		return {
			...parsed,
			completedEventIds: Array.isArray(parsed.completedEventIds) ? parsed.completedEventIds : [],
			customChecks: parsed.customChecks ?? {},
		};
	} catch {
		return { version: 1, githubCursors: {}, pending: [], completedEventIds: [], customChecks: {} };
	}
}

export function writeRoutineTriggerState(path: string, state: RoutineTriggerState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function githubTriggers(job: ScheduledJob): Array<Extract<RoutineTrigger, { kind: "github" }>> {
	return job.enabled && !job.suspendedReason
		? job.triggers.filter(
				(trigger): trigger is Extract<RoutineTrigger, { kind: "github" }> => trigger.kind === "github",
			)
		: [];
}

export async function pollGitHubRoutineTriggers(options: {
	jobs: readonly ScheduledJob[];
	state: RoutineTriggerState;
	run?: GitHubCommandRunner;
	signal?: AbortSignal;
}): Promise<RoutineTriggerState> {
	const run = options.run ?? runGitHubCommand;
	const next: RoutineTriggerState = {
		version: 1,
		githubCursors: { ...options.state.githubCursors },
		pending: [...options.state.pending],
		completedEventIds: [...(options.state.completedEventIds ?? [])],
		customChecks: { ...options.state.customChecks },
	};
	const repositories = new Map<
		string,
		Array<{ job: ScheduledJob; trigger: Extract<RoutineTrigger, { kind: "github" }> }>
	>();
	for (const job of options.jobs) {
		for (const trigger of githubTriggers(job)) {
			const list = repositories.get(trigger.repository) ?? [];
			list.push({ job, trigger });
			repositories.set(trigger.repository, list);
		}
	}
	for (const [repository, owners] of repositories) {
		const response = await run(
			["api", `repos/${repository}/events`, "-X", "GET", "-f", "per_page=100"],
			options.signal,
		);
		if (response.code !== 0 || response.cancelled || response.unavailable) continue;
		const events = parseGitHubRepositoryEvents(response.stdout);
		if (!events.length) continue;
		const previous = next.githubCursors[repository];
		next.githubCursors[repository] = events[0].id;
		if (!previous) continue;
		const boundary = events.findIndex((event) => event.id === previous);
		const unseen = boundary < 0 ? events : events.slice(0, boundary);
		for (const event of unseen.reverse()) {
			const normalized = normalizedGitHubEvent(event);
			if (!normalized) continue;
			for (const { job, trigger } of owners) {
				if (!trigger.events.includes(normalized.type as GitHubRoutineEventType)) continue;
				if (trigger.actors.length && (!normalized.actor || !trigger.actors.includes(normalized.actor))) continue;
				const id = `${job.id}:${trigger.id}:${normalized.id}`;
				if (next.pending.some((candidate) => candidate.id === id) || next.completedEventIds?.includes(id)) continue;
				next.pending.push({ id, jobId: job.id, triggerId: trigger.id, event: normalized });
			}
		}
	}
	return next;
}

export function completePendingRoutineTrigger(state: RoutineTriggerState, id: string): RoutineTriggerState {
	if (!state.pending.some((event) => event.id === id)) return state;
	return {
		...state,
		pending: state.pending.filter((event) => event.id !== id),
		completedEventIds: [...(state.completedEventIds ?? []).filter((completed) => completed !== id), id].slice(
			-MAX_COMPLETED_EVENT_IDS,
		),
	};
}

export interface DueCustomRoutineCheck {
	job: ScheduledJob;
	trigger: Extract<RoutineTrigger, { kind: "custom" }> & {
		monitor: NonNullable<Extract<RoutineTrigger, { kind: "custom" }>["monitor"]>;
	};
	lastCheckedAt?: string;
	checkpoint?: string;
}

function customCheckKey(jobId: string, triggerId: string): string {
	return `${jobId}:${triggerId}`;
}

export function dueCustomRoutineCheck(
	jobs: readonly ScheduledJob[],
	state: RoutineTriggerState,
	now = Date.now(),
): DueCustomRoutineCheck | undefined {
	for (const job of jobs) {
		if (!job.enabled || job.suspendedReason || !job.staffAgentId) continue;
		for (const trigger of job.triggers) {
			if (trigger.kind !== "custom" || !trigger.monitor) continue;
			const previous = state.customChecks?.[customCheckKey(job.id, trigger.id)];
			const lastCheckedAt = previous?.lastCheckedAt;
			const lastCheckedMs = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
			if (!Number.isFinite(lastCheckedMs) || lastCheckedMs + trigger.monitor.intervalMinutes * 60_000 <= now) {
				return {
					job,
					trigger: { ...trigger, monitor: trigger.monitor },
					...(lastCheckedAt ? { lastCheckedAt } : {}),
					...(previous?.checkpoint ? { checkpoint: previous.checkpoint } : {}),
				};
			}
		}
	}
	return undefined;
}

export function recordCustomRoutineCheck(
	state: RoutineTriggerState,
	jobId: string,
	triggerId: string,
	result: { success: true; checkpoint?: string } | { success: false; error: string },
	now = new Date().toISOString(),
): RoutineTriggerState {
	const key = customCheckKey(jobId, triggerId);
	const previous = state.customChecks?.[key];
	return {
		...state,
		customChecks: {
			...state.customChecks,
			[key]: {
				lastCheckedAt: now,
				failureStreak: result.success ? 0 : (previous?.failureStreak ?? 0) + 1,
				...(result.success ? {} : { lastError: result.error.slice(0, 2_000) }),
				...(result.success && result.checkpoint !== undefined
					? { checkpoint: result.checkpoint }
					: previous?.checkpoint
						? { checkpoint: previous.checkpoint }
						: {}),
			},
		},
	};
}

export function queueCustomRoutineTrigger(
	jobs: readonly ScheduledJob[],
	state: RoutineTriggerState,
	event: RoutineTriggerEvent,
): RoutineTriggerState {
	const pending = [...state.pending];
	for (const job of jobs) {
		if (!job.enabled || job.suspendedReason) continue;
		for (const trigger of job.triggers) {
			if (trigger.kind !== "custom" || trigger.adapterId !== event.source || trigger.event !== event.type) continue;
			const id = `${job.id}:${trigger.id}:${event.id}`;
			if (!pending.some((candidate) => candidate.id === id) && !state.completedEventIds?.includes(id)) {
				pending.push({ id, jobId: job.id, triggerId: trigger.id, event });
			}
		}
	}
	return { ...state, pending };
}

export function persistRoutineTriggerEvent(root: string, pending: PendingRoutineTrigger): string {
	const directory = join(root, "inbox", "events");
	mkdirSync(directory, { recursive: true });
	const file = `evt-${pending.event.source}-${pending.event.id.replace(/[^a-z0-9_-]/gi, "-")}-${pending.jobId}.json`;
	writeFileSync(
		join(directory, file),
		`${JSON.stringify({ receivedAt: new Date().toISOString(), routine: pending }, null, "\t")}\n`,
		"utf-8",
	);
	return file;
}
