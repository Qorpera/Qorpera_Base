// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { topLeftColor, watchBrowserBar } from "../src/ui/browser-bar.ts";

let stop: (() => void) | undefined;
let stack: HTMLElement[] = [];

function layer(background: string): HTMLElement {
	const element = document.createElement("div");
	element.style.backgroundColor = background;
	document.body.append(element);
	return element;
}

const bar = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;

beforeEach(() => {
	stack = [];
	// jsdom has no layout: the elements under the corner are whatever the test stacks.
	Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => stack });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	vi.useFakeTimers();
});

afterEach(() => {
	stop?.();
	stop = undefined;
	document.head.querySelector('meta[name="theme-color"]')?.remove();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the browser's bar takes the page's top-left colour", () => {
	it("picks the first opaque background, looking through see-through layers", () => {
		const dimmer = layer("rgba(20, 20, 19, 0.48)");
		const rail = layer("rgb(233, 231, 230)");
		const page = layer("rgb(255, 255, 255)");
		stack = [dimmer, rail, page];
		expect(topLeftColor()).toBe("rgb(233, 231, 230)");
		stack = [layer("transparent"), page];
		expect(topLeftColor()).toBe("rgb(255, 255, 255)");
		stack = [dimmer];
		expect(topLeftColor()).toBeUndefined();
	});

	it("sets theme-color at once and follows the sidebar showing and hiding", () => {
		const rail = layer("rgb(233, 231, 230)");
		const page = layer("rgb(250, 250, 250)");
		stack = [rail, page];
		stop = watchBrowserBar();
		expect(bar()).toBe("rgb(233, 231, 230)");

		rail.hidden = true;
		stack = [page];
		vi.runOnlyPendingTimers();
		return Promise.resolve().then(() => {
			vi.runOnlyPendingTimers();
			expect(bar()).toBe("rgb(250, 250, 250)");
		});
	});

	it("follows a theme change", () => {
		const rail = layer("rgb(233, 231, 230)");
		stack = [rail];
		stop = watchBrowserBar();
		rail.style.backgroundColor = "rgb(60, 60, 60)";
		window.dispatchEvent(new Event("qorpera-theme-change"));
		vi.runOnlyPendingTimers();
		expect(bar()).toBe("rgb(60, 60, 60)");
	});
});
