/*
 * The data kits of interface apps (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3b; Jonas, 13 November 2026, on a new
 * company whose seven agent-made apps were each a document in boxes: "they are supposed to be objects, models, apps and
 * videos that are visual-first to let you see the company"). Rules for how a page should look were tried twice and
 * gave tidier documents, because the agents that make apps are researchers and analysts, not designers. A kit takes
 * the drawing out of their hands: the agent hands in one data file (facts, numbers, the names of its pictures), and an
 * engine Qorpera wrote draws one visual form from it, the same engine in every app of the kit:
 * - `model`: numbers a member drags, with what a sale leaves and where the company breaks even;
 * - `board`: real things as pictures on one scale, directions to choose between, or a wall of references;
 * - `path`: the steps something goes through, the evidence under each, and the hole;
 * - `object`: a thing a member turns, with its parts pointed out on it.
 * An app made from one holds:
 * - `engine.js`, the kit's engine (packages/runtime/kits/<kit>/engine.js; `KIT_ENGINE_JS` holds each one's text);
 * - `index.html`, the page (`kitPage`), which names the data file and every picture and video the data refers to: a
 *   page in the app's frame gets its pictures only where it names them when it opens. It also holds the data as it
 *   was saved, for the one case where no `qorpera` object answers: an agent opening the page from `/company` on a
 *   machine to look at it before showing it;
 * - `<kit>.json`, the agent's own: the data;
 * - the pictures and videos the data names, which the agent writes from a company machine.
 * `save_app` writes the first two (cloud-folder-app-tools.ts); nothing here reads or writes the folder. The explainer,
 * whose agent writes scenes instead of data, is its own module (cloud-app-kit-explainer.ts).
 */

import {
	BOARD_ENGINE_JS,
	BOARD_KIT_GUIDE,
	MODEL_ENGINE_JS,
	MODEL_KIT_GUIDE,
	OBJECT_ENGINE_JS,
	OBJECT_KIT_GUIDE,
	PATH_ENGINE_JS,
	PATH_KIT_GUIDE,
} from "./cloud-app-kit-engines.generated.ts";

/** The kits whose agent writes one data file. */
export const DATA_KITS = Object.freeze(["model", "board", "path", "object"] as const);
export type DataKit = (typeof DATA_KITS)[number];

export const isDataKit = (kit: string | null | undefined): kit is DataKit =>
	typeof kit === "string" && (DATA_KITS as readonly string[]).includes(kit);

/** The files of a data kit's app, relative to its folder. */
export const KIT_ENGINE = "engine.js";
export const KIT_PAGE = "index.html";
/** The agent's data file: the kit's name with `.json`. */
export const kitDataFile = (kit: DataKit): string => `${kit}.json`;
/** A data file is read up to this size; a longer one holds what belongs in pictures or in the folder. */
export const KIT_DATA_MAX_BYTES = 256 * 1024;

/** Each kit's engine.js, as save_app writes it into an app's folder. */
export const KIT_ENGINE_JS: Readonly<Record<DataKit, string>> = Object.freeze({
	model: MODEL_ENGINE_JS,
	board: BOARD_ENGINE_JS,
	path: PATH_ENGINE_JS,
	object: OBJECT_ENGINE_JS,
});

/** What an agent is told of each kit (packages/runtime/kits/<kit>/KIT.md): what it draws and what its data holds.
 * save_app's schema carries them on `kit`, so a guide and its engine reach a run in the same bundle. */
export const KIT_GUIDE: Readonly<Record<DataKit, string>> = Object.freeze({
	model: MODEL_KIT_GUIDE,
	board: BOARD_KIT_GUIDE,
	path: PATH_KIT_GUIDE,
	object: OBJECT_KIT_GUIDE,
});

/** What each kit's data must hold for its engine to have anything to draw. */
const KIT_NEEDS: Readonly<Record<DataKit, readonly string[]>> = Object.freeze({
	model: ["groups"],
	board: ["mode", "items"],
	path: ["steps", "lanes"],
	object: [],
});

/** A text a member reads on a kit's page is a label or a short note: past this many characters an engine cuts it. */
const KIT_TEXT_MAX = 90;
/** The fields whose text is an address or a formula, not something a member reads. */
const KIT_UNREAD_FIELDS: ReadonlySet<string> = new Set(["source", "formula", "link", "hex", "id", "value", "track"]);

