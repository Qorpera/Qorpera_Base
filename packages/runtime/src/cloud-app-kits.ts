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

/**
 * Run by the page after the stand-in above: live values from the company's databases. Where a kit takes a number, its
 * data may hold `{"query": "<database>/<question>", "params", "column", "example"}` in its place. `QORPERA_KIT.load()`
 * reads the data file, puts each such value's current number in its place and gives the engine the text it parses: a
 * value with no answer yet is null, and a `state` beside it says `"unknown"` (an answered one says `"known"`). Each
 * question with its params is watched once, however many values share it; a later answer that fails keeps the last good
 * one. A watch the bridge could not start is no answer at once and is tried again after a wait: 10 seconds after the
 * first refusal, twice as long after each one in a row (10 minutes at most). No load starts it before then, and at
 * the wait's end the script asks for a load itself (as for a changed value), so a database made meanwhile shows
 * without anything else changing. A page makes at most 100 refused starts, counting the ones still out (one the data
 * drops while it is out stays counted until it answers), and then starts no watch that is not running: its value
 * stays not known until the page is opened again. Each refusal is a
 * refused call to the app's frame, which stops a page that makes too many (the web's `MAX_REFUSED`), and the engine
 * loads again at every live value's change: so a question that does not answer must not be asked at every load.
 * Loads run one after another. When a watched value changes, or a refused question's wait ends, the functions given
 * to `QORPERA_KIT.onLive` run, at most once a frame. `QORPERA_KIT.live` lists the places of the data that are bound
 * and `QORPERA_KIT.changed` the ones that moved at the last load, each as a JSON pointer. Where `qorpera.watch` is
 * missing (outside Qorpera, or an older web app), a value is its `example`, with `"assumed"` beside it, or not known
 * when it has none.
 */
const KIT_LIVE_VALUES = [
	"(()=>{const K=window.QORPERA_KIT,q=window.qorpera,asks=new Map(),fns=[];let seen=new Map(),frame=0,waiting=0,left=100;",
	'K.live=[];K.changed=[];K.onLive=(f)=>{if(typeof f==="function")fns.push(f)};',
	'const num=(v)=>{const n=typeof v==="number"?v:typeof v==="string"&&v.trim()?Number(v):NaN;return Number.isFinite(n)?n:null};',
	'const bound=(v)=>v&&typeof v==="object"&&!Array.isArray(v)&&typeof v.query==="string"&&Object.keys(v).every((k)=>["query","params","column","example"].includes(k));',
	"const ping=()=>{if(frame||waiting)return;frame=1;const go=()=>{frame=0;for(const f of fns)try{f()}catch(e){}};",
	"if(window.requestAnimationFrame)window.requestAnimationFrame(go);else setTimeout(go,16)};",
	// One watch for each question with its params. A failed answer is no answer: the last good one stays. A watch that
	// could not start (the bridge calls `failed`, or it throws) is no answer at once. A later load starts it again
	// (once, however many values share it), but not before its wait is over (`w.t`: 10 s, doubled by each refusal in a
	// row, `w.n`, up to 10 min; an answer ends the row). At the wait's end `again` asks for a load, unless the data no
	// longer names the question, a newer refusal has its own wait, or the page has no starts left; it waits for a load
	// that is running. `left` is the starts the page may still have refused: a start takes one (`w.o`: it is out, and
	// which one) and its own first answer gives it back, so starts that are out together cannot pass the limit. A
	// start still out when the data drops its question stays out and stays counted (below, `w.x`): its watch is not
	// stopped until the start's own answer comes, which gives the start back and stops it; a refusal keeps it
	// counted. So the frame never counts a refused start the page's count did not hold, however often a question is
	// named and dropped, and a dropped question moves no value, asks for no load and waits for nothing. A question
	// that cannot start is not waited for.
	// A question's key: its name and its params, in the order of their names (kitBindings keys it the same way).
	'const prm=(b)=>b.params&&typeof b.params==="object"?b.params:{};',
	"const keyOf=(b)=>{const p=prm(b);return JSON.stringify([b.query,Object.keys(p).sort().map((k)=>[k,p[k]])])};",
	"const ask=(b,key)=>{const p=prm(b);let w=asks.get(key);",
	"if(!w){w={dead:1,n:0,t:0,m:0};w.first=new Promise((r)=>{w.ready=r});asks.set(key,w)}",
	"if(w.dead&&!w.used&&Date.now()>=w.t){if(left<1)w.ready();else{w.dead=0;left--;const m=w.o=++w.m,",
	"dead=()=>{if(w.o===m)w.o=0;if(asks.get(key)!==w)return;w.dead=1;const n=++w.n,d=Math.min(6e5,5e3*2**n),",
	"again=()=>{if(asks.get(key)===w&&w.dead&&w.n===n&&left>0){if(waiting)setTimeout(again,1e3);else{w.t=0;ping()}}};",
	"w.t=Date.now()+d;setTimeout(again,d);w.ready()};",
	"try{w.stop=q.watch(b.query,p,(a)=>{try{if(w.o===m){w.o=0;left++}if(asks.get(key)!==w){if(w.x){w.x=0;w.stop()}return}",
	"if(!a||!Array.isArray(a.rows))return;const s=JSON.stringify([a.columns,a.rows[0]]);",
	"w.a=a;w.n=0;w.ready();if(s!==w.s){w.s=s;ping()}}catch(e){}},dead)}catch(e){dead()}}}w.used=1;return w};",
	'const walk=(v,h,k,path,out,d)=>{if(d>12||!v||typeof v!=="object")return;',
	'if(h&&bound(v)){out.push({h,k,b:v,p:path,s:!Array.isArray(h)&&(k==="value"||"state" in h)});return}',
	'for(const n of Object.keys(v))walk(v[n],v,n,path+"/"+n.replace(/~/g,"~0").replace(/\\//g,"~1"),out,d+1)};',
	'const run=async()=>{const raw=await q.read("apps/"+K.app+"/"+K.data);',
	'const text=typeof raw==="string"?raw:raw&&(raw.text??(raw.content&&raw.content.text)??raw.content);',
	'const found=[],ws=[],on=typeof q.watch==="function";let data=null;',
	'try{if(typeof text==="string"&&text.includes("query")){data=JSON.parse(text);walk(data,null,null,"",found,0)}}catch(e){}',
	// The first answers get a few seconds; what has not answered by then comes through onLive.
	// The watches the data no longer names stop before new ones start, so a bridge's limit on watches has room for them;
	// one whose start is still out is stopped when that start answers.
	"const keys=found.map((f)=>keyOf(f.b)),want=new Set(on?keys:[]);",
	'for(const[key,w]of asks)if(!want.has(key)){asks.delete(key);if(w.o)w.x=1;else try{if(typeof w.stop==="function")w.stop()}catch(e){}}',
	"waiting++;let t=0;try{for(const w of asks.values())w.used=0;if(on)found.forEach((f,i)=>ws.push(ask(f.b,keys[i])));",
	"if(ws.some((w)=>!w.a))await Promise.race([Promise.all(ws.map((w)=>w.first)),new Promise((r)=>{t=setTimeout(r,3000)})]);",
	"}finally{waiting--;clearTimeout(t)}",
	"const now=new Map(),moved=[];found.forEach((f,i)=>{let v=null;const a=on&&ws[i].a,r=a&&a.rows[0];",
	'if(r&&typeof r==="object")v=num(r[typeof f.b.column==="string"?f.b.column:Array.isArray(a.columns)&&a.columns.length?a.columns[0]:Object.keys(r)[0]]);',
	'else if(!on)v=num(f.b.example);f.h[f.k]=v;if(f.s)f.h.state=v===null?"unknown":on?"known":"assumed";',
	"now.set(f.p,v);if(seen.has(f.p)&&seen.get(f.p)!==v)moved.push(f.p)});",
	"seen=now;K.live=found.map((f)=>f.p);K.changed=moved;return found.length?JSON.stringify(data):text};",
	// One load at a time: a load asked for while one runs starts after it, so the newest answers land last.
	"let chain=Promise.resolve();K.load=()=>{const p=chain.then(run);chain=p.catch(()=>{});return p}})();",
].join("");

