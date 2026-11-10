// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationTimestampLabel } from "../src/ui/conversation-timestamps.ts";
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
	it("reads the moment in the chosen language and zone, after a label when there is one", () => {
		const { theirs } = thread();
		expect(sentTimeText(theirs)).toBe(conversationTimestampLabel(new Date(sentAt)));
		expect(sentTimeText(theirs)).toMatch(/^Today /);
		theirs.dataset.sentLabel = "Messaged Nova";
		expect(sentTimeText(theirs)).toBe(`Messaged Nova · ${conversationTimestampLabel(new Date(sentAt))}`);
		theirs.dataset.sentAt = "not a time";
		expect(sentTimeText(theirs)).toBe("");
	});

	it("shows after the pointer rests, then at once on the next message", () => {
		const { theirs, mine } = thread();
		over(theirs.firstElementChild!);
		expect(shownSentTime()).toBeUndefined();
		vi.advanceTimersByTime(400);
		expect(shownSentTime()?.textContent).toBe(sentTimeText(theirs));
		expect(shownSentTime()?.getAttribute("aria-hidden")).toBe("true");
		over(mine);
		expect(shownSentTime()?.textContent).toMatch(/^Yesterday /);
	});

	it("stands beside the message, away from the thread's middle", () => {
		const { theirs, mine } = thread();
		over(theirs);
		vi.advanceTimersByTime(400);
		const tip = shownSentTime()!;
		expect(Number.parseFloat(tip.style.left)).toBeGreaterThanOrEqual(320);
		over(mine);
		expect(Number.parseFloat(tip.style.left)).toBeLessThan(480);
	});

	it("hides off a message, on a press, a scroll or a key, and ignores touch and a selection", () => {
		const { root, theirs, blank } = thread();
		over(theirs, "touch");
		vi.advanceTimersByTime(400);
		expect(shownSentTime()).toBeUndefined();
		over(theirs, "mouse", 1);
		vi.advanceTimersByTime(400);
		expect(shownSentTime()).toBeUndefined();
		for (const end of [
			() => over(blank),
			() => root.dispatchEvent(new PointerEvent("pointerdown")),
			() => root.dispatchEvent(new Event("scroll")),
			() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" })),
			() => root.dispatchEvent(new PointerEvent("pointerleave")),
		]) {
			vi.advanceTimersByTime(1000);
			over(theirs);
			vi.advanceTimersByTime(400);
			expect(shownSentTime()).toBeDefined();
			end();
			expect(shownSentTime()).toBeUndefined();
		}
	});

	it("asks again when the pointer moves on within the message after a dismissal, after the wait", () => {
		// Review of #1651 round 1, F1: a scroll inside a long message hid the label for good.
		const { root, theirs } = thread();
		const text = theirs.firstElementChild!;
		over(text);
		vi.advanceTimersByTime(400);
		expect(shownSentTime()).toBeDefined();
		root.dispatchEvent(new Event("scroll"));
		expect(shownSentTime()).toBeUndefined();
		// No pointerover: the pointer never left the text.
		text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientY: 130 }));
		// A dismissal is not a move to the next message: it waits again.
		expect(shownSentTime()).toBeUndefined();
		vi.advanceTimersByTime(400);
		expect(shownSentTime()?.textContent).toBe(sentTimeText(theirs));
		// A move with the button down (a selection) brings nothing back.
		root.dispatchEvent(new PointerEvent("pointerdown"));
		text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", buttons: 1 }));
		vi.advanceTimersByTime(400);
		expect(shownSentTime()).toBeUndefined();
	});

	it("keeps the label inside a narrow panel that stands off the window's left edge", () => {
		// Review of #1651 round 1, F2: the label above the pointer could stand over what is beside the panel.
		const size = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(24);
		const message = h("article", { class: "message", "data-sent-at": sentAt }, "A long one");
		const panel = h("div", { class: "pair-messages" }, message);
		document.body.append(panel);
		panel.getBoundingClientRect = () => box(600, 0, 400, 600);
		message.getBoundingClientRect = () => box(612, 200, 376, 80);
		sentTimeHover(panel, lifetime.signal);
		message.dispatchEvent(
			new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", clientX: 615, clientY: 240 }),
		);
		vi.advanceTimersByTime(400);
		const tip = shownSentTime()!;
		expect(size).toHaveBeenCalled();
		// No room beside: above the pointer, its left edge inside the panel (600 + the 8 px margin), not at 535.
		expect(Number.parseFloat(tip.style.left)).toBe(608);
		expect(Number.parseFloat(tip.style.top)).toBeLessThan(240);
		message.dispatchEvent(new PointerEvent("pointerleave"));
		panel.dispatchEvent(new PointerEvent("pointerleave"));
		message.dispatchEvent(
			new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", clientX: 990, clientY: 240 }),
		);
		vi.advanceTimersByTime(400);
		// At the right edge, its right edge stays inside too (1000 - 8 - 160).
		expect(Number.parseFloat(shownSentTime()!.style.left)).toBe(832);
	});

	it("hides when its thread goes", () => {
		const { theirs } = thread();
		over(theirs);
		vi.advanceTimersByTime(400);
		expect(shownSentTime()).toBeDefined();
		lifetime.abort();
		expect(shownSentTime()).toBeUndefined();
	});
});
