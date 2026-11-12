import type { MachineDesktopAction } from "../cloud/machine-screens.ts";
import { h } from "./dom.ts";
import { t } from "./preferences.ts";

/** Printable keys typed within this of each other go as one text (a member's typing is many keys, one action). */
export const TYPE_BATCH_MS = 150;
/** A second press within this, near the first, makes a double click; a single click waits this long for it. */
export const DOUBLE_CLICK_MS = 250;
/** Wheel turns within this go as one scroll. */
const WHEEL_BATCH_MS = 100;
/** A press that moves more than this (CSS pixels) is a drag. */
const DRAG_PX = 4;
/** At most this many characters a text action carries (machine_screen's own bound). */
export const TEXT_MAX = 500;
/** The browser's names of keys that are not text, as X names them (xdotool's key names). */
const KEY_NAMES: Readonly<Record<string, string>> = {
	Enter: "Return",
	Backspace: "BackSpace",
	Tab: "Tab",
	Escape: "Escape",
	Delete: "Delete",
	Insert: "Insert",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	ArrowUp: "Up",
	ArrowDown: "Down",
	Home: "Home",
	End: "End",
	PageUp: "Prior",
	PageDown: "Next",
	...Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`F${n + 1}`, `F${n + 1}`])),
};
/** The keys of a shortcut by their place on the keyboard (ctrl+a is the A key whatever the layout types there). */
const CODE_NAMES: Readonly<Record<string, string>> = {
	Space: "space",
	Minus: "minus",
	Equal: "equal",
	BracketLeft: "bracketleft",
	BracketRight: "bracketright",
	Semicolon: "semicolon",
	Quote: "apostrophe",
	Comma: "comma",
	Period: "period",
	Slash: "slash",
	Backslash: "backslash",
	Backquote: "grave",
};
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Hyper", "Super"]);
/** Control characters other than a line break or a tab, which a desktop's text never carries. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A text in actions of at most TEXT_MAX characters each, its carriage returns and other control characters gone. */
export function machineTexts(text: string): string[] {
	const chars = [...text.replace(/\r\n?/g, "\n").replace(CONTROL, "")];
	const texts: string[] = [];
	for (let at = 0; at < chars.length; at += TEXT_MAX) texts.push(chars.slice(at, at + TEXT_MAX).join(""));
	return texts;
}

/** Where a member's input goes while they hold the desktop: one action at a time, in the screen's own pixels. */
export interface MachineScreenInput {
	act(action: MachineDesktopAction): void;
}

/** A decoded picture: what a canvas draws. */
export type MachineScreenPicture = CanvasImageSource & {
	readonly width: number;
	readonly height: number;
	close?(): void;
};

export interface MachineScreenViewOptions {
	/** The panel's body: the view sits over its state text while it shows a picture. */
	readonly mount: HTMLElement;
	readonly title: string;
	/** The view entered (full size in the thread, or full screen) or went back to the preview. */
	readonly onExpandedChange: (expanded: boolean) => void;
	/** Decodes a picture (default createImageBitmap, off the main thread). */
	readonly decode?: (png: Blob) => Promise<MachineScreenPicture>;
}

/**
 * The picture of an agent's desktop (migration 20260930712000), in the frame the old screen viewer drew
 * (member-web/ui/screens.css: overlay, frame, titlebar, heading, stage, Enter and Back, and the `.computer-panel` rules
 * around it), so it looks, enters and goes back exactly as before. A canvas shows each picture once it is decoded, so
 * the last one stays up until the next is ready.
 *
 * While the member holds the desktop (20260930713000, `capture`), the picture takes their input: clicks, double and
 * right clicks, drags and the wheel at the screen's own pixels (the picture's natural size, wherever it is drawn), keys
 * that are not text by their X names, typed text gathered into one action (TYPE_BATCH_MS), and what they paste. The
 * panel captures only while the view is entered (the frame in the thread, or full screen): in the preview a press drags
 * the window (computer-drag.ts), and a desktop cannot be driven at that size anyway. A slot under the picture holds the
 * take-over controls the panel gives it.
 */
