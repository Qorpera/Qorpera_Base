/*
 * The interface app tools of a folder-v2 run (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3; Jonas, 5 November 2026):
 * an agent makes a small web page, kept as files in `apps/<name>/` of the Company File, to show members a part of the
 * company as it stands, and members open it as a page of its own.
 * - `save_app` creates an app (its folder, its `app.toml` and its files) or changes its manifest and files, in one
 *   change set under the call's receipt. It applies at once (review class internal): the files are the agent's own work.
 *   It checks the name, the manifest, each file's kind and size and the app's totals before anything is written; it
 *   sets `owner` and `posted = false` on a new app and never changes either after.
 *   Its answer carries `look`: what a quick read of the saved entry page found (`appLookNotes`), as advice.
 *   An app made from a kit (`manifest.kit`, §3a) gets the kit's own files from this call: for an explainer the engine
 *   and the page, beside the agent's `scenes.js`, whose quick read is the `look` (cloud-app-kit-explainer.ts).
 * - `post_app` sets `posted`, which shows the app in every member's apps drawer or takes it away: delegation, which the
 *   automatic review sees (cloud-action-review.ts). It rewrites that one line of `app.toml`, every other byte as written.
 * `company_write` and `company_edit` check an `app.toml` the same way and refuse a change of `posted`
 * (cloud-folder-file-tools.ts, `appManifestCheck`).
 */

