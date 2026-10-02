// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leave, playOnce } from "../src/ui/motion.ts";

/* jsdom has no animation engine. These tests give elements a getAnimations so the helpers
 * take their animated path, and check what they do with the classes and the DOM. */
let running: { playState: string }[] = [];
let reduce = false;
beforeEach(() => {
	running = [];
	reduce = false;
	vi.stubGlobal("matchMedia", () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }));
	Element.prototype.getAnimations = () => running as unknown as Animation[];
});
afterEach(() => {
	delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("playOnce", () => {
	it("adds the class for one play and takes it off when the element's last animation ends", () => {
		const element = document.createElement("div");
		document.body.append(element);
		playOnce(element, "is-arriving");
		expect(element.classList.contains("is-arriving")).toBe(true);
		// A child's animation ending says nothing about the element's own.
		const child = document.createElement("span");
		element.append(child);
		child.dispatchEvent(new Event("animationend", { bubbles: true }));
		expect(element.classList.contains("is-arriving")).toBe(true);
		// One of its own animations still runs: the class stays.
		running = [{ playState: "running" }];
		element.dispatchEvent(new Event("animationend"));
		expect(element.classList.contains("is-arriving")).toBe(true);
		running = [{ playState: "finished" }];
		element.dispatchEvent(new Event("animationend"));
		expect(element.classList.contains("is-arriving")).toBe(false);
	});

	it("plays nothing under reduced motion or without an animation engine", () => {
		const element = document.createElement("div");
		reduce = true;
		playOnce(element, "is-arriving");
		expect(element.classList.contains("is-arriving")).toBe(false);
		reduce = false;
		delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
		playOnce(element, "is-arriving");
		expect(element.classList.contains("is-arriving")).toBe(false);
	});

	it("takes the class off by itself when no animationend comes", () => {
		vi.useFakeTimers();
		const element = document.createElement("div");
		playOnce(element, "is-arriving");
		vi.advanceTimersByTime(5000);
		expect(element.classList.contains("is-arriving")).toBe(false);
	});
});

describe("leave", () => {
	it("removes at once when nothing animates the leaving", () => {
		const element = document.createElement("div");
		document.body.append(element);
		const done = vi.fn();
		leave(element, "is-leaving", done);
		expect(done).toHaveBeenCalledOnce();
	});

	it("holds the element, deaf to the pointer, until its leaving animation ends", () => {
		const element = document.createElement("div");
		document.body.append(element);
		running = [{ playState: "running" }];
		const done = vi.fn();
		leave(element, "is-leaving", done);
		expect(done).not.toHaveBeenCalled();
		expect(element.classList.contains("is-leaving")).toBe(true);
		expect(element.style.pointerEvents).toBe("none");
		element.dispatchEvent(new Event("animationend"));
		element.dispatchEvent(new Event("animationend"));
		expect(done).toHaveBeenCalledOnce();
	});

	it("finishes at once for an element no longer on the page", () => {
		const done = vi.fn();
		running = [{ playState: "running" }];
		leave(document.createElement("div"), "is-leaving", done);
		expect(done).toHaveBeenCalledOnce();
	});
});
