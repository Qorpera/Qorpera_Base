import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, KernelExecutionIdentity } from "@qorpera/pi-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendKernelObservation,
	appendKernelSessionInfo,
	bindTrailSession,
	commitTrailAppend,
	listSharedTrailSessions,
	parseTrailAppendFrame,
	type TrailBinding,
	trailSessionStaffAgentId,
} from "../src/agent-runtime.ts";
import { CloudTrailSynchronizer, cloudTrailSyncStatePath } from "../src/cloud-trail-sync.ts";
import type {
	AppendHostedSessionEventInput,
	CreateHostedSessionInput,
	HostedSession,
	HostedSessionEvent,
	HostedSessionPage,
} from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const hostedSessionId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const runId = "e7c5380d-a213-460e-9c6d-35c6da9fa9f0";
const runnerAssignmentId = "46651b43-5769-45a5-bc1c-8fba94a52712";

class FakeHostedPrimary {
	readonly sessions: HostedSession[] = [];
	readonly events = new Map<string, HostedSessionEvent[]>();
	injectConcurrentEntry = false;
	failAfterNextAppend = false;
	readSessionEventsHook?: (sessionId: string, afterSequence: number) => void;

	#touch(session: HostedSession): void {
		session.updatedAt = new Date(Math.max(Date.now(), Date.parse(session.updatedAt) + 1)).toISOString();
	}

	async listSessionsPage(
		requestedEnvironmentId: string,
		after?: { updatedAt: string; sessionId: string },
		limit = 100,
	): Promise<HostedSessionPage> {
		const visible = this.sessions
			.filter((session) => session.environmentId === requestedEnvironmentId)
			.sort(
				(left, right) =>
					left.updatedAt.localeCompare(right.updatedAt) || left.sessionId.localeCompare(right.sessionId),
			)
			.filter(
				(session) =>
					!after ||
					session.updatedAt > after.updatedAt ||
					(session.updatedAt === after.updatedAt && session.sessionId > after.sessionId),
			);
		const items = visible.slice(0, limit);
		const last = items.at(-1);
		return {
			items,
			hasMore: visible.length > items.length,
			...(last ? { nextUpdatedAt: last.updatedAt, nextId: last.sessionId } : {}),
		};
	}

	async getSessionByClient(
		requestedEnvironmentId: string,
		clientSessionId: string,
	): Promise<HostedSession | undefined> {
		return this.sessions.find(
			(session) => session.environmentId === requestedEnvironmentId && session.clientSessionId === clientSessionId,
		);
	}

	async createSession(input: CreateHostedSessionInput): Promise<HostedSession> {
		const existing = this.sessions.find((session) => session.clientSessionId === input.clientSessionId);
		if (existing) return existing;
		const createdAt = new Date().toISOString();
		const session: HostedSession = {
			sessionId: hostedSessionId,
			clientSessionId: input.clientSessionId,
			profileId,
			environmentId: input.environmentId,
			title: input.title,
			staffAgentId: input.staffAgentId,
			parentSessionId: input.parentSessionId,
			executionScope: input.executionScope,
			companySnapshotId: input.companySnapshotId,
			staffVersion: input.staffVersion,
			status: "open",
			createdByUserId: actorUserId,
			createdAt,
			updatedAt: createdAt,
		};
		this.sessions.push(session);
		this.events.set(session.sessionId, []);
		return session;
	}

	async appendAccountEvent(input: AppendHostedSessionEventInput): Promise<HostedSessionEvent> {
		const session = this.sessions.find((candidate) => candidate.sessionId === input.sessionId);
		if (!session || session.status !== "open") throw new Error("session is closed");
		const events = this.events.get(input.sessionId);
		if (!events) throw new Error("session not found");
		if (this.injectConcurrentEntry) {
			this.injectConcurrentEntry = false;
			const entry = {
				type: "session_info",
				id: "concurrent-session-info",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "Concurrent update",
			};
			events.push({
				sessionId: input.sessionId,
				sequence: events.length + 1,
				eventId: "11111111-1111-4111-8111-111111111111",
				eventType: "session_info",
				actorUserId,
				body: {
					schema: "qorpera.shared-trail-entry-part/v1",
					entryId: entry.id,
					entryType: entry.type,
					partIndex: 0,
					partCount: 1,
					payloadBase64: Buffer.from(JSON.stringify(entry), "utf-8").toString("base64"),
				},
				previousHash: events.at(-1)?.eventHash,
				eventHash: (events.length + 1).toString(16).padStart(64, "0"),
				createdAt: new Date().toISOString(),
			});
			this.#touch(session);
			throw new Error("session event sequence changed (40001)");
		}
		const existing = events.find((event) => event.eventId === input.eventId);
		if (existing) {
			if (
				existing.eventType !== input.eventType ||
				JSON.stringify(existing.body) !== JSON.stringify(input.body) ||
				JSON.stringify(existing.execution) !== JSON.stringify(input.execution)
			) {
				throw new Error("event id is already bound to different content (23505)");
			}
			return existing;
		}
		if (input.expectedSequence !== undefined && input.expectedSequence !== events.length) {
			throw new Error("session event sequence changed (40001)");
		}
		const event: HostedSessionEvent = {
			sessionId: input.sessionId,
			sequence: events.length + 1,
			eventId: input.eventId,
			eventType: input.eventType,
			actorUserId,
			body: input.body as JsonValue,
			execution: input.execution,
			previousHash: events.at(-1)?.eventHash,
			eventHash: (events.length + 1).toString(16).padStart(64, "0"),
			createdAt: new Date().toISOString(),
		};
		events.push(event);
		this.#touch(session);
		if (this.failAfterNextAppend) {
			this.failAfterNextAppend = false;
			throw new Error("fetch failed after event commit");
		}
		return event;
	}

	async readSessionEvents(sessionId: string, afterSequence = 0, limit = 200): Promise<HostedSessionEvent[]> {
		this.readSessionEventsHook?.(sessionId, afterSequence);
		return (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence).slice(0, limit);
	}

	async closeSession(sessionId: string): Promise<void> {
		const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
		if (!session) throw new Error("session not found");
		session.status = "closed";
		this.#touch(session);
	}
}

