import { easing, reducedMotion } from "./motion.ts";
import { type Box, boxIn } from "./rail-selection.ts";

const ITEM = ".rail-row, .rail-pin, .cofounder-home, .rail-surface, .rail-agent-hub-row";
// WHY: a scheduled agent's row sits inside its wrapper with the pause button, and the wrapper is what lights.
const SCHEDULED = ".rail-agent-sched";
const GAP_WAIT = 100;
const LIT_CLASS = "hover-lit";

export class RailHover {
	readonly tint: HTMLElement;
	#list: HTMLElement;
	#target: HTMLElement | undefined;
	#animation: Animation | undefined;
	#to: Box | undefined;
	#leaving = 0;
	#lighting = 0;
	#removing = 0;
	#lit: HTMLElement | undefined;
	#pointer: { x: number; y: number } | undefined;

	constructor(list: HTMLElement, signal: AbortSignal) {
		this.#list = list;
		this.tint = document.createElement("div");
		this.tint.className = "rail-hover-tint";
		this.tint.setAttribute("aria-hidden", "true");
		const options = { signal };
		list.addEventListener("pointerover", (event) => this.#over(event), options);
		list.addEventListener("pointermove", (event) => this.#over(event), options);
		list.addEventListener(
			"pointerleave",
			() => {
				this.#pointer = undefined;
				this.#hide();
			},
			options,
		);
		list.addEventListener(
			"pointerdown",
			(event) => {
				if (this.#target && this.#itemOf(event.target) === this.#target) this.tint.classList.add("is-pressed");
			},
			options,
		);
		window.addEventListener("pointerup", () => this.tint.classList.remove("is-pressed"), options);
		window.addEventListener("pointercancel", () => this.tint.classList.remove("is-pressed"), options);
		signal.addEventListener("abort", () => {
			window.clearTimeout(this.#leaving);
			window.clearTimeout(this.#lighting);
			window.clearTimeout(this.#removing);
		});
	}

	get attached(): HTMLElement | undefined {
		return this.tint.parentElement === this.#list ? this.tint : undefined;
	}

	settle(): void {
		if (!this.#target) return;
		const kept = this.#target.isConnected && this.#list.contains(this.#target);
		const pointer = this.#pointer;
		const item = kept ? this.#target : pointer && this.#itemOf(document.elementFromPoint(pointer.x, pointer.y));
		if (!item || this.#list.classList.contains("rail-dragging")) {
			this.#hide(true);
			return;
		}
		this.#glideTo(item);
	}

	#itemOf(node: EventTarget | null): HTMLElement | undefined {
		if (!(node instanceof Element)) return undefined;
		const item = node.closest<HTMLElement>(SCHEDULED) ?? node.closest<HTMLElement>(ITEM);
		return item && this.#list.contains(item) ? item : undefined;
	}

	#over(event: PointerEvent): void {
		if (event.pointerType === "touch") return;
		this.#pointer = { x: event.clientX, y: event.clientY };
		if (this.#list.classList.contains("rail-dragging")) {
			this.#hide(true);
			return;
		}
		const item = this.#itemOf(event.target);
		if (!item) {
			if (this.#target && !this.#leaving) this.#leaving = window.setTimeout(() => this.#hide(), GAP_WAIT);
			return;
		}
		window.clearTimeout(this.#leaving);
		this.#leaving = 0;
		if (item !== this.#target) this.#glideTo(item);
	}

	#glideTo(item: HTMLElement): void {
		const to = this.#boxOf(item);
		if (item === this.#target && this.#animation && this.#to && sameBox(to, this.#to)) return;
		const from = this.#target ? this.#currentBox() : undefined;
		const lit = this.#lit === item && item.classList.contains(LIT_CLASS);
		this.#target = item;
		this.#animation?.cancel();
		this.#animation = undefined;
		this.#to = to;
		Object.assign(this.tint.style, frame(to));
		if (this.tint.parentElement !== this.#list) {
			this.#list.insertBefore(this.tint, this.#list.querySelector(":scope > .rail-selection-ghost"));
			// WHY: measuring commits the hidden state, so the fade-in runs on a freshly attached tint.
			this.tint.getBoundingClientRect();
		}
		window.clearTimeout(this.#removing);
		this.tint.classList.add("is-on");
		if (!from || reducedMotion() || typeof this.tint.animate !== "function") {
			this.#light(item, 0);
			return;
		}
		const distance = Math.hypot(to.left - from.left, to.top - from.top);
		if (sameBox(from, to)) {
			this.#light(item, 0);
			return;
		}
		const duration = Math.min(230, 150 + distance * 0.12);
		if (lit) this.#light(item, 0);
		else this.#light(item, duration * 0.55);
		const animation = this.tint.animate([frame(from), frame(to)], { duration, easing: easing("--ease-out") });
		this.#animation = animation;
		const done = () => {
			if (this.#animation === animation) this.#animation = undefined;
		};
		animation.finished.then(done, done);
	}

	#hide(now = false): void {
		window.clearTimeout(this.#leaving);
		this.#leaving = 0;
		if (!this.#target) return;
		if (this.#animation) {
			const box = this.#currentBox();
			this.#animation.cancel();
			this.#animation = undefined;
			Object.assign(this.tint.style, frame(box));
		}
		this.#target = undefined;
		this.tint.classList.remove("is-on", "is-pressed");
		window.clearTimeout(this.#removing);
		if (now) this.tint.remove();
		else this.#removing = window.setTimeout(() => this.tint.remove(), 160);
		this.#light(undefined, 0);
	}

	#light(item: HTMLElement | undefined, delay: number): void {
		window.clearTimeout(this.#lighting);
		if (this.#lit && this.#lit !== item) this.#lit.classList.remove(LIT_CLASS);
		this.#lit = item;
		if (!item) return;
		if (item.classList.contains("active")) {
			item.classList.remove(LIT_CLASS);
			return;
		}
		if (delay <= 0) item.classList.add(LIT_CLASS);
		else this.#lighting = window.setTimeout(() => item.classList.add(LIT_CLASS), delay);
	}

	#boxOf(item: HTMLElement): Box {
		return boxIn(this.#list, item.getBoundingClientRect(), getComputedStyle(item).borderRadius);
	}

	#currentBox(): Box {
		// WHY: the press shrink scales the rect around its centre; the layout size undoes it mid-spring too.
		const rect = this.tint.getBoundingClientRect();
		const width = this.tint.offsetWidth || rect.width;
		const height = this.tint.offsetHeight || rect.height;
		const unscaled = new DOMRect(
			rect.left + rect.width / 2 - width / 2,
			rect.top + rect.height / 2 - height / 2,
			width,
			height,
		);
		return boxIn(this.#list, unscaled, getComputedStyle(this.tint).borderRadius);
	}
}

function sameBox(a: Box, b: Box): boolean {
	return (
		Math.abs(a.left - b.left) < 1 &&
		Math.abs(a.top - b.top) < 1 &&
		Math.abs(a.width - b.width) < 1 &&
		Math.abs(a.height - b.height) < 1
	);
}

function frame(box: Box): Keyframe & Record<string, string> {
	return {
		translate: `${box.left}px ${box.top}px`,
		width: `${box.width}px`,
		height: `${box.height}px`,
		borderRadius: box.radius,
	};
}
