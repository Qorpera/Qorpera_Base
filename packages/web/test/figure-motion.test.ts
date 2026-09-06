// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localTime, pose } from "../public/assets/avatars/status-2d-v1/motion.mjs";
import { type FigureArtwork, type FigureMotion, mountFigureMotion } from "../src/ui/figure-motion.ts";
import { deferred, settle } from "./fixtures.ts";

vi.mock("../public/assets/avatars/status-2d-v1/recorded-motion.mjs", () => ({
	loadRecordedMotion: vi.fn(async () => {}),
	drawRecordedEyes: vi.fn(),
	drawWorkingStrokes: vi.fn(),
}));
const mounted: FigureMotion[] = [];
let now = 0,
	nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
let intersections: IntersectionObserverCallback;
let reduced: EventTarget & { matches: boolean };
const context = Object.fromEntries(
	[
		"drawImage",
		"scale",
		"setTransform",
		"save",
		"restore",
		"translate",
		"rotate",
		"beginPath",
		"roundRect",
		"fill",
		"fillRect",
		"clearRect",
		"moveTo",
		"quadraticCurveTo",
		"lineTo",
		"closePath",
		"arc",
		"stroke",
	].map((key) => [key, vi.fn()]),
);
const artwork: FigureArtwork = {
	faces: {
		crown: [
			{ x: 55, y: 55, width: 6, height: 14, rotation: -11 },
			{ x: 69, y: 54, width: 6, height: 14, rotation: -11 },
		],
	},
	prepare: vi.fn(),
	drawable: () => document.createElement("canvas"),
};
beforeEach(() => {
	now = 0;
	frames.clear();
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	reduced = Object.assign(new EventTarget(), { matches: false });
	vi.stubGlobal("matchMedia", () => reduced);
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
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
	HTMLImageElement.prototype.decode = vi.fn(async () => {});
});
afterEach(() => {
	for (const item of mounted.splice(0)) item.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function show(hosts: HTMLElement[], visible = true): void {
	intersections(
		hosts.map((target) => ({ target, isIntersecting: visible }) as IntersectionObserverEntry),
		{} as IntersectionObserver,
	);
}
function advance(milliseconds: number): void {
	now += milliseconds;
	const callbacks = [...frames.values()];
	frames.clear();
	for (const callback of callbacks) callback(now);
}
function mount(activity: "Idle" | "Working" = "Idle", identity = "agent"): HTMLElement {
	const host = document.createElement("span");
	document.body.append(host);
	mounted.push(mountFigureMotion(host, "crown", "#fcb51b", artwork, { activity, identity }));
	return host;
}

describe("2D studio playback in the shell", () => {
	it("keeps the final Working frame in bounds immediately before the loop wraps", async () => {
		const host = mount("Working", "loop-boundary");
		await settle();
		show([host]);
		advance((650 / 60) * 1000 - 0.0000001);
		expect(host.querySelector("canvas")!.dataset.frame).toBe("649");
	});
	it("advances one shared agent clock once per frame and preserves it when a view refreshes", async () => {
		const a = mount(),
			b = mount();
		await settle();
		show([a, b]);
		advance(1000);
		expect(a.querySelector("canvas")!.dataset.frame).toBe("60");
		expect(b.querySelector("canvas")!.dataset.frame).toBe("60");
		const replacement = mount();
		await settle();
		show([replacement]);
		expect(replacement.querySelector("canvas")!.dataset.frame).toBe("60");
		advance(3000);
		expect(replacement.querySelector("canvas")!.dataset.frame).toBe("221");
		expect(frames.size).toBe(0);
	});
	it("stops offscreen playback and holds a non-animated pose under reduced motion", async () => {
		const host = mount("Working");
		await settle();
		show([host]);
		advance(1000);
		expect(host.querySelector("canvas")!.dataset.frame).toBe("60");
		show([host], false);
		advance(1000);
		expect(frames.size).toBe(0);
		advance(9000);
		show([host]);
		advance(1000);
		expect(host.querySelector("canvas")!.dataset.frame).toBe("120");
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		advance(1000);
		expect(host.querySelector("canvas")!.dataset.frame).toBe("60");
		expect(frames.size).toBe(0);
	});
	it("does not paint or restart a removed figure after its artwork finishes loading", async () => {
		const load = deferred<void>();
		vi.mocked(HTMLImageElement.prototype.decode).mockReturnValue(load.promise);
		const host = document.createElement("span");
		document.body.append(host);
		const motion = mountFigureMotion(host, "ghost", "#312f2d", artwork);
		motion.dispose();
		host.remove();
		load.resolve();
		await settle();
		expect(host.querySelector("canvas")!.hidden).toBe(true);
		expect(frames.size).toBe(0);
	});
	it("retains the studio's holds, complete Working loop, and symbolic states", () => {
		expect(localTime("Idle", 90)).toBeCloseTo(221 / 60);
		expect(localTime("Waiting", 90)).toBeCloseTo(278 / 60);
		expect(localTime("Working", 650 / 60)).toBeCloseTo(0);
		expect(pose("Blocked", 1)).toMatchObject({ body: 0, stemWidth: 7.5, alertDotR: 4.4 });
		expect(pose("Thinking", 2).dots.map((dot) => dot.y)).toEqual([50, 50, 50]);
		expect(pose("Done", 1).strokes).toHaveLength(6);
		expect(pose("Done", 7).strokes).toHaveLength(0);
	});
});