function appendMessage(
	binding: TrailBinding,
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
	execution?: KernelExecutionIdentity,
) {
	const append = parseTrailAppendFrame(
		{
			type: "qorpera_trail_append",
			token: binding.token,
			entry: {
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message: { role, content: [{ type: "text", text }] },
			},
		},
		binding,
		execution,
	);
	if (!append) throw new Error("test message was rejected");
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-cloud-trail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("cloud trail synchronization", () => {
	it("does not create cloud authority for a metadata-only window until durable content exists", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const live = bindTrailSession(machine, machine, {
			actor: "company-agent",
			attended: true,
			staffAgentId: "financial-officer",
		});
		appendKernelSessionInfo(live, "Financial Officer");
		const primary = new FakeHostedPrimary();
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
			liveBindings: () => [live],
		});

		await expect(sync.sync()).resolves.toMatchObject({ sessionsCreated: 0, eventsUploaded: 0 });
		expect(primary.sessions).toHaveLength(0);

		appendMessage(live, "first-message", null, "user", "Create the durable conversation now.");
		await expect(sync.sync()).resolves.toMatchObject({ sessionsCreated: 1 });
		expect(primary.sessions).toHaveLength(1);
		expect(primary.events.get(hostedSessionId)?.length).toBeGreaterThan(0);
	});

	it("persists an immutable execution binding across restart and stamps every uploaded entry part", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const live = bindTrailSession(machine, machine, {
			actor: "company-agent",
			attended: true,
			staffAgentId: "financial-officer",
		});
		const primary = new FakeHostedPrimary();
		const execution = {
			kind: "turn" as const,
			id: "55555555-5555-4555-8555-555555555555",
			claimantId: "66666666-6666-4666-8666-666666666666",
		};
		appendMessage(live, "durable-answer", null, "assistant", "x".repeat(200_000), execution);
		const restarted = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
			liveBindings: () => [live],
		});
		await restarted.sync();
		const answerEvents = (primary.events.get(hostedSessionId) ?? []).filter(
			(event) =>
				event.body &&
				typeof event.body === "object" &&
				!Array.isArray(event.body) &&
				(event.body as Record<string, JsonValue>).entryId === "durable-answer",
		);
		expect(answerEvents.length).toBeGreaterThan(1);
		expect(answerEvents.every((event) => JSON.stringify(event.execution) === JSON.stringify(execution))).toBe(true);
	});

	it("reports a durable cursor advance without requiring a reload for a quarantine-only batch", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Quarantine-only recovery",
		});
		primary.events.get(hosted.sessionId)?.push({
			sessionId: hosted.sessionId,
			sequence: 1,
			eventId: "22222222-2222-4222-8222-222222222222",
			eventType: "message",
			actorUserId,
			body: { schema: "malicious.unknown/v1", payload: "ignored" },
			eventHash: "1".repeat(64),
			createdAt: new Date().toISOString(),
		});
		const advances: Array<{ hostedSessionId: string; cursor: number; requiresReload: boolean }> = [];
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
			onCursorAdvanced: (advance) => advances.push(advance),
		});

		await expect(sync.sync()).resolves.toMatchObject({
			eventsDownloaded: 1,
			eventsQuarantined: 1,
			entriesMaterialized: 0,
		});
		expect(advances).toEqual([{ hostedSessionId: hosted.sessionId, cursor: 1, requiresReload: false }]);
	});

	it("quarantines an unparseable event and continues materializing later events", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Quarantine recovery",
		});
		const events = primary.events.get(hosted.sessionId);
		if (!events) throw new Error("hosted session events were not created");
		events.push(
			{
				sessionId: hosted.sessionId,
				sequence: 1,
				eventId: "22222222-2222-4222-8222-222222222222",
				eventType: "message",
				actorUserId,
				body: { schema: "malicious.unknown/v1", payload: "ignored" },
				eventHash: "1".repeat(64),
				createdAt: new Date().toISOString(),
			},
			{
				sessionId: hosted.sessionId,
				sequence: 2,
				eventId: "33333333-3333-4333-8333-333333333333",
				eventType: "session_info",
				actorUserId,
				body: {
					schema: "qorpera.shared-session/v1",
					entry: {
						type: "session_info",
						id: "cloud-session-info:11111111-1111-4111-8111-111111111111",
						parentId: null,
						timestamp: new Date().toISOString(),
						name: "Quarantine recovery",
					},
				},
				previousHash: "1".repeat(64),
				eventHash: "2".repeat(64),
				createdAt: new Date().toISOString(),
			},
		);

		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});
		await expect(sync.sync()).resolves.toMatchObject({
			eventsDownloaded: 2,
			eventsQuarantined: 1,
			entriesMaterialized: 1,
		});
		expect(listSharedTrailSessions(machine)).toHaveLength(1);
		const state = JSON.parse(readFileSync(cloudTrailSyncStatePath(userData, machine, profileId), "utf-8")) as {
			sessions: Record<string, { cursor: number; quarantinedEvents: Array<{ eventId: string; reason: string }> }>;
		};
		expect(state.sessions[hosted.sessionId]).toMatchObject({
			cursor: 2,
			quarantinedEvents: [{ eventId: "22222222-2222-4222-8222-222222222222", reason: "unknown event schema" }],
		});
		expect((await sync.sync()).eventsDownloaded).toBe(0);
	});

	it("blocks completion at an execution-bound event that cannot be materialized", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Corrupt execution output",
		});
		const execution = {
			kind: "turn" as const,
			id: "55555555-5555-4555-8555-555555555555",
			claimantId: "66666666-6666-4666-8666-666666666666",
		};
		primary.events.get(hosted.sessionId)?.push({
			sessionId: hosted.sessionId,
			sequence: 1,
			eventId: "22222222-2222-4222-8222-222222222222",
			eventType: "message",
			actorUserId,
			body: { schema: "malicious.unknown/v1", payload: "invalid" },
			execution,
			eventHash: "1".repeat(64),
			createdAt: new Date().toISOString(),
		});
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});

		await expect(sync.sync()).rejects.toThrow("execution-bound hosted trail event");
		expect(sync.cursorForHostedSession(hosted.sessionId)).toBe(0);
		const state = JSON.parse(readFileSync(cloudTrailSyncStatePath(userData, machine, profileId), "utf-8")) as {
			sessions: Record<string, { quarantinedEvents: Array<{ eventId: string; reason: string }> }>;
		};
		expect(state.sessions[hosted.sessionId]?.quarantinedEvents).toEqual([
			expect.objectContaining({ eventId: "22222222-2222-4222-8222-222222222222", reason: "unknown event schema" }),
		]);
		await expect(sync.sync()).rejects.toThrow("execution-bound hosted trail event");
		const retriedState = JSON.parse(
			readFileSync(cloudTrailSyncStatePath(userData, machine, profileId), "utf-8"),
		) as typeof state;
		expect(retriedState.sessions[hosted.sessionId]?.quarantinedEvents).toHaveLength(1);
	});

	it("does not materialize message content disguised as unbound session metadata", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Metadata provenance",
		});
		const forgedEntry = {
			type: "message",
			id: "forged-unbound-message",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "forged" }] },
		};
		primary.events.get(hosted.sessionId)?.push({
			sessionId: hosted.sessionId,
			sequence: 1,
			eventId: "22222222-2222-4222-8222-222222222222",
			eventType: "session_info",
			actorUserId,
			body: {
				schema: "qorpera.shared-trail-entry-part/v1",
				entryId: forgedEntry.id,
				entryType: forgedEntry.type,
				partIndex: 0,
				partCount: 1,
				payloadBase64: Buffer.from(JSON.stringify(forgedEntry), "utf-8").toString("base64"),
			},
			eventHash: "1".repeat(64),
			createdAt: new Date().toISOString(),
		});
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});

		await expect(sync.sync()).resolves.toMatchObject({ eventsQuarantined: 1, entriesMaterialized: 0 });
		expect(listSharedTrailSessions(machine)).toHaveLength(0);
		expect(sync.cursorForHostedSession(hosted.sessionId)).toBe(1);
	});

	it("does not commit session discovery until every discovered transcript page is durable", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Crash-safe discovery",
		});
		const events = primary.events.get(hosted.sessionId);
		if (!events) throw new Error("hosted session events were not created");
		for (let index = 0; index < 501; index++) {
			const sequence = index + 1;
			events.push({
				sessionId: hosted.sessionId,
				sequence,
				eventId: randomUUID(),
				eventType: "session_info",
				actorUserId,
				body: {
					schema: "qorpera.shared-session/v1",
					entry: {
						type: "session_info",
						id: `crash-safe-metadata-${sequence}`,
						parentId: null,
						timestamp: new Date().toISOString(),
						name: `Metadata ${sequence}`,
					},
				},
				previousHash: events.at(-1)?.eventHash,
				eventHash: sequence.toString(16).padStart(64, "0"),
				createdAt: new Date().toISOString(),
			});
		}
		const statePath = cloudTrailSyncStatePath(userData, machine, profileId);
		primary.readSessionEventsHook = (_sessionId, afterSequence) => {
			if (afterSequence !== 500) return;
			const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as { sessionDiscovery?: unknown };
			expect(persisted.sessionDiscovery).toBeUndefined();
			throw new Error("simulated process loss after first transcript page");
		};
		const interrupted = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});
		await expect(interrupted.sync()).rejects.toThrow("simulated process loss");
		expect(interrupted.cursorForHostedSession(hosted.sessionId)).toBe(500);

		primary.readSessionEventsHook = undefined;
		const restarted = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});
		await expect(restarted.sync()).resolves.toMatchObject({ eventsDownloaded: 1, entriesMaterialized: 1 });
		expect(restarted.cursorForHostedSession(hosted.sessionId)).toBe(501);
	});

	it("retires fully pulled closed sessions after advancing durable discovery", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Compact closed session",
		});
		await primary.appendAccountEvent({
			sessionId: hosted.sessionId,
			eventId: "22222222-2222-4222-8222-222222222222",
			eventType: "session_info",
			body: {
				schema: "qorpera.shared-session/v1",
				entry: {
					type: "session_info",
					id: "closed-session-info",
					parentId: null,
					timestamp: hosted.createdAt,
					name: hosted.title,
				},
			},
			expectedSequence: 0,
		});
		await primary.closeSession(hosted.sessionId);
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
		});
		await expect(sync.sync()).resolves.toMatchObject({ eventsDownloaded: 1, entriesMaterialized: 1 });
		const persisted = JSON.parse(readFileSync(cloudTrailSyncStatePath(userData, machine, profileId), "utf-8")) as {
			adoptedSessionIds: string[];
			sessions: Record<string, unknown>;
		};
		expect(persisted.sessions[hosted.sessionId]).toBeUndefined();
		expect(persisted.adoptedSessionIds).not.toContain(hosted.clientSessionId);
		const restarted = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
		});
		await expect(restarted.sync()).resolves.toMatchObject({ eventsDownloaded: 0, eventsUploaded: 0 });
		expect(restarted.cursorForHostedSession(hosted.sessionId)).toBeUndefined();
	});

	it("materializes a runner transcript entry with immutable run and assignment provenance", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Runner continuation",
		});
		const execution = {
			kind: "run" as const,
			id: runId,
			claimantId: runId,
			runnerAssignmentId,
		};
		const entry = {
			type: "message" as const,
			id: "22222222-2222-4222-8222-222222222222",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "Completed on the runner." }] },
			execution,
		};
		primary.events.get(hosted.sessionId)?.push({
			sessionId: hosted.sessionId,
			sequence: 1,
			eventId: entry.id,
			eventType: "message",
			actorUserId,
			body: { schema: "qorpera.runner-transcript-entry/v1", entry },
			execution,
			eventHash: "1".repeat(64),
			createdAt: new Date().toISOString(),
		});
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});

		await expect(sync.sync()).resolves.toMatchObject({
			eventsDownloaded: 1,
			eventsQuarantined: 0,
			entriesMaterialized: 1,
		});
		const materialized = listSharedTrailSessions(machine)[0]?.entries.find((candidate) => candidate.id === entry.id);
		expect(materialized).toMatchObject({
			type: "message",
			message: { role: "assistant", qorperaRunId: runId },
			execution,
		});
	});

	it("materializes a runner entry whose execution identity serializes with a different key order", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Runner key order",
		});
		/* Production shape: the runner writes id-first execution identity into
		 * the transcript body while the hosted event parser constructs
		 * kind-first. Equality must be field-based, not serialization-based. */
		const entryExecution = {
			id: runId,
			kind: "run" as const,
			claimantId: runId,
			runnerAssignmentId,
		};
		const eventExecution = {
			kind: "run" as const,
			id: runId,
			claimantId: runId,
			runnerAssignmentId,
		};
		const entry = {
			type: "message" as const,
			id: "33333333-3333-4333-8333-333333333333",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "Completed on the runner." }] },
			execution: entryExecution,
		};
		primary.events.get(hosted.sessionId)?.push({
			sessionId: hosted.sessionId,
			sequence: 1,
			eventId: entry.id,
			eventType: "message",
			actorUserId,
			body: { schema: "qorpera.runner-transcript-entry/v1", entry },
			execution: eventExecution,
			eventHash: "1".repeat(64),
			createdAt: new Date().toISOString(),
		});
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});

		await expect(sync.sync()).resolves.toMatchObject({
			eventsDownloaded: 1,
			eventsQuarantined: 0,
			entriesMaterialized: 1,
		});
	});

	it("does not re-upload runner history after the bounded entry cache rolls over", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Long runner history",
		});
		const execution = {
			kind: "run" as const,
			id: runId,
			claimantId: runId,
			runnerAssignmentId,
		};
		const events = primary.events.get(hosted.sessionId);
		if (!events) throw new Error("hosted session events were not created");
		for (let index = 1; index <= 2_050; index++) {
			const eventId = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
			events.push({
				sessionId: hosted.sessionId,
				sequence: index,
				eventId,
				eventType: "message",
				actorUserId,
				body: {
					schema: "qorpera.runner-transcript-entry/v1",
					entry: {
						type: "message",
						id: eventId,
						parentId: index === 1 ? null : `00000000-0000-4000-8000-${(index - 1).toString().padStart(12, "0")}`,
						timestamp: new Date().toISOString(),
						message: { role: "assistant", content: [{ type: "text", text: `Entry ${index}` }] },
						execution,
					},
				},
				execution,
				eventHash: index.toString(16).padStart(64, "0"),
				createdAt: new Date().toISOString(),
			});
		}
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
		});

		await expect(sync.sync()).resolves.toMatchObject({
			eventsDownloaded: 2_050,
			entriesMaterialized: 2_050,
			eventsUploaded: 1,
		});
		expect(listSharedTrailSessions(machine)[0]?.entries).toHaveLength(2_050);
		await expect(sync.sync()).resolves.toMatchObject({ eventsUploaded: 0, entriesMaterialized: 0 });
	});

	it("hydrates a control-plane-authored input image without trusting runner user-message provenance", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Input attachment continuity",
		});
		const inputId = "22222222-2222-4222-8222-222222222222";
		const image = Buffer.from("durable image bytes", "utf-8");
		const sha256 = createHash("sha256").update(image).digest("hex");
		primary.events.get(hosted.sessionId)?.push({
			sessionId: hosted.sessionId,
			sequence: 1,
			eventId: inputId,
			eventType: "message",
			actorUserId,
			sessionInputId: inputId,
			body: {
				schema: "qorpera.runner-transcript-entry/v1",
				entry: {
					type: "message",
					id: inputId,
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "Review this image" }] },
					qorperaAttachments: [{ objectSha256: sha256, bytes: image.byteLength, mediaType: "image/png" }],
				},
			},
			eventHash: "1".repeat(64),
			createdAt: new Date().toISOString(),
		});
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
			loadObject: async (reference) => {
				expect(reference).toEqual({ sha256, bytes: image.byteLength, mediaType: "image/png" });
				return image;
			},
		});

		await expect(sync.sync()).resolves.toMatchObject({ entriesMaterialized: 1, eventsQuarantined: 0 });
		const materialized = listSharedTrailSessions(machine)[0]?.entries.find((entry) => entry.id === inputId);
		expect(materialized).toMatchObject({
			message: {
				role: "user",
				content: [
					{ type: "text", text: "Review this image" },
					{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
				],
			},
		});
		expect(materialized).not.toHaveProperty("qorperaAttachments");
	});

	it("quarantines a conflicting part without destroying the entry's accumulated parts", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const primary = new FakeHostedPrimary();
		const hosted = await primary.createSession({
			environmentId,
			clientSessionId: "11111111-1111-4111-8111-111111111111",
			title: "Conflict resilience",
		});
		const events = primary.events.get(hosted.sessionId);
		if (!events) throw new Error("hosted session events were not created");
		const entry = {
			type: "session_info",
			id: "cloud-session-info:11111111-1111-4111-8111-111111111111",
			parentId: null,
			timestamp: new Date().toISOString(),
			name: "Conflict resilience",
		};
		const payload = Buffer.from(JSON.stringify(entry), "utf-8");
		const half = Math.ceil(payload.length / 2);
		const part = (partIndex: number, partCount: number, bytes: Buffer) => ({
			schema: "qorpera.shared-trail-entry-part/v1",
			entryId: entry.id,
			entryType: entry.type,
			partIndex,
			partCount,
			payloadBase64: bytes.toString("base64"),
		});
		events.push(
			{
				sessionId: hosted.sessionId,
				sequence: 1,
				eventId: "22222222-2222-4222-8222-222222222222",
				eventType: "session_info",
				actorUserId,
				body: part(0, 2, payload.subarray(0, half)),
				eventHash: "1".repeat(64),
				createdAt: new Date().toISOString(),
			},
			{
				sessionId: hosted.sessionId,
				sequence: 2,
				eventId: "33333333-3333-4333-8333-333333333333",
				eventType: "session_info",
				actorUserId,
				body: part(0, 1, payload),
				previousHash: "1".repeat(64),
				eventHash: "2".repeat(64),
				createdAt: new Date().toISOString(),
			},
			{
				sessionId: hosted.sessionId,
				sequence: 3,
				eventId: "44444444-4444-4444-8444-444444444444",
				eventType: "session_info",
				actorUserId,
				body: part(1, 2, payload.subarray(half)),
				previousHash: "2".repeat(64),
				eventHash: "3".repeat(64),
				createdAt: new Date().toISOString(),
			},
		);

		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});
		await expect(sync.sync()).resolves.toMatchObject({
			eventsDownloaded: 3,
			eventsQuarantined: 1,
			entriesMaterialized: 1,
		});
		expect(listSharedTrailSessions(machine)).toHaveLength(1);
		const state = JSON.parse(readFileSync(cloudTrailSyncStatePath(userData, machine, profileId), "utf-8")) as {
			sessions: Record<string, { cursor: number; quarantinedEvents: Array<{ eventId: string; reason: string }> }>;
		};
		expect(state.sessions[hosted.sessionId]).toMatchObject({
			cursor: 3,
			quarantinedEvents: [{ eventId: "33333333-3333-4333-8333-333333333333", reason: "entry parts conflict" }],
		});
	});

	it("retries a remotely committed event without duplicating it after the response is lost", async () => {
		const machine = join(root, "machine", "company");
		const userData = join(root, "machine", "user-data");
		mkdirSync(join(machine, "trail"), { recursive: true });
		const live = bindTrailSession(machine, machine, { actor: "company-agent", attended: true });
		appendKernelSessionInfo(live, "Recovery test");
		appendMessage(live, "recovery-message", null, "user", "Persist this conversation.");
		const primary = new FakeHostedPrimary();
		primary.failAfterNextAppend = true;
		const sync = new CloudTrailSynchronizer({
			root: machine,
			userData,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
			liveBindings: () => [live],
		});

		await expect(sync.sync()).rejects.toThrow("fetch failed after event commit");
		expect(primary.events.get(hostedSessionId)).toHaveLength(1);
		await expect(sync.sync()).resolves.toMatchObject({ sessionsCreated: 0 });
		const events = primary.events.get(hostedSessionId) ?? [];
		expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
	});

	it("round-trips a chunked chat between two machines and keeps live trail audits appendable", async () => {
		const machineA = join(root, "machine-a", "company");
		const machineB = join(root, "machine-b", "company");
		const userDataA = join(root, "machine-a", "user-data");
		const userDataB = join(root, "machine-b", "user-data");
		mkdirSync(join(machineA, "trail"), { recursive: true });
		mkdirSync(join(machineB, "trail"), { recursive: true });

		const liveA = bindTrailSession(machineA, machineA, {
			actor: "company-agent",
			attended: false,
			staffAgentId: "financial-officer",
		});
		appendKernelSessionInfo(liveA, "Financial Officer");
		appendKernelObservation(liveA, {
			frameType: "prompt",
			message: "x".repeat(200_000),
			attended: true,
			origin: `account:${actorUserId}:composer-attended`,
			intent: {
				nonce: "11111111-1111-4111-8111-111111111111",
				sessionId: liveA.sessionId,
				requestHash: "a".repeat(64),
				attended: true,
				issuedAt: "2026-08-16T00:00:00.000Z",
				expiresAt: "2026-08-16T01:00:00.000Z",
				budget: { maxCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
				signature: "kernel-signature",
			},
			images: [],
		});
		appendMessage(liveA, "question", liveA.audit.ids.values().next().value ?? null, "user", "x".repeat(200_000));
		appendKernelObservation(liveA, {
			frameType: "prompt",
			message: "This attended message must survive a model failure.",
			attended: true,
			origin: `account:${actorUserId}:composer-attended`,
			intent: {
				nonce: "22222222-2222-4222-8222-222222222222",
				sessionId: liveA.sessionId,
				requestHash: "b".repeat(64),
				attended: true,
				issuedAt: "2026-08-16T00:00:00.000Z",
				expiresAt: "2026-08-16T01:00:00.000Z",
				budget: { maxCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
				signature: "kernel-signature",
			},
			images: [],
		});

		const primary = new FakeHostedPrimary();
		const syncA = new CloudTrailSynchronizer({
			root: machineA,
			userData: userDataA,
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
			liveBindings: () => [liveA],
		});
		const first = await syncA.sync();
		expect(first).toMatchObject({ sessionsCreated: 1, entriesMaterialized: 0 });
		expect(first.eventsUploaded).toBe(5);

		let canWriteB = false;
		let liveB: TrailBinding | undefined;
		const syncB = new CloudTrailSynchronizer({
			root: machineB,
			userData: userDataB,
			profileId,
			environmentId,
			primary,
			canWrite: () => canWriteB,
			liveBindings: () => (liveB ? [liveB] : []),
			onMaterialized: (binding) => {
				liveB = binding;
			},
		});
		const viewerPull = await syncB.sync();
		expect(viewerPull.eventsUploaded).toBe(0);
		expect(viewerPull.entriesMaterialized).toBe(4);
		const onB = listSharedTrailSessions(machineB);
		expect(onB).toHaveLength(1);
		expect(onB[0]).toMatchObject({
			localSessionId: liveA.sessionId,
			title: "Financial Officer",
			staffAgentId: "financial-officer",
		});
		expect(onB[0].entries.find((entry) => entry.id === "question")).toMatchObject({
			type: "message",
			message: { role: "user" },
		});
		expect(
			onB[0].entries.find(
				(entry) =>
					entry.type === "message" &&
					(entry.message as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ===
						"This attended message must survive a model failure.",
			),
		).toBeDefined();
		expect(trailSessionStaffAgentId(machineB, onB[0].trailFile)).toBe("financial-officer");

		if (!liveB) throw new Error("machine B trail was not materialized");
		appendMessage(liveB, "answer", "question", "assistant", "We have 90 days of runway.");
		canWriteB = true;
		primary.injectConcurrentEntry = true;
		const contributorPush = await syncB.sync();
		expect(contributorPush.eventsUploaded).toBe(1);
		expect(contributorPush.entriesMaterialized).toBe(1);

		const returnPull = await syncA.sync();
		expect(returnPull.entriesMaterialized).toBe(2);
		expect(listSharedTrailSessions(machineA)[0].entries.find((entry) => entry.id === "answer")).toMatchObject({
			message: { role: "assistant" },
		});
		appendMessage(liveA, "follow-up", "answer", "user", "What should we defer?");
		expect(
			bindTrailSession(
				machineA,
				machineA,
				{ actor: "company-agent", attended: true, staffAgentId: "financial-officer" },
				liveA.file,
			).audit.sequence,
		).toBe(liveA.audit.sequence);

		const idempotent = await syncA.sync();
		expect(idempotent.entriesMaterialized).toBe(0);
		expect(idempotent.eventsDownloaded).toBe(0);
		expect(idempotent.eventsUploaded).toBe(1);
		expect((await syncA.sync()).eventsUploaded).toBe(0);
		expect(readFileSync(liveA.path, "utf-8").match(/"id":"answer"/g)).toHaveLength(1);
	});

	it("round-trips autonomous staff work with its operational scope", async () => {
		const machineA = join(root, "machine-a", "company");
		const machineB = join(root, "machine-b", "company");
		mkdirSync(join(machineA, "trail"), { recursive: true });
		mkdirSync(join(machineB, "trail"), { recursive: true });
		const live = bindTrailSession(machineA, machineA, {
			actor: "company-agent",
			attended: false,
			staffAgentId: "legal-agent",
			autonomousLabel: "Register ApS",
			group: "job:company-registration",
			companySnapshotId: "55555555-5555-4555-8555-555555555555",
			staffVersion: 4,
		});
		appendMessage(live, "operational-result", null, "assistant", "The registration claim was submitted.");
		const primary = new FakeHostedPrimary();
		const push = new CloudTrailSynchronizer({
			root: machineA,
			userData: join(root, "machine-a", "user-data"),
			profileId,
			environmentId,
			primary,
			canWrite: () => true,
		});
		await expect(push.sync()).resolves.toMatchObject({ sessionsCreated: 1 });
		await push.finalizeOperationalSession(live.sessionId);
		expect(primary.sessions[0]?.executionScope).toEqual({
			attended: false,
			staffAgentId: "legal-agent",
			autonomousLabel: "Register ApS",
			group: "job:company-registration",
			companySnapshotId: "55555555-5555-4555-8555-555555555555",
			staffVersion: 4,
		});
		expect(primary.sessions[0]).toMatchObject({
			companySnapshotId: "55555555-5555-4555-8555-555555555555",
			staffVersion: 4,
			status: "closed",
		});

		const pull = new CloudTrailSynchronizer({
			root: machineB,
			userData: join(root, "machine-b", "user-data"),
			profileId,
			environmentId,
			primary,
			canWrite: () => false,
		});
		await expect(pull.sync()).resolves.toMatchObject({ entriesMaterialized: 2 });
		const shared = listSharedTrailSessions(machineB);
		expect(shared).toHaveLength(1);
		expect(shared[0]).toMatchObject({
			staffAgentId: "legal-agent",
			scope: {
				attended: false,
				staffAgentId: "legal-agent",
				autonomousLabel: "Register ApS",
				group: "job:company-registration",
				companySnapshotId: "55555555-5555-4555-8555-555555555555",
				staffVersion: 4,
			},
		});
		expect(shared[0].entries).toContainEqual(
			expect.objectContaining({ id: "operational-result", message: expect.objectContaining({ role: "assistant" }) }),
		);
	});
});
