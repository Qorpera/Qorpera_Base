// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";
import { RailHover } from "../src/ui/rail-hover.ts";

function point(target: Element, type: string, x = 40, y = 40): void {
	target.dispatchEvent(new MouseEvent(type, { bubbles: type !== "pointerleave", clientX: x, clientY: y }));
}

function row(label: string, top: number): HTMLElement {
	const element = h("a", { class: "rail-row" }, label);
	element.getBoundingClientRect = () => new DOMRect(10, top, 280, 64);
	return element;
}

let frames = new Map<number, FrameRequestCallback>();
let frameIds = 0;
let clock = 0;

function play(ms: number): void {
	for (const end = clock + ms; clock < end; ) {
		clock += 16;
		const due = [...frames.values()];
		frames.clear();
		for (const callback of due) callback(clock);
	}
}

function tintTop(hover: RailHover): number {
	return Number.parseFloat(hover.tint.style.translate.split(" ")[1] ?? "");
}

describe("rail hover tint", () => {
	let list: HTMLElement;
	let controller: AbortController;
	let hover: RailHover;

	beforeEach(() => {
		vi.useFakeTimers();
		frames = new Map();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++frameIds, callback);
			return frameIds;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		list = h("div", { class: "rail-scroll" });
		list.getBoundingClientRect = () => new DOMRect(0, 0, 300, 600);
		document.body.append(list);
		controller = new AbortController();
		hover = new RailHover(list, controller.signal);
	});

	afterEach(() => {
		Reflect.deleteProperty(document, "elementFromPoint");
		controller.abort();
		list.remove();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("is in the list only while it shows, and lets go after a gap or on leaving", () => {
		const first = row("Astrid", 20);
		const gap = h("div", { class: "rail-section-title" }, "Marketing");
		list.append(first, gap);
		expect(hover.attached).toBeUndefined();

		point(first, "pointerover");
		expect(hover.attached).toBe(hover.tint);
		expect(hover.tint.classList.contains("is-on")).toBe(true);
		expect(hover.tint.style.translate).toBe("10px 20px");
		expect(first.classList.contains("hover-lit")).toBe(true);

		point(gap, "pointerover");
		vi.advanceTimersByTime(99);
		expect(hover.tint.classList.contains("is-on")).toBe(true);
		point(first, "pointerover");
		vi.advanceTimersByTime(500);
		expect(hover.tint.classList.contains("is-on")).toBe(true);

		point(list, "pointerleave");
		expect(hover.tint.classList.contains("is-on")).toBe(false);
		expect(first.classList.contains("hover-lit")).toBe(false);
		vi.advanceTimersByTime(160);
		expect(list.querySelector(".rail-hover-tint")).toBeNull();
	});

	it("leaves the rows of the dock to the dock's own tint, which stays in the dock", () => {
		const above = row("Website", 20);
		const dock = h("div", { class: "rail-dock" });
		dock.getBoundingClientRect = () => new DOMRect(0, 400, 300, 200);
		const person = row("Sofie", 420);
		dock.append(person);
		list.append(above, dock);
		const dockHover = new RailHover(dock, controller.signal, list);

		point(person, "pointerover");
		expect(hover.attached).toBeUndefined();
		expect(dockHover.attached).toBe(dockHover.tint);
		expect(dockHover.tint.style.translate).toBe("10px 20px");

		point(above, "pointerover");
		expect(hover.attached).toBe(hover.tint);
		expect(dock.contains(hover.tint)).toBe(false);

		list.classList.add("rail-dragging");
		point(person, "pointermove");
		expect(dockHover.tint.classList.contains("is-on")).toBe(false);
	});

	it("moves to the row that replaced the hovered one when the rail redraws", () => {
		const old = row("Bo", 20);
		list.append(old);
		point(old, "pointerover", 50, 30);
		const rebuilt = row("Bo", 84);
		old.replaceWith(rebuilt);
		const elementFromPoint = vi.fn(() => rebuilt);
		document.elementFromPoint = elementFromPoint;

		hover.settle();

		expect(elementFromPoint).toHaveBeenCalledWith(50, 30);
		play(400);
		vi.advanceTimersByTime(100);
		expect(hover.tint.style.translate).toBe("10px 84px");
		expect(rebuilt.classList.contains("hover-lit")).toBe(true);
	});

	it("leaves the list at once while an agent is dragged", () => {
		const first = row("Clara", 20);
		list.append(first);
		point(first, "pointerover");
		list.classList.add("rail-dragging");

		point(first, "pointermove");

		expect(list.querySelector(".rail-hover-tint")).toBeNull();
	});

	it("takes the hover ring off a row once it is opened", () => {
		const first = row("Dagny", 20);
		list.append(first);
		point(first, "pointerover");
		expect(first.classList.contains("hover-lit")).toBe(true);

		first.classList.add("active");
		hover.settle();

		expect(first.classList.contains("hover-lit")).toBe(false);
		expect(hover.attached).toBe(hover.tint);
	});

	it("follows a new row from where it is, settles on it and stops on leaving", () => {
		const first = row("Astrid", 20);
		const second = row("Bo", 100);
		const third = row("Clara", 180);
		list.append(first, second, third);

		point(first, "pointerover");
		point(second, "pointerover");
		expect(frames.size).toBe(1);
		play(16);
		const midway = tintTop(hover);
		expect(midway).toBeGreaterThan(20);
		expect(midway).toBeLessThan(100);

		point(third, "pointerover");
		expect(frames.size).toBe(1);
		play(16);
		expect(tintTop(hover)).toBeGreaterThan(midway);

		play(600);
		expect(hover.tint.style.translate).toBe("10px 180px");
		expect(hover.tint.style.scale).toBe("none");
		expect(frames.size).toBe(0);

		point(first, "pointerover");
		expect(frames.size).toBe(1);
		point(list, "pointerleave");
		expect(frames.size).toBe(0);
	});
});
