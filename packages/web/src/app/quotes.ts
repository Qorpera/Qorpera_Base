import {
	characterIndex,
	type MessageQuote,
	QUOTE_CLOSE,
	QUOTE_MAX_CHARACTERS,
	QUOTE_OPEN,
	quoteRefFits,
	unitIndex,
} from "../cloud/quotes.ts";
import { compose, diffText, mergeText, type TextEdit } from "./text-merge.ts";

/* Quotes in the composer (contract, the 2026-10-02 amendment "quoted outside content in a member's message", item 2).
 * A quote is one piece of the draft: the member keeps it or removes it whole, and writes their own words around it.
 *
 * A draft is its text and its quotes, spans of that text in characters (code points). Beside the text the draft
 * keeps each quote's record: its words and where they came from. The spans are found from the records, as the cloud
 * finds a draft's kept quotes (qorpera_draft_keeps_quotes): wherever a record's words stand in «» marks, that is the
 * quote. So the member's own marks around a quote's words carry that quote's record and never pass as the member's
 * own words; a quote put back (an undo, a paste) is a quote again; and the cloud never finds a quote's words without
 * its record, which would refuse the draft. */

/** Where a quote's words came from. One record per words: two quotes with the same words carry the first one's. */
export interface QuoteRecord {
	readonly words: string;
	readonly source: string;
	readonly ref: string;
}

/** A text and its quotes. */
export interface QuotedText {
	readonly text: string;
	readonly quotes: readonly MessageQuote[];
}

/** A quote as a text field sees it: its marks and its words, in UTF-16 units. */
export interface QuotePiece {
	readonly from: number;
	readonly to: number;
}

/** `known` with the records of a text's quotes added; a record whose words are already known is left out. For quotes
 * the member adds here; quotes that come confirmed from the cloud take their words over (`takeQuoteRecords`). */
export function withQuoteRecords(
	known: readonly QuoteRecord[],
	text: string,
	quotes: readonly MessageQuote[],
): readonly QuoteRecord[] {
	if (!quotes.length) return known;
	const records = [...known];
	for (const quote of quotes) {
		const words = wordsOf(text, quote);
		if (!records.some((record) => record.words === words))
			records.push({ words, source: quote.source, ref: quote.ref });
	}
	return records.length === known.length ? known : records;
}

/** `known` with the records of quotes the cloud confirmed (a shared draft's, as merged): each one replaces a known
 * record of the same words, so a quote never keeps an email it no longer names. Another tab or a teammate may have
 * removed a quote of one email and quoted the same words from another; the draft holds them from the new one now. */
export function takeQuoteRecords(
	known: readonly QuoteRecord[],
	text: string,
	quotes: readonly MessageQuote[],
): readonly QuoteRecord[] {
	if (!quotes.length) return known;
	const taken = withQuoteRecords([], text, quotes);
	const words = new Set(taken.map((record) => record.words));
	return [...taken, ...known.filter((record) => !words.has(record.words))];
}

/** The quotes of a text: every «words» of a known record, in order. A record's words never hold a mark, so they
 * never overlap. */
export function placeQuotes(text: string, records: readonly QuoteRecord[]): MessageQuote[] {
	if (!records.length || !text.includes(QUOTE_OPEN)) return [];
	const byWords = new Map<string, QuoteRecord>();
	for (const record of records)
		if (
			!byWords.has(record.words) &&
			record.words &&
			!/[«»]/.test(record.words) &&
			[...record.words].length <= QUOTE_MAX_CHARACTERS &&
			quoteRefFits(record.source, record.ref)
		)
			byWords.set(record.words, record);
	const quotes: MessageQuote[] = [];
	let units = 0;
	let characters = 0;
	for (const match of text.matchAll(/«([^«»]+)»/g)) {
		const record = byWords.get(match[1] ?? "");
		if (!record) continue;
		const from = match.index + 1;
		characters += characterIndex(text.slice(units, from), from - units);
		units = from;
		const start = characters;
		const end = start + [...record.words].length;
		quotes.push({ start, end, source: record.source, ref: record.ref });
	}
	return quotes;
}

/** Each quote's piece of the text: the « before its words to the » after them. */
export function quotePieces(text: string, quotes: readonly MessageQuote[]): QuotePiece[] {
	return quotes.map((quote) => ({ from: unitIndex(text, quote.start) - 1, to: unitIndex(text, quote.end) + 1 }));
}

