/* The app is drawn at tokens.css's --ui-scale: a design pixel ("14px" in the
 * stylesheets) covers that many screen pixels: Big is 1.3 with a mouse or trackpad,
 * Small is 1, and phones/tablets keep 1 in both sizes. The build scales the stylesheets
 * (scripts/design-px.mjs); a script that sizes or places something in design
 * pixels goes through here. Pointer positions and measured boxes are already
 * screen pixels and need nothing. */

/** Screen pixels per design pixel; 1 until the stylesheet is in the page. Read each time: the
 * preference or primary pointer can change (a tablet's keyboard, device emulation). */
import { hasBrowserCompositor } from "./time-slice.ts";

let cachedScaleKey = "";
let cachedScale = 1;
let scalePointerFine: MediaQueryList | undefined;

export function uiScale(): number {
	const root = document.documentElement;
	if (!hasBrowserCompositor()) {
		const scale = Number.parseFloat(getComputedStyle(root).getPropertyValue("--ui-scale"));
		return Number.isFinite(scale) && scale > 0 ? scale : 1;
	}
	if (!scalePointerFine && typeof window.matchMedia === "function") {
		scalePointerFine = window.matchMedia("(pointer: fine)");
	}
	const key = `${window.innerWidth}|${root.dataset.uiSize ?? ""}|${root.style.getPropertyValue("--ui-scale")}|${scalePointerFine?.matches ? 1 : 0}`;
	if (key === cachedScaleKey) return cachedScale;
	const scale = Number.parseFloat(getComputedStyle(root).getPropertyValue("--ui-scale"));
	cachedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
	cachedScaleKey = key;
	return cachedScale;
}

/** A design length for an inline style; it follows --px, so a part that keeps its own size keeps it here too. */
export const designPx = (value: number): string => `calc(${value} * var(--px, 1px))`;
