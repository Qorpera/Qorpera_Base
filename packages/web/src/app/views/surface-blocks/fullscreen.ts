import { SurfaceDialog } from "../../../ui/dialog.ts";
import { h, icon } from "../../../ui/dom.ts";
import { matchesKey } from "../../../ui/keys.ts";
import { t } from "../../../ui/preferences.ts";

export interface StudioVisualItem {
	readonly title: string;
	readonly render: () => HTMLElement;
}

export type StudioFullscreenContentVariant = "doc" | "wide" | "frame" | "mark";
export type StudioFullscreenHostedVariant = "stage" | "frame";

interface HostedState {
	readonly node: HTMLElement;
	returnTo: HTMLElement;
}

export function expandButton(title: string, onOpen: () => void): HTMLButtonElement {
	const label = t("Show {name} large", { name: title });
	return h(
		"button",
		{
			type: "button",
			class: "icon-button studio-expand-btn",
			"data-act": "studio-expand",
			title: label,
			"aria-label": label,
			onclick: onOpen,
		},
		icon("expand"),
	);
}

export class StudioFullscreen {
	#dialog: SurfaceDialog | undefined;
	#hosted: HostedState | undefined;

	constructor(signal: AbortSignal) {
		signal.addEventListener("abort", () => this.close(false), { once: true });
	}

	openMedia(items: readonly StudioVisualItem[], startIndex: number): void {
		if (items.length === 0) return;
		this.close(false);
		let at = Math.max(0, Math.min(items.length - 1, startIndex));
		const heading = h("h2", null);
		const count = h("span", { class: "studio-fullscreen-count", "aria-live": "polite" });
		const stage = h("div", { class: "studio-fullscreen-media-stage" });
		const dialog = new SurfaceDialog(items[at]!.title, "studio-fullscreen-dialog is-media", () => {
			if (this.#dialog === dialog) this.#dialog = undefined;
		});
		this.#dialog = dialog;
		const step = (by: number) => {
			const next = at + by;
			if (next < 0 || next >= items.length) return;
			at = next;
			show();
		};
		const previous = h(
			"button",
			{
				type: "button",
				class: "studio-fullscreen-nav is-previous",
				"aria-label": t("Previous image"),
				onclick: () => step(-1),
			},
			icon("chevron"),
		);
		const next = h(
			"button",
			{
				type: "button",
				class: "studio-fullscreen-nav is-next",
				"aria-label": t("Next image"),
				onclick: () => step(1),
			},
			icon("chevron"),
		);
		const show = () => {
			const current = items[at]!;
			heading.textContent = current.title;
			dialog.el.setAttribute("aria-label", current.title);
			dialog.tools
				.querySelector(".surface-close")
				?.setAttribute("aria-label", t("Close {name}", { name: current.title.toLowerCase() }));
			previous.hidden = next.hidden = items.length < 2;
			previous.disabled = at === 0;
			next.disabled = at === items.length - 1;
			count.textContent =
				items.length > 1 ? t("{index} of {count}", { index: String(at + 1), count: String(items.length) }) : "";
			stage.replaceChildren(current.render());
		};
		dialog.el.addEventListener("keydown", (event) => {
			if (event.altKey || event.ctrlKey || event.metaKey || items.length < 2) return;
			if (matchesKey(event, "left")) {
				event.preventDefault();
				step(-1);
			} else if (matchesKey(event, "right")) {
				event.preventDefault();
				step(1);
			}
		});
		dialog.content.append(
			h("div", { class: "studio-fullscreen-head" }, heading, count),
			h("div", { class: "studio-fullscreen-media-body" }, previous, stage, next),
		);
		show();
		dialog.open();
	}

	openContent(title: string, build: () => HTMLElement, variant: StudioFullscreenContentVariant): void {
		this.close(false);
		const dialog = new SurfaceDialog(title, `studio-fullscreen-dialog is-${variant}`, () => {
			if (this.#dialog === dialog) this.#dialog = undefined;
		});
		this.#dialog = dialog;
		dialog.content.append(
			h("div", { class: "studio-fullscreen-head" }, h("h2", null, title)),
			h("div", { class: "studio-fullscreen-body" }, build()),
		);
		dialog.open();
	}

	openHosted(title: string, node: HTMLElement, returnTo: HTMLElement, variant: StudioFullscreenHostedVariant): void {
		this.close(false);
		const hosted: HostedState = { node, returnTo };
		this.#hosted = hosted;
		const dialog = new SurfaceDialog(title, `studio-fullscreen-dialog is-${variant}`, () => {
			if (this.#hosted === hosted) {
				this.#hosted = undefined;
				if (hosted.returnTo.isConnected) hosted.returnTo.append(hosted.node);
			}
			if (this.#dialog === dialog) this.#dialog = undefined;
		});
		this.#dialog = dialog;
		dialog.content.append(
			h("div", { class: "studio-fullscreen-head" }, h("h2", null, title)),
			h("div", { class: "studio-fullscreen-body" }, node),
		);
		dialog.open();
	}

	isHosting(node: HTMLElement): boolean {
		return this.#hosted?.node === node;
	}

	setReturnTarget(node: HTMLElement, returnTo: HTMLElement): void {
		if (this.#hosted?.node === node) this.#hosted.returnTo = returnTo;
	}

	closeIfHosting(node: HTMLElement): void {
		if (this.#hosted?.node === node) this.close(false);
	}

	close(restoreFocus = false): void {
		const dialog = this.#dialog;
		if (!dialog) return;
		this.#dialog = undefined;
		dialog.close(restoreFocus);
	}
}
