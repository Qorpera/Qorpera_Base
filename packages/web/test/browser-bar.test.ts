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
		stop = watchBrowserBar(document.body);
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
		stop = watchBrowserBar(document.body);
		expect(bar()).toBe("rgb(233, 231, 230)");
		rail.hidden = true;
		await settle();
		expect(bar()).toBe("rgb(250, 250, 250)");
	});

	it("reads again when the app puts a screen into its root after the watch starts", async () => {
		const root = layer("transparent");
		stop = watchBrowserBar(root);
		expect(bar()).toBe("rgb(250, 250, 250)");
		const frame = layer("rgb(255, 255, 255)", root);
		layer("rgb(233, 231, 230)", frame);
		await settle();
		expect(bar()).toBe("rgb(233, 231, 230)");
	});

	it("follows the sidebar's grey when the Safari window goes behind", async () => {
		const rail = layer("rgb(246, 246, 247)");
		stop = watchBrowserBar(document.body);
		expect(bar()).toBe("rgb(246, 246, 247)");
		// tokens.css swaps the grey on this mark; jsdom has no such stylesheet, so the test does.
		rail.style.backgroundColor = "rgb(233, 234, 235)";
		document.documentElement.dataset.windowInactive = "";
		await settle();
		expect(bar()).toBe("rgb(233, 234, 235)");
		delete document.documentElement.dataset.windowInactive;
	});

	it("skips hidden and fully faded boxes", () => {
		layer("rgb(255, 255, 255)");
		layer("rgb(1, 1, 1)").style.visibility = "hidden";
		layer("rgb(2, 2, 2)").style.opacity = "0";
		expect(topLeftColor()).toBe("rgb(255, 255, 255)");
	});

	it("ignores class and hidden mutations inside main so chat scrolling does not re-measure layout", async () => {
		const rail = layer("rgb(233, 231, 230)");
		const main = document.createElement("main");
		const message = document.createElement("div");
		main.append(message);
		document.body.append(main);
		stop = watchBrowserBar(document.body);
		const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
		message.classList.add("is-hovered");
		message.hidden = true;
		await settle();
		expect(rafSpy).not.toHaveBeenCalled();
		rail.hidden = true;
		await settle();
		expect(rafSpy).toHaveBeenCalled();
		expect(bar()).toBe("rgb(250, 250, 250)");
	});

	it("ignores class and hidden mutations inside the sidebar rail while still watching the rail itself", async () => {
		const rail = layer("rgb(233, 231, 230)");
		rail.className = "rail";
		const row = document.createElement("div");
		row.className = "rail-surface";
		rail.append(row);
		stop = watchBrowserBar(document.body);
		const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
		row.classList.add("is-hovered");
		row.hidden = true;
		await settle();
		expect(rafSpy).not.toHaveBeenCalled();
		rail.hidden = true;
		await settle();
		expect(rafSpy).toHaveBeenCalled();
		expect(bar()).toBe("rgb(250, 250, 250)");
	});
});
