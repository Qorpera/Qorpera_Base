import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";

const COMPACT = 80;
const MIN = 240;
/** Half again the desktop's 304px rail. */
const DEFAULT = 456;
/** The rail may take at most two fifths of the window, a touch wider than a Messages sidebar. */
const MAX_SHARE = 0.4;
/** Up to this window width the rail is a drawer (app.css), shown whole and never collapsed. */
const DRAWER_MAX = 760;
const STORAGE_KEY = "qorpera.web.rail-width.v2";
/** Where widths were stored while the default was 304px. A stored 304 there was almost
 * always a reset to that default, so it is dropped; any other width moves over once. */
const OLD_STORAGE_KEY = "qorpera.web.rail-width";
const OLD_DEFAULT = 304;

/** Only a browser layout preference. Company navigation remains canonical. */
export class RailLayout {
	readonly el: HTMLElement;
	readonly #frame: HTMLElement;
	readonly #rail: HTMLElement;
	readonly #lifetime = new AbortController();
	/** What the member last chose; the shown width is this, clamped to the window. */
	#preferred = DEFAULT;
	#width = DEFAULT;
	#max = 0;
	#drawer = false;
	#dragging = false;
	#dragged = false;
	constructor(frame: HTMLElement, rail: HTMLElement) {
		this.#frame = frame;
		this.#rail = rail;
		try {
			const old = localStorage.getItem(OLD_STORAGE_KEY);
			if (old !== null) {
				localStorage.removeItem(OLD_STORAGE_KEY);
				if (Number(old) !== OLD_DEFAULT && localStorage.getItem(STORAGE_KEY) === null)
					localStorage.setItem(STORAGE_KEY, old);
			}
			const width = Number(localStorage.getItem(STORAGE_KEY));
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
			if (event.button !== 0 || window.innerWidth <= DRAWER_MAX) return;
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
		this.el.addEventListener("dblclick", () => this.#reset());
		this.el.addEventListener("keydown", (event) => {
			if (matchesKey(event, "accept")) {
				event.preventDefault();
				this.#reset();
				return;
			}
			let width: number | undefined;
			if (matchesKey(event, "left")) width = this.#width <= MIN ? COMPACT : this.#width - 16;
			if (matchesKey(event, "right")) width = this.#width === COMPACT ? MIN : this.#width + 16;
			if (matchesKey(event, "first")) width = COMPACT;
			if (matchesKey(event, "last")) width = this.#cap();
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
	/** Back to the default, not clamped: a narrow window shows less of it, a wide one all of it. */
	#reset(): void {
		this.#preferred = DEFAULT;
		this.#apply();
		this.#persist();
	}
	/** The default is stored as no choice at all, so a later default reaches this member too. */
	#persist(): void {
		try {
			if (this.#preferred === DEFAULT) localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, String(this.#preferred));
		} catch {
			/* Layout still works for this window. */
		}
	}
	#apply(): void {
		const max = this.#cap();
		const width = Math.min(this.#preferred, max);
		const drawer = window.innerWidth <= DRAWER_MAX;
		if (width === this.#width && max === this.#max && drawer === this.#drawer) return;
		this.#width = width;
		this.#max = max;
		this.#drawer = drawer;
		// Only the rail and its edge read the width. Set on the frame, every change
		// would restyle the whole app, once per frame while the window is resized.
		this.#rail.style.setProperty("--rail-width", `${width}px`);
		this.el.style.setProperty("--rail-width", `${width}px`);
		// Collapsed only where the rail stands beside the page; the drawer always shows it whole.
		this.#frame.classList.toggle("rail-compact", width === COMPACT && !drawer);
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
