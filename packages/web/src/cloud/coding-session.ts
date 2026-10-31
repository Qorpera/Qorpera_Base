/* Coding sessions (Order 9): an agent starts one, a member owns and pays for it,
 * a harness runs it. The thread renders each session from the kernel's own view
 * and event stream (qorpera_list_coding_sessions, qorpera_read_coding_session),
 * never from the agent's prose. Shapes follow qorpera.coding-session/v1. */
import { array, boundedInteger, jsonValue, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";
import type { JsonValue } from "./types.ts";

export const CODING_HARNESSES = ["codex", "claude-code"] as const;
export type CodingHarness = (typeof CODING_HARNESSES)[number];

export const CODING_SESSION_PHASES = [
	"queued",
	"preparing",
	"running",
	"awaiting_input",
	"input_ready",
	"publishing",
	"completed",
	"failed",
	"cancelled",
] as const;
export type CodingSessionPhase = (typeof CODING_SESSION_PHASES)[number];

export const CODING_SESSION_EVENT_KINDS = [
	"phase",
	"step",
	"text",
	"needs_input",
	"input",
	"delegated",
	"published",
	"finished",
	"failed",
] as const;
export type CodingSessionEventKind = (typeof CODING_SESSION_EVENT_KINDS)[number];

export const CODING_SESSION_ACTORS = ["kernel", "harness", "member", "agent", "executor"] as const;
export type CodingSessionActor = (typeof CODING_SESSION_ACTORS)[number];

export interface CodingRepository {
	host: string;
	owner: string;
	name: string;
	baseBranch: string;
}

export interface CodingPullRequest {
	url: string;
	number: number;
	headSha?: string;
	title?: string;
}

export interface CodingCheck {
	name: string;
	status: string;
}

export interface CodingSession {
	workerId: string;
	workerKey: string;
	title: string;
	agentId: string;
	ownerUserId: string;
	harness: CodingHarness;
	model?: string;
	repository: CodingRepository;
	branch: string;
	baseSha?: string;
	/** The turn the session is on; follow-ups and answers each start a new one. */
	sequence: number;
	workerState: string;
	phase: CodingSessionPhase;
	lastStep?: string;
	filesChanged: number;
	pullRequest?: CodingPullRequest;
	checks: CodingCheck[];
	artifacts: JsonValue[];
	/** The question the session is waiting on, while it waits. */
	needs?: string;
	summary?: string;
	/** When the session's first turn was first claimed; later turns keep it (ui/coding-session.ts
	 * codingTurnStartedAt dates the current turn). */
	startedAt?: string;
	finishedAt?: string;
	updatedAt: string;
	createdAt: string;
	/** The conversation the agent dispatched from. */
	sessionId?: string;
	/** Whether the signed-in member owns the session (only the listing says). */
	isOwner?: boolean;
	/** Whether the cloud keeps sessions on their machine between turns (its view names `attached`). Before it
	 * does, nothing about standing by or archiving is shown, and Archive is not offered. */
	standby: boolean;
	/** Archived: taken off its machine, files kept; a new message reopens it. */
	archivedAt?: string;
	/** On its awake machine between turns (standing by), with what it left running. */
	attached: boolean;
	/** Commands still running at the last look, while attached. */
	runningCommands: number;
	/** Its machine is asleep: programs stopped, files kept, the next message wakes it. */
	machineAsleep: boolean;
	/** When this client asked for this copy (performance clock). The cloud moves `updatedAt` with the turn's own
	 * changes (its phase, its steps, the executor's heartbeat while it runs), not when the session stands by,
	 * sleeps or is archived, so of two copies with the same `updatedAt` the one asked for later knows more. */
	askedAt?: number;
}

/** Orders two copies of a session: positive when `a` is the newer, 0 when they are the same copy. */
export function compareCodingSessions(
	a: Pick<CodingSession, "updatedAt" | "askedAt">,
	b: Pick<CodingSession, "updatedAt" | "askedAt">,
): number {
	return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || (a.askedAt ?? 0) - (b.askedAt ?? 0);
}

/** Still going: neither settled nor archived. An archived session that was asking waits for nothing. */
export function codingSessionGoing(session: Pick<CodingSession, "phase" | "archivedAt">): boolean {
	return !codingSessionSettled(session.phase) && !session.archivedAt;
}

export interface CodingSessionEvent {
	id: number;
	sequence: number;
	kind: CodingSessionEventKind;
	actor: CodingSessionActor;
	body: JsonValue;
	at: string;
}

export interface CodingSessionRead {
	session: CodingSession;
	isOwner: boolean;
	events: CodingSessionEvent[];
}

/** Terminal for the executor: a follow-up or an answer starts the session again. */
export function codingSessionSettled(phase: CodingSessionPhase): boolean {
	return phase === "completed" || phase === "failed" || phase === "cancelled";
}

/** Whether the owner may type into the session now: it asked, or it is done (an
 * archived session too: the message reopens it). The kernel refuses input while
 * a turn is running. A session takes any number of turns. */
export function codingSessionTakesInput(session: Pick<CodingSession, "phase">): boolean {
	return session.phase === "awaiting_input" || codingSessionSettled(session.phase);
}

function optionalString(value: unknown, maximum = 32 * 1024): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : timestamp(value, label);
}

function parseRepository(value: unknown): CodingRepository {
	const item = record(value, "Coding repository");
	return {
		host: nonEmptyString(item.host, "Repository host", 253),
		owner: nonEmptyString(item.owner, "Repository owner", 100),
		name: nonEmptyString(item.name, "Repository name", 100),
		baseBranch: nonEmptyString(item.baseBranch, "Repository base branch", 250),
	};
}

