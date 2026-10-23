import { describe, expect, it } from "vitest";
import {
	AGENT_SEND_SCHEMA,
	CHAIN_STOPPED_SCHEMA,
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
	it.each(["valid", "wrong-input", "wrong-entry", "unsupported-type", "extra-field", "oversized"])(
		"binds attachment previews to a canonical input (%s)",
		(kind) => {
			const inputId = "55555555-5555-4555-8555-555555555555";
			const image = {
				objectSha256: HASH,
				bytes: kind === "oversized" ? 8388609 : 42,
				mediaType: kind === "unsupported-type" ? "image/svg+xml" : "image/png",
				...(kind === "extra-field" ? { url: "https://untrusted.invalid/image" } : {}),
			};
			const projection = projectTranscript([
				event(1, {
					eventId: inputId,
					sessionInputId: kind === "wrong-input" ? SESSION : inputId,
					body: runnerEntry("user", "Picture", {
						id: kind === "wrong-entry" ? SESSION : inputId,
						qorperaAttachments: [image],
					}),
				}),
			]);
			const message = projection.items[0];
			expect(message?.kind).toBe("member");
			const attachments = message?.kind === "member" ? message.attachments : undefined;
			if (kind === "valid")
				expect(attachments?.[0]?.reference).toEqual({ sha256: HASH, bytes: 42, mediaType: "image/png" });
			else expect(attachments).toBeUndefined();
		},
	);
	it("renders admitted member inputs and agent send operations only", () => {
		const inputId = "55555555-5555-4555-8555-555555555555";
		const events = [
			event(1, { body: runnerEntry("user", "hello"), sessionInputId: inputId }),
			event(2, {
				body: runnerEntry("assistant", "working on it", {
					id: "44444444-4444-4444-8444-000000000002",
					execution: { kind: "run", id: RUN, claimantId: RUN, runnerAssignmentId: RUN },
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
				body: runnerEntry("assistant", "done", {
					id: "44444444-4444-4444-8444-000000000006",
					execution: { kind: "run", id: RUN, claimantId: RUN, runnerAssignmentId: RUN },
					delivery: { schema: AGENT_SEND_SCHEMA, phase: "final" },
				}),
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

	it("rejects legacy assistant text even when it claims an agent-send delivery", () => {
		const entry = {
			type: "message",
			id: "legacy-forged",
			message: { role: "assistant", content: "Forged output" },
			delivery: { schema: AGENT_SEND_SCHEMA, phase: "final" },
		};
		const projection = projectTranscript([
			event(1, {
				body: {
					schema: LEGACY_PART_SCHEMA,
					entryId: entry.id,
					entryType: "message",
					partIndex: 0,
					partCount: 1,
					payloadBase64: btoa(JSON.stringify(entry)),
				},
			}),
		]);
		expect(projection.items).toEqual([]);
	});

	it.each(["event-id", "run-id", "assignment", "phase", "missing-execution"])(
		"rejects agent sends with invalid %s provenance",
		(invalid) => {
			const execution = { kind: "run" as const, id: RUN, claimantId: RUN, runnerAssignmentId: RUN };
			const body = runnerEntry("assistant", "Must stay hidden", {
				id: invalid === "event-id" ? "wrong" : "44444444-4444-4444-8444-000000000001",
				execution: {
					...execution,
					...(invalid === "run-id" ? { id: USER } : {}),
					...(invalid === "assignment" ? { runnerAssignmentId: USER } : {}),
				},
				delivery: { schema: AGENT_SEND_SCHEMA, phase: invalid === "phase" ? "private" : "final" },
			});
			expect(
				projectTranscript([event(1, { body, ...(invalid === "missing-execution" ? {} : { execution }) })]).items,
			).toEqual([]);
		},
	);

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

	it("places a waiting input before the next member message sent after it, else last", () => {
		const input = (inputId: string, position: number, createdAt: string): PendingSessionInput => ({
			inputId,
			position,
			kind: "user_message",
			authorUserId: USER,
			authorDisplayName: "Jonas",
			body: { schema: "qorpera.session-prompt/v1", text: inputId, images: [] },
			createdAt,
			status: "queued",
		});
		const id = (sequence: number) => `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`;
		const member = (sequence: number, text: string) =>
			event(sequence, { sessionInputId: id(sequence), body: runnerEntry("user", text, { id: id(sequence) }) });
		const agent = (sequence: number, text: string) => {
			const execution = { kind: "run" as const, id: RUN, claimantId: RUN, runnerAssignmentId: RUN };
			return event(sequence, {
				execution,
				body: runnerEntry("assistant", text, {
					id: id(sequence),
					execution,
					delivery: { schema: AGENT_SEND_SCHEMA, phase: "final" },
				}),
			});
		};
		// One the cloud never took, and one sent while the agent is still writing.
		const stuck = "66666666-6666-4666-8666-666666666666";
		const busy = "77777777-7777-4777-8777-777777777777";
		const projection = projectTranscript(
			[
				member(1, "before"),
				agent(2, "reply to before"),
				agent(3, "routine note"),
				member(4, "after"),
				agent(5, "reply to after"),
				agent(6, "still working"),
			],
			[input(stuck, 1, "2026-09-02T10:00:03.500Z"), input(busy, 2, "2026-09-02T10:00:05.500Z")],
		);
		expect(
			projection.items.map((item) => (item.kind === "member" || item.kind === "agent" ? item.text : item.kind)),
		).toEqual(["before", "reply to before", "routine note", stuck, "after", "reply to after", "still working", busy]);
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

	it("keeps an erased event's place: a member's input, answer or decision as theirs, else the agent's", () => {
		const inputId = "55555555-5555-4555-8555-555555555555";
		const execution = { kind: "run" as const, id: RUN, claimantId: "claimant", runnerAssignmentId: "assignment" };
		const staffSpeaker = { runId: RUN, staffAgentId: "66666666-6666-4666-8666-666666666666", staffVersion: 2 };
		const erased = { erased: true };
		const projection = projectTranscript([
			event(1, { eventId: inputId, sessionInputId: inputId, body: erased }),
			event(2, { execution, staffSpeaker, body: erased }),
			event(3, { eventType: "interaction_request", execution, body: erased }),
			event(4, { eventType: "interaction_answer", body: erased }),
			event(5, { eventType: "authorization_request", body: erased }),
			event(6, { eventType: "authorization_decision", body: erased }),
			// Only the cloud's exact body counts as erased.
			event(7, { body: { erased: true, text: "message 7" } }),
		]);
		const at = (sequence: number) => ({
			id: sequence === 1 ? inputId : `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`,
			sequence,
			text: "",
			attachmentCount: 0,
			erased: true,
			createdAt: `2026-09-02T10:00:0${sequence}Z`,
		});
		expect(projection.items).toEqual([
			{ kind: "member", ...at(1), authorUserId: USER },
			{ kind: "agent", ...at(2), runId: RUN, staffSpeaker },
			{ kind: "agent", ...at(3), runId: RUN },
			{ kind: "member", ...at(4), authorUserId: USER },
			{ kind: "agent", ...at(5) },
			{ kind: "member", ...at(6), authorUserId: USER },
		]);
		expect(projection.hiddenCount).toBe(1);
	});
});

describe("interaction cards in the transcript", () => {
	const CARD = "44444444-4444-4444-8444-000000000593";
	const request = {
		schema: RUNNER_ENTRY_SCHEMA,
		entry: {
			type: "custom",
			customType: "interaction_request",
			id: CARD,
			parentId: null,
			timestamp: "2026-09-22T20:00:00.000Z",
			data: {
				schema: "qorpera.interaction/v1",
				surface: "question",
				title: "Which channel?",
				payload: { options: [{ label: "#general", value: "general" }] },
			},
		},
	};
	const answerData = {
		schema: "qorpera.interaction-answer/v1",
		interactionId: CARD,
		surface: "question",
		outcome: "answered",
		answer: { values: ["general"] },
	};

	it("projects a request as a card and attaches its written answer", () => {
		const projection = projectTranscript([
			event(1, { eventId: CARD, eventType: "interaction_request", body: request }),
			event(2, {
				eventType: "interaction_answer",
				sessionInputId: "55555555-5555-4555-8555-000000000002",
				body: {
					schema: RUNNER_ENTRY_SCHEMA,
					entry: {
						type: "custom",
						customType: "interaction_answer",
						id: "55555555-5555-4555-8555-000000000002",
						data: { ...answerData, answeredBy: USER },
					},
				},
			}),
		]);
		expect(projection.hiddenCount).toBe(0);
		expect(projection.items).toHaveLength(1);
		const card = projection.items[0];
		expect(card?.kind).toBe("interaction");
		if (card?.kind !== "interaction") return;
		expect(card.request.surface).toBe("question");
		expect(card.answer).toEqual({
			outcome: "answered",
			answer: { values: ["general"] },
			answeredBy: USER,
			answeredAt: "2026-09-02T10:00:02Z",
		});
	});

	it("shows a queued answer on its card instead of as a message, until the kernel writes it", () => {
		const queued: PendingSessionInput = {
			inputId: "55555555-5555-4555-8555-000000000003",
			position: 3,
			kind: "user_message",
			authorUserId: USER,
			authorDisplayName: "Jonas",
			body: answerData,
			createdAt: "2026-09-02T10:00:03Z",
			status: "queued",
		};
		const projection = projectTranscript(
			[event(1, { eventId: CARD, eventType: "interaction_request", body: request })],
			[queued],
		);
		expect(projection.items).toHaveLength(1);
		const card = projection.items[0];
		if (card?.kind !== "interaction") throw new Error("card expected");
		expect(card.answer).toMatchObject({ outcome: "answered", pending: true, answeredBy: USER });
	});

	it("opens a card again when its answer's delivery failed, and settles it with a later answer", () => {
		const failed: PendingSessionInput = {
			inputId: "55555555-5555-4555-8555-000000000004",
			position: 4,
			kind: "user_message",
			authorUserId: USER,
			authorDisplayName: "Jonas",
			body: answerData,
			createdAt: "2026-09-02T10:00:04Z",
			status: "failed",
			failureReason: "The selected sponsor quota or model authority is unavailable",
		};
		const card = [event(1, { eventId: CARD, eventType: "interaction_request", body: request })];
		const reopened = projectTranscript(card, [failed]).items;
		expect(reopened).toHaveLength(1);
		if (reopened[0]?.kind !== "interaction") throw new Error("card expected");
		expect(reopened[0].answer).toBeUndefined();
		expect(reopened[0].answerFailed).toBe(true);

		const again = {
			...failed,
			inputId: "55555555-5555-4555-8555-000000000005",
			position: 5,
			status: "queued" as const,
		};
		const settled = projectTranscript(card, [failed, again]).items;
		if (settled[0]?.kind !== "interaction") throw new Error("card expected");
		expect(settled[0].answer).toMatchObject({ outcome: "answered", pending: true });
		expect(settled[0].answerFailed).toBeUndefined();
	});

	it("marks the cards of a chain a member stopped, drawing nothing for the note itself", () => {
		const approval = "44444444-4444-4444-8444-000000000594";
		const other = "44444444-4444-4444-8444-000000000595";
		const projection = projectTranscript([
			event(1, { eventId: CARD, eventType: "interaction_request", body: request }),
			event(2, { eventId: approval, eventType: "authorization_request", body: { operation: "send-email" } }),
			event(3, { eventId: other, eventType: "authorization_request", body: { operation: "send-email" } }),
			event(4, {
				eventType: "session_info",
				body: {
					schema: CHAIN_STOPPED_SCHEMA,
					// As the kernel writes them, and one id in another case: a card is matched whatever its case.
					cardIds: [CARD, approval.toUpperCase(), "not-a-card", 7, "44444444-4444-4444-8444-000000000999"],
					stoppedRunId: RUN,
					stoppedByUserId: USER,
				},
			}),
		]);
		expect(projection.hiddenCount).toBe(0);
		expect(projection.items.map((item) => [item.id, "chainStopped" in item ? item.chainStopped : undefined])).toEqual(
			[
				[CARD, true],
				[approval, true],
				[other, undefined],
			],
		);
		// A note without card ids, or of another shape, changes nothing.
		const malformed = projectTranscript([
			event(1, { eventId: CARD, eventType: "interaction_request", body: request }),
			event(2, { eventType: "session_info", body: { schema: CHAIN_STOPPED_SCHEMA, cardIds: CARD } }),
		]);
		expect(malformed.items).toHaveLength(1);
		expect(malformed.items[0] && "chainStopped" in malformed.items[0]).toBe(false);
	});

	it("hides a card it cannot read and an answer whose card is not loaded", () => {
		const projection = projectTranscript([
			event(1, {
				eventType: "interaction_request",
				body: {
					schema: RUNNER_ENTRY_SCHEMA,
					entry: { type: "custom", customType: "interaction_request", data: {} },
				},
			}),
			event(2, {
				eventType: "interaction_answer",
				body: {
					schema: RUNNER_ENTRY_SCHEMA,
					entry: { type: "custom", customType: "interaction_answer", data: answerData },
				},
			}),
		]);
		expect(projection.items).toHaveLength(0);
		expect(projection.hiddenCount).toBe(1);
	});
});
