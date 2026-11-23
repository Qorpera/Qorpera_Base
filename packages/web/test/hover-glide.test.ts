// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";
import { installHoverGlides } from "../src/ui/hover-glide.ts";

function point(target: Element, type: string): void {
	target.dispatchEvent(new MouseEvent(type, { bubbles: type !== "pointerleave", clientX: 40, clientY: 40 }));
}

function item(label: string, top: number, attributes: Record<string, string> = {}): HTMLElement {
	const element = h("button", { class: "context-menu-item", ...attributes }, label);
	element.getBoundingClientRect = () => new DOMRect(16, top, 200, 32);
	return element;
}

describe("hover glide in menus", () => {
	let controller: AbortController;
	let menu: HTMLElement;

	beforeEach(() => {
		vi.useFakeTimers();
		controller = new AbortController();
		installHoverGlides(controller.signal);
		menu = h("div", { class: "context-menu" });
		menu.getBoundingClientRect = () => new DOMRect(10, 100, 220, 200);
		document.body.append(menu);
	});

	afterEach(() => {
		controller.abort();
		menu.remove();
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
		expect(tint?.style.translate).toBe("6px 38px");

		point(menu, "pointerleave");
		expect(tint?.classList.contains("is-on")).toBe(false);
		vi.advanceTimersByTime(160);
		expect(menu.querySelector(".hover-glide-tint")).toBeNull();
	});

	it("passes over disabled items as a gap", () => {
		const first = item("Brooks", 106);
		const off = item("Fokusur", 138, { disabled: "" });
		menu.append(first, off);

		point(first, "pointerover");
		point(off, "pointerover");
		vi.advanceTimersByTime(100);

		expect(menu.querySelector(".hover-glide-tint")?.classList.contains("is-on")).toBe(false);
		expect(off.classList.contains("glide-item")).toBe(false);
	});
});
