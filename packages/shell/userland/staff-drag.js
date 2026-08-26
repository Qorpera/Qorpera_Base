/* Pointer-driven roster drag-and-drop. Persistence stays with renderer.js;
 * this file owns only pointer interaction, drop placement, and the preview. */
(() => {
	let activeCleanup = null;
	let clickSuppressedUntil = 0;

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

	function clearDropMarks(root) {
		for (const element of root.querySelectorAll(".staff-drop-target, .staff-drop-before, .staff-drop-after")) {
			element.classList.remove("staff-drop-target", "staff-drop-before", "staff-drop-after");
		}
	}

	function dragPreview(row) {
		const preview = row.cloneNode(true);
		preview.classList.remove("active", "peer-open", "is-dragging", "staff-drop-before", "staff-drop-after");
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
		let pinnedWasHidden = pinnedZone.hidden;

		const finish = () => {
			clearDropMarks(root);
			root.classList.remove("staff-reordering");
			draggedRow?.classList.remove("is-dragging");
			draggedRow?.removeAttribute("aria-grabbed");
			preview?.remove();
			if (pinnedWasHidden && !pinnedZone.children.length) pinnedZone.hidden = true;
			draggedId = null;
			draggedRow = null;
			preview = null;
			drop = null;
		};

		const begin = (row) => {
			draggedId = row.dataset.staffId;
			draggedRow = row;
			pinnedWasHidden = pinnedZone.hidden;
			pinnedZone.hidden = false;
			root.classList.add("staff-reordering");
			row.classList.add("is-dragging");
			row.setAttribute("aria-grabbed", "true");
			preview = dragPreview(row);
		};

		const position = (event) => {
			if (!draggedId || !preview) return;
			preview.style.transform = `translate3d(${event.clientX + 12}px, ${event.clientY - 46}px, 0)`;
			clearDropMarks(root);
			drop = null;
			const hit = document.elementFromPoint(event.clientX, event.clientY);
			const targetRow = hit?.closest(".staff-nav-row[data-staff-id]");
			if (targetRow && targetRow.dataset.staffId !== draggedId) {
				const zone = targetRow.parentElement;
				if (zone !== pinnedZone && zone !== listZone) return;
				const bounds = targetRow.getBoundingClientRect();
				const after = zone === pinnedZone
					? event.clientX >= bounds.left + bounds.width / 2
					: event.clientY >= bounds.top + bounds.height / 2;
				zone.classList.add("staff-drop-target");
				targetRow.classList.add(after ? "staff-drop-after" : "staff-drop-before");
				drop = { zone, targetId: targetRow.dataset.staffId, after };
				return;
			}
			const zone = hit?.closest(".staff-pinned-grid, .staff-unpinned-list");
			if (zone !== pinnedZone && zone !== listZone) return;
			zone.classList.add("staff-drop-target");
			drop = { zone, targetId: null, after: false };
		};

		const commit = () => {
			if (!draggedId || !drop) {
				finish();
				return;
			}
			const move = moveOrder(
				zoneIds(pinnedZone),
				zoneIds(listZone),
				draggedId,
				drop.zone === pinnedZone,
				drop.targetId,
				drop.after,
			);
			const id = draggedId;
			const pinned = drop.zone === pinnedZone;
			finish();
			onMove({ id, pinned, order: move.order });
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
			finish();
		};
	}

	window.qorperaStaffDrag = Object.freeze({ moveOrder, wire });
})();
