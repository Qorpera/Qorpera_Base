// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { CompanyController } from "../src/app/company.ts";
import { parseRoute } from "../src/app/router.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CodingSession } from "../src/cloud/coding-session.ts";
import { type MessageErase, MessageEraseError } from "../src/cloud/message-erases.ts";
import { createWebSessionRunControl } from "../src/cloud/session-run-control.ts";
import type { TranscriptItem, TranscriptMessage } from "../src/cloud/transcript.ts";
import type { HostedSessionEvent } from "../src/cloud/types.ts";
import appCss from "../src/styles/app.css?raw";
import conversationCss from "../src/styles/conversation.css?raw";
import tokensCss from "../src/styles/tokens.css?raw";
import { AttachmentTray } from "../src/ui/attachments.ts";
import { fmtTime } from "../src/ui/dom.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	event,
	fixture,
	id,
	placeholderLabel,
	profileA,
	session,
	settle,
	staff,
	team,
	timestamp,
	userA,
	userB,
	visibleText,
} from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
	// jsdom does not implement the native dialog methods; focus containment is
	// verified in Chromium separately.
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
		this.querySelector<HTMLButtonElement>("button")?.focus();
	};
	HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	URL.createObjectURL = vi.fn(() => "blob:fixture-local-image");
	URL.revokeObjectURL = vi.fn();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});
function setup(actions: WorkspaceActions = {}) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const view = new ConversationView(company, session.sessionId, actions);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, view };
}
/** A conversation whose messages are already loaded, built before it is placed
 * in the page, with the message pane's scroll metrics under the test's control
 * (jsdom lays nothing out). */
function loadedView() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const reply: TranscriptMessage = {
		kind: "agent",
		id: id(83),
		sequence: 1,
		text: "Latest answer",
		attachmentCount: 0,
		phase: "final",
		createdAt: timestamp,
		authorUserId: userA.id,
	};
	company
		.conversation(session.sessionId)
		.set({ loading: false, projection: { items: [reply], hiddenCount: 0, lastSequence: 1 } });
	const view = new ConversationView(company, session.sessionId);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const messages = view.el.querySelector<HTMLElement>(".messages")!;
	expect(messages.textContent).toContain("Latest answer");
	const metrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 400 };
	// Like a browser: a write past the end lands at the end.
	Object.defineProperty(messages, "scrollTop", {
		configurable: true,
		get: () => metrics.scrollTop,
		set: (value: number) => {
			metrics.scrollTop = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight));
		},
	});
	Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
	Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
	return { view, messages, metrics };
}
function button(root: ParentNode, label: string): HTMLButtonElement {
	const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.getAttribute("aria-label") === label || item.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}
function input(root: ParentNode, label: string, value: string): void {
	const field = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}
function attach(root: ParentNode, files: File[]): void {
	const field = root.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(field, "files", { configurable: true, value: files });
	field.dispatchEvent(new Event("change"));
}

