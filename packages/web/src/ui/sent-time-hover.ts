import { conversationTimestampLabel, parseConversationTimestamp } from "./conversation-timestamps.ts";
import { h } from "./dom.ts";
import { uiScale } from "./scale.ts";

/* When a message was sent, shown on a mouse hover (Jonas, 10 Nov 2026): every message in a
 * thread (an agent's, a group chat's, a member's chat, two agents' talk) carries its moment in
 * `data-sent-at`, and a small label beside it reads that moment ("Today 10:04") a moment after
 * the pointer rests on it. Moving on to the next message shows its time at once. The label is
 * read when it shows, so it follows the clock, the language and the time zone. A message's own
 * aria-label already names its time for a screen reader; the label is only drawn. */

/** The pointer rests this long on a message before its time shows. */
const DELAY_MS = 350;
/** After a label hid, the next message within this long shows its time at once. */
const WARM_MS = 500;
const GAP = 8;
const MARGIN = 8;

let tip: HTMLElement | undefined;
let current: HTMLElement | undefined;
let timer: number | undefined;
let hiddenAt = 0;

interface Point {
	x: number;
	y: number;
}

/** The text shown for a message: its time, after `data-sent-label` when it has one ("Messaged Nova · Today 10:04"). */
export function sentTimeText(target: HTMLElement, now = new Date()): string {
	const date = target.dataset.sentAt ? parseConversationTimestamp(target.dataset.sentAt) : undefined;
	if (!date) return "";
	const time = conversationTimestampLabel(date, now);
	return target.dataset.sentLabel ? `${target.dataset.sentLabel} · ${time}` : time;
}

/** The label shown now, if any (tests read it). */
export function shownSentTime(): HTMLElement | undefined {
	return tip?.classList.contains("is-shown") ? tip : undefined;
}

function hide(): void {
	if (timer !== undefined) window.clearTimeout(timer);
	timer = undefined;
	if (current && tip?.classList.contains("is-shown")) hiddenAt = Date.now();
	current = undefined;
	tip?.classList.remove("is-shown");
}

/** Beside the message, on the side away from the thread's middle (an agent's on the left gets it on its right, the
 * member's own on the right gets it on its left), at the pointer's height within the message. Without room beside (a
 * narrow window), just above the pointer, or below it at the thread's top edge. */
function place(label: HTMLElement, target: HTMLElement, root: HTMLElement, pointer: Point): void {
	const box = target.getBoundingClientRect();
	const area = root.getBoundingClientRect();
	const width = label.offsetWidth;
	const height = label.offsetHeight;
	const scale = uiScale();
	const gap = GAP * scale;
	const margin = MARGIN * scale;
	const rightSide = box.left + box.width / 2 <= area.left + area.width / 2;
	// Room within the thread itself: a panel's label never stands over what is beside it.
	const fitsRight = box.right + gap + width <= Math.min(area.right, window.innerWidth) - margin;
	const fitsLeft = box.left - gap - width >= Math.max(area.left, 0) + margin;
	let left: number;
	let top: number;
	if ((rightSide && fitsRight) || (!rightSide && fitsLeft)) {
		left = rightSide ? box.right + gap : box.left - gap - width;
		const low = Math.max(box.top, area.top + margin);
		const high = Math.min(box.bottom, area.bottom - margin) - height;
		top = high < low ? box.top + (box.height - height) / 2 : Math.min(Math.max(pointer.y - height / 2, low), high);
	} else {
		left = pointer.x - width / 2;
		top = pointer.y - 2 * gap - height;
		if (top < Math.max(area.top, 0) + margin) top = pointer.y + 3 * gap;
	}
	left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
	top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
	label.style.left = `${Math.round(left)}px`;
	label.style.top = `${Math.round(top)}px`;
}

function show(target: HTMLElement, root: HTMLElement, pointer: Point): void {
	timer = undefined;
	if (!target.isConnected || !root.contains(target)) return;
	const text = sentTimeText(target);
	if (!text) return;
	tip ??= h("div", { class: "sent-time-tip", "aria-hidden": "true" });
	if (!tip.isConnected) document.body.append(tip);
	if (tip.textContent !== text) tip.textContent = text;
	place(tip, target, root, pointer);
	tip.classList.add("is-shown");
}

/** Shows the sent time of each `[data-sent-at]` element in `root` on a mouse hover, until `signal` aborts. */
export function sentTimeHover(root: HTMLElement, signal: AbortSignal): void {
	const pointer: Point = { x: 0, y: 0 };
	const options = { signal };
	root.addEventListener(
		"pointerover",
		(event) => {
			if (event.pointerType !== "mouse") return;
			pointer.x = event.clientX;
			pointer.y = event.clientY;
			// A press held down is a selection being made: no label over it.
			if (event.buttons) return hide();
			const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-sent-at]") : null;
			if (!target || !root.contains(target)) return hide();
			if (target === current) return;
			const warm = Boolean(current && tip?.classList.contains("is-shown")) || Date.now() - hiddenAt < WARM_MS;
			hide();
			current = target;
			if (warm) show(target, root, pointer);
			else timer = window.setTimeout(() => show(target, root, pointer), DELAY_MS);
		},
		options,
	);
	root.addEventListener(
		"pointermove",
		(event) => {
			pointer.x = event.clientX;
			pointer.y = event.clientY;
			if (event.buttons && current) hide();
		},
		options,
	);
	root.addEventListener("pointerleave", hide, options);
	root.addEventListener("pointerdown", hide, options);
	// The thread scrolls under a still pointer: the label would point at another message.
	root.addEventListener("scroll", hide, { capture: true, signal });
	root.addEventListener("wheel", hide, { passive: true, signal });
	window.addEventListener("keydown", hide, options);
	window.addEventListener("blur", hide, options);
	signal.addEventListener("abort", () => {
		if (!current?.isConnected || root.contains(current)) hide();
	});
}
