// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";
import { quietScroll } from "../src/ui/quiet-scroll.ts";
import { isSteppedWheel, SMOOTH_WHEEL_SETTLE_MS, smoothWheel } from "../src/ui/smooth-wheel.ts";

let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let frameIds = 0;
let reduce = false;

beforeEach(() => {
	now = 1000;
	frames = new Map();
	reduce = false;
	vi.stubGlobal("matchMedia", () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameIds, callback);
		return frameIds;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** Runs the animation frames for this long, one every 16 ms. */
function play(ms: number): void {
	for (const end = now + ms; now < end; ) {
		now += 16;
		const due = [...frames.values()];
		frames.clear();
		for (const callback of due) callback(now);
	}
}

/** jsdom has no layout: a scroller of this size whose position the browser clamps like a real one. */
function scroller(content = 2000, height = 500): HTMLElement {
	const el = h("div");
	let top = 0;
	Object.defineProperty(el, "scrollHeight", { value: content, configurable: true });
	Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (value: number) => {
			top = Math.round(Math.min(Math.max(value, 0), content - height));
		},
	});
	document.body.append(el);
	return el;
}

type Wheel = {
	deltaY: number;
	deltaX?: number;
	deltaMode?: number;
	wheelDeltaY?: number;
	at?: number;
	ctrlKey?: boolean;
};
function wheelEvent({ deltaY, deltaX = 0, deltaMode = 0, wheelDeltaY, at = now, ctrlKey = false }: Wheel): WheelEvent {
	const event = new WheelEvent("wheel", { deltaY, deltaX, deltaMode, ctrlKey, bubbles: true, cancelable: true });
	Object.defineProperty(event, "wheelDeltaY", { value: wheelDeltaY ?? -Math.trunc(deltaY * 3) });
	Object.defineProperty(event, "timeStamp", { value: at });
	return event;
}
/** One click of a stepped wheel, as WebKit and Chromium report it: 40 px and 120 per line. */
const click = (lines: number, at = now) => wheelEvent({ deltaY: lines * 40, wheelDeltaY: -lines * 120, at });
/** A trackpad's whole-pixel step: wheelDeltaY is 3 × the pixels. */
const swipe = (pixels: number, at = now) => wheelEvent({ deltaY: pixels, at });

describe("which wheel events glide", () => {
	it("takes stepped wheels and leaves trackpads alone", () => {
		expect(isSteppedWheel(click(1))).toBe(true);
		expect(isSteppedWheel(click(-3))).toBe(true);
		// macOS speeds a slow wheel up in tenths of a line: 0.1000061 × 40 px, wheelDeltaY 12.
		expect(isSteppedWheel(wheelEvent({ deltaY: 4.000244140625, wheelDeltaY: -12 }))).toBe(true);
		expect(isSteppedWheel(wheelEvent({ deltaY: -8.00048828125, wheelDeltaY: 24 }))).toBe(true);
		// Firefox counts lines or pages and measures a line by the font: it keeps its own distance.
		expect(isSteppedWheel(wheelEvent({ deltaY: 3, deltaMode: 1, wheelDeltaY: -120 }))).toBe(false);
		expect(isSteppedWheel(wheelEvent({ deltaY: 1, deltaMode: 2, wheelDeltaY: -120 }))).toBe(false);

		expect(isSteppedWheel(swipe(1))).toBe(false);
		expect(isSteppedWheel(swipe(4))).toBe(false);
		expect(isSteppedWheel(swipe(-17))).toBe(false);
		expect(isSteppedWheel(wheelEvent({ deltaY: 2.5, wheelDeltaY: -7 }))).toBe(false);
		// A browser without the legacy field: pixels alone say nothing, so the browser keeps them.
		const bare = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
		expect(isSteppedWheel(bare)).toBe(false);
	});
});

