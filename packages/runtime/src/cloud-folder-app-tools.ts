/*
 * The interface app tools of a folder-v2 run (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3; Jonas, 5 November 2026):
 * an agent makes a small web page, kept as files in `apps/<name>/` of the Company File, to show members a part of the
 * company as it stands, and members open it as a page of its own.
 * - `save_app` creates an app (its folder, its `app.toml` and its files) or changes its manifest and files, in one
 *   change set under the call's receipt. It applies at once (review class internal): the files are the agent's own work.
 *   It checks the name, the manifest, each file's kind and size and the app's totals before anything is written; it
 *   sets `owner` and `posted = false` on a new app and never changes either after.
 *   Its answer carries `look`: what a quick read of the saved entry page found (`appLookNotes`), as advice.
 * - `post_app` sets `posted`, which shows the app in every member's apps drawer or takes it away: delegation, which the
 *   automatic review sees (cloud-action-review.ts). It rewrites that one line of `app.toml`, every other byte as written.
 * `company_write` and `company_edit` check an `app.toml` the same way and refuse a change of `posted`
 * (cloud-folder-file-tools.ts, `appManifestCheck`).
 */

import { createHash } from "node:crypto";
import { AGENT_COLOURS } from "@qorpera/cloud-client/company-state-shared";
import {
	APP_COVER_KINDS,
	APP_DEFAULT_ENTRY,
	APP_FILE_MAX_BYTES,
	APP_FILE_TYPES,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_MAX_BYTES,
	APP_MAX_FILES,
	APP_MEDIA_KINDS,
	APP_READS,
	APP_TEXT_KINDS,
	APP_VIDEO_FILE_MAX_BYTES,
	APP_VIDEOS_MAX_BYTES,
	type AppManifest,
	appFileKind,
	appFolder,
	appRelativePath,
	parseAppManifest,
	setAppPosted,
	writeAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { INTERFACE_EMBLEMS, isInterfaceName } from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderNewEntry,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
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
	"The live sources the page may read. The page's script reads the company through the qorpera object, and every call returns a promise. qorpera.read(path) gives a file's text and qorpera.list(folder) a folder's entries (name, path, kind, bytes, updatedAt), both by company path, such as apps/<name>/state.json: the app's own folder always, any other company path only with files in reads. qorpera.table(name) gives {name, columns, rows}, each row an object by column name (tables in reads). qorpera.todos() gives every agent's todos as {agent, title, status, updatedAt}, with status open, blocked, done or cancelled (todos in reads). qorpera.agents() gives each agent's name, role and working, true while it works (agents in reads). qorpera.onChange(fn) calls fn when the company folder changed, which in a busy company is every few seconds. Read and draw when the page opens; after a change draw again once, no sooner than ten seconds after the last draw however many changes arrive, and do not poll on a timer. An app may make 120 calls a minute in a member's tab and 8 at a time, and todos counts as ten calls, so call each source once per draw. Keep the facts a page shows (decisions, numbers, open questions) in one data file in the app's folder and draw the page from it, so a change of state is a change to that one file; show who works on what and what is blocked from todos and agents instead of typing it in. When a read fails, keep what the page last showed and read again ten seconds later, until a read works; with nothing to show yet, show a plain line, never an empty page. A page only reads: it cannot change anything.";

/**
 * save_app's description, last: what makes a page worth opening (Jonas, 10 November 2026: the agents' apps "weren't all
 * that great visually"; six of the seven reviewed were one report template of text, drop-downs and dead links). A
 * concept or prototype of the product follows the product's own design (the company context), so these rules name
 * every other app. How to look at a page before showing it is in the company context, which has the room.
 */
const SAVE_APP_DESIGN =
	" How to make a page worth opening (a concept or prototype of the company's product follows the product's own design instead). The first screen answers how this stands, without scrolling, on a laptop and on a phone: what is decided, what is open, what waits on a member and the two or three numbers that matter, each as a short line, a large number or a mark, never a paragraph. Head it with the area's plain name: no date, no update, no list of what you did; give the app that name as its title too, two or three words without the company's name. Show instead of write: a large number for a key figure, a chart for money or a trend, a map for places and routes, a diagram for steps and flows, a real picture for a thing or a screen; draw charts, maps and diagrams as inline SVG. A page with nothing to look at is a document, not an app. Keep it to about 300 words and rarely more than two laptop screens: a few words or a mark in a table cell, and the long reasoning in its file, named by its path in one line. Say what is not yet known once, as a state, not as a caveat in every sentence. Show a fact in one app only, the one whose area owns it. Fold nothing a member needs into <details> or closed rows. A link does not open inside an app, whether to a file, an app or the web: show the content itself, name a file by its path, and put links in your message. Once the company has a brand in QorperaOS/brand/, use its colours, logo and type in every app, copied in because a page cannot read QorperaOS/, so the apps look like one company; until then keep it calm: the system font, one accent colour, plenty of space. Make it work at phone width (about 390 px): one column, tables that fit or stack into cards, nothing cut off, text at least 14 px. Draw what the company already holds from its live data instead of typing it in: reads says how. The answer's look names what a quick read of the saved page found: fix it, unless it does not fit this page.";

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
	/** Null keeps what the app has (false for a new app). */
	readonly concept: boolean | null;
	readonly cover: string | null;
}

