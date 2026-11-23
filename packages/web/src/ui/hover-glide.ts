import { easing, reducedMotion } from "./motion.ts";

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
	radius: string;
}

export interface HoverGlideOptions {
	signal?: AbortSignal;
	tintClass: string;
	item(node: Element): HTMLElement | undefined;
	paused?(): boolean;
	place?(tint: HTMLElement): void;
}

const GAP_WAIT = 100;
const LIT_CLASS = "hover-lit";

export class HoverGlide {
	readonly tint: HTMLElement;
	#list: HTMLElement;
	#options: HoverGlideOptions;
	#target: HTMLElement | undefined;
	#animation: Animation | undefined;
	#to: Box | undefined;
	#leaving = 0;
	#lighting = 0;
	#removing = 0;
	#lit: HTMLElement | undefined;
	#pointer: { x: number; y: number } | undefined;

	constructor(list: HTMLElement, options: HoverGlideOptions) {
		this.#list = list;
		this.#options = options;
		this.tint = document.createElement("div");
		this.tint.className = options.tintClass;
		this.tint.setAttribute("aria-hidden", "true");
		const { signal } = options;
		list.addEventListener("pointerover", (event) => this.#over(event), { signal });
		list.addEventListener("pointermove", (event) => this.#over(event), { signal });
		list.addEventListener(
			"pointerleave",
			() => {
				this.#pointer = undefined;
				this.#hide();
			},
			{ signal },
		);
		signal?.addEventListener("abort", () => {
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
		if (!item || this.#options.paused?.()) {
			this.#hide(true);
			return;
		}
		this.#glideTo(item);
	}

	#itemOf(node: EventTarget | null): HTMLElement | undefined {
		if (!(node instanceof Element)) return undefined;
		const item = this.#options.item(node);
		return item && this.#list.contains(item) ? item : undefined;
	}

	#over(event: PointerEvent): void {
		if (event.pointerType === "touch") return;
		this.#pointer = { x: event.clientX, y: event.clientY };
		if (this.#options.paused?.()) {
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
		this.#glideTo(item);
	}

	#glideTo(item: HTMLElement): void {
		const to = this.#boxOf(item);
		if (item === this.#target && this.attached && this.#to && sameBox(to, this.#to)) {
			if (item.classList.contains("active")) item.classList.remove(LIT_CLASS);
			return;
		}
		const from = this.#target && this.attached ? this.#currentBox() : undefined;
		const lit = this.#lit === item && item.classList.contains(LIT_CLASS);
		this.#target = item;
		this.#animation?.cancel();
		this.#animation = undefined;
		this.#to = to;
		Object.assign(this.tint.style, frame(to));
		const tone = getComputedStyle(item).getPropertyValue("--glide-tint").trim();
		if (tone) this.tint.style.setProperty("--glide-tint", tone);
		else this.tint.style.removeProperty("--glide-tint");
		if (this.tint.parentElement !== this.#list) {
			if (this.#options.place) this.#options.place(this.tint);
			else this.#list.append(this.tint);
			// WHY: measuring commits the hidden state, so the fade-in runs on a freshly attached tint.
			this.tint.getBoundingClientRect();
		}
		window.clearTimeout(this.#removing);
		this.tint.classList.add("is-on");
		if (!from || reducedMotion() || typeof this.tint.animate !== "function" || sameBox(from, to)) {
			this.#light(item, 0);
			return;
		}
		const distance = Math.hypot(to.left - from.left, to.top - from.top);
		const duration = Math.min(230, 150 + distance * 0.12);
		this.#light(item, lit ? 0 : duration * 0.55);
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
		this.tint.classList.remove("is-on");
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
		return boxWithin(this.#list, item.getBoundingClientRect(), getComputedStyle(item).borderRadius);
	}

	#currentBox(): Box {
		return boxWithin(this.#list, this.tint.getBoundingClientRect(), getComputedStyle(this.tint).borderRadius);
	}
}

// WHY: a menu still scaling in is measured at full size, and its border is not part of where the tint sits.
export function boxWithin(list: HTMLElement, rect: DOMRect, radius: string): Box {
	const outer = list.getBoundingClientRect();
	const scale = list.offsetWidth > 0 && Math.abs(outer.width - list.offsetWidth) > 1 ? outer.width / list.offsetWidth : 1;
	return {
		left: (rect.left - outer.left) / scale - list.clientLeft + list.scrollLeft,
		top: (rect.top - outer.top) / scale - list.clientTop + list.scrollTop,
		width: rect.width / scale,
		height: rect.height / scale,
		radius,
	};
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

const GLIDE_ITEMS = [
	".context-menu-item",
	".composer-menu button",
	".account-item",
	".settings-nav [role=tab]",
	".settings-nav .settings-back",
	".files-row",
	".storage-recent-row",
	"button.data-row",
	".data-database",
	".routine-row",
	".bank-category-row",
	".concepts-item",
	".surface-overview-option",
	".surface-change",
	".surface-variant",
	".account-picture-item",
	".founding-friends li",
	".mailbox-pick",
].join(", ");
const DISABLED = ":disabled, [aria-disabled='true']";

const glides = new WeakMap<HTMLElement, HoverGlide>();

function glideItem(node: Element): HTMLElement | undefined {
	const item = node.closest<HTMLElement>(GLIDE_ITEMS);
	return item && !item.matches(DISABLED) ? item : undefined;
}

export function installHoverGlides(signal: AbortSignal): void {
	document.addEventListener(
		"pointerover",
		(event) => {
			if (event.pointerType === "touch" || !(event.target instanceof Element)) return;
			const item = glideItem(event.target);
			const group = item?.parentElement;
			if (!item || !group) return;
			item.classList.add("glide-item");
			if (glides.has(group)) return;
			group.classList.add("hover-glide-group");
			if (getComputedStyle(group).position === "static") group.classList.add("hover-glide-anchor");
			// WHY: capture runs before the event reaches the group, so the listeners added here still take this same pointerover.
			glides.set(
				group,
				new HoverGlide(group, {
					// WHY: no app signal here; it would keep every closed menu's glide alive, and the group's own listeners go with it.
					tintClass: "hover-glide-tint",
					item: (node) => {
						const found = glideItem(node);
						return found?.parentElement === group ? found : undefined;
					},
				}),
			);
		},
		{ signal, capture: true },
	);
}
