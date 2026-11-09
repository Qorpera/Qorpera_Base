/* Reordering the apps drawer's icons by dragging (Jonas, 9 Nov 2026: "I would like for the interfaces to be draggable
 * too, so you can reorder them"). An icon pressed and moved a few pixels lifts and follows the pointer; the others make
 * way for it, gliding to their new places, and letting go keeps the order it shows. A press that never moves stays a
 * click, Escape puts everything back, and touch scrolls as before. Alt with an arrow moves the focused icon one place,
 * the keyboard's twin of the drag. The icons carry `data-app-key`; the hooks say whether a drag may start and are told
 * the new order. */

import { matchesKey } from "./keys.ts";
import { easing, reducedMotion } from "./motion.ts";
import { uiScale } from "./scale.ts";

export interface AppGridDragHooks {
	/** Whether an icon may be picked up now (the drawer is open, no search covers it…). */
	readonly canDrag: () => boolean;
	/** The icons' keys in their new order, after a drag or a keyboard move that changed it. */
	readonly drop: (order: string[]) => void;
}

const ITEM = "[data-app-key]";
/** Design pixels a press moves before it drags. */
const THRESHOLD = 6;
const GLIDE_MS = 260;
const SETTLE_MS = 220;

const keyOf = (element: Element) => (element as HTMLElement).dataset.appKey ?? "";
const itemsIn = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>(`:scope > ${ITEM}`)];

/** The drawer's icons in the member's order: those it names first, as it names them, then the rest as they come (a new
 * page or app joins at the end). */
export function orderApps<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[]): T[] {
	const place = new Map(order.map((key, index) => [key, index]));
	return items
		.map((item, index) => ({ item, index, at: place.get(keyOf(item)) }))
		.sort((a, b) => (a.at ?? order.length + a.index) - (b.at ?? order.length + b.index))
		.map(({ item }) => item);
}

/** The keys of the grid's icons in the order they stand. */
export function gridOrder(grid: HTMLElement): string[] {
	return itemsIn(grid).map(keyOf);
}

/** Moves `item` to stand before `before` (or last), the other icons gliding from where they stood. */
function moveGliding(grid: HTMLElement, item: HTMLElement, before: Element | null): void {
	const others = itemsIn(grid).filter((other) => other !== item);
	const from = new Map(others.map((other) => [other, other.getBoundingClientRect()]));
	grid.insertBefore(item, before);
	if (reducedMotion()) return;
	const curve = easing("--ease-spring");
	for (const other of others) {
		const was = from.get(other);
		const now = other.getBoundingClientRect();
		if (!was || typeof other.animate !== "function") continue;
		const dx = was.left - now.left;
		const dy = was.top - now.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
		other.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: GLIDE_MS, easing: curve });
	}
}

interface Drag {
	readonly item: HTMLElement;
	readonly pointerId: number;
	readonly start: { x: number; y: number };
	/** Where the pointer held the icon, from its top left corner. */
	offset?: { x: number; y: number };
	/** The order before the drag, to put back on Escape. */
	readonly before: string[];
}

/** Makes the icons in `grid` reorderable. Listeners live until `signal` aborts. */
export class AppGridDrag {
	readonly #grid: HTMLElement;
	readonly #hooks: () => AppGridDragHooks;
	#drag: Drag | undefined;

