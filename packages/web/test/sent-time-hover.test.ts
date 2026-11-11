// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationClockLabel } from "../src/ui/conversation-timestamps.ts";
import { h } from "../src/ui/dom.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { sentTimeHover, sentTimeText, shownSentTime } from "../src/ui/sent-time-hover.ts";

const sentAt = "2026-11-10T09:04:00Z";
let lifetime: AbortController;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
	localStorage.clear();
	setLanguagePreference("en");
	lifetime = new AbortController();
});
afterEach(() => {
	lifetime.abort();
	document.body.replaceChildren();
	localStorage.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function box(left: number, top: number, width: number, height: number): DOMRect {
	return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
}

/** A thread 800 wide: an agent's message on the left, the member's own on the right. */
function thread() {
	const theirs = h("article", { class: "message", "data-sent-at": sentAt }, h("div", { class: "bubble" }, "Hi"));
	const mine = h("article", { class: "message mine", "data-sent-at": "2026-11-09T18:30:00Z" }, "Hello");
	const blank = h("div", { class: "empty" });
	const root = h("div", { class: "messages" }, theirs, mine, blank);
	document.body.append(root);
	root.getBoundingClientRect = () => box(0, 0, 800, 600);
	theirs.getBoundingClientRect = () => box(20, 100, 300, 40);
	mine.getBoundingClientRect = () => box(480, 200, 300, 40);
	sentTimeHover(root, lifetime.signal);
	return { root, theirs, mine, blank };
}

const over = (target: Element, pointerType = "mouse", buttons = 0) =>
	target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType, buttons, clientY: 120 }));

