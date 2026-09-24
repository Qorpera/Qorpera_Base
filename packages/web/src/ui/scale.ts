/* The app is drawn at tokens.css's --ui-scale: a design pixel ("14px" in the
 * stylesheets) covers that many screen pixels, 1.25 with a mouse or trackpad
 * and 1 on a phone or tablet. The build scales the stylesheets
 * (scripts/design-px.mjs); a script that sizes or places something in design
 * pixels goes through here. Pointer positions and measured boxes are already
 * screen pixels and need nothing. */

/** Screen pixels per design pixel; 1 until the stylesheet is in the page. Read each time: the
 * primary pointer can change (a tablet's keyboard, device emulation). */
export function uiScale(): number {
	const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
	return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** A design length for an inline style; it follows --px, so a part that keeps its own size keeps it here too. */
export const designPx = (value: number): string => `calc(${value} * var(--px, 1px))`;
