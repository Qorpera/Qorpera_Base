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
} as const;

export function matchesKey(event: KeyboardEvent, action: keyof typeof DEFAULT_APP_KEYBINDINGS): boolean {
	return !event.isComposing && event.key === DEFAULT_APP_KEYBINDINGS[action];
}
