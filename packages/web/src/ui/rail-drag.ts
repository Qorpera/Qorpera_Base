/* Dragging agents, group chats and member contacts in the rail: between sections, into
 * or out of the pinned row, and up or down inside one. Rows carry data-agent-id, for a
 * group chat data-room-id, or for a contact data-member-id; the places they can land
 * carry data-drop-zone ("pinned", "section:<id>", "unassigned" or, for contacts,
 * "members"). The list says what kind is dragged (data-dragging), so a zone that takes
 * only that kind can show itself. The rows make way while a row is dragged, as the
 * apps drawer's icons do (Jonas, 10 Nov 2026: "I prefer the style used when reordering
 * the interfaces with immediate orderswitching"): the row lifts off as an image under
 * the pointer, an empty space of its shape stands where it would land, and the rows
 * around glide to open and close it. Letting go drops it into that space. Off the rail
 * the space goes back to where the row started, and Escape puts everything back. A
 * press that never moves stays an ordinary click. While a row is lifted the rail is not
 * drawn afresh (the hooks' `end` draws what changed meanwhile). */

import { easing, reducedMotion } from "./motion.ts";
import { uiScale } from "./scale.ts";

export interface RailDrop {
	/** The agent, group chat or contact dropped. */
	itemId: string;
	kind: RailDragKind;
	zone: string;
	/** The zone's agents, group chats and contacts after the drop, the dragged one included, in order. */
	order: string[];
}

export type RailDragKind = "agent" | "room" | "member";

export interface RailDragHooks {
	/** Whether this item can be picked up now (no search running, the sidebar is loaded…). */
	canDrag(itemId: string): boolean;
	/** Whether the item may land in this zone. */
	accepts(zone: string, itemId: string): boolean;
	/** Told before anything on the screen moves: the row still stands in the zone it left, so what it left behind
	 * can be read off the list. */
	drop(drop: RailDrop): void;
	/** A drag ended, however it ended (dropped, put back, given up): the rail may draw again. */
	end(): void;
}

/** What the rail drags: agents, group chats and member contacts. */
export const RAIL_ITEM = "[data-agent-id], [data-room-id], [data-member-id]";
export const railItemId = (element: HTMLElement) =>
	element.dataset.agentId ?? element.dataset.roomId ?? element.dataset.memberId;
const itemSelector = (itemId: string) =>
	`[data-agent-id="${itemId}"], [data-room-id="${itemId}"], [data-member-id="${itemId}"]`;
/** What glides when the space moves: every row and card, and the titles and slots between them. */
const LEAVES = ".rail-row, .rail-pin, .rail-section-title, .rail-hidden-toggle, .rail-drop-slot, .rail-empty";

/** Design pixels: how far a press moves before it drags, and the band at the list's edges that scrolls it. */
const THRESHOLD = 6;
const EDGE = 40;
/** Design pixels: how near the rows' top the pointer comes before an empty pinned row opens to take a card. */
const PIN_REACH = 10;
/** As the apps drawer: the rows' glide, and the image's flight into its place. */
const GLIDE_MS = 260;
const SETTLE_MS = 220;

interface Active {
	itemId: string;
	kind: RailDragKind;
	pointerId: number;
	start: { x: number; y: number };
	offset: { x: number; y: number };
	source: HTMLElement;
	/** The row's size at the lift: hidden, it measures nothing. */
	size?: DOMRect;
	ghost?: HTMLElement;
	/** The empty space where the row would land. */
	gap?: HTMLElement;
	/** Where the row stood at the lift: its zone (none for Hidden agents) and its place there. */
	home?: { zone: HTMLElement | undefined; index: number };
	zone?: HTMLElement;
	index?: number;
	lastX: number;
	lastY: number;
}

/** Where an element is laid out, on screen: its box without the glide it may be in the middle of. */
function layoutRect(element: HTMLElement): DOMRect {
	const rect = element.getBoundingClientRect();
	const moved = getComputedStyle(element).translate;
	if (!moved || moved === "none") return rect;
	const [x = 0, y = 0] = moved.split(/\s+/).map((part) => Number.parseFloat(part) || 0);
	return new DOMRect(rect.left - x, rect.top - y, rect.width, rect.height);
}

