// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notification, updateNotification } from "../src/ui/notification.ts";

type Effect = {
	element: Element;
	frames: Keyframe[];
	duration: number | undefined;
	cancel: ReturnType<typeof vi.fn>;
	finish: () => void;
};

let effects: Effect[];
let offsets: Map<Element, number>;
let reducedMotion: boolean;
const lifetimes: AbortController[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");

beforeEach(() => {
	effects = [];
	offsets = new Map();
	reducedMotion = false;
	vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
	Object.defineProperty(Element.prototype, "animate", {
		configurable: true,
		value: function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
			let finish = () => {};
			let reject = (_reason: Error) => {};
			const finished = new Promise<Animation>((resolve, fail) => {
				finish = () => resolve(animation);
				reject = fail;
			});
			const cancel = vi.fn(() => {
				offsets.delete(this);
				reject(new Error("Animation cancelled"));
			});
			const animation = { finished, cancel } as unknown as Animation;
			effects.push({ element: this, frames, duration: Number(options.duration), cancel, finish });
			return animation;
		},
	});
});

afterEach(() => {
	for (const lifetime of lifetimes.splice(0)) lifetime.abort();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
	else Reflect.deleteProperty(Element.prototype, "animate");
});

function setup(count = 2) {
	const lifetime = new AbortController();
	lifetimes.push(lifetime);
	const stack = document.createElement("div");
	stack.className = "notification-stack";
	const surfaces = Array.from({ length: count }, () => document.createElement("section"));
	for (const surface of surfaces) {
		surface.hidden = true;
		stack.append(surface);
	}
	document.body.append(stack);
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		const surface = surfaces.find((entry) => entry === this || entry.contains(this));
		const preceding = surface ? surfaces.slice(0, surfaces.indexOf(surface)).filter((entry) => !entry.hidden) : [];
		return new DOMRect(100, 12 + preceding.length * 60 + (offsets.get(surface ?? this) ?? 0), 420, 52);
	});
	const show = (index: number, identity: string, animate = false) => {
		const card = notification("A run did not finish", vi.fn());
		updateNotification(surfaces[index]!, card, identity, lifetime.signal, animate);
		return card;
	};
	const clear = (index: number) => updateNotification(surfaces[index]!, null, undefined, lifetime.signal);
	return { lifetime, stack, surfaces, show, clear };
}

describe("notification motion", () => {
	it("fades in once and preserves the entrance and current dismiss behavior during busy redraws", () => {
		const f = setup(1);
		const dismiss = vi.fn();
		const first = notification("Update", dismiss);
		updateNotification(f.surfaces[0]!, first, "update", f.lifetime.signal);
		expect(effects).toHaveLength(1);
		expect(effects[0]?.frames[0]?.opacity).toBe(0);
		expect(effects[0]?.frames.at(-1)?.opacity).toBe(1);
		updateNotification(f.surfaces[0]!, notification("Update", dismiss, { busy: true }), "update", f.lifetime.signal);
		expect(f.surfaces[0]!.firstElementChild).toBe(first);
		expect(effects).toHaveLength(1);
		expect(effects[0]?.cancel).not.toHaveBeenCalled();
		first.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(dismiss).not.toHaveBeenCalled();
		updateNotification(f.surfaces[0]!, notification("Update", dismiss), "update", f.lifetime.signal);
		first.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(dismiss).toHaveBeenCalledOnce();
	});

	it("removes the real card immediately while an inert ghost fades and the lower card slides up", async () => {
		const f = setup();
		const upper = f.show(0, "upper");
		const lower = f.show(1, "lower");
		upper.querySelector("button")!.id = "upper-dismiss";
		f.clear(0);
		expect(f.surfaces[0]!.hidden).toBe(true);
		expect(f.surfaces[0]!.childElementCount).toBe(0);
		expect(f.stack.querySelectorAll(".notification-card")).toHaveLength(1);
		expect(f.surfaces[1]!.firstElementChild).toBe(lower);
		const ghost = f.stack.querySelector<HTMLElement>(".notification-ghost")!;
		expect(ghost).not.toBeNull();
		expect(ghost.inert).toBe(true);
		expect(ghost.getAttribute("aria-hidden")).toBe("true");
		expect(ghost.querySelector("[id], [data-action]")).toBeNull();
		expect(ghost.style.top).toBe("0px");
		expect(ghost.style.width).toBe("420px");
		const exit = effects.find((effect) => effect.element === ghost)!;
		expect(exit.frames.at(-1)?.opacity).toBe(0);
		const slide = effects.find((effect) => effect.element === f.surfaces[1])!;
		expect(slide.frames[0]?.transform).toBe("translateY(60px)");
		expect(slide.frames.at(-1)?.transform).toBe("translateY(0)");
		exit.finish();
		await Promise.resolve();
		expect(ghost.isConnected).toBe(false);
	});

	it("retargets a surviving card from its current visual position during rapid dismissals", () => {
		const f = setup(3);
		f.show(0, "first");
		f.show(1, "second");
		f.show(2, "third");
		f.clear(0);
		const originalSlide = effects.find((effect) => effect.element === f.surfaces[2])!;
		// The third card is partway through its first 60px upward movement.
		offsets.set(f.surfaces[2]!, 24);
		f.clear(1);
		const slides = effects.filter((effect) => effect.element === f.surfaces[2]);
		expect(originalSlide.cancel).toHaveBeenCalledOnce();
		expect(slides).toHaveLength(2);
		expect(slides[1]?.frames[0]?.transform).toBe("translateY(84px)");
	});

	it("fades queued identities even with identical titles and keeps their exit across a busy redraw", () => {
		const f = setup(1);
		f.show(0, "first");
		const second = f.show(0, "second", true);
		const ghost = f.stack.querySelector<HTMLElement>(".notification-ghost")!;
		const exit = effects.find((effect) => effect.element === ghost)!;
		expect(effects.find((effect) => effect.element === second)?.frames[0]?.opacity).toBe(0);
		updateNotification(
			f.surfaces[0]!,
			notification("A run did not finish", vi.fn(), { busy: true }),
			"second",
			f.lifetime.signal,
		);
		expect(ghost.isConnected).toBe(true);
		expect(exit.cancel).not.toHaveBeenCalled();
		expect(effects).toHaveLength(2);
	});

	it("clears all animation effects and outgoing copies when the owning lifetime ends", () => {
		const f = setup();
		f.show(0, "upper", true);
		f.show(1, "lower", true);
		f.clear(0);
		expect(f.stack.querySelector(".notification-ghost")).not.toBeNull();
		f.lifetime.abort();
		expect(f.stack.querySelector(".notification-ghost")).toBeNull();
		for (const effect of effects) expect(effect.cancel).toHaveBeenCalled();
	});

	it.each(["reduced motion", "missing animation API", "suppressed animation"])(
		"updates immediately with %s",
		(mode) => {
			const f = setup();
			f.show(0, "upper");
			f.show(1, "lower");
			if (mode === "reduced motion") reducedMotion = true;
			if (mode === "missing animation API") Reflect.deleteProperty(Element.prototype, "animate");
			updateNotification(f.surfaces[0]!, null, undefined, f.lifetime.signal, mode !== "suppressed animation");
			expect(f.surfaces[0]!.hidden).toBe(true);
			expect(f.stack.querySelectorAll(".notification-card")).toHaveLength(1);
			expect(f.stack.querySelector(".notification-ghost")).toBeNull();
			expect(effects).toHaveLength(0);
		},
	);
});