describe("a message's sent time on a hover", () => {
	it("reads the time of day alone, in the chosen language and zone", () => {
		const { theirs, mine } = thread();
		expect(sentTimeText(theirs)).toBe(conversationClockLabel(new Date(sentAt)));
		expect(sentTimeText(theirs)).toMatch(/^\d{1,2}:04/);
		// Yesterday's message shows no day either (Jonas, 11 Nov 2026: "only show the timestamp, not date").
		expect(sentTimeText(mine)).toBe(conversationClockLabel(new Date("2026-11-09T18:30:00Z")));
		expect(sentTimeText(mine)).not.toMatch(/Yesterday|Mon|Nov/);
		setLanguagePreference("da");
		expect(sentTimeText(theirs)).toBe(conversationClockLabel(new Date(sentAt)));
		theirs.dataset.sentAt = "not a time";
		expect(sentTimeText(theirs)).toBe("");
	});

	it("shows at once, with no wait, and moves on with the pointer", () => {
		const { theirs, mine } = thread();
		over(theirs.firstElementChild!);
		expect(shownSentTime()?.textContent).toBe(sentTimeText(theirs));
		expect(shownSentTime()?.getAttribute("aria-hidden")).toBe("true");
		over(mine);
		expect(shownSentTime()?.textContent).toBe(sentTimeText(mine));
	});

	it("stands beside the message, away from the thread's middle, centred on its height", () => {
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(16);
		const { theirs, mine } = thread();
		over(theirs);
		const tip = shownSentTime()!;
		expect(tip.classList.contains("is-over")).toBe(false);
		// Right of the agent's message (320 + 6), centred on 100..140 whatever the pointer's height.
		expect(Number.parseFloat(tip.style.left)).toBe(326);
		expect(Number.parseFloat(tip.style.top)).toBe(112);
		over(mine);
		// Left of the member's own (480 - 6 - 40), centred on 200..240.
		expect(Number.parseFloat(tip.style.left)).toBe(434);
		expect(Number.parseFloat(tip.style.top)).toBe(212);
	});

	it("centres on the part of a long message that is in view", () => {
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(16);
		const { theirs } = thread();
		theirs.getBoundingClientRect = () => box(20, -400, 300, 800);
		over(theirs);
		// Seen from 0 to 400 (the thread's bottom edge is 600, the message ends at 400): centred on 200.
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(192);
	});

	it("goes with the bubble under the pointer in a message of several", () => {
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(16);
		const author = h("div", { class: "message-author" }, "Nova");
		const words = h("div", { class: "bubble" }, h("p", null, "Here are the numbers"));
		const table = h("div", { class: "bubble" }, "A table");
		const caption = h("div", { class: "message-caption" }, "Seen");
		const message = h("article", { class: "message", "data-sent-at": sentAt }, author, words, table, caption);
		const root = h("div", { class: "messages" }, message);
		document.body.append(root);
		root.getBoundingClientRect = () => box(0, 0, 800, 600);
		message.getBoundingClientRect = () => box(20, 80, 500, 300);
		author.getBoundingClientRect = () => box(20, 80, 60, 20);
		words.getBoundingClientRect = () => box(20, 100, 200, 40);
		table.getBoundingClientRect = () => box(20, 150, 500, 200);
		caption.getBoundingClientRect = () => box(20, 360, 40, 20);
		sentTimeHover(root, lifetime.signal);
		over(words.firstElementChild!);
		expect(Number.parseFloat(shownSentTime()!.style.left)).toBe(226);
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(112);
		over(table);
		expect(Number.parseFloat(shownSentTime()!.style.left)).toBe(526);
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(242);
		over(author);
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(112);
		over(caption);
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(242);
		// Between the bubbles: beside the whole message.
		over(message);
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(222);
	});

	it("hides off a message, on a press, a scroll or a key, and ignores touch and a selection", () => {
		const { root, theirs, blank } = thread();
		over(theirs, "touch");
		expect(shownSentTime()).toBeUndefined();
		over(theirs, "mouse", 1);
		expect(shownSentTime()).toBeUndefined();
		for (const end of [
			() => over(blank),
			() => root.dispatchEvent(new PointerEvent("pointerdown")),
			() => root.dispatchEvent(new Event("scroll")),
			() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" })),
			() => root.dispatchEvent(new PointerEvent("pointerleave")),
		]) {
			over(theirs);
			expect(shownSentTime()).toBeDefined();
			end();
			expect(shownSentTime()).toBeUndefined();
		}
	});

	it("shows again when the pointer moves on within the message after a dismissal", () => {
		// Review of #1651 round 1, F1: a scroll inside a long message hid the time for good.
		const { root, theirs } = thread();
		const text = theirs.firstElementChild!;
		over(text);
		expect(shownSentTime()).toBeDefined();
		root.dispatchEvent(new Event("scroll"));
		expect(shownSentTime()).toBeUndefined();
		// No pointerover: the pointer never left the text.
		text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientY: 130 }));
		expect(shownSentTime()?.textContent).toBe(sentTimeText(theirs));
		// A move with the button down (a selection) brings nothing back.
		root.dispatchEvent(new PointerEvent("pointerdown"));
		text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", buttons: 1 }));
		expect(shownSentTime()).toBeUndefined();
	});

	it("stands above the message, inside the panel, where there is no room beside it", () => {
		// Review of #1651 round 1, F2: the time must not stand over what is beside the panel.
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(16);
		const message = h("article", { class: "message", "data-sent-at": sentAt }, "A long one");
		const panel = h("div", { class: "pair-messages" }, message);
		document.body.append(panel);
		panel.getBoundingClientRect = () => box(600, 0, 400, 600);
		message.getBoundingClientRect = () => box(612, 200, 376, 80);
		sentTimeHover(panel, lifetime.signal);
		over(message);
		const tip = shownSentTime()!;
		// Centred over the message (612 + 188 - 80), just above its top (200 - 16 - 3), on the thread's colour.
		expect(tip.classList.contains("is-over")).toBe(true);
		expect(Number.parseFloat(tip.style.left)).toBe(720);
		expect(Number.parseFloat(tip.style.top)).toBe(181);
		// A message wider than the panel, off its left edge: its time stays inside the panel (600 + the 8 px margin).
		message.getBoundingClientRect = () => box(300, 200, 560, 80);
		panel.dispatchEvent(new PointerEvent("pointerleave"));
		over(message);
		expect(Number.parseFloat(shownSentTime()!.style.left)).toBe(608);
		// At the top of the panel, below the message instead.
		message.getBoundingClientRect = () => box(612, 4, 376, 80);
		panel.dispatchEvent(new PointerEvent("pointerleave"));
		over(message);
		expect(Number.parseFloat(shownSentTime()!.style.top)).toBe(87);
	});

	it("hides when its thread goes", () => {
		const { theirs } = thread();
		over(theirs);
		expect(shownSentTime()).toBeDefined();
		lifetime.abort();
		expect(shownSentTime()).toBeUndefined();
	});
});
