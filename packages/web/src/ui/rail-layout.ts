import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { isPhoneLayout } from "./layout.ts";
import { t } from "./preferences.ts";

const COMPACT = 80;
const MIN = 240;
/** Half again the desktop's 304px rail. */
const DEFAULT = 456;
/** The rail may take at most two fifths of the window, a touch wider than a Messages sidebar. */
const MAX_SHARE = 0.4;
/** Version 2 came with the 456px default: widths stored before it are not carried over,
 * so every member starts once from the new default. */
const STORAGE_KEY = "qorpera.web.rail-width.v2";

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
			const width = Number(localStorage.getItem(STORAGE_KEY));
			if (Number.isFinite(width) && (width === COMPACT || width >= MIN)) this.#preferred = width;
		} catch {
			/* Browser storage is optional. */
		}
		this.el = h("div", {
			class: "rail-resizer",
			role: "separator",
			tabindex: "0",
			"aria-label": t("Resize company navigation"),
			"aria-orientation": "vertical",
			"aria-valuemin": String(COMPACT),
		});
		this.el.addEventListener("pointerdown", (event) => {
			if (event.button !== 0 || isPhoneLayout()) return;
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
		const drawer = isPhoneLayout();
		if (width === this.#width && max === this.#max && drawer === this.#drawer) return;
		this.#width = width;
		this.#max = max;
		this.#drawer = drawer;
		// --rail-width does not inherit (app.css), so each of its two readers carries its own value.
		this.#rail.style.setProperty("--rail-width", `${width}px`);
		this.el.style.setProperty("--rail-width", `${width}px`);
		// Collapsed only where the rail stands beside the page; the drawer always shows it whole.
		this.#frame.classList.toggle("rail-compact", width === COMPACT && !drawer);
		this.el.setAttribute("aria-valuemax", String(max));
		this.el.setAttribute("aria-valuenow", String(width));
		this.el.setAttribute("aria-valuetext", width === COMPACT ? t("Compact") : t("{width} pixels", { width }));
		window.dispatchEvent(new Event("qorpera-rail-resize"));
	}
	/** Say the handle's name and width again in a newly chosen language. */
	relabel(): void {
		this.el.setAttribute("aria-label", t("Resize company navigation"));
		this.#apply();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.el.remove();
		this.#frame.classList.remove("rail-resizing");
	}
}
