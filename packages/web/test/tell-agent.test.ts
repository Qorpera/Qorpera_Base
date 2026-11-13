// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController, type CompanyState } from "../src/app/company.ts";
import { noteReceiver, tellAgent } from "../src/app/tell-agent.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { SessionInputWriter } from "../src/cloud/session-input.ts";
import { fixture, id, pending, profileA, session, settle, team, userA } from "./fixtures.ts";
import { accountsFake, ada, cofounder, connections } from "./mail-fixtures.ts";

/* A member's note to an agent (app/tell-agent.ts), lifted out of the Mailbox's reader so an app's page can ask for one
 * too (RUNTIME-INTERFACE-APPS.md §5 "tell"): who hears a note from an app, and when a note goes from here or waits in
 * the agent's thread for the member to send. The Mailbox's own notes are test/mailbox.test.ts'. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
});

function company(state: Partial<CompanyState> = {}, write?: SessionInputWriter) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id, write);
	controller.store.set({ loading: false, staff: [cofounder, ada], sessions: [session], team, ...state });
	cleanup.push(() => controller.stop());
	return controller;
}

/** A note from an app's page: the member's words, and the line they answer (cloud/wall-reply.ts `appNoteLine`). */
const LINE = "app:orders#1043 · Lund, A";
const note = { text: "Get a quote from this one.", quotes: [], header: LINE };

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
		// screen (app/application.ts' input writer). The app's line is what the draft answers, which the send puts first.
		const seen: [away: boolean, answering: string | undefined][] = [];
		const send = vi.spyOn(controller, "sendPrompt").mockImplementation(async (sessionId) => {
			seen.push([controller.noteOnItsWay(sessionId), controller.conversation(sessionId, false).get().answering]);
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
		expect(seen).toEqual([[true, LINE]]);
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

	it("waits under the app's line when something is drafted there already: one message, never the line as written", async () => {
		const controller = company();
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		controller.conversation(session.sessionId).set({ draft: "Earlier words" });
		expect(await tellAgent(controller, accountsFake(), ada.id, note)).toMatchObject({ sent: false });
		expect(send).not.toHaveBeenCalled();
		const waiting = controller.conversation(session.sessionId).get();
		expect([waiting.draft, waiting.answering]).toEqual([`Earlier words\n\n${note.text}`, LINE]);
	});

	it("waits under the app's line when the member has no model account for the thread, and the composer says so", async () => {
		const controller = company();
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const accounts = accountsFake();
		accounts.selectSessionAccount.mockResolvedValue(undefined);
		expect(await tellAgent(controller, accounts, ada.id, note)).toMatchObject({ sent: false });
		const waiting = controller.conversation(session.sessionId).get();
		expect([waiting.draft, waiting.answering]).toEqual([note.text, LINE]);
		expect(waiting.sendError).toBe("Select an active model account before sending.");
	});

	it("is not added to a thread whose draft answers something already, or whose message is on its way", async () => {
		const states = [{ answering: "Who first?" }, { answering: "app:shop · Returns" }, { sending: true }];
		for (const state of states) {
			const controller = company();
			vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
			const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
			controller.conversation(session.sessionId).set(state);
			expect(await tellAgent(controller, accountsFake(), ada.id, note)).toEqual({
				sent: false,
				href: `#/c/${profileA.profileId}/staff/${ada.id}`,
				held: true,
			});
			expect(send).not.toHaveBeenCalled();
			// Nothing of the note is in the thread: what was there stays as it was.
			expect(controller.conversation(session.sessionId).get()).toMatchObject(state);
			expect(controller.conversation(session.sessionId).get().draft).toBeUndefined();
		}
	});

	it("waits after a wall question being answered when it is a note of the Mailbox's, which has no line of its own", async () => {
		const controller = company();
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		controller.conversation(session.sessionId).set({ answering: "Who first?" });
		const mail = { text: "Please answer the email «Invoice 42».", quotes: [] };
		expect(await tellAgent(controller, accountsFake(), ada.id, mail)).toMatchObject({ sent: false });
		expect(send).not.toHaveBeenCalled();
		const waiting = controller.conversation(session.sessionId).get();
		expect([waiting.draft, waiting.answering]).toEqual([mail.text, "Who first?"]);
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

	it("says why when the agent left or the Co-Founder's thread can't be opened", async () => {
		const controller = company({ staff: [cofounder, { ...ada, employmentStatus: "archived" }] });
		await expect(tellAgent(controller, accountsFake(), ada.id, note)).rejects.toThrow(
			"That agent is no longer at work.",
		);
		vi.spyOn(controller, "openCofounderConversation").mockResolvedValue({ reason: "No thread here." });
		await expect(tellAgent(controller, accountsFake(), cofounder.id, note)).rejects.toThrow("No thread here.");
	});
});

describe("a note that waited, sent from the thread's composer", () => {
	it("shows the app above the field, never its line, and goes as one message the thread draws under the app's card", async () => {
		const write = vi.fn<SessionInputWriter>().mockResolvedValue({ inputId: pending(1).inputId });
		const controller = company({}, write);
		controller.store.set({
			apps: [
				{
					name: "orders",
					path: "apps/orders",
					manifest: {
						name: "Orders",
						about: null,
						emblem: "board",
						colour: null,
						entry: "index.html",
						owner: ada.id,
						posted: true,
						reads: [],
						writes: [],
						concept: false,
						cover: null,
						kit: null,
					},
					problems: [],
					version: null,
				},
			],
		});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		controller.conversation(session.sessionId).set({ draft: "Earlier words" });
		expect(await tellAgent(controller, accountsFake(), ada.id, note)).toMatchObject({ sent: false });
		const view = new ConversationView(controller, session.sessionId, {
			sendMessage: (sessionId, text) => controller.sendPrompt(sessionId, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		// Above the field: the app, by its own name and emblem, and what the note is about. In it: the member's words.
		const strip = view.el.querySelector<HTMLElement>(".composer-answer")!;
		const field = view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		expect(strip.hidden).toBe(false);
		expect(strip.classList.contains("is-note")).toBe(true);
		expect(strip.querySelector(".composer-answer-label")?.textContent).toBe("Orders");
		expect(strip.querySelector(".composer-answer-question")?.textContent).toBe("Lund, A");
		expect(strip.querySelector(".composer-answer-emblem .interface-emblem")).not.toBeNull();
		expect(strip.querySelector("button")?.getAttribute("aria-label")).toBe("Leave the app out");
		expect(field.value).toBe(`Earlier words\n\n${note.text}`);
		expect(field.placeholder).toBe("Message…");
		expect(view.el.textContent).not.toContain("app:orders");
		// The thread's own account, as the thread chooses it; then the member sends from the composer.
		controller.setExecutionSponsor(session.sessionId, connections, id(880));
		await settle();
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
		expect(write.mock.calls[0]![2]).toBe(`> ${LINE}\n\nEarlier words\n\n${note.text}`);
		await settle();
		expect(strip.hidden).toBe(true);
		const sent = [...view.el.querySelectorAll<HTMLElement>(".message.mine")].at(-1)!;
		const card = sent.querySelector<HTMLElement>(".app-cards > .app-card.is-note");
		expect(card?.dataset.appName).toBe("orders");
		expect(card?.querySelector(".app-card-note")?.textContent).toBe("Lund, A");
		expect(sent.querySelector(".text")?.textContent).toBe(`Earlier words\n\n${note.text}`);
		expect(view.el.textContent).not.toContain("app:orders");
	});
});
