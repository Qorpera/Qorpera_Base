import { type FieldEdit, type QuotePiece, snapSelection } from "../quotes.ts";

/* A quote of outside content is one piece of a draft (app/quotes.ts): the caret never rests inside one, so nothing
 * typed, pasted or composed (an input method) lands in its words, and a selection takes a quote whole or not at all.
 * Arrow keys step over a quote, a click inside one lands at its nearer edge, and Backspace or Delete at its edge
 * reaches its mark, which removes it whole (CompanyController.editDraft). */

/** What each edit of a field replaced, read as it happens. */
export interface FieldEdits {
	/** The edit an `input` event made, once: the selection as it stood just before the edit landed (`beforeinput`),
	 * for the InputEvent of the same kind that followed it. A letter being composed replaces what was selected when
	 * composing began; a drop lands where the field selects it afterwards. Undefined when the field doesn't say (the
	 * change is then read from the texts, and kept only when clean: app/quotes.ts, keepQuotesWhole). */
	take(event: Event): FieldEdit | undefined;
	/** Code is about to replace `start`..`end` of the field (a name or skill picked, a message put in): the next
	 * `input` event is that edit. */
	declare(start: number, end: number): void;
}

export function watchEdits(input: HTMLTextAreaElement, signal: AbortSignal): FieldEdits {
	let pending: FieldEdit | undefined;
	let declared: FieldEdit | undefined;
	let composing: { before: string; start: number; end: number } | undefined;
	input.addEventListener(
		"compositionstart",
		() => {
			composing = { before: input.value, start: input.selectionStart, end: input.selectionEnd };
		},
		{ signal },
	);
	input.addEventListener(
		"beforeinput",
		(event) => {
			const { inputType } = event as InputEvent;
			pending =
				typeof inputType === "string" && inputType
					? { start: input.selectionStart, end: input.selectionEnd, inputType }
					: undefined;
		},
		{ signal },
	);
	return {
		take(event) {
			const edit = declared ?? pending;
			const byCode = declared !== undefined;
			declared = undefined;
			pending = undefined;
			if (byCode) return edit;
			if (!(event instanceof InputEvent)) return undefined;
			if (/Composition/.test(event.inputType)) return composing && { ...composing, inputType: event.inputType };
			if (!edit || event.inputType !== edit.inputType) return undefined;
			if (edit.inputType === "insertFromDrop")
				return { start: input.selectionStart, end: input.selectionStart, inputType: edit.inputType };
			return edit;
		},
		declare(start, end) {
			declared = { start, end, inputType: "insertFromCode" };
		},
	};
}

/** A field's text and caret, as the composer held it. */
export interface FieldState {
	readonly text: string;
	readonly caret: number;
}

export type HistoryStep = "undo" | "redo";

/** Where an edit begins and how it joins a run of the history (`historyRun`). */
export interface HistoryRun {
	readonly kind: string;
	readonly start: number;
	readonly closes: boolean;
}

/** The most states a composer's history keeps. */
const HISTORY_MAX = 100;

/** A composer's own undo history (DECISIONS.md, 2026-10-04 "A quote of outside content is one piece of the draft").
 * The browser's own can put back a text the composer never held (the moment after a Backspace reached a quote's mark,
 * where the marks left pair with the member's own), whose quote's words would go without their record. Every state
 * here is one the composer held after its quote rules settled an edit, so its quotes are whole, and the draft's
 * records last as long as the draft. Typing, and deleting, in one run is one step, as a text field groups them.
 *
 * A text that changes from outside the member's own edits (a teammate's words merged in, a message sent, a message
 * button) starts the history again there, as a browser's own does when a page sets a field's text: an undo never
 * reaches back past someone else's words. */
export class FieldHistory {
	#undo: FieldState[] = [];
	#redo: FieldState[] = [];
	#present: FieldState;
	/** The run of typing or deleting the present state belongs to, and where it ends. */
	#run: { readonly kind: string; readonly end: number } | undefined;