export class MachineScreenView {
	readonly el: HTMLElement;
	readonly #options: MachineScreenViewOptions;
	readonly #heading = h("span");
	readonly #hint = h("small");
	/** Says when the browser refused full screen, so the entered frame is not taken for it. Empty until then. */
	readonly #note = h("small", { class: "screen-viewer-note", role: "status", "aria-live": "polite" });
	readonly #back = h("button", {
		type: "button",
		class: "screen-viewer-back",
		hidden: true,
		"aria-label": t("Back to thread"),
		title: t("Back to thread"),
	});
	readonly #enter = h("button", { type: "button", class: "screen-viewer-enter", disabled: true }, t("Enter"));
	readonly #canvas = h("canvas", { class: "machine-screen-canvas", role: "img" });
	/** "Live" while the pictures come, "Updating…" while the last one is held. */
	readonly #mark = h("span", { class: "machine-screen-mark", hidden: true });
	readonly #switcherSlot = h("span", { class: "machine-screen-switcher-slot" });
	/** The take-over controls under the picture (the panel's: Take over, or what holding means and Hand back). */
	readonly #controlSlot = h("div", { class: "machine-screen-control-slot" });
	readonly #stop = new AbortController();
	#input: MachineScreenInput | null = null;
	#inputStop: AbortController | null = null;
	/** Typed text not sent yet, and when it goes. */
	#text = "";
	#textTimer: ReturnType<typeof setTimeout> | undefined;
	/** A single click waiting to see whether a second makes it a double. */
	#click: {
		x: number;
		y: number;
		at: number;
		clientX: number;
		clientY: number;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	/** A press on its way: where it began, and with which button. */
	#press: { x: number; y: number; clientX: number; clientY: number; button: number; moved: boolean } | null = null;
	#wheel: { delta: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
	#entered = false;
	#shown = false;
	/** Each picture's turn: one decoded after a newer one began is dropped. */
	#turn = 0;
	#fullscreenAttempt = 0;
	#ownedFullscreen = false;

	constructor(options: MachineScreenViewOptions) {
		this.#options = options;
		const headingWrap = h("span", { class: "screen-viewer-heading" }, this.#heading, this.#hint, this.#note);
		const controls = h("div", { class: "screen-viewer-controls" }, this.#back);
		const titlebar = h("div", { class: "screen-viewer-titlebar" }, headingWrap, this.#switcherSlot, controls);
		const stage = h("div", { class: "screen-viewer-stage" }, this.#canvas, this.#mark, this.#controlSlot);
		const frame = h("div", { class: "screen-viewer-frame" }, titlebar, stage, this.#enter);
		this.el = h(
			"div",
			{
				class: "screen-viewer-overlay screen-viewer-embedded machine-screen",
				role: "region",
				tabindex: "-1",
				hidden: true,
			},
			frame,
		);
		this.setTitle(options.title);
		options.mount.append(this.el);
		const signal = this.#stop.signal;
		this.#enter.addEventListener("click", () => this.#enterView(), { signal });
		this.#back.addEventListener("click", () => this.back(), { signal });
		document.addEventListener(
			"fullscreenchange",
			() => {
				const active = document.fullscreenElement === this.el;
				if (active) this.#note.textContent = "";
				if (this.#ownedFullscreen && !active) this.back();
				this.#ownedFullscreen = active;
			},
			{ signal },
		);
	}

	get entered(): boolean {
		return this.#entered;
	}

	/** Whether a picture is up. */
	get shown(): boolean {
		return this.#shown;
	}

	setTitle(title: string): void {
		this.el.setAttribute("aria-label", title);
		this.#canvas.setAttribute("aria-label", title);
		this.#heading.textContent = title;
	}

	/** The machine switcher, in the titlebar beside the title while entered (the panel keeps its own on the preview). */
	setSwitcher(switcher: HTMLElement | null): void {
		this.#switcherSlot.replaceChildren(...(switcher ? [switcher] : []));
	}

	/** The take-over controls under the picture, in the preview and entered alike (full screen too). */
	setControls(controls: HTMLElement | null): void {
		this.#controlSlot.replaceChildren(...(controls ? [controls] : []));
	}

	/** Whether the picture takes the member's input now. */
	get capturing(): boolean {
		return this.#input !== null;
	}

	/** Whether this element is the picture that takes input (the panel leaves its keys to it). */
	takesKeysFrom(target: EventTarget | null): boolean {
		return this.#input !== null && target === this.#canvas;
	}

	/** Gives the keyboard to the picture while it takes input. */
	focusScreen(): void {
		if (this.#input) this.#canvas.focus({ preventScroll: true });
	}

	/** Starts (an input) or stops (null) taking the member's input. Typed text not sent yet goes first when it stops;
	 * a single click still waiting goes too. */
	capture(input: MachineScreenInput | null): void {
		if (input === this.#input) return;
		this.#flush();
		this.#inputStop?.abort();
		this.#inputStop = null;
		this.#input = input;
		this.#press = null;
		this.el.classList.toggle("is-controlling", input !== null);
		if (!input) {
			this.#canvas.removeAttribute("tabindex");
			this.#canvas.setAttribute("role", "img");
			this.#canvas.removeAttribute("aria-roledescription");
			this.#canvas.removeAttribute("aria-description");
			return;
		}
		this.#canvas.tabIndex = 0;
		this.#canvas.setAttribute("role", "application");
		this.#canvas.setAttribute("aria-roledescription", t("computer screen"));
		this.#canvas.setAttribute(
			"aria-description",
			t("Your clicks and keys go to the computer. Shift+Escape leaves it."),
		);
		const stop = new AbortController();
		this.#inputStop = stop;
		const signal = AbortSignal.any([stop.signal, this.#stop.signal]);
		const canvas = this.#canvas;
		canvas.addEventListener("pointerdown", (event) => this.#pointerDown(event), { signal });
		canvas.addEventListener("pointermove", (event) => this.#pointerMove(event), { signal });
		canvas.addEventListener("pointerup", (event) => this.#pointerUp(event), { signal });
		canvas.addEventListener(
			"pointercancel",
			() => {
				this.#press = null;
			},
			{ signal },
		);
		canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
		canvas.addEventListener("wheel", (event) => this.#wheelTurn(event), { signal, passive: false });
		canvas.addEventListener("keydown", (event) => this.#key(event), { signal });
		canvas.addEventListener("compositionend", (event) => this.#typed(event.data ?? ""), { signal });
		canvas.addEventListener("paste", (event) => this.#paste(event), { signal });
	}

	/** Where a point of the page falls on the screen: its own pixels, or null outside the picture drawn there. */
	#at(clientX: number, clientY: number): { x: number; y: number } | null {
		const width = this.#canvas.width;
		const height = this.#canvas.height;
		const box = this.#canvas.getBoundingClientRect();
		if (!this.#shown || width < 1 || height < 1 || box.width <= 0 || box.height <= 0) return null;
		// The picture is drawn whole in the box (object-fit: contain), centred, at one scale.
		const scale = Math.min(box.width / width, box.height / height);
		const x = Math.floor((clientX - box.left - (box.width - width * scale) / 2) / scale);
		const y = Math.floor((clientY - box.top - (box.height - height * scale) / 2) / scale);
		if (x < 0 || y < 0 || x >= width || y >= height) return null;
		return { x, y };
	}

	#act(action: MachineDesktopAction): void {
		this.#input?.act(action);
	}

	#pointerDown(event: PointerEvent): void {
		// The press is the computer's: no drag of the panel, no text selection, and the keyboard comes here.
		event.stopPropagation();
		event.preventDefault();
		this.#canvas.focus({ preventScroll: true });
		const at = this.#at(event.clientX, event.clientY);
		if (!at || ![0, 1, 2].includes(event.button)) return;
		// A single click waiting for its second stays: this press may be that second.
		this.#flushBesides("click");
		this.#press = { ...at, clientX: event.clientX, clientY: event.clientY, button: event.button, moved: false };
		try {
			this.#canvas.setPointerCapture(event.pointerId);
		} catch {
			// A synthetic press has no pointer to capture.
		}
	}

	#pointerMove(event: PointerEvent): void {
		const press = this.#press;
		if (press && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > DRAG_PX)
			press.moved = true;
	}

	#pointerUp(event: PointerEvent): void {
		const press = this.#press;
		this.#press = null;
		if (!press) return;
		event.stopPropagation();
		if (press.moved || Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > DRAG_PX) {
			// A drag holds the left button from where it began to where it ends (only within the picture).
			const to = this.#at(event.clientX, event.clientY);
			if (press.button === 0 && to) {
				this.#flush();
				this.#act({ type: "drag", x: press.x, y: press.y, toX: to.x, toY: to.y });
			}
			return;
		}
		if (press.button !== 0) {
			this.#flush();
			this.#act({ type: "click", x: press.x, y: press.y, button: press.button === 2 ? "right" : "middle" });
			return;
		}
		const now = Date.now();
		const click = this.#click;
		if (
			click &&
			now - click.at <= DOUBLE_CLICK_MS &&
			Math.hypot(event.clientX - click.clientX, event.clientY - click.clientY) <= DRAG_PX * 2
		) {
			clearTimeout(click.timer);
			this.#click = null;
			this.#act({ type: "double", x: click.x, y: click.y });
			return;
		}
		this.#flush();
		const single = {
			x: press.x,
			y: press.y,
			at: now,
			clientX: event.clientX,
			clientY: event.clientY,
			timer: setTimeout(() => this.#flushClick(), DOUBLE_CLICK_MS),
		};
		this.#click = single;
	}

	/** A single click waiting for a second goes now. */
	#flushClick(): void {
		const click = this.#click;
		if (!click) return;
		clearTimeout(click.timer);
		this.#click = null;
		this.#act({ type: "click", x: click.x, y: click.y });
	}

	#wheelTurn(event: WheelEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const at = this.#at(event.clientX, event.clientY);
		if (!at) return;
		this.#flushBesides("wheel");
		// One notch of a mouse is about 100 pixels; a line is a third of a notch, a page ten notches.
		const delta = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 1000 : 1);
		if (this.#wheel) {
			this.#wheel.delta += delta;
			this.#wheel.x = at.x;
			this.#wheel.y = at.y;
			return;
		}
		this.#wheel = { delta, ...at, timer: setTimeout(() => this.#flushWheel(), WHEEL_BATCH_MS) };
	}

	#flushWheel(): void {
		const wheel = this.#wheel;
		if (!wheel) return;
		clearTimeout(wheel.timer);
		this.#wheel = null;
		if (wheel.delta === 0) return;
		const steps = Math.min(30, Math.max(1, Math.round(Math.abs(wheel.delta) / 100)));
		this.#act({ type: "scroll", direction: wheel.delta > 0 ? "down" : "up", steps, x: wheel.x, y: wheel.y });
	}

	#key(event: KeyboardEvent): void {
		if (event.isComposing || event.key === "Dead" || event.key === "Process" || event.key === "Unidentified") return;
		// Every other key is the computer's: shift+Escape is the way out of it, to the controls under the picture.
		if (event.key === "Escape" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			event.stopPropagation();
			this.#flush();
			this.#controlSlot.querySelector("button")?.focus();
			return;
		}
		if (MODIFIER_KEYS.has(event.key)) return;
		const altGraph = event.getModifierState?.("AltGraph") === true;
		const command = (event.ctrlKey || event.metaKey) && !altGraph;
		// The member's own paste (ctrl+v, cmd+v) types what is on their clipboard: the browser's paste event brings it.
		if (command && !event.altKey && !event.shiftKey && event.code === "KeyV") return;
		const alt = event.altKey && !altGraph;
		const printable = [...event.key].length === 1;
		if (printable && !command && !alt) {
			event.preventDefault();
			event.stopPropagation();
			this.#typed(event.key);
			return;
		}
		let name: string | undefined = KEY_NAMES[event.key];
		if (!name && printable) {
			const code = event.code;
			name = /^Key[A-Z]$/.test(code)
				? code.slice(3).toLowerCase()
				: /^Digit[0-9]$/.test(code)
					? code.slice(5)
					: CODE_NAMES[code];
		}
		if (!name) return;
		event.preventDefault();
		event.stopPropagation();
		const modifiers = [
			command ? "ctrl" : null,
			alt ? "alt" : null,
			event.shiftKey && (!printable || command || alt) ? "shift" : null,
		].filter((part): part is string => part !== null);
		this.#flush();
		this.#act({ type: "key", keys: [[...modifiers, name].join("+")] });
	}

	/** Text the member typed: gathered, and sent once they pause (or at TEXT_MAX). */
	#typed(text: string): void {
		const clean = text.replace(CONTROL, "");
		if (!clean) return;
		this.#flushBesides("text");
		this.#text += clean;
		clearTimeout(this.#textTimer);
		if ([...this.#text].length >= TEXT_MAX) this.#flushText();
		else this.#textTimer = setTimeout(() => this.#flushText(), TYPE_BATCH_MS);
	}

	#flushText(): void {
		clearTimeout(this.#textTimer);
		this.#textTimer = undefined;
		const text = this.#text;
		this.#text = "";
		for (const part of machineTexts(text)) this.#act({ type: "type", text: part });
	}

	#paste(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		event.preventDefault();
		event.stopPropagation();
		if (!text) return;
		this.#flush();
		for (const part of machineTexts(text)) this.#act({ type: "type", text: part });
	}

	/** Whatever input is still gathered goes now: a click waiting for its second, text, a wheel turn. */
	#flush(): void {
		this.#flushClick();
		this.#flushWheel();
		this.#flushText();
	}

	/** Input of one kind begins (a press, a wheel turn, typed text): what is gathered of the other kinds goes first, so
	 * the actions leave in the order the member made them (v233 release review r1, F31). Each kind's start does this, so
	 * at most one kind is ever gathered at a time, and #flush's order never matters. */
	#flushBesides(kind: "click" | "wheel" | "text"): void {
		if (kind !== "click") this.#flushClick();
		if (kind !== "wheel") this.#flushWheel();
		if (kind !== "text") this.#flushText();
	}

	/** Shows a picture once it is decoded; a newer picture that began meanwhile wins. Resolves false when this one was
	 * dropped or could not be decoded. */
	async show(png: Blob): Promise<boolean> {
		const turn = ++this.#turn;
		let picture: MachineScreenPicture;
		try {
			picture = await (this.#options.decode ?? ((blob: Blob) => createImageBitmap(blob)))(png);
		} catch {
			return false;
		}
		if (turn !== this.#turn || this.#stop.signal.aborted) {
			picture.close?.();
			return false;
		}
		if (this.#canvas.width !== picture.width) this.#canvas.width = picture.width;
		if (this.#canvas.height !== picture.height) this.#canvas.height = picture.height;
		this.#canvas.getContext("2d")?.drawImage(picture, 0, 0);
		picture.close?.();
		this.#shown = true;
		this.el.hidden = false;
		this.#enter.disabled = false;
		this.live();
		return true;
	}

	/** The picture up is the screen as it is now (the member had it already). */
	live(): void {
		if (!this.#shown) return;
		this.#mark.hidden = false;
		this.#mark.classList.remove("is-updating");
		this.#mark.textContent = t("Live");
		this.#hint.textContent = t("Live");
	}

	/** The last picture stays, marked as being updated (the company folder has not released the next one yet). */
	updating(): void {
		if (!this.#shown) return;
		this.#mark.hidden = false;
		this.#mark.classList.add("is-updating");
		this.#mark.textContent = t("Updating…");
		this.#hint.textContent = t("Updating…");
	}

	/** No picture any more: the view goes away, and the panel's state text shows. */
	clear(): void {
		this.capture(null);
		this.#turn++;
		this.back();
		this.#shown = false;
		this.el.hidden = true;
		this.#enter.disabled = true;
		this.#mark.hidden = true;
		this.#hint.textContent = "";
		this.#canvas.getContext("2d")?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
	}

	/** Enters the frame in the thread, as Enter does but without asking for full screen: only the member's own press on
	 * Enter asks for that. The panel's take-over pressed in the preview comes here, so the picture can take their input.
	 * Nothing while no picture shows. */
	enterFrame(): void {
		if (this.#entered || this.#enter.disabled) return;
		this.#setEntered(true);
	}

	/** Back to the preview, from the entered frame or full screen. */
	back(): void {
		if (!this.#entered) return;
		this.#fullscreenAttempt++;
		const focused = this.el.contains(document.activeElement);
		this.#setEntered(false);
		if (focused) this.el.focus();
		if (document.fullscreenElement === this.el && typeof document.exitFullscreen === "function")
			void document.exitFullscreen().catch(() => undefined);
	}

	dispose(): void {
		this.capture(null);
		this.back();
		this.#stop.abort();
		this.#turn++;
		this.el.remove();
	}

	#setEntered(value: boolean): void {
		if (this.#entered === value) return;
		this.#entered = value;
		this.el.classList.toggle("screen-viewer-entered", value);
		this.#back.hidden = !value;
		this.#enter.hidden = value;
		if (!value) this.#note.textContent = "";
		this.#options.onExpandedChange(value);
	}

	/** Entering takes the browser full screen, with the frame around the picture; "Back to thread" is the way out, and
	 * leaving full screen any other way (Escape, the system) goes back too. Refused, the entered frame stays in the
	 * thread and says so. */
	#enterView(): void {
		if (this.#entered || this.#enter.disabled) return;
		this.#setEntered(true);
		this.#back.focus();
		const supports =
			document.fullscreenEnabled !== false &&
			typeof this.el.requestFullscreen === "function" &&
			typeof document.exitFullscreen === "function";
		if (!supports) return;
		const attempt = ++this.#fullscreenAttempt;
		const refused = () => {
			if (attempt === this.#fullscreenAttempt && this.#entered && document.fullscreenElement !== this.el)
				this.#note.textContent = t("Full screen unavailable");
		};
		const slow = setTimeout(refused, 2000);
		// Asked before any await, so the click's user activation holds.
		void this.el
			.requestFullscreen()
			.then(() => {
				if (!this.#entered && document.fullscreenElement === this.el) return document.exitFullscreen();
				return undefined;
			})
			.catch(() => setTimeout(refused, 0))
			.finally(() => clearTimeout(slow));
	}
}
