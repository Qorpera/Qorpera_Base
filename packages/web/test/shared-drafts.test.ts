// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { DraftSync } from "../src/app/room-drafts.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { RoomDraft, RoomDraftWrite } from "../src/cloud/room-drafts.ts";
import type { HostedProfileMember, HostedSession } from "../src/cloud/types.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

const roomId = id(79);
const members: HostedProfileMember[] = [
	{ userId: userA.id, email: "a@example.invalid", displayName: "Account A", role: "owner", joinedAt: timestamp },
	{ userId: userB.id, email: "b@example.invalid", displayName: "Bo", role: "contributor", joinedAt: timestamp },
];
const group: HostedSession = { ...session, title: "Launch", executionScope: { roomId } };

function draft(ownerUserId: string, body: string, revision: number, more: Partial<RoomDraft> = {}): RoomDraft {
	return {
		roomId,
		ownerUserId,
		body,
		revision,
		editorUserId: ownerUserId,
		contributors: [],
		updatedAt: timestamp,
		...more,
	};
}

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup(drafts: RoomDraft[], options: { members?: HostedProfileMember[] } = {}) {
	const f = fixture();
	let live: ((draft: RoomDraft) => void) | undefined;
	const stop = vi.fn(async () => {});
	vi.mocked(f.api.listRoomDrafts).mockReset().mockResolvedValue(drafts);
	const put = vi.spyOn(f.api, "putRoomDraft");
	const subscribe = vi.spyOn(f.api, "subscribeRoomDrafts").mockImplementation((_room, onDraft, onHealth) => {
		live = onDraft;
		onHealth("connected");
		return { stop };
	});
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team: { ...team, members: options.members ?? members },
		staff: [staff],
		sessions: [group],
		loading: false,
	});
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	view.update();
	await settle();
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const el = view.el;
	return {
		f,
		company,
		view,
		put,
		subscribe,
		stop,
		live: (next: RoomDraft) => live?.(next),
		notches: () => [...el.querySelectorAll<HTMLButtonElement>(".draft-notch")],
		panel: () => el.querySelector<HTMLElement>(".draft-panel"),
		panelInput: () => el.querySelector<HTMLTextAreaElement>(".draft-panel-input")!,
		composer: () => el.querySelector<HTMLTextAreaElement>(".composer-input")!,
		helpers: () => el.querySelector<HTMLElement>(".draft-helpers")!,
	};
}

