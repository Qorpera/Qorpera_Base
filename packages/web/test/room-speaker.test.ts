import { describe, expect, it } from "vitest";
import { parseEvent } from "../src/cloud/parse.ts";
import { projectTranscript } from "../src/cloud/transcript.ts";

const id = "33333333-3333-4333-8333-333333333333";
const staff = "44444444-4444-4444-8444-444444444444";
function raw() {
	return {
		session_id: id,
		sequence: 1,
		event_id: id,
		event_type: "message",
		actor_user_id: id,
		event_hash: "a".repeat(64),
		created_at: "2026-09-12T12:00:00Z",
		execution_kind: "run",
		execution_id: id,
		execution_claimant_id: id,
		runner_assignment_id: id,
		session_input_id: null,
		staff_speaker: { run_id: id, staff_agent_id: staff, staff_version: 2, display_name: "Bob" },
		body: {
			schema: "qorpera.runner-transcript-entry/v1",
			entry: {
				type: "message",
				id,
				message: { role: "assistant", content: [{ type: "text", text: "Shared result" }] },
				execution: { kind: "run", id, claimantId: id, runnerAssignmentId: id },
				delivery: { schema: "qorpera.agent-send/v1", phase: "final" },
			},
		},
	};
}
describe("authoritative room staff attribution", () => {
	it("uses the separately projected immutable speaker only for an explicit send", () => {
		const message = projectTranscript([parseEvent(raw())]).items[0];
		expect(message).toMatchObject({
			kind: "agent",
			staffSpeaker: { staffAgentId: staff, staffVersion: 2, displayName: "Bob" },
		});
		const hidden = raw();
		hidden.body.entry.delivery.schema = "ordinary-output";
		expect(projectTranscript([parseEvent(hidden)]).items).toEqual([]);
	});
	it.each(["wrong-run", "wrong-staff", "version", "extra", "member"])(
		"rejects invalid speaker provenance %s",
		(kind) => {
			const input: Record<string, unknown> = raw();
			const speaker = input.staff_speaker as Record<string, unknown>;
			if (kind === "wrong-run") speaker.run_id = staff;
			if (kind === "wrong-staff") speaker.staff_agent_id = "not-an-id";
			if (kind === "version") speaker.staff_version = 0;
			if (kind === "extra") speaker.secret = "never";
			if (kind === "member") input.session_input_id = id;
			expect(() => parseEvent(input)).toThrow();
		},
	);
	it("does not infer staff from the human sponsor when metadata is absent", () => {
		const input: Record<string, unknown> = raw();
		delete input.staff_speaker;
		expect(projectTranscript([parseEvent(input)]).items[0]).not.toHaveProperty("staffSpeaker");
	});
	it("accepts retained staff identity without substituting a current name", () => {
		const input: Record<string, unknown> = raw();
		(input.staff_speaker as Record<string, unknown>).display_name = null;
		expect(projectTranscript([parseEvent(input)]).items[0]).toMatchObject({ staffSpeaker: { staffAgentId: staff } });
		expect(
			(projectTranscript([parseEvent(input)]).items[0] as { staffSpeaker: object }).staffSpeaker,
		).not.toHaveProperty("displayName");
	});
});
