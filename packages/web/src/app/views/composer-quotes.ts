import { type QuotePiece, snapSelection } from "../quotes.ts";

/* A quote of outside content is one piece of a draft (app/quotes.ts): the caret never rests inside one, so nothing
 * typed, pasted or composed (an input method) lands in its words, and a selection takes a quote whole or not at all.
 * Arrow keys step over a quote, a click inside one lands at its nearer edge, and Backspace or Delete at its edge
 * reaches its mark, which removes it whole (CompanyController.editDraft). */

/** Keeps a field's caret and selection out of the inside of its quotes, for as long as `signal` lasts. */
export function keepCaretOutOfQuotes(
	input: HTMLTextAreaElement,
	pieces: () => readonly QuotePiece[],
	signal: AbortSignal,
): void {
	let previous: { start: number; end: number } | undefined;
	// While a pointer drags a selection, it is left alone; it is set right once the pointer lets go.
	let dragging = false;
	const snap = () => {
		if (dragging || document.activeElement !== input) return;
		const { selectionStart: start, selectionEnd: end } = input;
		const next = snapSelection(pieces(), start, end, previous);
		previous = next;
		if (next.start !== start || next.end !== end)
			input.setSelectionRange(next.start, next.end, input.selectionDirection ?? undefined);
	};
	input.addEventListener(
		"pointerdown",
		() => {
			dragging = true;
			previous = undefined;
		},
		{ signal },
	);
	document.addEventListener(
		"pointerup",
		() => {
			if (!dragging) return;
			dragging = false;
			// The browser places the caret as the pointer lets go: read it after that.
			setTimeout(snap, 0);
		},
		{ signal },
	);
	for (const type of ["keyup", "select", "focus", "click", "input"]) input.addEventListener(type, snap, { signal });
	// Each move of the caret, keys held down included; newer browsers tell the field itself.
	document.addEventListener("selectionchange", snap, { signal });
	input.addEventListener("selectionchange", snap, { signal });
}
