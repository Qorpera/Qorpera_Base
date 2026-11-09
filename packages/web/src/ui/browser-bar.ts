/* The browser's own bar takes the colour of the page's top-left corner: the sidebar where one
 * shows, else the page. A page cannot read the colour of a browser's toolbar, so the sidebar
 * cannot follow it; instead the page tells the browser its colour with `theme-color`, and
 * browsers that honour it (Safari with "Show color in tab bar", an installed web app, phone
 * browsers) paint their bar to match, in every theme (Jonas, 9 Nov 2026: the sidebar should
 * match the browser's bar whatever the browser). Browsers that ignore it keep their own. */

/** The first fully opaque background under the page's top-left corner. Dimming layers under a
 * dialog are see-through, so the bar keeps the colour beneath them. */
export function topLeftColor(): string | undefined {
	for (const element of stackAt(1, 1)) {
		const style = getComputedStyle(element);
		if (style.visibility === "hidden" || style.opacity === "0") continue;
		if (opaque(style.backgroundColor)) return style.backgroundColor;
	}
	return undefined;
}

/** The elements whose boxes cover a point, topmost first, by position rather than hit testing:
 * hit testing skips inert parts of the page, such as the whole frame behind Settings, which
 * still paint under its see-through dimming. Paint order is taken as document order, later and
 * deeper on top, which holds for the page's corner (overlays are appended to the body last). */
function stackAt(x: number, y: number): Element[] {
	const found: Element[] = [document.body];
	const visit = (parent: Element) => {
		for (const child of parent.children) {
			const box = child.getBoundingClientRect();
			if (box.left <= x && x < box.right && box.top <= y && y < box.bottom) {
				found.push(child);
				visit(child);
			} else if (box.width === 0 && box.height === 0 && getComputedStyle(child).display === "contents") {
				visit(child);
			}
		}
	};
	visit(document.body);
	return found.reverse();
}

function opaque(color: string): boolean {
	if (!color || color === "transparent") return false;
	// Computed colours: rgb(r, g, b), rgba(r, g, b, a), or a slash form such as color(srgb r g b / a).
	const alpha = color.startsWith("rgba(")
		? color.slice(5, -1).split(",")[3]
		: color.includes("/")
			? color.slice(color.lastIndexOf("/") + 1, -1)
			: "1";
	if (alpha === undefined) return false;
	const value = alpha.trim();
	return (value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value)) >= 1;
}

/** Keep `<meta name="theme-color">` on the top-left colour as routes, the theme, the window
 * size and the sidebar change. Reads at most once a frame. */
export function watchBrowserBar(): () => void {
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.append(meta);
	}
	const tag = meta;
	let frame: number | undefined;
	const update = () => {
		frame = undefined;
		const color = topLeftColor();
		if (color && tag.content !== color) tag.content = color;
	};
	const schedule = () => {
		frame ??= requestAnimationFrame(update);
	};
	const system = window.matchMedia("(prefers-color-scheme: dark)");
	// The sidebar shows, hides or moves through `hidden` and classes.
	const observer = new MutationObserver(schedule);
	observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
	// A dialog or layer added to the page itself (not every change inside it).
	const layers = new MutationObserver(schedule);
	layers.observe(document.body, { childList: true });
	window.addEventListener("hashchange", schedule);
	window.addEventListener("resize", schedule);
	window.addEventListener("qorpera-theme-change", schedule);
	system.addEventListener("change", schedule);
	update();
	return () => {
		if (frame !== undefined) cancelAnimationFrame(frame);
		observer.disconnect();
		layers.disconnect();
		window.removeEventListener("hashchange", schedule);
		window.removeEventListener("resize", schedule);
		window.removeEventListener("qorpera-theme-change", schedule);
		system.removeEventListener("change", schedule);
	};
}
