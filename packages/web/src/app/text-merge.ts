/* Merging two members' edits of one shared draft. An edit is a list of steps
 * over the text in UTF-16 units: a positive number keeps that many units, a
 * negative number deletes that many, and a string inserts itself. Edits of the
 * same text are merged by transforming one against the other, so each member's
 * inserted words survive whatever the other deleted around them. */

export type TextEdit = readonly (number | string)[];

const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The edit that turns `before` into `after`, as one replaced span. `caret` is
 * where the editor's caret stands in `after`; it places a change in a run of
 * equal letters where the member actually typed it. */
export function diffText(before: string, after: string, caret?: number): TextEdit {
	if (before === after) return before ? [before.length] : [];
	const shortest = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
	if (caret !== undefined) prefix = Math.min(prefix, Math.max(0, caret - Math.max(0, after.length - before.length)));
	let suffix = 0;
	while (
		suffix < shortest - prefix &&
		before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
	)
		suffix += 1;
	// Never cut a surrogate pair: the kept span would end, or start, on half a letter.
	while (prefix > 0 && highSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;
	while (suffix > 0 && lowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;
	const edit: (number | string)[] = [];
	if (prefix) edit.push(prefix);
	const removed = before.length - prefix - suffix;
	if (removed) edit.push(-removed);
	const inserted = after.slice(prefix, after.length - suffix);
	if (inserted) edit.push(inserted);
	if (suffix) edit.push(suffix);
	return edit;
}

function inputLength(edit: TextEdit): number {
	let length = 0;
	for (const step of edit) if (typeof step === "number") length += Math.abs(step);
	return length;
}

export function applyEdit(text: string, edit: TextEdit): string {
	if (inputLength(edit) !== text.length) throw new Error("The edit does not fit the text.");
	let index = 0;
	let result = "";
	for (const step of edit) {
		if (typeof step === "string") result += step;
		else if (step > 0) {
			result += text.slice(index, index + step);
			index += step;
		} else index -= step;
	}
	return result;
}

/** Edits `a` and `b` of the same text, rewritten to apply after each other:
 * applying `b` then `a2` gives the same text as applying `a` then `b2`. Where
 * both insert at one place, `a`'s words come first. */
export function transform(a: TextEdit, b: TextEdit): [TextEdit, TextEdit] {
	if (inputLength(a) !== inputLength(b)) throw new Error("The edits are not of the same text.");
	const a2: (number | string)[] = [];
	const b2: (number | string)[] = [];
	const push = (edit: (number | string)[], step: number | string) => {
		if (step === 0 || step === "") return;
		const last = edit[edit.length - 1];
		if (typeof step === "string" && typeof last === "string") edit[edit.length - 1] = last + step;
		else if (typeof step === "number" && typeof last === "number" && Math.sign(step) === Math.sign(last))
			edit[edit.length - 1] = last + step;
		else edit.push(step);
	};
	let i = 0;
	let j = 0;
	let stepA: number | string | undefined = a[i++];
	let stepB: number | string | undefined = b[j++];
	while (stepA !== undefined || stepB !== undefined) {
		if (typeof stepA === "string") {
			push(a2, stepA);
			push(b2, stepA.length);
			stepA = a[i++];
			continue;
		}
		if (typeof stepB === "string") {
			push(a2, stepB.length);
			push(b2, stepB);
			stepB = b[j++];
			continue;
		}
		if (stepA === undefined || stepB === undefined) throw new Error("The edits are not of the same text.");
		const span = Math.min(Math.abs(stepA), Math.abs(stepB));
		if (stepA > 0 && stepB > 0) {
			push(a2, span);
			push(b2, span);
		} else if (stepA < 0 && stepB > 0) push(a2, -span);
		else if (stepA > 0 && stepB < 0) push(b2, -span);
		// Both deleted the same letters: nothing is left to do on either side.
		stepA = Math.abs(stepA) === span ? a[i++] : stepA > 0 ? stepA - span : stepA + span;
		stepB = Math.abs(stepB) === span ? b[j++] : stepB > 0 ? stepB - span : stepB + span;
	}
	return [a2, b2];
}

/** Edit `a` and then `b`, which edits what `a` made, as one edit of `a`'s text. */
export function compose(a: TextEdit, b: TextEdit): TextEdit {
	const out: (number | string)[] = [];
	const push = (step: number | string) => {
		if (step === 0 || step === "") return;
		const last = out[out.length - 1];
		if (typeof step === "string" && typeof last === "string") out[out.length - 1] = last + step;
		else if (typeof step === "number" && typeof last === "number" && Math.sign(step) === Math.sign(last))
			out[out.length - 1] = last + step;
		else out.push(step);
	};
	let i = 0;
	let j = 0;
	let stepA: number | string | undefined = a[i++];
	let stepB: number | string | undefined = b[j++];
	while (stepA !== undefined || stepB !== undefined) {
		// What `a` deleted, `b` never saw; what `b` inserted, `a` never had.
		if (typeof stepA === "number" && stepA < 0) {
			push(stepA);
			stepA = a[i++];
			continue;
		}
		if (typeof stepB === "string") {
			push(stepB);
			stepB = b[j++];
			continue;
		}
		if (stepA === undefined || stepB === undefined) throw new Error("The edits do not follow each other.");
		const span = Math.min(typeof stepA === "string" ? stepA.length : stepA, Math.abs(stepB));
		if (typeof stepA === "string") {
			// Inserted by `a`: it stays where `b` keeps it.
			if (stepB > 0) push(stepA.slice(0, span));
			stepA = span === stepA.length ? a[i++] : stepA.slice(span);
		} else {
			push(stepB > 0 ? span : -span);
			stepA = span === stepA ? a[i++] : stepA - span;
		}
		stepB = span === Math.abs(stepB) ? b[j++] : stepB > 0 ? stepB - span : stepB + span;
	}
	return out;
}

/** Where a position in a text lands after an edit of it. Text inserted exactly
 * at the position goes after it, so a caret stays before another member's words. */
export function moveIndex(index: number, edit: TextEdit): number {
	let before = 0;
	let after = 0;
	for (const step of edit) {
		if (typeof step === "string") {
			if (before >= index) break;
			after += step.length;
		} else if (step > 0) {
			if (before + step >= index) break;
			before += step;
			after += step;
		} else {
			// A caret inside deleted text lands where the deletion was.
			if (before - step >= index) return after;
			before -= step;
		}
	}
	return after + Math.max(0, index - before);
}

/** Merge a member's own text into the text the cloud now holds. `base` is the
 * text both started from; the result keeps the cloud's changes and replays the
 * member's on top. `edit` turns `mine` into the result (the others' changes). */
export function mergeText(
	base: string,
	mine: string,
	theirs: string,
	caret?: number,
): { text: string; edit: TextEdit } {
	const [own, other] = transform(diffText(base, mine, caret), diffText(base, theirs));
	return { text: applyEdit(theirs, own), edit: other };
}
