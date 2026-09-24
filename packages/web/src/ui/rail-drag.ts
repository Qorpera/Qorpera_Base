/* Dragging agents in the rail: between sections, into or out of the pinned row,
 * and up or down inside one. Rows carry data-agent-id; the places they can land
 * carry data-drop-zone ("pinned", "section:<id>" or "unassigned"). While a row is
 * dragged, the zone under the pointer is shaded (no border) and a thin marker shows
 * where the row will land. A press that never moves stays an ordinary click. */

export interface RailDrop {
	agentId: string;
	zone: string;
	/** The zone's agents after the drop, the dragged one included, in order. */
	order: string[];
}

export interface RailDragHooks {
	/** Whether this agent can be picked up now (no search running, the sidebar is loaded…). */
	canDrag(agentId: string): boolean;
	/** Whether the agent may land in this zone. */
	accepts(zone: string, agentId: string): boolean;
	drop(drop: RailDrop): void;
}

const THRESHOLD = 6;
const EDGE = 40;

interface Active {
	agentId: string;
	pointerId: number;
	start: { x: number; y: number };
	offset: { x: number; y: number };
	source: HTMLElement;
	ghost?: HTMLElement;
	zone?: HTMLElement;
	index?: number;
	lastX: number;
	lastY: number;
}

export class RailDrag {
	readonly #list: HTMLElement;
	readonly #hooks: () => RailDragHooks;
	readonly #marker: HTMLElement;
	#active: Active | undefined;
	#frame = 0;

	constructor(list: HTMLElement, hooks: () => RailDragHooks, signal: AbortSignal) {
		this.#list = list;
		this.#hooks = hooks;
		this.#marker = document.createElement("div");
		this.#marker.className = "rail-drop-marker";
		this.#marker.setAttribute("aria-hidden", "true");
		// Agent links and their figures are natively draggable; the rail drags those itself.
		// Other links (group chats) keep the browser's own dragging.
		list.addEventListener(
			"dragstart",
			(event) => {
				if ((event.target as Element).closest?.("[data-agent-id], [data-cofounder-id]")) event.preventDefault();
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

	/** The agent being dragged, once the pointer has moved far enough. */
	get dragging(): string | undefined {
		return this.#active?.ghost ? this.#active.agentId : undefined;
	}

	/** After the rail redraws: the dragged row may be a new element, the redraw took
	 * the marker away, and rows may have come or gone under the pointer. */
	refresh(): void {
		const active = this.#active;
		if (!active?.ghost) return;
		const source = this.#row(active.agentId, active.source);
		if (source && source !== active.source) {
			active.source.classList.remove("is-drag-source");
			active.source = source;
		}
		active.source.classList.add("is-drag-source");
		this.#list.classList.add("rail-dragging");
		// A zone element that was rebuilt is a new target, so the old one is let go first.
		if (active.zone && !active.zone.isConnected) active.zone = undefined;
		this.#target(active.lastX, active.lastY);
	}

	cancel(): void {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		cancelAnimationFrame(this.#frame);
		active.ghost?.remove();
		active.source.classList.remove("is-drag-source");
		active.zone?.classList.remove("is-drop-target");
		this.#marker.remove();
		this.#list.classList.remove("rail-dragging");
		document.documentElement.classList.remove("rail-drag-active");
	}

	#compact(): boolean {
		return this.#list.closest(".rail-compact") !== null;
	}

	#row(agentId: string, near: HTMLElement): HTMLElement | undefined {
		// The same agent can stand in the list and nowhere else; prefer the zone it was in.
		const zone = near.closest("[data-drop-zone]");
		const inZone = zone?.isConnected ? zone.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`) : null;
		return inZone ?? this.#list.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`) ?? undefined;
	}

	#press(event: PointerEvent): void {
		if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		const source = (event.target as Element).closest<HTMLElement>("[data-agent-id]");
		const agentId = source?.dataset.agentId;
		if (!source || !agentId || !this.#list.contains(source) || !this.#hooks().canDrag(agentId)) return;
		const rect = source.getBoundingClientRect();
		this.#active = {
			agentId,
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
			const source = this.#row(active.agentId, active.source);
			if (!source) {
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
		ghost.classList.remove("active", "menu-open", "is-drag-source");
		ghost.removeAttribute("href");
		ghost.removeAttribute("id");
		ghost.setAttribute("aria-hidden", "true");
		ghost.style.width = `${rect.width}px`;
		ghost.style.height = `${rect.height}px`;
		// A clone copies no pixels: the figure's canvas is drawn again from the row's.
		const drawn = active.source.querySelectorAll("canvas");
		ghost.querySelectorAll("canvas").forEach((canvas, index) => {
			const from = drawn[index];
			if (from?.width && from.height) canvas.getContext("2d")?.drawImage(from, 0, 0);
		});
		document.body.append(ghost);
		active.ghost = ghost;
		active.source.classList.add("is-drag-source");
		this.#list.classList.add("rail-dragging");
		document.documentElement.classList.add("rail-drag-active");
		getSelection()?.removeAllRanges();
		this.#scrollLoop();
	}

	#move(event: PointerEvent): void {
		const active = this.#active;
		if (!active || event.pointerId !== active.pointerId) return;
		if (!active.ghost) {
			if (Math.hypot(event.clientX - active.start.x, event.clientY - active.start.y) < THRESHOLD) return;
			this.#begin(active);
			if (!active.ghost) return;
		}
		event.preventDefault();
		active.lastX = event.clientX;
		active.lastY = event.clientY;
		active.ghost!.style.transform = `translate(${event.clientX - active.offset.x}px, ${event.clientY - active.offset.y}px)`;
		this.#target(event.clientX, event.clientY);
	}

	/** Finds the zone under the pointer and where in it the row would land. */
	#target(x: number, y: number): void {
		const active = this.#active!;
		const hooks = this.#hooks();
		const under = document.elementsFromPoint(x, y).find((element) => this.#list.contains(element));
		const listRect = this.#list.getBoundingClientRect();
		const inside = x >= listRect.left && x <= listRect.right && y >= listRect.top && y <= listRect.bottom;
		let zone = inside ? (under?.closest<HTMLElement>("[data-drop-zone]") ?? null) : null;
		if (zone && !hooks.accepts(zone.dataset.dropZone!, active.agentId)) zone = null;
		if (zone !== active.zone) {
			active.zone?.classList.remove("is-drop-target");
			zone?.classList.add("is-drop-target");
			active.zone = zone ?? undefined;
		}
		if (!zone) {
			active.index = undefined;
			this.#marker.remove();
			return;
		}
		const items = [...zone.querySelectorAll<HTMLElement>("[data-agent-id]")].filter(
			(item) => item.dataset.agentId !== active.agentId,
		);
		// The collapsed rail stacks pinned figures in a column: they order like rows there.
		const grid = zone.dataset.dropZone === "pinned" && !this.#compact();
		let index = items.length;
		for (const [position, item] of items.entries()) {
			const rect = item.getBoundingClientRect();
			const before = grid
				? y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)
				: y < rect.top + rect.height / 2;
			if (before) {
				index = position;
				break;
			}
		}
		active.index = index;
		this.#place(items, index, grid);
	}

