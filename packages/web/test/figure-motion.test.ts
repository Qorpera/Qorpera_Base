// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localTime, pose } from "../public/assets/avatars/status-2d-v1/motion.mjs";
import { writingAsk } from "../src/ui/figure-acts.ts";
import { level } from "../src/ui/figure-levels.ts";
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
context.createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
context.createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
context.bezierCurveTo = vi.fn();
context.getImageData = vi.fn(() => {
	const data = new Uint8ClampedArray(100 * 100 * 4);
	for (let y = 0; y < 100; y++)
		for (let x = 0; x < 100; x++) if ((x - 50) ** 2 + (y - 55) ** 2 < 35 ** 2) data[(y * 100 + x) * 4 + 3] = 255;
	return { data };
});
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
	activity: "Idle" | "Working" | "Thinking" | "Waiting" | "AtComputer" = "Idle",
	identity = "agent",
	options: { ask?: "question" | "bang"; alive?: boolean } = {},
): HTMLElement {
	const host = document.createElement("span");
	document.body.append(host);
	mounted.push(mountFigureMotion(host, "crown", "#fcb51b", artwork, { activity, identity, ...options }));
	return host;
}

describe("before the recorded motion arrives", () => {
	it("leaves its place empty, never in the still artwork's old colour, then fades in and plays from the first frame, under reduced motion too", async () => {
		const idle = mount("Idle", "late"),
			still = mount("Working", "late-still");
		await settle();
		show([idle, still]);
		advance(5000);
		for (const host of [idle, still]) {
			expect(host.querySelector<HTMLImageElement>(".figure-fallback")!.hidden).toBe(true);
			expect(host.querySelector("canvas")!.hidden).toBe(true);
			expect(host.querySelector("canvas")!.dataset.arrive).toBe("");
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
		vi.mocked(context.stroke!).mockClear();
		for (let frame = 0; frame < 600; frame++) advance(1000 / 60);
		expect(context.stroke).toHaveBeenCalled();
		expect(still.querySelectorAll(".figure-air")).toHaveLength(2);
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
		// In the air it turns edge on: thin, and off the ground. (The act plays at 0.85 of its own pace: 0.3 s of
		// it is 0.35 s on the clock.)
		advance(16);
		advance(336);
		expect(canvas.style.transform).toMatch(/^translate\(0%, -\d[\d.]*%\) rotate\(0deg\) scale\(0\.[1-6]/);
		// Down again, as the symbol: the question mark's hook and its dot are arcs, drawn in the figure's colour.
		advance(760);
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
	it("keeps what waits on the member in sight while the figure writes, and at rest for a member who wants no motion", async () => {
		// The symbols are drawn with these: the question mark's dot, the exclamation mark's stem.
		const questionDot = () => vi.mocked(context.arc!).mock.calls.some((call) => call[0] === 50.5 && call[2] === 9.3);
		const bangStem = () =>
			vi.mocked(context.roundRect!).mock.calls.some((call) => call[0] === 41.25 && call[2] === 17.5);
		const writing = mount("Thinking", "writes-and-asks", { ask: "question" });
		await settle();
		show([writing]);
		vi.mocked(context.arc!).mockClear();
		// It writes first: its dots, no symbol.
		for (let frame = 0; frame < 120; frame++) advance(1000 / 60);
		expect(questionDot()).toBe(false);
		// A few seconds on the dots have become the question mark, in the figure's colour.
		for (let frame = 0; frame < 330; frame++) advance(1000 / 60);
		expect(questionDot()).toBe(true);
		expect(context.fillStyle).toBe("#fcb51b");
		// A writing figure with nothing waiting never draws one.
		const plain = mount("Thinking", "only-writes");
		await settle();
		show([writing], false);
		show([plain]);
		vi.mocked(context.arc!).mockClear();
		for (let frame = 0; frame < 600; frame++) advance(1000 / 60);
		expect(questionDot()).toBe(false);
		// No motion: the symbol stands in place of a working figure and of a writing one, with no stars beside it.
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		advance(1000);
		const working = mount("Working", "works-and-asks", { ask: "bang" });
		working.style.width = "50px";
		await settle();
		vi.mocked(context.roundRect!).mockClear();
		vi.mocked(context.arc!).mockClear();
		show([working, writing]);
		expect(bangStem()).toBe(true);
		expect(questionDot()).toBe(true);
		expect(working.querySelector(".figure-air")).toBeNull();
		const busy = mount("Working", "only-works");
		await settle();
		vi.mocked(context.roundRect!).mockClear();
		show([busy]);
		expect(bangStem()).toBe(false);
		expect(busy.querySelector(".figure-air")).toBeNull();
	});
	it("keeps what waits on the member in sight while the figure uses its computer, at rest too (20260930742000)", async () => {
		const questionDot = () => vi.mocked(context.arc!).mock.calls.some((call) => call[0] === 50.5 && call[2] === 9.3);
		const bangStem = () =>
			vi.mocked(context.roundRect!).mock.calls.some((call) => call[0] === 41.25 && call[2] === 17.5);
		const lit = () => vi.mocked(context.createRadialGradient!).mock.calls.length > 0;
		const asking = mount("AtComputer", "uses-and-asks", { ask: "question" });
		await settle();
		show([asking]);
		vi.mocked(context.arc!).mockClear();
		vi.mocked(context.createRadialGradient!).mockClear();
		// It uses its computer first: lit by its screen, no symbol.
		for (let frame = 0; frame < 120; frame++) advance(1000 / 60);
		expect(questionDot()).toBe(false);
		expect(lit()).toBe(true);
		// A few seconds on it has become its question for a moment, unlit.
		for (let frame = 0; frame < 270; frame++) advance(1000 / 60);
		expect(questionDot()).toBe(true);
		// With nothing waiting it never draws a symbol.
		const plain = mount("AtComputer", "only-uses");
		await settle();
		show([asking], false);
		show([plain]);
		vi.mocked(context.arc!).mockClear();
		for (let frame = 0; frame < 600; frame++) advance(1000 / 60);
		expect(questionDot()).toBe(false);
		// No motion: the symbol stands in its place.
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		advance(1000);
		const approval = mount("AtComputer", "uses-and-waits", { ask: "bang" });
		await settle();
		vi.mocked(context.roundRect!).mockClear();
		show([approval]);
		expect(bangStem()).toBe(true);
		expect(frames.size).toBe(0);
	});
	it("shows the ask's symbol at its computer in every frame writingAsk shows it, and the lit figure in every other (review r4 F1)", async () => {
		const symbolDrawn = (ask: "question" | "bang") =>
			ask === "question"
				? vi.mocked(context.arc!).mock.calls.some((call) => call[0] === 50.5 && call[2] === 9.3)
				: vi.mocked(context.roundRect!).mock.calls.some((call) => call[0] === 41.25 && call[2] === 17.5);
		const lit = () => vi.mocked(context.createRadialGradient!).mock.calls.length > 0;
		const step = 1000 / 60;
		for (const ask of ["question", "bang"] as const) {
			const host = mount("AtComputer", `cycle-${ask}`, { ask });
			await settle();
			show([host]);
			// What the figure shows now, as its last paint left it.
			let shown: "symbol" | "figure" | undefined;
			let t = 0;
			const checked = { symbol: 0, figure: 0 };
			// One whole cycle of the ask and a little more: spell, hop in, hold (at rest too), hop out.
			for (let frame = 0; frame < 10.5 * 60; frame++) {
				vi.mocked(context.arc!).mockClear();
				vi.mocked(context.roundRect!).mockClear();
				vi.mocked(context.createRadialGradient!).mockClear();
				advance(step);
				t += step / 1000;
				if (symbolDrawn(ask)) shown = "symbol";
				else if (lit() || vi.mocked(context.drawImage!).mock.calls.length) shown = "figure";
				vi.mocked(context.drawImage!).mockClear();
				const expected = writingAsk(t, ask).symbol ? "symbol" : "figure";
				// A frame on either side of a change may land on the other side of it.
				const near = [-2, -1, 1, 2].some(
					(n) => (writingAsk(t + (n * step) / 1000, ask).symbol ? "symbol" : "figure") !== expected,
				);
				if (near || shown === undefined) continue;
				expect({ t: t.toFixed(3), shown }).toEqual({ t: t.toFixed(3), shown: expected });
				checked[expected]++;
			}
			// The cycle had both, and the symbol's hold at rest (about 6.2 to 8.5 s in) was among them.
			expect(checked.symbol).toBeGreaterThan(120);
			expect(checked.figure).toBeGreaterThan(240);
			show([host], false);
		}
		// No motion: the symbol alone, for a question and an approval, and nothing scheduled.
		reduced.matches = true;
		reduced.dispatchEvent(new Event("change"));
		advance(1000);
		for (const ask of ["question", "bang"] as const) {
			const host = mount("AtComputer", `still-${ask}`, { ask });
			await settle();
			vi.mocked(context.arc!).mockClear();
			vi.mocked(context.roundRect!).mockClear();
			vi.mocked(context.createRadialGradient!).mockClear();
			show([host]);
			expect(symbolDrawn(ask)).toBe(true);
			expect(lit()).toBe(false);
			expect(frames.size).toBe(0);
			show([host], false);
		}
	});
	it("shows a figure that was out of view none of the effects it missed", async () => {
		// The effects are elements with an animation each; here an animation never ends, so they can be counted.
		HTMLElement.prototype.animate = vi.fn(() => ({
			onfinish: null,
			oncancel: null,
		})) as unknown as HTMLElement["animate"];
		try {
			const rail = mount("Waiting", "asks-twice", { ask: "bang" }),
				card = mount("Waiting", "asks-twice", { ask: "bang" });
			await settle();
			show([rail, card]);
			const effects = (host: HTMLElement) => host.querySelectorAll(".figure-bit").length;
			for (let frame = 0; frame < 90; frame++) advance(1000 / 60);
			// Both showed the same: the stars of the change and the dust of its landing.
			expect(effects(rail)).toBeGreaterThan(0);
			expect(effects(card)).toBe(effects(rail));
			// The card scrolls away; the rail's figure keeps their clock going for minutes.
			show([card], false);
			const before = effects(card);
			for (let frame = 0; frame < 60 * 180; frame++) advance(1000 / 60);
			expect(effects(rail)).toBeGreaterThan(before + 20);
			// Back in view: nothing it missed goes off, and from here it shows what the rail shows.
			const railThen = effects(rail);
			show([card]);
			advance(1000 / 60);
			expect(effects(card)).toBe(before);
			for (let frame = 0; frame < 60 * 12; frame++) advance(1000 / 60);
			expect(effects(card) - before).toBe(effects(rail) - railThen);
			// A frame that comes very late sets off nothing either.
			const late = effects(rail);
			advance(120_000);
			expect(effects(rail)).toBe(late);
		} finally {
			Reflect.deleteProperty(HTMLElement.prototype, "animate");
		}
	});
	it("lets no cheer on a figure out of view stop the agent's other views, and drops it when it comes too late", async () => {
		const header = mount("Idle", "shared-idle"),
			row = mount("Idle", "shared-idle");
		await settle();
		// Only the header is on screen; the row's figure is asked to cheer while it is out of view.
		show([header]);
		mounted[mounted.length - 1]!.play("cheer");
		for (let frame = 0; frame < 60 * 5; frame++) advance(1000 / 60);
		// The header's figure played its opening (2.2 s, to the studio's frame 132) and rests: the clock ran, and no
		// frame is asked for any more.
		expect(header.querySelector("canvas")!.dataset.frame).toBe("132");
		expect(frames.size).toBe(0);
		// The row comes into view long after: no late cheer.
		show([row]);
		advance(1000 / 60);
		advance(1000 / 60);
		expect(row.querySelector("canvas")!.style.transform).toBe("");
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
	it("keeps a working figure itself while a thread passes round it, behind and in front, the same in every view", async () => {
		const rail = mount("Working", "at-work"),
			thread = mount("Working", "at-work");
		for (const host of [rail, thread]) host.style.width = "50px";
		await settle();
		show([rail, thread]);
		vi.mocked(context.roundRect!).mockClear();
		vi.mocked(context.stroke!).mockClear();
		for (let frame = 0; frame < 600; frame++) {
			advance(1000 / 60);
			expect(rail.querySelector("canvas")!.style.transform).toBe("");
			expect(thread.querySelector("canvas")!.style.transform).toBe("");
		}
		expect(context.roundRect).toHaveBeenCalled();
		expect(context.stroke).toHaveBeenCalled();
		const air = [...rail.querySelectorAll<HTMLCanvasElement>(".figure-air")];
		expect(air).toHaveLength(2);
		expect(air.filter((canvas) => canvas.classList.contains("is-behind"))).toHaveLength(1);
		advance(60_000);
		expect(frames.size).toBe(1);
	});
	it("does a working figure's frame at most 60 times a second on a faster screen, and every one of them at 90 Hz", async () => {
		const host = mount("Working", "fast-screen");
		await settle();
		show([host]);
		advance(1000 / 60);
		const canvas = host.querySelector("canvas")!;
		const drawn = (step: number) => {
			canvas.dataset.frame = "unpainted";
			advance(step);
			return canvas.dataset.frame !== "unpainted";
		};
		expect(drawn(6)).toBe(false);
		expect(drawn(6)).toBe(false);
		expect(frames.size).toBe(1);
		expect(drawn(6)).toBe(true);
		const framesPerSecond = (hz: number) => {
			advance(1000);
			let count = 0;
			for (let refresh = 0; refresh < hz; refresh++) if (drawn(1000 / hz)) count++;
			return count;
		};
		expect(framesPerSecond(60)).toBe(60);
		for (const hz of [75, 90, 100, 120, 144, 165, 240]) {
			const count = framesPerSecond(hz);
			expect(count).toBeGreaterThanOrEqual(59);
			expect(count).toBeLessThanOrEqual(62);
		}
	});
	for (const start of [1, 8, 15.5, 16.5])
		it(`draws every refresh of a screen a little faster than 60 Hz when the first comes ${start} ms after the figure starts`, async () => {
			const host = mount("Working", `drifting-screen-${start}`);
			await settle();
			show([host]);
			const canvas = host.querySelector("canvas")!;
			let missed = 0;
			for (const [index, step] of [start, ...Array<number>(600).fill(16.65)].entries()) {
				canvas.dataset.frame = "unpainted";
				advance(step);
				if (index > 0 && canvas.dataset.frame === "unpainted") missed++;
			}
			expect(missed).toBe(0);
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
	it("draws a view built anew at once when its artwork in that colour is here, and keeps a new colour's place empty until it is", async () => {
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
		const resize = (target: HTMLElement, width: number) =>
			resized!([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
		const first = mount("Idle", "rebuilt");
		await settle();
		show([first]);
		advance(1000);
		// A row built anew: drawn before the browser shows it, with no fade, no old-colour still and no frame advanced.
		const rebuilt = mount("Idle", "rebuilt");
		const canvas = rebuilt.querySelector("canvas")!;
		expect(canvas.hidden).toBe(false);
		expect(canvas.dataset.arrive).toBeUndefined();
		expect(canvas.dataset.frame).toBe("60");
		expect(rebuilt.querySelector<HTMLImageElement>(".figure-fallback")!.hidden).toBe(true);
		// It moves only once it is known to be in view; the view it replaces goes on.
		advance(500);
		expect(canvas.dataset.frame).toBe("60");
		expect(first.querySelector("canvas")!.dataset.frame).toBe("90");
		// Its size, reported before the browser shows it and before any visibility report, redraws it at that size.
		resize(rebuilt, 100);
		expect(canvas.width).toBe(112);
		// Once it is known to be out of view, a new size waits until it is back.
		show([rebuilt], false);
		resize(rebuilt, 60);
		expect(canvas.width).toBe(112);
		show([rebuilt]);
		expect(canvas.width).toBe(67);
		// The same figure in a colour not prepared yet: empty, then it fades in, in that colour.
		const host = document.createElement("span");
		document.body.append(host);
		mounted.push(mountFigureMotion(host, "crown", "#2047bd", artwork, { identity: "recoloured" }));
		expect(host.querySelector("canvas")!.hidden).toBe(true);
		expect(host.querySelector<HTMLImageElement>(".figure-fallback")!.hidden).toBe(true);
		await settle();
		show([host]);
		expect(host.querySelector("canvas")!.hidden).toBe(false);
		expect(host.querySelector("canvas")!.dataset.arrive).toBe("");
		expect(context.fillStyle).toBe("#2047bd");
		// The fade is the figure's own: its end reaches no view around it, and it plays once.
		const heard = vi.fn();
		host.addEventListener("animationend", heard);
		host.querySelector("canvas")!.dispatchEvent(new Event("animationend", { bubbles: true }));
		expect(heard).not.toHaveBeenCalled();
		expect(host.querySelector("canvas")!.dataset.arrive).toBeUndefined();
		// A fade cut short (its panel hidden mid-way) does not play again either.
		const other = document.createElement("span");
		document.body.append(other);
		mounted.push(mountFigureMotion(other, "crown", "#0fbd59", artwork, { identity: "cut-short" }));
		await settle();
		other.querySelector("canvas")!.dispatchEvent(new Event("animationcancel", { bubbles: true }));
		expect(other.querySelector("canvas")!.dataset.arrive).toBeUndefined();
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
	it("evicts oldest mipmap canvases past 128 and zeroes their backing store", () => {
		const source = document.createElement("canvas");
		source.width = source.height = 512;
		const first = level("lru-test-0", source, 64) as HTMLCanvasElement;
		expect(first.width).toBe(64);
		for (let idx = 1; idx <= 130; idx++) {
			level(`lru-test-${idx}`, source, 64);
		}
		expect(first.width).toBe(0);
		expect(first.height).toBe(0);
	});
	it("zeroes canvas dimensions when a mounted figure is disposed", async () => {
		const host = mount("Idle", "dispose-zero");
		await settle();
		show([host]);
		const canvas = host.querySelector("canvas")!;
		expect(canvas.width).toBeGreaterThan(0);
		mounted.pop()!.dispose();
		expect(canvas.width).toBe(0);
		expect(canvas.height).toBe(0);
	});
});