/** The keys a binding holds: an object whose `query` is text and whose keys are among these is a live value. */
const KIT_BINDING_KEYS: ReadonlySet<string> = new Set(["query", "params", "column", "example"]);
/** How many questions a page keeps live at once (the bridge's watches); the rest show as not known. */
export const KIT_LIVE_QUESTIONS = 8;

/**
 * The questions of the company's databases a kit's data names, once each (a question with its params counts once), as
 * the page's script finds them (KIT_LIVE_VALUES): a binding is an object whose `query` is text and whose keys are among
 * `query`, `params`, `column` and `example`, below the data's top and at most 12 levels down. Data that names any reads
 * the company's databases (`reads` holds `data`).
 */
export function kitBindings(data: unknown): string[] {
	const found = new Set<string>();
	const walk = (value: unknown, depth: number): void => {
		if (depth > 12 || typeof value !== "object" || value === null) return;
		const object = value as Record<string, unknown>;
		if (
			depth > 0 &&
			!Array.isArray(value) &&
			typeof object.query === "string" &&
			Object.keys(object).every((key) => KIT_BINDING_KEYS.has(key))
		) {
			const params = (typeof object.params === "object" && object.params !== null ? object.params : {}) as Record<
				string,
				unknown
			>;
			// The page's key for a question: its params in the order of their names, so an order makes no other question.
			found.add(
				JSON.stringify([
					object.query,
					Object.keys(params)
						.sort()
						.map((key) => [key, params[key]]),
				]),
			);
			return;
		}
		for (const item of Object.values(object)) walk(item, depth + 1);
	};
	walk(data, 0);
	return [...found];
}

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
 * Before the engine, the page also gives it the company's live values in place of the data's bindings (KIT_LIVE_VALUES).
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
		`<script>window.QORPERA_KIT = ${kitJson};${KIT_OUTSIDE_QORPERA}${KIT_LIVE_VALUES}</script>`,
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
 * - More questions of the company's databases than a page keeps live: the rest show as not known.
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
	const questions = kitBindings(data).length;
	if (questions > KIT_LIVE_QUESTIONS)
		notes.push(
			`${kitDataFile(kit)} names ${questions} different questions of the company's databases: a page keeps ${KIT_LIVE_QUESTIONS} live, and the rest show as not known.`,
		);
	if (long.length > 0)
		notes.push(
			`${long.length === 1 ? "1 text is" : `${long.length} texts are`} longer than a ${kit} page shows (in ${[...new Set(long)].slice(0, 4).join(", ")}): the page cuts ${long.length === 1 ? "it" : "them"}. A kit's page holds names, numbers and notes of a line; the reasoning stays in its file, linked as a source.`,
		);
	return notes;
}