import { createHash } from "node:crypto";
import { isAppGroupId } from "@qorpera/cloud-client/app-groups";
import { AGENT_COLOURS, companyPathKey } from "@qorpera/cloud-client/company-state-shared";
import {
	APP_CLOSED_FOLDERS,
	APP_COVER_KINDS,
	APP_DEFAULT_ENTRY,
	APP_FILE_MAX_BYTES,
	APP_FILE_TYPES,
	APP_KITS,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_MAX_BYTES,
	APP_MAX_FILES,
	APP_MEDIA_KINDS,
	APP_READS,
	APP_TEXT_KINDS,
	APP_VIDEO_FILE_MAX_BYTES,
	APP_VIDEOS_MAX_BYTES,
	APP_WRITES_MAX,
	type AppManifest,
	appFileKind,
	appFolder,
	appLinkName,
	appRelativePath,
	parseAppManifest,
	parseAppWrites,
	setAppPosted,
	writeAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { INTERFACE_EMBLEMS, isInterfaceName } from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
import {
	EXPLAINER_CLIPS,
	EXPLAINER_CLIPS_MAX_BYTES,
	EXPLAINER_ENGINE,
	EXPLAINER_ENGINE_JS,
	EXPLAINER_PAGE,
	EXPLAINER_SCENES,
	explainerNotes,
	explainerPage,
	parseExplainerClips,
} from "./cloud-app-kit-explainer.ts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderNewEntry,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { placeAppInGroup } from "./cloud-folder-app-groups.ts";
import {
	args,
	cloudFolderRefusal,
	OPERATION_KEY,
	operationKey,
	released,
	TOOL_VERSION,
	unavailable,
} from "./cloud-folder-file-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	MAX_TOOL_ARGUMENT_BYTES,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/** Files one save_app call writes, at most. */
const FILES_PER_CALL = 32;
/** The app's entries a save lists to check its totals: more than an app may hold. */
const LIST_LIMIT = 200;

/**
 * What save_app's schema says of `reads`: how a page reads the company's live data (the bridge of
 * RUNTIME-INTERFACE-APPS.md §5, which no agent-made app had used by 10 November 2026: every page was typed in by hand
 * and went stale when its area moved on). It sits on the field because a tool's own description holds 4096 bytes. The
 * pace it sets keeps a page inside the bridge's budget (120 a minute, todos as ten; change notices up to once a
 * second): six draws a minute of todos, agents and a few files stay under it, and a page that redrew on every notice
 * would spend it in seconds and then show an error until the next change.
 */
const SAVE_APP_READS =
	"The live sources the page may read. The page's script reads the company through the qorpera object, and every call returns a promise. qorpera.read(path) gives a file's text and qorpera.list(folder) a folder's entries (name, path, kind, bytes, updatedAt), both by company path, such as apps/<name>/state.json: the app's own folder always, any other company path only with files in reads. qorpera.table(name) gives {name, columns, rows}, each row an object by column name (tables in reads). qorpera.todos() gives every agent's todos as {agent, title, status, updatedAt}, with status open, blocked, done or cancelled (todos in reads). qorpera.agents() gives each agent's name, role and working, true while it works (agents in reads). qorpera.questions() gives your and the other agents' open questions to this member that point at this app (questions in reads; writes says how a page answers one). qorpera.onChange(fn) calls fn when the company folder changed, which in a busy company is every few seconds. Read and draw when the page opens; after a change draw again once, no sooner than ten seconds after the last draw however many changes arrive, and do not poll on a timer. An app may make 120 calls a minute in a member's tab and 8 at a time, and todos counts as ten calls, so call each source once per draw. Keep the facts a page shows (decisions, numbers, open questions) in one data file in the app's folder and draw the page from it, so a change of state is a change to that one file; show who works on what and what is blocked from todos and agents instead of typing it in. When a read fails, keep what the page last showed and read again ten seconds later, until a read works; with nothing to show yet, show a plain line, never an empty page. Reading changes nothing: writes says what a page may ask a member to change.";

/**
 * What save_app's schema says of `writes`: how a page lets a member act on the company (RUNTIME-INTERFACE-APPS.md §5;
 * Jonas, 10 November 2026: "interfaces let's you interact with your company directly"). The page only asks: the web
 * draws a bar outside the app's frame that shows what will be saved, and the save is the member's own. It sits on the
 * field for the same reason as `reads`.
 */
const SAVE_APP_WRITES =
	"What the page may ask a member to change, of answers and table:<name>. A page changes nothing by itself: its script asks, Qorpera shows the member a bar above the page with exactly what will be saved, and it is saved only when the member allows it there, as the member's own change. Each call returns a promise: it resolves once the change is saved, and rejects with the reason when the member says not now, when another request still waits, or when the save is refused. Show that reason on the page and leave the button, so the member can try again. Ask only from a click on a button of the page that says what it does, one request per click, never when the page opens or on a timer: after three not now in a row the page may not ask again until the member reloads it. A <form> does not submit inside an app: handle the button's click (and Enter in a field), not a form's submit. answers: a member answers an open question on the page. Ask the question with ask_member and point it at the app, with a link [title](app:<name>) in its body or app:<name> as an option's preview. qorpera.questions() (questions in reads) then lists the open questions that point at this app, each {id, agent, title, body, options: [{label, value, description}], multiSelect, askedAt}. Draw them as part of the page: a choice between two concepts as a button on each concept, an approval as a button beside what is approved. On a click call qorpera.answer(id, value) with one option's value, or a list of values for a multiSelect question. Your run goes on with the answer, as when the member answers in the chat; a typed answer is given in the chat. table:<name>: a member changes a row of the company table QorperaOS/tables/<name>/, such as a status, a date, a number or a note. qorpera.setRow(table, key, cells) changes cells of the row with that key: key is the value of the table's key column (an object of column to value when the key is several columns), and cells is an object of column to new value: text, a number, true or false, or null to empty an optional cell. qorpera.addRow(table, cells) adds a row. One row per request, at most 12 cells of it, a cell's text at most 500 characters; the bar shows each value before and after. A page cannot change a key cell or a column that names a member or an agent, and cannot remove a row; the table's own [write] rule and column types still decide, and the table areas is never written from an app. Read the rows with qorpera.table(name) (tables in reads) and draw again after a change. To act when a member changes a row, set a routine that wakes you: manage_routine with a trigger of kind file_change and path QorperaOS/tables/<name>/rows.csv; without one you see the change the next time you read the table. Keep what members change in a table, and what only you change in a data file of the app.";

/**
 * What save_app's schema says of `files`: the base style every app's page starts from (RUNTIME-INTERFACE-APPS.md §2;
 * the web puts it into the page, packages/web/src/app/interface-app-style.ts), its variables, where the company's
 * colours come from, and how a page follows light and dark. On the field for the same reason as `reads`.
 */
const SAVE_APP_FILES =
	"The files to write, by their path in the app's folder. Each page starts from Qorpera's base style, which sits in a layer under your own CSS, so any rule you write wins over it: the system font, the text in a centred column at most 800 px wide (set body's margin yourself to use the whole width), and plain headings, links, tables and code. Its colours are CSS variables, and you use them in place of fixed colours: --q-bg the page, --q-text the text, --q-muted quiet text, --q-line rules and borders, --q-surface cards and panels, --q-accent the company's colour for links, marks and key figures, --q-on-accent text on the accent, --q-accent-soft a tint of it, and --q-good, --q-warn and --q-bad for states; --q-font and --q-mono are the type and --q-radius the corner. They hold the company's colours once QorperaOS/brand/brand.toml gives them, which the agent that owns the brand writes with company_write: accent, background and text, each as \"#rrggbb\", at the top for a light page and again under [dark] for a dark one. Text must read on its background (4.5 to 1) and the accent must show on it (3 to 1), or Qorpera's own colour is used instead. A page is shown light unless its head says it works in both, with <meta name=\"color-scheme\" content=\"light dark\">: then it follows the member's light or dark, so give it no fixed colours at all. The company's logo and other pictures are still copied into the app's folder, because a page cannot read QorperaOS/. A concept gets no base style.";

/**
 * What save_app's schema says of `kit`: how to make an explainer, a short narrated video in place of a page
 * (RUNTIME-INTERFACE-APPS.md §3a; Jonas, 10 November 2026). It is the whole of what an agent knows of the engine
 * (packages/runtime/kits/explainer/engine.js), so a name here that the engine lacks draws nothing: the kit's test holds
 * the two together. On the field for the same reason as `reads`.
 */
const SAVE_APP_KIT =
	'explainer makes the app a short narrated video in place of a page: 90 to 120 seconds that explain one mechanism, decision or idea with pictures that move, as a maths explainer does. Use it where motion explains better than a page: how money or data flows, why a number is what it is, what a choice costs. Not for the state of an area (that is a page) and not as a mock-up of a screen. You write one file, scenes.js; save_app writes engine.js and index.html beside it, so never write or edit those two. scenes.js adds chapters and scenes to the video V, which the page makes and starts: V.part("The idea"); V.scene((s) => { const a = s.box({x: 400, y: 450, w: 260, h: 100, label: "Shop", sub: "pays 149", color: C.blue}); const b = s.icon({name: "person", x: 1100, y: 450, color: C.yellow, label: "Ada"}); const ab = s.arrow(a, b, {color: C.yellow}); s.say("The shop pays Ada.", s.create(a), s.create(b), s.create(ab), s.flow(ab, 1.2, {count: 3})); }); A part is a chapter (4 to 6 in a video); a scene is one picture, and the stage clears between scenes. The stage is 1600 by 900: x and y are a thing\'s centre, y grows downwards. Things: s.box({x, y, w, h, label, sub, color, dash}); s.text({x, y, str, size, color, font: "sans" or "serif"}); s.number({x, y, from, size, fmt}), which s.value(n, to) counts; s.bar({x, y, w, h, dir: "up" or "right", scale}), which s.value(bar, to) grows; s.icon({name, x, y, label}) with name of person, bot, house, bus, card, coin, server, db, cloud, lock, doc, clock, shield, globe, mail, bolt; s.arrow(from, to, {color, bend, label}) between two things or points; s.line({d, head: false}) for any path. show: true on a thing makes it visible from the start: for the title frame only. s.say(caption, ...animations) is one caption and what moves under it, one after another: s.create(m) draws it, s.write(text), s.fadeIn(m), s.fadeOut(m), s.dim(m, 0.3), s.move(m, x, y), s.scale(m, k), s.indicate(m) glows, s.value(m, to), s.flow(arrow, seconds, {count}) sends dots along an arrow, s.camera(x, y, zoom). Each takes its seconds last; s.all(s.create, [a, b], 1) runs several together and {w: true} plays one with the one before it. Animate every thing: what you never animate just fades in. Colours come from C, one meaning each: yellow money, green what is kept or good, red loss, blue and teal things, purple partners, grey what is unknown. The captions are the narration: shown under the stage, and spoken word for word when the video has a voice. Write them for the ear: one idea and about 15 words a caption, short plain sentences, amounts as they are said (149 kroner, not NOK 149.00), no brackets and no symbols. 2 to 7 captions a scene, 25 to 35 in all. The stage shows and the caption tells: at most 12 words on the stage at once, and never a sentence in a box. A mechanism is motion: money flows along arrows, a total counts up or down, a part slides out of a whole, a bar grows past zero; never only boxes that appear. Keep 60 units free at every edge. Text sizes: 24 at least, 28 to 34 for labels, 44 to 60 for statements, 76 to 96 for the one number that matters. The first scene is the title frame: a small grey line, the title in two lines at size 70 to 80 and one small picture, all show: true, with the band around y 560 left free for the Play button. The last scene stays on screen at the end: make it a summary worth stopping on. Every number, name and claim comes from the company\'s files: never round a figure into a new one, and say assumed or example where the source does. Look before you show it, as for any app, and at more than the first frame: index.html?t=SECONDS opens the video paused at that second. Look at the end of each caption, at t=0 and at the last frame, at 1280 and at 390 px wide, and fix what overlaps, is cut off, stands empty or is too small to read. The answer\'s look names what a read of scenes.js found.';

/**
 * save_app's description, last: what makes a page worth opening (Jonas, 10 November 2026: the agents' apps "weren't all
 * that great visually"; six of the seven reviewed were one report template of text, drop-downs and dead links). A
 * concept or prototype of the product follows the product's own design (the company context), so these rules name
 * every other app. How to look at a page before showing it is in the company context, which has the room. Since the
 * web opens an app's links and gives every app a base style (RUNTIME-INTERFACE-APPS.md §2 and §4), it says which links
 * open and points to `files` for the style.
 */
const SAVE_APP_DESIGN =
	" How to make a page worth opening (a concept or prototype of the company's product follows the product's own design instead). The first screen answers how this stands, without scrolling, on a laptop and on a phone: what is decided, what is open, what waits on a member and the two or three numbers that matter, each as a short line, a large number or a mark, never a paragraph. Head it with the area's plain name: no date, no update, no list of what you did; give the app that name as its title too, two or three words without the company's name. Show instead of write: a large number for a key figure, a chart for money or a trend, a map for places and routes, a diagram for steps and flows, a real picture for a thing or a screen; draw charts, maps and diagrams as inline SVG. A page with nothing to look at is a document, not an app. Keep it to about 300 words and rarely more than two laptop screens: a few words or a mark in a table cell, and the long reasoning in its file, linked in one line. Say what is not yet known once, as a state, not as a caveat in every sentence. Show a fact in one app only, the one whose area owns it. Fold nothing a member needs into <details> or closed rows. Links open on a member's click: href app:<name> another app, folder:<path> a file of the company's own work, https://… a web page in a new tab, #id a place in the page; nothing else opens. Every app starts from Qorpera's base style, which your own CSS overrides: the system font, a readable column, plain headings and tables, and the company's colours as variables, so the apps look like one company; files says which, so use them, not colours of your own. Make it work at phone width (about 390 px): one column, tables that fit or stack into cards, nothing cut off, text at least 14 px. Draw what the company already holds from its live data instead of typing it in: reads says how. The answer's look names what a quick read of the saved page found: fix it, unless it does not fit this page.";

const sha256hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface AppFile {
	readonly path: string;
	readonly text: string;
}

interface ManifestInput {
	readonly name: string;
	readonly about: string | null;
	readonly emblem: AppManifest["emblem"] | null;
	readonly colour: AppManifest["colour"];
	readonly entry: string | null;
	readonly reads: AppManifest["reads"] | null;
	/** Null keeps what the app has (nothing for a new app). */
	readonly writes: AppManifest["writes"] | null;
	/** Null keeps what the app has (false for a new app). */
	readonly concept: boolean | null;
	readonly cover: string | null;
	/** Null keeps what the app has (no kit for a new app). */
	readonly kit: AppManifest["kit"];
}

interface SaveRequest {
	readonly name: string;
	readonly operationKey: string;
	readonly manifest: ManifestInput | null;
	readonly files: readonly AppFile[];
	/** A group of apps/groups.md the app is put in, last, when the file does not list it yet (APP-GROUPS-SPEC §3). */
	readonly group?: string;
}

/** Where save_app put the app in the drawer's layout. */
interface Grouped {
	readonly group: string;
	readonly placed: "added" | "already_listed";
}

/**
 * What save_app's schema says of `group` (APP-GROUPS-SPEC §3): the drawer's groups are organize_apps' work, and a new app
 * goes into one as it is made. On the field because the description holds 4096 bytes.
 */
const SAVE_APP_GROUP =
	"The id of a group of the apps drawer (organize_apps list shows them) to put this app in, last, as it is saved. Give it when you make an app that belongs to a group: to a product, a customer or a piece of work the drawer already groups. An app the layout already lists stays where it stands: organize_apps move moves it. Leave it out to leave the app loose. A group that does not exist is refused and nothing is saved; a concept never goes in a group, it shows inside Concepts.";

const text = (value: JsonValue | undefined, label: string, max: number, required: boolean): string | null => {
	if (value === undefined || value === null) {
		if (required) throw new CloudToolArgumentRefusal(`${label} is required`);
		return null;
	}
	if (typeof value !== "string" || /[\0-\x1f\x7f]/.test(value) || [...value.trim()].length > max)
		throw new CloudToolArgumentRefusal(`${label} must be one line of at most ${max} characters`);
	const trimmed = value.trim();
	if (required && trimmed.length === 0) throw new CloudToolArgumentRefusal(`${label} is required`);
	return trimmed.length === 0 ? null : trimmed;
};

function groupId(value: JsonValue): string {
	if (typeof value !== "string" || !isAppGroupId(value))
		throw new CloudToolArgumentRefusal("group must be a group's id from organize_apps list, such as trips");
	return value;
}

function appName(value: JsonValue | undefined): string {
	if (typeof value !== "string" || !isInterfaceName(value))
		throw new CloudToolArgumentRefusal(
			"name must be the app's folder name: lowercase a–z, digits and single hyphens, at most 64 characters, like sales-board",
		);
	return value;
}

function parseManifest(value: JsonValue | undefined): ManifestInput | null {
	if (value === null) return null;
	if (value === undefined || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("manifest must be an object, or null to keep the app's manifest as it is");
	const keys = ["title", "about", "emblem", "colour", "entry", "reads", "writes", "concept", "cover", "kit"];
	if (Object.keys(value).some((key) => !keys.includes(key)))
		throw new CloudToolArgumentRefusal(`manifest takes ${keys.join(", ")}`);
	const choice = <T extends string>(raw: JsonValue | undefined, label: string, options: readonly T[]): T | null => {
		if (raw === undefined || raw === null) return null;
		if (typeof raw !== "string" || !(options as readonly string[]).includes(raw))
			throw new CloudToolArgumentRefusal(`${label} must be one of ${options.join(", ")}`);
		return raw as T;
	};
	let entry: string | null = null;
	if (value.entry !== undefined && value.entry !== null) {
		const relative = typeof value.entry === "string" ? appRelativePath(value.entry) : null;
		if (relative === null || !["html", "htm"].includes(appFileKind(relative)))
			throw new CloudToolArgumentRefusal("manifest.entry must be a relative path to an .html file of the app");
		entry = relative;
	}
	let cover: string | null = null;
	if (value.cover !== undefined && value.cover !== null) {
		const relative = typeof value.cover === "string" ? appRelativePath(value.cover) : null;
		if (relative === null || !APP_COVER_KINDS.has(appFileKind(relative)))
			throw new CloudToolArgumentRefusal(
				"manifest.cover must be a relative path to a .png, .jpg or .webp picture of the app",
			);
		cover = relative;
	}
	if (value.concept !== undefined && value.concept !== null && typeof value.concept !== "boolean")
		throw new CloudToolArgumentRefusal("manifest.concept must be true or false");
	let reads: AppManifest["reads"] | null = null;
	if (value.reads !== undefined && value.reads !== null) {
		if (
			!Array.isArray(value.reads) ||
			value.reads.some((read) => typeof read !== "string" || !(APP_READS as readonly string[]).includes(read))
		)
			throw new CloudToolArgumentRefusal(`manifest.reads must be a list of ${APP_READS.join(", ")}`);
		reads = [...new Set(value.reads as AppManifest["reads"][number][])];
	}
	let writes: AppManifest["writes"] | null = null;
	if (value.writes !== undefined && value.writes !== null) {
		const parsed = parseAppWrites(value.writes);
		if ("problem" in parsed) throw new CloudToolArgumentRefusal(`manifest.${parsed.problem}`);
		writes = parsed.writes;
	}
	const kit = choice(value.kit, "manifest.kit", APP_KITS);
	if (kit !== null && entry !== null && entry !== APP_DEFAULT_ENTRY)
		throw new CloudToolArgumentRefusal(
			`manifest.entry: an app made from a kit opens ${APP_DEFAULT_ENTRY}; leave entry out`,
		);
	return {
		name: text(value.title, "manifest.title", 60, true) as string,
		about: text(value.about, "manifest.about", 200, false),
		emblem: choice(value.emblem, "manifest.emblem", INTERFACE_EMBLEMS),
		colour: choice(value.colour, "manifest.colour", AGENT_COLOURS),
		entry,
		reads,
		writes,
		concept: typeof value.concept === "boolean" ? value.concept : null,
		cover,
		kit,
	};
}

function parseFiles(value: JsonValue | undefined): AppFile[] {
	if (!Array.isArray(value) || value.length > FILES_PER_CALL)
		throw new CloudToolArgumentRefusal(`files must be a list of at most ${FILES_PER_CALL} {path, text}`);
	const seen = new Set<string>();
	return value.map((item) => {
		const file = args(item, "each file", ["path", "text"]);
		const relative = typeof file.path === "string" ? appRelativePath(file.path) : null;
		if (relative === null)
			throw new CloudToolArgumentRefusal(
				"a file's path must be relative to the app's folder, like index.html or js/app.js (no leading /, no ..)",
			);
		if (relative.toLowerCase() === APP_MANIFEST)
			throw new CloudToolArgumentRefusal("app.toml is written from manifest, not as a file");
		const kind = appFileKind(relative);
		if (!APP_TEXT_KINDS.has(kind))
			throw new CloudToolArgumentRefusal(
				`${relative}: an app's text files are ${[...APP_TEXT_KINDS].map((name) => `.${name}`).join(" ")}; put a picture in the folder with company_write's sibling tools or as an inline SVG or data: URL`,
			);
		if (typeof file.text !== "string" || Buffer.byteLength(file.text) > APP_FILE_MAX_BYTES)
			throw new CloudToolArgumentRefusal(
				`${relative}: text must be UTF-8 of at most ${APP_FILE_MAX_BYTES / 1024} KiB`,
			);
		const key = relative.toLowerCase();
		if (seen.has(key)) throw new CloudToolArgumentRefusal(`${relative} is listed twice`);
		seen.add(key);
		return { path: relative, text: file.text };
	});
}

/** The folders a set of relative file paths needs, parents first. */
function foldersOf(paths: readonly string[]): string[] {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
	}
	return [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** The files a kit writes itself, which an agent's call may not name. */
const KIT_FILES: Readonly<Record<NonNullable<AppManifest["kit"]>, readonly string[]>> = {
	explainer: [EXPLAINER_ENGINE, EXPLAINER_PAGE],
};

/** Refuses a call that writes a file of the app's kit: the kit's files are Qorpera's, the same in every such app. */
function refuseKitFiles(kit: NonNullable<AppManifest["kit"]>, files: readonly AppFile[]): void {
	const own = files.find((file) => KIT_FILES[kit].includes(file.path.toLowerCase()));
	if (own)
		throw new CloudToolRefusal(
			`APP_KIT_FILE: ${own.path} is the ${kit} kit's own file, which save_app writes; leave it out and give ${EXPLAINER_SCENES}`,
		);
}

const contentOf = (path: string, text: string) => ({
	text,
	mediaType: APP_FILE_TYPES[appFileKind(path)] ?? "text/plain",
});

/** A page past this many words a member would read is a document. */
const LOOK_WORDS = 500;
/** A page of more words than this with nothing to look at gets a note. */
const LOOK_WORDS_UNSHOWN = 150;
/** This many folded sections hide what the page is for. */
const LOOK_FOLDED = 3;

/** `text` without each block from `open` to `close` (to the end when one is never closed), in one pass. */
function withoutBlocks(text: string, open: RegExp, close: RegExp): string {
	let out = "";
	let at = 0;
	for (;;) {
		open.lastIndex = at;
		const from = open.exec(text);
		if (from === null) return out + text.slice(at);
		out += `${text.slice(at, from.index)} `;
		close.lastIndex = from.index + from[0].length;
		const to = close.exec(text);
		if (to === null) return out;
		at = to.index + to[0].length;
	}
}

/**
 * Whether a link in an app's page opens when a member clicks it, by the form of its address: a quick mirror of the
 * web's check (packages/web/src/app/interface-apps.ts `appLink`), which is the one that decides. A jump inside the page
 * is the page's own. A `javascript:` address opens nothing: the browser runs none in an app's frame.
 */
function linkOpens(href: string): boolean {
	if (href.startsWith("#") || /^https?:/i.test(href) || appLinkName(href) !== undefined) return true;
	if (!href.startsWith("folder:")) return false;
	try {
		const top = companyPathKey(decodeURIComponent(href.slice("folder:".length))).split("/")[0] ?? "";
		return top !== "" && !APP_CLOSED_FOLDERS.includes(top);
	} catch {
		return false;
	}
}

/**
 * What a quick read of an app's entry page finds, told to the agent after a save: advice, never a refusal (Jonas,
 * 10 November 2026, on a company whose seven agent-made apps held 68 links that open nothing, 36 folded sections and
 * about 6,000 words, and six of them no picture, chart or diagram). It reads the page's text alone, so a replayed save
 * answers the same notes, and in one pass over the page, whatever an agent wrote into it:
 * - links that open nothing: the web opens an `app:`, `folder:` or web link when a member clicks it (`linkOpens`), and
 *   nothing else; a jump inside the page (`#`) is the page's own;
 * - folded sections (`<details>`), which hide what a member came to see;
 * - the words a member would read, outside scripts and styles;
 * - a page of text with nothing to look at: no picture, drawing, canvas or video, in the markup or made by a script.
 * How the page looks stays the agent's to check, on a machine (save_app's description).
 */
export function appLookNotes(html: string): string[] {
	const page = withoutBlocks(html, /<!--/g, /-->/g);
	const markup = withoutBlocks(withoutBlocks(page, /<script\b/gi, /<\/script\s*>/gi), /<style\b/gi, /<\/style\s*>/gi);
	let read = "";
	const dead: string[] = [];
	let folded = 0;
	let at = 0;
	for (;;) {
		const from = markup.indexOf("<", at);
		const to = from < 0 ? -1 : markup.indexOf(">", from);
		if (to < 0) break;
		read += `${markup.slice(at, from)} `;
		const tag = markup.slice(from + 1, to);
		if (/^details\b/i.test(tag)) folded++;
		const href = /^a\s/i.test(tag) ? /\shref\s*=\s*["']?\s*([^"'\s]*)/i.exec(tag) : null;
		if (href?.[1] && !linkOpens(href[1])) dead.push(href[1].length > 80 ? `${href[1].slice(0, 80)}…` : href[1]);
		at = to + 1;
	}
	read += markup.slice(at);
	const words = read
		.replace(/&[a-z0-9#]+;/gi, " ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
	const shown = /<(?:img|svg|canvas|video|picture)\b|createElementNS|getContext\(|url\(/i.test(page);
	const notes: string[] = [];
	if (dead.length > 0)
		notes.push(
			`${dead.length} ${dead.length === 1 ? "link opens" : "links open"} nothing (${dead.slice(0, 3).join(", ")}${dead.length > 3 ? ", …" : ""}): a link opens another app (app:<name>), a file of the company's own work (folder:<path>, never under QorperaOS/), a web page (https://…) or a place in the page (#id). For anything else, such as a tab, use a button with a click handler.`,
		);
	if (folded >= LOOK_FOLDED)
		notes.push(
			`${folded} folded sections (<details>): a member sees only what is open. Show what matters and leave the rest out.`,
		);
	if (words > LOOK_WORDS)
		notes.push(
			`${words} words: this reads as a document. Aim at about 300: show the state as numbers, marks, a chart or a diagram, and keep the long reasoning in its file.`,
		);
	if (!shown && words > LOOK_WORDS_UNSHOWN)
		notes.push("Nothing to look at, only text: show the main thing as a picture, a chart, a map or a diagram.");
	return notes;
}

/** What a quick read of what a call wrote finds: of an explainer its scenes, of any other app its entry page; nothing
 * when the call wrote neither. */
function lookNotes(files: readonly AppFile[], kit: AppManifest["kit"], entry: string): string[] {
	const path = kit === "explainer" ? EXPLAINER_SCENES : entry.toLowerCase();
	const written = files.find((file) => file.path.toLowerCase() === path)?.text;
	if (written === undefined) return [];
	return kit === "explainer" ? explainerNotes(written) : appLookNotes(written);
}

/** What the model is told after a commit, by each unit's outcome. `notes` is what a quick read of what this call
 * wrote found (`lookNotes`). */
function savedText(
	request: { name: string; operationKey: string },
	receiptId: string,
	units: readonly CloudCompanyFolderUnitResult[],
	created: boolean,
	notes: readonly string[],
	grouped: Grouped | null,
): string {
	const saved = units.filter((unit) => unit.outcome === "saved").length;
	const state = saved === units.length ? "applied" : saved === 0 ? "not_applied" : "partly_applied";
	const conflict = units.some((unit) => unit.outcome === "conflict");
	const look = state === "applied" ? notes : [];
	return cloudToolJsonText({
		schema: "qorpera.app-save/v1",
		state,
		app: request.name,
		operationKey: request.operationKey,
		receiptId,
		created,
		link: `app:${request.name}`,
		files: units.map((unit) => ({
			path: unit.path,
			outcome: unit.outcome,
			...(unit.version ? { version: unit.version } : {}),
			...(unit.reason ? { reason: unit.reason } : {}),
			...(unit.problems.length > 0 ? { problems: unit.problems.map((problem) => problem.message) } : {}),
		})),
		...(look.length > 0 ? { look } : {}),
		...(grouped
			? {
					group: grouped.group,
					groupPlaced:
						grouped.placed === "added"
							? "last in the group"
							: "not moved: the drawer's layout already lists it; organize_apps move moves it",
				}
			: {}),
		next:
			state === "applied"
				? `Saved. ${look.length > 0 ? "First fix what look names, unless it does not fit this page. Then show" : "Show"} it to the member with a link in your message: [${request.name}](app:${request.name}). post_app shows it to every member in their apps.`
				: conflict
					? "Some files changed while this call saved them: read the app's files again, then call again with a new operationKey."
					: "Some files were not saved (their reasons): fix them and call again with a new operationKey.",
	});
}

/** The two interface app tools of a folder-v2 run. `operations` takes the receipts of their changes. */
export function cloudAppTools(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
}): CloudNativeTool[] {
	const { folder, operations, identity } = options;
	const owner = identity.staffAgentId.toLowerCase();
	const read = async (path: string, signal: AbortSignal): Promise<CloudCompanyFolderEntry | null> => {
		try {
			return (await folder.read(path, signal)).entry;
		} catch (error) {
			return unavailable(error, "saved");
		}
	};
	const manifestText = async (path: string, signal: AbortSignal) => {
		try {
			return await folder.readText(path, APP_MANIFEST_MAX_BYTES, signal);
		} catch (error) {
			if (error instanceof CloudCompanyPathNotText) return "unreadable" as const;
			return unavailable(error, "saved");
		}
	};
	// A commit no one can complete would fence this run's later operations: refuse before writing anything.
	const writable = () => {
		if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
	};
	const commit = async (
		tool: "save_app" | "post_app",
		request: { name: string; operationKey: string },
		argumentsDigest: Record<string, JsonValue>,
		units: readonly CloudCompanyFolderUnit[],
		answer: (receiptId: string, units: readonly CloudCompanyFolderUnitResult[]) => string,
		context: CloudToolContext,
	) => {
		const content = await operations.execute({
			operation: {
				tool,
				toolVersion: TOOL_VERSION,
				logicalOperationKey: request.operationKey,
				arguments: argumentsDigest,
				target: { path: appFolder(request.name) as string },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			refused: cloudFolderRefusal,
			perform: async (_operation, { receiptId, signal }) => {
				const key = `${tool}:${sha256hex(request.operationKey)}`;
				const committed = await folder.commit(key, units, { receiptId }, signal);
				if (committed.units.length !== units.length) throw new Error("Company folder commit answered other units");
				return {
					content: { kind: "text", value: answer(receiptId, committed.units) },
					folderCommitId: committed.commitId,
					...(committed.units.some((unit) => unit.outcome === "waiting_for_review")
						? { proposed: true as const }
						: {}),
				};
			},
			signal: context.signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		if (content.kind !== "text") throw new Error("An app change answered no text");
		return content.value;
	};
	// After the receipt the change is made or settled, so an answer that cannot be released is unconfirmed, never a
	// refusal (which says nothing happened): the model repeats the same call, and its replay answers.
	const showCommitted = async (
		context: CloudToolContext,
		value: string,
		reads: readonly CloudCompanyFolderEntry[],
	) => {
		try {
			return await released(folder, identity.runId, context, value, reads.map(cloudCompanyFolderRelease));
		} catch (error) {
			if (error instanceof CloudToolRefusal)
				throw new Error("A committed answer could not be released", { cause: error });
			throw error;
		}
	};

	const saveApp: CloudNativeTool = {
		name: "save_app" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		maxArgumentBytes: MAX_TOOL_ARGUMENT_BYTES,
		description: `Make or change an interface app: a small web page in apps/<name>/ of the company folder that shows members a part of the company as it stands now (the state of an area, results, a prototype, a dashboard), opened as a page of its own. Give the app's name (its folder: lowercase, digits and hyphens), a manifest (title, and optionally about, emblem: ${INTERFACE_EMBLEMS.join(", ")}, colour: ${AGENT_COLOURS.join(", ")}, entry: the page that opens, default ${APP_DEFAULT_ENTRY}, reads: the live sources the page may read, of ${APP_READS.join(", ")}, writes: what it may ask a member to change, kit: explainer for a short narrated video) to make it or change its manifest, or null to keep it, and the files to write (at most ${FILES_PER_CALL} a call: .html, .css, .js, .json, .svg, .md, .csv, .txt, each at most ${APP_FILE_MAX_BYTES / 1024} KiB). Pictures (.png, .jpg, .webp, .gif) and videos (.mp4, .webm) you write into the app's folder from a company machine may be up to ${APP_VIDEO_FILE_MAX_BYTES / 1024 / 1024} MiB each and ${APP_VIDEOS_MAX_BYTES / 1024 / 1024} MiB in all; pages and code up to ${APP_MAX_BYTES / 1024 / 1024} MiB in all. The app is one page: only the entry opens, so links to its other .html files do not work; put every view in the entry, as tabs or sections. The page gets its pictures and videos only where it names them when it opens (<img src>, <video src>, a poster, or url() in its styles): a script cannot load a picture or video later, so put every picture it may show in the page (hidden ones too) and switch them with styles or a script; a script reads text files with qorpera.read(path). The entry may use the app's other files by relative paths (<link rel="stylesheet" href="style.css">, <script src="app.js">, <img src="chart.svg">); the page has no network, so put everything it needs in the app. A new app needs a manifest and its entry. It applies at once. Then link it in your message as [Title](app:<name>). Set concept = true for a concept of the company's product, and cover = a picture of it, so it shows in the Concepts viewer. Keep operationKey for the same change, and use a new one for any other change.${SAVE_APP_DESIGN}`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "operationKey", "manifest", "files"],
			properties: {
				name: { type: "string", maxLength: 64 },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				manifest: {
					type: ["object", "null"],
					additionalProperties: false,
					required: ["title"],
					properties: {
						title: { type: "string", maxLength: 60 },
						about: { type: ["string", "null"], maxLength: 200 },
						emblem: { type: ["string", "null"], enum: [...INTERFACE_EMBLEMS, null] },
						colour: { type: ["string", "null"], enum: [...AGENT_COLOURS, null] },
						entry: { type: ["string", "null"], maxLength: 1024 },
						reads: {
							type: ["array", "null"],
							items: { type: "string", enum: [...APP_READS] },
							description: SAVE_APP_READS,
						},
						writes: {
							type: ["array", "null"],
							maxItems: APP_WRITES_MAX,
							items: { type: "string", maxLength: 80 },
							description: SAVE_APP_WRITES,
						},
						concept: { type: ["boolean", "null"] },
						cover: { type: ["string", "null"], maxLength: 1024 },
						kit: { type: ["string", "null"], enum: [...APP_KITS, null], description: SAVE_APP_KIT },
					},
				},
				group: { type: "string", maxLength: 46, description: SAVE_APP_GROUP },
				files: {
					type: "array",
					maxItems: FILES_PER_CALL,
					description: SAVE_APP_FILES,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["path", "text"],
						properties: {
							path: { type: "string", maxLength: 1024 },
							text: { type: "string", maxLength: APP_FILE_MAX_BYTES },
						},
					},
				},
			},
		},
		parseArguments(value) {
			// group is the one field a call may leave out.
			const given = value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
			const { group, ...rest } = given ?? {};
			const input = args(given === null ? value : rest, "save_app", ["name", "operationKey", "manifest", "files"]);
			const request: SaveRequest = {
				name: appName(input.name),
				operationKey: operationKey(input.operationKey),
				manifest: parseManifest(input.manifest),
				files: parseFiles(input.files),
				...(group === undefined || group === null ? {} : { group: groupId(group) }),
			};
			if (request.manifest === null && request.files.length === 0)
				throw new CloudToolArgumentRefusal("give a manifest, files, or both");
			return request as unknown as JsonValue;
		},
		// Another agent's app, or a member's, is changed only after the automatic review (review r2, H-1): the panel names
		// its owner to members. Read before the review, so its effect class is the one that runs.
		async prepare(value, context) {
			const request = value as unknown as SaveRequest;
			const stored = await manifestText(`${appFolder(request.name)}/${APP_MANIFEST}`, context.signal);
			const parsed = stored !== null && stored !== "unreadable" ? parseAppManifest(stored.text) : null;
			const foreign = parsed?.ok === true && parsed.manifest.owner !== owner;
			return foreign ? ({ ...request, foreignOwner: true } as unknown as JsonValue) : value;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as unknown as SaveRequest;
			writable();
			context.observation?.update({
				inputBytes: request.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
			});
			const root = appFolder(request.name) as string;
			const reads: CloudCompanyFolderEntry[] = [];
			const at = await read(root, context.signal);
			if (at !== null && at.kind !== "folder")
				throw new CloudToolRefusal(
					`APP_NOT_A_FOLDER: ${root} is a ${at.kind === "file" ? "file" : "link"}, not an app's folder`,
				);
			const digest: Record<string, JsonValue> = {
				name: request.name,
				manifestSha256: sha256hex(JSON.stringify(request.manifest)),
				files: request.files.map((file) => ({ path: file.path, textSha256: sha256hex(file.text) })),
				...(request.group ? { group: request.group } : {}),
			};
			// The app's place in the drawer's layout, read and checked before anything is written; its unit goes in the
			// same commit as the app's own.
			const place = async (concept: boolean): Promise<Grouped | null> => {
				if (!request.group) return null;
				if (concept)
					throw new CloudToolRefusal(
						"APP_GROUP_CONCEPT: a concept shows inside Concepts in the drawer, never in a group; leave group out",
					);
				const placed = await placeAppInGroup(folder, request.name, request.group, context.signal);
				reads.push(placed.read);
				if (placed.unit) groupUnits.push(placed.unit);
				return { group: request.group, placed: placed.placed };
			};
			const groupUnits: CloudCompanyFolderUnit[] = [];
			if (at === null) {
				// A new app: its whole folder in one unit, the apps folder with it when the company has none yet.
				if (request.manifest === null)
					throw new CloudToolRefusal("APP_NOT_FOUND: no app has that name; give a manifest to make it");
				const manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? "page",
					colour: request.manifest.colour,
					entry: request.manifest.entry ?? APP_DEFAULT_ENTRY,
					owner,
					posted: false,
					reads: request.manifest.reads ?? [],
					writes: request.manifest.writes ?? [],
					concept: request.manifest.concept ?? false,
					cover: request.manifest.cover,
					kit: request.manifest.kit,
				};
				// A kit's own files go in with the agent's: for an explainer the engine and the page, around its scenes.
				let files = request.files;
				if (manifest.kit === "explainer") {
					refuseKitFiles(manifest.kit, files);
					if (!files.some((file) => file.path.toLowerCase() === EXPLAINER_SCENES))
						throw new CloudToolRefusal(
							`APP_SCENES_MISSING: a new explainer needs its ${EXPLAINER_SCENES} among files`,
						);
					files = [
						...files,
						{ path: EXPLAINER_ENGINE, text: EXPLAINER_ENGINE_JS },
						{ path: EXPLAINER_PAGE, text: explainerPage(manifest.name, []) },
					];
				}
				if (!files.some((file) => file.path.toLowerCase() === manifest.entry.toLowerCase()))
					throw new CloudToolRefusal(
						`APP_ENTRY_MISSING: a new app needs its entry, ${manifest.entry}, among files`,
					);
				const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
				if (files.length + 1 > APP_MAX_FILES || total > APP_MAX_BYTES)
					throw new CloudToolRefusal(
						`APP_TOO_LARGE: an app holds at most ${APP_MAX_FILES} files and ${APP_MAX_BYTES / 1024 / 1024} MiB in all`,
					);
				const contents: CloudCompanyFolderNewEntry[] = [
					{
						path: APP_MANIFEST,
						kind: "file",
						content: { text: writeAppManifest(manifest), mediaType: "application/toml" },
					},
					...foldersOf(files.map((file) => file.path)).map((path) => ({ path, kind: "folder" as const })),
					...files.map((file) => ({
						path: file.path,
						kind: "file" as const,
						content: contentOf(file.path, file.text),
					})),
				];
				const apps = await read("apps", context.signal);
				if (apps !== null) reads.push(apps);
				if (apps !== null && apps.kind !== "folder")
					throw new CloudToolRefusal("APP_NOT_A_FOLDER: apps is not a folder, so no app can be made");
				const unit: CloudCompanyFolderUnit =
					apps === null
						? {
								op: "new_folder",
								path: "apps",
								contents: [
									{ path: request.name, kind: "folder" },
									...contents.map((entry) => ({ ...entry, path: `${request.name}/${entry.path}` })),
								],
							}
						: { op: "new_folder", path: root, contents };
				const grouped = await place(manifest.concept);
				const answer = await commit(
					"save_app",
					request,
					digest,
					[unit, ...groupUnits],
					(receiptId, units) =>
						savedText(
							request,
							receiptId,
							units,
							true,
							lookNotes(request.files, manifest.kit, manifest.entry),
							grouped,
						),
					context,
				);
				return showCommitted(context, answer, reads);
			}
			reads.push(at);
			// A change: the manifest kept or rewritten with its owner and posted as stored, and each file written over the
			// version read now (a file another call changed in between is a conflict).
			const manifestPath = `${root}/${APP_MANIFEST}`;
			const stored = await manifestText(manifestPath, context.signal);
			const units: CloudCompanyFolderUnit[] = [];
			let entry = APP_DEFAULT_ENTRY;
			if (stored !== null && stored !== "unreadable") reads.push(stored.entry);
			const storedParse = stored !== null && stored !== "unreadable" ? parseAppManifest(stored.text) : null;
			const before = storedParse?.ok ? storedParse.manifest : null;
			// The kit and the title the app has after this call: the kit's page is written from them below.
			let kit = before?.kit ?? null;
			let title = before?.name ?? request.name;
			let concept = before?.concept ?? false;
			if (request.manifest !== null) {
				const manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? before?.emblem ?? "page",
					colour: request.manifest.colour ?? before?.colour ?? null,
					entry: request.manifest.entry ?? before?.entry ?? APP_DEFAULT_ENTRY,
					owner: before?.owner ?? owner,
					posted: before?.posted ?? false,
					reads: request.manifest.reads ?? before?.reads ?? [],
					writes: request.manifest.writes ?? before?.writes ?? [],
					concept: request.manifest.concept ?? before?.concept ?? false,
					cover: request.manifest.cover ?? before?.cover ?? null,
					kit: request.manifest.kit ?? before?.kit ?? null,
				};
				if (manifest.kit !== null && manifest.entry !== APP_DEFAULT_ENTRY)
					throw new CloudToolRefusal(
						`APP_KIT_ENTRY: an app made from a kit opens ${APP_DEFAULT_ENTRY}; give manifest.entry ${APP_DEFAULT_ENTRY}`,
					);
				entry = manifest.entry;
				kit = manifest.kit;
				title = manifest.name;
				concept = manifest.concept;
				const textOut = writeAppManifest(manifest);
				if (stored === "unreadable")
					throw new CloudToolRefusal(
						`APP_MANIFEST_UNREADABLE: ${manifestPath} is not text; replace it on the company's computer`,
					);
				units.push(
					stored === null
						? { op: "write", path: manifestPath, content: { text: textOut, mediaType: "application/toml" } }
						: {
								op: "write",
								path: manifestPath,
								content: { text: textOut, mediaType: stored.entry.file.mediaType },
								expectedVersion: stored.entry.version,
							},
				);
			} else if (storedParse?.ok) entry = storedParse.manifest.entry;
			else
				throw new CloudToolRefusal(
					`APP_MANIFEST_INVALID: ${manifestPath} is missing or has problems; give a manifest to write it again`,
				);
			// The app's totals, with this call's files in place of the ones they replace.
			const listed = await folder
				.list(root, { recursive: true, limit: LIST_LIMIT }, context.signal)
				.catch((error) => unavailable(error, "saved"));
			reads.push(...listed.entries);
			const byKey = new Map(listed.entries.map((item) => [item.path.slice(root.length + 1).toLowerCase(), item]));
			// A kit's own files, written where the folder holds none or other text: the engine of this runtime, and the
			// page with the title as it is now and the voice clips the folder holds. A save of scenes.js alone leaves
			// them as they are.
			let files = request.files;
			if (kit === "explainer") {
				refuseKitFiles(kit, files);
				const given = (path: string) => files.find((file) => file.path.toLowerCase() === path)?.text;
				if (byKey.get(EXPLAINER_SCENES)?.kind !== "file" && given(EXPLAINER_SCENES) === undefined)
					throw new CloudToolRefusal(
						`APP_SCENES_MISSING: the explainer's ${EXPLAINER_SCENES} is not in its folder; write it among files`,
					);
				let listedClips = given(EXPLAINER_CLIPS) ?? null;
				if (listedClips === null && byKey.get(EXPLAINER_CLIPS)?.kind === "file")
					listedClips = await folder
						.readText(`${root}/${EXPLAINER_CLIPS}`, EXPLAINER_CLIPS_MAX_BYTES, context.signal)
						.then(
							(found) => found?.text ?? null,
							(error) => (error instanceof CloudCompanyPathNotText ? null : unavailable(error, "saved")),
						);
				const clips = (listedClips === null ? [] : parseExplainerClips(listedClips)).filter(
					(clip) => byKey.get(`voice/${clip.file}`)?.kind === "file",
				);
				for (const file of [
					{ path: EXPLAINER_ENGINE, text: EXPLAINER_ENGINE_JS },
					{ path: EXPLAINER_PAGE, text: explainerPage(title, clips) },
				]) {
					const found = byKey.get(file.path);
					if (found?.kind !== "file" || found.file.fileSha256 !== sha256hex(file.text)) files = [...files, file];
				}
			}
			const sizes = new Map<string, number>();
			for (const item of listed.entries)
				if (item.kind === "file" && APP_FILE_TYPES[appFileKind(item.path)])
					sizes.set(item.path.slice(root.length + 1).toLowerCase(), item.file.bytes);
			for (const file of files) sizes.set(file.path.toLowerCase(), Buffer.byteLength(file.text));
			// A picture or video counts as a file, and toward the pictures' and videos' own bound, which the page's reader
			// holds it to; every file to its own bound, since the page's reader shows no app with one past it (7 November
			// 2026: a machine wrote 10 MB pages into an app that then never opened).
			const media = (path: string) => APP_MEDIA_KINDS.has(appFileKind(path));
			const total = [...sizes].reduce((sum, [path, bytes]) => (media(path) ? sum : sum + bytes), 0);
			const mediaTotal = [...sizes].reduce((sum, [path, bytes]) => (media(path) ? sum + bytes : sum), 0);
			if (
				listed.next !== null ||
				sizes.size > APP_MAX_FILES ||
				total > APP_MAX_BYTES ||
				mediaTotal > APP_VIDEOS_MAX_BYTES
			)
				throw new CloudToolRefusal(
					`APP_TOO_LARGE: an app holds at most ${APP_MAX_FILES} files, ${APP_MAX_BYTES / 1024 / 1024} MiB of pages and code, and ${APP_VIDEOS_MAX_BYTES / 1024 / 1024} MiB of pictures and videos; remove files with company_delete first`,
				);
			const over = [...sizes].find(([path, bytes]) =>
				media(path) ? bytes > APP_VIDEO_FILE_MAX_BYTES : bytes > APP_FILE_MAX_BYTES,
			);
			if (over)
				throw new CloudToolRefusal(
					`APP_FILE_TOO_LARGE: ${over[0]} is ${Math.ceil(over[1] / 1024)} KiB; a page or code file loads at most ${APP_FILE_MAX_BYTES / 1024} KiB and a picture or video at most ${APP_VIDEO_FILE_MAX_BYTES / 1024 / 1024} MiB, so the app would not open. Put pictures in their own files, not inside a page, and make it smaller or remove it with company_delete`,
				);
			for (const folderPath of foldersOf(files.map((file) => file.path))) {
				const found = byKey.get(folderPath.toLowerCase());
				if (found === undefined) units.push({ op: "mkdir", path: `${root}/${folderPath}` });
				else if (found.kind !== "folder")
					throw new CloudToolRefusal(`APP_NOT_A_FOLDER: ${root}/${folderPath} is a file, not a folder`);
			}
			for (const file of files) {
				const found = byKey.get(file.path.toLowerCase());
				if (found !== undefined && found.kind !== "file")
					throw new CloudToolRefusal(`APP_NOT_A_FILE: ${root}/${file.path} is a folder or a link`);
				units.push(
					found === undefined
						? { op: "write", path: `${root}/${file.path}`, content: contentOf(file.path, file.text) }
						: {
								op: "write",
								path: found.path,
								content: {
									text: file.text,
									mediaType: found.file.mediaType,
									executable: found.file.executable,
								},
								expectedVersion: found.version,
							},
				);
			}
			if (!byKey.has(entry.toLowerCase()) && !files.some((file) => file.path.toLowerCase() === entry.toLowerCase()))
				throw new CloudToolRefusal(
					`APP_ENTRY_MISSING: the app's entry, ${entry}, is not in its folder; write it among files`,
				);
			const grouped = await place(concept);
			const answer = await commit(
				"save_app",
				request,
				digest,
				[...units, ...groupUnits],
				(receiptId, results) =>
					savedText(request, receiptId, results, false, lookNotes(request.files, kit, entry), grouped),
				context,
			);
			return showCommitted(context, answer, reads);
		},
	};

	const postApp: CloudNativeTool = {
		name: "post_app" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description:
			"Post an interface app so every member of the company sees it in their apps (posted true), or take it away (posted false). The app stays in the company folder either way, and a link to it in a message still opens it. Post what members should keep coming back to: the state of an area, a dashboard, a board, a living plan. Keep operationKey for the same change, and use a new one for any other change.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "operationKey", "posted"],
			properties: {
				name: { type: "string", maxLength: 64 },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				posted: { type: "boolean" },
			},
		},
		parseArguments(value) {
			const input = args(value, "post_app", ["name", "operationKey", "posted"]);
			if (typeof input.posted !== "boolean") throw new CloudToolArgumentRefusal("posted must be true or false");
			return { name: appName(input.name), operationKey: operationKey(input.operationKey), posted: input.posted };
		},
		// Its own app posts at once; another agent's or a member's goes through the automatic review. Read before the
		// review, so its effect class is the one that runs, and bound to that read: the post writes only the manifest
		// version read here, so an app made or changed in between is refused, never posted under the wrong class.
		async prepare(value, context) {
			const request = value as unknown as { name: string };
			const stored = await manifestText(`${appFolder(request.name)}/${APP_MANIFEST}`, context.signal);
			const parsed = stored !== null && stored !== "unreadable" ? parseAppManifest(stored.text) : null;
			// A manifest that cannot be read or does not parse names no owner: it is reviewed as another's.
			const foreign = parsed === null ? stored === "unreadable" : !parsed.ok || parsed.manifest.owner !== owner;
			return {
				...(value as Record<string, JsonValue>),
				checkedVersion: stored !== null && stored !== "unreadable" ? stored.entry.version : null,
				...(foreign ? { foreignOwner: true } : {}),
			} as JsonValue;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as {
				name: string;
				operationKey: string;
				posted: boolean;
				checkedVersion?: string | null;
			};
			writable();
			const path = `${appFolder(request.name)}/${APP_MANIFEST}`;
			const stored = await manifestText(path, context.signal);
			// The review judged the manifest read in prepare: one made or changed since is not the one it judged.
			if (
				request.checkedVersion !== undefined &&
				(stored === null || stored === "unreadable" ? null : stored.entry.version) !== request.checkedVersion
			)
				throw new CloudToolRefusal("APP_CHANGED: the app changed while this post was checked; post it again");
			if (stored === null) throw new CloudToolRefusal("APP_NOT_FOUND: no app has that name; make it with save_app");
			if (stored === "unreadable")
				throw new CloudToolRefusal(`APP_MANIFEST_UNREADABLE: ${path} is not text; replace it with save_app`);
			const parsed = parseAppManifest(stored.text);
			const show = (answer: Record<string, JsonValue>) =>
				released(
					folder,
					identity.runId,
					context,
					cloudToolJsonText({
						schema: "qorpera.app-post/v1",
						app: request.name,
						operationKey: request.operationKey,
						...answer,
					}),
					[cloudCompanyFolderRelease(stored.entry)],
				);
			if (!parsed.ok)
				return show({
					state: "not_applied",
					reason: "invalid",
					problems: parsed.problems.map((problem) => problem.message),
					next: "The app's manifest has problems: fix it with save_app, then post it.",
				});
			if (parsed.manifest.posted === request.posted)
				return show({
					state: "unchanged",
					posted: request.posted,
					next: request.posted ? "It is already posted." : "It is not posted.",
				});
			const next = setAppPosted(stored.text, request.posted);
			if (next === null) throw new Error("A manifest that parses could not be posted");
			const answer = await commit(
				"post_app",
				request,
				{ name: request.name, posted: request.posted },
				[
					{
						op: "write",
						path: stored.entry.path,
						content: { text: next, mediaType: stored.entry.file.mediaType },
						expectedVersion: stored.entry.version,
					},
				],
				(receiptId, units) => {
					const unit = units[0];
					const saved = unit?.outcome === "saved";
					return cloudToolJsonText({
						schema: "qorpera.app-post/v1",
						app: request.name,
						operationKey: request.operationKey,
						receiptId,
						state: saved ? "applied" : unit?.outcome === "waiting_for_review" ? "proposed" : "not_applied",
						posted: saved ? request.posted : parsed.manifest.posted,
						outcome: unit?.outcome ?? "refused",
						...(unit?.reason ? { reason: unit.reason } : {}),
						next: saved
							? request.posted
								? "Posted: every member sees it in their apps."
								: "Taken away from the members' apps."
							: unit?.outcome === "conflict"
								? "The manifest changed while this call wrote it: call again with a new operationKey."
								: "Nothing was posted: tell the member.",
					});
				},
				context,
			);
			return showCommitted(context, answer, [stored.entry]);
		},
	};

	return [saveApp, postApp];
}