/** An edit as the text field made it: the selection it replaced, read just before it landed (`beforeinput`), and what
 * kind of edit it was (the InputEvent's `inputType`). */
export interface FieldEdit {
	readonly start: number;
	readonly end: number;
	readonly inputType: string;
	/** The text the edit was made in, when that is not the text the field held last: a letter being composed
	 * replaces what was selected when composing began, in the text as it was then. */
	readonly before?: string;
}

/** One replaced span: `removed` units of the old text from `prefix`, in place of which `inserted` stands. */
interface Change {
	readonly prefix: number;
	readonly removed: number;
	readonly inserted: string;
}

/** The span a field's edit replaced, from its selection: the selection itself, or for a deletion from a caret the
 * characters beside it. Undefined when the edit replaces a span the selection doesn't tell (a spelling fix, a
 * transposition, the browser's own undo), or when the selection doesn't account for the change. */
function replacedSpan(before: string, after: string, edit: FieldEdit): Change | undefined {
	if (/Replacement|Transpose|^history/.test(edit.inputType)) return undefined;
	const grown = after.length - before.length;
	const { start, end } = edit;
	const spans: [number, number][] =
		start !== end || !edit.inputType.startsWith("delete")
			? [[start, end]]
			: edit.inputType.endsWith("Forward")
				? [[start, start - grown]]
				: edit.inputType.endsWith("Backward")
					? [[start + grown, start]]
					: [
							[start + grown, start],
							[start, start - grown],
						];
	for (const [from, to] of spans) {
		const tail = before.length - to;
		if (from < 0 || from > to || tail < 0 || after.length - tail < from) continue;
		if (after.slice(0, from) === before.slice(0, from) && after.slice(after.length - tail) === before.slice(to))
			return { prefix: from, removed: to - from, inserted: after.slice(from, after.length - tail) };
	}
	return undefined;
}

/** The span that changed, read from the texts alone: diffText starts with the kept prefix only when there is one,
 * and a kept number after the change is the suffix. Where the same letters repeat it can't tell which ones went. */
function diffSpan(before: string, after: string, caret: number | undefined): Change {
	let prefix = 0;
	let removed = 0;
	let inserted = "";
	let seen = false;
	for (const step of diffText(before, after, caret)) {
		if (typeof step === "string") inserted = step;
		else if (step < 0) removed = -step;
		else if (!seen) prefix = step;
		seen = true;
	}
	return { prefix, removed, inserted };
}

/** A record's words with only one of their marks, decided by how the marks pair, as the cloud pairs them (each « with
 * the next », none between): a « that pairs with no », right before a record's words, or a » that pairs with no «,
 * right after them. Whatever letters follow or precede the words: «Btail with no » is B's words without their record,
 * and only a closing mark tells a quote from a longer word. A « that pairs with a later » is the member's own marks
 * («Janet» when a quote is "Jane"); a lone «Janet is held as broken, which fails closed. Each as the span of the words
 * and that mark. Such words would go as the member's own: a save or a send waits until the member mends or removes
 * them. */
export function brokenQuotes(
	text: string,
	records: readonly QuoteRecord[],
): { readonly from: number; readonly to: number; readonly words: string }[] {
	const words = [...new Set(records.map((record) => record.words))]
		.filter((item) => item && !/[«»]/.test(item))
		.sort((a, b) => b.length - a.length);
	if (!words.length || !/[«»]/.test(text)) return [];
	const lone: { at: number; opens: boolean }[] = [];
	let open: number | undefined;
	for (let at = 0; at < text.length; at++) {
		if (text[at] === QUOTE_OPEN) {
			if (open !== undefined) lone.push({ at: open, opens: true });
			open = at;
		} else if (text[at] === QUOTE_CLOSE) {
			if (open === undefined) lone.push({ at, opens: false });
			open = undefined;
		}
	}
	if (open !== undefined) lone.push({ at: open, opens: true });
	return lone.flatMap(({ at, opens }) => {
		const found = opens
			? words.find((item) => text.startsWith(item, at + 1))
			: words.find((item) => item.length <= at && text.slice(at - item.length, at) === item);
		if (found === undefined) return [];
		const from = opens ? at : at - found.length;
		return [{ from, to: from + found.length + 1, words: found }];
	});
}

