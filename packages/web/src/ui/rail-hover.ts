import { HoverGlide } from "./hover-glide.ts";

const ITEM = ".rail-row, .rail-pin, .cofounder-home, .rail-surface, .rail-agent-hub-row";
// WHY: a scheduled agent's row sits inside its wrapper with the pause button, and the wrapper is what lights.
const SCHEDULED = ".rail-agent-sched";

// WHY: the rail's dock is a window inside the list; each window lights only its own rows, under its own layer.
const WINDOW = ".rail-dock, .rail-scroll";

export class RailHover extends HoverGlide {
	constructor(root: HTMLElement, signal: AbortSignal, list = root) {
		super(root, {
			signal,
			tintClass: "rail-hover-tint",
			item: (node) => {
				const item = node.closest<HTMLElement>(SCHEDULED) ?? node.closest<HTMLElement>(ITEM) ?? undefined;
				const own = item?.closest(WINDOW);
				return own && own !== root && root.contains(own) ? undefined : item;
			},
			paused: () => list.classList.contains("rail-dragging"),
			place: (tint) => root.insertBefore(tint, root.querySelector(":scope > .rail-selection-ghost")),
		});
	}
}
