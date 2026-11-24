import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { isPhoneLayout } from "./layout.ts";
import { t, uiSizePreference } from "./preferences.ts";
import { uiScale } from "./scale.ts";

/* Widths here are design pixels (ui/scale.ts): the member's choice keeps its look whatever the
 * app's scale. Exported for index.html's static rail (ui/boot.ts, styles/boot.css), which a test ties to these. */
export const COMPACT = 80;
export const MIN = 240;
export const DEFAULT = 365;
export const SMALL_DEFAULT = 452;
/** The rail may take at most 44% of the window: the earlier two fifths made a tenth wider with the default. */
export const MAX_SHARE = 0.44;
export const STORAGE_KEY = "qorpera.web.rail-width.v6";
export const HIDDEN_STORAGE_KEY = "qorpera.web.rail-hidden.v1";

/** Two fifths of the window, but never below the narrowest expanded rail. */
function cap(): number {
	return Math.max(MIN, Math.floor((window.innerWidth * MAX_SHARE) / uiScale()));
}

/** The width the member chose for the rail when it is expanded, or this size's default; never more than the window
 * allows, never less than MIN. A compact rail's strip is no expanded width, and the rail keeps no other width beside
 * it, so the default stands in for it. In design pixels, so a reader outside the stylesheets multiplies by
 * `uiScale()`. The Concepts viewer's side panel reads it, so that panel is the rail's width wherever the member set it
 * (Jonas, 13 November 2026: the Concepts side panel should "match the style and width of the regular sidepanel"); the
 * panel's own fold is its own (review r1 of #1763, F2). */
export function expandedRailWidth(): number {
	let preferred: number | undefined;
	try {
		const stored = Number(localStorage.getItem(STORAGE_KEY));
		if (Number.isFinite(stored) && stored >= MIN) preferred = stored;
	} catch {
		/* Browser storage is optional. */
	}
	return Math.min(preferred ?? (uiSizePreference() === "small" ? SMALL_DEFAULT : DEFAULT), cap());
}

/** Only a browser layout preference. Company navigation remains canonical. */
export class RailLayout {
	readonly el: HTMLElement;
	readonly #frame: HTMLElement;
	readonly #rail: HTMLElement;
	readonly #lifetime = new AbortController();
	/** An explicit width, or the current size's default; shown clamped to the window. */
	#preferred: number | undefined;
	#width = DEFAULT;
	#max = 0;
	#scale = 0;
	#drawer = false;
	#hidden = false;
	#appliedHidden = false;
	#dragging = false;
	#dragged = false;
	constructor(frame: HTMLElement, rail: HTMLElement) {
		this.#frame = frame;
		this.#rail = rail;
		try {
			const width = Number(localStorage.getItem(STORAGE_KEY));
			if (Number.isFinite(width) && (width === COMPACT || width >= MIN)) this.#preferred = width;
			this.#hidden = localStorage.getItem(HIDDEN_STORAGE_KEY) === "1";
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
			const width = (event.clientX - frame.getBoundingClientRect().left) / uiScale();
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
			if (matchesKey(event, "last")) width = cap();
			if (width !== undefined) {
				event.preventDefault();
				this.#set(width);
			}
		});
		// The frame fills the window, so the window is what the cap follows.
		window.addEventListener("resize", () => this.#apply(), { signal: this.#lifetime.signal });
		// The scale changes with the primary pointer (a 2-in-1 turned into a tablet) without any resize.
		window.matchMedia?.("(pointer: coarse)")?.addEventListener?.("change", () => this.#apply(), {
			signal: this.#lifetime.signal,
		});
		this.#apply();
	}
	/** A choice the member makes now is bounded by what they can see now. */
	#set(width: number, persist = true): void {
		const next = width === COMPACT ? COMPACT : Math.round(Math.max(MIN, Math.min(cap(), width)));
		// An action that moves nothing on screen is not a choice either.
		if (next === this.#width) return;
		this.#preferred = next;
		this.#apply();
		if (persist) this.#persist();
	}
	/** Back to the default, not clamped: a narrow window shows less of it, a wide one all of it. */
	#reset(): void {
		this.#preferred = undefined;
		this.#apply();
		this.#persist();
	}
	/** The default is stored as no choice at all, so a later default reaches this member too. */
	#persist(): void {
		try {
			if (this.#preferred === undefined) localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, String(this.#preferred));
		} catch {
			/* Layout still works for this window. */
		}
	}
	get hidden(): boolean {
		return this.#hidden;
	}

	setHidden(hidden: boolean): void {
		if (this.#hidden === hidden) return;
		this.#hidden = hidden;
		try {
			if (hidden) localStorage.setItem(HIDDEN_STORAGE_KEY, "1");
			else localStorage.removeItem(HIDDEN_STORAGE_KEY);
		} catch {
			/* Layout still works for this window. */
		}
		this.#apply();
	}

	toggleHidden(): void {
		this.setHidden(!this.#hidden);
	}

	#apply(): void {
		const max = cap();
		const width = Math.min(this.#preferred ?? (uiSizePreference() === "small" ? SMALL_DEFAULT : DEFAULT), max);
		const drawer = isPhoneLayout();
		const scale = uiScale();
		const hiddenDesktop = this.#hidden && !drawer;
		if (
			width === this.#width &&
			max === this.#max &&
			drawer === this.#drawer &&
			scale === this.#scale &&
			hiddenDesktop === this.#appliedHidden
		)
			return;
		this.#width = width;
		this.#max = max;
		this.#drawer = drawer;
		this.#scale = scale;
		this.#appliedHidden = hiddenDesktop;
		// --rail-width does not inherit (app.css), so each of its two readers carries its own value.
		const shown = `${width * scale}px`;
		this.#rail.style.setProperty("--rail-width", shown);
		this.el.style.setProperty("--rail-width", shown);
		// Collapsed only where the rail stands beside the page; the drawer always shows it whole.
		this.#frame.classList.toggle("rail-compact", width === COMPACT && !drawer);
		this.#frame.classList.toggle("rail-hidden-desktop", hiddenDesktop);
		this.#rail.inert = hiddenDesktop;
		this.el.hidden = hiddenDesktop;
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
		this.#frame.classList.remove("rail-resizing", "rail-hidden-desktop");
		this.#rail.inert = false;
	}
}
