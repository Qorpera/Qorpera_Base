import { matchesKey } from "./keys.ts";

/** The preview's resting width; a member can grow it up to twice this along its edges. */
export const COMPUTER_PREVIEW_WIDTH = 400;
export const COMPUTER_PREVIEW_SCALE_LIMIT = 2;
const ASPECT = 16 / 9;
/** Edge band, in px inside the panel, that starts a resize instead of a move. */
const EDGE = 8;
const KEY_RESIZE_STEP = 40;

type Edge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
type Rect = { left: number; top: number; width: number; height: number };
type Drag = { id: number; x: number; y: number; from: Rect; moved: boolean; edge?: Edge };

/** The preview moves and resizes locally; dragging must never send pointer input to the desktop. */
export function attachComputerDrag(panel: HTMLElement, signal: AbortSignal): () => void {
	let position: { left: number; top: number } | undefined;
	let chosenWidth = COMPUTER_PREVIEW_WIDTH;
	let drag: Drag | undefined;
	let observer: ResizeObserver | undefined;
	const expanded = () => panel.classList.contains("is-entered") || Boolean(document.fullscreenElement);
	// The status row (send errors, run actions) sits above the composer and must stay reachable.
	const below = (parent: HTMLElement) =>
		[...parent.querySelectorAll<HTMLElement>(".thread-status, .composer")].reduce(
			(sum, element) => sum + element.getBoundingClientRect().height,
			0,
		);
	const header = (parent: HTMLElement) =>
		parent.querySelector<HTMLElement>(".thread-header")?.getBoundingClientRect().height ?? 0;
	/** The widest the preview can be shown between the thread header and the composer. */
	const fitWidth = (parent: HTMLElement) =>
		Math.max(
			0,
			Math.min(parent.clientWidth - 40, (parent.clientHeight - header(parent) - below(parent) - 16) * ASPECT),
		);
	const place = (left: number, top: number) => {
		const parent = panel.parentElement;
		if (!parent || expanded()) return;
		const inset = 8;
		const footer = below(parent);
		const minTop = header(parent) + inset;
		position = {
			left: Math.max(inset, Math.min(left, parent.clientWidth - panel.offsetWidth - inset)),
			top: Math.max(minTop, Math.min(top, parent.clientHeight - footer - panel.offsetHeight - inset)),
		};
		panel.style.setProperty("--computer-left", `${position.left}px`);
		panel.style.setProperty("--computer-top", `${position.top}px`);
	};
	const reclamp = () => {
		const parent = panel.parentElement;
		if (!parent || expanded()) return;
		const top = header(parent);
		const footer = below(parent);
		panel.style.setProperty("--computer-width", `${Math.min(chosenWidth, fitWidth(parent))}px`);
		if (position) place(position.left, position.top);
		else {
			// Keep the default right alignment until the member chooses a position.
			panel.style.setProperty(
				"--computer-top",
				`${Math.max(top + 8, Math.min(top + 20, parent.clientHeight - footer - panel.offsetHeight - 8))}px`,
			);
		}
	};
	const observe = () => {
		if (observer || !panel.parentElement || typeof ResizeObserver === "undefined") return;
		observer = new ResizeObserver(reclamp);
		observer.observe(panel.parentElement);
		observer.observe(panel);
		for (const boundary of panel.parentElement.querySelectorAll(".thread-header, .thread-status, .composer")) {
			observer.observe(boundary);
		}
	};
	// The panel is attached by its owner immediately after construction.
	queueMicrotask(() => {
		if (signal.aborted) return;
		observe();
		reclamp();
	});
	const frame = (): Rect | undefined => {
		const parent = panel.parentElement;
		if (!parent) return;
		const rect = panel.getBoundingClientRect(),
			bounds = parent.getBoundingClientRect();
		return { left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height };
	};
	const edgeAt = (event: PointerEvent): Edge | undefined => {
		const rect = panel.getBoundingClientRect();
		if (rect.width <= EDGE * 3 || rect.height <= EDGE * 3) return;
		const x = event.clientX - rect.left,
			y = event.clientY - rect.top;
		if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
		const vertical = y < EDGE ? "n" : y > rect.height - EDGE ? "s" : "";
		const horizontal = x < EDGE ? "w" : x > rect.width - EDGE ? "e" : "";
		return (`${vertical}${horizontal}` || undefined) as Edge | undefined;
	};
	/** Grow or shrink from `from`, keeping the edges opposite to `edge` where they are. */
	const resize = (from: Rect, edge: Edge, width: number) => {
		const parent = panel.parentElement;
		if (!parent) return;
		const inset = 8;
		const right = from.left + from.width,
			bottom = from.top + from.height;
		const limit = Math.min(
			COMPUTER_PREVIEW_WIDTH * COMPUTER_PREVIEW_SCALE_LIMIT,
			edge.includes("w") ? right - inset : parent.clientWidth - inset - from.left,
			(edge.includes("n")
				? bottom - header(parent) - inset
				: parent.clientHeight - below(parent) - inset - from.top) * ASPECT,
		);
		chosenWidth = Math.max(COMPUTER_PREVIEW_WIDTH, Math.min(width, limit));
		const shown = Math.min(chosenWidth, fitWidth(parent));
		panel.style.setProperty("--computer-width", `${shown}px`);
		place(edge.includes("w") ? right - shown : from.left, edge.includes("n") ? bottom - shown / ASPECT : from.top);
	};
	const finish = () => {
		if (!drag) return;
		const id = drag.id;
		drag = undefined;
		panel.classList.remove("is-dragging", "is-resizing");
		if (panel.hasPointerCapture(id)) panel.releasePointerCapture(id);
	};
	panel.addEventListener(
		"pointerdown",
		(event) => {
			if (expanded() || drag || !event.isPrimary || event.button !== 0) return;
			if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
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
				if (drag || expanded()) return;
				const onControl =
					event.target instanceof Element && event.target.closest("button, a, input, textarea, select");
				const edge = onControl ? undefined : edgeAt(event);
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
			const grow = !event.isComposing && (event.key === "+" || event.key === "=") ? 1 : event.key === "-" ? -1 : 0;
			if (grow) {
				const from = frame();
				if (!from) return;
				observe();
				resize(from, "se", from.width + grow * KEY_RESIZE_STEP);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			const dx = matchesKey(event, "left") ? -1 : matchesKey(event, "right") ? 1 : 0;
			const dy = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
			if (!dx && !dy) return;
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
	return reclamp;
}