const MEDIA = /\.(?:png|jpe?g|webp|gif|svg|mp4|webm)$/i;
const VIDEO = /\.(?:mp4|webm)$/i;

function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"]/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character,
	);
}

/**
 * Qorpera's plain look for a kit page that gets no base style from the web (a concept gets none): the variables the
 * base style gives (packages/web/src/app/interface-app-style.ts), in the base style's own layer and with no
 * specificity, so wherever the web does put its base style in, with the company's colours, that one wins.
 */
export const KIT_FALLBACK_STYLE =
	'@layer qorpera-base{:where(:root){color-scheme:light dark;--q-bg:light-dark(#ffffff,#1f2120);--q-text:light-dark(#161615,#f4f3f0);--q-accent:light-dark(#305fbe,#6ea4ff);--q-on-accent:light-dark(#ffffff,#161615);--q-muted:color-mix(in srgb,var(--q-text) 68%,var(--q-bg));--q-line:color-mix(in srgb,var(--q-text) 14%,var(--q-bg));--q-surface:color-mix(in srgb,var(--q-text) 5%,var(--q-bg));--q-accent-soft:color-mix(in srgb,var(--q-accent) 14%,var(--q-bg));--q-good:light-dark(#0f7a5a,#5ed6a9);--q-warn:light-dark(#9a6300,#f2c35d);--q-bad:light-dark(#b33a2f,#ff9084);--q-font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--q-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--q-radius:10px}:where(html){background:var(--q-bg);color:var(--q-text);font:100%/1.55 var(--q-font);-webkit-font-smoothing:antialiased}:where(button,input,select,textarea){font:inherit}}';

/** Run by the page before its engine: outside Qorpera, a `qorpera` object that answers the data file's read from the
 * data in the page, lists no questions and refuses every change. */
const KIT_OUTSIDE_QORPERA =
	'if(!window.qorpera){const saved=document.getElementById("kit-data").textContent;const no=()=>Promise.reject(new Error("Only inside Qorpera."));const none=()=>Promise.resolve([]);window.qorpera={read:(path)=>String(path).endsWith("/"+window.QORPERA_KIT.data)?Promise.resolve(saved):no(),list:no,table:no,todos:none,agents:none,questions:none,answer:no,setRow:no,addRow:no,onChange(){}};}';

