import { matchesKey } from "./keys.ts";

/** The preview moves locally; dragging must never send pointer input to the desktop. */
export function attachComputerDrag(panel: HTMLElement, signal: AbortSignal): () => void {
	let position: { left: number; top: number } | undefined;
	let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | undefined;
	let observer: ResizeObserver | undefined;
	const expanded = () => panel.classList.contains("is-entered") || Boolean(document.fullscreenElement);
	// The status row (send errors, run actions) sits above the composer and must stay reachable.
	const below = (parent: HTMLElement) =>
		[...parent.querySelectorAll<HTMLElement>(".thread-status, .composer")].reduce(
			(sum, element) => sum + element.getBoundingClientRect().height,
			0,
		);
	const place = (left: number, top: number) => {
		const parent = panel.parentElement;
		if (!parent || expanded()) return;
		const inset = 8;
		const header = parent.querySelector<HTMLElement>(".thread-header")?.getBoundingClientRect().height ?? 0;
		const footer = below(parent);
		const minTop = header + inset;
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
		const header = parent.querySelector<HTMLElement>(".thread-header")?.getBoundingClientRect().height ?? 0;
		const footer = below(parent);
		const height = Math.max(0, parent.clientHeight - header - footer - 16);
		const width = Math.max(0, Math.min(400, parent.clientWidth - 40, (height * 16) / 9));
		panel.style.setProperty("--computer-width", `${width}px`);
		if (position) place(position.left, position.top);
		else {
			// Keep the default right alignment until the member chooses a position.
			panel.style.setProperty(
				"--computer-top",
				`${Math.max(header + 8, Math.min(header + 20, parent.clientHeight - footer - panel.offsetHeight - 8))}px`,
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
	const finish = () => {
		if (!drag) return;
		const id = drag.id;
		drag = undefined;
		panel.classList.remove("is-dragging");
		if (panel.hasPointerCapture(id)) panel.releasePointerCapture(id);
	};
	panel.addEventListener(
		"pointerdown",
		(event) => {
			if (expanded() || drag || !event.isPrimary || event.button !== 0) return;
			if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
			const parent = panel.parentElement;
			if (!parent) return;
			const rect = panel.getBoundingClientRect();
			const bounds = parent.getBoundingClientRect();
			drag = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				left: rect.left - bounds.left,
				top: rect.top - bounds.top,
				moved: false,
			};
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
			if (!drag || event.pointerId !== drag.id) return;
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
			panel.classList.add("is-dragging");
			place(drag.left + dx, drag.top + dy);
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
		"keydown",
		(event) => {
			if (event.target !== panel || expanded() || event.altKey || event.ctrlKey || event.metaKey) return;
			const dx = matchesKey(event, "left") ? -1 : matchesKey(event, "right") ? 1 : 0;
			const dy = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
			if (!dx && !dy) return;
			const parent = panel.parentElement;
			if (!parent) return;
			const rect = panel.getBoundingClientRect(),
				bounds = parent.getBoundingClientRect();
			const step = event.shiftKey ? 50 : 10;
			observe();
			place(rect.left - bounds.left + dx * step, rect.top - bounds.top + dy * step);
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
