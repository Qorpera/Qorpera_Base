import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";

const COMPACT = 80;
const MIN = 240;
const DEFAULT = 304;
/** The rail may take at most half of the window, like a wide Messages sidebar. */
const MAX_SHARE = 0.5;

/** Only a browser layout preference. Company navigation remains canonical. */
export class RailLayout {
	readonly el: HTMLElement;
	readonly #frame: HTMLElement;
	/** What the member last chose; the shown width is this, clamped to the window. */
	#preferred = DEFAULT;
	#width = DEFAULT;
	#dragging = false;
	readonly #onWindowResize = () => this.#apply();
	readonly #observer: ResizeObserver | undefined;
	constructor(frame: HTMLElement) {
		this.#frame = frame;
		try {
			const width = Number(localStorage.getItem("qorpera.web.rail-width"));
			if (width === COMPACT || width >= MIN) this.#preferred = width;
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
			this.el.setPointerCapture(event.pointerId);
			frame.classList.add("rail-resizing");
		});
		this.el.addEventListener("pointermove", (event) => {
			if (!this.#dragging) return;
			const width = event.clientX - frame.getBoundingClientRect().left;
			this.#set(width < 160 ? COMPACT : width, false);
		});
		const finish = () => {
			if (!this.#dragging) return;
			this.#dragging = false;
			frame.classList.remove("rail-resizing");
			this.#set(this.#width);
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
			if (matchesKey(event, "last")) width = this.#max();
			if (matchesKey(event, "accept")) width = DEFAULT;
			if (width !== undefined) {
				event.preventDefault();
				this.#set(width);
			}
		});
		// The cap follows the frame, so re-clamp whenever the frame changes size.
		if (typeof ResizeObserver === "function") {
			this.#observer = new ResizeObserver(() => this.#apply());
			this.#observer.observe(frame);
		} else {
			window.addEventListener("resize", this.#onWindowResize);
		}
		this.#set(this.#preferred, false);
	}
	/** Half of the frame, but never below the narrowest expanded rail. */
	#max(): number {
		const frameWidth = this.#frame.getBoundingClientRect().width || window.innerWidth;
		return Math.max(MIN, Math.floor(frameWidth * MAX_SHARE));
	}
	#set(width: number, persist = true): void {
		this.#preferred = width === COMPACT ? COMPACT : Math.round(Math.max(MIN, width));
		this.#apply();
		if (persist) {
			try {
				localStorage.setItem("qorpera.web.rail-width", String(this.#width));
			} catch {
				/* Layout still works for this window. */
			}
		}
	}
	#apply(): void {
		const max = this.#max();
		this.#width = Math.min(this.#preferred, max);
		this.#frame.style.setProperty("--rail-width", `${this.#width}px`);
		this.#frame.classList.toggle("rail-compact", this.#width === COMPACT);
		this.el.setAttribute("aria-valuemax", String(max));
		this.el.setAttribute("aria-valuenow", String(this.#width));
		this.el.setAttribute("aria-valuetext", this.#width === COMPACT ? "Compact" : `${this.#width} pixels`);
		window.dispatchEvent(new Event("qorpera-rail-resize"));
	}
	dispose(): void {
		this.#observer?.disconnect();
		window.removeEventListener("resize", this.#onWindowResize);
		this.el.remove();
		this.#frame.classList.remove("rail-resizing");
	}
}
