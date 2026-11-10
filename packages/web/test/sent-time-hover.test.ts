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

	it("hides when its thread goes", () => {
		const { theirs } = thread();
		over(theirs);
		vi.advanceTimersByTime(400);
		expect(shownSentTime()).toBeDefined();
		lifetime.abort();
		expect(shownSentTime()).toBeUndefined();
	});
});
