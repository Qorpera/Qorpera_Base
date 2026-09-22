import { matchesKey } from "./keys.ts";

/** The preview's resting width; a member can grow it up to twice this along its edges. */
const COMPUTER_PREVIEW_WIDTH = 400;
const COMPUTER_PREVIEW_SCALE_LIMIT = 2;
const ASPECT = 16 / 9;
/** Edge band, in px inside the panel, that starts a resize instead of a move; a fingertip needs more. */
const EDGE = { mouse: 8, touch: 20 };
const KEY_RESIZE_STEP = 40;

type Edge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
type Rect = { left: number; top: number; width: number; height: number };
type Bounds = { top: number; footer: number; fit: number };
type Drag = { id: number; x: number; y: number; from: Rect; moved: boolean; edge?: Edge };

/** The preview moves and resizes locally; dragging must never send pointer input to the desktop. */
export function attachComputerDrag(panel: HTMLElement, signal: AbortSignal): () => void {
	let position: { left: number; top: number } | undefined;
	let chosenWidth = COMPUTER_PREVIEW_WIDTH;
	let drag: Drag | undefined;
	let observer: ResizeObserver | undefined;
	/** The thread the observer watches; the panel moves between threads and keeps its place. */
	let observed: HTMLElement | undefined;
	const expanded = () => panel.classList.contains("is-entered") || Boolean(document.fullscreenElement);
	// The status row (send errors, run actions) sits above the composer and must stay reachable.
	const below = (parent: HTMLElement) =>
		[...parent.querySelectorAll<HTMLElement>(".thread-status, .composer")].reduce(
			(sum, element) => sum + element.getBoundingClientRect().height,
			0,
		);
	const header = (parent: HTMLElement) =>
		parent.querySelector<HTMLElement>(".thread-header")?.getBoundingClientRect().height ?? 0;
	/** One layout read per interaction: the thread's edges and the widest preview that fits between them. */
	const measure = (parent: HTMLElement): Bounds => {
		const top = header(parent),
			footer = below(parent);
		return {
			top,
			footer,
			fit: Math.max(0, Math.min(parent.clientWidth - 40, (parent.clientHeight - top - footer - 16) * ASPECT)),
		};
	};
	/** A thread that is not in the page yet has no size; clamping against it would lose the member's position. */
	const sized = (parent: HTMLElement) => parent.clientWidth > 0 && parent.clientHeight > 0;
	const place = (left: number, top: number, bounds?: Bounds) => {
		const parent = panel.parentElement;
		if (!parent || expanded() || !sized(parent)) return;
		const inset = 8;
		const { top: minTop, footer } = bounds ?? measure(parent);
		position = {
			left: Math.max(inset, Math.min(left, parent.clientWidth - panel.offsetWidth - inset)),
			top: Math.max(minTop + inset, Math.min(top, parent.clientHeight - footer - panel.offsetHeight - inset)),
		};
		panel.style.setProperty("--computer-left", `${position.left}px`);
		panel.style.setProperty("--computer-top", `${position.top}px`);
	};
	const reclamp = () => {
		const parent = panel.parentElement;
		// Off the page the observer fits the preview once the thread has a size.
		if (!parent || expanded() || !sized(parent)) return;
		const bounds = measure(parent);
		panel.style.setProperty("--computer-width", `${Math.min(chosenWidth, bounds.fit)}px`);
		if (position) place(position.left, position.top, bounds);
		else {
			// Keep the default right alignment until the member chooses a position.
			const { top, footer } = bounds;
			panel.style.setProperty(
				"--computer-top",
				`${Math.max(top + 8, Math.min(top + 20, parent.clientHeight - footer - panel.offsetHeight - 8))}px`,
			);
		}
	};
	const observe = () => {
		const parent = panel.parentElement;
		if (!parent || typeof ResizeObserver === "undefined" || (observer && observed === parent)) return;
		observer?.disconnect();
		observed = parent;
		observer = new ResizeObserver(reclamp);
		observer.observe(parent);
		observer.observe(panel);
		for (const boundary of parent.querySelectorAll(".thread-header, .thread-status, .composer")) {
			observer.observe(boundary);
		}
	};
	/** Fit the preview to the thread it is in now; the owner calls this on every attach and
	 * detach. Out of any thread, the observer lets go of the last one so it can be collected. */
	const refit = () => {
		if (signal.aborted) return;
		if (!panel.parentElement) {
			observer?.disconnect();
			observer = undefined;
			observed = undefined;
			return;
		}
		observe();
		reclamp();
	};
	// The panel is attached by its owner immediately after construction.
	queueMicrotask(refit);
	const frame = (): Rect | undefined => {
		const parent = panel.parentElement;
		if (!parent) return;
		const rect = panel.getBoundingClientRect(),
			bounds = parent.getBoundingClientRect();
		return { left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height };
	};
	const edgeAt = (event: PointerEvent): Edge | undefined => {
		const band = event.pointerType === "mouse" ? EDGE.mouse : EDGE.touch;
		const rect = panel.getBoundingClientRect();
		if (rect.width <= band * 3 || rect.height <= band * 3) return;
		const x = event.clientX - rect.left,
			y = event.clientY - rect.top;
		if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
		const vertical = y < band ? "n" : y > rect.height - band ? "s" : "";
		const horizontal = x < band ? "w" : x > rect.width - band ? "e" : "";
		return (`${vertical}${horizontal}` || undefined) as Edge | undefined;
	};
	/**
	 * Grow or shrink from `from`. The edges opposite to a dragged `edge` stay where they are; along the other
	 * axis (and for the keyboard, both) the preview only has to fit the thread, so it shifts as needed.
	 */
	const resize = (from: Rect, edge: Edge | undefined, width: number) => {
		const parent = panel.parentElement;
		if (!parent) return;
		const inset = 8;
		const bounds = measure(parent);
		const right = from.left + from.width,
			bottom = from.top + from.height;
		const anchoredWidth = edge?.includes("w")
			? right - inset
			: edge?.includes("e")
				? parent.clientWidth - inset - from.left
				: Number.POSITIVE_INFINITY;
		const anchoredHeight = edge?.includes("n")
			? bottom - bounds.top - inset
			: edge?.includes("s")
				? parent.clientHeight - bounds.footer - inset - from.top
				: Number.POSITIVE_INFINITY;
		const limit = Math.min(
			COMPUTER_PREVIEW_WIDTH * COMPUTER_PREVIEW_SCALE_LIMIT,
			bounds.fit,
			anchoredWidth,
			anchoredHeight * ASPECT,
		);
		chosenWidth = Math.max(COMPUTER_PREVIEW_WIDTH, Math.min(width, limit));
		const shown = Math.min(chosenWidth, bounds.fit);
		panel.style.setProperty("--computer-width", `${shown}px`);
		place(
			edge?.includes("w") ? right - shown : from.left,
			edge?.includes("n") ? bottom - shown / ASPECT : from.top,
			bounds,
		);
	};
	// The enter animation slides the panel in by 18px; once the member takes hold of it, measurements and
	// positions must be the panel's own. Toggling animation via a class would replay the slide on release.
	const settle = () => {
		if (panel.style.animation !== "none") panel.style.animation = "none";
	};
	const finish = () => {
		if (!drag) return;
		const id = drag.id;
		drag = undefined;
		panel.classList.remove("is-dragging", "is-resizing");
		delete panel.dataset.resize;
		if (panel.hasPointerCapture(id)) panel.releasePointerCapture(id);
	};
	// A press focuses the panel (below, by script) and a click focuses a button. That focus must not keep the
	// hover controls up once the pointer has left, so the press is marked (is-pointer-focus, read by the
	// stylesheet); keyboard focus clears the mark and shows the controls until it leaves. Only the primary
	// button moves focus: a press that moves none (a right click, or a button in a browser whose buttons take
	// no focus) is forgotten on release, so it cannot mark a later keyboard focus.
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
	panel.addEventListener(
		"pointerdown",
		(event) => {
			if (expanded() || drag || !event.isPrimary || event.button !== 0) return;
			if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
			settle();
			const from = frame();
			if (!from) return;
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from, moved: false, edge: edgeAt(event) };
			observe();
			panel.setPointerCapture(event.pointerId);
			panel.focus({ preventScroll: true });
			event.preventDefault();
			event.stopPropagation();
		},
		{ capture: true, signal },
	);
	panel.addEventListener(
		"pointermove",
		(event) => {
			if (!drag || event.pointerId !== drag.id) {
				// A mouse or a hovering pen shows a cursor; a finger does not, so it skips the edge lookup.
				if (drag || event.pointerType === "touch" || expanded()) return;
				const onControl =
					event.target instanceof Element && event.target.closest("button, a, input, textarea, select");
				const edge = onControl ? undefined : edgeAt(event);
				if (edge === panel.dataset.resize) return;
				if (edge) panel.dataset.resize = edge;
				else delete panel.dataset.resize;
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (expanded()) {
				finish();
				return;
			}
			const dx = event.clientX - drag.x,
				dy = event.clientY - drag.y;
			if (!drag.moved && Math.hypot(dx, dy) < 4) return;
			drag.moved = true;
			const { from, edge } = drag;
			if (!edge) {
				panel.classList.add("is-dragging");
				place(from.left + dx, from.top + dy);
				return;
			}
			panel.classList.add("is-resizing");
			panel.dataset.resize = edge;
			const byWidth = edge.includes("e") ? from.width + dx : edge.includes("w") ? from.width - dx : undefined;
			const byHeight = edge.includes("s")
				? (from.height + dy) * ASPECT
				: edge.includes("n")
					? (from.height - dy) * ASPECT
					: undefined;
			// A corner follows whichever direction the pointer travelled further.
			const width =
				byWidth !== undefined && byHeight !== undefined
					? Math.abs(byWidth - from.width) >= Math.abs(byHeight - from.width)
						? byWidth
						: byHeight
					: (byWidth ?? byHeight ?? from.width);
			resize(from, edge, width);
		},
		{ capture: true, signal },
	);
	panel.addEventListener(
		"pointerup",
		(event) => {
			if (event.pointerId !== drag?.id) return;
			finish();
			event.preventDefault();
			event.stopPropagation();
		},
		{ capture: true, signal },
	);
	const cancel = (event: PointerEvent) => {
		if (event.pointerId === drag?.id) finish();
	};
	panel.addEventListener("pointercancel", cancel, { signal });
	panel.addEventListener("lostpointercapture", cancel, { signal });
	panel.addEventListener(
		"pointerleave",
		() => {
			if (!drag) delete panel.dataset.resize;
		},
		{ signal },
	);
	panel.addEventListener(
		"keydown",
		(event) => {
			if (event.target !== panel || expanded() || event.altKey || event.ctrlKey || event.metaKey) return;
			const grow = matchesKey(event, "grow") ? 1 : matchesKey(event, "shrink") ? -1 : 0;
			if (grow) {
				settle();
				const from = frame();
				if (!from) return;
				observe();
				resize(from, undefined, from.width + grow * KEY_RESIZE_STEP);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			const dx = matchesKey(event, "left") ? -1 : matchesKey(event, "right") ? 1 : 0;
			const dy = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
			if (!dx && !dy) return;
			settle();
			const from = frame();
			if (!from) return;
			const step = event.shiftKey ? 50 : 10;
			observe();
			place(from.left + dx * step, from.top + dy * step);
			event.preventDefault();
			event.stopPropagation();
		},
		{ signal },
	);
	window.addEventListener("resize", reclamp, { signal });
	signal.addEventListener(
		"abort",
		() => {
			finish();
			observer?.disconnect();
		},
		{ once: true },
	);
	return refit;
}
