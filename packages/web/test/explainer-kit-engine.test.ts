// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/* The explainer kit's engine (packages/runtime/kits/explainer/engine.js; RUNTIME-INTERFACE-APPS.md §3a), run in a DOM.
 * The file is the runtime's: `save_app` writes it into an explainer's folder as engine.js, and the web hands it to the
 * app's frame with the app's other files, knowing nothing of it. It is tested here because this is where there is a
 * DOM: how long a caption lasts, silent and spoken, that the video starts once and says what is wrong in the page, and
 * that the player speaks the clip of the caption on screen. What it draws is looked at in a browser. */

// From the web package's own folder, where its tests run.
const ENGINE = readFileSync(resolve("../runtime/kits/explainer/engine.js"), "utf8");

interface Segment {
	readonly text: string;
	readonly start: number;
	readonly end: number;
	readonly clip: { readonly src: string; readonly seconds: number } | null;
}
interface Scene {
	say(caption: string, ...animations: unknown[]): Scene;
	box(options: Record<string, unknown>): unknown;
	icon(options: Record<string, unknown>): unknown;
	arrow(from: unknown, to: unknown, options?: Record<string, unknown>): unknown;
	create(thing: unknown, seconds?: number): unknown;
	flow(arrow: unknown, seconds?: number, options?: Record<string, unknown>): unknown;
}
interface Video {
	readonly segments: Segment[];
	readonly total: number;
	part(title: string): void;
	scene(build: (scene: Scene) => void): void;
	start(): void;
}
type Kit = {
	Video: new (root: HTMLElement, options: { title: string }) => Video;
	captionHash: (text: string) => string;
};

// jsdom plays nothing: what the player asks of its audio element is taken down here, and an element told to play
// counts as playing until it is paused or a test ends its clip (`sounding`).
let play: MockInstance<() => Promise<void>>;
let pause: MockInstance<() => void>;
const sounding = new WeakSet<HTMLMediaElement>();

beforeEach(() => {
	// jsdom draws nothing either: an arrow asks its path for its length and its points.
	Object.assign(SVGElement.prototype, {
		getTotalLength: () => 100,
		getPointAtLength: (at: number) => ({ x: at, y: 0 }),
	});
	play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
		sounding.add(this);
	});
	pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
		sounding.delete(this);
	});
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
		return !sounding.has(this);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, "hidden");
	document.body.replaceChildren();
	document.head.replaceChildren();
});

/** The page as the kit writes it, up to the scenes: the stage, the clips, the engine, and the video `V`. */
function page(clips: Record<string, number> = {}): Kit & { V: Video; root: HTMLElement } {
	document.body.innerHTML = `<div id="video"></div>${Object.entries(clips)
		.map(
			([caption, seconds]) =>
				`<audio data-caption="${caption}" data-seconds="${seconds}" preload="none"><source src="data:video/mp4;base64,${caption}"></audio>`,
		)
		.join("")}`;
	new Function(ENGINE)();
	const kit = window as unknown as Kit;
	const root = document.getElementById("video") as HTMLElement;
	return {
		Video: kit.Video,
		captionHash: kit.captionHash,
		V: new kit.Video(root, { title: "How the fee works" }),
		root,
	};
}

/** The player's clock, moved by hand: each frame it draws moves the video on by at most a tenth of a second. */
function clock() {
	let now = 0;
	const frames: FrameRequestCallback[] = [];
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
	return (seconds: number) => {
		for (let step = 0; step < Math.round(seconds * 10); step++) {
			now += 100;
			for (const frame of frames.splice(0)) frame(now);
		}
	};
}
const speakers = () => play.mock.contexts as unknown as HTMLAudioElement[];

const seconds = (segment: Segment | undefined) => Number(((segment?.end ?? 0) - (segment?.start ?? 0)).toFixed(2));