export class RailDrag {
	readonly #list: HTMLElement;
	readonly #hooks: () => RailDragHooks;
	#active: Active | undefined;
	#frame = 0;
	/** The glides running now, one per element, so a new move starts each from where it is. */
	readonly #glides = new Map<Element, Animation>();

	constructor(list: HTMLElement, hooks: () => RailDragHooks, signal: AbortSignal) {
		this.#list = list;
		this.#hooks = hooks;
		// Agent, group chat and contact links and their figures are natively draggable; the rail
		// drags those itself. Other links keep the browser's own dragging.
		list.addEventListener(
			"dragstart",
			(event) => {
				if ((event.target as Element).closest?.(`${RAIL_ITEM}, [data-cofounder-id]`)) event.preventDefault();
			},
			{ signal },
		);
		list.addEventListener("pointerdown", (event) => this.#press(event), { signal });
		document.addEventListener("pointermove", (event) => this.#move(event), { signal });
		document.addEventListener("pointerup", (event) => this.#release(event), { signal });
		document.addEventListener("pointercancel", () => this.cancel(), { signal });
		document.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape" && this.dragging) {
					event.preventDefault();
					event.stopPropagation();
					this.cancel();
				}
			},
			{ capture: true, signal },
		);
		window.addEventListener("blur", () => this.cancel(), { signal });
		signal.addEventListener("abort", () => this.cancel());
	}

	/** The item being dragged, once the pointer has moved far enough. */
	get dragging(): string | undefined {
		return this.#active?.ghost ? this.#active.itemId : undefined;
	}

	/** Puts the row back where it stood at the lift, and drops a press not lifted yet. */
	cancel(): void {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		if (!active.ghost) return;
		this.#land(active, active.source, () => active.gap?.remove());
		this.#hooks().end();
	}