describe("smooth wheel", () => {
	it("glides a click the distance the browser would have jumped", () => {
		const el = scroller();
		smoothWheel(el);
		const event = click(2);
		el.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(el.scrollTop).toBe(0);
		play(48);
		expect(el.scrollTop).toBeGreaterThan(20);
		expect(el.scrollTop).toBeLessThan(80);
		play(SMOOTH_WHEEL_SETTLE_MS * 7);
		expect(el.scrollTop).toBe(80);
		expect(frames.size).toBe(0);
	});

	it("adds fast clicks into one glide and turns back from where it is", () => {
		const el = scroller();
		smoothWheel(el);
		el.dispatchEvent(click(3));
		play(16);
		el.dispatchEvent(click(3));
		play(400);
		expect(el.scrollTop).toBe(240);

		el.dispatchEvent(click(3));
		play(32);
		const turnedAt = el.scrollTop;
		el.dispatchEvent(click(-1));
		play(400);
		expect(el.scrollTop).toBe(turnedAt - 40);
	});

	it("stops at the ends and leaves a wheel there to the browser", () => {
		const el = scroller(600, 500);
		smoothWheel(el);
		el.dispatchEvent(click(10));
		play(400);
		expect(el.scrollTop).toBe(100);
		const atEnd = click(1, now + 500);
		el.dispatchEvent(atEnd);
		expect(atEnd.defaultPrevented).toBe(false);
		const up = click(-1, now + 1000);
		el.dispatchEvent(up);
		expect(up.defaultPrevented).toBe(true);
	});

	it("keeps the browser's own scrolling for trackpads, zoom, sideways and reduced motion", () => {
		const el = scroller();
		smoothWheel(el);
		const trackpad = swipe(6);
		el.dispatchEvent(trackpad);
		expect(trackpad.defaultPrevented).toBe(false);
		// Later events of that gesture stay native, whatever they look like.
		const fast = swipe(40, now + 16);
		el.dispatchEvent(fast);
		expect(fast.defaultPrevented).toBe(false);

		const zoom = wheelEvent({ deltaY: 40, wheelDeltaY: -120, ctrlKey: true, at: now + 1000 });
		el.dispatchEvent(zoom);
		expect(zoom.defaultPrevented).toBe(false);
		const sideways = wheelEvent({ deltaY: 0, deltaX: 40, wheelDeltaY: 0, at: now + 2000 });
		el.dispatchEvent(sideways);
		expect(sideways.defaultPrevented).toBe(false);

		// A line-based wheel (Firefox) keeps the browser's distance and easing.
		const lines = wheelEvent({ deltaY: 3, deltaMode: 1, wheelDeltaY: -120, at: now + 2500 });
		el.dispatchEvent(lines);
		expect(lines.defaultPrevented).toBe(false);

		reduce = true;
		const still = click(1, now + 3000);
		el.dispatchEvent(still);
		expect(still.defaultPrevented).toBe(false);
		expect(frames.size).toBe(0);
	});

	it("ends the glide where it is when a trackpad or a press takes over", () => {
		const el = scroller();
		smoothWheel(el);
		el.dispatchEvent(click(5));
		play(32);
		const at = el.scrollTop;
		el.dispatchEvent(swipe(3, now + 200));
		play(400);
		expect(el.scrollTop).toBe(at);

		el.dispatchEvent(click(5, now + 1000));
		play(32);
		const pressed = el.scrollTop;
		el.dispatchEvent(new Event("pointerdown"));
		play(400);
		expect(el.scrollTop).toBe(pressed);
	});

	it("keeps to the content when the scroller moves by itself", () => {
		const el = scroller(4000);
		smoothWheel(el);
		el.dispatchEvent(click(5));
		play(32);
		// Earlier messages are put in above, and the thread keeps its place by moving down 600 px.
		el.scrollTop += 600;
		play(400);
		expect(el.scrollTop).toBe(800);
	});

	it("leaves the wheel to a card inside that scrolls itself", () => {
		const el = scroller();
		const card = h("pre");
		Object.defineProperty(card, "scrollHeight", { value: 900 });
		Object.defineProperty(card, "clientHeight", { value: 300 });
		card.style.overflowY = "auto";
		el.append(card);
		smoothWheel(el);
		const inside = click(1);
		card.dispatchEvent(inside);
		expect(inside.defaultPrevented).toBe(false);
		// Scrolled to its own top, it has nothing left upward, so the thread takes an upward click.
		el.scrollTop = 300;
		const up = click(-1, now + 1000);
		card.dispatchEvent(up);
		expect(up.defaultPrevented).toBe(true);
	});

	it("comes with every quiet scroller", () => {
		const el = scroller();
		quietScroll(el);
		const event = click(1);
		el.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});
