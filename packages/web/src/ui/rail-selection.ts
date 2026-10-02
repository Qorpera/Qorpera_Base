/* The rail's selection slides: when another conversation is opened, the blue
 * highlight travels from the row it was on to the new one, taking that row's
 * shape on the way (the Co-Founder card, a pinned card, a row). A ghost of the
 * highlight runs under the rows (styles/motion.css) while the new row's own
 * background waits for it. */

import { easing, reducedMotion } from "./motion.ts";

const SELECTED = ":is(.rail-row, .rail-pin, .cofounder-home).active";

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
	radius: string;
}

/** A box in the list's scrolled content, so it holds while the list scrolls. */
function boxIn(list: HTMLElement, rect: DOMRect, radius: string): Box {
	const frame = list.getBoundingClientRect();
	return {
		left: rect.left - frame.left + list.scrollLeft,
		top: rect.top - frame.top + list.scrollTop,
		width: rect.width,
		height: rect.height,
		radius,
	};
}

function frame(box: Box): Keyframe {
	return {
		left: `${box.left}px`,
		top: `${box.top}px`,
		width: `${box.width}px`,
		height: `${box.height}px`,
		borderRadius: box.radius,
	};
}

export class RailSelection {
	readonly ghost: HTMLElement;
	#from: Box | undefined;
	#target: HTMLElement | undefined;
	#animation: Animation | undefined;
	/** Where the travelling highlight is headed. */
	#to: Box | undefined;

	constructor() {
		this.ghost = document.createElement("div");
		this.ghost.className = "rail-selection-ghost";
		this.ghost.setAttribute("aria-hidden", "true");
	}

	/** The ghost while it travels: the list keeps it as its last child. */
	get moving(): HTMLElement | undefined {
		return this.#animation ? this.ghost : undefined;
	}

	/** Before the rail redraws: where the highlight stands on screen now. */
	measure(list: HTMLElement): void {
		this.#from = undefined;
		if (this.#animation && this.ghost.isConnected) {
			this.#from = boxIn(list, this.ghost.getBoundingClientRect(), getComputedStyle(this.ghost).borderRadius);
			return;
		}
		const selected = list.querySelector<HTMLElement>(SELECTED);
		if (selected?.isConnected && selected.offsetParent)
			this.#from = boxIn(list, selected.getBoundingClientRect(), getComputedStyle(selected).borderRadius);
	}

	/** After the redraw: slides from where it stood to the row now selected. */
	move(list: HTMLElement): void {
		const from = this.#from;
		this.#from = undefined;
		const target = list.querySelector<HTMLElement>(SELECTED) ?? undefined;
		// Already on its way there, unless the row moved meanwhile (a new row above it): then it re-aims.
		if (target === this.#target && this.#animation && target?.offsetParent) {
			const now = boxIn(list, target.getBoundingClientRect(), this.#to?.radius ?? "");
			if (this.#to && Math.abs(now.top - this.#to.top) < 1 && Math.abs(now.left - this.#to.left) < 1) return;
		}
		if (!from || !target?.offsetParent || reducedMotion() || typeof this.ghost.animate !== "function") {
			this.#finish();
			return;
		}
		const to = boxIn(list, target.getBoundingClientRect(), getComputedStyle(target).borderRadius);
		if (Math.abs(to.top - from.top) < 1 && Math.abs(to.left - from.left) < 1) {
			this.#finish();
			return;
		}
		this.#finish();
		this.#target = target;
		this.#to = to;
		target.classList.add("selection-arriving");
		if (this.ghost.parentElement !== list) list.append(this.ghost);
		const distance = Math.hypot(to.top - from.top, to.left - from.left);
		// Farther goes a little longer, but never drags.
		const duration = Math.min(460, 300 + distance * 0.25);
		const keyframes = [frame(from), frame(to)];
		const animation = this.ghost.animate(keyframes, { duration, easing: easing("--ease-spring"), fill: "both" });
		this.#animation = animation;
		// Ended or cancelled from outside: either way the row gets its own background back.
		const settle = () => {
			if (this.#animation === animation) this.#finish();
		};
		animation.finished.then(settle, settle);
	}

	#finish(): void {
		this.#target?.classList.remove("selection-arriving");
		this.#target = undefined;
		const animation = this.#animation;
		this.#animation = undefined;
		animation?.cancel();
		this.ghost.remove();
	}
}
