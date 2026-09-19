import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";

const motion = new WeakMap<HTMLElement, { identity?: string; cancelExit?: () => void }>();
const movement = new WeakMap<HTMLElement, Animation>();

/** Update logical state immediately; an inert copy supplies the brief exit fade.
 * Measure surviving surfaces before layout changes so their motion can be retargeted. */
export function updateNotification(
	surface: HTMLElement,
	card: HTMLElement | null,
	identity: string | undefined,
	signal: AbortSignal,
	animate = true,
): void {
	const previous = motion.get(surface);
	const current = surface.querySelector<HTMLElement>(".notification-card");
	const changed = previous?.identity !== identity;
	const stack = surface.closest<HTMLElement>(".notification-stack");
	const enabled =
		animate &&
		!signal.aborted &&
		typeof surface.animate === "function" &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (changed || !enabled) previous?.cancelExit?.();
	const siblings = stack
		? [...stack.children].filter(
				(child): child is HTMLElement =>
					child instanceof HTMLElement &&
					child !== surface &&
					!child.hidden &&
					!child.classList.contains("notification-ghost"),
			)
		: [];
	const positions = enabled ? siblings.map((element) => ({ element, top: element.getBoundingClientRect().top })) : [];
	const state: { identity?: string; cancelExit?: () => void } = previous && !changed ? previous : { identity };
	motion.set(surface, state);
	if (enabled && changed && current && stack && current.isConnected) {
		const bounds = current.getBoundingClientRect();
		const origin = stack.getBoundingClientRect();
		const ghost = current.cloneNode(true) as HTMLElement;
		ghost.classList.replace("notification-card", "notification-ghost");
		ghost.inert = true;
		ghost.setAttribute("aria-hidden", "true");
		for (const element of ghost.querySelectorAll<HTMLElement>("[id], [data-action]")) {
			element.removeAttribute("id");
			element.removeAttribute("data-action");
		}
		Object.assign(ghost.style, {
			top: `${bounds.top - origin.top}px`,
			left: `${bounds.left - origin.left}px`,
			width: `${bounds.width}px`,
		});
		stack.append(ghost);
		const exit = ghost.animate(
			[
				{ opacity: getComputedStyle(current).opacity, transform: "translateY(0) scale(1)" },
				{ opacity: 0, transform: "translateY(-4px) scale(0.985)" },
			],
			{ duration: 140, easing: "ease-out", fill: "forwards" },
		);
		const cleanup = () => {
			exit.cancel();
			ghost.remove();
			signal.removeEventListener("abort", cleanup);
			if (state.cancelExit === cleanup) state.cancelExit = undefined;
		};
		state.cancelExit = cleanup;
		signal.addEventListener("abort", cleanup, { once: true });
		void exit.finished.then(cleanup, cleanup);
	}
	if (!changed && current && card) {
		current.className = card.className;
		current.replaceChildren(...card.childNodes);
	} else surface.replaceChildren(...(card ? [card] : []));
	surface.hidden = !card;
	if (enabled && changed && card) {
		const enter = card.animate(
			[
				{ opacity: 0, transform: "translateY(-4px) scale(0.985)" },
				{ opacity: 1, transform: "translateY(0) scale(1)" },
			],
			{ duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
		);
		const cancel = () => enter.cancel();
		signal.addEventListener("abort", cancel, { once: true });
		void enter.finished.then(
			() => signal.removeEventListener("abort", cancel),
			() => signal.removeEventListener("abort", cancel),
		);
	}
	for (const { element, top } of positions) {
		movement.get(element)?.cancel();
		const offset = top - element.getBoundingClientRect().top;
		if (Math.abs(offset) < 0.5) continue;
		const slide = element.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], {
			duration: 220,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
		});
		movement.set(element, slide);
		const cancel = () => slide.cancel();
		const cleanup = () => {
			signal.removeEventListener("abort", cancel);
			if (movement.get(element) === slide) movement.delete(element);
		};
		signal.addEventListener("abort", cancel, { once: true });
		void slide.finished.then(cleanup, cleanup);
	}
}

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
			class: options.error ? "notification-card notification-error" : "notification-card",
			onkeydown: (event: KeyboardEvent) => {
				if (!matchesKey(event, "dismiss")) return;
				event.preventDefault();
				event.stopPropagation();
				(event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(".notification-close")?.click();
			},
		},
		options.error ? h("span", { class: "notification-indicator", "aria-hidden": "true" }) : null,
		h("strong", { class: "notification-title", role: options.error ? "alert" : "status" }, title),
		options.action,
		close,
	);
}
