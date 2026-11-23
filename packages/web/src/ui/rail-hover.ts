import { HoverGlide } from "./hover-glide.ts";

const ITEM = ".rail-row, .rail-pin, .cofounder-home, .rail-surface, .rail-agent-hub-row";
// WHY: a scheduled agent's row sits inside its wrapper with the pause button, and the wrapper is what lights.
const SCHEDULED = ".rail-agent-sched";

export class RailHover extends HoverGlide {
	constructor(list: HTMLElement, signal: AbortSignal) {
		super(list, {
			signal,
			tintClass: "rail-hover-tint",
			item: (node) => node.closest<HTMLElement>(SCHEDULED) ?? node.closest<HTMLElement>(ITEM) ?? undefined,
			paused: () => list.classList.contains("rail-dragging"),
			place: (tint) => list.insertBefore(tint, list.querySelector(":scope > .rail-selection-ghost")),
		});
	}
}
