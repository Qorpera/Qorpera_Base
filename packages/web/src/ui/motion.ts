/* Motion helpers shared by the views. The timings and curves live in tokens.css
 * (--motion-*, --ease-*) and the animations in styles/motion.css; these helpers
 * only add a class for one play, or hold an element on the page while it leaves.
 * Under reduced motion every helper finishes at once. */

export function reducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** The longest an animation of ours runs (--motion-spring and a little): a class is
 * taken off and a leaving element removed by then even if no animationend comes. */
const LONGEST = 700;

/** Plays `className`'s animation once. The class comes off when it ends, so a node
 * moved later (a thread or rail reorder) does not play it again. */
export function playOnce(element: Element, className: string): void {
	// Nothing plays without an animation engine (or the wish for motion).
	if (reducedMotion() || typeof element.getAnimations !== "function") return;
	element.classList.remove(className);
	element.classList.add(className);
	let timer = 0;
	const done = (event?: Event) => {
		if (event && event.target !== element) return;
		// An element can play more than one animation: the class stays until the last ends.
		if (event?.type === "animationend" && element.getAnimations().some((a) => a.playState === "running")) return;
		element.classList.remove(className);
		element.removeEventListener("animationend", done);
		element.removeEventListener("animationcancel", done);
		window.clearTimeout(timer);
	};
	element.addEventListener("animationend", done);
	element.addEventListener("animationcancel", done);
	// Generous: the class only matters if the node moves before animationend (which normally comes).
	timer = window.setTimeout(done, LONGEST * 6);
}

/** Lets an element play its leaving animation (`className`), then calls `done`, which
 * removes or closes it. What leaves is out of reach at once: focus moves on before the
 * caller restores it, and the element is inert and marked `data-leaving` while it goes. */
export function leave(element: HTMLElement, className: string, done: () => void): void {
	const focused = document.activeElement;
	if (focused instanceof HTMLElement && element.contains(focused)) focused.blur();
	if (reducedMotion() || !element.isConnected || typeof element.getAnimations !== "function") {
		done();
		return;
	}
	let finished = false;
	let timer = 0;
	const finish = (event?: Event) => {
		if (finished || (event && event.target !== element)) return;
		finished = true;
		window.clearTimeout(timer);
		element.removeEventListener("animationend", finish);
		element.removeEventListener("animationcancel", finish);
		done();
	};
	element.inert = true;
	element.dataset.leaving = "";
	element.style.pointerEvents = "none";
	element.classList.add(className);
	// Nothing to wait for when no leaving animation took hold (an enter one that finished does not count).
	if (!element.getAnimations().some((animation) => animation.playState !== "finished")) {
		done();
		return;
	}
	element.addEventListener("animationend", finish);
	element.addEventListener("animationcancel", finish);
	timer = window.setTimeout(finish, LONGEST);
}

/** A motion token's curve for script animations (element.animate takes no var()). The
 * stylesheet already picks the linear() spring or its cubic stand-in for this browser. */
export function easing(token: "--ease-spring" | "--ease-bounce" | "--ease-out" | "--ease-in"): string {
	return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "cubic-bezier(0.2, 0.7, 0.2, 1)";
}

/** An element whose box just changed (a class toggled its size and place) grows or shrinks
 * from the box it had, `from`, to its new one: the computer going full size and back. */
export function zoomFrom(element: HTMLElement, from: DOMRect | undefined): void {
	if (!from || reducedMotion() || typeof element.animate !== "function") return;
	const to = element.getBoundingClientRect();
	if (!to.width || !to.height || !from.width || !from.height) return;
	const dx = from.left - to.left;
	const dy = from.top - to.top;
	const sx = from.width / to.width;
	const sy = from.height / to.height;
	if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
	element.animate(
		[
			{ transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
			{ transformOrigin: "0 0", transform: "none" },
		],
		{ duration: 460, easing: easing("--ease-spring") },
	);
}

/** An element drawn in place of a taller (or shorter) one folds from that height to its own,
 * while `was`, a copy of what stood there, fades out over it: a card that was answered
 * closes down to its one-line outcome. */
export function foldFrom(element: HTMLElement, height: number, was?: Element): void {
	if (reducedMotion() || typeof element.animate !== "function") return;
	const to = element.getBoundingClientRect().height;
	if (!to || Math.abs(to - height) < 2) return;
	const ghost = was instanceof HTMLElement ? was : undefined;
	if (ghost && !ghost.classList.contains("fold-ghost")) {
		ghost.classList.add("fold-ghost");
		// Laid over the fold whatever the card's own rules say about its place.
		Object.assign(ghost.style, { position: "absolute", inset: "0 0 auto 0", margin: "0", width: "100%" });
		ghost.setAttribute("aria-hidden", "true");
		ghost.inert = true;
		// A copy only: nothing in it may be found as the card itself, by id, name or a data- hook.
		for (const part of [ghost, ...ghost.querySelectorAll("*")]) {
			for (const name of part.getAttributeNames())
				if (name === "id" || name === "name" || name === "for" || name.startsWith("data-"))
					part.removeAttribute(name);
		}
	}
	if (ghost) element.append(ghost);
	element.style.position = "relative";
	element.style.overflow = "clip";
	// Where it folds from, for a redraw of it that carries the fold on.
	element.dataset.foldHeight = String(height);
	const clear = () => {
		ghost?.remove();
		delete element.dataset.foldHeight;
		element.style.removeProperty("overflow");
		element.style.removeProperty("position");
	};
	element
		.animate([{ height: `${height}px` }, { height: `${to}px` }], { duration: 380, easing: easing("--ease-out") })
		.finished.then(clear, clear);
}
