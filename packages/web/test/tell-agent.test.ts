// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController, type CompanyState } from "../src/app/company.ts";
import { noteReceiver, tellAgent } from "../src/app/tell-agent.ts";
import { fixture, profileA, session, team, userA } from "./fixtures.ts";
import { accountsFake, ada, cofounder } from "./mail-fixtures.ts";

/* A member's note to an agent (app/tell-agent.ts), lifted out of the Mailbox's reader so an app's page can ask for one
 * too (RUNTIME-INTERFACE-APPS.md §5 "tell"): who hears a note from an app, and when a note goes from here or waits in
 * the agent's thread for the member to send. The Mailbox's own notes are test/mailbox.test.ts'. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
});

function company(state: Partial<CompanyState> = {}) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({ loading: false, staff: [cofounder, ada], sessions: [session], team, ...state });
	cleanup.push(() => controller.stop());
	return controller;
}

const note = { text: "> app:orders#1043 · Lund, A\n\nGet a quote from this one.", quotes: [] };

describe("who hears a note from an app", () => {
	it("is the app's owner while it is at work, and the Co-Founder when the app has none at work", () => {
		const controller = company();
		expect(noteReceiver(controller, ada.id)).toEqual({ agent: ada });
		expect(noteReceiver(controller, null)).toEqual({ agent: cofounder });
		expect(noteReceiver(controller, "not-an-agent")).toEqual({ agent: cofounder });
		controller.store.set({ staff: [cofounder, { ...ada, employmentStatus: "archived" }] });
		expect(noteReceiver(controller, ada.id)).toEqual({ agent: cofounder });
		// The Co-Founder owns an app as any agent does.
		expect(noteReceiver(controller, cofounder.id)).toEqual({ agent: cofounder });
	});

	it("is nobody, with the page told why, when there is no Co-Founder or the member may not write", () => {
		const alone = company({ staff: [{ ...ada, employmentStatus: "archived" }] });
		expect(noteReceiver(alone, ada.id)).toEqual({
			refused: "Nobody can take a note from this app: its owner is not at work, and the company has no Co-Founder",
		});
		const viewer = company({
			team: { ...team, role: "viewer", capabilities: { ...team.capabilities, write: false } },
		});
		expect(noteReceiver(viewer, ada.id)).toEqual({ refused: "The member may not send messages in this company" });
		const lost = company({ accessLost: true });
		expect(noteReceiver(lost, ada.id)).toEqual({ refused: "The member may not send messages in this company" });
	});
});

describe("a note to an agent", () => {
	it("goes as the member's own message into a thread with nothing drafted, on the thread's own account", async () => {
		const controller = company();
		const open = vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		// While it goes, the send's checks know it is a note the member sent from elsewhere: the thread need not be on
		// screen (app/application.ts' input writer).
		const away: boolean[] = [];
		const send = vi.spyOn(controller, "sendPrompt").mockImplementation(async (sessionId) => {
			away.push(controller.noteOnItsWay(sessionId));
			return true;
		});
		const accounts = accountsFake();
		expect(controller.noteOnItsWay(session.sessionId)).toBe(false);
		expect(await tellAgent(controller, accounts, ada.id, note)).toEqual({
			sent: true,
			href: `#/c/${profileA.profileId}/staff/${ada.id}`,
		});
		expect(open).toHaveBeenCalledWith(ada);
		expect(accounts.selectSessionAccount).toHaveBeenCalledWith(session.sessionId, controller.signal);
		expect(send).toHaveBeenCalledExactlyOnceWith(session.sessionId, note.text);
		expect(away).toEqual([true]);
		expect(controller.noteOnItsWay(session.sessionId)).toBe(false);
	});

	it("goes to the Co-Founder's own thread for the Co-Founder", async () => {
		const controller = company();
		vi.spyOn(controller, "openCofounderConversation").mockResolvedValue({ sessionId: session.sessionId });
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		expect(await tellAgent(controller, accountsFake(), cofounder.id, note)).toEqual({
			sent: true,
			href: `#/c/${profileA.profileId}`,
		});
		expect(send).toHaveBeenCalledExactlyOnceWith(session.sessionId, note.text);
	});

	it("waits in the thread's composer when something is drafted there already", async () => {
		const controller = company();
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		controller.conversation(session.sessionId).set({ draft: "Earlier words" });
		expect(await tellAgent(controller, accountsFake(), ada.id, note)).toMatchObject({ sent: false });
		expect(send).not.toHaveBeenCalled();
		expect(controller.conversation(session.sessionId).get().draft).toBe(`Earlier words\n\n${note.text}`);
	});

	it("waits while the member is answering a question on the agent's wall, which a send would put in front of it", async () => {
		const controller = company();
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		controller.conversation(session.sessionId).set({ answering: "Who first?" });
		expect(await tellAgent(controller, accountsFake(), ada.id, note)).toEqual({
			sent: false,
			href: `#/c/${profileA.profileId}/staff/${ada.id}`,
		});
		expect(send).not.toHaveBeenCalled();
		const waiting = controller.conversation(session.sessionId).get();
		expect([waiting.draft, waiting.answering]).toEqual([note.text, "Who first?"]);
		// Also when the question is picked while the thread's account is chosen.
		const later = company();
		vi.spyOn(later, "openStaffConversation").mockResolvedValue(session.sessionId);
		const held = vi.spyOn(later, "sendPrompt").mockResolvedValue(true);
		const accounts = accountsFake();
		accounts.selectSessionAccount.mockImplementation(async () => {
			later.conversation(session.sessionId).set({ answering: "Who first?" });
			return undefined;
		});
		expect(await tellAgent(later, accounts, ada.id, note)).toMatchObject({ sent: false });
		expect(held).not.toHaveBeenCalled();
	});

	it("waits when the member has no model account for the thread, and the composer says so", async () => {
		const controller = company();
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const accounts = accountsFake();
		accounts.selectSessionAccount.mockResolvedValue(undefined);
		expect(await tellAgent(controller, accounts, ada.id, note)).toMatchObject({ sent: false });
		const waiting = controller.conversation(session.sessionId).get();
		expect(waiting.draft).toBe(note.text);
		expect(waiting.sendError).toBe("Select an active model account before sending.");
	});

	it("says why when the agent left or the Co-Founder's thread can't be opened", async () => {
		const controller = company({ staff: [cofounder, { ...ada, employmentStatus: "archived" }] });
		await expect(tellAgent(controller, accountsFake(), ada.id, note)).rejects.toThrow(
			"That agent is no longer at work.",
		);
		vi.spyOn(controller, "openCofounderConversation").mockResolvedValue({ reason: "No thread here." });
		await expect(tellAgent(controller, accountsFake(), cofounder.id, note)).rejects.toThrow("No thread here.");
	});
});
