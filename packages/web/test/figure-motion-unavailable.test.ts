// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FigureArtwork, type FigureMotion, loadFigureMotion, mountFigureMotion } from "../src/ui/figure-motion.ts";
import { settle } from "./fixtures.ts";

// The recorded motion chunk failed to load: a deploy renamed it while the tab
// was open, or the network dropped during the fetch.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/ui/figure-motion-data.ts", () => {
	loads.count++;
	throw new TypeError("Failed to fetch dynamically imported module");
});

const mounted: FigureMotion[] = [];
const frames = new Map<number, FrameRequestCallback>();
let intersections: IntersectionObserverCallback;
// jsdom has no 2D canvas; the artwork is composed on one before the first frame.
const context = Object.fromEntries(
	["drawImage", "scale", "setTransform", "save", "restore", "translate", "rotate", "beginPath", "fill"].map((key) => [
		key,
		vi.fn(),
	]),
);
const artwork: FigureArtwork = {
	faces: { crown: [] },
	prepare: vi.fn(),
	drawable: () => document.createElement("canvas"),
	colorOnDark: (_id, color) => color,
};
beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(frames.size + 1, callback);
		return frames.size;
	});
	vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				intersections = callback;
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	HTMLImageElement.prototype.decode = vi.fn(async () => {});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
	for (const item of mounted.splice(0)) item.dispose();
	document.body.replaceChildren();
	frames.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function mount(activity: "Idle" | "Working"): HTMLElement {
	const host = document.createElement("span");
	document.body.append(host);
	mounted.push(mountFigureMotion(host, "crown", "#fcb51b", artwork, { activity, identity: activity }));
	intersections(
		[{ target: host, isIntersecting: true } as unknown as IntersectionObserverEntry],
		{} as IntersectionObserver,
	);
	return host;
}

describe("recorded motion that could not load", () => {
	it("leaves every figure on its still artwork for the page's life, with no rebuild asked", async () => {
		const first = [mount("Idle"), mount("Working")];
		await expect(loadFigureMotion()).rejects.toThrow();
		await settle();
		const later = mount("Idle");
		await settle();
		for (const host of [...first, later]) {
			expect(host.querySelector<HTMLImageElement>(".figure-fallback")!.hidden).toBe(false);
			expect(host.querySelector("canvas")!.hidden).toBe(true);
			// The rail rebuilds a figure marked unavailable; that cannot bring the motion back.
			expect(host.dataset.motionUnavailable).toBeUndefined();
		}
		// The artwork itself loaded; only the motion is missing, and nothing animates.
		expect(artwork.prepare).toHaveBeenCalledWith("crown", expect.any(HTMLImageElement));
		expect(frames.size).toBe(0);
		// The browser keeps the failed module, so no later figure pretends to fetch it again.
		expect(loads.count).toBe(1);
	});
});
