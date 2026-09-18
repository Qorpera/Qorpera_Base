import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";

const COMPACT = 80;
const MIN = 240;
/** Half again the desktop's 304px rail. */
const DEFAULT = 456;
/** The rail may take at most two fifths of the window, a touch wider than a Messages sidebar. */
const MAX_SHARE = 0.4;

/** Only a browser layout preference. Company navigation remains canonical. */
export class RailLayout {
	readonly el: HTMLElement;
	readonly #frame: HTMLElement;
	readonly #lifetime = new AbortController();
	/** What the member last chose; the shown width is this, clamped to the window. */
	#preferred = DEFAULT;
	#width = DEFAULT;
	#max = 0;
	#dragging = false;
	#dragged = false;
	constructor(frame: HTMLElement) {
		this.#frame = frame;
		try {
			const width = Number(localStorage.getItem("qorpera.web.rail-width"));
			if (Number.isFinite(width) && (width === COMPACT || width >= MIN)) this.#preferred = width;
		} catch {
			/* Browser storage is optional. */
		}
		this.el = h("div", {
			class: "rail-resizer",
			role: "separator",
			tabindex: "0",
			"aria-label": "Resize company navigation",
			"aria-orientation": "vertical",
			"aria-valuemin": String(COMPACT),
		});
		this.el.addEventListener("pointerdown", (event) => {
			if (event.button !== 0 || window.innerWidth <= 760) return;
			event.preventDefault();
			this.#dragging = true;
			this.#dragged = false;
			this.el.setPointerCapture(event.pointerId);
			frame.classList.add("rail-resizing");
		});
		this.el.addEventListener("pointermove", (event) => {
			if (!this.#dragging) return;
			const width = event.clientX - frame.getBoundingClientRect().left;
			this.#dragged = true;
			this.#set(width < 160 ? COMPACT : width, false);
		});
		const finish = () => {
			if (!this.#dragging) return;
			this.#dragging = false;
			frame.classList.remove("rail-resizing");
			// A click that never moved is not a choice; leave the preference alone.
			if (this.#dragged) this.#persist();
		};
		this.el.addEventListener("pointerup", finish);
		this.el.addEventListener("pointercancel", finish);
		this.el.addEventListener("lostpointercapture", finish);
		this.el.addEventListener("dblclick", () => this.#set(DEFAULT));
		this.el.addEventListener("keydown", (event) => {
			let width: number | undefined;
			if (matchesKey(event, "left")) width = this.#width <= MIN ? COMPACT : this.#width - 16;
			if (matchesKey(event, "right")) width = this.#width === COMPACT ? MIN : this.#width + 16;
			if (matchesKey(event, "first")) width = COMPACT;
			if (matchesKey(event, "last")) width = this.#cap();
			if (matchesKey(event, "accept")) width = DEFAULT;
			if (width !== undefined) {
				event.preventDefault();
				this.#set(width);
			}
		});
		// The frame fills the window, so the window is what the cap follows.
		window.addEventListener("resize", () => this.#apply(), { signal: this.#lifetime.signal });
		this.#apply();
	}
	/** Two fifths of the window, but never below the narrowest expanded rail. */
	#cap(): number {
		return Math.max(MIN, Math.floor(window.innerWidth * MAX_SHARE));
	}
	/** A choice the member makes now is bounded by what they can see now. */
	#set(width: number, persist = true): void {
		const next = width === COMPACT ? COMPACT : Math.round(Math.max(MIN, Math.min(this.#cap(), width)));
		// An action that moves nothing on screen is not a choice either.
		if (next === this.#width) return;
		this.#preferred = next;
		this.#apply();
		if (persist) this.#persist();
	}
	#persist(): void {
		try {
			localStorage.setItem("qorpera.web.rail-width", String(this.#preferred));
		} catch {
			/* Layout still works for this window. */
		}
	}
	#apply(): void {
		const max = this.#cap();
		const width = Math.min(this.#preferred, max);
		if (width === this.#width && max === this.#max) return;
		this.#width = width;
		this.#max = max;
		this.#frame.style.setProperty("--rail-width", `${width}px`);
		this.#frame.classList.toggle("rail-compact", width === COMPACT);
		this.el.setAttribute("aria-valuemax", String(max));
		this.el.setAttribute("aria-valuenow", String(width));
		this.el.setAttribute("aria-valuetext", width === COMPACT ? "Compact" : `${width} pixels`);
		window.dispatchEvent(new Event("qorpera-rail-resize"));
	}
	dispose(): void {
		this.#lifetime.abort();
		this.el.remove();
		this.#frame.classList.remove("rail-resizing");
	}
}
