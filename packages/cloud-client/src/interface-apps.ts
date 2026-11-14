import { AGENT_COLOURS, type AgentColour, companyPathKey } from "./company-state-shared.ts";
import { INTERFACE_EMBLEMS, type InterfaceEmblem, isInterfaceName } from "./interfaces.ts";
import { parseTomlSubset, TomlSubsetError } from "./toml-subset.ts";

/* Interface apps (deploy/first-node/RUNTIME-INTERFACE-APPS.md, Jonas 5 November 2026): a small web page an agent makes
 * to show members something, kept as ordinary files in `apps/<name>/` of the Company File with an `app.toml` manifest.
 * The web runs it in the Company File's locked frame (packages/web/src/ui/page-frame.ts) and shows it as a page of its own.
 * This module is the format both sides read: names, the manifest's parser, which files an app may load, and the one
 * edit a reviewed post makes (`setAppPosted`). Browser-safe. */

/** The folder at the top of the Company File that holds the apps. */
export const APPS_FOLDER = "apps";
export const APP_MANIFEST = "app.toml";
export const APP_MANIFEST_MAX_BYTES = 4 * 1024;
/** One file of an app, as the write tools bound a file. */
export const APP_FILE_MAX_BYTES = 512 * 1024;
export const APP_MAX_FILES = 64;
/** What a page of an app may load in all, its entry included. */
export const APP_MAX_BYTES = 4 * 1024 * 1024;
/** One picture or video of an app, and an app's pictures and videos in all, on top of the rest (a machine writes them;
 * no text tool does). Pictures share the videos' bounds since 7 November 2026: a photoreal render is 0.5 to 2 MB, past
 * the 512 KiB of a page or code file. */
export const APP_VIDEO_FILE_MAX_BYTES = 12 * 1024 * 1024;
export const APP_VIDEOS_MAX_BYTES = 48 * 1024 * 1024;
export const APP_NAME_MAX_CHARS = 60;
export const APP_ABOUT_MAX_CHARS = 200;
export const APP_DEFAULT_ENTRY = "index.html";
export const APP_DEFAULT_EMBLEM: InterfaceEmblem = "page";
/** The live sources a manifest may ask for (§5). `questions`: the agents' open question cards that point at the app;
 * `data`: the company's databases, asked by their questions; `money` and `site`: the platform's own numbers of the
 * company, asked as questions of the reserved database `qorpera` (APP_NUMBERS_DATABASE): `money` the bank's sums
 * (`qorpera/money-*`), `site` the visits of the company's sites (`qorpera/sites`, `qorpera/site-*`). Neither needs
 * `data`, and `data` reads neither. */
export const APP_READS = Object.freeze([
	"files",
	"tables",
	"todos",
	"agents",
	"questions",
	"data",
	"money",
	"site",
] as const);
export type AppRead = (typeof APP_READS)[number];
/** The database name no company database may carry (the data gateway refuses it): its questions are the platform's own
 * numbers of the company (supabase/CLIENT-CONTRACT.md "The company's numbers"), answered in the data gateway's shape. */
export const APP_NUMBERS_DATABASE = "qorpera";

/** The read a question of the platform's numbers needs: `money` for `money-*`, `site` for `sites` and `site-*`; null for
 * a name that is neither, which is no question there. */
export function appNumbersRead(question: string): "money" | "site" | null {
	if (/^money-[a-z0-9]/.test(question)) return "money";
	if (question === "sites" || /^site-[a-z0-9]/.test(question)) return "site";
	return null;
}
/** The folders at the top of the Company File that the platform writes or keeps (the agents' prompt: "the platform
 * writes digital-post/, bank/, members/ and hooks/"), by their keys (`companyPathKey`): an app's page reads no file in
 * them and its links open none (§4, §5). */
export const APP_CLOSED_FOLDERS: readonly string[] = Object.freeze([
	"qorperaos",
	"hooks",
	"digital-post",
	"bank",
	"members",
	"code",
]);
/** What a manifest's `writes` may list (§5): `answers`, an answer to an agent's open question that points at the app,
 * and `table:<name>`, a row of that company table. The page only asks; the member allows each one on a bar the web
 * draws outside the app's frame, and the save is the member's own. */
export const APP_WRITE_ANSWERS = "answers";
export const APP_WRITE_TABLE = "table:";
export type AppWrite = typeof APP_WRITE_ANSWERS | `${typeof APP_WRITE_TABLE}${string}`;
export const APP_WRITES_MAX = 16;
/** Tables no app writes: the platform's own pages keep them (who owns and supervises what, on Members). */
export const APP_WRITE_KEPT_TABLES: readonly string[] = Object.freeze(["areas"]);
/** What `writes` must be, as a problem says it. */
export const APP_WRITES_SHAPE = `a list of at most ${APP_WRITES_MAX} of ${APP_WRITE_ANSWERS} and ${APP_WRITE_TABLE}<name>, a company table's folder name`;

