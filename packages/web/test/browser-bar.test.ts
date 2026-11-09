// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { topLeftColor, watchBrowserBar } from "../src/ui/browser-bar.ts";

let stop: (() => void) | undefined;

/** jsdom has no layout: a layer covers the top-left corner unless it is placed away from it. */
function layer(background: string, parent: Element = document.body, covers = true): HTMLElement {
	const element = document.createElement("div");
	element.style.backgroundColor = background;
	element.getBoundingClientRect = () =>
		element.hidden ? new DOMRect(0, 0, 0, 0) : covers ? new DOMRect(0, 0, 800, 600) : new DOMRect(300, 0, 500, 600);
	parent.append(element);
	return element;
}

const bar = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
const settle = () => {
	vi.runOnlyPendingTimers();
	return Promise.resolve().then(() => vi.runOnlyPendingTimers());
};

beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	document.body.style.backgroundColor = "rgb(250, 250, 250)";
	vi.useFakeTimers();
});

afterEach(() => {
	stop?.();
	stop = undefined;
	document.head.querySelector('meta[name="theme-color"]')?.remove();
	document.body.replaceChildren();
	document.body.removeAttribute("style");
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the browser's bar takes the page's top-left colour", () => {
	it("takes the topmost opaque box at the corner: deeper and later boxes lie on top", () => {
		const frame = layer("rgb(255, 255, 255)");
		const rail = layer("rgb(233, 231, 230)", frame);
		layer("transparent", rail);
		layer("rgb(0, 0, 0)", frame, false);
		expect(topLeftColor()).toBe("rgb(233, 231, 230)");
		rail.hidden = true;
		expect(topLeftColor()).toBe("rgb(255, 255, 255)");
		frame.remove();
		expect(topLeftColor()).toBe("rgb(250, 250, 250)");
	});

	it("looks through Settings' dimming to the inert sidebar, also after a theme change", () => {
		const frame = layer("rgb(255, 255, 255)");
		const rail = layer("rgb(233, 231, 230)", frame);
		stop = watchBrowserBar();
		frame.inert = true;
		layer("rgba(20, 20, 19, 0.48)");
		expect(topLeftColor()).toBe("rgb(233, 231, 230)");
		rail.style.backgroundColor = "rgb(60, 60, 60)";
		window.dispatchEvent(new Event("qorpera-theme-change"));
		vi.runOnlyPendingTimers();
		expect(bar()).toBe("rgb(60, 60, 60)");
	});

	it("sets theme-color at once and follows the sidebar hiding", async () => {
		const rail = layer("rgb(233, 231, 230)");
		stop = watchBrowserBar();
		expect(bar()).toBe("rgb(233, 231, 230)");
		rail.hidden = true;
		await settle();
		expect(bar()).toBe("rgb(250, 250, 250)");
	});

	it("skips hidden and fully faded boxes", () => {
		layer("rgb(255, 255, 255)");
		layer("rgb(1, 1, 1)").style.visibility = "hidden";
		layer("rgb(2, 2, 2)").style.opacity = "0";
		expect(topLeftColor()).toBe("rgb(255, 255, 255)");
	});
});
