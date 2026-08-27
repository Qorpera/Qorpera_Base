(() => {
	const grid = document.getElementById("hubCompanies");
	const previous = document.getElementById("hubCarouselPrevious");
	const next = document.getElementById("hubCarouselNext");
	const pagination = document.getElementById("hubCarouselPagination");
	const status = document.getElementById("hubCarouselStatus");
	if (!grid || !previous || !next || !pagination || !status) return;

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let updateFrame;
	let paginationSize = -1;
	let announcedItem;

	function items() {
		return [...grid.children];
	}

	function companyName(item) {
		return item.querySelector("strong")?.textContent?.trim() || "Company";
	}

	function centeredIndex(carouselItems) {
		const center = grid.scrollLeft + grid.clientWidth / 2;
		let closestIndex = 0;
		let closestDistance = Number.POSITIVE_INFINITY;
		for (const [index, item] of carouselItems.entries()) {
			const itemCenter = item.offsetLeft + item.offsetWidth / 2;
			const distance = Math.abs(itemCenter - center);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestIndex = index;
			}
		}
		return closestIndex;
	}

	function scrollToItem(item, behavior = reducedMotion.matches ? "auto" : "smooth") {
		grid.scrollTo({
			left: item.offsetLeft - (grid.clientWidth - item.offsetWidth) / 2,
			behavior,
		});
	}

	function rebuildPagination(carouselItems) {
		if (paginationSize === carouselItems.length) return;
		paginationSize = carouselItems.length;
		pagination.replaceChildren();
		for (const [index, item] of carouselItems.entries()) {
			const dot = document.createElement("button");
			dot.type = "button";
			dot.setAttribute("aria-label", `Show ${companyName(item)}`);
			dot.onclick = () => {
				const target = items()[index];
				if (target) scrollToItem(target);
			};
			pagination.appendChild(dot);
		}
	}

	function update() {
		updateFrame = undefined;
		const carouselItems = items();
		rebuildPagination(carouselItems);
		if (carouselItems.length === 0) {
			previous.disabled = true;
			next.disabled = true;
			announcedItem = undefined;
			status.textContent = "";
			return;
		}
		const activeIndex = centeredIndex(carouselItems);
		for (const [index, item] of carouselItems.entries()) {
			item.classList.toggle("is-centered", index === activeIndex);
		}
		for (const [index, dot] of [...pagination.children].entries()) {
			if (index === activeIndex) dot.setAttribute("aria-current", "true");
			else dot.removeAttribute("aria-current");
		}
		previous.disabled = activeIndex === 0;
		next.disabled = activeIndex === carouselItems.length - 1;
		const announcement = `${activeIndex + 1} of ${carouselItems.length}: ${companyName(carouselItems[activeIndex])}`;
		if (announcement !== announcedItem) {
			announcedItem = announcement;
			status.textContent = announcement;
		}
	}

	function scheduleUpdate() {
		if (updateFrame !== undefined) return;
		updateFrame = window.requestAnimationFrame(update);
	}

	function move(direction, focusCard = false) {
		const carouselItems = items();
		if (carouselItems.length === 0) return;
		const targetIndex = Math.max(0, Math.min(carouselItems.length - 1, centeredIndex(carouselItems) + direction));
		scrollToItem(carouselItems[targetIndex]);
		if (!focusCard) return;
		const card = carouselItems[targetIndex].matches(".company-card")
			? carouselItems[targetIndex]
			: carouselItems[targetIndex].querySelector(".company-card");
		card?.focus({ preventScroll: true });
	}

	previous.onclick = () => move(-1);
	next.onclick = () => move(1);
	grid.addEventListener("scroll", scheduleUpdate, { passive: true });
	grid.addEventListener("focusin", (event) => {
		const item = event.target.closest(".hub-grid > *");
		if (item) scrollToItem(item);
	});
	grid.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		move(event.key === "ArrowLeft" ? -1 : 1, true);
	});

	new MutationObserver(() => {
		paginationSize = -1;
		scheduleUpdate();
	}).observe(grid, { childList: true });
	new ResizeObserver(scheduleUpdate).observe(grid);
	scheduleUpdate();
})();