/** The table a `writes` entry names, or null when the entry is not a table's. */
export function appWriteTable(write: string): string | null {
	return write.startsWith(APP_WRITE_TABLE) ? write.slice(APP_WRITE_TABLE.length) : null;
}

/** A manifest's `writes` as given (a TOML or JSON list), checked: the entries without repeats, or why not. */
export function parseAppWrites(
	value: unknown,
): { readonly writes: readonly AppWrite[] } | { readonly problem: string } {
	if (!Array.isArray(value) || value.length > APP_WRITES_MAX) return { problem: `writes must be ${APP_WRITES_SHAPE}` };
	const writes: AppWrite[] = [];
	for (const write of value) {
		const table = typeof write === "string" ? appWriteTable(write) : null;
		if (write !== APP_WRITE_ANSWERS && (table === null || !isInterfaceName(table)))
			return { problem: `writes must be ${APP_WRITES_SHAPE}` };
		if (table !== null && APP_WRITE_KEPT_TABLES.includes(table))
			return { problem: `writes may not name the table ${table}: members change it on its own page` };
		if (!writes.includes(write as AppWrite)) writes.push(write as AppWrite);
	}
	return { writes };
}

/** The kits an app can be made from (RUNTIME-INTERFACE-APPS.md §3a and §3b): `save_app` writes the kit's own files
 * into the app's folder, and the agent writes only what the kit leaves to it. `explainer` is a short narrated video:
 * the kit writes `engine.js` and `index.html`, the agent `scenes.js`. `model`, `board`, `path` and `object` each draw
 * one visual form from one data file (Jonas, 13 November 2026: apps "are supposed to be objects, models, apps and
 * videos that are visual-first to let you see the company"): the kit writes `engine.js` and `index.html`, the agent
 * `<kit>.json` and the pictures it names. */
export const APP_KITS = Object.freeze(["explainer", "model", "board", "path", "object"] as const);
export type AppKit = (typeof APP_KITS)[number];

/** The kinds of file a page may load, by extension, with the media type each is handed to the frame as. */
export const APP_FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	mjs: "text/javascript",
	json: "application/json",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	mp4: "video/mp4",
	webm: "video/webm",
});
/** The kinds that are videos. */
export const APP_VIDEO_KINDS: ReadonlySet<string> = new Set(["mp4", "webm"]);
/** The kinds that are pictures (an SVG is text). */
export const APP_PICTURE_KINDS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
/** Pictures and videos: each at most APP_VIDEO_FILE_MAX_BYTES, all of them at most APP_VIDEOS_MAX_BYTES. */
export const APP_MEDIA_KINDS: ReadonlySet<string> = new Set([...APP_PICTURE_KINDS, ...APP_VIDEO_KINDS]);
/** The kinds that are text: an agent writes them with its text tools. */
export const APP_TEXT_KINDS: ReadonlySet<string> = new Set([
	"html",
	"htm",
	"css",
	"js",
	"mjs",
	"json",
	"txt",
	"md",
	"csv",
	"svg",
]);

export interface AppManifest {
	readonly name: string;
	readonly about: string | null;
	readonly emblem: InterfaceEmblem;
	readonly colour: AgentColour | null;
	/** The page that opens, relative to the app's folder. */
	readonly entry: string;
	/** The agent that made it (its staff agent id), or null when a member wrote the manifest without one. */
	readonly owner: string | null;
	readonly posted: boolean;
	readonly reads: readonly AppRead[];
	/** What the page may ask the member to change (§5); empty for a page that only shows. */
	readonly writes: readonly AppWrite[];
	/** A concept of the company's product (Jonas, 8 November 2026: "vision alignment through concepts"): it shows in the
	 * Concepts viewer, beside the company's other concepts, not as an app of its own. */
	readonly concept: boolean;
	/** A picture of the app, relative to its folder (.png, .jpg or .webp), shown as its thumbnail; null for none. */
	readonly cover: string | null;
	/** The kit the app is made from, or null for a page the agent wrote whole. A kit's page is `index.html`. */
	readonly kit: AppKit | null;
}

export interface AppProblem {
	readonly line: number | null;
	readonly message: string;
}

export type AppManifestParse =
	| { readonly ok: true; readonly manifest: AppManifest }
	| { readonly ok: false; readonly problems: readonly AppProblem[] };