	#compact(): boolean {
		return this.#list.closest(".rail-compact") !== null;
	}

	#press(event: PointerEvent): void {
		if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		const source = (event.target as Element).closest<HTMLElement>(RAIL_ITEM);
		const itemId = source ? railItemId(source) : undefined;
		if (!source || !itemId || !this.#list.contains(source) || !this.#hooks().canDrag(itemId)) return;
		const rect = source.getBoundingClientRect();
		this.#active = {
			itemId,
			kind: source.dataset.memberId ? "member" : source.dataset.roomId ? "room" : "agent",
			pointerId: event.pointerId,
			start: { x: event.clientX, y: event.clientY },
			offset: { x: event.clientX - rect.left, y: event.clientY - rect.top },
			source,
			lastX: event.clientX,
			lastY: event.clientY,
		};
	}

	#begin(active: Active): void {
		// A redraw between the press and the first move may have rebuilt the row.
		if (!active.source.isConnected) {
			const source = this.#list.querySelector<HTMLElement>(itemSelector(active.itemId));
			if (!source || !this.#hooks().canDrag(active.itemId)) {
				this.#active = undefined;
				return;
			}
			active.source = source;
		}
		const rect = active.source.getBoundingClientRect();
		const ghost = active.source.cloneNode(true) as HTMLElement;
		ghost.classList.add("rail-drag-ghost");
		// Outside the rail the ghost would lose the collapsed rail's layout.
		ghost.classList.toggle("compact", this.#compact());
		ghost.classList.remove("active", "menu-open", "is-drag-source", "is-drag-landing");
		ghost.removeAttribute("href");
		ghost.removeAttribute("id");
		ghost.setAttribute("aria-hidden", "true");
		ghost.style.width = `${rect.width}px`;
		ghost.style.height = `${rect.height}px`;
		active.size = rect;
		// A clone copies no pixels: the figure's canvas is drawn again from the row's.
		const drawn = active.source.querySelectorAll("canvas");
		ghost.querySelectorAll("canvas").forEach((canvas, index) => {
			const from = drawn[index];
			if (from?.width && from.height) canvas.getContext("2d")?.drawImage(from, 0, 0);
		});
		document.body.append(ghost);
		active.ghost = ghost;
		// The row leaves the list and an empty space of its size takes its place, so nothing moves yet.
		const zone = active.source.closest<HTMLElement>("[data-drop-zone]") ?? undefined;
		const gap = document.createElement("div");
		gap.className = "rail-drop-gap";
		gap.setAttribute("aria-hidden", "true");
		active.gap = gap;
		this.#shape(active, zone);
		active.source.before(gap);
		active.source.classList.add("is-drag-source");
		const index = zone ? this.#items(zone, active).indexOf(gap) : -1;
		active.home = { zone, index };
		active.zone = zone;
		active.index = index < 0 ? undefined : index;
		zone?.classList.add("is-drop-target");
		this.#list.classList.add("rail-dragging");
		this.#list.dataset.dragging = active.kind;
		document.documentElement.classList.add("rail-drag-active");
		getSelection()?.removeAllRanges();
		this.#scrollLoop();
	}

	/** The zone's rows or cards in order, the dragged one left out and its space in its place. */
	#items(zone: HTMLElement, active: Active): HTMLElement[] {
		return [...zone.querySelectorAll<HTMLElement>(`${RAIL_ITEM}, .rail-drop-gap`)].filter(
			(item) => item !== active.source,
		);
	}

	/** Gives the space the shape of what stands in `zone`: a card in the pinned row, a row elsewhere. */
	#shape(active: Active, zone: HTMLElement | undefined): void {
		const gap = active.gap!;
		const card = zone?.dataset.dropZone === "pinned";
		gap.classList.toggle("is-pin", card);
		const like = card ? ".rail-pin" : ".rail-row";
		const sample = active.source.matches(like)
			? undefined
			: ((zone ?? this.#list).querySelector<HTMLElement>(`${like}:not(.is-drag-source)`) ??
				this.#list.querySelector<HTMLElement>(`${like}:not(.is-drag-source)`));
		// With nothing of that shape to measure, the stylesheet's size stands.
		const rect = sample ? sample.getBoundingClientRect() : active.source.matches(like) ? active.size : undefined;
		gap.style.width = card && rect?.width ? `${rect.width}px` : "";
		gap.style.height = rect?.height ? `${rect.height}px` : "";
	}

	#move(event: PointerEvent): void {
		const active = this.#active;
		if (!active || event.pointerId !== active.pointerId) return;
		if (!active.ghost) {
			if (Math.hypot(event.clientX - active.start.x, event.clientY - active.start.y) < THRESHOLD * uiScale()) return;
			this.#begin(active);
			if (!active.ghost) return;
		}
		event.preventDefault();
		active.lastX = event.clientX;
		active.lastY = event.clientY;
		active.ghost!.style.transform = `translate(${event.clientX - active.offset.x}px, ${event.clientY - active.offset.y}px)`;
		this.#target(event.clientX, event.clientY);
	}

	/** Finds the zone under the pointer and the place in it, and moves the space there. Over
	 * the rail but no zone (or one that takes no more), the space stays where it is; off the
	 * rail it goes back to where the row started. */
	#target(x: number, y: number): void {
		const active = this.#active!;
		const listRect = this.#list.getBoundingClientRect();
		const inside = x >= listRect.left && x <= listRect.right && y >= listRect.top && y <= listRect.bottom;
		if (!inside) {
			this.#put(active, active.home!.zone, active.home!.index);
			return;
		}
		this.#reach(active, y);
		// The zones themselves never glide, so they say where the pointer is in the list as it stands, whatever
		// row is passing over it.
		const zone = document
			.elementsFromPoint(x, y)
			.find(
				(element): element is HTMLElement => element.matches("[data-drop-zone]") && this.#list.contains(element),
			);
		if (!zone || !this.#hooks().accepts(zone.dataset.dropZone!, active.itemId)) return;
		const items = this.#items(zone, active).filter((item) => item !== active.gap);
		// The collapsed rail stacks pinned figures in a column: they order like rows there.
		const grid = zone.dataset.dropZone === "pinned" && !this.#compact();
		let index = items.length;
		for (const [position, item] of items.entries()) {
			// Where the rows will stand, not where a glide has them now, so a move never undoes itself.
			const rect = layoutRect(item);
			const before = grid
				? y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)
				: y < rect.top + rect.height / 2;
			if (before) {
				index = position;
				break;
			}
		}
		this.#put(active, zone, index);
	}

	/** An empty pinned row (or one whose only card is lifted) opens only when the pointer comes up to it, so
	 * lifting a row never pushes the list down under the pointer. It closes once the pointer is a little past it. */
	#reach(active: Active, y: number): void {
		const pinned = this.#list.querySelector<HTMLElement>(':scope > [data-drop-zone="pinned"]');
		const open = this.#list.classList.contains("rail-pin-open");
		let want = false;
		if (pinned && this.#hooks().accepts("pinned", active.itemId)) {
			const margin = PIN_REACH * uiScale();
			if (open) want = y <= pinned.getBoundingClientRect().bottom + margin;
			else {
				const below = pinned.nextElementSibling;
				want = below ? y < layoutRect(below as HTMLElement).top + margin : true;
			}
		}
		if (want !== open) this.#glide(() => this.#list.classList.toggle("rail-pin-open", want));
	}

	/** Moves the space to `index` in `zone` (none: back to where the row started), the rows gliding. */
	#put(active: Active, zone: HTMLElement | undefined, index: number): void {
		const gap = active.gap!;
		if (zone !== active.zone) {
			active.zone?.classList.remove("is-drop-target");
			zone?.classList.add("is-drop-target");
		}
		const home = zone === undefined || (zone === active.home!.zone && index === active.home!.index);
		active.zone = zone;
		active.index = zone ? index : undefined;
		const items = zone ? this.#items(zone, active).filter((item) => item !== gap) : [];
		const at = (): [Element, "before" | "after"] | undefined => {
			if (home) return [active.source, "before"];
			if (index < items.length) return [items[index]!, "before"];
			if (items.length) return [items[items.length - 1]!, "after"];
			return undefined;
		};
		const place = at();
		const already = place
			? place[1] === "before"
				? place[0].previousElementSibling === gap
				: place[0].nextElementSibling === gap
			: gap.parentElement !== null && zone?.contains(gap);
		if (already) return;
		this.#glide(() => {
			this.#shape(active, home ? active.home!.zone : zone);
			if (place) place[0][place[1]](gap);
			else if (zone) {
				// An empty zone: the space goes where its rows would be.
				const slot = zone.querySelector(":scope > .rail-drop-slot");
				if (slot) slot.before(gap);
				else (zone.querySelector(".rail-section-list") ?? zone).append(gap);
			}
		});
	}

	/** Runs `change` and lets every row it moves glide from where it stood. */
	#glide(change: () => void): void {
		const leaves = [...this.#list.querySelectorAll<HTMLElement>(LEAVES)];
		const from = new Map(leaves.map((leaf) => [leaf, leaf.getBoundingClientRect()]));
		change();
		if (reducedMotion()) return;
		const curve = easing("--ease-spring");
		for (const leaf of leaves) {
			if (!leaf.isConnected || typeof leaf.animate !== "function") continue;
			// A glide still running starts again from where it has the row now.
			this.#glides.get(leaf)?.cancel();
			const was = from.get(leaf)!;
			const now = leaf.getBoundingClientRect();
			// What was not drawn before (the opened pinned row's slot) or is not drawn now has nowhere to glide from.
			if (!was.width || !was.height || !now.width || !now.height) continue;
			const dx = was.left - now.left;
			const dy = was.top - now.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
			const glide = leaf.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
				duration: GLIDE_MS,
				easing: curve,
			});
			this.#glides.set(leaf, glide);
			const done = () => {
				if (this.#glides.get(leaf) === glide) this.#glides.delete(leaf);
			};
			glide.addEventListener?.("finish", done);
			glide.addEventListener?.("cancel", done);
		}
	}

	/** Near the top or bottom edge the list scrolls under the pointer. */
	#scrollLoop(): void {
		const step = () => {
			const active = this.#active;
			if (!active?.ghost) return;
			const dock = this.#dockAt(active.lastX, active.lastY);
			if ((dock && this.#edgeScroll(dock, active.lastY)) || this.#edgeScroll(this.#list, active.lastY)) {
				this.#target(active.lastX, active.lastY);
			}
			this.#frame = requestAnimationFrame(step);
		};
		this.#frame = requestAnimationFrame(step);
	}

	#edgeScroll(scroller: HTMLElement, y: number): boolean {
		const rect = scroller.getBoundingClientRect();
		const edge = EDGE * uiScale();
		const speed =
			y < rect.top + edge
				? -Math.ceil((rect.top + edge - y) / 4)
				: y > rect.bottom - edge
					? Math.ceil((y - (rect.bottom - edge)) / 4)
					: 0;
		if (!speed) return false;
		const before = scroller.scrollTop;
		scroller.scrollTop += speed;
		return scroller.scrollTop !== before;
	}

	// WHY: the rail's dock (Agents and Members) scrolls by itself inside the list: over it the dock scrolls first, and
	// the list once the dock can go no further.
	#dockAt(x: number, y: number): HTMLElement | undefined {
		return document
			.elementsFromPoint?.(x, y)
			.find((element): element is HTMLElement => element.matches(".rail-dock") && this.#list.contains(element));
	}

	#release(event: PointerEvent): void {
		const active = this.#active;
		if (!active || event.pointerId !== active.pointerId) return;
		if (!active.ghost) {
			this.#active = undefined;
			return;
		}
		// The press ends on a link: that click is the drop, not a navigation.
		const swallow = (click: MouseEvent) => {
			click.preventDefault();
			click.stopPropagation();
		};
		window.addEventListener("click", swallow, { capture: true, once: true });
		setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
		const { zone, index, home } = active;
		if (!zone?.isConnected || index === undefined || (zone === home!.zone && index === home!.index)) {
			this.cancel();
			return;
		}
		this.#active = undefined;
		const gap = active.gap!;
		const order = this.#items(zone, active).map((item) => (item === gap ? active.itemId : railItemId(item)!));
		// A row that lands among rows takes the space itself, so the drop moves nothing on the screen. A row
		// pinned or unpinned changes shape: the space holds its place until the rail draws the new card or row.
		const same = gap.classList.contains("is-pin") === active.source.classList.contains("rail-pin");
		const hooks = this.#hooks();
		hooks.drop({ itemId: active.itemId, kind: active.kind, zone: zone.dataset.dropZone!, order });
		if (same) {
			gap.replaceWith(active.source);
			active.source.classList.replace("is-drag-source", "is-drag-landing");
		}
		// Drawn now, the rail stands as it will (the drop drew the change at once).
		hooks.end();
		gap.remove();
		const selector = itemSelector(active.itemId);
		const landed =
			(same && active.source.isConnected ? active.source : undefined) ??
			zone.querySelector<HTMLElement>(selector) ??
			this.#list.querySelector<HTMLElement>(selector) ??
			active.source;
		if (landed !== active.source) active.source.classList.remove("is-drag-source");
		this.#land(active, landed);
	}

	/** The list is an ordinary list again (after `change`), its rows gliding there, and the image flies into
	 * `landed`, which shows when it gets there. */
	#land(active: Active, landed: HTMLElement, change?: () => void): void {
		cancelAnimationFrame(this.#frame);
		document.documentElement.classList.remove("rail-drag-active");
		const ghost = active.ghost!;
		// The row comes back into the list unseen, keeping its space, so it can glide like the rest.
		this.#glide(() => {
			change?.();
			active.zone?.classList.remove("is-drop-target");
			this.#list.classList.remove("rail-dragging", "rail-pin-open");
			delete this.#list.dataset.dragging;
			active.source.classList.remove("is-drag-source");
			if (landed.isConnected) landed.classList.add("is-drag-landing");
		});
		const done = () => {
			ghost.remove();
			landed.classList.remove("is-drag-landing");
		};
		if (!landed.isConnected || reducedMotion() || typeof ghost.animate !== "function") {
			done();
			return;
		}
		const to = layoutRect(landed);
		const from = ghost.getBoundingClientRect();
		// A card that lands as a row (or a row as a card) has another shape: the image fades on its way.
		const fits = Math.abs(to.width - from.width) < 2 && Math.abs(to.height - from.height) < 2;
		const left = to.left + (to.width - from.width) / 2;
		const top = to.top + (to.height - from.height) / 2;
		const flight = ghost.animate(
			[
				{ transform: ghost.style.transform },
				{ transform: `translate(${left}px, ${top}px)`, ...(fits ? {} : { opacity: 0 }) },
			],
			{ duration: SETTLE_MS, easing: easing("--ease-out"), fill: "forwards" },
		);
		flight.addEventListener?.("finish", done);
		flight.addEventListener?.("cancel", done);
		// However the flight ends (a hidden tab runs no animations), the row shows.
		setTimeout(done, SETTLE_MS + 200);
	}
}
