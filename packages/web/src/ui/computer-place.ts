/** The agent's computer stands in its thread as a row beside the agent's figure (Jonas, 14 Nov 2026): it is not moved
 * or resized by hand any more. What is left of the preview's own handling:
 * - a press on the preview focuses it, and that focus is marked (is-pointer-focus, read by the stylesheet) so it does
 *   not keep the hover controls up once the pointer has left; keyboard focus clears the mark and shows them;
 * - the large view covers the thread the row stands in (its `.thread-body`): the panel is fixed to that box while it
 *   is entered, since the row scrolls with the thread. Called as the view enters, and again whenever the thread's size
 *   changes: also WHILE the view's zoom moves and scales the panel, so nothing here is read from the panel itself.
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
		const parent = panel.parentElement;
		if (!thread || !parent) {
			for (const name of BOX) panel.style.removeProperty(name);
			return;
		}
		// A fixed box is placed against the window, or against an ancestor that contains it (a container query's
		// container may). Where that is, a still probe beside the panel says: fixed as the panel is, at nothing on every
		// side, never drawn. It is NOT read from the panel: the large view's zoom moves and scales the panel while it
		// enters, the thread's observer calls here during it, and a reading of the moving panel put the box partly off
		// the window (seen live on 14 Nov 2026: top -102px, right -109px, bottom -226px in a 1280 by 800 window).
		const probe = document.createElement("div");
		probe.setAttribute("data-computer-place-probe", "");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText =
			"position: fixed; top: 0; left: 0; right: 0; bottom: 0; visibility: hidden; pointer-events: none;";
		parent.insertBefore(probe, panel);
		const frame = probe.getBoundingClientRect();
		probe.remove();
		const box = thread.getBoundingClientRect();
		const values = [box.top - frame.top, box.left - frame.left, frame.right - box.right, frame.bottom - box.bottom];
		for (const [index, name] of BOX.entries()) panel.style.setProperty(name, `${Math.round(values[index] ?? 0)}px`);
	};
	window.addEventListener("resize", place, { signal });
	signal.addEventListener("abort", () => observer?.disconnect(), { once: true });
	return place;
}