describe("conversation UI boundaries", () => {
	it("uses recorded room speaker names and never substitutes the current staff or sponsor", () => {
		const f = setup();
		f.company.store.set({ sessions: [{ ...session, executionScope: { roomId: id(79) } }] });
		const agent: TranscriptMessage = {
			kind: "agent",
			id: id(80),
			sequence: 1,
			text: "Result",
			attachmentCount: 0,
			phase: "final",
			createdAt: timestamp,
			authorUserId: userA.id,
			staffSpeaker: { runId: id(81), staffAgentId: id(82), staffVersion: 1, displayName: "Historical Bob" },
		};
		const state = f.company.conversation(session.sessionId);
		for (const [speaker, name] of [
			[agent.staffSpeaker, "Historical Bob"],
			[{ runId: id(81), staffAgentId: id(82), staffVersion: 1 }, `Agent ${id(82)}`],
			[undefined, "Agent reply · speaker unavailable"],
		] as const) {
			state.set({ projection: { items: [{ ...agent, staffSpeaker: speaker }], hiddenCount: 0, lastSequence: 1 } });
			f.view.update();
			expect(f.view.el.querySelector(".message-author")?.textContent).toBe(name);
			expect(f.view.el.querySelector(".message")?.getAttribute("aria-label")).toContain(name);
		}
	});
	it("groups agent bubbles within one message while retaining authors, timestamps and delivery state", () => {
		const f = setup();
		f.company.store.set({
			team: {
				...team,
				members: [
					{ userId: userB.id, email: userB.email!, displayName: "Anna", role: "contributor", joinedAt: timestamp },
				],
			},
		});
		const agent: TranscriptMessage = {
			kind: "agent",
			id: id(80),
			sequence: 1,
			text: "First paragraph.\n\nSecond paragraph.",
			attachmentCount: 1,
			phase: "progress",
			createdAt: timestamp,
		};
		const member: TranscriptMessage = {
			kind: "member",
			id: id(81),
			sequence: 2,
			text: "**Literal** member text\n\nAnother paragraph.",
			attachmentCount: 0,
			authorUserId: userB.id,
			createdAt: timestamp,
		};
		const mine: TranscriptMessage = {
			...member,
			id: id(82),
			sequence: 3,
			authorUserId: userA.id,
			pending: "failed",
			failureReason: "Please retry",
		};
		const items = [agent, member, mine];
		f.company.conversation(session.sessionId).set({ projection: { items, hiddenCount: 1, lastSequence: 3 } });
		f.view.update();
		const messages = f.view.el.querySelectorAll<HTMLElement>(".message");
		expect(messages).toHaveLength(3);
		expect(messages[0]?.dataset.messageId).toBe(agent.id);
		expect(messages[0]?.querySelectorAll(".bubble")).toHaveLength(2);
		expect(messages[0]?.getAttribute("aria-label")).toContain(staff.displayName);
		expect(messages[0]?.title).toContain(fmtTime(timestamp));
		// A progress message is not labelled: its text is the whole message.
		expect(messages[0]?.classList.contains("message-progress")).toBe(true);
		expect(messages[0]?.querySelector(".message-caption")).toBeNull();
		expect(messages[0]?.querySelectorAll(".received-file")).toHaveLength(1);
		expect(messages[0]?.querySelector(".received-file")?.textContent).toContain("Preview unavailable");
		expect(messages[1]?.querySelector(".message-author")?.textContent).toBe("Anna");
		expect(messages[1]?.querySelectorAll(".bubble")).toHaveLength(1);
		expect(messages[1]?.querySelector(".text")?.textContent).toBe(member.text);
		expect(messages[2]?.querySelector(".message-caption")?.textContent).toBe("Failed · Please retry");
		expect(f.view.el.querySelector(".message .avatar, .message .figure, .message .meta")).toBeNull();
		expect(f.company.conversation(session.sessionId).get().projection.items).toBe(items);
		for (const pending of ["queued", "processing"] as const) {
			f.company.conversation(session.sessionId).set({
				projection: { items: [{ ...mine, pending }], hiddenCount: 0, lastSequence: 3 },
			});
			f.view.update();
			expect(f.view.el.querySelector(".message-caption")?.textContent?.toLowerCase()).toBe(pending);
		}
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("draws an erased message as (erased), also in place of one already drawn", () => {
		const f = setup();
		const member: TranscriptMessage = {
			kind: "member",
			id: id(83),
			sequence: 1,
			text: "Before",
			attachmentCount: 0,
			authorUserId: userB.id,
			createdAt: timestamp,
		};
		const agent: TranscriptMessage = {
			kind: "agent",
			id: id(84),
			sequence: 2,
			text: "Reply",
			attachmentCount: 0,
			createdAt: timestamp,
		};
		const state = f.company.conversation(session.sessionId);
		state.set({ projection: { items: [member, agent], hiddenCount: 0, lastSequence: 2 } });
		f.view.update();
		state.set({
			projection: {
				items: [
					{ ...member, text: "", erased: true },
					{ ...agent, text: "", erased: true },
				],
				hiddenCount: 0,
				lastSequence: 2,
			},
		});
		f.view.update();
		const messages = [...f.view.el.querySelectorAll<HTMLElement>(".message")];
		const bubbles = messages.map((message) => message.querySelector(".bubble")?.textContent);
		expect(bubbles).toEqual(["(erased)", "(erased)"]);
		expect(messages.every((message) => message.classList.contains("message-erased"))).toBe(true);
	});
	/** A thread the controller reads from a cloud whose `history` and erasure `generation` the test changes; `hold`
	 * keeps the forward read after one sequence on its way until released. */
	async function erasable(history: HostedSessionEvent[], generation: number, actions: WorkspaceActions = {}) {
		const f = fixture();
		const server: {
			history: HostedSessionEvent[];
			generation: number;
			hold?: { after: number; reached: ReturnType<typeof deferred<void>>; until: Promise<void> };
		} = { history, generation };
		vi.mocked(f.api.readSessionEvents).mockImplementation(async (_session, after = 0) => {
			if (server.hold?.after === after) {
				server.hold.reached.resolve();
				await server.hold.until;
			}
			return server.history.filter((item) => item.sequence > after);
		});
		vi.mocked(f.api.readSessionMemoryGeneration).mockImplementation(async () => server.generation);
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		const view = new ConversationView(company, session.sessionId, actions);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		await settle();
		const bubbles = () =>
			[...view.el.querySelectorAll(".message")].map((message) => message.querySelector(".bubble")?.textContent);
		return { ...f, server, company, view, bubbles };
	}
	const erasedCopy = (item: HostedSessionEvent): HostedSessionEvent => ({ ...item, body: { erased: true } });
	it("draws a message it showed as (erased) once a full read finds the erase; no read brings it back", async () => {
		const before = event(1, "Before");
		const reply = event(2, "Reply");
		const f = await erasable([before, reply], 0);
		expect(f.bubbles()).toEqual(["Before", "Reply"]);
		// The erase rewrites the event in place, under the same sequence, and raises the generation.
		f.server.history = [erasedCopy(before), reply];
		f.server.generation = 1;
		// A read of new events only does not see it; the next full read (the open thread's clock) does.
		await f.company.loadConversation(session.sessionId, { eventsOnly: true });
		expect(f.bubbles()).toEqual(["Before", "Reply"]);
		vi.mocked(f.api.readSessionEvents).mockClear();
		await f.company.loadConversation(session.sessionId);
		await settle();
		expect(f.bubbles()).toEqual(["(erased)", "Reply"]);
		expect(vi.mocked(f.api.readSessionEvents).mock.calls.map((call) => call[1])).toEqual([2, 0]);
		// A later erase, read beside a copy of the first message from before its erase: that copy does not bring the
		// words back.
		f.server.history = [before, erasedCopy(reply)];
		f.server.generation = 2;
		await f.company.loadConversation(session.sessionId);
		await settle();
		expect(f.bubbles()).toEqual(["(erased)", "(erased)"]);
		// The same generation again reads only what came after.
		vi.mocked(f.api.readSessionEvents).mockClear();
		await f.company.loadConversation(session.sessionId);
		expect(vi.mocked(f.api.readSessionEvents).mock.calls.map((call) => call[1])).toEqual([2]);
	});
	it("reads a thread again when its first read finds a generation an erase may have raised meanwhile", async () => {
		const before = event(1, "Before");
		const f = fixture();
		// The first read of the history is from before the erase; the generation read beside it is from after.
		vi.mocked(f.api.readSessionEvents)
			.mockResolvedValueOnce([before])
			.mockResolvedValue([erasedCopy(before)]);
		vi.mocked(f.api.readSessionMemoryGeneration).mockResolvedValue(1);
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		const view = new ConversationView(company, session.sessionId, {});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		await settle();
		expect([...view.el.querySelectorAll(".message .bubble")].map((bubble) => bubble.textContent)).toEqual([
			"(erased)",
		]);
		expect(company.conversation(session.sessionId).get().memoryGeneration).toBe(1);
	});
	it.each([
		["after the thread was read again", false],
		["while the thread is read again", true],
	] as const)("reads every event again when a Show earlier from before an erase lands %s", async (_when, during) => {
		const f = await erasable([event(5, "Five")], 0);
		const state = f.company.conversation(session.sessionId);
		// The thread opened at its newest events: older ones wait for Show earlier.
		state.set({ hasEarlier: true });
		const earlier = deferred<HostedSessionEvent[]>();
		vi.mocked(f.api.readSessionEventsTail).mockReturnValue(earlier.promise);
		const showing = f.company.loadEarlier(session.sessionId);
		// Meanwhile an older message is erased; a full read finds it and reads what the thread has (event 5 on) again.
		f.server.history = [erasedCopy(event(3, "Three")), event(5, "Five")];
		f.server.generation = 1;
		const until = deferred<void>();
		if (during) f.server.hold = { after: 4, reached: deferred<void>(), until: until.promise };
		const loading = f.company.loadConversation(session.sessionId);
		if (f.server.hold) await f.server.hold.reached.promise;
		else await loading;
		// Show earlier lands with its copy from before the erase.
		earlier.resolve([event(3, "Three")]);
		await showing;
		until.resolve();
		await loading;
		await settle();
		expect(f.bubbles()).toEqual(["Three", "Five"]);
		expect(state.get().memoryGeneration).toBeUndefined();
		// The next full read reads every event again.
		await f.company.loadConversation(session.sessionId);
		await settle();
		expect(f.bubbles()).toEqual(["(erased)", "Five"]);
		expect(state.get().memoryGeneration).toBe(1);
	});
	/** The menu a thread's message opens, `from` a mouse's right-click, a long press, Shift+F10 or the menu key (released,
	 * as on Windows), and the status lines above the composer (M3e). Like a browser, it fires the keyboard's at the focused
	 * element's place, not at 0,0. */
	const messageMenu = (message: Element, from: "mouse" | "touch" | "Shift+F10" | "menu key" = "mouse") => {
		if (from === "Shift+F10")
			message.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
		else if (from === "menu key")
			message.dispatchEvent(new KeyboardEvent("keyup", { key: "ContextMenu", bubbles: true }));
		else
			message.dispatchEvent(
				Object.defineProperty(new MouseEvent("pointerdown", { bubbles: true }), "pointerType", { value: from }),
			);
		const opened = message.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
		);
		const menu = document.querySelector<HTMLElement>(".context-menu");
		return { offered: !opened, menu, items: [...(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])] };
	};
	const notices = (root: ParentNode) => [...root.querySelectorAll(".notice")].map((item) => item.textContent);
	/** The words the thread names a message by: its author and time, as its own label reads; mid-sentence, the
	 * member's own message is from "you". */
	const named = (message: Element) => {
		const [author, time] = message.getAttribute("aria-label")!.split(" · ");
		return { author: author === "You" ? "you" : author!, time: time! };
	};
	const erases = (answers: MessageErase["state"][], copies: MessageErase["copies"] = []) => {
		const erase = (state: MessageErase["state"]): MessageErase => ({
			eraseId: id(90),
			state,
			sessionId: session.sessionId,
			eventId: id(1001),
			// Step 3 names the copies.
			copies: state === "requested" || state === "done" ? copies : [],
		});
		const request = vi.fn(async (_session: string, _event: string, _signal: AbortSignal) => erase(answers[0]!));
		let read = 0;
		const status = vi.fn(async (_erase: MessageErase, _signal: AbortSignal) => erase(answers[++read] ?? "done"));
		return { request, status };
	};
	it("offers Erase on a message's own menu to an owner or admin, how it went once erased, nothing on its way", async () => {
		const f = setup({ messageErases: erases(["pending"]) });
		const sent: TranscriptMessage = {
			kind: "member",
			id: id(83),
			sequence: 1,
			text: "Before",
			attachmentCount: 0,
			authorUserId: userB.id,
			createdAt: timestamp,
		};
		const items = [
			sent,
			{ ...sent, id: id(84), sequence: 2, text: "", erased: true as const },
			{ ...sent, id: id(85), sequence: 3, text: "On its way", pending: "queued" as const },
		];
		f.company.conversation(session.sessionId).set({ projection: { items, hiddenCount: 0, lastSequence: 3 } });
		f.view.update();
		const messages = () => [...f.view.el.querySelectorAll(".message")];
		const first = messageMenu(messages()[0]!);
		expect(first.offered).toBe(true);
		expect(first.menu?.getAttribute("aria-label")).toBe(`Message from ${named(messages()[0]!).author}`);
		expect(first.items.map((item) => item.textContent)).toEqual(["Erase message"]);
		first.menu!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector(".context-menu")).toBeNull();
		// The erased one offers how its erase went; the one still on its way keeps the browser's own menu.
		const erased = messageMenu(messages()[1]!);
		expect(erased.items.map((item) => item.textContent)).toEqual(["Show how the erase went"]);
		erased.menu!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		// Its words are gone, so a long press on it offers nothing to copy, even with text selected in it.
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn() } });
		try {
			document.getSelection()!.selectAllChildren(messages()[1]!);
			const pressed = messageMenu(messages()[1]!, "touch");
			expect(pressed.items.map((item) => item.textContent)).toEqual(["Show how the erase went"]);
			pressed.menu!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		} finally {
			Reflect.deleteProperty(navigator, "clipboard");
			document.getSelection()!.removeAllRanges();
		}
		expect(messageMenu(messages()[2]!).offered).toBe(false);
		// The route takes owners and admins: a contributor or a viewer is not offered it.
		for (const role of ["admin", "contributor", "viewer"] as const) {
			f.company.store.set({ team: { ...team, role } });
			const menu = messageMenu(messages()[0]!);
			expect(menu.offered).toBe(role === "admin");
			menu.menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		}
		// Nor without the erase route.
		dispose?.();
		const bare = setup();
		bare.company.conversation(session.sessionId).set({ projection: { items, hiddenCount: 0, lastSequence: 3 } });
		bare.view.update();
		expect(messageMenu(bare.view.el.querySelector(".message")!).offered).toBe(false);
	});
	it("erases a message once confirmed, says how far it got and draws it (erased)", async () => {
		const before = event(1, "Before");
		const reply = event(2, "Reply");
		const route = erases(["pending", "open", "done"]);
		const f = await erasable([before, reply], 0, { messageErases: route });
		const message = f.view.el.querySelector(".message")!;
		const what = named(message);
		// The member's own message.
		expect(what.author).toBe("you");
		messageMenu(message).items[0]!.click();
		await settle();
		const dialog = document.querySelector(".modal-backdrop")!;
		expect(dialog.textContent).toContain(
			`Erase the message from ${what.author} at ${what.time}? It is erased for everyone: the thread shows (erased) in its place, and the company's memory forgets it. This can't be undone.`,
		);
		button(dialog, "Erase").click();
		await settle();
		expect(route.request).toHaveBeenCalledWith(session.sessionId, before.eventId, expect.any(AbortSignal));
		expect(notices(f.view.el)).toContain(`Erasing the message from ${what.author} at ${what.time}…`);
		// The cloud blanks it: the next read of the erase says `open`, and the thread reads itself again in full.
		f.server.history = [{ ...before, body: { erased: true } }, reply];
		f.server.generation = 1;
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		await settle();
		expect(route.status).toHaveBeenCalledTimes(1);
		expect(f.bubbles()).toEqual(["(erased)", "Reply"]);
		expect(notices(f.view.el)).toContain(
			`The message from ${what.author} at ${what.time} is erased from the thread. Clearing it from the company's memory…`,
		);
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(notices(f.view.el)).toContain(
			`Erased the message from ${what.author} at ${what.time}: it is gone from the thread and from the company's memory.`,
		);
		// Done: it reads no more.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(route.status).toHaveBeenCalledTimes(2);
		// The erased message's menu no longer offers Erase, only how it went.
		const erased = messageMenu(f.view.el.querySelector(".message")!);
		expect(erased.items.map((item) => item.textContent)).toEqual(["Show how the erase went"]);
		erased.menu!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
	it("names each copy the erase leaves by its path, and says the message is not gone from them", async () => {
		const here = profileA.environmentId;
		const route = erases(
			["pending", "requested", "done"],
			[
				{ environmentId: here, path: "Zeta/notes.md", live: false },
				{ environmentId: here, path: "reports/r2.md", live: true },
				// Another environment of the company.
				{ environmentId: id(56), path: "old.md", live: false },
				{ environmentId: id(56), path: "reports/r2.md", live: true },
			],
		);
		const f = await erasable([event(1, "Before")], 0, { messageErases: route });
		const what = named(f.view.el.querySelector(".message")!);
		messageMenu(f.view.el.querySelector(".message")!).items[0]!.click();
		await settle();
		button(document.querySelector(".modal-backdrop")!, "Erase").click();
		await settle();
		const lines = () =>
			[...f.view.el.querySelectorAll(".notice")].map((item) => [...item.children].map((line) => line.textContent));
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		const copies = [
			"A copy stays in the history of Zeta/notes.md, which is deleted.",
			"A copy stays in reports/r2.md.",
			"A copy stays in the history of old.md in another Company File, where it is deleted.",
			"A copy stays in reports/r2.md in another Company File.",
		];
		expect(lines()).toContainEqual([
			`The message from ${what.author} at ${what.time} is erased from the thread. Clearing it from the company's memory…`,
			...copies,
		]);
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(lines()).toContainEqual([
			`Erased the message from ${what.author} at ${what.time} from the thread and from the company's memory, but not from files that hold a copy of it.`,
			...copies,
		]);
		expect(f.view.el.querySelector(".notice-warn")).not.toBeNull();
	});
	it("asks nothing when the member does not confirm", async () => {
		const route = erases(["pending"]);
		const f = await erasable([event(1, "Before")], 0, { messageErases: route });
		messageMenu(f.view.el.querySelector(".message")!).items[0]!.click();
		await settle();
		button(document.querySelector(".modal-backdrop")!, "Cancel").click();
		await settle();
		expect(route.request).not.toHaveBeenCalled();
		expect(notices(f.view.el)).toEqual([]);
	});
	it("offers Erase on a message an earlier page brought, outside the live log", async () => {
		const route = erases(["pending"]);
		const f = setup({ messageErases: route });
		const state = f.company.conversation(session.sessionId);
		const message = (sequence: number, text: string): TranscriptMessage => ({
			kind: "member",
			id: id(80 + sequence),
			sequence,
			text,
			attachmentCount: 0,
			authorUserId: userB.id,
			createdAt: timestamp,
		});
		const newest = { items: [message(3, "Three")], hiddenCount: 0, lastSequence: 3 };
		state.set({ loading: false, hasEarlier: true, projection: newest });
		f.view.update();
		state.set({ earlierLoading: true });
		f.view.update();
		const items = [message(1, "One"), message(3, "Three")];
		state.set({ earlierLoading: false, hasEarlier: false, projection: { items, hiddenCount: 0, lastSequence: 3 } });
		f.view.update();
		const older = f.view.el.querySelector<HTMLElement>(".thread-older .message")!;
		expect(older.textContent).toContain("One");
		const menu = messageMenu(older);
		expect(menu.offered).toBe(true);
		menu.items[0]!.click();
		await settle();
		button(document.querySelector(".modal-backdrop")!, "Erase").click();
		await settle();
		expect(route.request).toHaveBeenCalledWith(session.sessionId, id(81), expect.any(AbortSignal));
	});
	it("gives the keyboard back to the link or the message the menu was opened on", async () => {
		const route = erases(["pending"]);
		const f = setup({ messageErases: route });
		// The view's own first read lands before the test draws the thread.
		await settle();
		const reply: TranscriptMessage = {
			kind: "agent",
			id: id(83),
			sequence: 1,
			text: "See [the plan](https://example.com/plan).",
			attachmentCount: 0,
			phase: "final",
			createdAt: timestamp,
			authorUserId: userA.id,
		};
		const state = f.company.conversation(session.sessionId);
		state.set({ loading: false, projection: { items: [reply], hiddenCount: 0, lastSequence: 1 } });
		f.view.update();
		const message = f.view.el.querySelector<HTMLElement>(".message")!;
		const link = message.querySelector<HTMLElement>("a[href]")!;
		const pressEscape = (menu: HTMLElement | null) =>
			menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		// Shift+F10 on a link in the message, then Escape: the link has the keyboard again.
		link.focus();
		const fromLink = messageMenu(link, "Shift+F10");
		expect(fromLink.offered).toBe(true);
		pressEscape(fromLink.menu);
		expect(document.activeElement).toBe(link);
		// And again after Cancel in the dialog that Erase opens.
		messageMenu(link, "Shift+F10").items[0]!.click();
		await settle();
		button(document.querySelector(".modal-backdrop")!, "Cancel").click();
		await settle();
		expect(document.activeElement).toBe(link);
		// A right-click elsewhere in it, with the keyboard outside the message: the message itself takes the keyboard.
		link.blur();
		pressEscape(messageMenu(message.querySelector(".bubble")!).menu);
		expect(document.activeElement).toBe(message);
		messageMenu(message).items[0]!.click();
		await settle();
		button(document.querySelector(".modal-backdrop")!, "Cancel").click();
		await settle();
		expect(document.activeElement).toBe(message);
		expect(route.request).not.toHaveBeenCalled();
		// The message erased and drawn again without its link: the message keeps the keyboard.
		link.focus();
		state.set({ projection: { items: [{ ...reply, text: "", erased: true }], hiddenCount: 0, lastSequence: 1 } });
		f.view.update();
		expect(link.isConnected).toBe(false);
		expect(document.activeElement).toBe(f.view.el.querySelector(".message"));
		// The message gone from the thread while its dialog is open: Cancel leaves the keyboard on the thread.
		state.set({ projection: { items: [reply], hiddenCount: 0, lastSequence: 1 } });
		f.view.update();
		messageMenu(f.view.el.querySelector(".message")!).items[0]!.click();
		await settle();
		state.set({ projection: { items: [], hiddenCount: 0, lastSequence: 1 } });
		f.view.update();
		expect(f.view.el.querySelector(".message")).toBeNull();
		button(document.querySelector(".modal-backdrop")!, "Cancel").click();
		await settle();
		expect(document.activeElement).toBe(f.view.el.querySelector(".messages"));
		expect(route.request).not.toHaveBeenCalled();
	});
	it("says in plain words why an erase stopped", async () => {
		const cases: [Partial<Record<"request" | "status", MessageEraseError>>, MessageErase["state"][], string][] = [
			[{ request: new MessageEraseError("no", 403) }, [], "Only an owner or admin can erase messages."],
			// A 401 is the member's sign-in, not their role.
			[
				{ request: new MessageEraseError("no", 401) },
				[],
				"Could not erase the message from {author} at {time}. Try again.",
			],
			[{ request: new MessageEraseError("no", 404) }, [], "The message from {author} at {time} can't be erased."],
			[{ request: new MessageEraseError("no", 423) }, [], "The company is paused, so no message can be erased now."],
			[
				{ request: new MessageEraseError("no", 503) },
				[],
				"Could not erase the message from {author} at {time}. Try again.",
			],
			[
				{},
				["pending", "refused"],
				"The message from {author} at {time} was not erased: only an owner or admin can erase messages.",
			],
			[
				{ status: new MessageEraseError("no", 404) },
				["pending"],
				"Could not read how the erase of the message from {author} at {time} is going.",
			],
		];
		for (const [failures, answers, line] of cases) {
			const route = erases(answers);
			if (failures.request) route.request.mockRejectedValue(failures.request);
			if (failures.status) route.status.mockRejectedValue(failures.status);
			const f = await erasable([event(1, "Before")], 0, { messageErases: route });
			const message = f.view.el.querySelector(".message")!;
			const what = named(message);
			messageMenu(message).items[0]!.click();
			await settle();
			button(document.querySelector(".modal-backdrop")!, "Erase").click();
			await settle();
			await vi.advanceTimersByTimeAsync(1000);
			await settle();
			expect(notices(f.view.el)).toEqual([line.replace("{author}", what.author).replace("{time}", what.time)]);
			// It reads no more after it stopped.
			const reads = route.status.mock.calls.length;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(route.status).toHaveBeenCalledTimes(reads);
			dispose?.();
			dispose = undefined;
			document.body.replaceChildren();
		}
	});
	it("keeps reading an erase after a read that failed on the way", async () => {
		const route = erases(["pending", "done"]);
		route.status.mockRejectedValueOnce(new MessageEraseError("Message erase is unavailable (503)", 503));
		const f = await erasable([event(1, "Before")], 0, { messageErases: route });
		const message = f.view.el.querySelector(".message")!;
		const what = named(message);
		messageMenu(message).items[0]!.click();
		await settle();
		button(document.querySelector(".modal-backdrop")!, "Erase").click();
		await settle();
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(notices(f.view.el)).toEqual([`Erasing the message from ${what.author} at ${what.time}…`]);
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(route.status).toHaveBeenCalledTimes(2);
		expect(notices(f.view.el)).toEqual([
			`Erased the message from ${what.author} at ${what.time}: it is gone from the thread and from the company's memory.`,
		]);
	});
	it("follows each erase on its own line, its copies as they come, while the member erases another", async () => {
		const first = event(1, "First");
		const second = { ...event(2, "Second"), createdAt: "2026-09-05T11:00:00Z" };
		const copy = (path: string) => ({ environmentId: profileA.environmentId, path, live: true });
		const erase = (asked: HostedSessionEvent, state: MessageErase["state"], copies: MessageErase["copies"] = []) => ({
			eraseId: id(asked.sequence + 90),
			state,
			sessionId: session.sessionId,
			eventId: asked.eventId,
			copies,
		});
		// The first stays `rewritten` while step 3 names its copies, block by block; the second is done at its first read.
		const answers = new Map<string, MessageErase[]>([
			[
				first.eventId,
				[
					erase(first, "pending"),
					erase(first, "rewritten", [copy("a.md")]),
					erase(first, "rewritten", [copy("a.md"), copy("b.md")]),
					erase(first, "done", [copy("a.md"), copy("b.md")]),
				],
			],
			[second.eventId, [erase(second, "pending"), erase(second, "done")]],
		]);
		const reads = new Map<string, number>();
		// A request answers with the erase as it stands; a status read moves it on.
		const latest = (eventId: string) => {
			const list = answers.get(eventId)!;
			return list[Math.min(reads.get(eventId) ?? 0, list.length - 1)]!;
		};
		const route = {
			request: vi.fn(async (_session: string, eventId: string, _signal: AbortSignal) => latest(eventId)),
			status: vi.fn(async (asked: MessageErase, _signal: AbortSignal) => {
				reads.set(asked.eventId, (reads.get(asked.eventId) ?? 0) + 1);
				return latest(asked.eventId);
			}),
		};
		const f = await erasable([first, second], 0, { messageErases: route });
		const messages = () => [...f.view.el.querySelectorAll(".message")];
		const [a, b] = messages().map(named);
		const lines = () =>
			[...f.view.el.querySelectorAll(".notice")].map((item) =>
				item.children.length ? [...item.children].map((line) => line.textContent) : [item.textContent],
			);
		// The second right after the first, while the first is still on its way.
		for (const index of [0, 1]) {
			messageMenu(messages()[index]!).items[0]!.click();
			await settle();
			button(document.querySelector(".modal-backdrop")!, "Erase").click();
			await settle();
		}
		expect(lines()).toEqual([
			[`Erasing the message from ${a!.author} at ${a!.time}…`],
			[`Erasing the message from ${b!.author} at ${b!.time}…`],
		]);
		f.server.history = [erasedCopy(first), erasedCopy(second)];
		f.server.generation = 1;
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		await settle();
		expect(f.bubbles()).toEqual(["(erased)", "(erased)"]);
		const clearing = `The message from ${a!.author} at ${a!.time} is erased from the thread. Clearing it from the company's memory…`;
		expect(lines()).toEqual([
			[clearing, "A copy stays in a.md."],
			[
				`Erased the message from ${b!.author} at ${b!.time}: it is gone from the thread and from the company's memory.`,
			],
		]);
		// The next read, still `rewritten`, names one more copy.
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(lines()[0]).toEqual([clearing, "A copy stays in a.md.", "A copy stays in b.md."]);
		await vi.advanceTimersByTimeAsync(4000);
		await settle();
		const done = [
			`Erased the message from ${a!.author} at ${a!.time} from the thread and from the company's memory, but not from files that hold a copy of it.`,
			"A copy stays in a.md.",
			"A copy stays in b.md.",
		];
		expect(lines()[0]).toEqual(done);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(route.status).toHaveBeenCalledTimes(4);
		// Read again from the first message's menu: its new line takes the old one's place, and the second's, done with
		// nothing left to say, goes.
		const show = messageMenu(messages()[0]!);
		expect(show.items.map((item) => item.textContent)).toEqual(["Show how the erase went"]);
		show.items[0]!.click();
		await settle();
		expect(document.querySelector(".modal-backdrop")).toBeNull();
		expect(route.request).toHaveBeenCalledTimes(3);
		expect(lines()).toEqual([done]);
	});
	it("reads again how an erased message's erase went, without asking", async () => {
		const before = event(1, "Before");
		const route = erases(["done"], [{ environmentId: profileA.environmentId, path: "reports/r2.md", live: true }]);
		const f = await erasable([erasedCopy(before)], 0, { messageErases: route });
		expect(f.bubbles()).toEqual(["(erased)"]);
		const what = { author: "you", time: fmtTime(timestamp) };
		const menu = messageMenu(f.view.el.querySelector(".message")!);
		expect(menu.items.map((item) => item.textContent)).toEqual(["Show how the erase went"]);
		menu.items[0]!.click();
		await settle();
		// No dialog: the route answers a message already erased with the erase that did it.
		expect(document.querySelector(".modal-backdrop")).toBeNull();
		expect(route.request).toHaveBeenCalledWith(session.sessionId, before.eventId, expect.any(AbortSignal));
		expect(notices(f.view.el)).toEqual([
			`Erased the message from ${what.author} at ${what.time} from the thread and from the company's memory, but not from files that hold a copy of it.A copy stays in reports/r2.md.`,
		]);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(route.status).not.toHaveBeenCalled();
		// A read that fails says so, and nothing about erasing it.
		route.request.mockRejectedValueOnce(new MessageEraseError("Message erase is unavailable (503)", 503));
		messageMenu(f.view.el.querySelector(".message")!).items[0]!.click();
		await settle();
		expect(notices(f.view.el)).toEqual([
			`Could not read how the erase of the message from ${what.author} at ${what.time} is going.`,
		]);
	});
	it("leaves the browser's menu to a link or an attachment, and to a mouse's right-click on text selected in a message", async () => {
		const route = erases(["pending"]);
		const f = setup({ messageErases: route });
		await settle();
		const reply: TranscriptMessage = {
			kind: "agent",
			id: id(83),
			sequence: 1,
			text: "See [the plan](https://example.com/plan).",
			attachmentCount: 0,
			phase: "final",
			createdAt: timestamp,
			authorUserId: userA.id,
		};
		const state = f.company.conversation(session.sessionId);
		state.set({ loading: false, projection: { items: [reply], hiddenCount: 0, lastSequence: 1 } });
		f.view.update();
		const message = f.view.el.querySelector<HTMLElement>(".message")!;
		const bubble = message.querySelector(".bubble")!;
		const link = message.querySelector<HTMLElement>("a[href]")!;
		const pressEscape = (menu: HTMLElement | null) =>
			menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		// Open link, Copy link address: the browser's, by a right-click or a long press.
		expect(messageMenu(link).offered).toBe(false);
		expect(messageMenu(link, "touch").offered).toBe(false);
		expect(document.querySelector(".context-menu")).toBeNull();
		// Shift+F10 or the menu key on the same link opens the message's, at the link's place.
		for (const from of ["Shift+F10", "menu key"] as const) {
			const menu = messageMenu(link, from);
			expect(menu.offered, from).toBe(true);
			pressEscape(menu.menu);
		}
		// The key doesn't stick: the mouse's next right-click there is the browser's again.
		expect(messageMenu(link).offered).toBe(false);
		// An image the message brought, as ReceivedAttachments draws it: Save image as.
		const attachments = message.appendChild(document.createElement("div"));
		attachments.className = "received-attachments";
		const image = attachments.appendChild(document.createElement("img"));
		expect(messageMenu(image).offered).toBe(false);
		expect(messageMenu(image, "touch").offered).toBe(false);
		attachments.remove();
		// Text selected in the message: Copy.
		const selection = document.getSelection()!;
		selection.selectAllChildren(bubble);
		const text = selection.toString();
		expect(messageMenu(bubble).offered).toBe(false);
		// Chrome's long press selects the word under the finger before the menu comes: the message's, with Copy in place of
		// the browser's. A Copy that fails says so above the composer, until one works.
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		try {
			writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
			const pressed = messageMenu(bubble, "touch");
			expect(pressed.items.map((item) => item.textContent)).toEqual(["Copy", "Erase message"]);
			pressed.items[0]!.click();
			await settle();
			expect(writeText).toHaveBeenLastCalledWith(text);
			expect(notices(f.view.el)).toEqual(["The text could not be copied."]);
			// jsdom drops the selection when the menu takes focus (a browser keeps it): the next long press selects again.
			selection.selectAllChildren(bubble);
			messageMenu(bubble, "touch").items[0]!.click();
			await settle();
			expect(writeText).toHaveBeenCalledTimes(2);
			expect(notices(f.view.el)).toEqual([]);
			// Firefox's selects only after a menu nobody took, so nothing is selected yet: Copy message, its whole text.
			selection.removeAllRanges();
			const whole = messageMenu(bubble, "touch");
			expect(whole.items.map((item) => item.textContent)).toEqual(["Copy message", "Erase message"]);
			whole.items[0]!.click();
			await settle();
			expect(writeText).toHaveBeenLastCalledWith(reply.text);
			expect(route.request).not.toHaveBeenCalled();
		} finally {
			Reflect.deleteProperty(navigator, "clipboard");
		}
		// With no clipboard (a page that isn't secure), a long press gives the message's menu alone.
		const plain = messageMenu(bubble, "touch");
		expect(plain.items.map((item) => item.textContent)).toEqual(["Erase message"]);
		pressEscape(plain.menu);
		// Text selected outside it: the message's own menu.
		const outside = document.body.appendChild(document.createElement("p"));
		outside.textContent = "Elsewhere";
		selection.selectAllChildren(outside);
		const pointer = messageMenu(bubble);
		expect(pointer.offered).toBe(true);
		pressEscape(pointer.menu);
		selection.removeAllRanges();
		outside.remove();
	});
	it("closes attachment previews and clears private drafts when the account signs out", async () => {
		const f = fixture(),
			root = document.createElement("div");
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		input(root, "Message", "Private unsent draft");
		attach(root, [new File(["private"], "private.png", { type: "image/png" })]);
		button(root, "Preview private.png").click();
		f.auth(null);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(document.querySelector("dialog")).toBeNull();
		expect(root.textContent).not.toContain("Private unsent draft");
		expect(URL.revokeObjectURL).toHaveBeenCalled();
		f.auth(userA);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(root.querySelector(".attachment-chip")).toBeNull();
		expect(root.querySelector<HTMLTextAreaElement>(".composer-input")?.value).toBe("");
	});
	it("opens badge-free details, stays read-only without a write port and keeps focus through refreshes", async () => {
		const f = setup();
		const identity = button(f.view.el, "Open agent details");
		expect(f.view.el.querySelector(".thread-header .badge")).toBeNull();
		identity.focus();
		identity.click();
		const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
		expect(field("Responsibilities").value).toBe(staff.charter);
		expect(field("Agent name").readOnly).toBe(true);
		expect(button(document, "Edit figure").disabled).toBe(true);
		expect(document.querySelector(".agent-inline-field.is-editable")).toBeNull();
		const close = button(document, "Close agent details");
		expect(document.activeElement).toBe(close);
		f.company.store.set({ staff: [{ ...staff, version: 2 }] });
		await settle();
		expect(document.activeElement).toBe(close);
		document.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector("dialog")).toBeNull();
		expect(document.activeElement).toBe(identity);
		expect(f.company.staffById(staff.id)?.displayName).toBe(staff.displayName);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("discards pending metadata saves on disposal and blocks writes after a role downgrade", async () => {
		const pending = deferred<number>(),
			updateAgent = vi.fn((_agent: unknown, _draft: unknown, _signal: AbortSignal) => pending.promise);
		const f = setup({ updateAgent });
		button(f.view.el, "Open agent details").click();
		const name = document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!;
		name.focus();
		input(document, "Agent name", "Renamed");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(name.readOnly).toBe(true);
		name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(updateAgent).not.toHaveBeenCalled();
		expect(name.value).toBe(staff.displayName);
		f.company.store.set({ team });
		await settle();
		name.focus();
		input(document, "Agent name", "Renamed");
		name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(updateAgent).toHaveBeenCalledTimes(1);
		expect(updateAgent.mock.calls[0]![1]).toMatchObject({ displayName: "Renamed", role: staff.role });
		f.view.dispose();
		expect(updateAgent.mock.calls[0]![2].aborted).toBe(true);
		pending.resolve(staff.version + 1);
		await settle();
		expect(document.querySelector("dialog")).toBeNull();
		expect(f.api.listStaff).not.toHaveBeenCalled();
	});
	it("enables supported image sends, previews locally and retains keyboard send semantics after removal", () => {
		const sendMessage = vi.fn().mockResolvedValue(true);
		const f = setup({ sendMessage });
		input(f.view.el, "Message", "Keep this draft");
		attach(f.view.el, [new File(["local"], "brief.png", { type: "image/png" })]);
		expect(f.company.conversation(session.sessionId).get().attachments).toHaveLength(1);
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		button(f.view.el, "Preview brief.png").click();
		expect(document.querySelector("dialog img")?.getAttribute("src")).toBe("blob:fixture-local-image");
		button(document, "Close file preview").click();
		button(f.view.el, "Remove brief.png").click();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture-local-image");
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		const field = f.view.el.querySelector("textarea")!;
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		expect(sendMessage).not.toHaveBeenCalled();
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			"Keep this draft",
			expect.any(AbortSignal),
		);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("keeps selected attachment bytes local and blocks text submission until they are removed", async () => {
		const f = fixture(),
			root = document.createElement("div");
		vi.spyOn(f.api, "appendPrompt");
		document.body.append(root);
		// Isolate attachment gating from the model-account selection flow.
		dispose = mountApplication(root, f.cloud, f.api, { nativeSubscription: undefined });
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		input(root, "Message", "Keep this local");
		await settle();
		const send = button(root, "Send message");
		expect(send.disabled).toBe(false);
		attach(root, [new File(["local"], "brief.txt", { type: "text/plain" })]);
		expect(send.disabled).toBe(true);
		send.click();
		root.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(root.querySelector("textarea")!.value).toBe("Keep this local");
		expect(root.querySelector(".attachment-status")?.textContent).toContain("Attachments stay on this device");
		expect(root.textContent).not.toContain("Remove them to send");
		button(root, "Remove brief.txt").click();
		expect(send.disabled).toBe(false);
		expect(root.querySelector("textarea")!.value).toBe("Keep this local");
		expect(f.api.appendPrompt).not.toHaveBeenCalled();
		expect(
			vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).endsWith("/qorpera_list_member_notifications")),
		).toHaveLength(0);
		// Only the company's mail (with its Digital Post), offers, consents and pages are read while it is open
		// (Interfaces steps I5c, I9c, C6a and C6d; RUNTIME-DIGITAL-POST.md).
		const companyRead = (name: string) =>
			name.startsWith("qorpera_member_mail_") ||
			name === "qorpera_member_digital_post" ||
			name === "qorpera_member_interface_offers" ||
			name === "qorpera_member_interface_supervisions" ||
			name === "qorpera_member_interface_pages";
		expect(vi.mocked(f.cloud.rpc).mock.calls.filter(([name]) => !companyRead(name))).toEqual([]);
	});
	it("keeps attachment drafts scoped to their conversation and releases previews on disposal", () => {
		const f = setup();
		attach(f.view.el, [new File(["local"], "private.png", { type: "image/png" })]);
		button(f.view.el, "Preview private.png").click();
		f.view.dispose();
		expect(document.querySelector("dialog")).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalled();
		const other = new ConversationView(f.company, id(90));
		expect(other.el.querySelector(".attachment-tray")?.children).toHaveLength(0);
		other.dispose();
		const restored = new ConversationView(f.company, session.sessionId);
		expect(button(restored.el, "Preview private.png")).toBeDefined();
		restored.dispose();
	});
	function stubResizeObserver() {
		const observers: { callback: () => void; targets: Element[]; disconnected: boolean }[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly #entry: (typeof observers)[number];
				constructor(callback: () => void) {
					this.#entry = { callback, targets: [], disconnected: false };
					observers.push(this.#entry);
				}
				observe(target: Element) {
					this.#entry.targets.push(target);
				}
				disconnect() {
					this.#entry.disconnected = true;
				}
			},
		);
		return observers;
	}

	it("opens a loaded conversation at its latest message and keeps it there while the pane resizes", () => {
		// The view renders before it is placed in the page, so the end of the
		// thread can only be shown once the message pane has a size.
		const observers = stubResizeObserver();
		const { view, messages, metrics } = loadedView();
		const sizes = observers.find((entry) => entry.targets.includes(messages))!;
		expect(sizes.targets).toEqual([messages]);
		document.body.append(view.el);
		metrics.scrollHeight = 2000;
		sizes.callback();
		expect(metrics.scrollTop).toBe(1600);
		// A reader who scrolled up to older messages is left there.
		metrics.scrollTop = 500;
		messages.dispatchEvent(new Event("scroll"));
		metrics.scrollHeight = 2400;
		sizes.callback();
		expect(metrics.scrollTop).toBe(500);
		// Back at the end, a pane that changes size still shows the latest message.
		metrics.scrollTop = 2000;
		messages.dispatchEvent(new Event("scroll"));
		metrics.scrollHeight = 2600;
		sizes.callback();
		expect(metrics.scrollTop).toBe(2200);
		view.dispose();
		expect(sizes.disconnected).toBe(true);
		metrics.scrollTop = 0;
		sizes.callback();
		expect(metrics.scrollTop).toBe(0);
	});

	it("stays pinned when the pin's own scroll event arrives after the pane shrank", () => {
		// The composer or a notice line appears in the same task as the pin, so the
		// pin's scroll event reads a gap it did not cause. Only a real scroll counts.
		const observers = stubResizeObserver();
		const { view, messages, metrics } = loadedView();
		const sizes = observers.find((entry) => entry.targets.includes(messages))!;
		document.body.append(view.el);
		metrics.scrollHeight = 2000;
		sizes.callback();
		expect(metrics.scrollTop).toBe(1600);
		metrics.clientHeight = 340; // a line appeared above the composer
		messages.dispatchEvent(new Event("scroll")); // the pin's event, 60px short now
		sizes.callback();
		expect(metrics.scrollTop).toBe(1660);
		// The guard is spent: the next event at another position is the member's.
		metrics.scrollTop = 1000;
		messages.dispatchEvent(new Event("scroll"));
		metrics.scrollHeight = 2400;
		sizes.callback();
		expect(metrics.scrollTop).toBe(1000);
		// Back at the end; a pin that does not move the thread arms nothing, so a
		// later real scroll that lands on the same position is still the member's.
		metrics.scrollTop = 2060;
		messages.dispatchEvent(new Event("scroll"));
		sizes.callback();
		expect(metrics.scrollTop).toBe(2060);
		metrics.scrollHeight = 2500; // content grew under the reader
		messages.dispatchEvent(new Event("scroll")); // still at 2060: 100px from the end
		metrics.scrollHeight = 2600;
		sizes.callback();
		expect(metrics.scrollTop).toBe(2060);
		view.dispose();
	});
	it("still opens a loaded conversation at its latest message without a size observer", async () => {
		vi.stubGlobal("ResizeObserver", undefined);
		const { view, metrics } = loadedView();
		metrics.scrollHeight = 2000;
		document.body.append(view.el);
		expect(metrics.scrollTop).toBe(0);
		await Promise.resolve();
		expect(metrics.scrollTop).toBe(1600);
	});
	it("keeps the computer popover compact and the conversation usable at every width", () => {
		const f = setup();
		expect(f.view.show(staff.id, "computer")).toBe(true);
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(document.activeElement).toBe(panel);
		expect(panel.textContent).toContain("Computer access is not available yet.");
		expect(panel.querySelector("header, select, .computer-preview")).toBeNull();
		expect(panel.textContent).not.toContain("Open computer");
		expect(panel.textContent).not.toContain("Routines");
		const composer = f.view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		for (const width of [1280, 600, 375]) {
			vi.stubGlobal("innerWidth", width);
			window.dispatchEvent(new Event("resize"));
			expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
			composer.focus();
			expect(document.activeElement).toBe(composer);
		}
		panel.focus();
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(f.view.el.querySelector(".computer-panel")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
		expect(document.activeElement).toBe(composer);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("has no computer button in the header; the agent's card opens the computer, once however often it asks", () => {
		const f = setup();
		const header = f.view.el.querySelector<HTMLElement>(".thread-header")!;
		expect([...header.children].map((node) => node.className)).toEqual([
			"mobile-navigation-toggle icon-button",
			"thread-identity",
			"thread-presence",
		]);
		// The rail names an agent's own chat on a wide screen, so its header shows only on a phone.
		expect(header.classList.contains("is-agent")).toBe(true);
		// The phone header's identity opens the agent's card, and its Computer line opens the panel here.
		button(f.view.el, "Open agent details").click();
		button(document, "Computer").click();
		expect(document.querySelector(".agent-details")).toBeNull();
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(document.activeElement).toBe(panel);
		// Asked again, the open one takes the keyboard; there is never a second.
		f.view.el.querySelector<HTMLTextAreaElement>(".composer-input")!.focus();
		expect(f.view.show(staff.id, "computer")).toBe(true);
		expect(f.view.el.querySelectorAll(".computer-panel")).toHaveLength(1);
		expect(f.view.el.querySelector(".computer-panel")).toBe(panel);
		expect(document.activeElement).toBe(panel);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("opens nothing for another agent, or before the thread knows its agent", () => {
		const f = setup();
		expect(f.view.show(id(97), "computer")).toBe(false);
		expect(f.view.el.querySelector(".computer-panel")).toBeNull();
		const unknown = new ConversationView(f.company, id(90));
		document.body.append(unknown.el);
		expect(unknown.show(staff.id, "computer")).toBe(false);
		expect(unknown.el.querySelector(".computer-panel")).toBeNull();
		unknown.dispose();
		// A thread that is gone opens nothing either.
		f.view.dispose();
		expect(f.view.show(staff.id, "computer")).toBe(false);
	});
	it("closes the popover from its X top right and goes back to the composer", () => {
		const f = setup();
		f.view.show(staff.id, "computer");
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		const close = panel.querySelector<HTMLButtonElement>("button.computer-close")!;
		expect(close.getAttribute("aria-label")).toBe("Close computer");
		expect(close.getAttribute("title")).toBe("Close");
		close.click();
		expect(f.view.el.querySelector(".computer-panel")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
		expect(document.activeElement).toBe(f.view.el.querySelector(".composer-input"));
		// It opens again from the card afterwards.
		expect(f.view.show(staff.id, "computer")).toBe(true);
		expect(f.view.el.querySelectorAll(".computer-panel")).toHaveLength(1);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("keeps the agent's computer open across the threads a member moves between", () => {
		const panels = new ComputerPanels(),
			f = setup({ computerPanels: panels });
		f.view.show(staff.id, "computer");
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(panel).not.toBeNull();
		// Leaving the thread keeps the panel; it is only out of the page for now.
		f.view.dispose();
		expect(panel.isConnected).toBe(false);
		expect(panels.get(staff.id)?.el).toBe(panel);
		// Another thread without this agent shows nothing of it.
		const other = new ConversationView(f.company, id(90), { computerPanels: panels });
		expect(other.el.querySelector(".computer-panel")).toBeNull();
		other.dispose();
		// Back in the agent's thread the same panel is there, with no click.
		const restored = new ConversationView(f.company, session.sessionId, { computerPanels: panels });
		document.body.append(restored.el);
		expect(restored.el.querySelector(".computer-panel")).toBe(panel);
		// Closing it there ends it for every thread.
		panel.querySelector<HTMLButtonElement>("button.computer-close")!.click();
		expect(restored.el.querySelector(".computer-panel")).toBeNull();
		expect(panels.get(staff.id)).toBeUndefined();
		restored.dispose();
		const again = new ConversationView(f.company, session.sessionId, { computerPanels: panels });
		expect(again.el.querySelector(".computer-panel")).toBeNull();
		again.dispose();
		// The company's shared panel set is left to the company: this view never disposes it.
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});

	it("keeps the open computer through a rename and replaces it only when the thread changes agent", async () => {
		const panels = new ComputerPanels(),
			f = setup({ computerPanels: panels });
		f.view.show(staff.id, "computer");
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		f.company.store.set({ staff: [{ ...staff, displayName: "Renamed" }] });
		await settle();
		expect(f.view.el.querySelector(".computer-panel")).toBe(panel);
		expect(f.view.el.querySelector(".thread-identity h1")?.textContent).toBe("Renamed");
		expect(panels.get(staff.id)?.el).toBe(panel);
		const other = { ...staff, id: id(97), displayName: "Other" };
		f.company.store.set({
			staff: [{ ...staff, displayName: "Renamed" }, other],
			sessions: [{ ...session, staffAgentId: other.id }],
		});
		await settle();
		const replaced = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(replaced).not.toBe(panel);
		expect(panels.get(staff.id)).toBeUndefined();
		expect(panels.get(other.id)?.el).toBe(replaced);
		// The card of the agent who left opens nothing here any more; the new agent's does.
		expect(f.view.show(staff.id, "computer")).toBe(false);
		expect(f.view.show(other.id, "computer")).toBe(true);
		expect(f.view.el.querySelector(".computer-panel")).toBe(replaced);
	});

	it("closes a coworker's transcript open over the chat for the computer the card asks for", async () => {
		const f = setup();
		const coworker = { ...staff, id: id(97), displayName: "Helper" };
		f.company.store.set({ staff: [staff, coworker] });
		await f.company.loadConversation(session.sessionId);
		f.company.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "peer_link",
						id: id(96),
						sequence: 1,
						direction: "in",
						counterpartStaffId: coworker.id,
						pairSessionId: id(98),
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 1,
			},
		});
		f.view.update();
		const pane = f.view.el.querySelector<HTMLElement>(".thread-conversation")!;
		f.view.el.querySelector<HTMLButtonElement>(".peer-chip")!.click();
		await settle();
		expect(f.view.el.querySelector(".pair-transcript")).not.toBeNull();
		expect(pane.inert).toBe(true);
		// The computer sits under the pages laid over the thread: the transcript closes for it.
		expect(f.view.show(staff.id, "computer")).toBe(true);
		expect(f.view.el.querySelector(".pair-transcript")).toBeNull();
		expect(pane.inert).toBe(false);
		expect(document.activeElement).toBe(f.view.el.querySelector(".computer-panel"));
	});

	it("places the company notices above the coding sessions' dock, which sits right above the composer", () => {
		const host = document.createElement("div");
		const f = setup({ notificationHost: host });
		expect(host.parentElement).toBe(f.view.el.querySelector(".thread-conversation"));
		// The failed-run line shares the band: notices first, then the run, the coding dock, then the composer.
		const slot = host.nextElementSibling;
		expect(slot?.classList.contains("thread-run-failure")).toBe(true);
		const dock = slot?.nextElementSibling as HTMLElement | null | undefined;
		expect(dock?.classList.contains("coding-dock")).toBe(true);
		expect(dock?.hidden).toBe(true);
		expect(dock?.nextElementSibling).toBe(f.view.el.querySelector("footer.composer"));
	});

	it("places the failed-run line above the coding dock without a notification host", () => {
		const f = setup();
		const slot = f.view.el.querySelector<HTMLElement>(".thread-run-failure");
		expect(slot?.parentElement).toBe(f.view.el.querySelector(".thread-conversation"));
		expect(slot?.previousElementSibling?.classList.contains("thread-status")).toBe(true);
		expect(slot?.nextElementSibling?.classList.contains("coding-dock")).toBe(true);
		expect(slot?.nextElementSibling?.nextElementSibling).toBe(f.view.el.querySelector("footer.composer"));
	});

	it.each([false, true])("restores notification focus with the computer open (entered: %s)", async (entered) => {
		const host = document.createElement("div");
		document.body.append(host);
		const f = setup({ notificationHost: host });
		f.view.show(staff.id, "computer");
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		// The renderer sets this class when native fullscreen is unavailable.
		panel.classList.toggle("is-entered", entered);
		f.company.store.set({
			activity: [
				{
					runId: id(70),
					staffAgentId: staff.id,
					sourceKind: "room_delivery",
					jobStatus: "failed",
					activity: "needs_attention",
					updatedAt: timestamp,
				},
			],
		});
		await settle();
		const close = button(f.view.el, "Dismiss");
		close.focus();
		close.click();
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(document.activeElement).toBe(entered ? panel : f.view.el.querySelector(".composer-input"));
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
	});

	it("closes an unresolved run popup immediately without discarding work or reopening on polling", async () => {
		const host = document.createElement("div");
		const sibling = document.createElement("section");
		host.append(sibling);
		document.body.append(host);
		const f = setup({ notificationHost: host });
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError: "Runner lease expired before durable completion",
			unsettledOperations: 1,
		};
		const card = () => document.querySelector<HTMLElement>(".run-failure");
		const discard = vi.spyOn(f.api, "discardFailedRun");
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details } });
		await settle();
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe("Fixture agent did not finish this run");
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"Qorpera lost contact with this run. The problem is on Qorpera's side.",
		);
		// The cloud's own error text stays out of the card; the reason is in the member's words.
		expect(card()?.textContent).not.toContain(details.lastError);
		expect(card()?.querySelector("details")).toBeNull();
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		// Unsettled operations: nothing may be repeated yet.
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
		// The card sits above the composer (only the coding dock between), below the notices, never in the thread.
		expect(f.view.el.querySelector(".messages")?.contains(card())).toBe(false);
		expect(host.querySelector(".run-failure")).toBeNull();
		const slot = f.view.el.querySelector<HTMLElement>(".thread-run-failure");
		expect(slot?.contains(card())).toBe(true);
		expect(slot?.previousElementSibling).toBe(host);
		expect(slot?.nextElementSibling?.classList.contains("coding-dock")).toBe(true);
		expect(slot?.nextElementSibling?.nextElementSibling?.classList.contains("composer")).toBe(true);
		expect(f.view.el.querySelector(".thread-status .notice-warn")).toBeNull();
		const close = button(f.view.el, "Dismiss");
		close.focus();
		f.company.store.set({ activity: [{ ...run }] });
		await settle();
		expect(button(f.view.el, "Dismiss")).toBe(close);
		expect(document.activeElement).toBe(close);
		close.click();
		expect(card()).toBeNull();
		expect(document.activeElement).toBe(f.view.el.querySelector("textarea"));
		expect(discard).not.toHaveBeenCalled();
		f.company.store.set({
			activity: [{ ...run }],
			recoveries: { [run.runId]: { ...details, unsettledOperations: 0 } },
		});
		await settle();
		expect(card()).toBeNull();
		// Navigation within the same company does not replay a dismissed popup.
		f.view.dispose();
		const reopened = new ConversationView(f.company, session.sessionId, { notificationHost: host });
		document.body.append(reopened.el);
		expect(card()).toBeNull();
		// A different failed run still gets its own dismissible notification.
		f.company.store.set({ activity: [{ ...run, runId: id(71) }] });
		await settle();
		expect(card()).not.toBeNull();
		reopened.dispose();
		expect([...host.children]).toEqual([sibling]);
	});

	it("allows readers to hide run notifications and retains review links without subtext", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError: "Internal provider failure",
			unsettledOperations: 0,
			proposalId: id(71),
		};
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		f.company.store.set({
			team: { ...team, capabilities: { ...team.capabilities, write: false } },
			activity: [run],
			recoveries: { [run.runId]: details },
		});
		await settle();
		expect(card()?.querySelector("a")?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/file`);
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe(
			"Fixture agent stopped with changes to review",
		);
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe("Its changes wait for your decision.");
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
		button(f.view.el, "Dismiss").focus();
		button(f.view.el, "Dismiss").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(card()).toBeNull();
		expect(document.activeElement).toBe(button(f.view.el, "Open agent details"));
		const review = { ...run, runId: id(72), sourceKind: "proposal_review" as const };
		f.company.store.set({ activity: [review] });
		await settle();
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe("A review did not finish");
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
		expect(card()?.querySelector("a")?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/file`);
		f.company.store.set({ team: undefined });
		await settle();
		expect(card()).toBeNull();
	});

	it("dismisses durably at once, and the next run then shows with its Stop control", async () => {
		const nextRun = id(73);
		const cancel = vi.fn(async () => "cancelled" as const);
		const f = setup({
			runControl: {
				read: vi.fn(async () => ({
					sessionId: session.sessionId,
					staffAgentId: staff.id,
					run: { runId: nextRun, status: "leased" as const, canCancel: true },
				})),
				cancel,
			},
		});
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const pending = deferred<void>();
		const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockReturnValue(pending.promise);
		const discard = vi.spyOn(f.api, "discardFailedRun");
		// Match the server's priority: the old failure masks the newer leased run until acknowledged.
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([
			{ ...run, runId: nextRun, jobStatus: "leased", activity: "working" },
		]);
		// Details have not arrived yet: dismissing does not wait for them.
		f.company.store.set({ activity: [run], recoveries: {} });
		await settle();
		expect(f.company.agentState(staff.id)).toBe("failed");
		expect(f.view.el.querySelector('[aria-label="Stop"]')).toBeNull();
		const close = button(f.view.el, "Dismiss");
		close.focus();
		close.click();
		close.click();
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(document.activeElement).toBe(f.view.el.querySelector("textarea"));
		// Seen: the run stops standing in for the agent before the cloud has answered.
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(run.runId);
		expect(discard).not.toHaveBeenCalled();
		expect(f.company.agentState(staff.id)).toBe("idle");
		pending.resolve();
		await settle();
		expect(f.company.agentState(staff.id)).toBe("working");
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(button(f.view.el, "Stop").disabled).toBe(false);
		button(f.view.el, "Stop").click();
		await settle();
		expect(cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId, nextRun, expect.any(AbortSignal));
	});

	it("shows a message the member stopped as stopped, not failed, and keeps the Stop for the agent's other run", async () => {
		const routineRun = id(73);
		const cancel = vi.fn(async () => "cancelled" as const);
		const f = setup({
			runControl: {
				read: vi.fn(async () => ({
					sessionId: session.sessionId,
					staffAgentId: staff.id,
					run: { runId: routineRun, status: "leased" as const, canCancel: true },
				})),
				cancel,
			},
		});
		const stopped = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "cancelled" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: stopped.runId,
			sourceKind: stopped.sourceKind,
			jobStatus: stopped.jobStatus,
			lastError: "Runner job was cancelled by a company member",
			unsettledOperations: 0,
		};
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		// The cloud no longer lists the stopped message: the routine run the agent is
		// still working on stands for it, and the member can stop that one too.
		f.company.store.set({
			activity: [{ ...stopped, runId: routineRun, sourceKind: "wake", jobStatus: "leased", activity: "working" }],
		});
		await settle();
		expect(f.company.agentState(staff.id)).toBe("working");
		expect(card()).toBeNull();
		button(f.view.el, "Stop").click();
		await settle();
		expect(cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId, routineRun, expect.any(AbortSignal));
		// An older cloud still lists the stop: nothing reads as failed or offers Try again.
		f.company.store.set({ activity: [stopped], recoveries: { [stopped.runId]: details } });
		await settle();
		expect(f.company.agentState(staff.id)).toBe("idle");
		expect(card()).toBeNull();
		// A stop that left Company File changes asks for the decision: Review, never Try again.
		f.company.store.set({ recoveries: { [stopped.runId]: { ...details, proposalId: id(71) } } });
		await settle();
		expect(f.company.agentState(staff.id)).toBe("decision");
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe(
			"Fixture agent stopped with changes to review",
		);
		expect(card()?.querySelector("a")?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/file`);
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
	});

	it("stops a routine run working in the agent's thread through the conversation run control", async () => {
		// A routine run is a wake run in the agent's own thread. The cloud's run control
		// reports it like a member's turn (20260926183100); the composer's one button
		// stops its exact id over the real transport; with a draft it is Send again.
		const routineRun = id(74);
		let working = true;
		const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			if (String(input).endsWith("/rpc/qorpera_cancel_session_run")) {
				working = false;
				return Response.json({ session_id: session.sessionId, run_id: routineRun, status: "cancelled" });
			}
			return Response.json({
				session_id: session.sessionId,
				staff_agent_id: staff.id,
				run: working ? { run_id: routineRun, status: "leased", can_cancel: true } : null,
			});
		});
		vi.stubGlobal("fetch", fetch);
		const f = fixture();
		const lifetime = new AbortController();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		const view = new ConversationView(company, session.sessionId, {
			runControl: createWebSessionRunControl(f.cloud, userA.id, lifetime.signal, () => {}),
		});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
			lifetime.abort();
		};
		const routine = {
			runId: routineRun,
			staffAgentId: staff.id,
			sourceKind: "wake" as const,
			jobStatus: "leased" as const,
			activity: "working" as const,
			updatedAt: timestamp,
		};
		company.store.set({ activity: [routine] });
		await settle();
		await settle();
		expect(company.agentState(staff.id)).toBe("working");
		expect(button(view.el, "Stop").disabled).toBe(false);
		input(view.el, "Message", "Also check the invoices.");
		await settle();
		expect(view.el.querySelector('[aria-label="Stop"]')).toBeNull();
		expect(button(view.el, "Send message")).toBe(view.el.querySelector(".composer-send"));
		input(view.el, "Message", "");
		await settle();
		button(view.el, "Stop").click();
		await settle();
		await settle();
		const cancel = fetch.mock.calls.find(([url]) => String(url).endsWith("/rpc/qorpera_cancel_session_run"));
		expect(JSON.parse(cancel?.[1]?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_run_id: routineRun,
		});
		// The confirmed Stop re-reads the conversation: no run is left to stop, even
		// before the agent's activity catches up.
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(view.el.querySelector('[aria-label="Stop"]')).toBeNull();
		company.store.set({ activity: [] });
		await settle();
		expect(company.agentState(staff.id)).toBe("idle");
		expect(view.el.querySelector('[aria-label="Stop"]')).toBeNull();
	});

	it("offers Try again in the thread, runs it on the selected account, and reports a refusal in plain words", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError:
				"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)",
			unsettledOperations: 0,
		};
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		const retryButton = () => card()?.querySelector<HTMLButtonElement>('[data-action="retry-run"]') ?? null;
		const sponsor = {
			connectionId: id(80),
			provider: "openai",
			nativeHarness: "codex-cli" as const,
			sponsorBindingId: id(81),
			sponsorVersion: 3,
			computeIdentityId: id(82),
			workerClass: "managed_sandbox" as const,
		};
		f.company.conversation(session.sessionId, false).set({ executionSponsor: sponsor });
		// The cloud keeps reporting the failed run until it is released or dismissed.
		vi.spyOn(f.api, "listStaffActivity").mockResolvedValue([run]);
		vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(details);
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details } });
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"No computer could be started for this run. The problem is on Qorpera's side.",
		);
		let release: (() => void) | undefined;
		const retry = vi.spyOn(f.api, "retryRoomDelivery").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		retryButton()!.focus();
		retryButton()!.click();
		await settle();
		expect(retry).toHaveBeenCalledExactlyOnceWith(run.runId, sponsor.sponsorBindingId, sponsor.sponsorVersion);
		expect(retryButton()?.textContent).toBe("Trying again…");
		expect(retryButton()?.getAttribute("aria-disabled")).toBe("true");
		// A second click while it runs does nothing, and the button keeps focus across the redraw.
		retryButton()!.click();
		expect(retry).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(retryButton());
		release?.();
		await settle();
		// A refusal stays in the card, in the member's words.
		retry.mockRejectedValueOnce(new Error("Only the author of the post can retry it"));
		f.company.store.set({ activity: [{ ...run }], recoveries: { [run.runId]: details } });
		await settle();
		retryButton()!.click();
		await settle();
		expect(card()?.querySelector(".run-failure-error")?.textContent).toBe(
			"Only the person who wrote the message can try it again.",
		);
		expect(retryButton()?.textContent).toBe("Try again");
		// Only an operator pauses a company now; there is nothing for the member to resume.
		retry.mockRejectedValueOnce(new Error("Company execution is paused"));
		retryButton()!.click();
		await settle();
		expect(card()?.querySelector(".run-failure-error")?.textContent).toBe(
			"Agents are paused for a moment while Qorpera updates. Try again shortly.",
		);
	});

	it("stops offering Try again for room posts when the deployed cloud cannot do it, and keeps it for session turns", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError: "Runner lease expired before durable completion",
			unsettledOperations: 0,
		};
		const retryButton = () => f.view.el.querySelector<HTMLButtonElement>('.run-failure [data-action="retry-run"]');
		f.company.conversation(session.sessionId, false).set({
			executionSponsor: {
				connectionId: id(80),
				provider: "openai",
				nativeHarness: "codex-cli",
				sponsorBindingId: id(81),
				sponsorVersion: 1,
				computeIdentityId: id(82),
				workerClass: "managed_sandbox",
			},
		});
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details } });
		await settle();
		vi.spyOn(f.api, "listStaffActivity").mockResolvedValue([run]);
		vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(details);
		vi.spyOn(f.api, "retryRoomDelivery").mockRejectedValue(
			new CloudRpcError("qorpera_retry_room_delivery", { message: "not found", code: "PGRST202" }, 404),
		);
		retryButton()!.click();
		await settle();
		f.company.store.set({ activity: [{ ...run }], recoveries: { [run.runId]: details } });
		await settle();
		expect(retryButton()).toBeNull();
		expect(f.view.el.querySelector(".run-failure-error")?.textContent).toBe(
			"Trying again is not available yet. Send the message again instead.",
		);
		expect(button(f.view.el, "Dismiss")).toBeTruthy();
		const turn = { ...run, runId: id(71), sourceKind: "session_turn" as const };
		const turnRetry = vi.spyOn(f.api, "retryFailedRun").mockResolvedValue();
		f.company.store.set({
			activity: [turn],
			recoveries: { [turn.runId]: { ...details, runId: turn.runId, sourceKind: turn.sourceKind } },
		});
		await settle();
		retryButton()!.click();
		await settle();
		expect(turnRetry).toHaveBeenCalledExactlyOnceWith(turn.runId);
	});

	it("offers Dismiss only for a refused run, and Try again for an interrupted one", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = (lastError: string) => ({
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError,
			unsettledOperations: 0,
		});
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details("You have hit your usage limit.") } });
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.",
		);
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		// A real usage limit: the bridge's refusal names only a spent budget; the cloud's usage-limit signal decides.
		const bridge = "Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]";
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: { ...details(bridge), usageLimit: true } } });
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.",
		);
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		// The member's own ChatGPT plan reached its limit: OpenAI's words and "Manage usage" (20260928379930).
		const plan = { ...details(bridge), usageLimit: true, paidByChatgptPlan: true };
		f.company.store.set({
			activity: [run],
			recoveries: { [run.runId]: { ...plan, requestedByUserId: f.company.userId.toLowerCase() } },
		});
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"ChatGPT · Usage limit reached. Review your plan or this app's limit in ChatGPT settings.",
		);
		const manage = card()?.querySelector<HTMLAnchorElement>('[data-action="manage-usage"]');
		expect([manage?.textContent, manage?.href, manage?.target, manage?.rel]).toEqual([
			"Manage usage",
			"https://chatgpt.com/settings/usage",
			"_blank",
			"noopener noreferrer",
		]);
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		// Another member's plan: the plain sentence, no link to someone else's settings.
		f.company.store.set({
			activity: [run],
			recoveries: { [run.runId]: { ...plan, requestedByUserId: "11111111-1111-4111-8111-999999999999" } },
		});
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.",
		);
		expect(card()?.querySelector('[data-action="manage-usage"]')).toBeNull();
		// The member's own Codex login at its limit: the plain sentence, no link.
		const own = f.company.userId.toLowerCase();
		f.company.store.set({
			activity: [run],
			recoveries: {
				[run.runId]: { ...details(bridge), usageLimit: true, paidByChatgptPlan: false, requestedByUserId: own },
			},
		});
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.",
		);
		expect(card()?.querySelector('[data-action="manage-usage"]')).toBeNull();
		// The member's own plan, stopped for another reason: no limit words, no link.
		f.company.store.set({
			activity: [run],
			recoveries: {
				[run.runId]: { ...details(bridge), usageLimit: false, paidByChatgptPlan: true, requestedByUserId: own },
			},
		});
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"The run started, but one of its steps was refused. The problem is on Qorpera's side.",
		);
		expect(card()?.querySelector('[data-action="manage-usage"]')).toBeNull();
		// A run that left changes keeps Review, also at the member's own plan's limit.
		f.company.store.set({
			activity: [run],
			recoveries: { [run.runId]: { ...plan, requestedByUserId: own, proposalId: id(72) } },
		});
		await settle();
		expect(card()?.querySelector('[data-action="manage-usage"]')).toBeNull();
		expect(card()?.querySelector("a")?.textContent).toBe("Review");
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details(bridge) } });
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"The run started, but one of its steps was refused. The problem is on Qorpera's side.",
		);
		f.company.store.set({
			activity: [run],
			recoveries: { [run.runId]: details("Runner lease expired before durable completion") },
		});
		await settle();
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual([
			"Try again",
			"Dismiss",
		]);
		// A step cancelled while the database stopped answering, after the run hired an agent (WB-001, 28 October):
		// Qorpera lost contact, and the cloud will not repeat work that took effect, so Dismiss only.
		const cancelled =
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]; durable attempt output requires review";
		f.company.store.set({
			activity: [run],
			recoveries: { [run.runId]: { ...details(cancelled), durableOutcome: true } },
		});
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"Qorpera lost contact with this run. The problem is on Qorpera's side.",
		);
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details(cancelled) } });
		await settle();
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual([
			"Try again",
			"Dismiss",
		]);
		// The card is one quiet line, like a company notice: no big mark, no rule.
		expect(card()?.querySelector(".run-failure-mark")).toBeNull();
		expect(card()?.querySelector(".run-failure-rule")).toBeNull();
	});

	it("keeps a dismissed failure dismissed when it is displaced and returns", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockResolvedValue(undefined);
		// The cloud's next read reports a newer failure, which gets its own card.
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([{ ...run, runId: id(71) }]);
		f.company.store.set({ activity: [run] });
		await settle();
		button(f.view.el, "Dismiss").click();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(run.runId);
		await settle();
		expect(f.view.el.querySelector(".run-failure")).not.toBeNull();
		// The dismissed run comes back from a stale read: it stays dismissed, once.
		f.company.store.set({
			activity: [run],
			recoveries: {
				[run.runId]: {
					runId: run.runId,
					sourceKind: run.sourceKind,
					jobStatus: run.jobStatus,
					unsettledOperations: 0,
				},
			},
		});
		await settle();
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(acknowledge).toHaveBeenCalledTimes(1);
		expect(f.company.agentState(staff.id)).toBe("idle");
	});

	it("keeps a dismissal across navigation, and shows the card again after a lost cloud reply", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const recovery = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			unsettledOperations: 0,
		};
		const pending = deferred<void>();
		const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockReturnValueOnce(pending.promise);
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([run]);
		vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(recovery);
		f.company.store.set({ activity: [run] });
		await settle();
		button(f.view.el, "Dismiss").click();
		f.view.dispose();
		f.view.el.remove();
		const reopened = new ConversationView(f.company, session.sessionId);
		document.body.append(reopened.el);
		dispose = () => {
			reopened.dispose();
			f.company.stop();
		};
		f.company.store.set({ recoveries: { [run.runId]: recovery } });
		await settle();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(run.runId);
		expect(reopened.el.querySelector(".run-failure")).toBeNull();
		// Nothing reached the cloud: the failure is not settled, so the card returns
		// in the current view and can be dismissed again.
		pending.reject(new Error("Connection lost"));
		await settle();
		expect(reopened.el.querySelector(".run-failure-title")?.textContent).toBe(
			"Fixture agent did not finish this run",
		);
		expect(f.company.agentState(staff.id)).toBe("failed");
		acknowledge.mockResolvedValue(undefined);
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([]);
		button(reopened.el, "Dismiss").click();
		await settle();
		expect(acknowledge).toHaveBeenCalledTimes(2);
		expect(reopened.el.querySelector(".run-failure")).toBeNull();
		expect(f.company.agentState(staff.id)).toBe("idle");
	});

	it.each(["reader", "unsettled", "proposal", "review", "closed", "stopped"] as const)(
		"keeps dismissal local when recovery arrives after %s changes",
		async (kind) => {
			const f = setup();
			const run = {
				runId: id(70),
				staffAgentId: staff.id,
				sourceKind: kind === "review" ? ("proposal_review" as const) : ("session_turn" as const),
				jobStatus: "failed" as const,
				activity: "needs_attention" as const,
				updatedAt: timestamp,
			};
			const discard = vi.spyOn(f.api, "discardFailedRun");
			f.company.store.set({ activity: [run] });
			await settle();
			const close = button(f.view.el, "Dismiss");
			if (kind === "reader")
				f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
			close.click();
			if (kind === "closed")
				f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id, status: "closed" }] });
			if (kind === "stopped") f.company.stop();
			f.company.store.set({
				recoveries: {
					[run.runId]: {
						runId: run.runId,
						sourceKind: run.sourceKind,
						jobStatus: run.jobStatus,
						unsettledOperations: kind === "unsettled" ? 1 : 0,
						proposalId: kind === "proposal" ? id(74) : undefined,
					},
				},
			});
			await settle();
			expect(discard).not.toHaveBeenCalled();
			expect(f.view.el.querySelector(".run-failure")).toBeNull();
		},
	);
});

describe("conversation loading placeholders", () => {
	it("stands the header, messages and composer as placeholders, each replaced where it stands", async () => {
		const f = fixture();
		const events = deferred<Awaited<ReturnType<typeof f.api.readSessionEvents>>>();
		vi.mocked(f.api.readSessionEvents).mockReturnValue(events.promise);
		const company = new CompanyController(f.api, profileA, userA.id);
		const view = new ConversationView(company, session.sessionId, {});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		const header = view.el.querySelector(".thread-identity")!;
		const composer = () => view.el.querySelector<HTMLElement>(".composer:not(.skeleton-composer)")!;
		// The company is still opening: neither the conversation nor who may write in it is known.
		expect(header.querySelector(".skeleton-identity-figure")).not.toBeNull();
		expect(header.getAttribute("title")).toBe("");
		expect(visibleText(view.el.querySelector(".thread-header"))).toBe("");
		expect(visibleText(view.el.querySelector(".messages"))).toBe("");
		expect(placeholderLabel(view.el.querySelector(".messages"))).toBe("Loading conversation");
		expect(view.el.querySelectorAll(".skeleton-composer")).toHaveLength(1);
		expect(composer().hidden).toBe(true);
		const messages = view.el.querySelector(".messages")!;
		const placeholder = messages.querySelector(".skeleton-messages");
		const records: MutationRecord[] = [];
		const changes = new MutationObserver((batch) => records.push(...batch));
		changes.observe(messages, { childList: true });
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		await settle();
		// The live log keeps the same placeholder in place, so a screen reader does not hear it again.
		expect(messages.querySelector(".skeleton-messages")).toBe(placeholder);
		records.push(...changes.takeRecords());
		expect(records).toHaveLength(0);
		changes.disconnect();
		// Header and composer arrive; the messages are still being read.
		expect(header.querySelector(".skeleton")).toBeNull();
		expect(header.querySelector("h1")?.textContent).toBe(staff.displayName);
		expect(view.el.querySelector(".skeleton-composer")).toBeNull();
		expect(composer().hidden).toBe(false);
		expect(view.el.querySelector(".messages .skeleton-messages")).not.toBeNull();
		events.resolve([]);
		await settle();
		expect(view.el.querySelector(".skeleton")).toBeNull();
	});

	it("keeps no composer placeholder for a member who cannot write once the company is open", async () => {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			team: { ...team, capabilities: { ...team.capabilities, write: false } },
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
		});
		const view = new ConversationView(company, session.sessionId, {});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		await settle();
		expect(view.el.querySelector(".skeleton-composer")).toBeNull();
		expect(view.el.querySelector<HTMLElement>(".composer")?.hidden).toBe(true);
	});
});

describe("local attachment validation", () => {
	it("rejects empty/oversized files and renders SVG as an inert document", () => {
		const change = vi.fn();
		const tray = new AttachmentTray([], change);
		dispose = () => tray.dispose();
		tray.add([new File([], "empty"), new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge")]);
		expect(tray.count).toBe(0);
		tray.add([new File(['<svg onload="alert(1)"/>'], "untrusted.svg", { type: "image/svg+xml" })]);
		expect(tray.count).toBe(1);
		expect(tray.el.querySelector("img")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
	it("caps the selection and does not mutate an incoming draft array", () => {
		const files = [new File(["x"], "original")],
			tray = new AttachmentTray(files, () => {});
		dispose = () => tray.dispose();
		button(tray.el, "Remove original").click();
		expect(files).toHaveLength(1);
		tray.add(Array.from({ length: 9 }, (_, index) => new File(["x"], `file-${index}`)));
		expect(tray.count).toBe(8);
		expect(tray.status.textContent).toContain("up to 8 files");
	});
});

describe("safe formatted messages", () => {
	it("splits paragraphs while keeping blank lines inside lists, quotes and code intact", () => {
		const bubbles = markdownBubbles(
			"First.\n\nSecond.\n\n- one\n\n  continuation\n\n- two\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\n> Quote\n>\n> Another paragraph\n\nLast.",
		);
		expect(bubbles).toHaveLength(6);
		expect(bubbles[0]?.textContent).toBe("First.");
		expect(bubbles[1]?.textContent).toBe("Second.");
		expect(bubbles[2]?.querySelectorAll("li")).toHaveLength(2);
		expect(bubbles[2]?.textContent).toContain("continuation");
		expect(bubbles[3]?.querySelector("pre code")?.textContent).toBe("const x = 1;\n\nconst y = 2;");
		expect(bubbles[4]?.querySelectorAll("blockquote p")).toHaveLength(2);
		expect(bubbles[5]?.textContent).toBe("Last.");
	});
	it("wraps long code inside the bubble instead of scrolling sideways", () => {
		expect(conversationCss).toMatch(/\.message-prose pre \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
		expect(conversationCss).toMatch(/\.message-prose code \{[^}]*overflow-wrap: anywhere;/);
	});
	it("keeps introductions with lists and tables and resolves references across bubbles", () => {
		const bubbles = markdownBubbles(
			"See [brief][plan].\n\nTasks:\n\n- one\n- two\n\nStatus:\n\n| Item | State |\n| --- | --- |\n| Brief | Ready |\n\n[plan]: https://example.invalid/brief",
		);
		expect(bubbles).toHaveLength(3);
		expect(bubbles[0]?.querySelector("a")?.href).toBe("https://example.invalid/brief");
		expect(bubbles[1]?.querySelector("p")?.textContent).toBe("Tasks:");
		expect(bubbles[1]?.querySelectorAll("li")).toHaveLength(2);
		expect(bubbles[2]?.querySelector("p")?.textContent).toBe("Status:");
		expect(bubbles[2]?.querySelectorAll("td")).toHaveLength(2);
	});
	it("preserves public progress and file summaries and keeps unsafe markup inert after grouping", () => {
		const bubbles = markdownBubbles(
			"Working on that now.\n\nFiles changed:\n\n- brief.md\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert%281%29)\n\n![Track](https://example.invalid/image.png)",
		);
		expect(bubbles.map((bubble) => bubble.textContent).join("\n")).toContain("Working on that now.");
		expect(bubbles.map((bubble) => bubble.textContent).join("\n")).toContain("brief.md");
		for (const bubble of bubbles) expect(bubble.querySelector("img, script, iframe")).toBeNull();
		expect(bubbles.flatMap((bubble) => [...bubble.querySelectorAll("a")]).map((link) => link.protocol)).toEqual([
			"https:",
		]);
	});
	it("decodes text entities without activating encoded markup or destinations", () => {
		const rendered = markdown("A &amp; B &copy; &lt;img src=x&gt; `&amp;` [Unsafe](jav&#x61;script:alert%281%29)");
		expect(rendered.textContent).toBe("A & B © <img src=x> &amp; Unsafe");
		expect(rendered.querySelector("img, a")).toBeNull();
	});
	it("renders structure while leaving raw HTML, dangerous links and remote images inert", () => {
		const rendered = markdown(
			"# Heading\n\n**Strong** and `code`\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\n<script>alert(1)</script>\n```\n\n[Good](https://example.invalid) [Bad](javascript:alert%281%29)\n\n![Track](https://example.invalid/track.png)\n\n<img src=x onerror=alert(1)>",
		);
		expect(rendered.querySelector("h2")?.textContent).toBe("Heading");
		expect(rendered.querySelector("strong")?.textContent).toBe("Strong");
		expect(rendered.querySelectorAll("li")).toHaveLength(2);
		expect(rendered.querySelectorAll("td")).toHaveLength(2);
		expect(rendered.querySelector("pre code")?.textContent).toBe("<script>alert(1)</script>");
		expect(rendered.querySelector("img, script, iframe, svg")).toBeNull();
		expect([...rendered.querySelectorAll("a")].map((link) => link.protocol)).toEqual(["https:", "https:"]);
		expect(rendered.textContent).toContain("<img src=x onerror=alert(1)>");
	});
	it("draws one disabled checkbox per task item without repeating its marker as text", () => {
		// Tight and loose lists place marked's checkbox token at different depths.
		for (const source of ["- [x] done\n- [ ] open", "- [x] done\n\n- [ ] open"]) {
			const items = [...markdown(source).querySelectorAll("li")];
			expect(items.map((item) => item.querySelectorAll("input").length)).toEqual([1, 1]);
			expect(items.map((item) => item.querySelector("input")?.checked)).toEqual([true, false]);
			expect(items.every((item) => item.querySelector("input")?.disabled)).toBe(true);
			expect(items.map((item) => item.textContent)).toEqual(["done", "open"]);
		}
		expect(markdown("[x] not a list").textContent).toBe("[x] not a list");
	});
});

