import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/** Native modal focus containment works for both desktop popovers and mobile
 * sheets. Disposal never restores focus into a different route or account. */
export class SurfaceDialog {
	readonly el: HTMLDialogElement;
	readonly content = h("div", { class: "surface-dialog-content" });
	readonly #previous: HTMLElement | null;
	readonly #onClose: () => void;
	#closed = false;
	constructor(label: string, className: string, onClose: () => void) {
		this.#previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this.#onClose = onClose;
		this.el = h(
			"dialog",
			{ class: `surface-dialog ${className}`, "aria-label": label },
			h(
				"button",
				{
					type: "button",
					class: "surface-close icon-button",
					"aria-label": `Close ${label.toLowerCase()}`,
					onclick: () => this.close(),
				},
				icon("close"),
			),
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
			if (matchesKey(event, "tab")) {
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
		this.el.showModal();
	}
	close(restoreFocus = true): void {
		if (this.#closed) return;
		this.#closed = true;
		this.el.close();
		this.el.remove();
		this.#onClose();
		if (restoreFocus && this.#previous?.isConnected) this.#previous.focus({ preventScroll: true });
	}
}
