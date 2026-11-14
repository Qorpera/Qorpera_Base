// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import type { ComputerPanel, ComputerPanels } from "../src/app/views/computer.ts";
import { ComputerByItself } from "../src/app/views/computer-by-itself.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { SessionExecutionSponsor } from "../src/cloud/session-input.ts";
import type { TranscriptInteraction } from "../src/cloud/transcript.ts";
import { fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

/* The agent's take-over card in its thread (migration 20260930713000): Take over opens the agent's computer window and
 * takes its desktop over; I'm done gives the desktop back before the answer, which wakes the agent, goes. */

const card: TranscriptInteraction = {
	kind: "interaction",
	id: id(700),
	sequence: 1,
	actorUserId: userA.id,
	createdAt: timestamp,
	request: {
		surface: "takeover",
		title: "Sign in to the bank",
		payload: { instruction: "Sign in.", reason: "sign_in" },
	},
};
const sponsor: SessionExecutionSponsor = {
	connectionId: id(710),
	provider: "openai",
	nativeHarness: "codex-cli",
	sponsorBindingId: id(711),
	sponsorVersion: 1,
	computeIdentityId: id(712),
	workerClass: "managed_sandbox",
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

function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	vi.spyOn(company, "loadConversation").mockResolvedValue();
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	company.conversation(session.sessionId).set({
		executionSponsor: sponsor,
		loading: false,
		projection: { items: [card], hiddenCount: 0, lastSequence: 1 },
	});
	const order: string[] = [];
	const answer = vi.spyOn(f.api, "answerInteraction").mockImplementation(async () => {
		order.push("answer");
		return { inputId: id(714), position: 1 };
	});
	// The company's computer windows: one panel for the agent, its take-over watched; the company's hand-back of the
	// agent's desktops (its ledger, window or not) is confirmed by the database unless the test says otherwise.
	let release = () => {};
	let confirmed = true;
	let open = true;
	const panel = {
		agentId: staff.id,
		attached: false,
		holding: false,
		attach: vi.fn(),
		detach: vi.fn(),
		focus: vi.fn(),
		retitle: vi.fn(),
		dispose: vi.fn(),
		coverAgain: vi.fn(),
		takeOver: vi.fn(() => {
			order.push("takeOver");
		}),
		handBack: vi.fn(),
	};
	const panels = {
		open: vi.fn(() => panel),
		get: vi.fn((agentId: string) => (agentId === staff.id && open ? panel : undefined)),
		close: vi.fn(),
		dispose: vi.fn(),
		// The window that shows by itself (20260930742000): never in these tests.
		byItself: new ComputerByItself({ current: () => undefined, close: vi.fn() }),
		busy: vi.fn(() => false),
		releaseAgent: vi.fn(
			(_agentId: string) =>
				new Promise<boolean>((resolve) => {
					order.push("releaseAgent");
					release = () => resolve(confirmed);
				}),
		),
	};
	const view = new ConversationView(company, session.sessionId, {
		computerPanels: panels as unknown as ComputerPanels,
	});
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return {
		view,
		company,
		panel: panel as typeof panel & Partial<ComputerPanel>,
		panels,
		answer,
		order,
		release: () => release(),
		unconfirmed: () => {
			confirmed = false;
		},
		closeWindow: () => {
			open = false;
		},
	};
}
function pill(view: ConversationView, label: string) {
	return [...view.el.querySelectorAll<HTMLButtonElement>(".interaction-card button")].find(
		(button) => button.textContent === label,
	);
}

describe("an agent's take-over card", () => {
	it("opens the agent's computer and takes its desktop over from Take over", async () => {
		const f = setup();
		await settle();
		pill(f.view, "Take over")!.click();
		// The member's own click: a sleeping computer wakes for it (COMPUTER-OPEN-BRIEF).
		expect(f.panels.open).toHaveBeenCalledWith(expect.objectContaining({ id: staff.id }), { asked: true });
		expect(f.panel.attach).toHaveBeenCalled();
		expect(f.panel.takeOver).toHaveBeenCalledOnce();
		expect(f.answer).not.toHaveBeenCalled();
	});

	it("gives the desktop back before I'm done answers, so the agent it wakes may look again", async () => {
		const f = setup();
		await settle();
		pill(f.view, "I'm done")!.click();
		await settle();
		expect(f.panels.releaseAgent).toHaveBeenCalledExactlyOnceWith(staff.id);
		expect(f.panel.handBack).not.toHaveBeenCalled();
		// The answer waits for the hand-back.
		expect(f.answer).not.toHaveBeenCalled();
		f.release();
		await settle();
		await settle();
		expect(f.order).toEqual(["releaseAgent", "answer"]);
		expect(f.answer).toHaveBeenCalledWith(
			session.sessionId,
			expect.any(String),
			card.id,
			"handed_back",
			{},
			expect.anything(),
		);
	});

	it("answers nothing while the hand-back is not confirmed, and says so, so I'm done asks again (review r1 F4)", async () => {
		const f = setup();
		f.unconfirmed();
		await settle();
		pill(f.view, "I'm done")!.click();
		await settle();
		f.release();
		await settle();
		await settle();
		expect(f.panels.releaseAgent).toHaveBeenCalledOnce();
		expect(f.answer).not.toHaveBeenCalled();
		expect(f.company.conversation(session.sessionId).get().interactionError).toBe(
			"The computer could not be given back yet. Press I'm done to try again. It goes back by itself within 5 minutes.",
		);
		f.view.update();
		expect(f.view.el.textContent).toContain("The computer could not be given back yet.");
		// The card is open again: I'm done asks once more.
		const again = pill(f.view, "I'm done")!;
		expect(again.getAttribute("aria-disabled")).toBeNull();
		again.click();
		await settle();
		expect(f.panels.releaseAgent).toHaveBeenCalledTimes(2);
	});

	it("asks the company's hand-back, not a window: with the window closed, I'm done still waits for it (review r2 F4)", async () => {
		const f = setup();
		f.closeWindow();
		await settle();
		pill(f.view, "I'm done")!.click();
		await settle();
		expect(f.panels.releaseAgent).toHaveBeenCalledExactlyOnceWith(staff.id);
		expect(f.answer).not.toHaveBeenCalled();
		f.release();
		await settle();
		await settle();
		expect(f.order).toEqual(["releaseAgent", "answer"]);
	});

	it("leaves the desktop held when the member skips the card", async () => {
		const f = setup();
		await settle();
		pill(f.view, "Skip")!.click();
		await settle();
		await settle();
		expect(f.panels.releaseAgent).not.toHaveBeenCalled();
		expect(f.answer).toHaveBeenCalledWith(
			session.sessionId,
			expect.any(String),
			card.id,
			"dismissed",
			{},
			expect.anything(),
		);
	});
});