describe("the explainer kit's engine", () => {
	it("keeps everything but Video, C and captionHash to itself", () => {
		page();
		const global = window as unknown as Record<string, unknown>;
		expect(typeof global.Video).toBe("function");
		expect(typeof global.captionHash).toBe("function");
		expect((global.C as Record<string, string>).yellow).toBe("#F7D96F");
		// A scenes.js may name its own things as it likes.
		for (const own of ["NS", "Scene", "Box", "ICONS", "KINDS", "el", "lerp"])
			expect(global[own], own).toBeUndefined();
	});

	it("lets a silent caption last its words, and a spoken one its clip", () => {
		// The clip is named as the engine names the caption.
		const named = page().captionHash;
		const spoken = "Each traveller pays one visible fee: 149 kroner.";
		const { V } = page({ [named(spoken)]: 4.2 });
		V.part("The fee");
		V.scene((s) => {
			s.say(spoken);
			s.say("So four friends see that fee before they commit.");
		});
		V.start();
		expect(V.segments.map((segment) => segment.text)).toEqual([
			spoken,
			"So four friends see that fee before they commit.",
		]);
		// Spoken: the clip and half a second. Silent: nine words at three a second, and half a second.
		expect(seconds(V.segments[0])).toBe(4.7);
		expect(V.segments[0]?.clip).toEqual({ src: `data:video/mp4;base64,${named(spoken)}`, seconds: 4.2 });
		expect(seconds(V.segments[1])).toBe(3.5);
		expect(V.segments[1]?.clip).toBeNull();
		// A caption whose pictures take longer lasts as long as they do.
		const { V: drawn } = page();
		drawn.scene((s) => {
			const shop = s.box({ x: 400, y: 450, label: "Shop" });
			const ada = s.icon({ name: "person", x: 1100, y: 450, label: "Ada" });
			const pays = s.arrow(shop, ada);
			s.say("Paid.", s.create(shop, 2), s.create(ada, 2), s.create(pays, 1), s.flow(pays, 1.5, { count: 2 }));
		});
		drawn.start();
		expect(seconds(drawn.segments[0])).toBeGreaterThan(6.5);
	});

	it("starts once, whoever starts it", () => {
		const { V, root } = page();
		V.part("One");
		V.scene((s) => s.say("A caption."));
		V.part("Two");
		V.scene((s) => s.say("Another."));
		// A scenes.js that starts the video itself, and the page that starts it after.
		V.start();
		V.start();
		expect(root.querySelectorAll(".vp")).toHaveLength(1);
		expect([...root.querySelectorAll(".vp-chip")].map((chip) => chip.textContent)).toEqual(["1One", "2Two"]);
		expect(root.querySelector(".vp-time")?.textContent).toMatch(/^0:00 \/ 0:0\d$/);
	});

	it("says in the page what is wrong, in place of an empty stage", () => {
		const empty = page();
		empty.V.start();
		expect(empty.root.querySelector(".vp-fail")?.textContent).toBe("This video has no scenes yet.");
		// A mistake in scenes.js stops the script: the page says which, with its line.
		const broken = page();
		window.dispatchEvent(
			new ErrorEvent("error", { message: "Uncaught ReferenceError: fee is not defined", lineno: 7 }),
		);
		expect(broken.root.querySelector(".vp-fail")?.textContent).toBe(
			"This video's script has a mistake (line 7): Uncaught ReferenceError: fee is not defined",
		);
		// One wrong word for an icon does not stop the video.
		const { V } = page();
		expect(() =>
			V.scene((s) => s.say("A caption.", s.create(s.icon({ name: "unicorn", x: 800, y: 450 })))),
		).not.toThrow();
	});

	it("speaks the clip of the caption on screen, stops with the video, and can be switched off", async () => {
		const run = clock();
		const first = "Each traveller pays one visible fee: 149 kroner.";
		const named = page().captionHash;
		const { V, root } = page({ [named(first)]: 4.2 });
		V.part("The fee");
		V.scene((s) => {
			s.say(first);
			s.say("A caption with no clip.");
		});
		V.start();
		const voice = root.querySelector<HTMLButtonElement>(".vp-voice") as HTMLButtonElement;
		expect([voice.hidden, voice.textContent, voice.getAttribute("aria-pressed")]).toEqual([
			false,
			"Voice on",
			"true",
		]);
		expect(play).not.toHaveBeenCalled();
		// Play is the member's press. No caption has begun yet, so the speaker is started inside the press all the
		// same, muted, and stopped again: that is what lets a browser play the clips that follow by themselves.
		root.querySelector<HTMLButtonElement>(".vp-big")?.click();
		expect(play).toHaveBeenCalledTimes(1);
		expect([speakers()[0]?.muted, speakers()[0]?.src]).toEqual([true, `data:video/mp4;base64,${named(first)}`]);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakers()[0]?.muted).toBe(false);
		expect(pause).toHaveBeenCalledTimes(1);
		// The caption comes on screen three tenths of a second in: its clip is spoken, by the same element.
		run(0.5);
		expect(root.querySelector(".vp-cc")?.textContent).toBe(first);
		expect(play).toHaveBeenCalledTimes(2);
		expect(speakers()[1]).toBe(speakers()[0]);
		// Pause stops the video and the voice with it; Play picks the caption up again. (The button, not Space: the
		// videos of the tests before this one still listen for keys in this document.)
		root.querySelector<HTMLButtonElement>(".vp-play")?.click();
		expect(pause).toHaveBeenCalledTimes(2);
		expect(root.querySelector(".vp-play")?.textContent).toBe("Play");
		root.querySelector<HTMLButtonElement>(".vp-play")?.click();
		expect(play).toHaveBeenCalledTimes(3);
		// The caption with no clip is read in silence: nothing more is played while it stands.
		run(5);
		expect(root.querySelector(".vp-cc")?.textContent).toBe("A caption with no clip.");
		expect(play).toHaveBeenCalledTimes(3);
		// Switched off, a jump back to the spoken caption speaks nothing; switched on again, it does.
		voice.click();
		expect([voice.textContent, voice.getAttribute("aria-pressed")]).toEqual(["Voice off", "false"]);
		root.querySelector<HTMLButtonElement>(".vp-tick, .vp-chip")?.click();
		run(0.5);
		expect(root.querySelector(".vp-cc")?.textContent).toBe(first);
		expect(play).toHaveBeenCalledTimes(3);
		voice.click();
		expect(play).toHaveBeenCalledTimes(4);
		// The button is drawn; in a video with no clip it is not, though buttons of its kind are flex boxes.
		expect(getComputedStyle(voice).display).toBe("inline-flex");
		const silent = page();
		silent.V.scene((s) => s.say("A caption."));
		silent.V.start();
		const none = silent.root.querySelector<HTMLButtonElement>(".vp-voice") as HTMLButtonElement;
		expect(none.hidden).toBe(true);
		expect(getComputedStyle(none).display).toBe("none");
	});

	it("says the rest of a caption when its clip ran out while the picture stood still, and stops when hidden", async () => {
		const run = clock();
		const first = "Each traveller pays one visible fee: 149 kroner.";
		const named = page().captionHash;
		const { V, root } = page({ [named(first)]: 4.2 });
		V.scene((s) => s.say(first));
		V.start();
		root.querySelector<HTMLButtonElement>(".vp-big")?.click();
		await Promise.resolve();
		await Promise.resolve();
		run(1.3);
		expect(play).toHaveBeenCalledTimes(2);
		const speaker = speakers()[1] as HTMLAudioElement;
		expect(speaker.paused).toBe(false);
		// The page draws no frames for a while (behind another window) and the clip plays on to its end: back on
		// screen the caption is one second in, and its clip is over. The rest is said from where the picture is.
		sounding.delete(speaker);
		run(0.1);
		expect(play).toHaveBeenCalledTimes(3);
		expect(speakers()[2]).toBe(speaker);
		expect(speaker.paused).toBe(false);
		// A browser that will not play is asked again once a second, not on every frame.
		sounding.delete(speaker);
		run(0.5);
		expect(play).toHaveBeenCalledTimes(3);
		run(0.6);
		expect(play).toHaveBeenCalledTimes(4);
		// In the clip's last quarter second, and in the breath after it, nothing is started again.
		run(1.8);
		sounding.delete(speaker);
		run(0.4);
		expect(root.querySelector(".vp-cc")?.textContent).toBe(first);
		expect(play).toHaveBeenCalledTimes(4);
		// The page is hidden: the video stops and the voice with it, and starting it again is the member's.
		const again = page({ [named(first)]: 4.2 });
		again.V.scene((s) => s.say(first));
		again.V.start();
		again.root.querySelector<HTMLButtonElement>(".vp-big")?.click();
		run(1);
		expect(again.root.querySelector(".vp-play")?.textContent).toBe("Pause");
		const told = speakers().at(-1) as HTMLAudioElement;
		expect(told.paused).toBe(false);
		Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
		document.dispatchEvent(new Event("visibilitychange"));
		expect(again.root.querySelector(".vp-play")?.textContent).toBe("Play");
		expect(told.paused).toBe(true);
		const calls = play.mock.calls.length;
		run(1);
		expect(play.mock.calls.length).toBe(calls);
	});
});
