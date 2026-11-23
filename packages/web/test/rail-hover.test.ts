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

describe("rail hover tint", () => {
	let list: HTMLElement;
	let controller: AbortController;
	let hover: RailHover;

	beforeEach(() => {
		vi.useFakeTimers();
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
});
