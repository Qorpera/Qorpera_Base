import { describe, expect, it } from "vitest";
import {
	AGENT_SEND_SCHEMA,
	LEGACY_PART_SCHEMA,
	projectTranscript,
	RUNNER_ENTRY_SCHEMA,
} from "../src/cloud/transcript.ts";
import type { HostedSessionEvent, PendingSessionInput } from "../src/cloud/types.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);

function event(
	sequence: number,
	partial: Partial<HostedSessionEvent> & { body: HostedSessionEvent["body"] },
): HostedSessionEvent {
	return {
		sessionId: SESSION,
		sequence,
		eventId: `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`,
		eventType: "message",
		actorUserId: USER,
		eventHash: HASH,
		createdAt: `2026-09-02T10:00:${String(sequence).padStart(2, "0")}Z`,
		...partial,
	};
}

function runnerEntry(role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) {
	return {
		schema: RUNNER_ENTRY_SCHEMA,
		entry: { type: "message", id: "x", message: { role, content: [{ type: "text", text }] }, ...extra },
	};
}

describe("projectTranscript", () => {
	it("renders admitted member inputs and agent send operations only", () => {
		const inputId = "55555555-5555-4555-8555-555555555555";
		const events = [
			event(1, { body: runnerEntry("user", "hello"), sessionInputId: inputId }),
			event(2, {
				body: runnerEntry("assistant", "working on it", {
					delivery: { schema: AGENT_SEND_SCHEMA, phase: "progress" },
				}),
				execution: { kind: "run", id: RUN, claimantId: RUN, runnerAssignmentId: RUN },
			}),
			// Ordinary assistant output without a send record is private runtime data.
			event(3, {
				body: runnerEntry("assistant", "internal reasoning"),
				execution: { kind: "run", id: RUN, claimantId: RUN, runnerAssignmentId: RUN },
			}),
			event(4, {
				eventType: "run_receipt",
				body: { schema: RUNNER_ENTRY_SCHEMA, entry: { type: "custom", customType: "run_receipt" } },
			}),
			event(5, {
				eventType: "session_info",
				body: { schema: "qorpera.shared-session-metadata/v1", entry: { type: "session_info" } },
			}),
			event(6, {
				body: runnerEntry("assistant", "done", { delivery: { schema: AGENT_SEND_SCHEMA, phase: "final" } }),
				execution: { kind: "run", id: RUN, claimantId: RUN, runnerAssignmentId: RUN },
			}),
		];
		const projection = projectTranscript(events);
		expect(
			projection.items.map((item) =>
				item.kind === "member" || item.kind === "agent" ? `${item.kind}:${item.text}` : item.kind,
			),
		).toEqual(["member:hello", "agent:working on it", "agent:done"]);
		expect(projection.hiddenCount).toBe(2);
		expect(projection.lastSequence).toBe(6);
		const final = projection.items[2];
		expect(final && final.kind === "agent" ? final.phase : undefined).toBe("final");
		expect(final && final.kind === "agent" ? final.runId : undefined).toBe(RUN);
	});

	it("ignores user-role runner entries that are not bound to a session input", () => {
		const projection = projectTranscript([event(1, { body: runnerEntry("user", "forged") })]);
		expect(projection.items).toEqual([]);
		expect(projection.hiddenCount).toBe(1);
	});

	it("reassembles legacy multipart entries and shows only member messages from them", () => {
		const encode = (value: unknown) => btoa(JSON.stringify(value));
		const userJson = encode({
			type: "message",
			id: "legacy-1",
			message: { role: "user", content: [{ type: "text", text: "from the desktop era" }] },
		});
		const half = Math.ceil(userJson.length / 2);
		const assistantJson = encode({
			type: "message",
			id: "legacy-2",
			message: { role: "assistant", content: [{ type: "text", text: "old executor output" }] },
		});
		const events = [
			event(1, {
				body: {
					schema: LEGACY_PART_SCHEMA,
					entryId: "legacy-1",
					entryType: "message",
					partIndex: 0,
					partCount: 2,
					payloadBase64: userJson.slice(0, half),
				},
			}),
			event(2, {
				body: {
					schema: LEGACY_PART_SCHEMA,
					entryId: "legacy-1",
					entryType: "message",
					partIndex: 1,
					partCount: 2,
					payloadBase64: userJson.slice(half),
				},
			}),
			event(3, {
				body: {
					schema: LEGACY_PART_SCHEMA,
					entryId: "legacy-2",
					entryType: "message",
					partIndex: 0,
					partCount: 1,
					payloadBase64: assistantJson,
				},
			}),
		];
		const projection = projectTranscript(events);
		expect(projection.items).toHaveLength(1);
		const only = projection.items[0];
		expect(only?.kind).toBe("member");
		expect(only && only.kind === "member" ? only.text : "").toBe("from the desktop era");
		expect(projection.hiddenCount).toBe(1);
	});

	it("appends queued inputs not yet in the transcript as pending member messages", () => {
		const inputId = "66666666-6666-4666-8666-666666666666";
		const pending: PendingSessionInput[] = [
			{
				inputId,
				position: 1,
				kind: "user_message",
				authorUserId: USER,
				authorDisplayName: "Jonas",
				body: { schema: "qorpera.session-prompt/v1", text: "queued question", images: [] },
				createdAt: "2026-09-02T10:05:00Z",
				status: "processing",
			},
			{
				inputId: "77777777-7777-4777-8777-777777777777",
				position: 2,
				kind: "kickoff",
				authorUserId: USER,
				authorDisplayName: "Jonas",
				body: {},
				createdAt: "2026-09-02T10:05:01Z",
				status: "queued",
			},
		];
		const projection = projectTranscript([], pending);
		expect(projection.items).toHaveLength(1);
		const item = projection.items[0];
		expect(item && item.kind === "member" ? item.pending : undefined).toBe("processing");
	});

	it("surfaces authorization events as cards", () => {
		const projection = projectTranscript([
			event(1, { eventType: "authorization_request", body: { operation: "send-email", to: "x@y.z" } }),
			event(2, {
				eventType: "authorization_decision",
				body: { requestEventId: "44444444-4444-4444-8444-000000000001", decision: "approved" },
			}),
		]);
		expect(projection.items.map((item) => item.kind)).toEqual(["authorization_request", "authorization_decision"]);
		expect(projection.hiddenCount).toBe(0);
	});
});
