// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";
import { isPhoneLayout } from "../src/ui/layout.ts";
import { RailLayout } from "../src/ui/rail-layout.ts";
import { designPx, uiScale } from "../src/ui/scale.ts";

const queries: string[] = [];
let style: HTMLStyleElement | undefined;
beforeEach(() => {
	localStorage.clear();
	queries.length = 0;
	vi.stubGlobal("innerWidth", 1600);
	vi.stubGlobal("matchMedia", (query: string) => {
		queries.push(query);
		return { matches: false, addEventListener() {}, removeEventListener() {} };
	});
});
afterEach(() => {
	style?.remove();
	style = undefined;
	vi.unstubAllGlobals();
});
/** What tokens.css declares for a mouse or trackpad. */
const drawAt = (scale: number) => {
	style = h("style", null, `:root { --ui-scale: ${scale}; }`);
	document.head.append(style);
};

describe("the app's scale in scripts", () => {
	it("is 1 until the stylesheet is in the page, then follows --ui-scale", () => {
		expect(uiScale()).toBe(1);
		drawAt(1.25);
		expect(uiScale()).toBe(1.25);
		expect(designPx(82)).toBe("calc(82 * var(--px, 1px))");
	});

	it("asks for the phone layout at the width the build wrote for this scale", () => {
		isPhoneLayout();
		drawAt(1.25);
		isPhoneLayout();
		expect(queries).toEqual(["(max-width: 760px)", "(max-width: 950px)"]);
	});

	it("keeps rail widths in design pixels: shown scaled, chosen and stored unscaled", () => {
		drawAt(1.25);
		const aside = h("aside", { class: "rail" }),
			frame = h("div", null, aside),
			rail = new RailLayout(frame, aside);
		frame.append(rail.el);
		try {
			// The 456px default is drawn at 570 screen pixels; the cap is two fifths of the window in design pixels.
			expect(aside.style.getPropertyValue("--rail-width")).toBe("570px");
			expect(rail.el.getAttribute("aria-valuemax")).toBe("512");
			// A drag to 500 screen pixels chooses 400 design pixels.
			rail.el.setPointerCapture = () => {};
			rail.el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1 }));
			rail.el.dispatchEvent(new PointerEvent("pointermove", { clientX: 500, pointerId: 1 }));
			rail.el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
			expect(rail.el.getAttribute("aria-valuenow")).toBe("400");
			expect(aside.style.getPropertyValue("--rail-width")).toBe("500px");
			expect(localStorage.getItem("qorpera.web.rail-width.v2")).toBe("400");
		} finally {
			rail.dispose();
		}
	});
});