/** Whether a change read from the texts alone leaves every quote as it should be: each piece it touched is still
 * whole (its remnants lie inside a quote of `after`), and every occurrence of a record's words in `after` is inside a
 * quote, or stood unchanged outside one before (the member's own words, untouched). */
function clean(before: string, after: string, records: readonly QuoteRecord[], change: Change): boolean {
	const piecesBefore = quotePieces(before, placeQuotes(before, records));
	const piecesAfter = quotePieces(after, placeQuotes(after, records));
	// Within a quote's piece, its marks included (a record's words hold no mark, so they can only be its words).
	const quoted = (pieces: readonly QuotePiece[], from: number, to: number) =>
		pieces.some((piece) => piece.from <= from && to <= piece.to);
	const { prefix, removed, inserted } = change;
	const shift = inserted.length - removed;
	for (const { from, to } of piecesBefore) {
		const touched = removed > 0 ? prefix < to && prefix + removed > from : prefix > from && prefix < to;
		if (!touched) continue;
		const left = Math.min(to, prefix);
		const right = Math.max(from, prefix + removed) + shift;
		if (from < prefix && !quoted(piecesAfter, from, left)) return false;
		if (to > prefix + removed && !quoted(piecesAfter, right, to + shift)) return false;
	}
	const suffix = before.length - prefix - removed;
	for (const words of new Set(records.map((record) => record.words))) {
		if (!words) continue;
		for (let at = after.indexOf(words); at >= 0; at = after.indexOf(words, at + 1)) {
			const end = at + words.length;
			if (quoted(piecesAfter, at, end)) continue;
			const old = end <= prefix ? at : at >= after.length - suffix ? at - shift : undefined;
			if (old === undefined || quoted(piecesBefore, old, old + words.length)) return false;
		}
	}
	return true;
}

/** The member changed a text from `before` to `after`; `caret` is where their caret stands in `after`, and `records`
 * are the draft's (`placeQuotes`). A change that reaches into a quote (its marks or its words) removes all of it: the
 * rest of its piece goes, and the words the member typed or pasted stay. Returns the text to keep and where the caret
 * goes in it. The field keeps the caret out of a quote (`snapSelection`), so this is mostly a deletion that reached a
 * quote's mark, removing the quote whole.
 *
 * `edit` is the field's own account of the change. Without it (a spelling fix, a change with no `beforeinput`) the
 * change can only be read from the texts, which can't tell a pasted «A» over «B» from an A typed over the B inside
 * the marks. Such a change is kept only when it is clean (`clean`); otherwise the text goes back to `before`. Undo and
 * redo never come here: the composers keep their own history (app/views/composer-quotes.ts). */
export function keepQuotesWhole(
	before: string,
	records: readonly QuoteRecord[],
	after: string,
	caret?: number,
	edit?: FieldEdit,
): { text: string; caret: number | undefined } {
	if (before === after || !records.length) return { text: after, caret };
	// A letter being composed is read against the text composing began in.
	const base = edit?.before ?? before;
	const known = edit && replacedSpan(base, after, edit);
	if (!known) {
		const change = diffSpan(before, after, caret);
		return clean(before, after, records, change) ? { text: after, caret } : { text: before, caret: change.prefix };
	}
	const { prefix, removed, inserted } = known;
	const shift = inserted.length - removed;
	const cut: [number, number][] = [];
	for (const { from, to } of quotePieces(base, placeQuotes(base, records))) {
		const touched = removed > 0 ? prefix < to && prefix + removed > from : prefix > from && prefix < to;
		if (!touched) continue;
		// What is left of the piece in `after`: before the change, and after it (moved by what changed).
		if (from < prefix) cut.push([from, Math.min(to, prefix)]);
		if (to > prefix + removed) cut.push([Math.max(from, prefix + removed) + shift, to + shift]);
	}
	if (!cut.length) return { text: after, caret };
	cut.sort((a, b) => a[0] - b[0]);
	let text = "";
	let at = 0;
	// The caret moves back by what was cut before it.
	let cutBefore = 0;
	for (const [from, to] of cut) {
		text += after.slice(at, from);
		if (caret !== undefined) cutBefore += Math.max(0, Math.min(caret, to) - Math.max(at, from));
		at = Math.max(at, to);
	}
	text += after.slice(at);
	return { text, caret: caret === undefined ? undefined : caret - cutBefore };
}

