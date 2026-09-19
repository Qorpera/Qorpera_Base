// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachComputerDrag } from "../src/ui/computer-drag.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setup() {
	const stop = new AbortController();
	const parent = document.createElement("section"),
		panel = document.createElement("aside"),
		canvas = document.createElement("canvas"),
		header = document.createElement("header"),
		composer = document.createElement("footer");
	panel.tabIndex = 0;
	header.className = "thread-header";
	composer.className = "composer";
	panel.append(canvas);
	parent.append(header, panel, composer);
	document.body.append(parent);
	const size = { width: 1000, height: 700, panelWidth: 400, panelHeight: 225 };
	const width = () =>
		Math.min(size.panelWidth, Number.parseFloat(panel.style.getPropertyValue("--computer-width")) || size.panelWidth);
	const height = () => Math.min(size.panelHeight, (width() * 9) / 16);
	Object.defineProperties(parent, {
		clientWidth: { get: () => size.width },
		clientHeight: { get: () => size.height },
	});
	Object.defineProperties(panel, {
		offsetWidth: { get: width },
		offsetHeight: { get: height },
	});
	vi.spyOn(parent, "getBoundingClientRect").mockImplementation(() => new DOMRect(100, 50, size.width, size.height));
	vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 1000, 50));
	vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 650, 1000, 100));
	vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
		() =>
			new DOMRect(
				100 + (Number.parseFloat(panel.style.getPropertyValue("--computer-left")) || 500),
				50 + (Number.parseFloat(panel.style.getPropertyValue("--computer-top")) || 80),
				width(),
				height(),
			),
	);
	const captured = new Set<number>();
	panel.setPointerCapture = vi.fn((id: number) => {
		captured.add(id);
	});
	panel.hasPointerCapture = vi.fn((id: number) => captured.has(id));
	panel.releasePointerCapture = vi.fn((id: number) => {
		captured.delete(id);
	});
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
	const fit = attachComputerDrag(panel, stop.signal);
	cleanup.push(() => stop.abort());
	return {
		panel,
		canvas,
		parent,
		header,
		composer,
		size,
		stop,
		observe,
		disconnect,
		resize: (target?: Element) => {
			if (!target || observe.mock.calls.some(([element]) => element === target)) resized();
		},
		fit,
	};
}

function pointer(
	target: HTMLElement,
	type: string,
	options: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {},
) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 610, clientY: 140, ...options });
	Object.defineProperties(event, {
		pointerId: { value: options.pointerId ?? 1 },
		isPrimary: { value: options.isPrimary ?? true },
	});
	target.dispatchEvent(event);
	return event;
}

function key(target: HTMLElement, value: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
	target.dispatchEvent(event);
	return event;
}

