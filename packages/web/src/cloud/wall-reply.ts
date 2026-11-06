/* An answer to a question on the agent's wall: the message opens with the question, quoted, so the agent reads what is
 * being answered and the thread shows it. It is plain text, so everything that carries a message carries this too. */

/** The longest question a message repeats. */
const QUESTION_MAX = 240;

/** A wall headline as one quoted line. A name or a quote mark in it names nobody and quotes nothing in the message. */
export function replyQuestion(words: string): string {
	const line = words.replace(/[@«»]/g, "").replace(/\s+/g, " ").trim();
	return line.length > QUESTION_MAX ? `${line.slice(0, QUESTION_MAX - 1).trimEnd()}…` : line;
}

export function withReply(question: string, text: string): string {
	return text ? `> ${question}\n\n${text}` : `> ${question}`;
}

/** The question a message answers and the member's own words, from where they start in the message. */
export function splitReply(text: string): { question: string; text: string; start: number } | undefined {
	const match = /^> ([^\n]+)(?:\n\n([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const words = match[2] ?? "";
	return { question: match[1] as string, text: words, start: text.length - words.length };
}
