import {
	characterIndex,
	type MessageQuote,
	QUOTE_MAX_CHARACTERS,
	QUOTE_OPEN,
	quoteRefFits,
	unitIndex,
} from "../cloud/quotes.ts";
import { diffText } from "./text-merge.ts";

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

/** `known` with the records of a text's quotes added; a record whose words are already known is left out. */
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

/** The member changed a text from `before` to `after`; `caret` is where their caret stands in `after`. A change that
 * reaches into a quote (its marks or its words) removes all of it: the rest of its piece goes, and the words the
 * member typed stay. Returns the text to keep and where the caret goes in it. The field keeps the caret out of a
 * quote (`snapSelection`), so this is mostly a deletion that reached a quote's mark, removing the quote whole. */
export function keepQuotesWhole(
	before: string,
	pieces: readonly QuotePiece[],
	after: string,
	caret?: number,
): { text: string; caret: number | undefined } {
	if (before === after || !pieces.length) return { text: after, caret };
	// One replaced span: `removed` units of `before` from `prefix`, in place of which `inserted` stands. diffText
	// starts with the kept prefix only when there is one; a kept number after the change is the suffix.
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
	const shift = inserted.length - removed;
	const cut: [number, number][] = [];
	for (const { from, to } of pieces) {
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
