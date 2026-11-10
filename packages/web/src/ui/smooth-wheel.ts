import { reducedMotion } from "./motion.ts";

/** How quickly a wheel step settles: the distance left shrinks by e every this many milliseconds,
 * so a step is ~90 % there after 115 ms and done in under 300 ms. */
export const SMOOTH_WHEEL_SETTLE_MS = 50;
/** Wheel events further apart than this start a new burst, which is judged afresh. */
const BURST_GAP_MS = 120;
/** A frame that came late still moves at most this far in time, so a stall never jumps. */
const MAX_FRAME_MS = 50;
const DELTA_PIXEL = 0;
const DELTA_LINE = 1;
const DELTA_PAGE = 2;
/** A line of a line-based wheel (Firefox, some Linux mice), in pixels. */
const LINE_PX = 40;

type LegacyWheel = WheelEvent & { wheelDeltaY?: number };

/**
 * Whether a wheel event comes from a wheel that clicks in steps, the kind a browser may move
 * without any easing (Safari does), rather than from a trackpad or a Magic Mouse, whose
 * gestures already glide and keep their own momentum.
 *
 * Browsers don't say which device sent an event. What they do give away:
 * - line or page deltas come only from stepped wheels;
 * - WebKit and Chromium report the legacy `wheelDeltaY` as 120 per wheel line (WebKit's
 *   WheelEvent TickMultiplier). A trackpad's lines are its pixels / 40, so its wheelDeltaY is
 *   3 × its whole-pixel delta: a multiple of 120 only for a 40 px jump, which is not how a
 *   gesture starts.
 * - macOS speeds a slow wheel up in tenths of a line, a 16.16 fixed-point number, so a slow
 *   click arrives as 4.000244… px with wheelDeltaY 12. Trackpads move in whole pixels.
 */
export function isSteppedWheel(event: WheelEvent): boolean {
	if (event.deltaMode !== DELTA_PIXEL) return true;
	const legacy = (event as LegacyWheel).wheelDeltaY;
	if (typeof legacy !== "number" || legacy === 0) return false;
	if (legacy % 120 === 0) return true;
	return !Number.isInteger(event.deltaY) && legacy % 12 === 0;
}

function pixels(event: WheelEvent, scroller: HTMLElement): number {
	if (event.deltaMode === DELTA_LINE) return event.deltaY * LINE_PX;
	if (event.deltaMode === DELTA_PAGE) return event.deltaY * scroller.clientHeight;
	return event.deltaY;
}

/** Whether something between the pointer and the scroller would scroll this way itself
 * (a code block, a long card): then it keeps the wheel. */
function innerScrollerTakes(target: EventTarget | null, scroller: HTMLElement, down: boolean): boolean {
	for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
		if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight) continue;
		const overflow = getComputedStyle(node).overflowY;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		if (down ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0) return true;
	}
	return false;
}

/**
 * Eases a stepped mouse wheel in a scroller: each click glides the same distance the browser
 * would have jumped, and clicks that come fast add up into one glide. Trackpads, Magic Mice,
 * pinch zoom, sideways scrolls and reduced motion keep the browser's own scrolling.
 *
 * The glide keeps to the content when something else moves the scroller (a pin to the newest
 * message, earlier messages put in above): the move is carried into the glide, not undone.
 * Any other input (a trackpad, a key, a touch, a press) ends the glide where it is.
 */
export function smoothWheel(scroller: HTMLElement): void {
	let frame = 0;
	let position = 0;
	let target = 0;
	let written = 0;
	let lastFrame = 0;
	let lastWheel = Number.NEGATIVE_INFINITY;
	let burstSmoothed = false;

	const maxTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	const stop = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};
	const step = (now: number) => {
		frame = 0;
		if (!scroller.isConnected) return;
		// Someone else moved the scroller since the last frame: keep the glide on the same content.
		const moved = scroller.scrollTop - written;
		if (Math.abs(moved) >= 1) {
			position += moved;
			target += moved;
		}
		target = Math.min(Math.max(target, 0), maxTop());
		const elapsed = Math.min(Math.max(now - lastFrame, 0), MAX_FRAME_MS);
		lastFrame = now;
		position += (target - position) * (1 - Math.exp(-elapsed / SMOOTH_WHEEL_SETTLE_MS));
		const done = Math.abs(target - position) < 0.5;
		if (done) position = target;
		scroller.scrollTop = position;
		written = scroller.scrollTop;
		if (!done) frame = requestAnimationFrame(step);
	};

	scroller.addEventListener(
		"wheel",
		(event) => {
			const burst = event.timeStamp - lastWheel < BURST_GAP_MS;
			lastWheel = event.timeStamp;
			if (!burst) burstSmoothed = isSteppedWheel(event);
			const smooth =
				burstSmoothed &&
				event.cancelable &&
				!event.defaultPrevented &&
				!event.ctrlKey &&
				!event.shiftKey &&
				event.deltaY !== 0 &&
				Math.abs(event.deltaY) >= Math.abs(event.deltaX) &&
				!reducedMotion() &&
				typeof requestAnimationFrame === "function";
			if (!smooth) {
				stop();
				return;
			}
			const down = event.deltaY > 0;
			if (innerScrollerTakes(event.target, scroller, down)) {
				stop();
				return;
			}
			if (!frame) {
				position = scroller.scrollTop;
				target = position;
				written = position;
				lastFrame = performance.now();
			} else if (down !== target > position) target = position; // Turning back starts from here.
			const next = Math.min(Math.max(target + pixels(event, scroller), 0), maxTop());
			if (next === target && !frame) return; // Already at the end: nothing to glide.
			event.preventDefault();
			target = next;
			if (!frame) frame = requestAnimationFrame(step);
		},
		{ passive: false },
	);
	// Any other way of scrolling takes over from the glide.
	for (const type of ["pointerdown", "touchstart", "keydown"] as const)
		scroller.addEventListener(type, stop, { passive: true });
}
