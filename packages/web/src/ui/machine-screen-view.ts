import type { MachineDesktopAction } from "../cloud/machine-screens.ts";
import type { MachineStreamMessage, MachineStreamRect } from "../cloud/machine-stream.ts";
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

/** When the member made an input (review r4 F2 of #1701): the wall clock and the monotonic clock at the event, read
 * there and carried through every buffer here. Both clocks, because neither alone sees every gap: a suspended tab
 * moves both, a sleeping laptop may stop the monotonic clock in some browsers, and a wall clock may be set back. */
export interface InputTime {
	readonly wall: number;
	readonly mono: number;
}

/** The time of an input made now. */
export function inputTime(): InputTime {
	return { wall: Date.now(), mono: performance.now() };
}

/** When the parts of one action were made (review r5 F1 of #1701): one event, or several joined (the keys of a text, a
 * wheel burst, a press and its release, a click and its second, texts joined in a send queue). Joining keeps every
 * part's verdict: the oldest part by each clock gives its age, the newest by each clock shows a clock gone back since
 * any part, and the largest wall-minus-monotonic offset shows a wall clock set back since any part even after it came
 * forward again. So a joined action is too old whenever any of its parts is. */
export interface InputSpan {
	readonly oldest: InputTime;
	readonly newest: InputTime;
	readonly offset: number;
}

/** The span of one event made at `time` (now, unless given). */
export function inputSpan(time: InputTime = inputTime()): InputSpan {
	return { oldest: time, newest: time, offset: time.wall - time.mono };
}

/** Two spans as one action's. */
export function joinInputs(a: InputSpan, b: InputSpan): InputSpan {
	return {
		oldest: { wall: Math.min(a.oldest.wall, b.oldest.wall), mono: Math.min(a.oldest.mono, b.oldest.mono) },
		newest: { wall: Math.max(a.newest.wall, b.newest.wall), mono: Math.max(a.newest.mono, b.newest.mono) },
		offset: Math.max(a.offset, b.offset),
	};
}

/** Where a member's input goes while they hold the desktop: one action at a time, in the screen's own pixels, with
 * when the member made its parts. `lost` hears of a press the picture drops unfinished when it is given another input
 * (review r5 F2 of #1701), so the one who loses it may say so. */
export interface MachineScreenInput {
	act(action: MachineDesktopAction, made: InputSpan): void;
	lost?(): void;
	/** Where the member's own pointer is over the picture, in the screen's own pixels, while no button is pressed
	 * (20260930744000: the desktop's pointer follows it, so hover works); null once it leaves the picture. Nothing of a
	 * key or a text is ever in it. */
	point?(at: { readonly x: number; readonly y: number } | null): void;
}

/**
 * What the page may hold of a live picture while it decodes (review r3 F1 of #1746: before this, every message began
 * decoding at once and a stalled decoder held every later PNG and bitmap). The numbers come from what the real machine
 * sends: a whole 1600 x 1000 screen is one message of 28 areas, about 50 KB of PNG and 1.6 Mpx; a moving page sends
 * about 30 messages a second, together some 16 KiB/s. So these bounds sit far above an ordinary busy screen — 16
 * messages is half a second of a moving page's backlog, 8 MiB is 160 whole screens of PNG, 16 Mpx is ten whole screens
 * decoded — and a decoder that is merely slow catches up, while one that is stuck overflows. On overflow the stream
 * ends and the window goes back to its own pictures, so the member is never left with nothing.
 */
const MAX_PENDING_MESSAGES = 16;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_PIXELS = 16 * 1000 * 1000;
/** How many areas decode at once across the view: a whole screen's 28 bands then go in four rounds of a few ms. */
const MAX_DECODING = 8;
/** What an await of a stream's work answers when that stream was dropped while it waited. */
const GONE: unique symbol = Symbol("the stream is gone");

/**
 * One live picture's own decoding (review r4 F1 of #1746). Everything in it belongs to that stream: the turns its areas
 * take, who waits for one, and what it holds. A stream that ends or is replaced is `dropped`: everyone waiting is let
 * go at once and then SKIPS decoding (review r5 F1), and every bitmap of it is closed as it lands. `showing` turns true
 * only when pixels of it have reached the canvas, so until then the window keeps its own pictures.
 */
interface StreamPaint {
	readonly generation: number;
	dropped: boolean;
	showing: boolean;
	/** Every job of this stream, so that dropping it closes what they had already decoded (review r5 F1 of #1746). */
	readonly jobs: Set<PaintJob>;
	/** The size this stream told, which lives and dies with it and which no other source touches (review r6 of #1746):
	 * the fit check is against this, and an area outside it is an inconsistency. */
	size: { readonly width: number; readonly height: number } | null;
	/** This stream's own order: each message waits for the one before it, and for nothing of any other stream. */
	chain: Promise<void>;
	/** One entry for each wait of one of its messages still under way, each answering GONE the moment this stream is
	 * dropped: EVERY await of a message ends with the stream, so a decode that never settles cannot hold that message, or
	 * any message behind it, or their callers, past the stream's end (the lead's audit of #1746, 13 Nov). A wait that
	 * settles takes its entry out, so a long stream keeps none of them (the v245 release review: a shared promise that
	 * never settled kept a handler for every wait of every message, 54,000 in half an hour). */
	readonly cancels: Set<() => void>;
	decoding: number;
	readonly waiting: (() => void)[];
	readonly held: Set<{ readonly bytes: number; readonly pixels: number }>;
	bytes: number;
	pixels: number;
}