interface SaveRequest {
	readonly name: string;
	readonly operationKey: string;
	readonly manifest: ManifestInput | null;
	readonly files: readonly AppFile[];
}

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
	const keys = ["title", "about", "emblem", "colour", "entry", "reads", "concept", "cover"];
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
	return {
		name: text(value.title, "manifest.title", 60, true) as string,
		about: text(value.about, "manifest.about", 200, false),
		emblem: choice(value.emblem, "manifest.emblem", INTERFACE_EMBLEMS),
		colour: choice(value.colour, "manifest.colour", AGENT_COLOURS),
		entry,
		reads,
		concept: typeof value.concept === "boolean" ? value.concept : null,
		cover,
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

/** The text this call writes as the app's entry page, or null when it leaves the entry as it is. */
const entryText = (request: SaveRequest, entry: string): string | null =>
	request.files.find((file) => file.path.toLowerCase() === entry.toLowerCase())?.text ?? null;

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
 * What a quick read of an app's entry page finds, told to the agent after a save: advice, never a refusal (Jonas,
 * 10 November 2026, on a company whose seven agent-made apps held 68 links that open nothing, 36 folded sections and
 * about 6,000 words, and six of them no picture, chart or diagram). It reads the page's text alone, so a replayed save
 * answers the same notes, and in one pass over the page, whatever an agent wrote into it:
 * - links: the frame opens none (a `folder:`, `app:` or web link blanks the app or does nothing); `#` links stay;
 * - folded sections (`<details>`), which hide what a member came to see;
 * - the words a member would read, outside scripts and styles;
 * - a page of text with nothing to look at: no picture, drawing, canvas or video, in the markup or made by a script.
 * How the page looks stays the agent's to check, on a machine (save_app's description).
 */
