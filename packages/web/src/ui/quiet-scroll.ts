/** How far a quiet scroller's top fade reaches, in CSS pixels; app.css draws it the same size. */
export const QUIET_SCROLL_FADE = 28;

/**
 * Marks a scroller that hides its bar, like Messages. The bar's job as the cue that content
 * continues above passes to a fade at the top edge, which `.scroll-quiet[data-scrolled]` in
 * app.css draws while the scroller is away from its top. Programmatic scrolls fire scroll events
 * too, but only with the next rendered frame; the returned refresh reads the position at once,
 * for a scroller that moves itself while the page is not being drawn (a pin from a ResizeObserver
 * in a hidden window).
 */
export function quietScroll(scroller: HTMLElement): () => void {
	scroller.classList.add("scroll-quiet");
	const update = () => scroller.toggleAttribute("data-scrolled", scroller.scrollTop > 0);
	scroller.addEventListener("scroll", update, { passive: true });
	update();
	return update;
}
