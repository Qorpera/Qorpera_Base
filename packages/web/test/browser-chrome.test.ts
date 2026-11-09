// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBrowserChrome, safariOnMac, watchTheme } from "../src/ui/appearance.ts";

const SAFARI =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const root = document.documentElement;
let stopWatching: (() => void) | undefined;
let focused = true;
let standalone = false;

function browser(agent: string, touchPoints = 0) {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
	Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => touchPoints });
}

beforeEach(() => {
	focused = true;
	standalone = false;
	vi.useFakeTimers();
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("standalone") ? standalone : false,
		addEventListener() {},
		removeEventListener() {},
	}));
});

afterEach(() => {
	stopWatching?.();
	stopWatching = undefined;
	delete root.dataset.chrome;
	delete root.dataset.windowInactive;
	delete root.dataset.theme;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("sidebars follow Safari's toolbar", () => {
	it("marks only Safari on a Mac, not Chrome, an iPad or an installed web app", () => {
		browser(SAFARI);
		expect(safariOnMac()).toBe(true);
		browser(CHROME);
		expect(safariOnMac()).toBe(false);
		browser(SAFARI, 5);
		expect(safariOnMac()).toBe(false);
		browser(SAFARI);
		standalone = true;
		expect(safariOnMac()).toBe(false);
		applyBrowserChrome();
		expect(root.dataset.chrome).toBeUndefined();
	});

	it("turns darker when the window goes behind and lighter when it comes back", () => {
		browser(SAFARI);
		stopWatching = watchTheme();
		expect(root.dataset.chrome).toBe("safari");
		expect(root.dataset.windowInactive).toBeUndefined();

		focused = false;
		window.dispatchEvent(new Event("blur"));
		vi.runOnlyPendingTimers();
		expect(root.dataset.windowInactive).toBe("");

		focused = true;
		window.dispatchEvent(new Event("focus"));
		expect(root.dataset.windowInactive).toBeUndefined();
	});

	it("stays in front while focus is inside a frame, and notices the window going behind from there", () => {
		browser(SAFARI);
		stopWatching = watchTheme();
		// Focus moves into an iframe: the page blurs, but the document still has focus.
		window.dispatchEvent(new Event("blur"));
		vi.advanceTimersByTime(1);
		expect(root.dataset.windowInactive).toBeUndefined();
		// The window goes behind with focus in the frame: no event reaches the page.
		focused = false;
		vi.advanceTimersByTime(500);
		expect(root.dataset.windowInactive).toBe("");
	});

	it("leaves other browsers alone", () => {
		browser(CHROME);
		stopWatching = watchTheme();
		focused = false;
		window.dispatchEvent(new Event("blur"));
		vi.runOnlyPendingTimers();
		expect(root.dataset.chrome).toBeUndefined();
		expect(root.dataset.windowInactive).toBeUndefined();
	});
});
