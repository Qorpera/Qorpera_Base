(() => {
	const handle = document.getElementById("railResizeHandle");
	const rail = document.getElementById("primaryNavigation");
	const search = document.getElementById("railSearch");
	if (!(handle instanceof HTMLElement) || !(rail instanceof HTMLElement)) return;

	const COMPACT_WIDTH = 80;
	const SNAP_WIDTH = 168;
	const MIN_EXPANDED_WIDTH = 176;
	const DEFAULT_WIDTH = 304;
	const MAX_WIDTH = 380;
	const WIDTH_KEY = "qorpera:agent-rail-width";
	const COMPACT_KEY = "qorpera:agent-rail-compact";
	let lastExpandedWidth = DEFAULT_WIDTH;
	let pointerId = null;
	let dragStartX = 0;
	let dragStartWidth = DEFAULT_WIDTH;
	let liveWidth = DEFAULT_WIDTH;

	function readStoredNumber(key, fallback) {
		try {
			const value = Number(localStorage.getItem(key));
			return Number.isFinite(value) && value > 0 ? value : fallback;
		} catch {
			return fallback;
		}
	}

	function readStoredCompact() {
		try {
			return localStorage.getItem(COMPACT_KEY) === "true";
		} catch {
			return false;
		}
	}

	function maximumWidth() {
		return Math.max(MIN_EXPANDED_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.44)));
	}

	function clampExpanded(width) {
		return Math.min(maximumWidth(), Math.max(MIN_EXPANDED_WIDTH, Math.round(width)));
	}

	function storeState(compact, width) {
		try {
			localStorage.setItem(COMPACT_KEY, String(compact));
			if (!compact) localStorage.setItem(WIDTH_KEY, String(width));
		} catch {
			/* Storage is a convenience; resizing remains functional without it. */
		}
	}

	function syncCompactTooltips(compact) {
		for (const row of document.querySelectorAll("#staffNavigation .staff-nav-row, #staffNavigation .controller-nav-row")) {
			if (!(row instanceof HTMLElement)) continue;
			if (compact) {
				const name = row.querySelector("strong")?.textContent?.trim() || "Agent";
				const status = row.querySelector("small")?.textContent?.trim();
				row.title = status ? `${name} — ${status}` : name;
				row.dataset.railCompactTitle = "true";
			} else if (row.dataset.railCompactTitle === "true") {
				row.removeAttribute("title");
				delete row.dataset.railCompactTitle;
			}
		}
	}

	function setRail(width, compact, persist = false, unrestricted = false) {
		const nextWidth = unrestricted
			? Math.min(maximumWidth(), Math.max(COMPACT_WIDTH, Math.round(width)))
			: compact
				? COMPACT_WIDTH
				: clampExpanded(width);
		liveWidth = nextWidth;
		if (!compact) lastExpandedWidth = nextWidth;
		document.documentElement.style.setProperty("--rail-width", `${nextWidth}px`);
		document.body.classList.toggle("rail-compact", compact);
		handle.setAttribute("aria-valuenow", String(nextWidth));
		handle.setAttribute("aria-valuemax", String(maximumWidth()));
		handle.setAttribute("aria-valuetext", compact ? "Compact figure navigation" : `${nextWidth} pixels`);
		syncCompactTooltips(compact);
		if (persist) storeState(compact, nextWidth);
	}

	function toggleCompact() {
		const compact = document.body.classList.contains("rail-compact");
		setRail(compact ? lastExpandedWidth : COMPACT_WIDTH, !compact, true);
	}

	function finishDrag() {
		if (pointerId === null) return;
		const compact = liveWidth <= SNAP_WIDTH;
		document.body.classList.remove("rail-resizing");
		handle.removeAttribute("data-dragging");
		try {
			handle.releasePointerCapture(pointerId);
		} catch {
			/* Capture can already be released when the window loses focus. */
		}
		pointerId = null;
		setRail(compact ? COMPACT_WIDTH : liveWidth, compact, true);
	}

	handle.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		pointerId = event.pointerId;
		dragStartX = event.clientX;
		dragStartWidth = liveWidth;
		handle.setPointerCapture(pointerId);
		handle.dataset.dragging = "true";
		document.body.classList.add("rail-resizing");
		event.preventDefault();
	});

	handle.addEventListener("pointermove", (event) => {
		if (event.pointerId !== pointerId) return;
		const width = Math.min(maximumWidth(), Math.max(COMPACT_WIDTH, dragStartWidth + event.clientX - dragStartX));
		setRail(width, width <= SNAP_WIDTH, false, true);
	});

	handle.addEventListener("pointerup", finishDrag);
	handle.addEventListener("pointercancel", finishDrag);
	handle.addEventListener("dblclick", toggleCompact);
	handle.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggleCompact();
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			setRail(COMPACT_WIDTH, true, true);
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			setRail(maximumWidth(), false, true);
			return;
		}
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const direction = event.key === "ArrowLeft" ? -1 : 1;
		const compact = document.body.classList.contains("rail-compact");
		const width = compact && direction > 0 ? lastExpandedWidth : liveWidth + direction * 16;
		setRail(width, width <= SNAP_WIDTH, true);
	});

	search?.addEventListener("focus", () => {
		if (document.body.classList.contains("rail-compact")) setRail(lastExpandedWidth, false, true);
	});

	new MutationObserver(() => syncCompactTooltips(document.body.classList.contains("rail-compact"))).observe(
		document.getElementById("staffNavigation") ?? rail,
		{ childList: true, subtree: true },
	);

	window.addEventListener("resize", () => {
		if (document.body.classList.contains("rail-compact")) return;
		setRail(Math.min(liveWidth, maximumWidth()), false, true);
	});

	lastExpandedWidth = clampExpanded(readStoredNumber(WIDTH_KEY, DEFAULT_WIDTH));
	const compact = readStoredCompact();
	setRail(compact ? COMPACT_WIDTH : lastExpandedWidth, compact);
})();