function type(field: HTMLTextAreaElement, value: string, caret = value.length): void {
	field.focus();
	field.value = value;
	field.setSelectionRange(caret, caret);
	field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("shared drafts above the composer", () => {
	it("shows another member's unsent message as a notch that types while they type and previews the text", async () => {
		const s = await setup([draft(userB.id, "Plan the launch", 3)]);
		expect(s.subscribe).toHaveBeenCalledWith(roomId, expect.any(Function), expect.any(Function));
		expect(s.f.api.listRoomDrafts).toHaveBeenCalledWith(roomId);
		const [notch] = s.notches();
		expect(notch?.getAttribute("aria-label")).toBe("Bo has an unsent message. Open it to write with them");
		expect(notch?.classList.contains("is-typing")).toBe(false);
		expect(notch?.querySelector(".person-avatar")?.textContent).toBe("B");
		expect(notch?.querySelector(".draft-peek-text")?.textContent).toBe("Plan the launch");
		expect(notch?.querySelector(".draft-peek")?.getAttribute("aria-hidden")).toBe("true");

		s.live(draft(userB.id, "Plan the launch today", 4));
		await settle();
		expect(s.notches()[0]).toBe(notch);
		expect(notch?.classList.contains("is-typing")).toBe(true);
		expect(notch?.getAttribute("aria-label")).toBe("Bo is writing a message. Open it to write with them");
		expect(notch?.querySelector(".draft-peek-name")?.textContent).toBe("Bo is writing");
		expect(notch?.querySelector(".draft-peek-text")?.textContent).toBe("Plan the launch today");
		await vi.advanceTimersByTimeAsync(4100);
		expect(notch?.classList.contains("is-typing")).toBe(false);

		// Sent (emptied): the notch goes.
		s.live(draft(userB.id, "", 5));
		await settle();
		expect(s.notches()).toEqual([]);
		expect(s.view.el.querySelector<HTMLElement>(".composer-drafts")?.hidden).toBe(true);
	});

	it("opens another member's draft to write in it, without a way to send it", async () => {
		const s = await setup([draft(userB.id, "Plan the launch", 3)]);
		s.put.mockResolvedValue({
			status: "ok",
			draft: draft(userB.id, "Plan the launch now", 4, { editorUserId: userA.id }),
		});
		s.notches()[0]!.click();
		await settle();
		const panel = s.panel()!;
		expect(panel.getAttribute("aria-label")).toBe("Bo's message");
		expect(panel.querySelector(".draft-panel-note")?.textContent).toBe("Only Bo can send it");
		expect(panel.querySelector(".composer-send")).toBeNull();
		expect(s.notches()).toEqual([]);
		expect(document.activeElement).toBe(s.panelInput());
		expect(s.panelInput().value).toBe("Plan the launch");

		type(s.panelInput(), "Plan the launch now");
		// Enter writes a line; it never sends.
		s.panelInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenCalledTimes(1);
		expect(s.put).toHaveBeenCalledWith(roomId, userB.id, 3, "Plan the launch now");
		await settle();

		// Bo keeps writing: the words arrive where Bo wrote them, the caret stays.
		s.panelInput().setSelectionRange(4, 4);
		s.live(draft(userB.id, "Please plan the launch now", 5, { editorUserId: userB.id }));
		await settle();
		expect(s.panelInput().value).toBe("Please plan the launch now");
		expect(s.panelInput().selectionStart).toBe(11);

		s.panelInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(s.panel()).toBeNull();
		expect(document.activeElement).toBe(s.notches()[0]);
		expect(s.put).toHaveBeenCalledTimes(1);
	});

	it("merges its words into the draft when another member wrote first, and writes again", async () => {
		const s = await setup([draft(userB.id, "Plan the launch", 3)]);
		s.put
			.mockResolvedValueOnce({ status: "stale", draft: draft(userB.id, "Please plan the launch", 4) })
			.mockResolvedValueOnce({
				status: "ok",
				draft: draft(userB.id, "Please plan the launch today", 5, { editorUserId: userA.id }),
			});
		s.notches()[0]!.click();
		await settle();
		type(s.panelInput(), "Plan the launch today");
		await vi.advanceTimersByTimeAsync(310);
		await settle();
		expect(s.panelInput().value).toBe("Please plan the launch today");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenNthCalledWith(2, roomId, userB.id, 4, "Please plan the launch today");
	});

	it("keeps the member's caret when others' words reach their own draft, and says who writes with them", async () => {
		const s = await setup([draft(userA.id, "Hello", 2)]);
		// A reloaded browser gets its own unsent message back.
		expect(s.composer().value).toBe("Hello");
		s.composer().focus();
		s.composer().setSelectionRange(2, 2);
		s.live(draft(userA.id, "Hello team", 3, { editorUserId: userB.id, contributors: [userB.id] }));
		await settle();
		expect(s.composer().value).toBe("Hello team");
		expect(s.composer().selectionStart).toBe(2);
		expect(s.company.conversation(session.sessionId).get().draft).toBe("Hello team");
		expect(s.helpers().hidden).toBe(false);
		expect(s.helpers().textContent).toBe("BBo is writing with you");
		await vi.advanceTimersByTimeAsync(4100);
		expect(s.helpers().textContent).toBe("BWritten with Bo");
		expect(s.put).not.toHaveBeenCalled();

		s.put.mockResolvedValue({
			status: "ok",
			draft: draft(userA.id, "Hey there team", 4, { contributors: [userB.id] }),
		});
		type(s.composer(), "Hey there team", 9);
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenCalledWith(roomId, userA.id, 3, "Hey there team");
	});

	it("holds others' words while the member composes a letter, then merges them when it ends", async () => {
		const s = await setup([draft(userA.id, "Hi", 2)]);
		const composer = s.composer();
		s.put.mockResolvedValue({ status: "ok", draft: draft(userA.id, "Hi é all", 4) });
		composer.dispatchEvent(new CompositionEvent("compositionstart"));
		// As a browser does: input events while composing, and none after compositionend.
		type(composer, "Hi ´");
		s.live(draft(userA.id, "Hi all", 3, { editorUserId: userB.id }));
		await settle();
		expect(composer.value).toBe("Hi ´");
		type(composer, "Hi é");
		await vi.advanceTimersByTimeAsync(1000);
		expect(composer.value).toBe("Hi é");
		// Nothing half composed is written.
		expect(s.put).not.toHaveBeenCalled();
		composer.dispatchEvent(new CompositionEvent("compositionend"));
		await settle();
		expect(composer.value).toBe("Hi é all");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenCalledTimes(1);
		expect(s.put).toHaveBeenCalledWith(roomId, userA.id, 3, "Hi é all");
	});

	it("merges a teammate's words into their draft once a letter composed in it ends, without another input", async () => {
		const s = await setup([draft(userB.id, "Plan", 3)]);
		s.put.mockResolvedValue({ status: "ok", draft: draft(userB.id, "Well, Plan é", 5, { editorUserId: userA.id }) });
		s.notches()[0]!.click();
		await settle();
		const input = s.panelInput();
		input.dispatchEvent(new CompositionEvent("compositionstart"));
		type(input, "Plan é");
		s.live(draft(userB.id, "Well, Plan", 4));
		await vi.advanceTimersByTimeAsync(1000);
		expect(input.value).toBe("Plan é");
		expect(s.put).not.toHaveBeenCalled();
		input.dispatchEvent(new CompositionEvent("compositionend"));
		await settle();
		expect(input.value).toBe("Well, Plan é");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenCalledWith(roomId, userB.id, 4, "Well, Plan é");
	});

	it("keeps what was typed when the same draft is opened again before it was written", async () => {
		const s = await setup([draft(userB.id, "Plan", 3)]);
		s.put.mockResolvedValue({ status: "ok", draft: draft(userB.id, "Plan x", 4, { editorUserId: userA.id }) });
		s.notches()[0]!.click();
		await settle();
		type(s.panelInput(), "Plan x");
		s.panelInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(s.panel()).toBeNull();
		s.notches()[0]!.click();
		await settle();
		expect(s.panelInput().value).toBe("Plan x");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenCalledTimes(1);
		expect(s.put).toHaveBeenCalledWith(roomId, userB.id, 3, "Plan x");
		// Emptying it now empties what was written, too.
		type(s.panelInput(), "");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenLastCalledWith(roomId, userB.id, 4, "");
	});

	it("says when what was typed in a teammate's draft is not saved yet, and saves it once the cloud answers", async () => {
		const s = await setup([draft(userB.id, "Plan", 3)]);
		s.put.mockRejectedValueOnce(new Error("offline"));
		s.put.mockResolvedValueOnce({ status: "ok", draft: draft(userB.id, "Plan it", 4, { editorUserId: userA.id }) });
		s.notches()[0]!.click();
		await settle();
		const status = s.panel()!.querySelector<HTMLElement>(".draft-panel-status")!;
		expect(status.hidden).toBe(true);
		type(s.panelInput(), "Plan it");
		await vi.advanceTimersByTimeAsync(310);
		expect(status.hidden).toBe(false);
		expect(status.textContent).toBe("Not saved yet. Trying again…");
		await vi.advanceTimersByTimeAsync(600);
		expect(s.put).toHaveBeenCalledTimes(2);
		expect(status.hidden).toBe(true);
	});

	it("does not share a text longer than a message can be, and says so until it is shortened", async () => {
		const s = await setup([draft(userB.id, "Plan", 3)]);
		s.put.mockResolvedValue({ status: "ok", draft: draft(userB.id, "Plan short", 4, { editorUserId: userA.id }) });
		s.notches()[0]!.click();
		await settle();
		const status = s.panel()!.querySelector<HTMLElement>(".draft-panel-status")!;
		type(s.panelInput(), `Plan ${"æ".repeat(33_000)}`);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(s.put).not.toHaveBeenCalled();
		expect(status.hidden).toBe(false);
		expect(status.textContent).toBe("Too long to share. Shorten it to share your changes.");
		type(s.panelInput(), "Plan short");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.put).toHaveBeenCalledWith(roomId, userB.id, 3, "Plan short");
		expect(status.hidden).toBe(true);
	});

	it("keeps a teammate's first words that raced a listing, and never goes back to an older version", async () => {
		const f = await setup([]);
		const listing = deferred<RoomDraft[]>();
		vi.mocked(f.f.api.listRoomDrafts).mockReturnValue(listing.promise);
		await vi.advanceTimersByTimeAsync(30_000);
		f.live(draft(userB.id, "Hi", 1));
		await settle();
		listing.resolve([]);
		await settle();
		expect(f.notches()).toHaveLength(1);
		f.live(draft(userB.id, "Hi there", 3));
		f.live(draft(userB.id, "Hi th", 2));
		await settle();
		expect(f.notches()[0]!.querySelector(".draft-peek-text")?.textContent).toBe("Hi there");
	});

	it("asks a room that refused again after a minute", async () => {
		const f = fixture();
		vi.mocked(f.api.listRoomDrafts)
			.mockReset()
			.mockRejectedValueOnce(
				new CloudRpcError("qorpera_list_room_drafts", { message: "denied", code: "42501" }, 403),
			)
			.mockResolvedValue([draft(userB.id, "Back again", 2)]);
		vi.spyOn(f.api, "subscribeRoomDrafts").mockReturnValue({ stop: async () => {} });
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team: { ...team, members }, staff: [staff], sessions: [group], loading: false });
		const view = new ConversationView(company, session.sessionId);
		document.body.append(view.el);
		view.update();
		await settle();
		dispose = () => {
			view.dispose();
			company.stop();
		};
		expect(view.el.querySelector(".draft-notch")).toBeNull();
		await vi.advanceTimersByTimeAsync(61_000);
		view.update();
		await settle();
		expect(f.api.listRoomDrafts).toHaveBeenCalledTimes(2);
		expect(view.el.querySelector(".draft-notch")).not.toBeNull();
	});

	it("keeps words another member added while the message was being sent, and removes the sent text", async () => {
		const s = await setup([draft(userA.id, "Plan it", 2)]);
		s.company.roomDrafts.sending(session.sessionId);
		s.live(draft(userA.id, "Plan it, and invite Bo", 3, { editorUserId: userB.id }));
		await settle();
		const current = s.company.conversation(session.sessionId).get().draft ?? "";
		expect(current).toBe("Plan it, and invite Bo");
		expect(s.company.roomDrafts.sent(session.sessionId, "Plan it", current, true)).toBe(", and invite Bo");
		// Nothing arrived: the composer empties, as without shared drafts.
		s.company.roomDrafts.sending(session.sessionId);
		expect(s.company.roomDrafts.sent(session.sessionId, "Plan it", "Plan it", true)).toBe("");
		// Not delivered: the text stays.
		s.company.roomDrafts.sending(session.sessionId);
		expect(s.company.roomDrafts.sent(session.sessionId, "Plan it", "Plan it", false)).toBe("Plan it");
	});

	it("shares nothing in a company with one member, or on a cloud without shared drafts", async () => {
		const solo = await setup([], { members: [members[0]!] });
		type(solo.composer(), "Only me");
		await vi.advanceTimersByTimeAsync(500);
		expect(solo.f.api.listRoomDrafts).not.toHaveBeenCalled();
		expect(solo.subscribe).not.toHaveBeenCalled();
		expect(solo.put).not.toHaveBeenCalled();
		dispose?.();

		const f = fixture();
		const put = vi.spyOn(f.api, "putRoomDraft");
		const subscribe = vi.spyOn(f.api, "subscribeRoomDrafts").mockReturnValue({ stop: async () => {} });
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team: { ...team, members }, staff: [staff], sessions: [group], loading: false });
		const view = new ConversationView(company, session.sessionId);
		document.body.append(view.el);
		view.update();
		await settle();
		dispose = () => {
			view.dispose();
			company.stop();
		};
		type(view.el.querySelector<HTMLTextAreaElement>(".composer-input")!, "Nobody sees this");
		await vi.advanceTimersByTimeAsync(500);
		view.update();
		expect(f.api.listRoomDrafts).toHaveBeenCalledTimes(1);
		expect(put).not.toHaveBeenCalled();
		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(view.el.querySelector(".draft-notch")).toBeNull();
	});

	it("unsubscribes a minute after the last view of the room closed, and not while one returns", async () => {
		const s = await setup([]);
		s.view.dispose();
		await vi.advanceTimersByTimeAsync(30_000);
		const again = new ConversationView(s.company, session.sessionId);
		again.update();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.stop).not.toHaveBeenCalled();
		expect(s.subscribe).toHaveBeenCalledTimes(1);
		again.dispose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.stop).toHaveBeenCalledTimes(1);
	});
});

