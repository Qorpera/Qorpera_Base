import { reducedMotion } from "./motion.ts";

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
const FOLLOW_MS = 38;
const LIT_CLASS = "hover-lit";

export class HoverGlide {
	readonly tint: HTMLElement;
	#list: HTMLElement;
	#options: HoverGlideOptions;
	#target: HTMLElement | undefined;
	#frame = 0;
	#shown: Box | undefined;
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
			this.#stop();
			this.#target = undefined;
			this.#lit = undefined;
			this.#to = undefined;
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
		if (item === this.#target && this.attached) {
			if (item.classList.contains("active")) item.classList.remove(LIT_CLASS);
			return;
		}
		this.#glideTo(item);
	}

	#glideTo(item: HTMLElement): void {
		const to = this.#boxOf(item);
		if (item === this.#target && this.attached && this.#to && sameBox(to, this.#to)) {
			if (item.classList.contains("active")) item.classList.remove(LIT_CLASS);
			return;
		}
		const from = this.#target && this.attached ? this.#shown : undefined;
		const lit = this.#lit === item && item.classList.contains(LIT_CLASS);
		this.#target = item;
		this.#to = to;
		Object.assign(this.tint.style, { width: `${to.width}px`, height: `${to.height}px`, borderRadius: to.radius });
		this.#show(from ?? to);
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
			this.#stop();
			this.#show(to);
			this.#light(item, 0);
			return;
		}
		this.#light(item, lit ? 0 : FOLLOW_MS * 1.6);
		if (!this.#frame) this.#follow();
	}

	#follow(): void {
		let last: number | undefined;
		const step = (now: number) => {
			const to = this.#to;
			const shown = this.#shown;
			if (!to || !shown) {
				this.#frame = 0;
				return;
			}
			const elapsed = last === undefined ? 1000 / 60 : Math.min(64, now - last);
			last = now;
			const next = between(shown, to, 1 - Math.exp(-elapsed / FOLLOW_MS));
			if (sameBox(next, to)) {
				this.#show(to);
				this.#frame = 0;
				return;
			}
			this.#show(next);
			this.#frame = window.requestAnimationFrame(step);
		};
		this.#frame = window.requestAnimationFrame(step);
	}

	#show(box: Box): void {
		this.#shown = box;
		Object.assign(this.tint.style, motionFrame(box, this.#to ?? box));
	}

	#stop(): void {
		window.cancelAnimationFrame(this.#frame);
		this.#frame = 0;
	}

	#hide(now = false): void {
		window.clearTimeout(this.#leaving);
		this.#leaving = 0;
		if (!this.#target) return;
		this.#stop();
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
}

// WHY: a menu still scaling in is measured at full size, and its border is not part of where the tint sits.
export function boxWithin(list: HTMLElement, rect: DOMRect, radius: string): Box {
	const outer = list.getBoundingClientRect();
	const scale =
		list.offsetWidth > 0 && Math.abs(outer.width - list.offsetWidth) > 1 ? outer.width / list.offsetWidth : 1;
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

function motionFrame(box: Box, target: Box): { translate: string; scale: string } {
	const sx = target.width > 0 ? box.width / target.width : 1;
	const sy = target.height > 0 ? box.height / target.height : 1;
	return {
		translate: `${box.left}px ${box.top}px`,
		scale: sx === 1 && sy === 1 ? "none" : `${sx} ${sy}`,
	};
}

function between(from: Box, to: Box, k: number): Box {
	const at = (a: number, b: number) => a + (b - a) * k;
	return {
		left: at(from.left, to.left),
		top: at(from.top, to.top),
		width: at(from.width, to.width),
		height: at(from.height, to.height),
		radius: to.radius,
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
