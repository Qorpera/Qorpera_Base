/* Rail rows glide to their new places instead of jumping: a new hire pushing the list
 * down, a row dropped elsewhere, a search narrowing the list. Each row is found again
 * by where it leads (its href), so a row rebuilt for a new state still glides. */

import { easing, reducedMotion } from "./motion.ts";

const ROWS = ":is(.rail-row, .rail-pin, .cofounder-home)[href]";

export type RowPlaces = Map<string, { left: number; top: number }>;

function placesIn(list: HTMLElement): RowPlaces {
	const frame = list.getBoundingClientRect();
	const places: RowPlaces = new Map();
	for (const row of list.querySelectorAll<HTMLElement>(ROWS)) {
		if (!row.offsetParent) continue;
		const rect = row.getBoundingClientRect();
		places.set(row.getAttribute("href")!, {
			left: rect.left - frame.left + list.scrollLeft,
			top: rect.top - frame.top + list.scrollTop,
		});
	}
	return places;
}

/** Before the rail redraws: where every row stands. */
export function measureRows(list: HTMLElement): RowPlaces | undefined {
	if (reducedMotion() || typeof list.animate !== "function" || !list.isConnected) return undefined;
	return placesIn(list);
}

/** After the redraw: rows that moved start where they stood and glide home. */
export function glideRows(list: HTMLElement, before: RowPlaces | undefined): void {
	if (!before?.size) return;
	const after = placesIn(list);
	const curve = easing("--ease-spring");
	for (const row of list.querySelectorAll<HTMLElement>(ROWS)) {
		const href = row.getAttribute("href")!;
		const from = before.get(href);
		const to = after.get(href);
		if (!from || !to) continue;
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
		row.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: 380, easing: curve });
	}
}
