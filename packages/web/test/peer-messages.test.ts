import { describe, expect, it } from "vitest";
import { parseEvent } from "../src/cloud/parse.ts";
import {
	PEER_BUDGET_SCHEMA,
	PEER_LINK_SCHEMA,
	PEER_MESSAGE_SCHEMA,
	projectTranscript,
	RUNNER_ENTRY_SCHEMA,
} from "../src/cloud/transcript.ts";

const session = "33333333-3333-4333-8333-333333333333";
const alice = "44444444-4444-4444-8444-444444444444";
const bob = "55555555-5555-4555-8555-555555555555";
const run = "66666666-6666-4666-8666-666666666666";
const member = "77777777-7777-4777-8777-777777777777";
function base(sequence: number, eventType: "message" | "session_info", body: unknown) {
	return {
		session_id: session,
		sequence,
		event_id: `8888888${sequence}-8888-4888-8888-888888888888`,
		event_type: eventType,
		actor_user_id: member,
		event_hash: "a".repeat(64),
		created_at: "2026-09-22T19:24:00Z",
		body,
	};
}
function peerMessage(sequence: number, text = "Could you check the note?") {
	return base(sequence, "message", {
		schema: RUNNER_ENTRY_SCHEMA,
		entry: {
			type: "message",
			id: `8888888${sequence}-8888-4888-8888-888888888888`,
			parentId: null,
			timestamp: "2026-09-22T19:24:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text }] },
			delivery: {
				schema: PEER_MESSAGE_SCHEMA,
				from: alice,
				to: bob,
				runId: run,
				staffVersion: 3,
				displayName: "New Bot",
				receiptId: run,
				operationKey: "ask-1",
			},
		},
	});
}

describe("messages between two agents (contract 14.6)", () => {
	it("shows a peer message as the sending agent's bubble, without a run send", () => {
		const projection = projectTranscript([parseEvent(peerMessage(1))]);
		expect(projection.hiddenCount).toBe(0);
		expect(projection.items).toEqual([
			expect.objectContaining({
				kind: "agent",
				text: "Could you check the note?",
				phase: "final",
				runId: run,
				staffSpeaker: { runId: run, staffAgentId: alice, staffVersion: 3, displayName: "New Bot" },
			}),
		]);
	});
	it("marks a message sent without waking the coworker as held", () => {
		const held = peerMessage(7, "FYI: the note is updated.");
		(held.body as { entry: { delivery: Record<string, unknown> } }).entry.delivery.held = true;
		expect(projectTranscript([parseEvent(held)]).items[0]).toMatchObject({ kind: "agent", held: true });
		expect(projectTranscript([parseEvent(peerMessage(8))]).items[0]).not.toHaveProperty("held");
	});
	it("hides a peer message that claims a run execution or lacks its speaker", () => {
		const withRun = {
			...peerMessage(1),
			execution_kind: "run",
			execution_id: run,
			execution_claimant_id: run,
			runner_assignment_id: run,
		};
		expect(projectTranscript([parseEvent(withRun)]).items).toEqual([]);
		const speakerless = peerMessage(2);
		(speakerless.body as { entry: { delivery: Record<string, unknown> } }).entry.delivery.from = "not-an-agent";
		expect(projectTranscript([parseEvent(speakerless)]).items).toEqual([]);
	});
	it("turns the chip and the budget line into their own items", () => {
		const chip = base(3, "session_info", {
			schema: PEER_LINK_SCHEMA,
			direction: "in",
			counterpartStaffId: alice,
			pairSessionId: session,
			eventId: run,
			receiptId: run,
		});
		const note = base(4, "session_info", {
			schema: PEER_BUDGET_SCHEMA,
			text: "This exchange paused after 6 messages.",
		});
		const other = base(5, "session_info", { schema: "qorpera.shared-session-metadata/v1", entry: {} });
		const projection = projectTranscript([parseEvent(chip), parseEvent(note), parseEvent(other)]);
		expect(projection.items).toEqual([
			expect.objectContaining({
				kind: "peer_link",
				direction: "in",
				counterpartStaffId: alice,
				pairSessionId: session,
			}),
			expect.objectContaining({ kind: "note", text: "This exchange paused after 6 messages." }),
		]);
		expect(projection.hiddenCount).toBe(0);
	});
	it("keeps the held flag on a chip", () => {
		const chip = base(9, "session_info", {
			schema: PEER_LINK_SCHEMA,
			direction: "out",
			held: true,
			counterpartStaffId: alice,
			pairSessionId: session,
			eventId: run,
			receiptId: run,
		});
		expect(projectTranscript([parseEvent(chip)]).items[0]).toMatchObject({
			kind: "peer_link",
			direction: "out",
			held: true,
		});
	});
	it("ignores a malformed chip instead of rendering a broken link", () => {
		const broken = base(6, "session_info", {
			schema: PEER_LINK_SCHEMA,
			direction: "sideways",
			counterpartStaffId: alice,
			pairSessionId: session,
		});
		expect(projectTranscript([parseEvent(broken)]).items).toEqual([]);
	});
});
