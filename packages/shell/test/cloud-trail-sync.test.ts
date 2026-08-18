import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/pi-protocol";
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
} from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const hostedSessionId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";

class FakeHostedPrimary {
	readonly sessions: HostedSession[] = [];
	readonly events = new Map<string, HostedSessionEvent[]>();
	injectConcurrentEntry = false;
	failAfterNextAppend = false;

	async listSessions(requestedEnvironmentId: string): Promise<HostedSession[]> {
		return this.sessions.filter((session) => session.environmentId === requestedEnvironmentId);
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
			throw new Error("session event sequence changed (40001)");
		}
		const existing = events.find((event) => event.eventId === input.eventId);
		if (existing) {
			if (existing.eventType !== input.eventType || JSON.stringify(existing.body) !== JSON.stringify(input.body)) {
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
			previousHash: events.at(-1)?.eventHash,
			eventHash: (events.length + 1).toString(16).padStart(64, "0"),
			createdAt: new Date().toISOString(),
		};
		events.push(event);
		if (this.failAfterNextAppend) {
			this.failAfterNextAppend = false;
			throw new Error("fetch failed after event commit");
		}
		return event;
	}

	async readSessionEvents(sessionId: string, afterSequence = 0, limit = 200): Promise<HostedSessionEvent[]> {
		return (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence).slice(0, limit);
	}
}

function appendMessage(
	binding: TrailBinding,
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
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
		const live = bindTrailSession(machine, machine, { actor: "controller", attended: true });
		appendKernelSessionInfo(live, "Recovery test");
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
			actor: "controller",
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
				{ actor: "controller", attended: true, staffAgentId: "financial-officer" },
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
});
