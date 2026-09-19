import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/** Anchored desktop details are nonmodal; mobile sheets and previews retain
 * native modal containment. Disposal never restores focus into another route. */
export class SurfaceDialog {
	readonly el: HTMLDialogElement;
	readonly content = h("div", { class: "surface-dialog-content" });
	/** The top-right controls. A view may add its own buttons before Close. */
	readonly tools: HTMLElement;
	readonly #close: HTMLButtonElement;
	readonly #previous: HTMLElement | null;
	readonly #onClose: () => void;
	readonly #anchor: HTMLElement | undefined;
	readonly #lifetime = new AbortController();
	#modal = true;
	#closed = false;
	constructor(label: string, className: string, onClose: () => void, anchor?: HTMLElement) {
		this.#previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this.#onClose = onClose;
		this.#anchor = anchor;
		this.#close = h(
			"button",
			{
				type: "button",
				class: "surface-close icon-button",
				"aria-label": `Close ${label.toLowerCase()}`,
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
		this.#close.focus({ preventScroll: true });
	}
	#layout(): void {
		const modal = !this.#anchor || window.innerWidth <= 760;
		if (!this.el.open || modal !== this.#modal) {
			if (this.el.open) this.el.close();
			this.#modal = modal;
			this.el.setAttribute("aria-modal", String(modal));
			if (modal) this.el.showModal();
			else this.el.show();
		}
		if (this.#anchor && !modal) {
			const rect = this.#anchor.getBoundingClientRect();
			this.el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - this.el.getBoundingClientRect().width - 12))}px`;
			this.el.style.top = `${rect.bottom + 8}px`;
		} else {
			this.el.style.removeProperty("left");
			this.el.style.removeProperty("top");
		}
	}
	close(restoreFocus = true): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#lifetime.abort();
		this.el.close();
		this.el.remove();
		this.#onClose();
		if (restoreFocus && this.#previous?.isConnected) this.#previous.focus({ preventScroll: true });
	}
}

/** The heading of a page shown inside a dialog: the way back, a title and an
 * optional line under it. */
export function dialogPageHeader(title: string, back?: () => void, backLabel = "Back", detail?: string): HTMLElement {
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
