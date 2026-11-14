// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachComputerPlace } from "../src/ui/computer-place.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A thread with the window standing in a row of its log, as conversation.ts lays it out. */
function setup() {
	const stop = new AbortController();
	const body = document.createElement("div"),
		log = document.createElement("div"),
		row = document.createElement("div"),
		panel = document.createElement("aside"),
		canvas = document.createElement("canvas");
	body.className = "thread-body";
	panel.tabIndex = 0;
	panel.append(canvas);
	row.append(panel);
	log.append(row);
	body.append(log);
	document.body.append(body);
	vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
		DOMRect.fromRect({ x: 300, y: 40, width: 900, height: 700 }),
	);
	// The panel, fixed with its box at nothing, lands on the whole window (the stylesheet sets no inset here).
	vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 1280, height: 800 }));
	let resized = () => {};
	const observe = vi.fn(),
		disconnect = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resized = callback;
			}
			observe = observe;
			disconnect = disconnect;
		},
	);
	const fit = attachComputerPlace(panel, stop.signal);
	cleanup.push(() => stop.abort());
	return { body, panel, canvas, stop, observe, disconnect, resized: () => resized(), fit };
}

function pointer(target: HTMLElement, type: string, options: MouseEventInit & { isPrimary?: boolean } = {}) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 610, clientY: 140, ...options });
	Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: options.isPrimary ?? true } });
	target.dispatchEvent(event);
	return event;
}

function key(target: HTMLElement, value: string) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

const box = (panel: HTMLElement) =>
	["top", "left", "right", "bottom"].map((side) => panel.style.getPropertyValue(`--computer-box-${side}`));

describe("the computer's window in its thread", () => {
	it("is not dragged: a press focuses it and leaves the press alone", () => {
		const f = setup();
		const press = pointer(f.canvas, "pointerdown");
		expect(press.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(f.panel);
		pointer(f.canvas, "pointermove", { clientX: 700, clientY: 300 });
		pointer(f.canvas, "pointerup", { clientX: 700, clientY: 300 });
		expect(f.panel.getAttribute("style") ?? "").toBe("");
	});

	it("covers the thread it stands in while entered, following the thread's size, and lets go after", () => {
		const f = setup();
		f.fit();
		expect(box(f.panel)).toEqual(["", "", "", ""]);
		expect(f.observe).not.toHaveBeenCalled();
		f.panel.classList.add("is-entered");
		f.fit();
		expect(box(f.panel)).toEqual(["40px", "300px", "80px", "60px"]);
		expect(f.observe).toHaveBeenCalledWith(f.body);
		vi.mocked(f.body.getBoundingClientRect).mockReturnValue(
			DOMRect.fromRect({ x: 0, y: 40, width: 1280, height: 760 }),
		);
		f.resized();
		expect(box(f.panel)).toEqual(["40px", "0px", "0px", "0px"]);
		f.panel.classList.remove("is-entered");
		f.fit();
		expect(box(f.panel)).toEqual(["", "", "", ""]);
		expect(f.disconnect).toHaveBeenCalled();
	});
});

describe("computer preview pointer focus mark", () => {
	const marked = (panel: HTMLElement) => panel.classList.contains("is-pointer-focus");
	it("marks the focus a press gives the panel, and a key clears it", () => {
		const f = setup();
		pointer(f.panel, "pointerdown");
		expect(document.activeElement).toBe(f.panel);
		expect(marked(f.panel)).toBe(true);
		pointer(f.panel, "pointerup");
		expect(marked(f.panel)).toBe(true);
		key(f.panel, "ArrowLeft");
		expect(marked(f.panel)).toBe(false);
		// Pressing the panel it already holds focus in marks it again at once.
		pointer(f.panel, "pointerdown");
		expect(marked(f.panel)).toBe(true);
		pointer(f.panel, "pointerup");
	});
	it("leaves a later keyboard focus unmarked after a press that moved no focus", () => {
		const f = setup();
		// A right click: focus stays outside.
		pointer(f.panel, "pointerdown", { button: 2 });
		pointer(f.panel, "pointerup", { button: 2 });
		expect(document.activeElement).not.toBe(f.panel);
		f.panel.focus();
		expect(marked(f.panel)).toBe(false);
		f.panel.blur();
		expect(marked(f.panel)).toBe(false);
		// A button in a browser whose buttons take no focus on click, released off the panel.
		const button = document.createElement("button");
		f.panel.append(button);
		pointer(button, "pointerdown");
		expect(document.activeElement).not.toBe(f.panel);
		pointer(document.body, "pointerup", { clientX: 20, clientY: 20 });
		f.panel.focus();
		expect(marked(f.panel)).toBe(false);
	});
	it("marks a button the press focuses and clears the mark when focus leaves the panel", () => {
		const f = setup();
		const button = document.createElement("button");
		f.panel.append(button);
		const outside = document.createElement("button");
		document.body.append(outside);
		pointer(button, "pointerdown");
		button.focus();
		expect(marked(f.panel)).toBe(true);
		pointer(button, "pointerup");
		// Focus moving within the panel keeps the mark; leaving clears it.
		f.panel.focus();
		expect(marked(f.panel)).toBe(true);
		outside.focus();
		expect(marked(f.panel)).toBe(false);
	});
});
