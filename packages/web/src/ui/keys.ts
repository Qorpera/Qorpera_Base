/** Browser defaults. Keep shared UI shortcuts in one place. */
export const DEFAULT_APP_KEYBINDINGS = {
	dismiss: "Escape",
	next: "ArrowDown",
	previous: "ArrowUp",
	first: "Home",
	last: "End",
	tab: "Tab",
	accept: "Enter",
	space: " ",
	left: "ArrowLeft",
	right: "ArrowRight",
	/** "=" is the unshifted "+" on most layouts. */
	grow: ["+", "="],
	shrink: "-",
} as const;

export function matchesKey(event: KeyboardEvent, action: keyof typeof DEFAULT_APP_KEYBINDINGS): boolean {
	if (event.isComposing) return false;
	const keys: string | readonly string[] = DEFAULT_APP_KEYBINDINGS[action];
	return typeof keys === "string" ? event.key === keys : keys.includes(event.key);
}