	constructor(grid: HTMLElement, hooks: () => AppGridDragHooks, signal: AbortSignal) {
		this.#grid = grid;
		this.#hooks = hooks;
		// The icons are links: the browser would start its own drag of them.
		grid.addEventListener(
			"dragstart",
			(event) => {
				if ((event.target as Element).closest?.(ITEM)) event.preventDefault();
			},
			{ signal },
		);
		grid.addEventListener("pointerdown", (event) => this.#press(event), { signal });
		document.addEventListener("pointermove", (event) => this.#move(event), { signal });
		document.addEventListener("pointerup", (event) => this.#release(event), { signal });
		document.addEventListener("pointercancel", () => this.cancel(), { signal });
		document.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || !this.dragging) return;
				event.preventDefault();
				event.stopPropagation();
				this.cancel();
			},
			{ signal, capture: true },
		);
		grid.addEventListener("keydown", (event) => this.#key(event), { signal });
	}

	/** Whether an icon is lifted now: the drawer is not drawn afresh meanwhile. */
	get dragging(): boolean {
		return this.#drag?.offset !== undefined;
	}

	/** Puts every icon back where it stood before the drag. */
	cancel(): void {
		const drag = this.#drag;
		this.#drag = undefined;
		if (!drag?.offset) return;
		const byKey = new Map(itemsIn(this.#grid).map((item) => [keyOf(item), item]));
		for (const key of drag.before) {
			const item = byKey.get(key);
			if (item) this.#grid.append(item);
		}
		this.#settle(drag.item);
	}

	#press(event: PointerEvent): void {
		if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		const item = (event.target as Element).closest?.<HTMLElement>(ITEM);
		if (!item || item.parentElement !== this.#grid || !this.#hooks().canDrag()) return;
		this.#drag = {
			item,
			pointerId: event.pointerId,
			start: { x: event.clientX, y: event.clientY },
			before: gridOrder(this.#grid),
		};
	}

	#move(event: PointerEvent): void {
		const drag = this.#drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		if (!drag.offset) {
			const far = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
			if (far < THRESHOLD * uiScale()) return;
			const rect = drag.item.getBoundingClientRect();
			drag.offset = { x: drag.start.x - rect.left, y: drag.start.y - rect.top };
			drag.item.classList.add("is-lifted");
			this.#grid.classList.add("is-sorting");
		}
		event.preventDefault();
		// The icon over which the pointer stands takes the dragged one's place.
		const over = itemsIn(this.#grid).find((other) => {
			if (other === drag.item) return false;
			const r = other.getBoundingClientRect();
			return (
				event.clientX >= r.left && event.clientX < r.right && event.clientY >= r.top && event.clientY < r.bottom
			);
		});
		if (over) {
			const items = itemsIn(this.#grid);
			const forward = items.indexOf(over) > items.indexOf(drag.item);
			moveGliding(this.#grid, drag.item, forward ? over.nextElementSibling : over);
		}
		this.#follow(drag, event.clientX, event.clientY);
	}

	/** Keeps the lifted icon under the pointer, inside the grid. */
	#follow(drag: Drag, x: number, y: number): void {
		const item = drag.item;
		const offset = drag.offset!;
		item.style.translate = "";
		const slot = item.getBoundingClientRect();
		const frame = this.#grid.getBoundingClientRect();
		const left = Math.min(Math.max(x - offset.x, frame.left), frame.right - slot.width);
		const top = Math.min(Math.max(y - offset.y, frame.top), frame.bottom - slot.height);
		item.style.translate = `${left - slot.left}px ${top - slot.top}px`;
	}

	#release(event: PointerEvent): void {
		const drag = this.#drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		this.#drag = undefined;
		if (!drag.offset) return;
		// The press moved, so the click that follows it is no click. A release off the icon brings no click, so the
		// guard ends with this task rather than eating the next real one.
		const guard = new AbortController();
		this.#grid.addEventListener(
			"click",
			(click) => {
				click.preventDefault();
				click.stopPropagation();
				guard.abort();
			},
			{ capture: true, signal: guard.signal },
		);
		setTimeout(() => guard.abort(), 0);
		this.#settle(drag.item);
		const order = gridOrder(this.#grid);
		if (order.join("\n") !== drag.before.join("\n")) this.#hooks().drop(order);
	}

	/** The lifted icon glides into its place and is an ordinary icon again. */
	#settle(item: HTMLElement): void {
		this.#grid.classList.remove("is-sorting");
		const left = item.style.translate;
		item.style.translate = "";
		item.classList.remove("is-lifted");
		if (!left || reducedMotion() || typeof item.animate !== "function") return;
		item.animate([{ translate: left }, { translate: "0 0" }], { duration: SETTLE_MS, easing: easing("--ease-out") });
	}

	/** Alt with an arrow moves the focused icon one place: left and up go earlier, right and down later. */
	#key(event: KeyboardEvent): void {
		if (!event.altKey || this.dragging) return;
		const earlier = event.key === "ArrowLeft" || matchesKey(event, "previous");
		const later = event.key === "ArrowRight" || matchesKey(event, "next");
		if (!earlier && !later) return;
		const item = (event.target as Element).closest?.<HTMLElement>(ITEM);
		if (!item || item.parentElement !== this.#grid || !this.#hooks().canDrag()) return;
		event.preventDefault();
		const items = itemsIn(this.#grid);
		const index = items.indexOf(item);
		const target = items[index + (earlier ? -1 : 1)];
		if (!target) return;
		moveGliding(this.#grid, item, earlier ? target : target.nextElementSibling);
		item.focus({ preventScroll: true });
		this.#hooks().drop(gridOrder(this.#grid));
	}
}
