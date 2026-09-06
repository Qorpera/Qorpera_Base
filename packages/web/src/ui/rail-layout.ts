import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/** Only a browser layout preference. Company navigation remains canonical. */
export class RailLayout {
	readonly el: HTMLElement;
	readonly #frame: HTMLElement;
	readonly #lifetime = new AbortController();
	#width = 304;
	#expanded = 304;
	#dragging = false;
	constructor(frame: HTMLElement) {
		this.#frame = frame;
		try {
			const width = Number(localStorage.getItem("qorpera.web.rail-width"));
			if (width === 80 || (width >= 240 && width <= 380)) this.#width = width;
		} catch {
			/* Browser storage is optional. */
		}
		if (this.#width > 80) this.#expanded = this.#width;
		this.el = h("div", {
			class: "rail-resizer",
			role: "separator",
			tabindex: "0",
			"aria-label": "Resize company navigation",
			"aria-orientation": "vertical",
			"aria-valuemin": "80",
			"aria-valuemax": "380",
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
			this.#set(width < 160 ? 80 : Math.max(240, Math.min(380, width)), false);
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
		this.el.addEventListener("dblclick", () => this.#set(304));
		this.el.addEventListener("keydown", (event) => {
			let width: number | undefined;
			if (matchesKey(event, "left")) width = this.#width <= 240 ? 80 : this.#width - 16;
			if (matchesKey(event, "right")) width = this.#width === 80 ? 240 : this.#width + 16;
			if (matchesKey(event, "first")) width = 80;
			if (matchesKey(event, "last")) width = 380;
			if (matchesKey(event, "accept")) width = 304;
			if (width !== undefined) {
				event.preventDefault();
				this.#set(width === 80 ? 80 : Math.max(240, Math.min(380, width)));
			}
		});
		frame.addEventListener(
			"click",
			(event) => {
				if (event.target instanceof Element && event.target.closest("[data-toggle-rail]"))
					this.#set(this.#width === 80 ? this.#expanded : 80);
			},
			{ signal: this.#lifetime.signal },
		);
		this.#set(this.#width, false);
	}
	#set(width: number, persist = true): void {
		this.#width = Math.round(width);
		if (width > 80) this.#expanded = this.#width;
		this.#frame.style.setProperty("--rail-width", `${this.#width}px`);
		this.#frame.classList.toggle("rail-compact", width === 80);
		this.el.setAttribute("aria-valuenow", String(this.#width));
		this.el.setAttribute("aria-valuetext", width === 80 ? "Compact" : `${this.#width} pixels`);
		if (persist) {
			try {
				localStorage.setItem("qorpera.web.rail-width", String(this.#width));
			} catch {
				/* Layout still works for this window. */
			}
		}
		window.dispatchEvent(new Event("qorpera-rail-resize"));
	}
	dispose(): void {
		this.#lifetime.abort();
		this.el.remove();
		this.#frame.classList.remove("rail-resizing");
	}
}