/**
 * One piece of work on its way to a canvas, whoever submits it (review r5 of #1746: THE one painter, in its final shape
 * at r6). There is NO comparison of "what landed meanwhile" any more — the question it tried to answer cannot arise:
 *  - the window's own pictures and the live picture have a canvas each, so neither source ever writes where the other
 *    draws; exactly one of the two is shown, and a look can neither overwrite the live picture nor clear its size nor
 *    end it.
 *  - inside one live picture the messages apply strictly in the order they arrived (size, areas), however long
 *    any one of them takes to decode: only the decoding runs side by side, never the applying. Nothing of a stream is
 *    ever dropped to keep that order; a stream's work is discarded only when the WHOLE stream is dropped.
 *  - of the window's own looks only the newest paints (`#lookTurn`): an older one that decodes later is dropped, since
 *    both hold the whole screen at a moment and the newer moment is the true one.
 * `pictures` holds what this job has decoded so far, so a job that may no longer land closes them where they land
 * instead of holding them behind a sibling that never finishes (review r5 F1). There is no longer a token of any kind:
 * nothing is decided by comparing one piece of work with another (review r6).
 */
interface PaintJob {
	/** The live picture this work belongs to, or null for the window's own pictures. */
	readonly owner: StreamPaint | null;
	readonly pictures: Set<MachineScreenPicture>;
	void: boolean;
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
 * panel captures only while the view is entered (the frame in the thread, or full screen): in the preview (a row of its
 * thread) a click opens the large view, and a desktop is not driven at that size. A slot under the picture holds the
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
	/** The window's own pictures (its looks). */
	readonly #canvas = h("canvas", { class: "machine-screen-canvas", role: "img" });
	/** The live picture, on a canvas of its own (review r6 of #1746): exactly one of the two is shown at a time, and
	 * neither ever writes where the other draws, so a look can never overwrite the stream, clear its size or end it, and
	 * no rule is needed about what landed meanwhile. */
	readonly #streamCanvas = h("canvas", { class: "machine-screen-canvas", role: "img", hidden: true });
	/** "Live" while the pictures come, "Updating…" while the last one is held. */
	readonly #mark = h("span", { class: "machine-screen-mark", hidden: true });
	readonly #switcherSlot = h("span", { class: "machine-screen-switcher-slot" });
	/** The take-over controls under the picture (the panel's: Take over, or what holding means and Hand back). */
	readonly #controlSlot = h("div", { class: "machine-screen-control-slot" });
	/** Where the take-over controls stand in the large view: a slim row of the frame under its titlebar, never on the
	 * desktop's picture (its dock and clock; v239 real test, 13 Nov 2026). */
	readonly #barSlot = h("div", { class: "machine-screen-bar-slot" });
	#controls: HTMLElement | null = null;
	readonly #stop = new AbortController();
	#input: MachineScreenInput | null = null;
	#inputStop: AbortController | null = null;
	/** Typed text not sent yet, when its keys were made, and when it goes. */
	#text = "";
	#textAt: InputSpan | undefined;
	#textTimer: ReturnType<typeof setTimeout> | undefined;
	/** A single click waiting to see whether a second makes it a double. */
	#click: {
		x: number;
		y: number;
		at: number;
		/** When its press and its release were made. */
		made: InputSpan;
		clientX: number;
		clientY: number;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	/** A press on its way: where it began, with which button, and when. */
	#press: {
		x: number;
		y: number;
		clientX: number;
		clientY: number;
		button: number;
		moved: boolean;
		made: InputSpan;
	} | null = null;
	/** A wheel burst: its turns so far, and when they were made. */
	#wheel: { delta: number; x: number; y: number; made: InputSpan; timer: ReturnType<typeof setTimeout> } | null = null;
	/** Where the member's pointer went (null: it left the picture) while an action was still gathered here (a click
	 * waiting for its second, a wheel burst, text): it goes right after that action, never before it (review r1 F3 of
	 * #1733: a hover move must not close the menu a click waiting here is for). Undefined: none waits. */
	#heldPoint: { readonly x: number; readonly y: number } | null | undefined = undefined;
	#entered = false;
	#shown = false;
	/** THE painter (review r5 of #1746, in its final shape at r6): one place writes pixels and one place disposes of what
	 * may not land. There is no longer any comparison of "what landed meanwhile": the window's own pictures and the live
	 * picture have a canvas each, so no source can overwrite another's, and inside one live picture the messages apply
	 * strictly in the order they arrived. Work is discarded only when its whole stream is dropped, or when a newer look
	 * replaced an older one on the window's own canvas. */
	#painting: Promise<unknown> = Promise.resolve();
	/** The newest of the window's own pictures: an older one that decodes later does not paint over it. */
	#lookTurn = 0;
	/** Whether a picture of the window's own is on its canvas: when none is, there is nothing for a live picture to fall
	 * back to when it ends. */
	#looked = false;
	/** How many times the picture was cleared or a live picture ended: the generation. Everything a stream decodes and
	 * draws belongs to its own generation (`#paint`), so a replacement shares nothing with it (review r4 F1 of #1746). */
	#cleared = 0;
	/** The one stream whose work this view is doing now, or none. Each has its own chain, its own decoding turns, its own
	 * waiting list and its own count of what it holds; when it is dropped, its queue goes, every waiter is let go at once
	 * so nothing of a later stream waits behind it, and each of its bitmaps is closed as it lands. */
	#paint: StreamPaint | null = null;
	#fullscreenAttempt = 0;
	#ownedFullscreen = false;

	constructor(options: MachineScreenViewOptions) {
		this.#options = options;
		const headingWrap = h("span", { class: "screen-viewer-heading" }, this.#heading, this.#hint, this.#note);
		const controls = h("div", { class: "screen-viewer-controls" }, this.#back);
		const titlebar = h("div", { class: "screen-viewer-titlebar" }, headingWrap, this.#switcherSlot, controls);
		const stage = h(
			"div",
			{ class: "screen-viewer-stage" },
			this.#canvas,
			this.#streamCanvas,
			this.#mark,
			this.#controlSlot,
		);
		const frame = h("div", { class: "screen-viewer-frame" }, titlebar, this.#barSlot, stage, this.#enter);
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
		for (const canvas of this.#canvases) canvas.setAttribute("aria-label", title);
		this.#heading.textContent = title;
	}

	/** Both pictures of this view, in the order they stand (review r6 of #1746): the window's own and the live one. What
	 * belongs to the picture as a thing the member sees and acts on — its label, its role, its input —
	 * is on both, so taking over keeps working across the moment the live picture appears or ends. */
	get #canvases(): readonly HTMLCanvasElement[] {
		return [this.#canvas, this.#streamCanvas];
	}

	/** The one of the two that shows now: the live picture's while its pixels are up, the window's own otherwise. The
	 * hidden one takes no pointer and is measured by nobody. */
	get #face(): HTMLCanvasElement {
		return this.#streamCanvas.hidden ? this.#canvas : this.#streamCanvas;
	}

	/** Shows one of the two pictures in place of the other. **Whatever the member has moves with the swap** — here the
	 * keyboard, which is the one thing a canvas holds that the view does not: a focused element that stops being
	 * rendered is blurred by the browser (the focus fixup rule plus `display: none`), and the member's keys would then
	 * reach the page's own shortcuts instead of the computer until they clicked the picture again (review r7 F1 of
	 * #1746). The one taking over is shown before the other goes, so the focus has somewhere to land. */
	#swap(shown: HTMLCanvasElement, hidden: HTMLCanvasElement): void {
		const held = document.activeElement === hidden;
		shown.hidden = false;
		hidden.hidden = true;
		if (held) shown.focus({ preventScroll: true });
	}

	/** The machine switcher, in the titlebar beside the title while entered (the panel keeps its own on the preview). */
	setSwitcher(switcher: HTMLElement | null): void {
		this.#switcherSlot.replaceChildren(...(switcher ? [switcher] : []));
	}

	/** The take-over controls: on the picture's foot in the preview, in the frame's row above the picture entered (full
	 * screen too). */
	setControls(controls: HTMLElement | null): void {
		this.#controls = controls;
		this.#placeControls();
	}

	#placeControls(): void {
		const controls = this.#controls;
		(this.#entered ? this.#controlSlot : this.#barSlot).replaceChildren();
		if (controls) (this.#entered ? this.#barSlot : this.#controlSlot).replaceChildren(controls);
	}

	/** Whether the picture takes the member's input now. */
	get capturing(): boolean {
		return this.#input !== null;
	}

	/** Whether this element is the picture that takes input (the panel leaves its keys to it). */
	takesKeysFrom(target: EventTarget | null): boolean {
		return this.#input !== null && this.#canvases.some((canvas) => target === canvas);
	}

	/** Gives the keyboard to the picture while it takes input. */
	focusScreen(): void {
		if (this.#input) this.#face.focus({ preventScroll: true });
	}

	/** Starts (an input) or stops (null) taking the member's input. Typed text not sent yet goes first when it stops;
	 * a single click still waiting goes too. */
	capture(input: MachineScreenInput | null): void {
		if (input === this.#input) return;
		// A press not let go yet cannot be finished for the input it began under: it is dropped, and that input hears so.
		const unfinished = this.#press !== null;
		this.#flush();
		// A position that waited goes nowhere else: the next input gets its pointer from the next move.
		this.#heldPoint = undefined;
		if (unfinished) this.#input?.lost?.();
		this.#inputStop?.abort();
		this.#inputStop = null;
		this.#input = input;
		this.#press = null;
		this.el.classList.toggle("is-controlling", input !== null);
		if (!input) {
			for (const canvas of this.#canvases) {
				canvas.removeAttribute("tabindex");
				canvas.setAttribute("role", "img");
				canvas.removeAttribute("aria-roledescription");
				canvas.removeAttribute("aria-description");
			}
			return;
		}
		const stop = new AbortController();
		this.#inputStop = stop;
		const signal = AbortSignal.any([stop.signal, this.#stop.signal]);
		// Both pictures take the input, so the member keeps the computer across the moment the live picture appears or
		// ends: the hidden one receives nothing anyway, and the shown one is always the one under their pointer.
		for (const canvas of this.#canvases) {
			canvas.tabIndex = 0;
			canvas.setAttribute("role", "application");
			canvas.setAttribute("aria-roledescription", t("computer screen"));
			canvas.setAttribute("aria-description", t("Your clicks and keys go to the computer. Shift+Escape leaves it."));
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
			canvas.addEventListener("pointerleave", () => this.#point(null), { signal });
			canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
			canvas.addEventListener("wheel", (event) => this.#wheelTurn(event), { signal, passive: false });
			canvas.addEventListener("keydown", (event) => this.#key(event), { signal });
			canvas.addEventListener("compositionend", (event) => this.#typed(event.data ?? ""), { signal });
			canvas.addEventListener("paste", (event) => this.#paste(event), { signal });
		}
	}

	/** Where a point of the page falls on the screen: its own pixels, or null outside the picture drawn there. The
	 * picture shown is the one that counts — the live one while it is up, the window's own otherwise — so the member's
	 * clicks land where they see them whichever of the two they are looking at. */
	#at(clientX: number, clientY: number): { x: number; y: number } | null {
		const face = this.#face;
		const width = face.width;
		const height = face.height;
		const box = face.getBoundingClientRect();
		if (!this.#shown || width < 1 || height < 1 || box.width <= 0 || box.height <= 0) return null;
		// The picture is drawn whole in the box (object-fit: contain), centred, at one scale.
		const scale = Math.min(box.width / width, box.height / height);
		const x = Math.floor((clientX - box.left - (box.width - width * scale) / 2) / scale);
		const y = Math.floor((clientY - box.top - (box.height - height * scale) / 2) / scale);
		if (x < 0 || y < 0 || x >= width || y >= height) return null;
		return { x, y };
	}

	#act(action: MachineDesktopAction, made: InputSpan): void {
		this.#input?.act(action, made);
	}

	#pointerDown(event: PointerEvent): void {
		// The press is the computer's: no drag of the panel, no text selection, and the keyboard comes here.
		event.stopPropagation();
		event.preventDefault();
		this.#face.focus({ preventScroll: true });
		const at = this.#at(event.clientX, event.clientY);
		if (!at || ![0, 1, 2].includes(event.button)) return;
		// A single click waiting for its second stays: this press may be that second.
		this.#flushBesides("click");
		this.#press = {
			...at,
			clientX: event.clientX,
			clientY: event.clientY,
			button: event.button,
			moved: false,
			made: inputSpan(),
		};
		try {
			this.#face.setPointerCapture(event.pointerId);
		} catch {
			// A synthetic press has no pointer to capture.
		}
	}

	#pointerMove(event: PointerEvent): void {
		const press = this.#press;
		if (press && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > DRAG_PX)
			press.moved = true;
		// The member's own pointer is the desktop's (20260930744000): where it is goes to the input while no button is
		// pressed (a press's moves are its drag's, sent as one action); outside the picture drawn there, nowhere.
		if (!press && event.buttons === 0) this.#point(this.#at(event.clientX, event.clientY));
	}

	/** Where the member's pointer is goes to the input, after any action still gathered here (#heldPoint). */
	#point(at: { readonly x: number; readonly y: number } | null): void {
		if (!this.#input?.point) return;
		if (this.#click || this.#wheel || this.#textAt) {
			this.#heldPoint = at;
			return;
		}
		this.#heldPoint = undefined;
		this.#input.point(at);
	}

	/** An action gathered here went: the position that waited behind it goes now, once nothing else is gathered. */
	#pointAfter(): void {
		if (this.#heldPoint === undefined || this.#click || this.#wheel || this.#textAt) return;
		const at = this.#heldPoint;
		this.#heldPoint = undefined;
		this.#input?.point?.(at);
	}

	#pointerUp(event: PointerEvent): void {
		const press = this.#press;
		this.#press = null;
		if (!press) return;
		// The action is the press and its release: made over both.
		const made = joinInputs(press.made, inputSpan());
		event.stopPropagation();
		if (press.moved || Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > DRAG_PX) {
			// A drag holds the left button from where it began to where it ends (only within the picture).
			const to = this.#at(event.clientX, event.clientY);
			if (press.button === 0 && to) {
				this.#flush();
				this.#act({ type: "drag", x: press.x, y: press.y, toX: to.x, toY: to.y }, made);
			}
			return;
		}
		if (press.button !== 0) {
			this.#flush();
			this.#act({ type: "click", x: press.x, y: press.y, button: press.button === 2 ? "right" : "middle" }, made);
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
			// A double click is both clicks.
			this.#act({ type: "double", x: click.x, y: click.y }, joinInputs(click.made, made));
			this.#pointAfter();
			return;
		}
		this.#flush();
		const single = {
			x: press.x,
			y: press.y,
			at: now,
			made,
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
		this.#act({ type: "click", x: click.x, y: click.y }, click.made);
		this.#pointAfter();
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
			this.#wheel.made = joinInputs(this.#wheel.made, inputSpan());
			return;
		}
		this.#wheel = { delta, ...at, made: inputSpan(), timer: setTimeout(() => this.#flushWheel(), WHEEL_BATCH_MS) };
	}

	#flushWheel(): void {
		const wheel = this.#wheel;
		if (!wheel) return;
		clearTimeout(wheel.timer);
		this.#wheel = null;
		if (wheel.delta === 0) {
			this.#pointAfter();
			return;
		}
		const steps = Math.min(30, Math.max(1, Math.round(Math.abs(wheel.delta) / 100)));
		this.#act(
			{ type: "scroll", direction: wheel.delta > 0 ? "down" : "up", steps, x: wheel.x, y: wheel.y },
			wheel.made,
		);
		this.#pointAfter();
	}

	#key(event: KeyboardEvent): void {
		if (event.isComposing || event.key === "Dead" || event.key === "Process" || event.key === "Unidentified") return;
		// Every other key is the computer's: shift+Escape is the way out of it, to the controls under the picture.
		if (event.key === "Escape" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			event.stopPropagation();
			this.#flush();
			this.#controls?.querySelector("button")?.focus();
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
		const made = inputSpan();
		this.#flush();
		this.#act({ type: "key", keys: [[...modifiers, name].join("+")] }, made);
	}

	/** Text the member typed: gathered, and sent once they pause (or at TEXT_MAX). */
	#typed(text: string): void {
		const clean = text.replace(CONTROL, "");
		if (!clean) return;
		const made = inputSpan();
		this.#flushBesides("text");
		// The text is made over all its keys.
		this.#textAt = this.#text && this.#textAt ? joinInputs(this.#textAt, made) : made;
		this.#text += clean;
		clearTimeout(this.#textTimer);
		if ([...this.#text].length >= TEXT_MAX) this.#flushText();
		else this.#textTimer = setTimeout(() => this.#flushText(), TYPE_BATCH_MS);
	}

	#flushText(): void {
		clearTimeout(this.#textTimer);
		this.#textTimer = undefined;
		const text = this.#text;
		const made = this.#textAt;
		this.#text = "";
		this.#textAt = undefined;
		if (made) for (const part of machineTexts(text)) this.#act({ type: "type", text: part }, made);
		this.#pointAfter();
	}

	#paste(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		event.preventDefault();
		event.stopPropagation();
		if (!text) return;
		const made = inputSpan();
		this.#flush();
		for (const part of machineTexts(text)) this.#act({ type: "type", text: part }, made);
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
		// The window's own picture draws on its OWN canvas (review r6 of #1746): it can neither overwrite the live
		// picture, nor clear its size, nor end it. Only a newer look of its own supersedes it.
		const turn = ++this.#lookTurn;
		const job = this.#job();
		let picture: MachineScreenPicture;
		try {
			picture = await (this.#options.decode ?? ((blob: Blob) => createImageBitmap(blob)))(png);
		} catch {
			return false;
		}
		if (job.void || this.#stop.signal.aborted) {
			picture.close?.();
			return false;
		}
		job.pictures.add(picture);
		return (
			(await this.#commit(job, () => {
				// A look a newer one has overtaken paints nothing: discarded work, not a failure.
				if (turn !== this.#lookTurn) return "dropped";
				if (this.#canvas.width !== picture.width) this.#canvas.width = picture.width;
				if (this.#canvas.height !== picture.height) this.#canvas.height = picture.height;
				this.#canvas.getContext("2d")?.drawImage(picture, 0, 0);
				this.#looked = true;
				this.#shown = true;
				this.el.hidden = false;
				this.#enter.disabled = false;
				this.live();
				return "drawn" as const;
			})) === "drawn"
		);
	}

	/**
	 * THE one place that writes pixels (review r5 of #1746, in its final shape at r6). Work waits its turn in one
	 * ordered queue and is committed in the order it was submitted; whatever it decoded is closed here. Nothing is
	 * compared against "what the canvas already holds" any more — the two canvases and each stream's own order make
	 * that question impossible. Work does not land for three reasons only: its stream was dropped, its job was
	 * disposed of, or the view is gone. `paint` says what it did: `drawn`, `dropped` (it decided for itself not to
	 * draw — a look a newer one has overtaken) or `failed` (an inconsistency: the stream ends, review r5's safe mode).
	 */
	async #commit(job: PaintJob, paint: () => "drawn" | "dropped" | "failed"): Promise<"drawn" | "dropped" | "failed"> {
		const mine = this.#painting.then(() => {
			// The only reasons work does not land: its stream was dropped, a newer look replaced it, or the view is gone.
			if (job.void || job.owner?.dropped === true || this.#stop.signal.aborted) return "dropped" as const;
			return paint();
		});
		// Every pixel of this view is written inside that one callback, under that one check.
		this.#painting = mine.catch(() => "failed" as const);
		try {
			return await mine;
		} catch {
			return "failed";
		} finally {
			this.#dispose(job);
		}
	}

	/** One piece of work for the painter: whose it is, what it has decoded, and whether it may still land. */
	#job(owner: StreamPaint | null = null): PaintJob {
		return { owner, pictures: new Set(), void: false };
	}

	/** Closes whatever a job decoded, wherever it is in its life, and marks it as no longer able to land. */
	#dispose(job: PaintJob): void {
		job.void = true;
		for (const picture of job.pictures) picture.close?.();
		job.pictures.clear();
	}

	/** One message of the desktop's live picture (20260930745000), drawn after those before it: the screen's size (what
	 * was drawn goes) and changed areas at their places. The desktop's pointer shape is not shown (Jonas, 14 Nov 2026:
	 * "let's actually hide the agent cursor when inside of the agents computer"): over the picture the member keeps
	 * their own pointer, so its message is answered at once and nothing of it is read. A picture of a look still being decoded is
	 * dropped (the stream's is newer). Answers `"drawn"`, `"dropped"` (the picture was cleared or the stream ended while
	 * it decoded: discarded work, no fault of the stream) or `"failed"` (an area that does not decode, or does not fit
	 * the screen: that stream is of no use). The caller must tell the last two apart, or a draw discarded at a renewal
	 * would end the stream that replaced it (review r2 F4 of #1746). */
	async stream(message: MachineStreamMessage): Promise<"drawn" | "dropped" | "failed" | "overflow"> {
		if (message.kind === "cursor") return "drawn";
		const paint = this.#paintFor();
		const bytes = message.kind === "rects" ? message.rects.reduce((sum, rect) => sum + rect.png.size, 0) : 0;
		const pixels =
			message.kind === "rects" ? message.rects.reduce((sum, rect) => sum + rect.width * rect.height, 0) : 0;
		// Past what this stream may hold while it decodes, nothing of the message is begun: the window ends that stream
		// and its own pictures carry on (review r3 F1 of #1746).
		if (
			paint.held.size >= MAX_PENDING_MESSAGES ||
			paint.bytes + bytes > MAX_PENDING_BYTES ||
			paint.pixels + pixels > MAX_PENDING_PIXELS
		)
			return "overflow";
		const holds = { bytes, pixels };
		paint.held.add(holds);
		paint.bytes += bytes;
		paint.pixels += pixels;
		const letGo = () => {
			if (!paint.held.delete(holds)) return;
			paint.bytes -= bytes;
			paint.pixels -= pixels;
		};
		const job = this.#job(paint);
		paint.jobs.add(job);
		const decode = this.#options.decode ?? ((blob: Blob) => createImageBitmap(blob));
		// At most MAX_DECODING areas of THIS stream decode at once. Work of a stream that was dropped, or of a job that
		// may no longer land, is skipped BEFORE anything is decoded, and a picture that lands for such a job is closed
		// where it lands instead of waiting behind a sibling that may never finish (review r5 F1 of #1746). Nothing else
		// makes work stale: inside one stream nothing is ever dropped for ordering (review r6 of #1746).
		const stale = () => paint.dropped || job.void || this.#stop.signal.aborted;
		const one = async (rect: MachineStreamRect) => {
			await this.#turnToDecode(paint);
			try {
				if (stale()) return null;
				const picture = await decode(rect.png);
				if (stale()) {
					picture.close?.();
					return null;
				}
				job.pictures.add(picture);
				return { rect, picture };
			} catch {
				return null;
			} finally {
				this.#decoded(paint);
			}
		};
		const pictures = message.kind === "rects" ? Promise.all(message.rects.map(one)) : Promise.resolve([]);
		// This stream's messages reach the canvas in the order they came (its areas change regions, so order matters):
		// each waits for the one before it, inside this stream alone, never for anything of another stream (r4 F1).
		const behind = paint.chain;
		let ready: () => void = () => {};
		paint.chain = new Promise<void>((resolve) => {
			ready = resolve;
		});
		// Each wait below ends with the stream: a decode that never settles holds nothing past the drop, neither this
		// message nor the ones behind it, nor whoever awaits them. Pictures that land later are closed where they land
		// (`stale()` above); those already decoded were closed by the drop with the job.
		const decoded = await this.#whileLive(paint, pictures);
		const turn = decoded === GONE ? GONE : await this.#whileLive(paint, behind);
		if (decoded === GONE || turn === GONE || paint.dropped || this.#stop.signal.aborted) {
			this.#dispose(job);
			paint.jobs.delete(job);
			letGo();
			ready();
			return "dropped";
		}
		try {
			return await this.#commit(job, () => {
				// The live picture's own canvas: the window's pictures are on the other one and are never touched here.
				const canvas = this.#streamCanvas;
				if (message.kind === "size") {
					// Set whichever way: a size message says the whole screen goes, and setting a canvas's size empties
					// it, so a renewal of the same size cannot show a single pixel of the stream before it.
					canvas.width = message.width;
					canvas.height = message.height;
					// The remembered size belongs to this stream and to nothing else (review r6 of #1746): it lives and
					// dies with it, and the fit check below is against it alone.
					paint.size = { width: message.width, height: message.height };
					// A size alone shows nothing: the window keeps its own pictures until pixels of this stream land.
					return "drawn";
				}
				// The safe mode (review r5 of #1746): anything that does not agree — an area outside the size this stream
				// told, a picture of another size than its area, one that did not decode, or pixels before any size —
				// ends the stream and the window's own pictures come back. Nothing is painted through and nothing guessed.
				const size = paint.size;
				const fits = (rect: MachineStreamRect, picture: MachineScreenPicture) =>
					size !== null &&
					picture.width === rect.width &&
					picture.height === rect.height &&
					rect.x + rect.width <= size.width &&
					rect.y + rect.height <= size.height &&
					size.width === canvas.width &&
					size.height === canvas.height;
				if (decoded.some((each) => each === null || !fits(each.rect, each.picture))) return "failed";
				const context = canvas.getContext("2d");
				for (const each of decoded) if (each) context?.drawImage(each.picture, each.rect.x, each.rect.y);
				// Pixels of this stream are on its canvas: now it is shown, in place of the window's own picture, with
				// the member's keyboard carried over to it.
				paint.showing = true;
				this.#swap(canvas, this.#canvas);
				this.#shown = true;
				this.el.hidden = false;
				this.#enter.disabled = false;
				this.live();
				return "drawn";
			});
		} finally {
			// Committed (and so disposed of): the stream keeps no record of it (the v245 release review: finished jobs
			// were kept until the stream ended, 54,000 in half an hour at 30 messages a second).
			paint.jobs.delete(job);
			letGo();
			ready();
		}
	}

	/** `work`, or GONE the moment `paint`'s stream is dropped, whichever comes first; once either has happened, the
	 * stream keeps nothing of this wait. */
	#whileLive<T>(paint: StreamPaint, work: Promise<T>): Promise<T | typeof GONE> {
		if (paint.dropped) return Promise.resolve(GONE);
		return new Promise<T | typeof GONE>((resolve, reject) => {
			const cancel = () => resolve(GONE);
			paint.cancels.add(cancel);
			work.then(
				(value) => {
					paint.cancels.delete(cancel);
					resolve(value);
				},
				(error: unknown) => {
					paint.cancels.delete(cancel);
					reject(error);
				},
			);
		});
	}

	/** This stream's own work, started when a stream's first message comes and left behind when its generation goes. */
	#paintFor(): StreamPaint {
		const paint = this.#paint;
		if (paint && !paint.dropped && paint.generation === this.#cleared) return paint;
		const made: StreamPaint = {
			generation: this.#cleared,
			dropped: false,
			showing: false,
			jobs: new Set(),
			size: null,
			chain: Promise.resolve(),
			cancels: new Set(),
			decoding: 0,
			waiting: [],
			held: new Set(),
			bytes: 0,
			pixels: 0,
		};
		this.#paint = made;
		return made;
	}

	/** The stream whose work this was is over: its queue goes, everyone waiting for one of its turns is let go at once
	 * (so nothing of the next stream waits behind it), and each of its pictures is closed as it lands. */
	#dropPaint(): void {
		const paint = this.#paint;
		this.#paint = null;
		if (!paint || paint.dropped) return;
		paint.dropped = true;
		// The size was this stream's own and goes with it; nothing else ever read it.
		paint.size = null;
		if (paint.showing) this.#handBack();
		else this.#streamCanvas.hidden = true;
		// Anything of this stream still waiting its turn in the stream's own order is let through to be dropped: a later
		// message starts on a settled chain, and every message already waiting — on a decode or on the one before it —
		// answers now, because each of those awaits is raced against the stream's end.
		paint.chain = Promise.resolve();
		for (const cancel of paint.cancels) cancel();
		paint.cancels.clear();
		// What its jobs had already decoded is closed now, not left behind a sibling that may never finish.
		for (const job of paint.jobs) this.#dispose(job);
		paint.jobs.clear();
		for (const waiting of paint.waiting.splice(0)) waiting();
		paint.held.clear();
		paint.bytes = 0;
		paint.pixels = 0;
	}

	/**
	 * The live picture's pixels are up and its stream is over: the window's own canvas takes the screen back. Its last
	 * frame is copied onto that canvas FIRST, inside the painter like every other write, so the picture does not jump
	 * back in time to the look taken before the stream began — which, with the looks paused all the while, can be
	 * minutes old (review r7 F2 of #1746). Then the two are swapped, the keyboard moving with them, and the picture is
	 * marked as being updated rather than live: it is the screen as it was a moment ago, and the window asks for a
	 * whole fresh look at this same moment.
	 */
	#handBack(): void {
		const from = this.#streamCanvas;
		const { width, height } = from;
		// The stream's last frame is the newest picture the window has: a look of its own still decoding began before
		// it, so it may no longer land, however late it decodes, nor say the older screen is live (the v245 release
		// review F2). The fresh look the window asks for now is newer still, and lands.
		this.#lookTurn++;
		void this.#commit(this.#job(), () => {
			// Nothing writes that canvas between the drop and here (its stream is gone, and a new stream's own size
			// message is committed after this one), but a size that moved all the same is not copied.
			const copy = width > 0 && height > 0 && from.width === width && from.height === height;
			if (copy) {
				if (this.#canvas.width !== width) this.#canvas.width = width;
				if (this.#canvas.height !== height) this.#canvas.height = height;
				this.#canvas.getContext("2d")?.drawImage(from, 0, 0);
				this.#looked = true;
			}
			this.#swap(this.#canvas, from);
			// Were the live picture's the only pixels this view ever had and the copy did not happen, there is nothing
			// of its own to fall back to: it shows no picture until the first look lands.
			if (this.#shown && !this.#looked) {
				this.#shown = false;
				this.el.hidden = true;
				this.#enter.disabled = true;
				this.#mark.hidden = true;
			} else this.updating();
			return copy ? "drawn" : "dropped";
		});
	}

	/** What the current stream keeps besides its pending work: its jobs and its waits under way. Both go back to none
	 * once its messages are drawn, however many there were (the v245 release review). Read by the tests and nothing
	 * else. */
	get retained(): { readonly jobs: number; readonly waits: number } {
		const paint = this.#paint;
		return { jobs: paint?.jobs.size ?? 0, waits: paint?.cancels.size ?? 0 };
	}

	/** Whether pixels of the live picture are on the canvas: until they are, the window keeps its own pictures. */
	get streaming(): boolean {
		return this.#paint?.showing === true;
	}

	/** Waits for one of this stream's MAX_DECODING turns; a dropped stream's waiters are let go at once, and each of them
	 * then skips its decode (review r5 F1 of #1746: letting them go must not start the whole backlog decoding). */
	#turnToDecode(paint: StreamPaint): Promise<void> {
		if (paint.dropped || paint.decoding < MAX_DECODING) {
			paint.decoding++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => paint.waiting.push(resolve));
	}

	/** One area of this stream finished decoding: the next of ITS areas takes the turn. */
	#decoded(paint: StreamPaint): void {
		const next = paint.waiting.shift();
		if (next) next();
		else paint.decoding--;
	}

	/** What the live picture holds right now: its messages, their PNG bytes, their decoded pixels and the areas decoding
	 * at this moment, all of the current stream alone (review r3 F1 and r4 F1 of #1746). Read by the tests and nothing
	 * else; a dropped stream's work counts for nothing here, since no later stream waits for it. */
	get pending(): {
		readonly messages: number;
		readonly bytes: number;
		readonly pixels: number;
		readonly decoding: number;
	} {
		const paint = this.#paint;
		if (!paint || paint.dropped) return { messages: 0, bytes: 0, pixels: 0, decoding: 0 };
		return { messages: paint.held.size, bytes: paint.bytes, pixels: paint.pixels, decoding: paint.decoding };
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

	/**
	 * The live picture ended (20260930745000): its canvas is hidden and the window's own picture is what shows again
	 * (review r6 of #1746), and that stream's work is dropped — its queue goes, everyone waiting for one of its decoding turns is let go, and
	 * each of its pictures is closed as it lands, so a replacement shares nothing with it and waits for none of it
	 * (review r2 F4 and r4 F1 of #1746).
	 */
	streamEnded(): void {
		this.#cleared++;
		this.#dropPaint();
	}

	/** No picture any more: the view goes away, and the panel's state text shows. */
	clear(): void {
		this.capture(null);
		// The erase is the newest look of the window's own: a look still decoding is dropped at its commit.
		this.#lookTurn++;
		this.#cleared++;
		this.#dropPaint();
		this.back();
		this.#shown = false;
		this.el.hidden = true;
		this.#enter.disabled = true;
		this.#mark.hidden = true;
		this.#hint.textContent = "";
		// Erasing is a write like any other and goes through the painter. Only the window's own canvas is erased here:
		// the live picture's was dropped above with its stream, is hidden, and is emptied by the next stream's own size.
		const turn = this.#lookTurn;
		void this.#commit(this.#job(), () => {
			if (turn !== this.#lookTurn) return "dropped";
			this.#canvas.getContext("2d")?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
			this.#looked = false;
			return "drawn";
		});
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
		this.#lookTurn++;
		this.#cleared++;
		this.#dropPaint();
		this.el.remove();
	}

	#setEntered(value: boolean): void {
		if (this.#entered === value) return;
		this.#entered = value;
		this.el.classList.toggle("screen-viewer-entered", value);
		// Moving the controls must not drop the keyboard from a control that had it.
		const focused = this.#controls?.contains(document.activeElement) ? document.activeElement : null;
		this.#placeControls();
		if (focused instanceof HTMLElement) focused.focus();
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
