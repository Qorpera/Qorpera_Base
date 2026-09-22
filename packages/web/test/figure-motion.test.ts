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

import { loadRecordedMotion } from "../public/assets/avatars/status-2d-v1/recorded-motion.mjs";

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
	colorOnDark: (_id, color) => (color === "#312f2d" ? "#a29d97" : color),
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
		hosts.map((target) => ({
			target,
			isIntersecting: visible,
			boundingClientRect: target.getBoundingClientRect(),
			intersectionRect: target.getBoundingClientRect(),
			intersectionRatio: visible ? 1 : 0,
			rootBounds: null,
			time: now,
		})),
		{} as IntersectionObserver,
	);
}
function advance(milliseconds: number): void {
	now += milliseconds;
	const callbacks = [...frames.values()];
	frames.clear();
	for (const callback of callbacks) callback(now);
}
function mount(activity: "Idle" | "Working" | "Thinking" = "Idle", identity = "agent"): HTMLElement {
	const host = document.createElement("span");
	document.body.append(host);
	mounted.push(mountFigureMotion(host, "crown", "#fcb51b", artwork, { activity, identity }));
	return host;
}

describe("2D studio playback in the shell", () => {
	it("keeps writing dots synchronized across views, coloured and static under reduced motion", async () => {
		const rail = mount("Thinking"),
			thread = mount("Thinking");
		await settle();
		show([rail, thread]);
		advance(2000);
		expect(rail.querySelector("canvas")!.dataset.frame).toBe(thread.querySelector("canvas")!.dataset.frame);
		expect(context.fillStyle).toBe("#fcb51b");
		expect(pose("Thinking", 2).body).toBe(0);
		expect(pose("Thinking", 2).dots).toHaveLength(3);
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		advance(1000);
		expect(frames.size).toBe(0);
		expect(rail.querySelector("canvas")!.dataset.frame).toBe(thread.querySelector("canvas")!.dataset.frame);
	});
	it("plays Working past the recording's end without restarting, the same in every view of the agent", async () => {
		const rail = mount("Working", "loop-boundary"),
			thread = mount("Working", "loop-boundary");
		await settle();
		show([rail, thread]);
		advance(1000);
		expect(rail.querySelector("canvas")!.dataset.frame).toBe("60");
		expect(rail.querySelector("canvas")!.dataset.clip).toBe("Working");
		advance((650 / 60) * 1000 - 1000 + 100);
		const canvas = rail.querySelector("canvas")!;
		// Past the opening (frames 0–79); the pieces after it are drawn at random.
		expect(canvas.dataset.clip === "Waiting" || Number(canvas.dataset.frame) > 79).toBe(true);
		expect(canvas.dataset.frame).toBe(thread.querySelector("canvas")!.dataset.frame);
		expect(canvas.dataset.clip).toBe(thread.querySelector("canvas")!.dataset.clip);
		expect(loadRecordedMotion).toHaveBeenCalledWith("Waiting", expect.any(URL));
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
	it("paints charcoal in the light ink on the dark theme and repaints when the theme changes", async () => {
		const drawable = vi.spyOn(artwork, "drawable");
		const root = document.documentElement;
		root.dataset.theme = "light";
		try {
			const charcoal = document.createElement("span"),
				gold = document.createElement("span");
			document.body.append(charcoal, gold);
			mounted.push(mountFigureMotion(charcoal, "crown", "#312f2d", artwork, { still: true, identity: "ink" }));
			await settle();
			show([charcoal]);
			expect(drawable).toHaveBeenLastCalledWith("crown-face", "#312f2d");
			expect(context.fillStyle).toBe("#312f2d");
			root.dataset.theme = "dark";
			window.dispatchEvent(new Event("qorpera-theme-change"));
			await settle();
			expect(drawable).toHaveBeenLastCalledWith("crown-face", "#a29d97");
			expect(context.fillStyle).toBe("#a29d97");
			// Other colours are painted as stored.
			mounted.push(mountFigureMotion(gold, "crown", "#fcb51b", artwork, { still: true, identity: "gold" }));
			await settle();
			show([gold]);
			expect(context.fillStyle).toBe("#fcb51b");
			root.dataset.theme = "light";
			window.dispatchEvent(new Event("qorpera-theme-change"));
			await settle();
			expect(context.fillStyle).toBe("#312f2d");
		} finally {
			delete root.dataset.theme;
		}
	});
	it("repaints a figure at the new pixel density when the window moves to another screen", async () => {
		const screens: EventTarget[] = [];
		vi.stubGlobal("matchMedia", (query: string) => {
			if (!query.startsWith("(resolution")) return reduced;
			screens.push(Object.assign(new EventTarget(), { matches: true }));
			return screens.at(-1);
		});
		const host = mount();
		await settle();
		show([host]);
		const canvas = host.querySelector("canvas")!;
		const width = canvas.width;
		vi.stubGlobal("devicePixelRatio", 2);
		screens.at(-1)!.dispatchEvent(new Event("change"));
		expect(canvas.width).toBe(width * 2);
		// It then watches for the next move, from the new density.
		expect(screens).toHaveLength(2);
	});
	it("retains the studio's holds and symbolic states", () => {
		expect(localTime("Idle", 90)).toBeCloseTo(221 / 60);
		expect(localTime("Waiting", 90)).toBeCloseTo(278 / 60);
		expect(pose("Blocked", 1)).toMatchObject({ body: 0, stemWidth: 7.5, alertDotR: 4.4 });
		expect(pose("Thinking", 2).dots.map((dot) => dot.y)).toEqual([50, 50, 50]);
		expect(pose("Done", 1).strokes).toHaveLength(6);
		expect(pose("Done", 7).strokes).toHaveLength(0);
	});
});
