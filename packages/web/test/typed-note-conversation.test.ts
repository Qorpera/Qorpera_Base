// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
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

function setup(state: "working" | "idle") {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	vi.spyOn(company, "loadConversation").mockResolvedValue();
	const agentState = vi.spyOn(company, "agentState").mockReturnValue(state);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
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
	return { card, show, agentState, company };
}

describe("a question answered in the member's own words, in its thread", () => {
	it("shows the agent reworking it while the agent works, and the exchange once the agent is back", async () => {
		const f = setup("working");
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

	it("is the exchange it was when the agent is not at work", async () => {
		const f = setup("idle");
		await settle();
		expect(f.card()?.classList.contains("is-reworking")).toBe(false);
		expect(f.card()?.classList.contains("is-exchange")).toBe(true);
	});
});