describe("new conversation and agent setup", () => {
	function setupNew(actions: WorkspaceActions = {}, agents = [staff]) {
		const f = fixture(),
			company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ staff: agents, sessions: [session], loading: false });
		const view = new NewConversationView(company, actions, () => {});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		return { ...f, company, view, search: recipients(view.el) };
	}
	function recipients(root: ParentNode): HTMLInputElement {
		return root.querySelector<HTMLInputElement>('[aria-label="Search conversation recipients"]')!;
	}
	function choice(root: ParentNode, key: string): HTMLElement {
		const result = root.querySelector<HTMLElement>(`[role="option"][data-choice="${key}"]`);
		if (!result) throw new Error(`Missing choice: ${key}`);
		return result;
	}
	function choices(root: ParentNode): string[] {
		return [...root.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.dataset.choice!);
	}
	function press(target: HTMLElement, key: string): KeyboardEvent {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		return event;
	}
	it("hangs one list from the To: field: new agent, new group chat, then the agents", async () => {
		const f = setupNew();
		await settle();
		f.search.focus();
		expect(f.search.getAttribute("role")).toBe("combobox");
		expect(f.search.getAttribute("aria-expanded")).toBe("true");
		expect(f.view.el.querySelector<HTMLElement>(".recipient-menu")!.hidden).toBe(false);
		expect(choices(f.view.el)).toEqual(["create", "group", staff.id]);
		expect(choice(f.view.el, staff.id).textContent).toContain("Fixture agent");
		// The old screen's heading, cards and Open/Cancel footer are gone.
		expect(f.view.el.querySelector("h1, .recipient-card, .recipient-footer")).toBeNull();
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.search.getAttribute("aria-expanded")).toBe("false");
		expect(f.view.el.querySelector<HTMLElement>(".recipient-menu")!.hidden).toBe(true);
		f.search.click();
		expect(f.search.getAttribute("aria-expanded")).toBe("true");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("adds agents and the Co-Founder to recipients without navigating", async () => {
		const other = { ...staff, id: id(92), displayName: "Second agent", role: "Research" },
			cofounder = { ...staff, id: id(93), displayName: "Co-Founder", templateId: "co-founder" };
		const f = setupNew({}, [cofounder, staff, other]);
		await settle();
		f.search.focus();
		const originalHash = location.hash;
		choice(f.view.el, other.id).click();
		choice(f.view.el, cofounder.id).click();
		expect(location.hash).toBe(originalHash);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		input(f.view.el, "Search conversation recipients", "fixture");
		expect(choices(f.view.el)).toEqual(["create", "group", staff.id]);
		// Typing highlights the first match, so Enter adds it.
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, staff.id).id);
		expect(press(f.search, "Enter").defaultPrevented).toBe(true);
		expect(location.hash).toBe(originalHash);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(3);
		// Rows show no titles, so a title alone never matches.
		input(f.view.el, "Search conversation recipients", "research");
		expect(choices(f.view.el)).toEqual(["create", "group"]);
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("counts a double-click once, since rows and chips move under the pointer", async () => {
		const other = { ...staff, id: id(92), displayName: "Second agent" };
		const f = setupNew({}, [staff, other]);
		await settle();
		const click = (target: HTMLElement, detail: number) =>
			target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
		click(choice(f.view.el, "group"), 1);
		// The first agent now sits where New group chat was; the second click lands on it.
		expect(choices(f.view.el)).toEqual(["create", staff.id, other.id]);
		click(choice(f.view.el, staff.id), 2);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(0);
		for (const agent of [staff, other]) click(choice(f.view.el, agent.id), 1);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		click(f.view.el.querySelector<HTMLElement>(".recipient-chip")!, 1);
		click(f.view.el.querySelector<HTMLElement>(".recipient-chip")!, 2);
		expect([...f.view.el.querySelectorAll(".recipient-chip")].map((chip) => chip.textContent)).toEqual([
			"Second agent",
		]);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("moves through the list with the arrow keys and closes it with Escape", async () => {
		const f = setupNew();
		f.company.store.set({ team });
		await settle();
		f.search.focus();
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		press(f.search, "ArrowDown");
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, "create").id);
		expect(choice(f.view.el, "create").classList.contains("active")).toBe(true);
		press(f.search, "ArrowUp");
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, staff.id).id);
		expect(choice(f.view.el, "create").hasAttribute("aria-selected")).toBe(false);
		expect(press(f.search, "Escape").defaultPrevented).toBe(true);
		expect(f.search.getAttribute("aria-expanded")).toBe("false");
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		// With the list already closed, Escape is left to the page.
		expect(press(f.search, "Escape").defaultPrevented).toBe(false);
		press(f.search, "ArrowDown");
		expect(f.search.getAttribute("aria-expanded")).toBe("true");
	});
	it("keeps focus and the caret in the field across refreshes and drops a row that disappears", async () => {
		const f = setupNew();
		await settle();
		f.search.focus();
		for (let step = 0; step < 3; step++) press(f.search, "ArrowDown");
		const row = choice(f.view.el, staff.id);
		expect(f.search.getAttribute("aria-activedescendant")).toBe(row.id);
		f.company.store.set({ activity: [] });
		await settle();
		// Activity refreshes neither rebuild the rows nor move the highlight.
		expect(choice(f.view.el, staff.id)).toBe(row);
		expect(f.search.getAttribute("aria-activedescendant")).toBe(row.id);
		f.company.store.set({ staff: [] });
		await settle();
		expect(document.activeElement).toBe(f.search);
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		expect(f.view.el.querySelector(".recipient-empty")?.textContent).toBe("No agents yet.");
		f.search.value = "Fixture";
		f.search.dispatchEvent(new Event("input"));
		f.search.setSelectionRange(2, 2);
		f.company.store.set({ staff: [staff] });
		await settle();
		expect(document.activeElement).toBe(f.search);
		expect(f.search.selectionStart).toBe(2);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("waits for permission, names a new agent from the search, and preserves a local setup draft", async () => {
		const f = setupNew();
		expect(parseRoute(`#/c/${profileA.profileId}/new`)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "new",
		});
		expect(choice(f.view.el, "create").getAttribute("aria-disabled")).toBe("true");
		choice(f.view.el, "create").click();
		expect(f.view.el.querySelector("form")).toBeNull();
		f.company.store.set({ team });
		await settle();
		expect(choice(f.view.el, "create").hasAttribute("aria-disabled")).toBe(false);
		input(f.view.el, "Search conversation recipients", "missing");
		expect(choices(f.view.el)).toEqual(["create", "group"]);
		expect(f.view.el.querySelector(".recipient-empty")?.textContent).toBe("No agents match.");
		expect(choice(f.view.el, "create").textContent).toBe("New agent “missing”");
		choice(f.view.el, "create").click();
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("missing");
		input(f.view.el, "Agent name", "Draft agent");
		expect(button(f.view.el, "Create agent").disabled).toBe(true);
		button(f.view.el, "Back").click();
		expect(document.activeElement).toBe(recipients(f.view.el));
		expect(recipients(f.view.el).value).toBe("missing");
		// The member's own name wins over what is typed in the search.
		choice(f.view.el, "create").click();
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("Draft agent");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("sends to the selected group only on the first message and blocks duplicate sends", async () => {
		const pending = deferred<string>(),
			startConversation = vi.fn(() => pending.promise);
		const other = { ...staff, id: id(92), displayName: "Second agent" };
		const f = setupNew({ startConversation }, [staff, other]);
		f.company.store.set({ team });
		await settle();
		input(f.view.el, "Message", "Work together on this");
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		choice(f.view.el, staff.id).click();
		choice(f.view.el, other.id).click();
		expect(startConversation).not.toHaveBeenCalled();
		const message = f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
		message.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		message.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		expect(startConversation).not.toHaveBeenCalled();
		press(message, "Enter");
		button(f.view.el, "Send message").click();
		expect(startConversation).toHaveBeenCalledExactlyOnceWith(
			[staff.id, other.id],
			"Work together on this",
			expect.any(AbortSignal),
		);
		expect(message.disabled).toBe(true);
		pending.resolve(id(95));
		await settle();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${id(95)}`);
	});
	it("preserves recipients and text on preparation failure and blocks send after permission loss", async () => {
		const startConversation = vi
			.fn()
			.mockRejectedValue(new Error("Connect a model account to start a conversation."));
		const f = setupNew({ startConversation });
		f.company.store.set({ team });
		await settle();
		choice(f.view.el, staff.id).click();
		input(f.view.el, "Message", "Keep this draft");
		button(f.view.el, "Send message").click();
		await settle();
		expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Keep this draft");
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(1);
		expect(f.view.el.textContent).toContain("Connect a model account");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		await settle();
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		button(f.view.el, "Send message").click();
		expect(startConversation).toHaveBeenCalledTimes(1);
	});
	it("returns a created agent to the recipients and preserves the message through setup and cancel", async () => {
		const created = { ...staff, id: id(92), displayName: "New agent" };
		const createAgent = vi.fn().mockResolvedValue(created.id);
		const f = setupNew({ createAgent });
		f.company.store.set({ team });
		vi.mocked(f.api.listStaff).mockResolvedValue([staff, created]);
		await settle();
		choice(f.view.el, staff.id).click();
		input(f.view.el, "Message", "Our shared task");
		choice(f.view.el, "create").click();
		button(f.view.el, "Cancel").click();
		expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Our shared task");
		choice(f.view.el, "create").click();
		input(f.view.el, "Agent name", "New agent");
		input(f.view.el, "Agent title", "Research");
		const originalHash = location.hash;
		vi.mocked(f.api.listStaff).mockRejectedValueOnce(new Error("Roster unavailable"));
		f.view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		expect(f.view.el.textContent).toContain("The agent was created");
		f.view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(location.hash).toBe(originalHash);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Our shared task");
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Message");
	});

	it.each(["Back", "Cancel"])(
		"retains a created agent across %s and reopening after a failed roster refresh",
		async (leave) => {
			const created = { ...staff, id: id(92), displayName: "New agent" };
			const createAgent = vi.fn().mockResolvedValue(created.id);
			const f = setupNew({ createAgent });
			f.company.store.set({ team });
			vi.mocked(f.api.listStaff)
				.mockResolvedValue([staff, created])
				.mockRejectedValueOnce(new Error("Roster unavailable"));
			await settle();
			input(f.view.el, "Message", "Keep our task");
			input(f.view.el, "Search conversation recipients", "New agent");
			choice(f.view.el, "create").click();
			input(f.view.el, "Agent title", "Research");
			button(f.view.el, "Create agent").click();
			await settle();
			expect(f.view.el.textContent).toContain("The agent was created");
			button(f.view.el, leave).click();
			input(f.view.el, "Search conversation recipients", "Another agent");
			choice(f.view.el, "create").click();
			expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("New agent");
			expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
			button(f.view.el, "Add created agent").click();
			await settle();
			expect(createAgent).toHaveBeenCalledTimes(1);
			expect(f.view.el.querySelector(`[data-remove-recipient="${created.id}"]`)).not.toBeNull();
			expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Keep our task");
			// Successful recovery clears the identity and draft for the next new agent.
			choice(f.view.el, "create").click();
			expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("");
			expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
			expect(button(f.view.el, "Create agent").disabled).toBe(false);
		},
	);

	it("styles the New agent form with rules of its own", async () => {
		const style = document.createElement("style");
		style.textContent = [tokensCss, conversationCss, appCss].join("\n").replace(/^@import .*;$/gm, "");
		document.head.append(style);
		try {
			const f = setupNew();
			f.company.store.set({ team });
			await settle();
			choice(f.view.el, "create").click();
			const fields = f.view.el.querySelector<HTMLFieldSetElement>("form fieldset")!;
			// A cleanup of other editors' styles once left this form with the
			// browser's fieldset box and page-sized labels.
			expect(getComputedStyle(fields).display).toBe("grid");
			expect(getComputedStyle(fields).borderTopWidth).toBe("0px");
			expect(getComputedStyle(fields.querySelector("label")!).fontSize).toBe("12px");
		} finally {
			style.remove();
		}
	});
	it("does not duplicate creation or navigate when an injected creation finishes after disposal", async () => {
		const result = deferred<string>(),
			createAgent = vi.fn(() => result.promise);
		const f = setupNew({ createAgent });
		f.company.store.set({ team });
		await settle();
		choice(f.view.el, "create").click();
		input(f.view.el, "Agent name", "New agent");
		input(f.view.el, "Agent title", "Research");
		for (let index = 0; index < 2; index++)
			f.view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		expect(createAgent).toHaveBeenCalledTimes(1);
		const originalHash = location.hash;
		f.view.dispose();
		result.resolve(id(70));
		await settle();
		expect(location.hash).toBe(originalHash);
		expect(f.api.listStaff).not.toHaveBeenCalled();
	});
});

describe("messages between two agents (contract 14.6)", () => {
	it("keeps the coworker's figure and name together wherever Danish puts them", async () => {
		setLanguagePreference("da");
		const f = setup();
		const coworker = { ...staff, id: id(97), displayName: "Helper" };
		f.company.store.set({ staff: [staff, coworker] });
		await f.company.loadConversation(session.sessionId);
		f.company.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "peer_link",
						id: id(96),
						sequence: 1,
						direction: "in",
						counterpartStaffId: coworker.id,
						pairSessionId: id(98),
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 1,
			},
		});
		f.view.update();
		const chip = f.view.el.querySelector<HTMLButtonElement>(".peer-chip")!;
		expect([...chip.querySelectorAll(":scope > span:not(.figure)")].map((span) => span.textContent)).toEqual([
			"Besked fra",
			"Helper",
		]);
		expect(chip.querySelector(".figure")?.nextElementSibling?.textContent).toBe("Helper");
		expect(chip.getAttribute("aria-label")).toBe("Besked fra Helper. Åbn samtalen");
	});

	it("shows a chip for a coworker's message and opens the two agents' view-only transcript from it", async () => {
		const f = setup();
		const coworker = { ...staff, id: id(97), displayName: "Helper" };
		f.company.store.set({ staff: [staff, coworker] });
		const pairSessionId = id(98);
		// The thread's own first load finishes before the test supplies its projection.
		await f.company.loadConversation(session.sessionId);
		f.company.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "peer_link",
						id: id(96),
						sequence: 1,
						direction: "in",
						counterpartStaffId: coworker.id,
						pairSessionId,
						createdAt: timestamp,
					},
					{
						kind: "note",
						id: id(95),
						sequence: 2,
						text: "This exchange paused after 6 messages.",
						createdAt: timestamp,
					},
					{
						kind: "peer_link",
						id: id(89),
						sequence: 3,
						direction: "out",
						held: true,
						counterpartStaffId: coworker.id,
						pairSessionId,
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 3,
			},
		});
		f.view.update();
		const chips = f.view.el.querySelectorAll<HTMLButtonElement>(".peer-chip");
		const chip = chips[0]!;
		// Verb, the coworker's figure, then the name: the figure sits between the two spans.
		expect([...chip.querySelectorAll(":scope > span:not(.figure)")].map((span) => span.textContent)).toEqual([
			"Message from",
			"Helper",
		]);
		expect(chip.querySelector(".figure")?.previousElementSibling?.textContent).toBe("Message from");
		expect(chip.getAttribute("aria-label")).toBe("Message from Helper. Open the conversation");
		expect(chips[1]?.getAttribute("aria-label")).toBe("Left a note for Helper. Open the conversation");
		expect(f.view.el.querySelector(".conversation-note")?.textContent).toBe("This exchange paused after 6 messages.");
		expect(f.view.el.querySelector(".pair-transcript")).toBeNull();
		chip.click();
		await settle();
		// The transcript itself (loaded after the panel opened): the coworker's message under its name, nothing to type into.
		f.company.conversation(pairSessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "agent",
						id: id(94),
						sequence: 1,
						text: "Jonas created you and asked me to pass this along: he approves of you. Welcome.",
						attachmentCount: 0,
						phase: "final",
						runId: id(93),
						staffSpeaker: { runId: id(93), staffAgentId: coworker.id, staffVersion: 1, displayName: "Helper" },
						createdAt: timestamp,
					},
					{
						kind: "agent",
						id: id(92),
						sequence: 2,
						text: "FYI: the note is updated.",
						attachmentCount: 0,
						phase: "final",
						runId: id(91),
						held: true,
						staffSpeaker: {
							runId: id(91),
							staffAgentId: staff.id,
							staffVersion: 1,
							displayName: staff.displayName,
						},
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 2,
			},
		});
		await settle();
		const panel = f.view.el.querySelector<HTMLElement>(".pair-transcript")!;
		expect(panel).not.toBeNull();
		const pairNames = (sheet: HTMLElement) =>
			[...sheet.querySelectorAll(".pair-identity :is(.pair-name, .pair-glyph)")]
				.map((part) => part.textContent)
				.join("");
		expect(pairNames(panel)).toBe(`${staff.displayName}⇄Helper`);
		expect(panel.querySelector(".pair-count")?.textContent).toBe("2 messages");
		expect(panel.querySelector(".message-author")?.textContent).toBe("Helper");
		// The coworker speaks from the left, this thread's own agent from the right.
		const rows = panel.querySelectorAll<HTMLElement>(".pair-row");
		expect(rows[0]?.classList.contains("pair-row-right")).toBe(false);
		expect(rows[1]?.classList.contains("pair-row-right")).toBe(true);
		expect(rows[1]?.querySelector(".message-author")?.textContent).toBe(staff.displayName);
		expect(panel.textContent).toContain("he approves of you");
		expect(panel.querySelector(".message-caption")?.textContent).toBe("Left for Helper's next turn");
		expect(panel.textContent).toContain("Only the two agents write here");
		expect(panel.querySelector("textarea")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(true);
		button(panel, "Close").click();
		expect(f.view.el.querySelector(".pair-transcript")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(false);
		expect(document.activeElement).toBe(chip);
		// A press on the dimmed thread behind the sheet closes it too.
		chip.click();
		await settle();
		f.view.el.querySelector<HTMLElement>(".pair-transcript .pair-dim")!.click();
		expect(f.view.el.querySelector(".pair-transcript")).toBeNull();
		expect(document.activeElement).toBe(chip);
	});

	describe("in a row, on one line", () => {
		const helper = { ...staff, id: id(97), displayName: "Helper" };
		const nova = { ...staff, id: id(87), displayName: "Nova" };
		const ada = { ...staff, id: id(77), displayName: "Ada" };
		const pairs = new Map([
			[helper.id, id(98)],
			[nova.id, id(88)],
			[ada.id, id(78)],
		]);
		const link = (
			sequence: number,
			coworker: typeof staff,
			direction: "in" | "out",
			extra: { held?: boolean; createdAt?: string } = {},
		): TranscriptItem => ({
			kind: "peer_link",
			id: id(300 + sequence),
			sequence,
			direction,
			counterpartStaffId: coworker.id,
			pairSessionId: pairs.get(coworker.id)!,
			createdAt: timestamp,
			...extra,
		});
		async function thread(items: TranscriptItem[]) {
			const f = setup();
			f.company.store.set({ staff: [staff, helper, nova, ada] });
			await f.company.loadConversation(session.sessionId);
			const show = (shown: TranscriptItem[]) => {
				f.company.conversation(session.sessionId).set({
					loading: false,
					projection: { items: shown, hiddenCount: 0, lastSequence: shown.length },
				});
				f.view.update();
			};
			show(items);
			return { ...f, show, lines: () => [...f.view.el.querySelectorAll<HTMLElement>(".peer-link")] };
		}
		const words = (line: HTMLElement) =>
			[...line.children].map((part) =>
				part.matches(".peer-chip") ? `[${part.getAttribute("aria-label")}]` : part.textContent,
			);

		it("names each coworker once, in a chip that opens its own transcript", async () => {
			const f = await thread([link(1, helper, "out"), link(2, nova, "out")]);
			const [line] = f.lines();
			expect(f.lines()).toHaveLength(1);
			expect(line!.classList.contains("peer-group")).toBe(true);
			expect(words(line!)).toEqual([
				"Messaged",
				"[Helper. Open the conversation]",
				"and",
				"[Nova. Open the conversation]",
			]);
			expect(line!.getAttribute("aria-label")).toBe("Messaged Helper and Nova");
			const chip = line!.querySelectorAll<HTMLButtonElement>(".peer-chip")[1]!;
			expect(chip.querySelector(".figure")?.nextElementSibling?.textContent).toBe("Nova");
			expect(chip.title).toBe(`Nova · ${fmtTime(timestamp)}`);
			chip.click();
			await settle();
			const panel = f.view.el.querySelector<HTMLElement>(".pair-transcript")!;
			expect(
				[...panel.querySelectorAll(".pair-identity :is(.pair-name, .pair-glyph)")]
					.map((part) => part.textContent)
					.join(""),
			).toBe(`${staff.displayName}⇄Nova`);
			button(panel, "Close").click();
			expect(document.activeElement).toBe(chip);
		});

		it("says who wrote and counts the messages when there are more than coworkers", async () => {
			const f = await thread([link(1, helper, "out"), link(2, helper, "in"), link(3, nova, "out")]);
			expect(words(f.lines()[0]!)).toEqual([
				"Talked with",
				"[Helper. Open the conversation]",
				"and",
				"[Nova. Open the conversation]",
				"· 3 messages",
			]);
			f.show([link(1, helper, "in"), link(2, nova, "in")]);
			expect(f.lines()[0]!.getAttribute("aria-label")).toBe("Messages from Helper and Nova");
			f.show([link(1, helper, "out", { held: true }), link(2, helper, "out", { held: true })]);
			expect(words(f.lines()[0]!)).toEqual(["Left notes for", "[Helper. Open the conversation]", "· 2 messages"]);
			f.show([link(1, helper, "in", { held: true }), link(2, nova, "in")]);
			expect(f.lines()[0]!.getAttribute("aria-label")).toBe("Messages from Helper and Nova");
		});

		it("shows three or more coworkers by their figures, named in their labels", async () => {
			const f = await thread([
				link(1, helper, "out"),
				link(2, nova, "out"),
				link(3, ada, "out"),
				link(4, nova, "in"),
			]);
			const line = f.lines()[0]!;
			expect(words(line)).toEqual([
				"Talked with",
				"[Helper. Open the conversation]",
				"[Nova. Open the conversation]",
				"[Ada. Open the conversation]",
				"· 4 messages",
			]);
			expect(line.getAttribute("aria-label")).toBe("Talked with Helper, Nova, and Ada · 4 messages");
			for (const chip of line.querySelectorAll(".peer-chip")) {
				expect(chip.classList.contains("figure-only")).toBe(true);
				expect(chip.querySelector(":scope > span:not(.figure)")).toBeNull();
			}
		});

		it("puts the chips where Danish puts the names", async () => {
			setLanguagePreference("da");
			const f = await thread([link(1, helper, "out"), link(2, nova, "out"), link(3, nova, "out")]);
			expect(words(f.lines()[0]!)).toEqual([
				"Skrev til",
				"[Helper. Åbn samtalen]",
				"og",
				"[Nova. Åbn samtalen]",
				"· 3 beskeder",
			]);
		});

		it("keeps a line of its own for one message, and for what a message or a pause stands between", async () => {
			const later = "2026-09-05T10:10:00Z";
			const reply: TranscriptMessage = {
				kind: "agent",
				id: id(400),
				sequence: 3,
				text: "Asked them both.",
				attachmentCount: 0,
				phase: "final",
				runId: id(401),
				createdAt: timestamp,
			};
			const f = await thread([
				link(1, helper, "out"),
				link(2, nova, "out"),
				reply,
				link(4, helper, "in"),
				link(5, nova, "in", { createdAt: later }),
			]);
			const lines = f.lines();
			expect(lines.map((line) => line.classList.contains("peer-group"))).toEqual([true, false, false]);
			expect(lines[1]!.querySelector(".peer-chip")?.getAttribute("aria-label")).toBe(
				"Message from Helper. Open the conversation",
			);
			// Ten minutes on, a time stands before the last line.
			expect(lines[2]!.previousElementSibling?.matches("time.conversation-timestamp")).toBe(true);
		});

		it("measures the next time from the line's last message", async () => {
			const at = (minute: number) => `2026-09-05T10:0${minute}:00Z`;
			const reply: TranscriptMessage = {
				kind: "agent",
				id: id(400),
				sequence: 4,
				text: "Both answered.",
				attachmentCount: 0,
				phase: "final",
				runId: id(401),
				createdAt: at(8),
			};
			const f = await thread([
				link(1, helper, "out", { createdAt: at(0) }),
				link(2, helper, "in", { createdAt: at(3) }),
				link(3, nova, "in", { createdAt: at(6) }),
				reply,
			]);
			expect(f.lines()).toHaveLength(1);
			// Eight minutes after the line's first message, two after its last: no time between them.
			expect(f.view.el.querySelectorAll("time.conversation-timestamp")).toHaveLength(1);
		});

		it("takes in the next message with the coworker's chip springing in and the keyboard kept", async () => {
			Element.prototype.getAnimations = () => [];
			try {
				const f = await thread([link(1, helper, "out")]);
				f.show([link(1, helper, "out")]);
				const single = f.lines()[0]!.querySelector<HTMLButtonElement>(".peer-chip")!;
				single.focus();
				f.show([link(1, helper, "out"), link(2, nova, "out")]);
				const line = f.lines()[0]!;
				const [first, second] = line.querySelectorAll<HTMLButtonElement>(".peer-chip");
				expect(document.activeElement).toBe(first);
				expect(first!.classList.contains("is-joining")).toBe(false);
				expect(second!.classList.contains("is-joining")).toBe(true);
				expect(line.classList.contains("is-arriving")).toBe(false);
				second!.focus();
				f.show([link(1, helper, "out"), link(2, nova, "out"), link(3, nova, "in")]);
				const grown = f.lines()[0]!;
				expect(document.activeElement).toBe(grown.querySelectorAll(".peer-chip")[1]);
				expect(grown.querySelector(".peer-count")?.classList.contains("is-joining")).toBe(true);
				expect(grown.querySelector(".peer-chip.is-joining")).toBeNull();
			} finally {
				delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
			}
		});

		it("finds the coworker's chip again when a coding session splits the line", async () => {
			const at = (minute: number) => `2026-09-05T10:0${minute}:00Z`;
			// Started between the two messages: it stands between them once the thread learns of it.
			const coding: CodingSession = {
				workerId: id(500),
				workerKey: "fix-send",
				title: "Fix the delay after send",
				agentId: staff.id,
				ownerUserId: userA.id,
				harness: "codex",
				repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
				branch: `qorpera/coding/${id(500)}`,
				sequence: 1,
				workerState: "succeeded",
				phase: "completed",
				filesChanged: 0,
				checks: [],
				artifacts: [],
				updatedAt: at(1),
				createdAt: at(1),
				sessionId: session.sessionId,
				standby: true,
				attached: false,
				runningCommands: 0,
				machineAsleep: false,
			};
			const f = await thread([
				link(1, helper, "out", { createdAt: at(0) }),
				link(2, nova, "out", { createdAt: at(2) }),
			]);
			const sessions = (codingSessions: CodingSession[]) => {
				f.company.conversation(session.sessionId).set({ codingSessions });
				f.view.update();
			};
			const novaChip = () =>
				f.view.el.querySelector<HTMLButtonElement>(`.peer-chip[data-pair-session-id="${pairs.get(nova.id)}"]`)!;
			expect(f.lines()).toHaveLength(1);
			novaChip().click();
			await settle();
			sessions([coding]);
			expect(f.lines().map((line) => line.classList.contains("coding-line"))).toEqual([false, true, false]);
			// Closing Nova's transcript goes back to Nova, now on a line of its own.
			button(f.view.el.querySelector<HTMLElement>(".pair-transcript")!, "Close").click();
			expect(document.activeElement).toBe(novaChip());
			expect(novaChip().getAttribute("aria-label")).toBe("Messaged Nova. Open the conversation");
			// And a keyboard user on Nova's chip stays on it as the line splits.
			sessions([]);
			expect(f.lines()).toHaveLength(1);
			novaChip().focus();
			sessions([coding]);
			expect(f.lines()).toHaveLength(3);
			expect(document.activeElement).toBe(novaChip());
		});
	});
});

describe("the composer at a scale that makes one line fractional", () => {
	/** The stylesheets as the build draws them at 125% (scripts/design-px.mjs), resolved to plain pixels for jsdom.
	 * The app ships at tokens.css's --ui-scale (130%, a line of 54.6); 125% keeps the expected sums exact. */
	function drawAt125(): HTMLStyleElement {
		const style = document.createElement("style");
		// jsdom settles a conflict by order, not specificity, so app.css's bare `textarea` rule goes first;
		// and it cannot split a border shorthand that holds var(), so the shell's widths are spelled out.
		style.textContent = [
			tokensCss,
			appCss,
			conversationCss,
			".composer-shell { border-top-width: 1px; border-bottom-width: 1px; }",
		]
			.join("\n")
			.replace(/^@import .*;$/gm, "")
			.replace(/(?<![\w.#-])(\d+(?:\.\d+)?)px/g, (text, value: string) =>
				Number(value) < 2 ? text : `${Number(value) * 1.25}px`,
			);
		document.head.append(style);
		return style;
	}
	/** Types a draft whose field reports `scrollHeight` as Chrome rounds it, and lays the field out at the height it is given. */
	function typeDraft(view: ConversationView, scrollHeight: number) {
		const field = view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
		Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => scrollHeight });
		field.getBoundingClientRect = () => ({ height: Number.parseFloat(field.style.height) || 0 }) as DOMRect;
		field.value = "draft";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		const shell = view.el.querySelector<HTMLElement>(".composer-shell")!;
		return { field, shell, expanded: shell.classList.contains("is-expanded") };
	}

	it("keeps one line on one row, grows for more and scrolls past the tallest draft", () => {
		const style = drawAt125();
		try {
			const f = setup();
			// One line is 42 × 1.25 = 52.5 pixels, which Chrome reports as 53. The empty composer once
			// opened in its two-row shape here, because 53 > 52.5.
			const one = typeDraft(f.view, 53);
			expect(one.expanded).toBe(false);
			expect(one.field.style.height).toBe("53px");
			expect(one.shell.style.height).toBe("55px");
			// Two lines: the shell adds its expanded padding (8 + 34, at 125%) and its 1px borders.
			const two = typeDraft(f.view, 79);
			expect(two.expanded).toBe(true);
			expect(two.shell.style.height).toBe("133.5px");
			// Back to one line: the shell is measured compact again, so it folds back to one row.
			const again = typeDraft(f.view, 53);
			expect(again.expanded).toBe(false);
			expect(again.shell.style.height).toBe("55px");
			// The tallest draft is 112 × 1.25 = 140 pixels; past it the field scrolls.
			const tall = typeDraft(f.view, 400);
			expect(tall.field.style.height).toBe("140px");
			expect(tall.field.style.overflowY).toBe("auto");
			// A file keeps the shell expanded, even under one line of text: measured expanded, one
			// line is the expanded field's 30 × 1.25 = 37.5, read as 38, under the compact 52.5.
			attach(f.view.el, [new File(["notes"], "notes.txt", { type: "text/plain" })]);
			expect(typeDraft(f.view, 38).expanded).toBe(true);
		} finally {
			style.remove();
		}
	});
});
