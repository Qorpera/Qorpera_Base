// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { parseStaffExecutionActivity } from "../src/cloud/parse.ts";
import type { TranscriptInteraction, TranscriptItem } from "../src/cloud/transcript.ts";
import { fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const noted: TranscriptInteraction = {
	kind: "interaction",
	id: id(720),
	sequence: 1,
	actorUserId: userA.id,
	createdAt: "2026-09-05T10:00:00Z",
	request: {
		surface: "question",
		title: "Which look?",
		payload: { options: [{ label: "Dusk", value: "dusk" }], allowCustom: true },
	},
	answer: {
		outcome: "answered",
		answer: { values: ["Warmer, less blue"] },
		answeredBy: userA.id,
		answeredAt: "2026-09-05T10:05:00Z",
	},
};
const back: TranscriptItem = {
	kind: "agent",
	id: id(721),
	sequence: 2,
	text: "Here is a warmer one.",
	attachmentCount: 0,
	createdAt: "2026-09-05T10:09:00Z",
};

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No external requests in this fixture")));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

const run = {
	run_id: id(722),
	staff_agent_id: staff.id,
	source_kind: "session_turn",
	updated_at: "2026-09-05T10:05:01Z",
};
const working = parseStaffExecutionActivity([{ ...run, job_status: "leased", activity: "working" }]);
const paused = parseStaffExecutionActivity([
	{
		...run,
		job_status: "queued",
		activity: "waiting",
		paused_until: "2099-01-01T00:00:00Z",
		sponsor_binding_id: id(723),
		requested_by_user_id: userA.id,
		paid_by_chatgpt_plan: true,
		paid_while_away: false,
		movable: false,
	},
]);

function setup(activity: typeof working) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	vi.spyOn(company, "loadConversation").mockResolvedValue();
	company.store.set({
		team,
		staff: [staff],
		sessions: [{ ...session, staffAgentId: staff.id }],
		activity,
		loading: false,
	});
	const show = (items: TranscriptItem[]) =>
		company
			.conversation(session.sessionId)
			.set({ loading: false, projection: { items, hiddenCount: 0, lastSequence: items.length } });
	show([noted]);
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const card = () => view.el.querySelector<HTMLElement>(".interaction-card");
	return { card, show, company };
}

describe("a question answered in the member's own words, in its thread", () => {
	it("shows the agent reworking it while the agent works, and the exchange once the agent is back", async () => {
		const f = setup(working);
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(true);
		expect(f.card()?.querySelector(".interaction-call strong")?.textContent).toBe(
			`${staff.displayName} is reworking this`,
		);
		expect(f.card()?.querySelector(".interaction-call .interaction-figure .figure")).not.toBeNull();
		expect(f.card()?.querySelector(".interaction-noted")?.textContent).toBe("“Warmer, less blue”");

		f.show([noted, back]);
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(false);
		expect(f.card()?.classList.contains("is-exchange")).toBe(true);
		expect(f.card()?.querySelector(".interaction-chosen")?.textContent).toBe("Warmer, less blue");
	});

	it("flips on the agent's state alone, on the same view, a run waiting at its usage limit included", async () => {
		const f = setup(working);
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(true);
		f.company.store.set({ activity: [] });
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(false);
		expect(f.card()?.classList.contains("is-exchange")).toBe(true);
		f.company.store.set({ activity: paused });
		await settle();
		expect(f.company.agentState(staff.id)).toBe("idle");
		expect(f.card()?.classList.contains("is-reworking")).toBe(true);
		f.company.store.set({ activity: [] });
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(false);
	});

	it("is the exchange it was when the agent is not at work", async () => {
		const f = setup([]);
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(false);
		expect(f.card()?.classList.contains("is-exchange")).toBe(true);
	});
});
