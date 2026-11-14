/** The agent's computer stands in its thread as a row beside the agent's figure (Jonas, 14 Nov 2026): it is not moved
 * or resized by hand any more. What is left of the preview's own handling:
 * - a press on the preview focuses it, and that focus is marked (is-pointer-focus, read by the stylesheet) so it does
 *   not keep the hover controls up once the pointer has left; keyboard focus clears the mark and shows them;
 * - the large view covers the thread the row stands in (its `.thread-body`): the panel is fixed to that box while it
 *   is entered, since the row scrolls with the thread. Called as the view enters, before its zoom moves it.
 * Returns `place`, which sets that box from the thread's place on the page (or clears it while not entered). */
export function attachComputerPlace(panel: HTMLElement, signal: AbortSignal): () => void {
	// Only the primary button moves focus: a press that moves none (a right click, or a button in a browser whose buttons
	// take no focus) is forgotten on release, so it cannot mark a later keyboard focus.
	let pressed = false;
	const mark = (on: boolean) => panel.classList.toggle("is-pointer-focus", on);
	panel.addEventListener(
		"pointerdown",
		(event) => {
			if (event.button !== 0) return;
			pressed = true;
			if (panel.contains(document.activeElement)) mark(true);
		},
		{ capture: true, signal },
	);
	panel.addEventListener(
		"pointerdown",
		(event) => {
			if (!event.isPrimary || event.button !== 0 || panel.classList.contains("is-entered")) return;
			if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
			if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
		},
		{ signal },
	);
	panel.addEventListener(
		"focusin",
		(event) => {
			// Focus moving within the panel keeps the mark it has.
			if (event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) return;
			mark(pressed);
			pressed = false;
		},
		{ signal },
	);
	const released = () => {
		pressed = false;
	};
	document.addEventListener("pointerup", released, { capture: true, signal });
	document.addEventListener("pointercancel", released, { capture: true, signal });
	panel.addEventListener("keydown", () => mark(false), { capture: true, signal });
	panel.addEventListener(
		"focusout",
		(event) => {
			if (!(event.relatedTarget instanceof Node && panel.contains(event.relatedTarget))) mark(false);
		},
		{ signal },
	);

	const BOX = ["--computer-box-top", "--computer-box-left", "--computer-box-right", "--computer-box-bottom"] as const;
	let observer: ResizeObserver | undefined;
	let observed: HTMLElement | undefined;
	const place = () => {
		const thread = panel.classList.contains("is-entered")
			? (panel.closest<HTMLElement>(".thread-body") ?? undefined)
			: undefined;
		if (thread !== observed) {
			observer?.disconnect();
			observed = thread;
			if (thread && typeof ResizeObserver === "function") {
				observer ??= new ResizeObserver(() => place());
				observer.observe(thread);
			}
		}
		for (const name of BOX) panel.style.removeProperty(name);
		if (!thread) return;
		// A fixed box is placed against the window, or against an ancestor that contains it (a container query's
		// container may): read where the panel lands with the box at nothing, and set the box from there.
		const style = getComputedStyle(panel);
		const at = panel.getBoundingClientRect();
		const inset = (value: string) => Number.parseFloat(value) || 0;
		const frame = {
			top: at.top - inset(style.top),
			left: at.left - inset(style.left),
			right: at.right + inset(style.right),
			bottom: at.bottom + inset(style.bottom),
		};
		const box = thread.getBoundingClientRect();
		const values = [box.top - frame.top, box.left - frame.left, frame.right - box.right, frame.bottom - box.bottom];
		for (const [index, name] of BOX.entries()) panel.style.setProperty(name, `${Math.round(values[index] ?? 0)}px`);
	};
	window.addEventListener("resize", place, { signal });
	signal.addEventListener("abort", () => observer?.disconnect(), { once: true });
	return place;
}