describe("one draft kept in step with the cloud", () => {
	function sync(start: { revision: number; body: string }) {
		let text = start.body;
		let busy = false;
		const writes: { base: number; body: string; answer: ReturnType<typeof deferred<RoomDraftWrite>> }[] = [];
		const host = {
			text: () => text,
			caret: () => undefined,
			show: vi.fn((next: string) => {
				text = next;
			}),
			gone: vi.fn(),
			busy: () => busy,
		};
		const written = vi.fn();
		const draftSync = new DraftSync(
			roomId,
			userB.id,
			start,
			host,
			(base, body) => {
				const answer = deferred<RoomDraftWrite>();
				writes.push({ base, body, answer });
				return answer.promise;
			},
			written,
		);
		return {
			sync: draftSync,
			host,
			written,
			writes,
			set: (next: string) => {
				text = next;
				draftSync.changed();
			},
			text: () => text,
			busy: (value: boolean) => {
				busy = value;
			},
		};
	}

	it("writes one change at a time from the revision it last saw, with the keystrokes typed meanwhile after it", async () => {
		const s = sync({ revision: 3, body: "a" });
		s.set("ab");
		s.set("abc");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.writes.map(({ base, body }) => [base, body])).toEqual([[3, "abc"]]);
		s.set("abcd");
		await vi.advanceTimersByTimeAsync(500);
		expect(s.writes).toHaveLength(1);
		s.writes[0]!.answer.resolve({ status: "ok", draft: draft(userB.id, "abc", 4) });
		await vi.advanceTimersByTimeAsync(310);
		expect(s.writes.map(({ base, body }) => [base, body])).toEqual([
			[3, "abc"],
			[4, "abcd"],
		]);
		expect(s.written).toHaveBeenCalledWith(draft(userB.id, "abc", 4));
		expect(s.sync.settled).toBe(false);
		s.writes[1]!.answer.resolve({ status: "ok", draft: draft(userB.id, "abcd", 5) });
		await settle();
		expect(s.sync.settled).toBe(true);
		expect(s.sync.revision).toBe(5);
	});

	it("merges a change announced while its own write was on its way, once the write is answered", async () => {
		const s = sync({ revision: 1, body: "one" });
		s.set("one two");
		await vi.advanceTimersByTimeAsync(310);
		s.sync.remote(draft(userB.id, "zero one two", 3));
		expect(s.host.show).not.toHaveBeenCalled();
		s.writes[0]!.answer.resolve({ status: "ok", draft: draft(userB.id, "one two", 2) });
		await settle();
		expect(s.text()).toBe("zero one two");
		expect(s.sync.revision).toBe(3);
		await vi.advanceTimersByTimeAsync(500);
		expect(s.writes).toHaveLength(1);
		// An old announcement changes nothing.
		s.sync.remote(draft(userB.id, "one", 1));
		expect(s.text()).toBe("zero one two");
	});

	it("keeps trying through a long outage and writes the text once, never twice", async () => {
		const s = sync({ revision: 1, body: "hello" });
		s.set("hello world");
		await vi.advanceTimersByTimeAsync(310);
		for (let attempt = 0; attempt < 12; attempt++) {
			s.writes.at(-1)!.answer.reject(new Error("offline"));
			await vi.advanceTimersByTimeAsync(8000);
		}
		expect(s.sync.stopped).toBe(false);
		expect(s.sync.failing).toBe(true);
		expect(s.writes).toHaveLength(13);
		s.set("hello world!");
		s.writes.at(-1)!.answer.resolve({ status: "ok", draft: draft(userB.id, "hello world!", 2) });
		await settle();
		expect(s.writes.every(({ base }) => base === 1)).toBe(true);
		expect(s.text()).toBe("hello world!");
		expect(s.sync.failing).toBe(false);
		expect(s.sync.settled).toBe(true);
	});

	it("takes a stale answer as the draft even at a revision it thought it had passed, and writes once more", async () => {
		const s = sync({ revision: 3, body: "a" });
		s.set("ab");
		await vi.advanceTimersByTimeAsync(310);
		s.writes[0]!.answer.resolve({ status: "stale", draft: draft(userB.id, "", 0) });
		await vi.advanceTimersByTimeAsync(310);
		expect(s.writes.map(({ base, body }) => [base, body])).toEqual([
			[3, "ab"],
			[0, "b"],
		]);
		s.writes[1]!.answer.resolve({ status: "ok", draft: draft(userB.id, "b", 1) });
		await vi.advanceTimersByTimeAsync(3000);
		expect(s.writes).toHaveLength(2);
	});

	it("does not try a text the cloud refused again until the member changes it", async () => {
		const s = sync({ revision: 1, body: "a" });
		s.set("ab");
		await vi.advanceTimersByTimeAsync(310);
		s.writes[0]!.answer.reject(
			new CloudRpcError("qorpera_put_room_draft", { message: "Draft is invalid", code: "22023" }, 400),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.writes).toHaveLength(1);
		expect(s.sync.status).toBe("too-long");
		await s.sync.flushed();
		s.set("abc");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.writes).toHaveLength(2);
	});

	it("tries again later when the cloud does not answer, and stops when the draft is gone", async () => {
		const s = sync({ revision: 1, body: "a" });
		s.set("ab");
		await vi.advanceTimersByTimeAsync(310);
		s.writes[0]!.answer.reject(new Error("offline"));
		await vi.advanceTimersByTimeAsync(400);
		expect(s.writes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		expect(s.writes.map(({ base, body }) => [base, body])).toEqual([
			[1, "ab"],
			[1, "ab"],
		]);
		s.writes[1]!.answer.resolve({ status: "gone" });
		await settle();
		expect(s.host.gone).toHaveBeenCalledTimes(1);
		expect(s.sync.stopped).toBe(true);
		s.set("abc");
		await vi.advanceTimersByTimeAsync(500);
		expect(s.writes).toHaveLength(2);
	});

	it("keeps a stale answer for after the letter being composed", async () => {
		const s = sync({ revision: 1, body: "hi" });
		s.set("hi ");
		await vi.advanceTimersByTimeAsync(310);
		s.busy(true);
		s.writes[0]!.answer.resolve({ status: "stale", draft: draft(userB.id, "hi all", 2) });
		await settle();
		expect(s.text()).toBe("hi ");
		s.busy(false);
		s.set("hi é");
		expect(s.text()).toBe("hi é all");
		await vi.advanceTimersByTimeAsync(310);
		expect(s.writes.at(-1)).toMatchObject({ base: 2, body: "hi é all" });
	});
});