describe("computer preview dragging", () => {
	it("captures the preview before desktop input and waits for a four-pixel movement", () => {
		const f = setup(),
			desktopDown = vi.fn(),
			desktopMove = vi.fn();
		f.canvas.addEventListener("pointerdown", desktopDown);
		f.canvas.addEventListener("pointermove", desktopMove);
		expect(pointer(f.canvas, "pointerdown").defaultPrevented).toBe(true);
		expect(desktopDown).not.toHaveBeenCalled();
		expect(f.panel.setPointerCapture).toHaveBeenCalledWith(1);
		expect(document.activeElement).toBe(f.panel);
		expect(pointer(f.canvas, "pointermove", { clientX: 613 }).defaultPrevented).toBe(true);
		expect(desktopMove).not.toHaveBeenCalled();
		expect(f.panel.classList.contains("is-dragging")).toBe(false);
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("");
		expect(pointer(f.canvas, "pointermove", { clientX: 614 }).defaultPrevented).toBe(true);
		expect(desktopMove).not.toHaveBeenCalled();
		expect(f.panel.classList.contains("is-dragging")).toBe(true);
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("504px");
		expect(pointer(f.panel, "pointerup").defaultPrevented).toBe(true);
		expect(f.panel.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
		expect(f.panel.classList.contains("is-dragging")).toBe(false);
	});
	it("keeps the preview within thread edges, below the header and above the composer", () => {
		const f = setup();
		pointer(f.canvas, "pointerdown");
		pointer(f.panel, "pointermove", { clientX: -1000, clientY: -1000 });
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("8px");
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("58px");
		pointer(f.panel, "pointermove", { clientX: 3000, clientY: 3000 });
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("592px");
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("367px");
	});
	it.each(["pointercancel", "lostpointercapture", "abort"])(
		"releases dragging on %s and ignores later movement",
		(ending) => {
			const f = setup();
			pointer(f.canvas, "pointerdown");
			pointer(f.panel, "pointermove", { clientX: 620 });
			if (ending === "abort") f.stop.abort();
			else pointer(f.panel, ending);
			expect(f.panel.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
			expect(f.panel.classList.contains("is-dragging")).toBe(false);
			pointer(f.panel, "pointermove", { clientX: 700 });
			expect(f.panel.style.getPropertyValue("--computer-left")).toBe("510px");
			if (ending === "abort") {
				expect(f.disconnect).toHaveBeenCalledOnce();
				pointer(f.canvas, "pointerdown");
				expect(f.panel.setPointerCapture).toHaveBeenCalledTimes(1);
			}
		},
	);
	it.each(["pointercancel", "lostpointercapture"])(
		"ignores %s for a different pointer and keeps dragging",
		(ending) => {
			const f = setup();
			pointer(f.canvas, "pointerdown");
			pointer(f.panel, "pointermove", { clientX: 620 });
			pointer(f.panel, ending, { pointerId: 2 });
			expect(f.panel.releasePointerCapture).not.toHaveBeenCalled();
			expect(f.panel.classList.contains("is-dragging")).toBe(true);
			pointer(f.panel, "pointermove", { clientX: 630 });
			expect(f.panel.style.getPropertyValue("--computer-left")).toBe("520px");
			pointer(f.panel, ending);
			expect(f.panel.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
			expect(f.panel.classList.contains("is-dragging")).toBe(false);
		},
	);
	it("leaves controls, nonprimary pointers and secondary buttons alone", () => {
		const f = setup(),
			button = document.createElement("button"),
			icon = document.createElement("span");
		button.append(icon);
		f.panel.append(button);
		expect(pointer(icon, "pointerdown").defaultPrevented).toBe(false);
		expect(pointer(f.canvas, "pointerdown", { isPrimary: false }).defaultPrevented).toBe(false);
		expect(pointer(f.canvas, "pointerdown", { button: 2 }).defaultPrevented).toBe(false);
		expect(f.panel.setPointerCapture).not.toHaveBeenCalled();
		pointer(f.canvas, "pointerdown");
		pointer(f.panel, "pointermove", { pointerId: 2, clientX: 800 });
		pointer(f.panel, "pointerup", { pointerId: 2 });
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("");
		expect(f.panel.releasePointerCapture).not.toHaveBeenCalled();
	});
	it("does not drag or move by keyboard while entered or fullscreen", () => {
		const f = setup();
		f.panel.classList.add("is-entered");
		expect(pointer(f.canvas, "pointerdown").defaultPrevented).toBe(false);
		expect(key(f.panel, "ArrowLeft").defaultPrevented).toBe(false);
		f.panel.classList.remove("is-entered");
		const original = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
		Object.defineProperty(document, "fullscreenElement", { configurable: true, value: f.canvas });
		try {
			expect(pointer(f.canvas, "pointerdown").defaultPrevented).toBe(false);
			expect(key(f.panel, "ArrowLeft").defaultPrevented).toBe(false);
		} finally {
			if (original) Object.defineProperty(document, "fullscreenElement", original);
			else Reflect.deleteProperty(document, "fullscreenElement");
		}
		expect(f.panel.setPointerCapture).not.toHaveBeenCalled();
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("");
		pointer(f.canvas, "pointerdown");
		f.panel.classList.add("is-entered");
		pointer(f.panel, "pointermove", { clientX: 620 });
		expect(f.panel.releasePointerCapture).toHaveBeenCalledOnce();
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("");
	});
	it("moves only from panel arrow keys, with larger Shift steps and no typing interference", () => {
		const f = setup();
		expect(key(f.panel, "ArrowRight").defaultPrevented).toBe(true);
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("510px");
		expect(key(f.panel, "ArrowDown", { shiftKey: true }).defaultPrevented).toBe(true);
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("130px");
		key(f.panel, "ArrowUp");
		key(f.panel, "ArrowLeft");
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("500px");
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("120px");
		expect(key(f.canvas, "ArrowRight").defaultPrevented).toBe(false);
		for (const options of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
			expect(key(f.panel, "ArrowRight", options).defaultPrevented).toBe(false);
		}
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("500px");
	});
	it("keeps a bottom-positioned preview above a composer growing with text or attachments", () => {
		const f = setup();
		pointer(f.canvas, "pointerdown");
		pointer(f.panel, "pointermove", { clientY: 3000 });
		pointer(f.panel, "pointerup");
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("367px");
		for (const height of [212, 292]) {
			vi.mocked(f.composer.getBoundingClientRect).mockReturnValue(new DOMRect(100, 750 - height, 1000, height));
			f.resize(f.composer);
			expect(Number.parseFloat(f.panel.style.getPropertyValue("--computer-top")) + f.size.panelHeight).toBe(
				f.size.height - height - 8,
			);
		}
		expect(f.size).toEqual({ width: 1000, height: 700, panelWidth: 400, panelHeight: 225 });
	});
	it("keeps a moved preview below a growing thread header", () => {
		const f = setup();
		pointer(f.canvas, "pointerdown");
		pointer(f.panel, "pointermove", { clientY: -1000 });
		pointer(f.panel, "pointerup");
		vi.mocked(f.header.getBoundingClientRect).mockReturnValue(new DOMRect(100, 50, 1000, 90));
		f.resize(f.header);
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("98px");
	});
	it("reclamps a moved preview when the thread or panel resizes and disconnects on disposal", () => {
		const f = setup();
		key(f.panel, "ArrowRight");
		expect(f.observe.mock.calls.map(([target]) => target)).toEqual([f.parent, f.panel, f.header, f.composer]);
		f.size.width = 650;
		f.size.height = 400;
		f.resize();
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("242px");
		expect(f.panel.style.getPropertyValue("--computer-top")).toBe("67px");
		f.size.panelWidth = 350;
		window.dispatchEvent(new Event("resize"));
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("242px");
		f.stop.abort();
		expect(f.disconnect).toHaveBeenCalledOnce();
		f.size.width = 600;
		window.dispatchEvent(new Event("resize"));
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("242px");
	});
	it("fits an unmoved preview before interaction and follows composer growth at its original aspect ratio", async () => {
		const f = setup();
		f.size.height = 400;
		vi.mocked(f.composer.getBoundingClientRect).mockReturnValue(new DOMRect(100, 238, 1000, 212));
		await Promise.resolve();
		expect(f.observe).toHaveBeenCalledWith(f.composer);
		expect(f.panel.offsetHeight).toBeCloseTo(122);
		expect(f.panel.offsetWidth / f.panel.offsetHeight).toBeCloseTo(16 / 9);
		expect(Number.parseFloat(f.panel.style.getPropertyValue("--computer-top")) + f.panel.offsetHeight).toBeCloseTo(
			180,
		);
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe("");
		vi.mocked(f.composer.getBoundingClientRect).mockReturnValue(new DOMRect(100, 170, 1000, 280));
		f.resize(f.composer);
		expect(f.panel.offsetHeight).toBeCloseTo(54);
		expect(Number.parseFloat(f.panel.style.getPropertyValue("--computer-top")) + f.panel.offsetHeight).toBeCloseTo(
			112,
		);
		f.size.height = 700;
		f.resize();
		expect(f.panel.offsetWidth).toBe(400);
		expect(f.panel.offsetHeight).toBe(225);
	});
	it("fits a dragged preview after shrinking and after returning from expanded mode", async () => {
		const f = setup();
		await Promise.resolve();
		key(f.panel, "ArrowRight");
		const left = f.panel.style.getPropertyValue("--computer-left");
		f.panel.classList.add("is-entered");
		f.size.height = 400;
		vi.mocked(f.composer.getBoundingClientRect).mockReturnValue(new DOMRect(100, 238, 1000, 212));
		f.resize();
		expect(f.panel.offsetHeight).toBe(225);
		f.panel.classList.remove("is-entered");
		f.fit();
		expect(f.panel.offsetHeight).toBeCloseTo(122);
		expect(f.panel.style.getPropertyValue("--computer-left")).toBe(left);
		expect(Number.parseFloat(f.panel.style.getPropertyValue("--computer-top")) + f.panel.offsetHeight).toBeCloseTo(
			180,
		);
	});
});
