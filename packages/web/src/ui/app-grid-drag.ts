/* Reordering the apps drawer's icons by dragging (Jonas, 9 Nov 2026: "I would like for the interfaces to be draggable
 * too, so you can reorder them"). An icon pressed and moved a few pixels lifts and follows the pointer; the others make
 * way for it, gliding to their new places, and letting go keeps the order it shows. A press that never moves stays a
 * click, Escape puts everything back, and touch scrolls as before. Alt with an arrow moves the focused icon one place,
 * the keyboard's twin of the drag. The icons carry `data-app-key`; the hooks say whether a drag may start and are told
 * the new order. While an icon is lifted the pointer is matched against the grid's places as they stood when it was
 * lifted, never against icons still gliding, so a swap never undoes itself. */

import { matchesKey } from "./keys.ts";
import { easing, reducedMotion } from "./motion.ts";
import { uiScale } from "./scale.ts";

export interface AppGridDragHooks {
	/** Whether an icon may be picked up now (the drawer is open, no search covers it…). */
	readonly canDrag: () => boolean;
	/** The icons' keys in their new order, after a drag or a keyboard move that changed it. */
	readonly drop: (order: string[]) => void;
	/** A drag ended, however it ended (dropped, put back, given up): what the drawer held back meanwhile may draw. */
	readonly end: () => void;
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

/** Moves `item` to stand before `before` (or last), the other icons gliding from where they stood. Each glide is kept in
 * `moving` until it ends, so a lift can finish them first and measure the places where the icons really stand. */
function moveGliding(grid: HTMLElement, item: HTMLElement, before: Element | null, moving: Set<Animation>): void {
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
		track(
			moving,
			other.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: GLIDE_MS, easing: curve }),
		);
	}
}

/** Keeps `animation` in `moving` until it finishes or is cancelled. */
function track(moving: Set<Animation>, animation: Animation): void {
	moving.add(animation);
	const done = () => moving.delete(animation);
	animation.addEventListener?.("finish", done);
	animation.addEventListener?.("cancel", done);
}

interface Drag {
	/** The pressed icon's key: a redraw before the lift may have replaced its element. */
	readonly key: string;
	readonly pointerId: number;
	readonly start: { x: number; y: number };
	lifted?: {
		readonly item: HTMLElement;
		/** Where the pointer held the icon, from its top left corner. */
		readonly offset: { x: number; y: number };
		/** The grid's places at the lift, by index, before anything glides. */
		readonly slots: readonly DOMRect[];
		/** The order at the lift, to put back on Escape. */
		readonly before: readonly string[];
	};
}

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/** Makes the icons in `grid` reorderable. Listeners live until `signal` aborts. */
export class AppGridDrag {
	readonly #grid: HTMLElement;
	readonly #hooks: () => AppGridDragHooks;
	#drag: Drag | undefined;
	/** The glides and settles running now. */
	readonly #moving = new Set<Animation>();

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
		// Switching to another window mid-drag: the release may never reach this page.
		window.addEventListener("blur", () => this.cancel(), { signal });
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
		return this.#drag?.lifted !== undefined;
	}

	/** Puts every icon back where it stood at the lift, and drops a press not lifted yet. */
	cancel(): void {
		const lifted = this.#drag?.lifted;
		this.#drag = undefined;
		if (!lifted) return;
		const byKey = new Map(itemsIn(this.#grid).map((item) => [keyOf(item), item]));
		for (const key of lifted.before) {
			const item = byKey.get(key);
			if (item) this.#grid.append(item);
		}
		this.#settle(lifted.item);
		this.#hooks().end();
	}

	#press(event: PointerEvent): void {
		if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		const item = (event.target as Element).closest?.<HTMLElement>(ITEM);
		if (!item || item.parentElement !== this.#grid || !this.#hooks().canDrag()) return;
		this.#drag = { key: keyOf(item), pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY } };
	}

	#move(event: PointerEvent): void {
		const drag = this.#drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		// The button came up where this page could not hear it (another window, a lost release).
		if ((event.buttons & 1) === 0) {
			this.cancel();
			return;
		}
		if (!drag.lifted) {
			const far = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
			if (far < THRESHOLD * uiScale()) return;
			// The icon as it stands now: a redraw since the press may have rebuilt it, or taken it away.
			const items = itemsIn(this.#grid);
			const item = items.find((candidate) => keyOf(candidate) === drag.key);
			if (!item || !this.#hooks().canDrag()) {
				this.#drag = undefined;
				return;
			}
			// An earlier move may still be gliding: its icons jump to where they stand, so the places are measured true.
			for (const animation of [...this.#moving]) animation.finish();
			this.#moving.clear();
			const rect = item.getBoundingClientRect();
			drag.lifted = {
				item,
				offset: { x: drag.start.x - rect.left, y: drag.start.y - rect.top },
				slots: items.map((candidate) => candidate.getBoundingClientRect()),
				before: items.map(keyOf),
			};
			item.classList.add("is-lifted");
			this.#grid.classList.add("is-sorting");
		}
		event.preventDefault();
		const { item, slots } = drag.lifted;
		// The place under the pointer is the icon's new place.
		const target = slots.findIndex((slot) => inside(slot, event.clientX, event.clientY));
		const others = itemsIn(this.#grid).filter((other) => other !== item);
		if (target >= 0 && others.length + 1 === slots.length && itemsIn(this.#grid).indexOf(item) !== target)
			moveGliding(this.#grid, item, others[target] ?? null, this.#moving);
		this.#follow(drag.lifted, event.clientX, event.clientY);
	}

	/** Keeps the lifted icon under the pointer, inside the grid. */
	#follow(lifted: NonNullable<Drag["lifted"]>, x: number, y: number): void {
		const { item, offset, slots } = lifted;
		const slot = slots[itemsIn(this.#grid).indexOf(item)];
		if (!slot) return;
		const frame = this.#grid.getBoundingClientRect();
		const left = Math.min(Math.max(x - offset.x, frame.left), frame.right - slot.width);
		const top = Math.min(Math.max(y - offset.y, frame.top), frame.bottom - slot.height);
		item.style.translate = `${left - slot.left}px ${top - slot.top}px`;
	}

	#release(event: PointerEvent): void {
		const drag = this.#drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		this.#drag = undefined;
		const lifted = drag.lifted;
		if (!lifted) return;
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
		this.#settle(lifted.item);
		const order = gridOrder(this.#grid);
		const hooks = this.#hooks();
		if (order.join("\n") !== lifted.before.join("\n")) hooks.drop(order);
		hooks.end();
	}

	/** The lifted icon glides into its place and is an ordinary icon again. */
	#settle(item: HTMLElement): void {
		this.#grid.classList.remove("is-sorting");
		const left = item.style.translate;
		item.style.translate = "";
		item.classList.remove("is-lifted");
		if (!left || reducedMotion() || typeof item.animate !== "function") return;
		track(
			this.#moving,
			item.animate([{ translate: left }, { translate: "0 0" }], {
				duration: SETTLE_MS,
				easing: easing("--ease-out"),
			}),
		);
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
		moveGliding(this.#grid, item, earlier ? target : target.nextElementSibling, this.#moving);
		item.focus({ preventScroll: true });
		const hooks = this.#hooks();
		hooks.drop(gridOrder(this.#grid));
		hooks.end();
	}
}
