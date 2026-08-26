/* Pointer-driven roster drag-and-drop. Persistence stays with renderer.js;
 * this file owns only pointer interaction, drop placement, and the preview. */
(() => {
	let activeCleanup = null;
	let clickSuppressedUntil = 0;
	const layoutAnimations = new WeakMap();

	function moveOrder(pinnedIds, listIds, id, targetPinned, targetId = null, after = false) {
		const pinned = pinnedIds.filter((candidate) => candidate !== id);
		const list = listIds.filter((candidate) => candidate !== id);
		const target = targetPinned ? pinned : list;
		const targetIndex = targetId ? target.indexOf(targetId) : -1;
		const insertionIndex = targetIndex < 0 ? target.length : targetIndex + Number(after);
		target.splice(insertionIndex, 0, id);
		return { pinned, list, order: [...pinned, ...list] };
	}

	function zoneIds(zone) {
		return [...zone.querySelectorAll(":scope > .staff-nav-row[data-staff-id]")]
			.map((row) => row.dataset.staffId)
			.filter(Boolean);
	}

	function sameOrder(left, right) {
		return left.length === right.length && left.every((id, index) => id === right[index]);
	}

	function applyOrder(pinnedZone, listZone, pinnedIds, listIds) {
		const rows = new Map(
			[...pinnedZone.children, ...listZone.children]
				.filter((child) => child.matches?.(".staff-nav-row[data-staff-id]"))
				.map((child) => [child.dataset.staffId, child]),
		);
		for (const id of pinnedIds) {
			const row = rows.get(id);
			if (!row) continue;
			row.classList.add("staff-pinned-card");
			pinnedZone.append(row);
		}
		for (const id of listIds) {
			const row = rows.get(id);
			if (!row) continue;
			row.classList.remove("staff-pinned-card");
			listZone.append(row);
		}
	}

	function animateLayout(root, mutate) {
		const rows = [...root.querySelectorAll(".staff-nav-row[data-staff-id]")];
		const before = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
		for (const row of rows) layoutAnimations.get(row)?.cancel();
		mutate();
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		for (const row of rows) {
			if (typeof row.animate !== "function") continue;
			const start = before.get(row);
			const end = row.getBoundingClientRect();
			const x = start.left - end.left;
			const y = start.top - end.top;
			if (x === 0 && y === 0) continue;
			const animation = row.animate(
				[
					{ transform: `translate3d(${x}px, ${y}px, 0)` },
					{ transform: "translate3d(0, 0, 0)" },
				],
				{ duration: 140, easing: "cubic-bezier(.2, .8, .2, 1)" },
			);
			layoutAnimations.set(row, animation);
			animation.addEventListener(
				"finish",
				() => {
					if (layoutAnimations.get(row) === animation) layoutAnimations.delete(row);
				},
				{ once: true },
			);
		}
	}

	function dragPreview(row) {
		const preview = row.cloneNode(true);
		preview.classList.remove("active", "peer-open", "is-dragging");
		preview.classList.add("staff-drag-preview", "is-pointer-preview");
		preview.removeAttribute("aria-current");
		preview.removeAttribute("data-staff-id");
		preview.removeAttribute("data-draggable");
		document.body.appendChild(preview);
		return preview;
	}

	function wire({ root, pinnedZone, listZone, onMove }) {
		activeCleanup?.();
		let pointerStart = null;
		let draggedId = null;
		let draggedRow = null;
		let preview = null;
		let drop = null;
		let initialOrder = null;

		const finish = () => {
			root.classList.remove("staff-reordering");
			draggedRow?.classList.remove("is-dragging");
			draggedRow?.removeAttribute("aria-grabbed");
			preview?.remove();
			pinnedZone.hidden = pinnedZone.children.length === 0;
			draggedId = null;
			draggedRow = null;
			preview = null;
			drop = null;
			initialOrder = null;
		};

		const restoreInitialOrder = () => {
			if (!initialOrder) return;
			animateLayout(root, () => applyOrder(pinnedZone, listZone, initialOrder.pinned, initialOrder.list));
		};

		const previewOrder = (move, currentPinned, currentList) => {
			if (!sameOrder(move.pinned, currentPinned) || !sameOrder(move.list, currentList)) {
				animateLayout(root, () => applyOrder(pinnedZone, listZone, move.pinned, move.list));
			}
			drop = { pinned: move.pinned.includes(draggedId), order: move.order };
		};

		const begin = (row) => {
			draggedId = row.dataset.staffId;
			draggedRow = row;
			initialOrder = { pinned: zoneIds(pinnedZone), list: zoneIds(listZone) };
			pinnedZone.hidden = false;
			root.classList.add("staff-reordering");
			row.classList.add("is-dragging");
			row.setAttribute("aria-grabbed", "true");
			preview = dragPreview(row);
		};

		const position = (event) => {
			if (!draggedId || !preview) return;
			preview.style.transform = `translate3d(${event.clientX + 12}px, ${event.clientY - 46}px, 0)`;
			const hit = document.elementFromPoint(event.clientX, event.clientY);
			const targetRow = hit?.closest(".staff-nav-row[data-staff-id]");
			if (targetRow?.dataset.staffId === draggedId) return;
			if (targetRow && targetRow.dataset.staffId !== draggedId) {
				const zone = targetRow.parentElement;
				if (zone !== pinnedZone && zone !== listZone) {
					drop = null;
					return;
				}
				const bounds = targetRow.getBoundingClientRect();
				const after = zone === pinnedZone
					? event.clientX >= bounds.left + bounds.width / 2
					: event.clientY >= bounds.top + bounds.height / 2;
				const currentPinned = zoneIds(pinnedZone);
				const currentList = zoneIds(listZone);
				const move = moveOrder(
					currentPinned,
					currentList,
					draggedId,
					zone === pinnedZone,
					targetRow.dataset.staffId,
					after,
				);
				previewOrder(move, currentPinned, currentList);
				return;
			}
			const zone = hit?.closest(".staff-pinned-grid, .staff-unpinned-list");
			if (zone !== pinnedZone && zone !== listZone) {
				drop = null;
				return;
			}
			const currentPinned = zoneIds(pinnedZone);
			const currentList = zoneIds(listZone);
			const move = moveOrder(currentPinned, currentList, draggedId, zone === pinnedZone);
			previewOrder(move, currentPinned, currentList);
		};

		const commit = () => {
			if (!draggedId || !drop) {
				restoreInitialOrder();
				finish();
				return;
			}
			const id = draggedId;
			const pinned = drop.pinned;
			const order = drop.order;
			finish();
			onMove({ id, pinned, order });
		};

		const onPointerDown = (event) => {
			if (event.button !== 0 || !event.isPrimary) return;
			const row = event.target.closest(".staff-nav-row[data-staff-id]");
			if (!row || !root.contains(row)) return;
			pointerStart = { pointerId: event.pointerId, row, x: event.clientX, y: event.clientY };
		};
		const onPointerMove = (event) => {
			if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
			if (!draggedId && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5) return;
			if (!draggedId) begin(pointerStart.row);
			event.preventDefault();
			position(event);
		};
		const onPointerUp = (event) => {
			if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
			const dragged = Boolean(draggedId);
			pointerStart = null;
			if (!dragged) return;
			event.preventDefault();
			clickSuppressedUntil = performance.now() + 500;
			commit();
		};
		const onPointerCancel = (event) => {
			if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
			pointerStart = null;
			restoreInitialOrder();
			finish();
		};
		const onClick = (event) => {
			if (performance.now() > clickSuppressedUntil) return;
			clickSuppressedUntil = 0;
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		for (const row of root.querySelectorAll(".staff-nav-row[data-staff-id]")) {
			row.dataset.draggable = "true";
		}
		root.addEventListener("pointerdown", onPointerDown);
		root.addEventListener("click", onClick, true);
		window.addEventListener("pointermove", onPointerMove, { passive: false });
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
		activeCleanup = () => {
			root.removeEventListener("pointerdown", onPointerDown);
			root.removeEventListener("click", onClick, true);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			restoreInitialOrder();
			finish();
		};
	}

	window.qorperaStaffDrag = Object.freeze({ moveOrder, wire });
})();
