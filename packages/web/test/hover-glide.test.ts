// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";
import { HoverGlide, installHoverGlides } from "../src/ui/hover-glide.ts";

function point(target: Element, type: string): void {
	target.dispatchEvent(new MouseEvent(type, { bubbles: type !== "pointerleave", clientX: 40, clientY: 40 }));
}

function item(label: string, top: number, attributes: Record<string, string | boolean> = {}): HTMLElement {
	const element = h("button", { class: "context-menu-item", ...attributes }, label);
	element.getBoundingClientRect = () => new DOMRect(16, top, 200, 32);
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

describe("hover glide in menus", () => {
	let controller: AbortController;
	let menu: HTMLElement;

	beforeEach(() => {
		vi.useFakeTimers();
		frames = new Map();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++frameIds, callback);
			return frameIds;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		controller = new AbortController();
		installHoverGlides(controller.signal);
		menu = h("div", { class: "context-menu" });
		menu.getBoundingClientRect = () => new DOMRect(10, 100, 220, 200);
		document.body.append(menu);
	});

	afterEach(() => {
		controller.abort();
		menu.remove();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("puts one tint under the hovered item of any menu and moves it to the next", () => {
		const first = item("Brooks", 106);
		const second = item("Thetaband", 138);
		menu.append(first, second);

		point(first, "pointerover");
		const tint = menu.querySelector<HTMLElement>(".hover-glide-tint");
		expect(tint?.classList.contains("is-on")).toBe(true);
		expect(tint?.style.translate).toBe("6px 6px");
		expect(menu.classList.contains("hover-glide-group")).toBe(true);
		expect(first.classList.contains("glide-item")).toBe(true);

		point(second, "pointerover");
		expect(menu.querySelectorAll(".hover-glide-tint")).toHaveLength(1);
		play(400);
		expect(tint?.style.translate).toBe("6px 38px");

		point(menu, "pointerleave");
		expect(tint?.classList.contains("is-on")).toBe(false);
		vi.advanceTimersByTime(160);
		expect(menu.querySelector(".hover-glide-tint")).toBeNull();
	});

	it("lights the figure under the pointer in a grid of figures", () => {
		const grid = h("div", { class: "surface-figure-choices" });
		grid.getBoundingClientRect = () => new DOMRect(20, 110, 296, 246);
		const cell = (figure: string, left: number, top: number) => {
			const element = h("button", { class: "surface-figure-choice", "data-figure": figure });
			element.getBoundingClientRect = () => new DOMRect(left, top, 46, 46);
			return element;
		};
		const browser = cell("browser", 20, 110);
		const parcel = cell("parcel", 120, 160);
		grid.append(browser, parcel);
		menu.append(grid);

		point(browser, "pointerover");
		const tint = grid.querySelector<HTMLElement>(".hover-glide-tint");
		expect(tint?.classList.contains("is-on")).toBe(true);
		expect(tint?.style.translate).toBe("0px 0px");
		point(parcel, "pointerover");
		play(400);
		expect(tint?.style.translate).toBe("100px 50px");
		expect(menu.querySelector(":scope > .hover-glide-tint")).toBeNull();
	});

	it("passes over disabled items as a gap", () => {
		const first = item("Brooks", 106);
		const off = item("Fokusur", 138, { disabled: true });
		menu.append(first, off);

		point(first, "pointerover");
		point(off, "pointerover");
		vi.advanceTimersByTime(100);

		expect(menu.querySelector(".hover-glide-tint")?.classList.contains("is-on")).toBe(false);
		expect(off.classList.contains("glide-item")).toBe(false);
	});

	it("follows picks made in code and leaves the pointer alone when told to", () => {
		const list = h("div", { class: "search-window-results" });
		list.getBoundingClientRect = () => new DOMRect(10, 100, 220, 200);
		const row = (top: number) => {
			const element = h("div", { class: "search-window-hit" });
			element.getBoundingClientRect = () => new DOMRect(16, top, 200, 32);
			return element;
		};
		const first = row(106);
		const second = row(138);
		list.append(first, second);
		document.body.append(list);
		const glide = new HoverGlide(list, { tintClass: "hover-glide-tint", item: () => undefined, picks: true });

		point(first, "pointerover");
		expect(list.querySelector(".hover-glide-tint")).toBeNull();
		glide.moveTo(first);
		expect(glide.tint.parentElement).toBe(list);
		expect(glide.tint.style.translate).toBe("6px 6px");
		glide.moveTo(second);
		expect(glide.tint.style.translate).toBe("6px 6px");
		play(400);
		expect(glide.tint.style.translate).toBe("6px 38px");
		point(list, "pointerleave");
		expect(glide.tint.classList.contains("is-on")).toBe(true);
		glide.moveTo(undefined);
		expect(list.querySelector(".hover-glide-tint")).toBeNull();
		list.remove();
	});
});
