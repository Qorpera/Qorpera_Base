import { appLinkName } from "@qorpera/cloud-client/interface-apps";

/* An answer to a question on the agent's wall: the message opens with the question, quoted, so the agent reads what is
 * being answered and the thread shows it. It is plain text, so everything that carries a message carries this too.
 * A note from an interface app (`qorpera.tell`, RUNTIME-INTERFACE-APPS.md §5) opens the same way, with the app and the
 * thing in it the note is about as its quoted line: `> app:<name>#<at> · <about>`. Until it is sent, that line is what
 * the draft answers (`answering`, as a wall question is), shown above the composer and never in it; the send puts it
 * first. The thread draws it as the app's card (views/conversation.ts). */

/** The longest question a message repeats. */
const QUESTION_MAX = 240;

/** A wall headline as one quoted line. A name or a quote mark in it names nobody and quotes nothing in the message. */
export function replyQuestion(words: string): string {
	const line = words.replace(/[@«»]/g, "").replace(/\s+/g, " ").trim();
	return line.length > QUESTION_MAX ? `${line.slice(0, QUESTION_MAX - 1).trimEnd()}…` : line;
}

/** The text a draft goes as. Nothing to say and nothing attached stays nothing, so it is not sent. */
export function withReply(question: string | undefined, text: string, files: number): string {
	if (!question || (!text && !files)) return text;
	return text ? `> ${question}\n\n${text}` : `> ${question}`;
}

/** The question a message answers and the member's own words, from where they start in the message. */
export function splitReply(text: string): { question: string; text: string; start: number } | undefined {
	const match = /^> ([^\n]+)(?:\n\n([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const words = match[2] ?? "";
	return { question: match[1] as string, text: words, start: text.length - words.length };
}

/** What an app's note is about, at most, in characters. */
export const APP_NOTE_ABOUT_MAX = 60;
/** The thing in the app a note is about: its id in the app's own data. */
export const APP_NOTE_AT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** What an app's page says a note is about, as one line that names nobody, quotes nothing and turns no text around: a
 * name or a quote mark is taken out, and so are control and direction marks; spaces and line breaks become one space. */
export function appNoteAbout(words: string): string {
	return words
		.replace(/[@«»‎‏‪-‮⁦-⁩]/g, "")
		.replace(/[\s\p{Cc}]+/gu, " ")
		.trim();
}

/** What a note from an app answers, as a draft carries it until it is sent: the app, the thing and what it is about. */
export function appNoteLine(app: string, at: string | null, about: string): string {
	return `app:${app}${at === null ? "" : `#${at}`} · ${about}`;
}

/** A note from an app as the message it goes as: that line first, then the member's own words. */
export function appNoteText(app: string, at: string | null, about: string, words: string): string {
	return withReply(appNoteLine(app, at, about), words, 0);
}

/** The app, the thing and what it is about, from a message's quoted first line, or undefined when it names no app. */
export function appNoteHeader(line: string): { app: string; at: string | null; about: string } | undefined {
	const match = /^app:([^\s#·]+)(?:#(\S+))? · (.+)$/.exec(line);
	if (!match) return undefined;
	const app = appLinkName(`app:${match[1]}`);
	if (app === undefined || (match[2] !== undefined && !APP_NOTE_AT.test(match[2]))) return undefined;
	return { app, at: match[2] ?? null, about: match[3] as string };
}

/** How a draft carries the line an app's note answers wherever it is saved and shared (the room's shared draft,
 * app/room-drafts.ts): as the text's first line, quoted, then an empty line, as the message will open. */
export function appNoteLead(line: string): string {
	return `> ${line}\n\n`;
}

/** A draft's text that opens with an app note's line: the line, its lead as written, and the rest; undefined when the
 * text opens with none. */
export function splitAppNote(text: string): { line: string; lead: string; rest: string } | undefined {
	const match = /^> ([^\n]+)\n\n/.exec(text);
	const line = match?.[1];
	if (!match || line === undefined || !appNoteHeader(line)) return undefined;
	return { line, lead: match[0], rest: text.slice(match[0].length) };
}
