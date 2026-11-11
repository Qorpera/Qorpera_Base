import { conversationClockLabel, parseConversationTimestamp } from "./conversation-timestamps.ts";
import { h } from "./dom.ts";
import { uiScale } from "./scale.ts";

/* When a message was sent, shown on a mouse hover (Jonas, 10 Nov 2026): every message in a
 * thread (an agent's, a group chat's, a member's chat, two agents' talk) carries its moment in
 * `data-sent-at`, and the time of day ("10:04") stands beside it the moment the pointer is on it
 * (Jonas, 11 Nov 2026: "the hover should be instant, … should only show the timestamp, not date,
 * be centered to the message, and have no composer around it"). It is plain small text, centred
 * on the message's height. The time is read when it shows, so it follows the clock, the language
 * and the time zone. A message's own aria-label already names its time for a screen reader; the
 * time beside it is only drawn. */

const GAP = 6;
const MARGIN = 8;

let tip: HTMLElement | undefined;
let current: HTMLElement | undefined;

/** The time shown for a message: the time of day alone ("10:04", "2:18 PM"). */
export function sentTimeText(target: HTMLElement): string {
	const date = target.dataset.sentAt ? parseConversationTimestamp(target.dataset.sentAt) : undefined;
	return date ? conversationClockLabel(date) : "";
}

/** The time shown now, if any (tests read it). */
export function shownSentTime(): HTMLElement | undefined {
	return tip?.classList.contains("is-shown") ? tip : undefined;
}

function hide(): void {
	current = undefined;
	tip?.classList.remove("is-shown", "is-over");
}

/** Beside the bubble, on the side away from the thread's middle (an agent's on the left gets it on its right, the
 * member's own on the right gets it on its left), else on the other side, centred on the part of the bubble in view.
 * Without room on either side (a narrow window), centred just above the bubble, on the thread's own colour. */
function place(label: HTMLElement, bubble: HTMLElement, root: HTMLElement): void {
	const box = bubble.getBoundingClientRect();
	const area = root.getBoundingClientRect();
	const width = label.offsetWidth;
	const height = label.offsetHeight;
	const scale = uiScale();
	const gap = GAP * scale;
	const margin = MARGIN * scale;
	const leftmost = Math.max(area.left, 0) + margin;
	const rightmost = Math.min(area.right, window.innerWidth) - margin;
	const fitsRight = box.right + gap + width <= rightmost;
	const fitsLeft = box.left - gap - width >= leftmost;
	const rightFirst = box.left + box.width / 2 <= area.left + area.width / 2;
	const side = rightFirst
		? fitsRight
			? "right"
			: fitsLeft
				? "left"
				: ""
		: fitsLeft
			? "left"
			: fitsRight
				? "right"
				: "";
	let left: number;
	let top: number;
	if (side) {
		left = side === "right" ? box.right + gap : box.left - gap - width;
		const seenTop = Math.max(box.top, area.top, 0);
		const seenBottom = Math.min(box.bottom, area.bottom, window.innerHeight);
		top = (seenBottom > seenTop ? (seenTop + seenBottom) / 2 : box.top + box.height / 2) - height / 2;
	} else {
		left = box.left + (box.width - width) / 2;
		top = box.top - height - gap / 2;
		if (top < Math.max(area.top, 0) + margin) top = box.bottom + gap / 2;
	}
	label.classList.toggle("is-over", !side);
	// Inside the thread as it is on screen: a panel's time never stands over what is beside it.
	left = Math.max(Math.min(left, rightmost - width), leftmost);
	top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
	label.style.left = `${Math.round(left)}px`;
	label.style.top = `${Math.round(top)}px`;
}

function show(target: HTMLElement, bubble: HTMLElement, root: HTMLElement): void {
	current = bubble;
	const text = sentTimeText(target);
	if (!text) {
		hide();
		return;
	}
	tip ??= h("div", { class: "sent-time-tip", "aria-hidden": "true" });
	if (!tip.isConnected) document.body.append(tip);
	if (tip.textContent !== text) tip.textContent = text;
	place(tip, bubble, root);
	tip.classList.add("is-shown");
}

/** A message of several bubbles (its words, a table, its files) gets the time beside the one under the pointer; its
 * author's name above them goes with the first, a caption under them ("Seen", "Queued") with the last. Anything else
 * (a chip, a gap between bubbles) gets it beside the whole. */
function bubbleAt(under: Element, message: HTMLElement): HTMLElement {
	let part: Element | null = under;
	while (part && part !== message && part.parentElement !== message) part = part.parentElement;
	if (part?.matches(".message-author")) part = part.nextElementSibling;
	else if (part?.matches(".message-caption")) part = part.previousElementSibling;
	return part instanceof HTMLElement && part.matches(".bubble, .received-attachments") ? part : message;
}

/** Shows the sent time of each `[data-sent-at]` element in `root` on a mouse hover, until `signal` aborts. */
export function sentTimeHover(root: HTMLElement, signal: AbortSignal): void {
	const options = { signal };
	const messageAt = (event: PointerEvent) => {
		const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-sent-at]") : null;
		return target && root.contains(target) ? target : undefined;
	};
	const follow = (event: PointerEvent) => {
		if (event.pointerType !== "mouse") return;
		// A press held down is a selection being made: no time over it.
		if (event.buttons) return hide();
		const target = messageAt(event);
		if (!target) return hide();
		const part = bubbleAt(event.target as Element, target);
		if (part !== current) show(target, part, root);
	};
	root.addEventListener("pointerover", follow, options);
	// After a press, a scroll or a key, moving on within the same message shows its time again.
	root.addEventListener(
		"pointermove",
		(event) => {
			if (!current) follow(event);
			else if (event.buttons) hide();
		},
		options,
	);
	root.addEventListener("pointerleave", hide, options);
	root.addEventListener("pointerdown", hide, options);
	// The thread scrolls under a still pointer: the time would stand beside another message.
	root.addEventListener("scroll", hide, { capture: true, signal });
	root.addEventListener("wheel", hide, { passive: true, signal });
	window.addEventListener("keydown", hide, options);
	window.addEventListener("blur", hide, options);
	signal.addEventListener("abort", () => {
		if (!current?.isConnected || root.contains(current)) hide();
	});
}
