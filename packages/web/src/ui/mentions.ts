/* Mentions: "@" and a member's or agent's name in a message. The cloud reads the
 * same rule from the text (qorpera_room_text_mentions, 20260928010000): an agent
 * named in a group chat answers, the others stay quiet; a member named is told.
 * The rule, shared with the SQL: "@" at the start or after a space or an opening
 * bracket or quote, then the name (any case), then the end or a space or
 * punctuation. Longer names win: "@Bo Jensen" names Bo Jensen, not Bo. Everyone
 * who shares a name named is named. */

export interface MentionTarget {
	kind: "member" | "agent";
	id: string;
	name: string;
}

export interface Mention {
	target: MentionTarget;
	start: number;
	end: number;
}

const BEFORE = /[\s(["'“‘]/u;
const AFTER = /[\s.,!?;:)\]}"'”’]/u;

/** Every mention in a text, in order. */
export function findMentions(text: string, targets: readonly MentionTarget[]): Mention[] {
	const lower = text.toLowerCase();
	// Which name took each letter: a shorter name cannot use them, the same name can.
	const taken = new Array<string | undefined>(text.length).fill(undefined);
	const found: Mention[] = [];
	const byLength = [...targets].filter((target) => target.name.trim()).sort((a, b) => b.name.length - a.name.length);
	for (const target of byLength) {
		const needle = `@${target.name.toLowerCase()}`;
		let from = 0;
		for (;;) {
			const start = lower.indexOf(needle, from);
			if (start < 0) break;
			from = start + 1;
			const end = start + needle.length;
			const before = start === 0 || BEFORE.test(text[start - 1]!);
			const after = end === text.length || AFTER.test(text[end]!);
			if (!before || !after || taken.slice(start, end).some((name) => name !== undefined && name !== needle))
				continue;
			taken.fill(needle, start, end);
			found.push({ target, start, end });
		}
	}
	return found.sort((a, b) => a.start - b.start);
}

/** A text as plain parts and mentions, for showing a message. */
export function mentionParts(text: string, targets: readonly MentionTarget[]): (string | Mention)[] {
	const parts: (string | Mention)[] = [];
	let at = 0;
	for (const mention of findMentions(text, targets)) {
		if (mention.start > at) parts.push(text.slice(at, mention.start));
		parts.push(mention);
		at = mention.end;
	}
	if (at < text.length) parts.push(text.slice(at));
	return parts;
}

/** The mention being typed at the caret: "Ask @so|" → { start: 4, query: "so" }. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
	const before = text.slice(0, caret);
	// One word, or two ("@Sofie L"); a space right after a name ends the mention.
	const match = /(?:^|[\s(["'“‘])@([^\s@]{0,32}(?: [^\s@]{1,32})?)$/u.exec(before);
	if (!match) return undefined;
	const query = match[1]!;
	return { start: caret - query.length - 1, query };
}

/** Letters as a keyboard without them types them: "Søren" is found by "so", "Æble" by "ae". */
const PLAIN: Record<string, string> = { ø: "o", æ: "ae", ß: "ss", đ: "d", ł: "l", œ: "oe" };

function fold(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/[øæßđłœ]/g, (letter) => PLAIN[letter] ?? letter);
}

/** Who a query can mean: the start of the name or of any word in it, accents aside. Agents first. */
export function matchTargets(query: string, targets: readonly MentionTarget[], limit = 6): MentionTarget[] {
	const wanted = fold(query.trim());
	return targets
		.filter((target) => {
			const name = fold(target.name);
			return !wanted || name.startsWith(wanted) || name.split(/\s+/).some((word) => word.startsWith(wanted));
		})
		.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "agent" ? -1 : 1))
		.slice(0, limit);
}