/** A data file's text as the object an engine draws from, or what is wrong with it, in words for its maker. */
export function parseKitData(
	kit: DataKit,
	text: string,
): { readonly data: Readonly<Record<string, unknown>> } | { readonly problem: string } {
	const file = kitDataFile(kit);
	if (Buffer.byteLength(text) > KIT_DATA_MAX_BYTES)
		return {
			problem: `${file} is larger than ${KIT_DATA_MAX_BYTES / 1024} KiB: it holds the facts and the names of the pictures, never the pictures or the long text`,
		};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { problem: `${file} is not JSON: ${error instanceof Error ? error.message : "it does not parse"}` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { problem: `${file} must be one JSON object` };
	const data = value as Record<string, unknown>;
	const missing = KIT_NEEDS[kit].filter((key) => data[key] === undefined || data[key] === null);
	if (missing.length > 0)
		return { problem: `${file} has no ${missing.join(" and no ")}: the ${kit} kit draws nothing without` };
	if (kit === "object" && data.turntable === undefined && data.picture === undefined && data.variants === undefined)
		return { problem: `${file} has no turntable, picture or variants: the object kit has no thing to show` };
	return { data };
}

/**
 * Every picture and video of the app's own folder that the data names, once, in the data's order: any text that ends
 * in a picture's or video's extension and is a plain path inside the folder. An address (`https://…`, `folder:…`), a
 * path out of the folder and a path that starts at the top are not the app's own files.
 */
export function kitMedia(data: unknown): string[] {
	const found: string[] = [];
	const walk = (value: unknown, depth: number): void => {
		if (depth > 12) return;
		if (typeof value === "string") {
			if (
				value.length <= 200 &&
				MEDIA.test(value) &&
				!/^[a-z][a-z0-9+.-]*:/i.test(value) &&
				!value.startsWith("/") &&
				!value.split("/").includes("..") &&
				!/[\0-\x1f"<>\\]/.test(value) &&
				!found.includes(value)
			)
				found.push(value);
		} else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
		else if (typeof value === "object" && value !== null)
			for (const item of Object.values(value)) walk(item, depth + 1);
	};
	walk(data, 0);
	return found;
}

/**
 * The page of a data kit's app: the fallback look, the pictures and videos the data names that the folder holds
 * (`holds` by path relative to the app's folder; one it lacks is left out, and the engine draws a quiet placeholder),
 * which app and data file the engine reads, and the engine. The page says it follows light and dark.
 *
 * In Qorpera the frame gives the page its `qorpera` object before any of the page's scripts run
 * (packages/web/public/page-preview/index.html), and the engine reads the data file through it, as it stands now. Opened
 * anywhere else there is none: the page then answers the engine's read from the data it was saved with, and has
 * nothing a member could act on. That is how an agent looks at its app on a machine, with no stand-in to write.
 */
export function kitPage(
	app: string,
	kit: DataKit,
	title: string,
	data: Readonly<Record<string, unknown>>,
	holds: (path: string) => boolean,
	concept = false,
): string {
	const lang = typeof data.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(data.lang) ? data.lang : "en";
	// In a script: no `<`, so nothing in a name ends the script or opens a comment.
	const kitJson = JSON.stringify({ app, kit, data: kitDataFile(kit), ...(concept ? { concept: true } : {}) }).replace(
		/</g,
		"\\u003c",
	);
	return [
		"<!doctype html>",
		`<html lang="${lang}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="light dark">',
		`<title>${escapeHtml(title)}</title>`,
		`<style>${KIT_FALLBACK_STYLE}</style>`,
		"</head>",
		"<body>",
		'<div hidden id="kit-media">',
		...kitMedia(data)
			.filter(holds)
			.map((path) =>
				VIDEO.test(path)
					? `<video data-kit-src="${escapeHtml(path)}" src="${escapeHtml(path)}" preload="metadata" muted playsinline></video>`
					: `<img data-kit-src="${escapeHtml(path)}" src="${escapeHtml(path)}" alt="">`,
			),
		"</div>",
		`<script type="application/json" id="kit-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`,
		`<script>window.QORPERA_KIT = ${kitJson};${KIT_OUTSIDE_QORPERA}</script>`,
		`<script src="${KIT_ENGINE}"></script>`,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/**
 * What a read of a kit's data tells its maker after a save: advice, never a refusal.
 * - Pictures and videos the data names that the app's folder does not hold: the page shows a placeholder until they are
 *   written and the app is saved again (the page names its pictures when it is written).
 * - Texts longer than a kit shows: a page of a kit holds labels and short notes, and an engine cuts the rest.
 */
export function kitNotes(
	kit: DataKit,
	data: Readonly<Record<string, unknown>>,
	holds: (path: string) => boolean,
): string[] {
	const notes: string[] = [];
	const missing = kitMedia(data).filter((path) => !holds(path));
	if (missing.length > 0)
		notes.push(
			`${missing.length === 1 ? "1 picture or video is" : `${missing.length} pictures or videos are`} named in ${kitDataFile(kit)} but not in the app's folder (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}): the page shows a placeholder there. Write ${missing.length === 1 ? "it" : "them"} into the app's folder from a machine, then save the app again so the page names ${missing.length === 1 ? "it" : "them"}.`,
		);
	const long: string[] = [];
	const walk = (value: unknown, key: string, depth: number): void => {
		if (depth > 12) return;
		if (typeof value === "string") {
			if (!KIT_UNREAD_FIELDS.has(key) && [...value].length > KIT_TEXT_MAX && !/^[a-z][a-z0-9+.-]*:/i.test(value))
				long.push(key);
		} else if (Array.isArray(value)) for (const item of value) walk(item, key, depth + 1);
		else if (typeof value === "object" && value !== null)
			for (const [name, item] of Object.entries(value)) walk(item, name, depth + 1);
	};
	walk(data, "", 0);
	if (long.length > 0)
		notes.push(
			`${long.length === 1 ? "1 text is" : `${long.length} texts are`} longer than a ${kit} page shows (in ${[...new Set(long)].slice(0, 4).join(", ")}): the page cuts ${long.length === 1 ? "it" : "them"}. A kit's page holds names, numbers and notes of a line; the reasoning stays in its file, linked as a source.`,
		);
	return notes;
}
