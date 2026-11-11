/** The rules the executor's words follow for text it did not write (a check's output, a file's name, a key of a
 * repository's file): shared by the words of the checks (`code-checks.ts`) and of a repository's site (`code-site.ts`).
 * Pure, and it imports nothing, so that `code-site.ts` stays readable by Node alone. */

/** Whether a line may show the character: not a control (C0, DEL, C1), a separator that some readers break a line at
 * (LS, PS), or a mark that turns the direction of the text after it around. */
export function unseen(code: number): boolean {
	return (
		code < 0x20 ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029 ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}
export const halfCharacter = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;

/** Text from a file or a command as part of one line of the words: every character a line may not show is U+FFFD, and
 * at most `max` bytes, cut at a whole character with an ellipsis. */
export function shown(text: string, max: number): string {
	let line = "";
	for (const character of text) {
		const point = character.codePointAt(0) as number;
		line += halfCharacter(point) || unseen(point) ? "�" : character;
	}
	return bytes(line) <= max ? line : `${cut(line, max - bytes("…"))}…`;
}

/** `text` cut to at most `max` bytes of UTF-8, at a whole character, with no mark. */
export function cut(text: string, max: number): string {
	if (bytes(text) <= max) return text;
	let kept = "";
	let used = 0;
	for (const character of text) {
		used += bytes(character);
		if (used > max) break;
		kept += character;
	}
	return kept;
}

export function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}
