// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localTime, pose } from "../public/assets/avatars/status-2d-v1/motion.mjs";
import { type FigureArtwork, type FigureMotion, loadFigureMotion, mountFigureMotion } from "../src/ui/figure-motion.ts";
import { deferred, settle } from "./fixtures.ts";

// The recorded motion is its own chunk; here it arrives when a test says so.
const motionArrives = vi.hoisted(() => {
	let arrive = () => {};
	const promise = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	return { promise, arrive };
});
vi.mock("../src/ui/figure-motion-data.ts", async (importOriginal) => {
	await motionArrives.promise;
	return importOriginal();
});

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
		"ellipse",
		"stroke",
		"rect",
		"clip",
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
function mount(
	activity: "Idle" | "Working" | "Thinking" | "Waiting" = "Idle",
	identity = "agent",
	options: { ask?: "question" | "bang"; alive?: boolean } = {},
): HTMLElement {
	const host = document.createElement("span");
	document.body.append(host);
	mounted.push(mountFigureMotion(host, "crown", "#fcb51b", artwork, { activity, identity, ...options }));
	return host;
}

describe("before the recorded motion arrives", () => {
	it("shows the still artwork, then plays from the first frame, under reduced motion too", async () => {
		const idle = mount("Idle", "late"),
			still = mount("Working", "late-still");
		await settle();
		show([idle, still]);
		advance(5000);
		for (const host of [idle, still]) {
			expect(host.querySelector<HTMLImageElement>(".figure-fallback")!.hidden).toBe(false);
			expect(host.querySelector("canvas")!.hidden).toBe(true);
		}
		expect(frames.size).toBe(0);
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		motionArrives.arrive();
		await loadFigureMotion();
		await settle();
		// The reduced still is the studio's frame at one second; nothing is scheduled.
		expect(still.querySelector("canvas")!.dataset.frame).toBe("60");
		expect(still.querySelector<HTMLImageElement>(".figure-fallback")!.hidden).toBe(true);
		expect(frames.size).toBe(0);
		reduced.matches = false;
		reduced.dispatchEvent(new Event("change"));
		// The clock did not run while the motion was on its way.
		expect(idle.querySelector("canvas")!.dataset.frame).toBe("0");
		advance(1000);
		expect(idle.querySelector("canvas")!.dataset.frame).toBe("60");
		// The working figure goes on with its act: it bounces under its stars.
		const poses = new Set<string>();
		for (let frame = 0; frame < 420; frame++) {
			advance(1000 / 60);
			poses.add(still.querySelector("canvas")!.style.transform);
		}
		expect([...poses].some((pose) => /^translate\(0%, -\d/.test(pose))).toBe(true);
	});
});

describe("2D studio playback in the shell", () => {
	beforeAll(async () => {
		// Also when these tests run without the one above.
		motionArrives.arrive();
		await loadFigureMotion();
	});
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
	it("makes a figure that needs the member jump, spin and become its question, and keep asking", async () => {
		const host = mount("Waiting", "asks", { ask: "question" });
		await settle();
		show([host]);
		const canvas = host.querySelector("canvas")!;
		vi.mocked(context.arc!).mockClear();
		// In the air it turns edge on: thin, and off the ground.
		advance(16);
		advance(284);
		expect(canvas.style.transform).toMatch(/^translate\(0%, -\d[\d.]*%\) rotate\(0deg\) scale\(0\.[1-6]/);
		// Down again, as the symbol: the question mark's hook and its dot are arcs, drawn in the figure's colour.
		advance(700);
		advance(16);
		expect(canvas.style.transform).toBe("");
		expect(context.arc).toHaveBeenCalled();
		expect(context.fillStyle).toBe("#fcb51b");
		// It keeps asking: the frames go on, and the symbol hops or rocks within a few seconds.
		const poses = new Set<string>();
		for (let frame = 0; frame < 240; frame++) {
			advance(1000 / 60);
			poses.add(canvas.style.transform);
		}
		expect(poses.size).toBeGreaterThan(5);
		expect(frames.size).toBe(1);
		// A member who wants no motion sees the symbol at rest.
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		expect(canvas.style.transform).toBe("");
		advance(1000);
		expect(frames.size).toBe(0);
	});
	it("cheers once when asked to, smiling, and comes back to rest", async () => {
		const host = mount("Idle", "cheers");
		await settle();
		show([host]);
		advance(5000);
		expect(frames.size).toBe(0);
		const canvas = host.querySelector("canvas")!;
		vi.mocked(context.ellipse!).mockClear();
		mounted[mounted.length - 1]!.play("cheer");
		expect(frames.size).toBe(1);
		advance(16);
		advance(300);
		expect(canvas.style.transform).toMatch(/^translate\(0%, -\d/);
		// The smile is an arch, not a pill.
		expect(context.ellipse).toHaveBeenCalled();
		advance(3400);
		advance(16);
		expect(canvas.style.transform).toBe("");
		// The opening blink plays after the cheer, then the figure rests.
		advance(5000);
		expect(frames.size).toBe(0);
		expect(canvas.dataset.frame).toBe("221");
	});
	it("lets an idle figure that is alive move again by itself, and leaves the others still", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const alive = mount("Idle", "alive", { alive: true }),
				quiet = mount("Idle", "quiet");
			await settle();
			show([alive, quiet]);
			advance(5000);
			expect(frames.size).toBe(0);
			// Its next move is due within half a minute of the opening blink; a timer wakes it.
			now += 30_000;
			vi.advanceTimersByTime(30_000);
			expect(frames.size).toBe(1);
			advance(16);
			advance(16);
			expect(frames.size).toBe(1);
			expect(quiet.querySelector("canvas")!.dataset.frame).toBe("221");
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps a working figure itself, juggling three stars, the same in every view of the agent", async () => {
		const rail = mount("Working", "at-work"),
			thread = mount("Working", "at-work");
		// Large enough to show its stars.
		for (const host of [rail, thread]) host.style.width = "50px";
		await settle();
		show([rail, thread]);
		const canvas = rail.querySelector("canvas")!;
		vi.mocked(context.roundRect!).mockClear();
		const poses = new Set<string>();
		for (let frame = 0; frame < 180; frame++) {
			advance(1000 / 60);
			poses.add(canvas.style.transform);
			// Two views of one agent show the same pose.
			expect(canvas.style.transform).toBe(thread.querySelector("canvas")!.style.transform);
		}
		// It bounces from side to side, and its eyes (drawn pills) are there the whole time.
		expect([...poses].some((pose) => /rotate\(-[1-9]/.test(pose))).toBe(true);
		expect([...poses].some((pose) => /rotate\([1-9]/.test(pose))).toBe(true);
		expect(context.roundRect).toHaveBeenCalled();
		// Three stars over it, each placed by its own transform, all out by now.
		const stars = [...rail.querySelectorAll<HTMLElement>(".figure-prop")];
		expect(stars).toHaveLength(3);
		expect(stars.every((star) => /^translate\(.*scale\(1\)$/.test(star.style.transform))).toBe(true);
		// In the cascade no star is behind the figure.
		expect(stars.some((star) => star.classList.contains("is-behind"))).toBe(false);
		expect(new Set(stars.map((star) => star.style.transform)).size).toBe(3);
		// It goes on working past any length of time.
		advance(60_000);
		expect(frames.size).toBe(1);
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
		const motion = mountFigureMotion(host, "moon", "#312f2d", artwork);
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
	it("draws the body and the eyes from surfaces at most twice the painted side", async () => {
		const host = mount("Idle", "levels");
		await settle();
		context.drawImage!.mockClear();
		show([host]);
		advance(16);
		const side = host.querySelector("canvas")!.width;
		// The body: a whole surface onto the figure's 100 units.
		const body = context.drawImage!.mock.calls.filter((call) => call.slice(1).join() === "0,0,100,100");
		expect(body).toHaveLength(1);
		// A 512px surface drawn there in one step would turn jagged (figure-levels.ts).
		expect((body[0]![0] as HTMLCanvasElement).width).toBeGreaterThanOrEqual(side);
		expect((body[0]![0] as HTMLCanvasElement).width).toBeLessThanOrEqual(side * 2);
		// The eyes, drawn last: their box, at the body's level, onto the part of the figure the box covers.
		const eyes = context.drawImage!.mock.calls.filter((call) => call.length === 9).at(-1)!;
		const [, , , width, height, x, y, toWidth, toHeight] = eyes as number[];
		const level = Math.min(512, 2 ** Math.ceil(Math.log2(Math.max(32, side))));
		expect([toWidth! / 100, toHeight! / 100]).toEqual([width! / level, height! / level]);
		// The box holds both drawn eyes (at 55 and 69 across, 55 and 54 down) and little else.
		expect(x! / 100).toBeLessThanOrEqual(0.52);
		expect((x! + toWidth!) / 100).toBeGreaterThanOrEqual(0.72);
		expect(y! / 100).toBeLessThanOrEqual(0.52);
		expect((y! + toHeight!) / 100).toBeGreaterThanOrEqual(0.57);
		expect(toWidth! / 100).toBeLessThanOrEqual(0.5);
		expect(width).toBeLessThanOrEqual(side * 2);
	});
	it("cuts the eyes in the layer's own pixels at the 512px level, where nothing is halved", async () => {
		let resized: ResizeObserverCallback | undefined;
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: ResizeObserverCallback) {
					resized = callback;
				}
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		vi.stubGlobal("devicePixelRatio", 3);
		const host = mount("Idle", "large");
		await settle();
		show([host]);
		for (const fn of Object.values(context)) if (typeof fn?.mockClear === "function") fn.mockClear();
		// 120 CSS px at 3x: a side above 256, so the body's level and the eye layer are 512 (repainted at once).
		resized!([{ target: host, contentRect: { width: 120 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
		expect(host.querySelector("canvas")!.width).toBeGreaterThan(256);
		// The eye layer was drawn under 5.12x and its box's offset; the clip and the cut must not be.
		const order = (fn: (typeof context)[string]) => fn.mock.invocationCallOrder;
		const clip = order(context.clip!).at(-1)!;
		const save = order(context.save!)
			.filter((at) => at < clip)
			.at(-1)!;
		const resets = context
			.setTransform!.mock.calls.map((args, index) => [args.join(), order(context.setTransform!)[index]!] as const)
			.filter(([args, at]) => args === "1,0,0,1,0,0" && at > save && at < clip);
		expect(resets).toHaveLength(1);
		expect(context.rect).toHaveBeenLastCalledWith(0, 0, expect.any(Number), expect.any(Number));
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
