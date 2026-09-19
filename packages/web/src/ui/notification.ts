import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/** A non-modal, title-only notification. Escape applies only within the card. */
export function notification(
	title: string,
	dismiss: () => void,
	options: { busy?: boolean; action?: HTMLElement; error?: boolean } = {},
): HTMLElement {
	const close = h(
		"button",
		{
			type: "button",
			class: "notification-close",
			"aria-label": "Dismiss notification",
			title: "Dismiss notification",
			"data-action": "dismiss-notification",
			"aria-disabled": options.busy ? "true" : undefined,
			onclick: (event: MouseEvent) => {
				if (!options.busy && event.detail < 2) dismiss();
			},
		},
		icon("close"),
	);
	return h(
		"div",
		{
			class: "notification-card",
			onkeydown: (event: KeyboardEvent) => {
				if (!matchesKey(event, "dismiss")) return;
				event.preventDefault();
				event.stopPropagation();
				if (!options.busy) dismiss();
			},
		},
		h("strong", { class: "notification-title", role: options.error ? "alert" : "status" }, title),
		options.action,
		close,
	);
}