/** Where a field's selection may stand: never inside a quote, so typing never lands in one and a selection takes a
 * quote whole or not at all. A caret that comes into one moves on to the edge it was going toward (the nearest edge
 * when that is not known); a selection's end that comes into one takes the quote in going outward, and leaves it
 * going back. `previous` is the selection as it last stood. */
export function snapSelection(
	pieces: readonly QuotePiece[],
	start: number,
	end: number,
	previous?: { readonly start: number; readonly end: number },
): { start: number; end: number } {
	const inside = (at: number) => pieces.find((piece) => piece.from < at && at < piece.to);
	if (start === end) {
		const piece = inside(start);
		if (!piece) return { start, end };
		const was = previous && previous.start === previous.end ? previous.start : undefined;
		const edge =
			was !== undefined && was <= piece.from
				? piece.to
				: was !== undefined && was >= piece.to
					? piece.from
					: start - piece.from <= piece.to - start
						? piece.from
						: piece.to;
		return { start: edge, end: edge };
	}
	let from = start;
	let to = end;
	const first = inside(start);
	if (first) from = previous && previous.end === end && previous.start < start ? first.to : first.from;
	const last = inside(end);
	if (last) to = previous && previous.start === start && previous.end > end ? last.from : last.to;
	// Leaving the quote it was in can leave nothing selected: then the caret stands at that quote's edge.
	return from <= to ? { start: from, end: to } : { start: to, end: to };
}

/** A draft with `addition` after it, a blank line between, and the records of both. Undefined when the addition
 * quotes the same words as a quote the draft still holds, from somewhere else (two emails with one subject): one
 * record per words would give the new quote the other's thread, and a draft can't keep both. A record whose quote
 * is no longer in the draft gives way to the addition's. */
export function appendQuoted(
	draft: string,
	known: readonly QuoteRecord[],
	addition: QuotedText,
): { text: string; records: readonly QuoteRecord[] } | undefined {
	const kept = draft.trim();
	const text = kept ? `${kept}\n\n${addition.text}` : addition.text;
	const added = withQuoteRecords([], addition.text, addition.quotes);
	const held = new Set(placeQuotes(draft, known).map((quote) => wordsOf(draft, quote)));
	const stale = new Set<string>();
	for (const record of added) {
		const other = known.find((item) => item.words === record.words);
		if (!other || (other.source === record.source && other.ref === record.ref)) continue;
		if (held.has(record.words)) return undefined;
		stale.add(record.words);
	}
	const records = stale.size ? known.filter((record) => !stale.has(record.words)) : known;
	return { text, records: withQuoteRecords(records, addition.text, addition.quotes) };
}

function wordsOf(text: string, quote: MessageQuote): string {
	return text.slice(unitIndex(text, quote.start), unitIndex(text, quote.end));
}

/** The first and last private-use letters: placeholders for quotes while drafts merge. */
const PRIVATE_USE_FIRST = 0xe000;
const PRIVATE_USE_LAST = 0xf8ff;

/** A shared draft merged with each quote as one indivisible piece (app/room-drafts.ts). Letters merge one by one
 * (text-merge.ts), so a quote one side replaced and the other removed would come out as bare words, a quote's words
 * as the member's own. Here every «words» of a quote stands as one placeholder letter while base, mine and theirs
 * merge: a quote is kept, removed or replaced whole, never cut. The placeholders are private-use letters none of the
 * three texts holds; undefined when there aren't enough of them (thousands of private-use letters in a draft).
 *
 * One record per words (`placeQuotes`) can't hold the same words from two emails. When the merge would, the cloud's
 * quote stays and the other gives way (`dropped`): the cloud's draft is what every member's browser shows, and a
 * local quote of the same words would otherwise carry the other email's thread. `edit` turns `mine` into the result,
 * as mergeText's does. */
