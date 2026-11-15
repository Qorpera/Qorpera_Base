import { POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import { companyPathKey } from "./company-state-shared.ts";
import { isInterfaceName } from "./interfaces.ts";

/* Retired interfaces (the founder, 15 November 2026: users "should also get a "retire interface" config when
 * rightclicking an interface to stop maintaining it, and hide it"): a member retires an agent's interface app from
 * their sidebar, and it is hidden for the whole company and its agent stops keeping it, until a member brings it back.
 * The state is one Markdown file of the Company File, `apps/retired.md`, one line an interface:
 *
 *   # Retired interfaces
 *   - <app folder name> | <member user id> | <ISO time, UTC>
 *
 * Not a key in `app.toml`: an unknown key fails the manifest's parse in every older reader and hides the app,
 * `save_app` rebuilds the manifest from its fields, and a Restore of an old `app.toml` would undo it. Only members
 * write the file (the web, through their own folder client); the runtime refuses every agent's change of it and every
 * change of a retired app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3e).
 *
 * The reader is tolerant: an app is retired when its folder name has a line that reads, the first such line of a name
 * says who retired it and when, and every other line is kept as written and means nothing. At most the first
 * APP_RETIRED_MAX_LINES lines are read. It is not an app (`appPath` reads no app in `retired.md`), so nothing that
 * lists the folders of `apps/` sees it as one. Browser-safe: the web and the runtime read the same file. */

export const APP_RETIRED_PATH = "apps/retired.md";
/** The lines a reader reads, from the top. */
export const APP_RETIRED_MAX_LINES = 200;
/** What a reader takes of the file: far more than 200 lines need. A larger file is not read, and nothing is retired. */
export const APP_RETIRED_MAX_BYTES = 1024 * 1024;
/** The first line of a new file. */
export const APP_RETIRED_HEADING = "# Retired interfaces";

export interface RetiredApp {
	/** The app's folder name under `apps/`. */
	readonly name: string;
	/** The member who retired it: their user id, lowercase. */
	readonly by: string;
	/** When, as written: an ISO time in UTC. */
	readonly at: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
// Linear in its line whatever it holds: no two quantifiers next to each other take the same character.
const LINE = /^[ \t]*-[ \t]+([^\s|]+)[ \t]*\|[ \t]*([^\s|]+)[ \t]*\|[ \t]*([^\s|]+)[ \t\r]*$/;

/** Whether a path is the file, in any letter case the folder takes for it. */
export function isAppRetiredPath(path: string): boolean {
	return companyPathKey(path) === companyPathKey(APP_RETIRED_PATH);
}

/** One line read as a retired interface, or null. */
function readLine(line: string): RetiredApp | null {
	const found = LINE.exec(line);
	if (!found) return null;
	const [, name = "", by = "", at = ""] = found;
	if (
		!isInterfaceName(name) ||
		!POSTGRES_UUID_PATTERN.test(by.toLowerCase()) ||
		!ISO.test(at) ||
		!Number.isFinite(Date.parse(at))
	)
		return null;
	return { name, by: by.toLowerCase(), at };
}

/** The retired interfaces of the file's text, in its order, each name once (its first line). Never fails: a line that
 * does not read is skipped; null or empty text is none. */
export function parseRetiredApps(text: string | null): readonly RetiredApp[] {
	if (!text) return [];
	const found: RetiredApp[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n", APP_RETIRED_MAX_LINES)) {
		const app = readLine(line);
		if (!app || seen.has(app.name)) continue;
		seen.add(app.name);
		found.push(app);
	}
	return found;
}

/** The file's next text with `name` retired by the member `by` at `at` (an ISO time in UTC), every other byte as
 * written: a line added at the end, or a new file with its heading for null or empty text. A retired app answers the
 * text unchanged. Null when the new line would not be read (the file already has APP_RETIRED_MAX_LINES lines before
 * it). Throws on a name, member or time the file cannot hold. */
export function retireApp(text: string | null, name: string, by: string, at: string): string | null {
	const line = `- ${name} | ${by.toLowerCase()} | ${at}`;
	if (readLine(line)?.name !== name)
		throw new Error("A retired interface needs an app's name, a member's id and a time");
	if (parseRetiredApps(text).some((app) => app.name === name)) return text ?? "";
	const next = text ? `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n` : `${APP_RETIRED_HEADING}\n${line}\n`;
	return parseRetiredApps(next).some((app) => app.name === name) ? next : null;
}

/** The file's next text with `name` brought back: every line that reads as its retirement taken out, every other byte
 * as written. An app that is not retired answers the text unchanged. */
export function bringBackApp(text: string, name: string): string {
	const lines = text.split("\n");
	const kept = lines.filter((line) => readLine(line)?.name !== name);
	return kept.length === lines.length ? text : kept.join("\n");
}
