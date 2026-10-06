/* Dragging a board's card (Interfaces step I9a). A card that may move is pressed and moved a few pixels; the lanes it
 * may land in are marked, the one under the pointer shaded, and letting go over it asks for that move. The card follows
 * the pointer until then and settles back into its place (at once when reduced motion is asked for): the board draws it
 * where it lands only once the save has landed. A press that never moves stays a click, Escape puts the card back, and
 * touch scrolls as before: the card's buttons are the way on a phone and from the keyboard. */

import { uiScale } from "./scale.ts";

export interface BoardDragOptions {
	/** The lanes the card may land in, by their `data-drop-lane`. */
	readonly targets: readonly string[];
	/** The card was let go over one of them. */
	readonly drop: (lane: string) => void;
}

/** Design pixels a press moves before it drags. */
const THRESHOLD = 6;
/** How long the settle back may take before the card is left alone, in milliseconds. */
const SETTLE = 400;

/** Makes a card draggable onto its target lanes. The card is drawn again after a drop, so nothing outlives it. */
export function boardDrag(card: HTMLElement, options: BoardDragOptions): void {
	if (!options.targets.length) return;
	card.classList.add("is-draggable");
	// Its links and pictures would start the browser's own drag.
	card.addEventListener("dragstart", (event) => event.preventDefault());
	card.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		// A press on one of the card's buttons is that button's.
		if ((event.target as Element).closest?.(".interface-actions")) return;
		press(card, options, event);
	});
}

function press(card: HTMLElement, options: BoardDragOptions, down: PointerEvent): void {
	const board = card.closest<HTMLElement>(".interface-board");
	if (!board) return;
	const stop = new AbortController();
	const lanes = () =>
		[...board.querySelectorAll<HTMLElement>("[data-drop-lane]")].filter((lane) =>
			options.targets.includes(lane.dataset.dropLane ?? ""),
		);
	let dragging = false;
	let over: HTMLElement | null = null;
	const end = (dropped: boolean) => {
		stop.abort();
		if (!dragging) return;
		for (const lane of lanes()) lane.classList.remove("is-drop-target", "is-drop-over");
		board.classList.remove("is-dragging");
		card.classList.remove("is-dragging");
		// The press ends on the card: that click is the drop, not an open.
		const swallow = (click: MouseEvent) => {
			click.preventDefault();
			click.stopPropagation();
		};
		window.addEventListener("click", swallow, { capture: true, once: true });
		setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
		card.classList.add("is-settling");
		card.style.transform = "";
		const settled = () => card.classList.remove("is-settling");
		card.addEventListener("transitionend", settled, { once: true });
		setTimeout(settled, SETTLE);
		if (dropped && over?.isConnected && over.dataset.dropLane) options.drop(over.dataset.dropLane);
	};
	document.addEventListener(
		"pointermove",
		(event) => {
			if (event.pointerId !== down.pointerId) return;
			// The board was drawn again under the drag: the card it moved is gone.
			if (!card.isConnected) {
				end(false);
				return;
			}
			const [dx, dy] = [event.clientX - down.clientX, event.clientY - down.clientY];
			if (!dragging) {
				if (Math.hypot(dx, dy) < THRESHOLD * uiScale()) return;
				dragging = true;
				board.classList.add("is-dragging");
				card.classList.add("is-dragging");
				for (const lane of lanes()) lane.classList.add("is-drop-target");
				getSelection()?.removeAllRanges();
			}
			event.preventDefault();
			card.style.transform = `translate(${dx}px, ${dy}px)`;
			const under =
				lanes().find((lane) => {
					const rect = lane.getBoundingClientRect();
					return (
						event.clientX >= rect.left &&
						event.clientX <= rect.right &&
						event.clientY >= rect.top &&
						event.clientY <= rect.bottom
					);
				}) ?? null;
			if (under !== over) {
				over?.classList.remove("is-drop-over");
				under?.classList.add("is-drop-over");
				over = under;
			}
		},
		{ signal: stop.signal },
	);
	document.addEventListener(
		"pointerup",
		(event) => {
			if (event.pointerId === down.pointerId) end(true);
		},
		{ signal: stop.signal },
	);
	document.addEventListener("pointercancel", () => end(false), { signal: stop.signal });
	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Escape" || !dragging) return;
			event.preventDefault();
			event.stopPropagation();
			end(false);
		},
		{ capture: true, signal: stop.signal },
	);
	window.addEventListener("blur", () => end(false), { signal: stop.signal });
}