const KEYS = [
	"name",
	"about",
	"emblem",
	"colour",
	"entry",
	"owner",
	"posted",
	"reads",
	"writes",
	"concept",
	"cover",
	"kit",
];
/** The kinds a cover may be. */
export const APP_COVER_KINDS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A file's kind: its extension, lowercase, or "" for none. */
export function appFileKind(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A path inside an app's folder, as a manifest or a page names it: relative, `/`-separated, with no empty, `.` or `..`
 * part, no scheme, query or fragment, and no backslash. Answers the plain path, or null. `./` in front is allowed. */
export function appRelativePath(value: string): string | null {
	if (value.length === 0 || value.length > 1024 || /[\\\0?#]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value))
		return null;
	const path = value.startsWith("./") ? value.slice(2) : value;
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
	return path;
}

/** Where an app named `name` lives, or null for a name that is not an app's. */
export function appFolder(name: string): string | null {
	return isInterfaceName(name) ? `${APPS_FOLDER}/${name}` : null;
}

/** The app a company-relative path is in, with the path inside it: `apps/<name>/<inner>`. The folder itself has an
 * empty `inner`. Null for any other path, or a badly named app folder. */
export function appPath(path: string): { readonly name: string; readonly inner: string } | null {
	const key = companyPathKey(path);
	if (!key.startsWith(`${APPS_FOLDER}/`)) return null;
	const rest = key.slice(APPS_FOLDER.length + 1);
	const slash = rest.indexOf("/");
	const name = slash === -1 ? rest : rest.slice(0, slash);
	if (!isInterfaceName(name)) return null;
	return { name, inner: slash === -1 ? "" : rest.slice(slash + 1) };
}

/** Whether a path is an app's manifest. */
export function isAppManifestPath(path: string): boolean {
	const app = appPath(path);
	return app !== null && app.inner === APP_MANIFEST;
}

/** Reads an `app.toml`. Every problem is found, with its line, so one fix can deal with all of them. */
export function parseAppManifest(text: string): AppManifestParse {
	if (new TextEncoder().encode(text).byteLength > APP_MANIFEST_MAX_BYTES)
		return {
			ok: false,
			problems: [{ line: null, message: `app.toml is larger than ${APP_MANIFEST_MAX_BYTES} bytes` }],
		};
	let document: ReturnType<typeof parseTomlSubset>;
	try {
		document = parseTomlSubset(text);
	} catch (error) {
		if (error instanceof TomlSubsetError)
			return { ok: false, problems: [{ line: error.line, message: error.message }] };
		throw error;
	}
	const value = document.value;
	const problems: AppProblem[] = [];
	const line = (key: string) => document.lines.get(key) ?? null;
	const problem = (key: string, message: string) => problems.push({ line: line(key), message });
	for (const key of Object.keys(value))
		if (!KEYS.includes(key)) problem(key, `${key} is not a key of app.toml (it has ${KEYS.join(", ")})`);
	const text_ = (key: string, max: number, required: boolean): string | null => {
		const raw = value[key];
		if (raw === undefined) {
			if (required) problem(key, `${key} is missing`);
			return null;
		}
		if (typeof raw !== "string") {
			problem(key, `${key} must be text`);
			return null;
		}
		const trimmed = raw.trim();
		if ((required && trimmed.length === 0) || [...trimmed].length > max || /[\0-\x1f\x7f]/.test(trimmed)) {
			problem(key, `${key} must be one line of ${required ? "1–" : "at most "}${max} characters`);
			return null;
		}
		return trimmed.length === 0 ? null : trimmed;
	};
	const choice = <T extends string>(key: string, options: readonly T[]): T | null => {
		const raw = value[key];
		if (raw === undefined) return null;
		if (typeof raw !== "string" || !(options as readonly string[]).includes(raw)) {
			problem(key, `${key} must be one of ${options.join(", ")}`);
			return null;
		}
		return raw as T;
	};
	const name = text_("name", APP_NAME_MAX_CHARS, true);
	const about = text_("about", APP_ABOUT_MAX_CHARS, false);
	const emblem = choice("emblem", INTERFACE_EMBLEMS) ?? APP_DEFAULT_EMBLEM;
	const colour = choice("colour", AGENT_COLOURS);
	let entry = APP_DEFAULT_ENTRY;
	if (value.entry !== undefined) {
		const relative = typeof value.entry === "string" ? appRelativePath(value.entry) : null;
		const kind = relative === null ? "" : appFileKind(relative);
		if (relative === null || (kind !== "html" && kind !== "htm"))
			problem("entry", "entry must be a relative path to an .html file in the app's folder");
		else entry = relative;
	}
	let owner: string | null = null;
	if (value.owner !== undefined) {
		if (typeof value.owner !== "string" || !UUID.test(value.owner.toLowerCase()))
			problem("owner", "owner must be the id of the agent that made the app");
		else owner = value.owner.toLowerCase();
	}
	let posted = false;
	if (value.posted !== undefined) {
		if (typeof value.posted !== "boolean") problem("posted", "posted must be true or false");
		else posted = value.posted;
	}
	let concept = false;
	if (value.concept !== undefined) {
		if (typeof value.concept !== "boolean") problem("concept", "concept must be true or false");
		else concept = value.concept;
	}
	let cover: string | null = null;
	if (value.cover !== undefined) {
		const relative = typeof value.cover === "string" ? appRelativePath(value.cover) : null;
		if (relative === null || !APP_COVER_KINDS.has(appFileKind(relative)))
			problem("cover", "cover must be a relative path to a .png, .jpg or .webp picture in the app's folder");
		else cover = relative;
	}
	const reads: AppRead[] = [];
	if (value.reads !== undefined) {
		if (!Array.isArray(value.reads)) problem("reads", `reads must be a list of ${APP_READS.join(", ")}`);
		else
			for (const read of value.reads) {
				if (typeof read !== "string" || !(APP_READS as readonly string[]).includes(read))
					problem("reads", `reads must be a list of ${APP_READS.join(", ")}`);
				else if (!reads.includes(read as AppRead)) reads.push(read as AppRead);
			}
	}
	let writes: readonly AppWrite[] = [];
	if (value.writes !== undefined) {
		const parsed = parseAppWrites(value.writes);
		if ("problem" in parsed) problem("writes", parsed.problem);
		else writes = parsed.writes;
	}
	const kit = choice("kit", APP_KITS);
	// A kit writes its own page, so there is one place it opens.
	if (kit !== null && entry !== APP_DEFAULT_ENTRY)
		problem("entry", `an app made from a kit opens ${APP_DEFAULT_ENTRY}: leave entry out`);
	if (problems.length > 0 || name === null) return { ok: false, problems };
	return {
		ok: true,
		manifest: { name, about, emblem, colour, entry, owner, posted, reads, writes, concept, cover, kit },
	};
}

/** A TOML basic string. */
export function tomlString(value: string): string {
	return `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/[\0-\x1f\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** A manifest written out, as `save_app` makes a new one. */
export function writeAppManifest(manifest: AppManifest): string {
	const lines = [`name = ${tomlString(manifest.name)}`];
	if (manifest.about) lines.push(`about = ${tomlString(manifest.about)}`);
	lines.push(`emblem = ${tomlString(manifest.emblem)}`);
	if (manifest.colour) lines.push(`colour = ${tomlString(manifest.colour)}`);
	lines.push(`entry = ${tomlString(manifest.entry)}`);
	if (manifest.owner) lines.push(`owner = ${tomlString(manifest.owner)}`);
	lines.push(`posted = ${manifest.posted}`);
	if (manifest.reads.length > 0) lines.push(`reads = [${manifest.reads.map(tomlString).join(", ")}]`);
	if (manifest.writes.length > 0) lines.push(`writes = [${manifest.writes.map(tomlString).join(", ")}]`);
	if (manifest.concept) lines.push("concept = true");
	if (manifest.cover) lines.push(`cover = ${tomlString(manifest.cover)}`);
	if (manifest.kit) lines.push(`kit = ${tomlString(manifest.kit)}`);
	return `${lines.join("\n")}\n`;
}

/** A manifest's text with `posted` set, every other byte as written: the line that sets it is changed in place, or a
 * line is added at the end. Null when the text is not a manifest that parses. */
export function setAppPosted(text: string, posted: boolean): string | null {
	const parsed = parseAppManifest(text);
	if (!parsed.ok) return null;
	const at = /^([ \t]*posted[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)$/m;
	const next = at.test(text)
		? text.replace(at, (_line, head: string, _old: string, tail: string) => `${head}${posted}${tail}`)
		: `${text}${text.length === 0 || text.endsWith("\n") ? "" : "\n"}posted = ${posted}\n`;
	const check = parseAppManifest(next);
	return check.ok && check.manifest.posted === posted ? next : null;
}

/** A link to an app in a message: `app:<name>`, exactly so. Answers the name, or undefined. */
export function appLinkName(href: string): string | undefined {
	if (!href.startsWith("app:")) return undefined;
	const name = href.slice(4);
	return isInterfaceName(name) ? name : undefined;
}
