import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { isPhoneLayout } from "./layout.ts";
import { t } from "./preferences.ts";
import { uiScale } from "./scale.ts";

/** Anchored desktop details are nonmodal; mobile sheets and previews retain
 * native modal containment. Disposal never restores focus into another route. */
export class SurfaceDialog {
	readonly el: HTMLDialogElement;
	readonly content = h("div", { class: "surface-dialog-content" });
	/** The top-right controls. A view may add its own buttons before Close. */
	readonly tools: HTMLElement;
	readonly #close: HTMLButtonElement;
	readonly #previous: HTMLElement | null;
	/** Where focus goes back when what had it left the page meanwhile (a rail row rebuilt while the card was open). */
	findOpener: (() => HTMLElement | null) | undefined;
	readonly #onClose: () => void;
	readonly #anchor: HTMLElement | undefined;
	/** Under the anchor (a title), or beside it (a row in the rail). */
	readonly #beside: boolean;
	/** Where the anchor last stood, for when the rail has rebuilt it (its agent started working). */
	#anchorRect: DOMRect | undefined;
	readonly #lifetime = new AbortController();
	#modal = true;
	#closed = false;
	constructor(
		label: string,
		className: string,
		onClose: () => void,
		anchor?: HTMLElement,
		placement: "below" | "beside" = "below",
	) {
		this.#previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this.#onClose = onClose;
		this.#anchor = anchor;
		this.#beside = placement === "beside";
		this.#close = h(
			"button",
			{
				type: "button",
				class: "surface-close icon-button",
				"aria-label": t("Close {name}", { name: label.toLowerCase() }),
				onclick: () => this.close(),
			},
			icon("close"),
		);
		this.tools = h("div", { class: "surface-tools" }, this.#close);
		// Focusable itself, so a field left with Enter or Escape keeps focus in the dialog.
		this.el = h(
			"dialog",
			{ class: `surface-dialog ${className}`, "aria-label": label, tabindex: "-1" },
			this.tools,
			this.content,
		);
		this.el.addEventListener("cancel", (event) => {
			event.preventDefault();
			this.close();
		});
		this.el.addEventListener("click", (event) => {
			if (event.target === this.el) this.close();
		});
		this.el.addEventListener("keydown", (event) => {
			if (this.#modal && matchesKey(event, "tab")) {
				const controls = [
					...this.el.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]"),
				].filter(
					(control) =>
						control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0,
				);
				const first = controls[0],
					last = controls[controls.length - 1];
				if (
					!this.el.contains(document.activeElement) ||
					document.activeElement === this.el ||
					document.activeElement === (event.shiftKey ? first : last)
				) {
					event.preventDefault();
					(event.shiftKey ? last : first)?.focus();
				}
			}
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			}
		});
	}
	open(): void {
		document.body.append(this.el);
		this.#layout();
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (
					!this.#modal &&
					event.target instanceof Node &&
					!this.el.contains(event.target) &&
					!this.#anchor?.contains(event.target)
				)
					this.close(false);
			},
			{ signal: this.#lifetime.signal },
		);
		window.addEventListener("resize", () => this.#layout(), { signal: this.#lifetime.signal });
		window.addEventListener("qorpera-rail-resize", () => this.#layout(), { signal: this.#lifetime.signal });
		// A card beside a row stays inside the window when it grows (a longer description, an error line).
		if (this.#beside && typeof ResizeObserver !== "undefined") {
			const sizes = new ResizeObserver(() => this.#layout());
			sizes.observe(this.el);
			this.#lifetime.signal.addEventListener("abort", () => sizes.disconnect());
		}
		this.#close.focus({ preventScroll: true });
	}
	#layout(): void {
		const modal = !this.#anchor || isPhoneLayout();
		if (!this.el.open || modal !== this.#modal) {
			if (this.el.open) this.el.close();
			this.#modal = modal;
			this.el.setAttribute("aria-modal", String(modal));
			if (modal) this.el.showModal();
			else this.el.show();
		}
		// A row the rail rebuilt meanwhile is gone: the card keeps to where it stood, still inside the window as it grows.
		if (this.#anchor?.isConnected) this.#anchorRect = this.#anchor.getBoundingClientRect();
		if (this.#anchor && !modal && this.#beside && this.#anchorRect) {
			// Level with the row's top, kept inside the window as the card grows.
			const rect = this.#anchorRect;
			const scale = uiScale();
			const box = this.el.getBoundingClientRect();
			this.el.style.left = `${Math.min(rect.right + 8 * scale, window.innerWidth - box.width - 12 * scale)}px`;
			this.el.style.top = `${Math.max(12 * scale, Math.min(rect.top - 8 * scale, window.innerHeight - box.height - 12 * scale))}px`;
			this.el.style.maxHeight = `${window.innerHeight - 24 * scale}px`;
		} else if (this.#anchor && !modal && this.#anchorRect) {
			const rect = this.#anchorRect;
			const scale = uiScale();
			this.el.style.left = `${Math.max(12 * scale, Math.min(rect.left, window.innerWidth - this.el.getBoundingClientRect().width - 12 * scale))}px`;
			this.el.style.top = `${rect.bottom + 8 * scale}px`;
			this.el.style.maxHeight = `${Math.max(0, window.innerHeight - rect.bottom - 24 * scale)}px`;
		} else {
			this.el.style.removeProperty("left");
			this.el.style.removeProperty("top");
			this.el.style.removeProperty("max-height");
		}
	}
	close(restoreFocus = true): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#lifetime.abort();
		this.el.close();
		this.el.remove();
		this.#onClose();
		if (!restoreFocus) return;
		if (this.#previous?.isConnected) this.#previous.focus({ preventScroll: true });
		else if (this.#previous) this.findOpener?.()?.focus({ preventScroll: true });
	}
}

/** The heading of a page shown inside a dialog: the way back, a title and an
 * optional line under it. */
export function dialogPageHeader(
	title: string,
	back?: () => void,
	backLabel = t("Back"),
	detail?: string,
): HTMLElement {
	return h(
		"header",
		{ class: "dialog-page-header" },
		back
			? h(
					"button",
					{
						type: "button",
						class: "icon-button dialog-page-back",
						title: backLabel,
						"aria-label": backLabel,
						onclick: back,
					},
					icon("back"),
				)
			: null,
		h("div", { class: "dialog-page-title" }, h("h2", null, title), detail ? h("p", null, detail) : null),
	);
}