export function mergeQuoted(
	base: QuotedText,
	mine: QuotedText,
	theirs: QuotedText,
	caret?: number,
): { text: string; quotes: MessageQuote[]; edit: TextEdit; dropped: boolean } | undefined {
	const used = new Set<number>();
	for (const { text } of [base, mine, theirs])
		for (const letter of text) {
			const code = letter.codePointAt(0) ?? 0;
			if (code >= PRIVATE_USE_FIRST && code <= PRIVATE_USE_LAST) used.add(code);
		}
	let next = PRIVATE_USE_FIRST;
	const letters = new Map<string, string>();
	const records = new Map<string, QuoteRecord>();
	const letterFor = (record: QuoteRecord): string | undefined => {
		const key = `${record.source}\n${record.ref}\n${record.words}`;
		let letter = letters.get(key);
		if (letter === undefined) {
			while (used.has(next)) next++;
			if (next > PRIVATE_USE_LAST) return undefined;
			letter = String.fromCharCode(next++);
			letters.set(key, letter);
			records.set(letter, record);
		}
		return letter;
	};
	const tokens = ({ text, quotes }: QuotedText): string | undefined => {
		let out = "";
		let at = 0;
		for (const quote of quotes) {
			const words = wordsOf(text, quote);
			const from = unitIndex(text, quote.start) - 1;
			const letter = letterFor({ words, source: quote.source, ref: quote.ref });
			if (letter === undefined) return undefined;
			out += text.slice(at, from) + letter;
			at = from + words.length + 2;
		}
		return out + text.slice(at);
	};
	const size = (letter: string) => {
		const record = records.get(letter);
		return record ? record.words.length + 2 : letter.length;
	};
	const expand = (tokenText: string): QuotedText & { quotes: MessageQuote[] } => {
		let text = "";
		const quotes: MessageQuote[] = [];
		let characters = 0;
		for (const letter of tokenText) {
			const record = records.get(letter);
			if (!record) {
				text += letter;
				characters += 1;
				continue;
			}
			const length = [...record.words].length;
			quotes.push({ start: characters + 1, end: characters + 1 + length, source: record.source, ref: record.ref });
			text += `«${record.words}»`;
			characters += length + 2;
		}
		return { text, quotes };
	};
	const baseTokens = tokens(base);
	const mineTokens = tokens(mine);
	const theirTokens = tokens(theirs);
	if (baseTokens === undefined || mineTokens === undefined || theirTokens === undefined) return undefined;
	// The caret in the placeholder text: past each whole quote before it, at the start of one it stands in.
	let tokenCaret = caret;
	if (caret !== undefined) {
		let shrunk = 0;
		let inside: number | undefined;
		for (const { from, to } of quotePieces(mine.text, mine.quotes)) {
			if (to <= caret) shrunk += to - from - 1;
			else if (from < caret) inside = from - shrunk;
		}
		tokenCaret = inside ?? caret - shrunk;
	}
	const merged = mergeText(baseTokens, mineTokens, theirTokens, tokenCaret);
	// The same words from two emails: the quote the cloud's draft holds stays, and every other one goes whole.
	const kept = new Map<string, string>();
	for (const letter of theirTokens) {
		const record = records.get(letter);
		if (record && !kept.has(record.words)) kept.set(record.words, letter);
	}
	for (const letter of merged.text) {
		const record = records.get(letter);
		if (record && !kept.has(record.words)) kept.set(record.words, letter);
	}
	let dropped = false;
	let resolved = "";
	// The drop as an edit of the merged placeholder text, so the edit the caret and a send in progress follow
	// (RoomDrafts.sent) keeps or removes each quote whole, never a mark of one.
	const drop: number[] = [];
	for (const letter of merged.text) {
		const record = records.get(letter);
		const gone = record !== undefined && kept.get(record.words) !== letter;
		const step = gone ? -letter.length : letter.length;
		const last = drop[drop.length - 1];
		if (last !== undefined && Math.sign(last) === Math.sign(step)) drop[drop.length - 1] = last + step;
		else drop.push(step);
		if (gone) dropped = true;
		else resolved += letter;
	}
	const result = expand(resolved);
	// The edit in the real text: each placeholder it keeps or removes stands for its whole quote.
	const edit: (number | string)[] = [];
	let at = 0;
	const span = (count: number) => {
		let units = 0;
		for (const letter of mineTokens.slice(at, at + count)) units += size(letter);
		at += count;
		return units;
	};
	for (const step of dropped ? compose(merged.edit, drop) : merged.edit) {
		if (typeof step === "string") edit.push(expand(step).text);
		else if (step > 0) edit.push(span(step));
		else edit.push(-span(-step));
	}
	return { ...result, edit, dropped };
}