export function appLookNotes(html: string): string[] {
	const page = withoutBlocks(html, /<!--/g, /-->/g);
	const markup = withoutBlocks(withoutBlocks(page, /<script\b/gi, /<\/script\s*>/gi), /<style\b/gi, /<\/style\s*>/gi);
	let read = "";
	let links = 0;
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
		if (href !== null && href[1] !== "" && !href[1].startsWith("#")) links++;
		at = to + 1;
	}
	read += markup.slice(at);
	const words = read
		.replace(/&[a-z0-9#]+;/gi, " ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
	const shown = /<(?:img|svg|canvas|video|picture)\b|createElementNS|getContext\(|url\(/i.test(page);
	const notes: string[] = [];
	if (links > 0)
		notes.push(
			`${links} ${links === 1 ? "link" : "links"}: a link does not open inside an app. Show the content itself, name a file by its path, and put links in your message.`,
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

/** What the model is told after a commit, by each unit's outcome. `entry` is the entry page's text when this call wrote it. */
function savedText(
	request: { name: string; operationKey: string },
	receiptId: string,
	units: readonly CloudCompanyFolderUnitResult[],
	created: boolean,
	entry: string | null,
): string {
	const saved = units.filter((unit) => unit.outcome === "saved").length;
	const state = saved === units.length ? "applied" : saved === 0 ? "not_applied" : "partly_applied";
	const conflict = units.some((unit) => unit.outcome === "conflict");
	const look = state === "applied" && entry !== null ? appLookNotes(entry) : [];
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
		description: `Make or change an interface app: a small web page in apps/<name>/ of the company folder that shows members a part of the company as it stands now (the state of an area, results, a prototype, a dashboard), opened as a page of its own. Give the app's name (its folder: lowercase, digits and hyphens), a manifest (title, and optionally about, emblem: ${INTERFACE_EMBLEMS.join(", ")}, colour: ${AGENT_COLOURS.join(", ")}, entry: the page that opens, default ${APP_DEFAULT_ENTRY}, reads: the live sources the page may read, of ${APP_READS.join(", ")}) to make it or change its manifest, or null to keep it, and the files to write (at most ${FILES_PER_CALL} a call: .html, .css, .js, .json, .svg, .md, .csv, .txt, each at most ${APP_FILE_MAX_BYTES / 1024} KiB). Pictures (.png, .jpg, .webp, .gif) and videos (.mp4, .webm) you write into the app's folder from a company machine may be up to ${APP_VIDEO_FILE_MAX_BYTES / 1024 / 1024} MiB each and ${APP_VIDEOS_MAX_BYTES / 1024 / 1024} MiB in all; pages and code up to ${APP_MAX_BYTES / 1024 / 1024} MiB in all. The app is one page: only the entry opens, so links to its other .html files do not work; put every view in the entry, as tabs or sections. The page gets its pictures and videos only where it names them when it opens (<img src>, <video src>, a poster, or url() in its styles): a script cannot load a picture or video later, so put every picture it may show in the page (hidden ones too) and switch them with styles or a script; a script reads text files with qorpera.read(path). The entry may use the app's other files by relative paths (<link rel="stylesheet" href="style.css">, <script src="app.js">, <img src="chart.svg">); the page has no network, so put everything it needs in the app. A new app needs a manifest and its entry. It applies at once. Then link it in your message as [Title](app:<name>), which members open as a page of its own. Set concept = true for a concept of the company's product, and cover = a picture of it, so it shows in the Concepts viewer. Keep operationKey for the same change, and use a new one for any other change.${SAVE_APP_DESIGN}`,
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
						concept: { type: ["boolean", "null"] },
						cover: { type: ["string", "null"], maxLength: 1024 },
					},
				},
				files: {
					type: "array",
					maxItems: FILES_PER_CALL,
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
			const input = args(value, "save_app", ["name", "operationKey", "manifest", "files"]);
			const request: SaveRequest = {
				name: appName(input.name),
				operationKey: operationKey(input.operationKey),
				manifest: parseManifest(input.manifest),
				files: parseFiles(input.files),
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
			};
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
					concept: request.manifest.concept ?? false,
					cover: request.manifest.cover,
				};
				if (!request.files.some((file) => file.path.toLowerCase() === manifest.entry.toLowerCase()))
					throw new CloudToolRefusal(
						`APP_ENTRY_MISSING: a new app needs its entry, ${manifest.entry}, among files`,
					);
				const total = request.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
				if (request.files.length + 1 > APP_MAX_FILES || total > APP_MAX_BYTES)
					throw new CloudToolRefusal(
						`APP_TOO_LARGE: an app holds at most ${APP_MAX_FILES} files and ${APP_MAX_BYTES / 1024 / 1024} MiB in all`,
					);
				const contents: CloudCompanyFolderNewEntry[] = [
					{
						path: APP_MANIFEST,
						kind: "file",
						content: { text: writeAppManifest(manifest), mediaType: "application/toml" },
					},
					...foldersOf(request.files.map((file) => file.path)).map((path) => ({ path, kind: "folder" as const })),
					...request.files.map((file) => ({
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
				const answer = await commit(
					"save_app",
					request,
					digest,
					[unit],
					(receiptId, units) => savedText(request, receiptId, units, true, entryText(request, manifest.entry)),
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
			if (request.manifest !== null) {
				const before = storedParse?.ok ? storedParse.manifest : null;
				const manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? before?.emblem ?? "page",
					colour: request.manifest.colour ?? before?.colour ?? null,
					entry: request.manifest.entry ?? before?.entry ?? APP_DEFAULT_ENTRY,
					owner: before?.owner ?? owner,
					posted: before?.posted ?? false,
					reads: request.manifest.reads ?? before?.reads ?? [],
					concept: request.manifest.concept ?? before?.concept ?? false,
					cover: request.manifest.cover ?? before?.cover ?? null,
				};
				entry = manifest.entry;
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
			const sizes = new Map<string, number>();
			for (const item of listed.entries)
				if (item.kind === "file" && APP_FILE_TYPES[appFileKind(item.path)])
					sizes.set(item.path.slice(root.length + 1).toLowerCase(), item.file.bytes);
			for (const file of request.files) sizes.set(file.path.toLowerCase(), Buffer.byteLength(file.text));
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
			const byKey = new Map(listed.entries.map((item) => [item.path.slice(root.length + 1).toLowerCase(), item]));
			for (const folderPath of foldersOf(request.files.map((file) => file.path))) {
				const found = byKey.get(folderPath.toLowerCase());
				if (found === undefined) units.push({ op: "mkdir", path: `${root}/${folderPath}` });
				else if (found.kind !== "folder")
					throw new CloudToolRefusal(`APP_NOT_A_FOLDER: ${root}/${folderPath} is a file, not a folder`);
			}
			for (const file of request.files) {
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
			if (
				!byKey.has(entry.toLowerCase()) &&
				!request.files.some((file) => file.path.toLowerCase() === entry.toLowerCase())
			)
				throw new CloudToolRefusal(
					`APP_ENTRY_MISSING: the app's entry, ${entry}, is not in its folder; write it among files`,
				);
			const answer = await commit(
				"save_app",
				request,
				digest,
				units,
				(receiptId, results) => savedText(request, receiptId, results, false, entryText(request, entry)),
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