function parsePullRequest(value: unknown): CodingPullRequest | undefined {
	if (value === null || value === undefined) return undefined;
	const item = record(value, "Pull request");
	const number = boundedInteger(item.number, "Pull request number", 1, Number.MAX_SAFE_INTEGER);
	return {
		url: nonEmptyString(item.url, "Pull request url", 2048),
		number,
		headSha: optionalString(item.headSha, 40),
		title: optionalString(item.title, 512),
	};
}

function parseChecks(value: unknown): CodingCheck[] {
	if (!Array.isArray(value)) return [];
	const checks: CodingCheck[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const item = entry as Record<string, unknown>;
		const name = optionalString(item.name, 200);
		if (!name) continue;
		checks.push({ name, status: optionalString(item.status, 64) ?? "unknown" });
	}
	return checks;
}

/** `askedAt`: when the request that returned it was sent. */
export function parseCodingSession(value: unknown, askedAt = performance.now()): CodingSession {
	const item = record(value, "Coding session");
	const session: CodingSession = {
		workerId: uuid(item.workerId, "Coding session worker id"),
		workerKey: nonEmptyString(item.workerKey, "Coding session worker key", 64),
		title: nonEmptyString(item.title, "Coding session title", 400),
		agentId: uuid(item.agentId, "Coding session agent id"),
		ownerUserId: uuid(item.ownerUserId, "Coding session owner id"),
		harness: oneOf(item.harness, CODING_HARNESSES, "Coding session harness"),
		repository: parseRepository(item.repository),
		branch: nonEmptyString(item.branch, "Coding session branch", 250),
		sequence: boundedInteger(item.sequence, "Coding session sequence", 1, Number.MAX_SAFE_INTEGER),
		workerState: nonEmptyString(item.workerState, "Coding session worker state", 32),
		phase: oneOf(item.phase, CODING_SESSION_PHASES, "Coding session phase"),
		filesChanged: typeof item.filesChanged === "number" && item.filesChanged >= 0 ? Math.floor(item.filesChanged) : 0,
		checks: parseChecks(item.checks),
		artifacts: Array.isArray(item.artifacts) ? item.artifacts.map(jsonValue) : [],
		updatedAt: timestamp(item.updatedAt, "Coding session updated at"),
		createdAt: timestamp(item.createdAt ?? item.updatedAt, "Coding session created at"),
		standby: Object.hasOwn(item, "attached"),
		attached: item.attached === true,
		runningCommands:
			typeof item.runningCommands === "number" && item.runningCommands > 0 ? Math.floor(item.runningCommands) : 0,
		machineAsleep: item.machineAsleep === true,
		askedAt,
	};
	const archivedAt = optionalTimestamp(item.archivedAt, "Coding session archived at");
	if (archivedAt) session.archivedAt = archivedAt;
	const model = optionalString(item.model, 96);
	if (model) session.model = model;
	const baseSha = optionalString(item.baseSha, 40);
	if (baseSha) session.baseSha = baseSha;
	const lastStep = optionalString(item.lastStep, 200);
	if (lastStep) session.lastStep = lastStep;
	const pullRequest = parsePullRequest(item.pullRequest);
	if (pullRequest) session.pullRequest = pullRequest;
	const needs = optionalString(item.needs, 1000);
	if (needs) session.needs = needs;
	const summary = optionalString(item.summary, 4000);
	if (summary) session.summary = summary;
	const startedAt = optionalTimestamp(item.startedAt, "Coding session started at");
	if (startedAt) session.startedAt = startedAt;
	const finishedAt = optionalTimestamp(item.finishedAt, "Coding session finished at");
	if (finishedAt) session.finishedAt = finishedAt;
	if (typeof item.sessionId === "string") session.sessionId = uuid(item.sessionId, "Coding session conversation id");
	if (typeof item.isOwner === "boolean") session.isOwner = item.isOwner;
	return session;
}

/** qorpera_list_coding_sessions: the sessions dispatched from one conversation, oldest first. */
export function parseCodingSessions(value: unknown, askedAt = performance.now()): CodingSession[] {
	const page = record(value, "Coding sessions");
	return array(page.sessions, "Coding sessions").map((session) => parseCodingSession(session, askedAt));
}

export function parseCodingSessionEvent(value: unknown): CodingSessionEvent {
	const item = record(value, "Coding session event");
	return {
		id: boundedInteger(item.id, "Coding session event id", 1, Number.MAX_SAFE_INTEGER),
		sequence: boundedInteger(item.sequence, "Coding session event sequence", 1, Number.MAX_SAFE_INTEGER),
		kind: oneOf(item.kind, CODING_SESSION_EVENT_KINDS, "Coding session event kind"),
		actor: oneOf(item.actor, CODING_SESSION_ACTORS, "Coding session event actor"),
		body: jsonValue(item.body ?? {}),
		at: timestamp(item.at, "Coding session event time"),
	};
}

/** qorpera_read_coding_session: the view plus the events after a cursor. */
export function parseCodingSessionRead(value: unknown, askedAt = performance.now()): CodingSessionRead {
	const item = record(value, "Coding session read");
	return {
		session: parseCodingSession(item.session, askedAt),
		isOwner: item.isOwner === true,
		events: array(item.events, "Coding session events").map(parseCodingSessionEvent),
	};
}
