// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";
import { RailDrag } from "../src/ui/rail-drag.ts";

let frames: FrameRequestCallback[] = [];
let stop: AbortController;

function boxed(element: HTMLElement, top: number, height: number): HTMLElement {
	element.getBoundingClientRect = () => new DOMRect(0, top, 300, height);
	return element;
}

function scrolls(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
	let top = 0;
	Object.defineProperties(element, {
		scrollHeight: { get: () => scrollHeight },
		clientHeight: { get: () => clientHeight },
		scrollTop: {
			get: () => top,
			set: (value: number) => {
				top = Math.max(0, Math.min(scrollHeight - clientHeight, value));
			},
		},
	});
}

function pointer(type: string, y: number): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
		clientX: 20,
		clientY: y,
	});
}

beforeEach(() => {
	frames = [];
	stop = new AbortController();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
	vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
	stop.abort();
	Reflect.deleteProperty(document, "elementsFromPoint");
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("dragging a contact over the rail's dock", () => {
	it("scrolls the dock near its lower edge, and the list behind it once the dock is at its end", () => {
		const pinned = boxed(h("div", { "data-drop-zone": "pinned" }), 0, 40);
		const sofie = boxed(h("a", { class: "rail-pin", "data-member-id": "sofie" }, "Sofie"), 0, 40);
		pinned.append(sofie);
		const people = boxed(h("div", { class: "rail-section rail-members", "data-drop-zone": "members" }), 320, 280);
		people.append(boxed(h("a", { class: "rail-row", "data-member-id": "mads" }, "Mads"), 320, 40));
		const dock = boxed(h("div", { class: "rail-dock" }, people), 300, 300);
		const list = boxed(h("div", { class: "rail-scroll" }, pinned, dock), 0, 600);
		scrolls(dock, 900, 300);
		scrolls(list, 1200, 600);
		document.body.append(list);
		document.elementsFromPoint = (_x: number, y: number) => (y >= 300 ? [people, dock, list] : [pinned, list]);
		new RailDrag(
			list,
			() => ({ canDrag: () => true, accepts: () => true, drop: () => undefined, end: () => undefined }),
			stop.signal,
		);

		sofie.dispatchEvent(pointer("pointerdown", 20));
		document.dispatchEvent(pointer("pointermove", 34));
		document.dispatchEvent(pointer("pointermove", 590));
		for (let i = 0; i < 3; i++) for (const frame of frames.splice(0)) frame(i * 16);

		expect(list.dataset.dragging).toBe("member");
		expect(dock.scrollTop).toBeGreaterThan(0);
		expect(list.scrollTop).toBe(0);

		dock.scrollTop = 600;
		for (let i = 0; i < 3; i++) for (const frame of frames.splice(0)) frame(48 + i * 16);
		expect(dock.scrollTop).toBe(600);
		expect(list.scrollTop).toBeGreaterThan(0);
	});
});
