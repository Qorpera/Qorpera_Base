import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { listSharedTrailSessions } from "../src/agent-runtime.ts";
import { CloudTrailSynchronizer } from "../src/cloud-trail-sync.ts";
import type { HostedSession, HostedSessionEvent } from "../src/hosted-primary.ts";

it("materializes explicit cloud sends before completion and replays them on another read-only client", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-mouth-delivery-"));
	try {
		const now = new Date().toISOString();
		const session: HostedSession = {
			sessionId: randomUUID(),
			clientSessionId: randomUUID(),
			profileId: randomUUID(),
			environmentId: randomUUID(),
			title: "Cloud agent",
			staffAgentId: randomUUID(),
			audience: { kind: "company" },
			createdByUserId: randomUUID(),
			status: "open",
			createdAt: now,
			updatedAt: now,
		};
		const runId = randomUUID();
		const execution = { kind: "run" as const, id: runId, claimantId: runId, runnerAssignmentId: randomUUID() };
		const progressId = randomUUID();
		const finalId = randomUUID();
		const events: HostedSessionEvent[] = [];
		for (const [index, phase] of (["progress", "final"] as const).entries()) {
			const id = phase === "progress" ? progressId : finalId;
			events.push({
				sessionId: session.sessionId,
				sequence: index + 1,
				eventId: id,
				eventType: "message",
				actorUserId: session.createdByUserId,
				execution,
				body: {
					schema: "qorpera.runner-transcript-entry/v1",
					entry: {
						type: "message",
						id,
						parentId: index === 0 ? null : progressId,
						timestamp: now,
						execution,
						delivery: { schema: "qorpera.agent-send/v1", phase },
						message: {
							role: "assistant",
							content: [{ type: "text", text: phase === "progress" ? "Working." : "Done." }],
						},
					},
				},
				eventHash: (index + 1).toString().repeat(64),
				createdAt: now,
			});
		}
		let visibleEvents = 1;
		const primary = {
			appendAccountEvent: vi.fn(async () => {
				throw new Error("The client cannot author cloud output");
			}),
			closeSession: vi.fn(async () => undefined),
			createSession: vi.fn(async () => {
				throw new Error("The client cannot create authority");
			}),
			getSessionByClient: vi.fn(async () => session),
			listSessionsPage: vi.fn(async () => ({ items: [session], hasMore: false })),
			readSessionEvents: vi.fn(async (_sessionId: string, cursor = 0) =>
				events.slice(0, visibleEvents).filter((event) => event.sequence > cursor),
			),
		};
		const machine = join(root, "first", "company");
		await mkdir(join(machine, "trail"), { recursive: true });
		const onCursorAdvanced = vi.fn();
		const first = new CloudTrailSynchronizer({
			root: machine,
			userData: join(root, "first", "cache"),
			profileId: session.profileId,
			environmentId: session.environmentId,
			primary,
			canWrite: () => false,
			onCursorAdvanced,
		});
		await expect(first.sync()).resolves.toMatchObject({
			entriesMaterialized: 1,
			eventsQuarantined: 0,
			eventsUploaded: 0,
		});
		expect(onCursorAdvanced).toHaveBeenCalledWith({
			hostedSessionId: session.sessionId,
			cursor: 1,
			requiresReload: true,
		});
		expect(listSharedTrailSessions(machine)[0]?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: progressId,
					delivery: { schema: "qorpera.agent-send/v1", phase: "progress" },
					message: { role: "assistant", content: [{ type: "text", text: "Working." }], qorperaRunId: runId },
				}),
			]),
		);
		visibleEvents = 2;
		await expect(first.sync()).resolves.toMatchObject({ entriesMaterialized: 1, eventsUploaded: 0 });
		await expect(first.sync()).resolves.toMatchObject({ entriesMaterialized: 0, eventsUploaded: 0 });
		const otherMachine = join(root, "second", "company");
		await mkdir(join(otherMachine, "trail"), { recursive: true });
		const second = new CloudTrailSynchronizer({
			root: otherMachine,
			userData: join(root, "second", "cache"),
			profileId: session.profileId,
			environmentId: session.environmentId,
			primary,
			canWrite: () => false,
		});
		await expect(second.sync()).resolves.toMatchObject({
			entriesMaterialized: 2,
			eventsUploaded: 0,
			eventsQuarantined: 0,
		});
		const replayed = listSharedTrailSessions(otherMachine)[0]?.entries.filter((entry) => entry.type === "message");
		expect(replayed?.map((entry) => entry.id)).toEqual([progressId, finalId]);
		expect(replayed?.[1]).toMatchObject({
			parentId: progressId,
			execution,
			delivery: { schema: "qorpera.agent-send/v1", phase: "final" },
		});
		expect(primary.appendAccountEvent).not.toHaveBeenCalled();
		expect(primary.createSession).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