	constructor(present: FieldState) {
		this.#present = present;
	}

	/** The member's edit, once settled: `before` is the text it was made in, `next` what the field holds now. */
	edited(before: string, next: FieldState, run?: HistoryRun): void {
		if (before !== this.#present.text) this.#restart({ text: before, caret: run?.start ?? next.caret });
		if (next.text === this.#present.text) {
			this.#present = next;
			return;
		}
		const joins = run !== undefined && this.#run?.kind === run.kind && this.#run.end === run.start;
		if (!joins) {
			this.#undo.push(this.#present);
			if (this.#undo.length > HISTORY_MAX) this.#undo.shift();
		}
		this.#redo = [];
		this.#present = next;
		// A letter being composed is one run from where composing began, however its text changes.
		const end = run?.kind === "composing" ? run.start : next.caret;
		this.#run = run && !run.closes ? { kind: run.kind, end } : undefined;
	}

	/** Undo or redo from `current`, the text the composer holds: the state to show, or undefined when there is none
	 * (or the text changed from outside since, which starts the history again). */
	step(which: HistoryStep, current: string): FieldState | undefined {
		if (current !== this.#present.text) {
			this.#restart({ text: current, caret: current.length });
			return undefined;
		}
		const from = which === "undo" ? this.#undo : this.#redo;
		const state = from.pop();
		if (!state) return undefined;
		(which === "undo" ? this.#redo : this.#undo).push(this.#present);
		this.#present = state;
		this.#run = undefined;
		return state;
	}

	#restart(present: FieldState): void {
		this.#undo = [];
		this.#redo = [];
		this.#present = present;
		this.#run = undefined;
	}
}

/** How an edit joins the history's runs: typing, deleting or composing a letter, from where it began. A typed space
 * or line ends a typing run. */
export function historyRun(edit: FieldEdit | undefined, event: Event): HistoryRun | undefined {
	if (!edit) return undefined;
	const data = (event as InputEvent).data;
	if (/Composition/.test(edit.inputType)) return { kind: "composing", start: edit.start, closes: false };
	if (edit.inputType === "insertText" && edit.start === edit.end)
		return { kind: "typing", start: edit.start, closes: typeof data === "string" && /\s/.test(data) };
	if (/^delete(Content|Word)(Backward|Forward)$/.test(edit.inputType) && edit.start === edit.end)
		return { kind: edit.inputType, start: edit.start, closes: false };
	return undefined;
}

/** The undo or redo an `input` or `beforeinput` event asks for. */
export function historyStep(event: Event): HistoryStep | undefined {
	const { inputType } = event as InputEvent;
	return inputType === "historyUndo" ? "undo" : inputType === "historyRedo" ? "redo" : undefined;
}

/** Answers a field's undo and redo from the composer's own history (`FieldHistory`), never the browser's: the keys
 * (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y) and the browser's own undo and redo (a menu, a gesture), which it cancels.
 * A browser that doesn't let the page cancel those applies its own first; the field's `input` handler then puts the
 * composer's state back (`historyStep`). */
export function watchHistory(
	input: HTMLTextAreaElement,
	signal: AbortSignal,
	step: (which: HistoryStep) => void,
): void {
	input.addEventListener(
		"keydown",
		(event) => {
			if (event.isComposing || event.altKey) return;
			const key = event.key.toLowerCase();
			const which =
				(event.metaKey || event.ctrlKey) && key === "z"
					? event.shiftKey
						? "redo"
						: "undo"
					: event.ctrlKey && !event.metaKey && !event.shiftKey && key === "y"
						? "redo"
						: undefined;
			if (!which) return;
			event.preventDefault();
			step(which);
		},
		{ signal },
	);
	input.addEventListener(
		"beforeinput",
		(event) => {
			const which = historyStep(event);
			if (!which) return;
			event.preventDefault();
			if (event.defaultPrevented) step(which);
		},
		{ signal },
	);
}

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
