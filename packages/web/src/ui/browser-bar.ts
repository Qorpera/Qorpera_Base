/* The browser's own bar takes the colour of the page's top-left corner: the sidebar where one
 * shows, else the page. A page cannot read the colour of a browser's toolbar, so the sidebar
 * cannot follow it; instead the page tells the browser its colour with `theme-color`, and
 * browsers that honour it (Safari with "Show color in tab bar", an installed web app, phone
 * browsers) paint their bar to match, in every theme (Jonas, 9 Nov 2026: the sidebar should
 * match the browser's bar whatever the browser). Browsers that ignore it keep their own. */

/** The first fully opaque background under the page's top-left corner. Dimming layers under a
 * dialog are see-through, so the bar keeps the colour beneath them. */
export function topLeftColor(): string | undefined {
	// A document without layout (a test's) has nothing under any point.
	if (typeof document.elementsFromPoint !== "function") return undefined;
	for (const element of document.elementsFromPoint(1, 1)) {
		const color = getComputedStyle(element).backgroundColor;
		if (opaque(color)) return color;
	}
	return undefined;
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
	// The sidebar shows, hides or moves through `hidden` and classes; a route draws into the page.
	const observer = new MutationObserver(schedule);
	observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
	window.addEventListener("hashchange", schedule);
	window.addEventListener("resize", schedule);
	window.addEventListener("qorpera-theme-change", schedule);
	system.addEventListener("change", schedule);
	update();
	return () => {
		if (frame !== undefined) cancelAnimationFrame(frame);
		observer.disconnect();
		window.removeEventListener("hashchange", schedule);
		window.removeEventListener("resize", schedule);
		window.removeEventListener("qorpera-theme-change", schedule);
		system.removeEventListener("change", schedule);
	};
}