	#place(items: HTMLElement[], index: number, grid: boolean): void {
		const list = this.#list.getBoundingClientRect();
		const top = (value: number) => value - list.top + this.#list.scrollTop;
		const left = (value: number) => value - list.left + this.#list.scrollLeft;
		const marker = this.#marker;
		marker.classList.toggle("vertical", grid && items.length > 0);
		if (!items.length) {
			// An empty zone: its shading says where the agent lands.
			marker.remove();
			return;
		}
		if (grid) {
			const anchor = items[Math.min(index, items.length - 1)]!.getBoundingClientRect();
			const x = index < items.length ? anchor.left - 4 : anchor.right + 4;
			Object.assign(marker.style, {
				top: `${top(anchor.top + 8)}px`,
				left: `${left(x) - 1}px`,
				width: "",
				height: `${anchor.height - 16}px`,
			});
		} else {
			const anchor = items[Math.min(index, items.length - 1)]!.getBoundingClientRect();
			const y = index < items.length ? anchor.top : anchor.bottom;
			Object.assign(marker.style, {
				top: `${top(y) - 1}px`,
				left: `${left(anchor.left + 8)}px`,
				width: `${anchor.width - 16}px`,
				height: "",
			});
		}
		if (marker.parentElement !== this.#list) this.#list.append(marker);
	}

	/** Near the top or bottom edge the list scrolls under the pointer. */
	#scrollLoop(): void {
		const step = () => {
			const active = this.#active;
			if (!active?.ghost) return;
			const rect = this.#list.getBoundingClientRect();
			const speed =
				active.lastY < rect.top + EDGE
					? -Math.ceil((rect.top + EDGE - active.lastY) / 4)
					: active.lastY > rect.bottom - EDGE
						? Math.ceil((active.lastY - (rect.bottom - EDGE)) / 4)
						: 0;
			if (speed) {
				const before = this.#list.scrollTop;
				this.#list.scrollTop += speed;
				if (this.#list.scrollTop !== before) {
					this.#target(active.lastX, active.lastY);
				}
			}
			this.#frame = requestAnimationFrame(step);
		};
		this.#frame = requestAnimationFrame(step);
	}

	#release(event: PointerEvent): void {
		const active = this.#active;
		if (!active || event.pointerId !== active.pointerId) return;
		if (!active.ghost) {
			this.#active = undefined;
			return;
		}
		const zone = active.zone;
		const index = active.index;
		this.cancel();
		// The press ends on a link: that click is the drop, not a navigation.
		const swallow = (click: MouseEvent) => {
			click.preventDefault();
			click.stopPropagation();
		};
		window.addEventListener("click", swallow, { capture: true, once: true });
		setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
		if (!zone?.isConnected || index === undefined) return;
		const order = [...zone.querySelectorAll<HTMLElement>("[data-agent-id]")]
			.map((item) => item.dataset.agentId!)
			.filter((agentId) => agentId !== active.agentId);
		order.splice(index, 0, active.agentId);
		this.#hooks().drop({ agentId: active.agentId, zone: zone.dataset.dropZone!, order });
	}
}
