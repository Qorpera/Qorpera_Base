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
 * - `object`: a thing a member turns, with its parts pointed out on it;
 * - `curve`: one value over time, drawn big, with the expected part as a band and a safe level (Jonas, 14 November
 *   2026, "Yes, start building" on lanes/company-views-20261114/PLAN.md's shape kits);
 * - `stack`: things that want a member's yes, one big card at a time, answered from the card;
 * - `shelf`: the company's real things side by side, each with one level behind it;
 * - `map`: the company, or an owner's area, as its things that fill as they are built, the agents at them and layers to
 *   dive into (Jonas, 15 November 2026: "Use a map kit"); its first layer may be the company's reading, live;
 * - `ring`: a year, a month or a week as a ring, with marks for points in time, wedges for stretches, a hand at now and
 *   the next thing in its middle (Jonas, 14 November 2026, PLAN.md step 5);
 * - `flow`: money or people as wide bands from where they come, through the company, to where they go.
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
	CURVE_ENGINE_JS,
	CURVE_KIT_GUIDE,
	FLOW_ENGINE_JS,
	FLOW_KIT_GUIDE,
	MAP_ENGINE_JS,
	MAP_KIT_GUIDE,
	MODEL_ENGINE_JS,
	MODEL_KIT_GUIDE,
	OBJECT_ENGINE_JS,
	OBJECT_KIT_GUIDE,
	PATH_ENGINE_JS,
	PATH_KIT_GUIDE,
	RING_ENGINE_JS,
	RING_KIT_GUIDE,
	ROADMAP_ENGINE_JS,
	ROADMAP_KIT_GUIDE,
	SHELF_ENGINE_JS,
	SHELF_KIT_GUIDE,
	STACK_ENGINE_JS,
	STACK_KIT_GUIDE,
} from "./cloud-app-kit-engines.generated.ts";
import { KIT_FIGURES } from "./cloud-app-kit-figures.generated.ts";
import { OBJECT_THREE_JS, OBJECT_THREE_LICENSE } from "./cloud-app-kit-three.generated.ts";

/** The kits whose agent writes one data file. */
export const DATA_KITS = Object.freeze([
	"model",
	"board",
	"path",
	"object",
	"curve",
	"stack",
	"shelf",
	"map",
	"ring",
	"flow",
	"roadmap",
] as const);
export type DataKit = (typeof DATA_KITS)[number];

export const isDataKit = (kit: string | null | undefined): kit is DataKit =>
	typeof kit === "string" && (DATA_KITS as readonly string[]).includes(kit);

/** The files of a data kit's app, relative to its folder. */
export const KIT_ENGINE = "engine.js";
export const KIT_PAGE = "index.html";
/** The agent's data file: the kit's name with `.json`. */
export const kitDataFile = (kit: DataKit): string => `${kit}.json`;
export const KIT_THREE = "three.js";
export const KIT_THREE_LICENSE = "three.license.txt";
/** A data file is read up to this size; a longer one holds what belongs in pictures or in the folder. */
export const KIT_DATA_MAX_BYTES = 256 * 1024;

/** Each kit's engine.js, as save_app writes it into an app's folder. */
export const KIT_ENGINE_JS: Readonly<Record<DataKit, string>> = Object.freeze({
	model: MODEL_ENGINE_JS,
	board: BOARD_ENGINE_JS,
	path: PATH_ENGINE_JS,
	object: OBJECT_ENGINE_JS,
	curve: CURVE_ENGINE_JS,
	stack: STACK_ENGINE_JS,
	shelf: SHELF_ENGINE_JS,
	map: MAP_ENGINE_JS,
	ring: RING_ENGINE_JS,
	flow: FLOW_ENGINE_JS,
	roadmap: ROADMAP_ENGINE_JS,
});

/** What an agent is told of each kit (packages/runtime/kits/<kit>/KIT.md): what it draws and what its data holds.
 * app_guide answers with them (cloud-app-guides.ts), so a guide and its engine reach a run in the same bundle. */
export const KIT_GUIDE: Readonly<Record<DataKit, string>> = Object.freeze({
	model: MODEL_KIT_GUIDE,
	board: BOARD_KIT_GUIDE,
	path: PATH_KIT_GUIDE,
	object: OBJECT_KIT_GUIDE,
	curve: CURVE_KIT_GUIDE,
	stack: STACK_KIT_GUIDE,
	shelf: SHELF_KIT_GUIDE,
	map: MAP_KIT_GUIDE,
	ring: RING_KIT_GUIDE,
	flow: FLOW_KIT_GUIDE,
	roadmap: ROADMAP_KIT_GUIDE,
});

/** What each kit's data must hold for its engine to have anything to draw. */
const KIT_NEEDS: Readonly<Record<DataKit, readonly string[]>> = Object.freeze({
	model: ["groups"],
	board: ["mode", "items"],
	path: ["steps", "lanes"],
	object: [],
	curve: ["points"],
	stack: ["cards"],
	shelf: ["things"],
	map: ["top"],
	ring: [],
	flow: ["from", "to"],
	roadmap: ["title", "parts"],
});

/** A text a member reads on a kit's page is a label or a short note: past this many characters an engine cuts it. */
const KIT_TEXT_MAX = 90;
/** The fields whose text is an address or a formula, not something a member reads. */
const KIT_UNREAD_FIELDS: ReadonlySet<string> = new Set([
	"source",
	"formula",
	"link",
	"hex",
	"id",
	"value",
	"track",
	"node",
	"model",
	"environment",
]);

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
	// The watches the data no longer names stop before new ones start, so a bridge's limit on watches has room for them.
	// Not one whose start is still out: it is stopped when that start answers, and keeps its place in the bridge's
	// limit until then. A new question the bridge refuses for that reason waits and is asked again, as any refused one.
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
	// A model of no input draws a line that says so and nothing else (14 November 2026: an agent that had never been
	// given the kit's guide answered "model.json has no groups" with `{"groups":[]}`, and the save passed).
	if (
		kit === "model" &&
		!(
			Array.isArray(data.groups) &&
			data.groups.some((group: unknown) => {
				const inputs = typeof group === "object" && group !== null ? (group as { inputs?: unknown }).inputs : null;
				return Array.isArray(inputs) && inputs.length > 0;
			})
		)
	)
		return { problem: `${file} has no input in its groups: the model kit draws nothing without one` };
	if (
		kit === "object" &&
		data.turntable === undefined &&
		data.picture === undefined &&
		data.model === undefined &&
		data.variants === undefined
	)
		return { problem: `${file} has no model, turntable, picture or variants: the object kit has no thing to show` };
	if (kit === "object") {
		const problem = objectProblem(data);
		if (problem) return { problem: `${file} ${problem}` };
	}
	// A curve is a line between two points at least; a shelf holds one thing at least. A stack of no cards is a stack
	// with nothing waiting, which its page shows as done.
	if (kit === "curve" && !(Array.isArray(data.points) && data.points.length >= 2))
		return { problem: `${file} needs two points at least in points: the curve kit draws a line between them` };
	if (kit === "shelf" && !(Array.isArray(data.things) && data.things.length > 0))
		return { problem: `${file} has no thing in things: the shelf kit has nothing to stand on its shelf` };
	if (kit === "stack" && !Array.isArray(data.cards)) return { problem: `${file}'s cards must be a list` };
	if (kit === "map") {
		const problem = mapProblem(data);
		if (problem) return { problem: `${file} ${problem}` };
	}
	if (kit === "ring") {
		const problem = ringProblem(data);
		if (problem) return { problem: `${file} ${problem}` };
	}
	if (kit === "flow") {
		const problem = flowProblem(data);
		if (problem) return { problem: `${file} ${problem}` };
	}
	if (kit === "roadmap") {
		const problem = roadmapProblem(data);
		if (problem) return { problem: `${file} ${problem}` };
	}
	return { data };
}

function isOwnFile(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 200 &&
		!/^[a-z][a-z0-9+.-]*:/i.test(value) &&
		!value.startsWith("/") &&
		!value.split("/").includes("..") &&
		!/[\0-\x1f"<>\\]/.test(value)
	);
}

const GLB = /\.glb$/i;
const HDR = /\.hdr$/i;

function objectProblem(data: Readonly<Record<string, unknown>>): string | null {
	const things = [data, ...(Array.isArray(data.variants) ? data.variants : [])];
	for (const [index, thing] of things.entries()) {
		const model = typeof thing === "object" && thing !== null ? (thing as { model?: unknown }).model : undefined;
		if (model !== undefined && !(isOwnFile(model) && GLB.test(model)))
			return `has a model${index ? ` in variant ${index}` : ""} that is not the path of a .glb file in the app's folder, such as "model/box.glb"`;
	}
	if (data.environment !== undefined && !(isOwnFile(data.environment) && HDR.test(data.environment)))
		return `has an environment that is not the path of an .hdr file in the app's folder`;
	if (data.view !== undefined) {
		const view = data.view as { yaw?: unknown; pitch?: unknown } | null;
		if (
			typeof view !== "object" ||
			view === null ||
			Array.isArray(view) ||
			(view.yaw !== undefined && typeof view.yaw !== "number") ||
			(view.pitch !== undefined && typeof view.pitch !== "number")
		)
			return 'has a view that is not {"yaw", "pitch"} in degrees';
	}
	return null;
}

export function kitModels(kit: DataKit, data: unknown): string[] {
	if (kit !== "object" || typeof data !== "object" || data === null) return [];
	const object = data as { model?: unknown; variants?: unknown };
	const found: string[] = [];
	for (const thing of [object, ...(Array.isArray(object.variants) ? object.variants : [])]) {
		const model = typeof thing === "object" && thing !== null ? (thing as { model?: unknown }).model : undefined;
		if (isOwnFile(model) && GLB.test(model) && !found.includes(model)) found.push(model);
	}
	return found;
}

export function kitLibrary(kit: DataKit, data: unknown): { readonly path: string; readonly text: string }[] {
	return kitModels(kit, data).length > 0
		? [
				{ path: KIT_THREE, text: OBJECT_THREE_JS },
				{ path: KIT_THREE_LICENSE, text: OBJECT_THREE_LICENSE },
			]
		: [];
}

/** The map kit's bounds: things in a layer, layers deep and things in all (packages/runtime/kits/map/KIT.md). */
export const MAP_BOUNDS = Object.freeze({ top: [3, 7], layer: [1, 12], depth: 4, things: 80 });

/** A map thing's id and a layer's key, as the engine takes them. */
const MAP_ID = /^[A-Za-z0-9-]{1,64}$/;

/** What is wrong with a list of a map's things for its engine, which draws no thing it cannot name or tell apart (review
 * r1 of #1847, F2): one that is no object, has no id of letters, digits and `-` (64 at most) or no name, or repeats an
 * id of the same list. */
function mapThingsProblem(list: readonly unknown[], where: string): string | null {
	const seen = new Set<string>();
	for (const [index, thing] of list.entries()) {
		if (typeof thing !== "object" || thing === null || Array.isArray(thing))
			return `has a thing in ${where} that is no object (number ${index + 1})`;
		const { id, name } = thing as { id?: unknown; name?: unknown };
		if (typeof id !== "string" || !MAP_ID.test(id))
			return `has a thing in ${where} whose id is not letters, digits and - (number ${index + 1}): the page cannot draw it`;
		if (typeof name !== "string" || name.trim() === "") return `has a thing ${id} in ${where} with no name`;
		if (seen.has(id)) return `has the id ${id} twice in ${where}`;
		seen.add(id);
	}
	return null;
}

/** What is wrong with a map's data for its engine, or null: a first layer that is the company's reading or 3 to 7
 * things, layers of 1 to 12 things by a thing's id, at most four layers deep and 80 things in all; every thing
 * drawable (`mapThingsProblem`), so what save_app takes is what the page draws. */
function mapProblem(data: Readonly<Record<string, unknown>>): string | null {
	const things = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);
	const top = data.top;
	const first =
		top === "reading"
			? null
			: typeof top === "object" && top !== null
				? things((top as { things?: unknown }).things)
				: undefined;
	if (first === undefined) return 'needs top: "reading" for the company\'s reading, or an object with its things';
	if (first !== null && (first.length < MAP_BOUNDS.top[0] || first.length > MAP_BOUNDS.top[1]))
		return `needs ${MAP_BOUNDS.top[0]} to ${MAP_BOUNDS.top[1]} things in top: the map kit draws one picture of them`;
	const firstProblem = first === null ? null : mapThingsProblem(first, "top");
	if (firstProblem) return firstProblem;
	const layers = data.layers ?? {};
	if (typeof layers !== "object" || layers === null || Array.isArray(layers))
		return "has layers that are no object: each key is a thing's id, its value what is inside it";
	const inside = new Map<string, unknown[]>();
	for (const [id, layer] of Object.entries(layers)) {
		if (!MAP_ID.test(id)) return `has a layer ${id} whose key is not a thing's id (letters, digits and -)`;
		const list = typeof layer === "object" && layer !== null ? things((layer as { things?: unknown }).things) : null;
		if (!list || list.length < MAP_BOUNDS.layer[0] || list.length > MAP_BOUNDS.layer[1])
			return `has a layer ${id} without ${MAP_BOUNDS.layer[0]} to ${MAP_BOUNDS.layer[1]} things`;
		const listProblem = mapThingsProblem(list, `the layer ${id}`);
		if (listProblem) return listProblem;
		inside.set(id, list);
	}
	// From the first layer down, how deep the layers go; under the company's reading (whose things are live) each
	// layer no other layer holds stands under the first layer.
	const idOf = (thing: unknown) =>
		typeof thing === "object" && thing !== null && typeof (thing as { id?: unknown }).id === "string"
			? (thing as { id: string }).id
			: null;
	const deepest = (list: readonly unknown[], depth: number, seen: Set<string>): number => {
		let most = depth;
		for (const thing of list) {
			const id = idOf(thing);
			const below = id === null || seen.has(id) ? undefined : inside.get(id);
			if (!below) continue;
			most = Math.max(most, deepest(below, depth + 1, new Set([...seen, id as string])));
		}
		return most;
	};
	const held = new Set([...inside.values()].flatMap((list) => list.map(idOf)));
	const roots = first ?? [...inside.keys()].filter((id) => !held.has(id)).map((id) => ({ id }));
	const depth = deepest(roots, 1, new Set());
	const count = (first?.length ?? 0) + [...inside.values()].reduce((sum, list) => sum + list.length, 0);
	if (depth > MAP_BOUNDS.depth) return `goes ${depth} layers deep: the map kit opens ${MAP_BOUNDS.depth} at most`;
	if (count > MAP_BOUNDS.things) return `holds ${count} things: the map kit draws ${MAP_BOUNDS.things} at most`;
	return null;
}

/** The ring kit's bounds (packages/runtime/kits/ring/KIT.md): marks and wedges on one ring. */
export const RING_BOUNDS = Object.freeze({ marks: 12, wedges: 8 });
/** The ring's spans. */
const RING_SPANS: readonly unknown[] = ["year", "month", "week"];
const DAY_MS = 86_400_000;

/** A day as the ring kit takes it, `YYYY-MM-DD` of a real date, as its number of days since 1970; null for any other. */
function ringDay(value: unknown): number | null {
	const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
	if (!m) return null;
	const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	const day = new Date(time);
	return day.getUTCMonth() === Number(m[2]) - 1 && day.getUTCDate() === Number(m[3]) ? time / DAY_MS : null;
}

/** What is wrong with a ring's data for its engine, or null: a span it draws, dates it can place, and one mark or
 * wedge at least, within the kit's bounds and each named, so what save_app takes is what the page draws. */
function ringProblem(data: Readonly<Record<string, unknown>>): string | null {
	if (data.span !== undefined && !RING_SPANS.includes(data.span))
		return 'has a span the ring kit does not draw: "year", "month" or "week"';
	for (const key of ["start", "now"] as const)
		if (data[key] !== undefined && ringDay(data[key]) === null) return `has a ${key} that is not a date (YYYY-MM-DD)`;
	const marks = data.marks ?? [];
	const wedges = data.wedges ?? [];
	if (!Array.isArray(marks)) return "has marks that are no list";
	if (!Array.isArray(wedges)) return "has wedges that are no list";
	if (marks.length + wedges.length === 0)
		return "has no mark and no wedge: the ring kit has nothing to put on its ring";
	if (marks.length > RING_BOUNDS.marks)
		return `has ${marks.length} marks: the ring kit draws ${RING_BOUNDS.marks} at most`;
	if (wedges.length > RING_BOUNDS.wedges)
		return `has ${wedges.length} wedges: the ring kit draws ${RING_BOUNDS.wedges} at most`;
	const things: [string, readonly unknown[], readonly string[]][] = [
		["mark", marks, ["at"]],
		["wedge", wedges, ["from"]],
	];
	for (const [kind, list, needs] of things)
		for (const [index, thing] of list.entries()) {
			if (typeof thing !== "object" || thing === null || Array.isArray(thing))
				return `has a ${kind} that is no object (number ${index + 1})`;
			const each = thing as Record<string, unknown>;
			if (typeof each.name !== "string" || each.name.trim() === "")
				return `has a ${kind} with no name (number ${index + 1})`;
			for (const key of [...needs, ...(kind === "wedge" && each.to !== undefined ? ["to"] : [])])
				if (ringDay(each[key]) === null)
					return `has a ${kind} ${each.name} whose ${key} is not a date (YYYY-MM-DD)`;
		}
	return null;
}

/** The first day of a ring's span and the day after its last, as day numbers: the span that holds `start`, or the one
 * that holds the data's `now`, else `today`, as the engine draws it (a week given no start begins on a Monday). */
function ringSpan(data: Readonly<Record<string, unknown>>, clock: Date): readonly [number, number] {
	const span = RING_SPANS.includes(data.span) ? data.span : "year";
	const start = ringDay(data.start);
	const now = ringDay(data.now);
	const today = now === null ? clock : new Date(now * DAY_MS + 12 * 3_600_000);
	const local = now === null;
	const y = local ? today.getFullYear() : today.getUTCFullYear();
	const m = local ? today.getMonth() : today.getUTCMonth();
	const date = local ? today.getDate() : today.getUTCDate();
	const weekday = local ? today.getDay() : today.getUTCDay();
	const first =
		start !== null
			? new Date(start * DAY_MS)
			: new Date(
					span === "year"
						? Date.UTC(y, 0, 1)
						: span === "month"
							? Date.UTC(y, m, 1)
							: Date.UTC(y, m, date - ((weekday + 6) % 7)),
				);
	const end =
		span === "year"
			? Date.UTC(first.getUTCFullYear() + 1, first.getUTCMonth(), first.getUTCDate())
			: span === "month"
				? Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate())
				: first.getTime() + 7 * DAY_MS;
	return [first.getTime() / DAY_MS, end / DAY_MS];
}

/** The flow kit's bounds (packages/runtime/kits/flow/KIT.md): the ends a side may name, of which its page draws a few
 * and joins the rest into one band, and the bands straight through. */
export const FLOW_BOUNDS = Object.freeze({ side: 24, drawn: 6, links: 24 });

/** What is wrong with a flow's data for its engine, or null: one end at least on each side, each named and told apart,
 * and bands straight through that join ends it has. */
function flowProblem(data: Readonly<Record<string, unknown>>): string | null {
	const ids = new Map<string, Set<string>>();
	for (const side of ["from", "to"] as const) {
		const ends = data[side];
		if (!Array.isArray(ends) || ends.length === 0)
			return `has no end in ${side}: the flow kit draws a band from each`;
		if (ends.length > FLOW_BOUNDS.side)
			return `has ${ends.length} ends in ${side}: the flow kit takes ${FLOW_BOUNDS.side} at most`;
		const seen = new Set<string>();
		for (const [index, end] of ends.entries()) {
			if (typeof end !== "object" || end === null || Array.isArray(end))
				return `has an end in ${side} that is no object (number ${index + 1})`;
			const { id, name } = end as { id?: unknown; name?: unknown };
			if (typeof name !== "string" || name.trim() === "")
				return `has an end in ${side} with no name (number ${index + 1})`;
			if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)))
				return `has an end ${name} in ${side} whose id is not letters, digits and -`;
			const key = typeof id === "string" ? id : name.trim();
			if (seen.has(key)) return `has ${key} twice in ${side}`;
			seen.add(key);
		}
		ids.set(side, seen);
	}
	if (data.links === undefined) return null;
	if (!Array.isArray(data.links)) return "has links that are no list";
	if (data.links.length > FLOW_BOUNDS.links)
		return `has ${data.links.length} links: the flow kit draws ${FLOW_BOUNDS.links} at most`;
	for (const [index, link] of data.links.entries()) {
		const { from, to } = (typeof link === "object" && link !== null ? link : {}) as { from?: unknown; to?: unknown };
		if (typeof from !== "string" || !ids.get("from")?.has(from))
			return `has a link (number ${index + 1}) whose from is no id of an end in from`;
		if (typeof to !== "string" || !ids.get("to")?.has(to))
			return `has a link (number ${index + 1}) whose to is no id of an end in to`;
	}
	return null;
}

export const ROADMAP_BOUNDS = Object.freeze({ top: [2, 7], parts: 12, depth: 3, all: 80, agents: 4 });
const ROADMAP_STATES: readonly unknown[] = ["done", "now", "later", "open"];
const ROADMAP_STANDS: readonly unknown[] = ["in order", "side by side"];
const ROADMAP_PICTURE = /\.(?:png|jpe?g|webp)$/i;
const ROADMAP_DATES = ["date", "dates", "due", "when", "start", "end", "deadline", "year", "quarter", "month"];

type RoadmapNode = Readonly<Record<string, unknown>>;

const roadmapParts = (node: RoadmapNode): readonly unknown[] => (Array.isArray(node.parts) ? node.parts : []);

const roadmapPicture = (value: unknown): value is string => isOwnFile(value) && ROADMAP_PICTURE.test(value);

function roadmapProblem(data: RoadmapNode): string | null {
	if (typeof data.title !== "string" || data.title.trim() === "")
		return "needs a title: the ambition in a few words, drawn large over its picture";
	if (!Array.isArray(data.parts)) return "has parts that are no list: the products or fields the ambition spans";
	const [fewest, most] = ROADMAP_BOUNDS.top;
	if (data.parts.length < fewest || data.parts.length > most)
		return `needs ${fewest} to ${most} parts at its top, the products or fields the ambition spans: it has ${data.parts.length}`;
	let count = 0;
	const nodeProblem = (node: RoadmapNode, at: string): string | null => {
		const date = ROADMAP_DATES.find((key) => node[key] !== undefined);
		if (date) return `has a ${date} ${at}: a roadmap has no dates, the order of the parts is the order`;
		if (node.picture !== undefined && !roadmapPicture(node.picture))
			return `has a picture ${at} that is not the path of a .png, .jpg or .webp file in the app's folder, such as "pictures/tunnels.png"`;
		if (node.stand !== undefined && !ROADMAP_STANDS.includes(node.stand))
			return `has a stand ${at} that is not "in order" or "side by side"`;
		if (node.parts !== undefined && !Array.isArray(node.parts)) return `has parts ${at} that are no list`;
		return null;
	};
	const walk = (node: RoadmapNode, where: string, depth: number): string | null => {
		const problem = nodeProblem(node, depth === 0 ? "at its top" : `in ${where}`);
		if (problem) return problem;
		const parts = roadmapParts(node);
		if (depth > 0 && parts.length > ROADMAP_BOUNDS.parts)
			return `has ${parts.length} parts in ${where}: the roadmap kit draws ${ROADMAP_BOUNDS.parts} at most in one layer`;
		if (depth === ROADMAP_BOUNDS.depth && parts.length > 0)
			return `goes ${depth + 1} layers under its title in ${where}: the roadmap kit opens ${ROADMAP_BOUNDS.depth} at most`;
		for (const [index, part] of parts.entries()) {
			const inside = depth === 0 ? "its top" : where;
			if (typeof part !== "object" || part === null || Array.isArray(part))
				return `has a part in ${inside} that is no object (number ${index + 1})`;
			const each = part as RoadmapNode;
			if (typeof each.name !== "string" || each.name.trim() === "")
				return `has a part in ${inside} with no name (number ${index + 1})`;
			const name = each.name.trim();
			if (each.state === undefined) return `has a part ${name} with no state: "done", "now", "later" or "open"`;
			if (!ROADMAP_STATES.includes(each.state))
				return `has a part ${name} with a state the roadmap kit does not draw: "done", "now", "later" or "open"`;
			if (
				each.agents !== undefined &&
				!(
					Array.isArray(each.agents) &&
					each.agents.length <= ROADMAP_BOUNDS.agents &&
					each.agents.every((agent) => typeof agent === "string" && agent.trim() !== "")
				)
			)
				return `has agents in ${name} that are not 0 to ${ROADMAP_BOUNDS.agents} agents' names`;
			count++;
			const problem = walk(each, name, depth + 1);
			if (problem) return problem;
		}
		return null;
	};
	const problem = walk(data, "", 0);
	if (problem) return problem;
	if (count > ROADMAP_BOUNDS.all) return `holds ${count} parts: the roadmap kit draws ${ROADMAP_BOUNDS.all} at most`;
	return null;
}

export function roadmapNamesAgents(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return false;
	const node = data as RoadmapNode;
	return (Array.isArray(node.agents) && node.agents.length > 0) || roadmapParts(node).some(roadmapNamesAgents);
}

export function roadmapFirstPictures(data: RoadmapNode): string[] {
	const found: string[] = [];
	for (const node of [data, ...roadmapParts(data)]) {
		const picture = typeof node === "object" && node !== null ? (node as RoadmapNode).picture : undefined;
		if (roadmapPicture(picture) && !found.includes(picture)) found.push(picture);
	}
	return found;
}

function roadmapUnpictured(data: RoadmapNode): string[] {
	const found: string[] = [];
	const walk = (node: RoadmapNode) => {
		for (const part of roadmapParts(node)) {
			if (typeof part !== "object" || part === null) continue;
			const each = part as RoadmapNode;
			if (
				(each.state === "done" || each.state === "now") &&
				each.picture === undefined &&
				typeof each.name === "string"
			)
				found.push(each.name.trim());
			walk(each);
		}
	};
	walk(data);
	return found;
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
			if (isOwnFile(value) && MEDIA.test(value) && !found.includes(value)) found.push(value);
		} else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
		else if (typeof value === "object" && value !== null)
			for (const item of Object.values(value)) walk(item, depth + 1);
	};
	walk(data, 0);
	return found;
}

/**
 * The agents' figures a kit's data names (a field `figure` whose text is a figure's id, such as `"crown"`), once each,
 * in the data's order. The page carries each as a picture of its own (kitPage), since a page has no network and the
 * figures are not the app's files: an engine shows the asking agent or the maker by it.
 */
export function kitFigures(data: unknown): string[] {
	const found: string[] = [];
	const walk = (value: unknown, key: string, depth: number): void => {
		if (depth > 12) return;
		if (typeof value === "string") {
			if (key === "figure" && Object.hasOwn(KIT_FIGURES, value) && !found.includes(value)) found.push(value);
		} else if (Array.isArray(value)) for (const item of value) walk(item, key, depth + 1);
		else if (typeof value === "object" && value !== null)
			for (const [name, item] of Object.entries(value)) walk(item, name, depth + 1);
	};
	walk(data, "", 0);
	return found;
}

/**
 * The page of a data kit's app: the fallback look, the pictures and videos the data names that the folder holds
 * (`holds` by path relative to the app's folder; one it lacks is left out, and the engine draws a quiet placeholder)
 * and the agents' figures it names (`figure:<id>`, as data: URLs; a map's page carries all twelve),
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
		...(kit === "roadmap" ? roadmapFirstPictures(data) : kitMedia(data))
			.filter(holds)
			.map((path) =>
				VIDEO.test(path)
					? `<video data-kit-src="${escapeHtml(path)}" src="${escapeHtml(path)}" preload="metadata" muted playsinline></video>`
					: `<img data-kit-src="${escapeHtml(path)}" src="${escapeHtml(path)}" alt="">`,
			),
		// A map's agents are found when the page opens (its data names them, or the company's reading does), so its page
		// carries every figure.
		...(kit === "map" || (kit === "roadmap" && roadmapNamesAgents(data))
			? Object.keys(KIT_FIGURES)
			: kitFigures(data)
		).map((id) => `<img data-kit-src="figure:${id}" src="${KIT_FIGURES[id]}" alt="">`),
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
 * - A ring's marks and wedges outside its span (the one that holds `start`, or `today`), which its page does not draw.
 * - A flow's side of more ends than its page draws: the smallest join one band; and through the middle, two sides that
 *   differ by more than 1 %, whose difference the page draws as a band of its own.
 */
export function kitNotes(
	kit: DataKit,
	data: Readonly<Record<string, unknown>>,
	holds: (path: string) => boolean,
	today: Date = new Date(),
): string[] {
	const notes: string[] = [];
	const missing = kitMedia(data).filter((path) => !holds(path));
	if (missing.length > 0)
		notes.push(
			`${missing.length === 1 ? "1 picture or video is" : `${missing.length} pictures or videos are`} named in ${kitDataFile(kit)} but not in the app's folder (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}): the page shows a placeholder there. Write ${missing.length === 1 ? "it" : "them"} into the app's folder from a machine, then save the app again so the page names ${missing.length === 1 ? "it" : "them"}.`,
		);
	if (kit === "object") {
		const models = kitModels(kit, data);
		const environment = isOwnFile(data.environment) && HDR.test(data.environment) ? [data.environment] : [];
		const absent = [...models, ...environment].filter((path) => !holds(path));
		if (absent.length > 0)
			notes.push(
				`${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} named in ${kitDataFile(kit)} but not in the app's folder: the page shows the picture or turntable in ${absent.length === 1 ? "its" : "their"} place, or a line that the model could not be shown. Write ${absent.length === 1 ? "it" : "them"} into the app's folder from a machine.`,
			);
		const bare = [data, ...(Array.isArray(data.variants) ? data.variants : [])].filter((thing) => {
			const each = (typeof thing === "object" && thing !== null ? thing : {}) as Record<string, unknown>;
			return each.model !== undefined && each.turntable === undefined && each.picture === undefined;
		}).length;
		if (bare > 0)
			notes.push(
				`${bare === 1 ? "1 thing has" : `${bare} things have`} a model and no turntable or picture: give one beside the model, which the page shows while the model arrives and where a browser cannot draw 3D.`,
			);
	}
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
	if (kit === "ring") {
		const [first, after] = ringSpan(data, today);
		const day = (thing: unknown, key: string) =>
			ringDay(typeof thing === "object" && thing !== null ? (thing as Record<string, unknown>)[key] : null);
		const outside = (thing: unknown, from: string, to: string) => {
			const a = day(thing, from);
			const b = day(thing, to) ?? a;
			return a !== null && b !== null && (Math.max(a, b) < first || Math.min(a, b) >= after);
		};
		const count =
			(Array.isArray(data.marks) ? data.marks.filter((mark) => outside(mark, "at", "at")).length : 0) +
			(Array.isArray(data.wedges) ? data.wedges.filter((wedge) => outside(wedge, "from", "to")).length : 0);
		const date = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
		if (count > 0)
			notes.push(
				`${count === 1 ? "1 mark or wedge is" : `${count} marks or wedges are`} outside the ring's ${typeof data.span === "string" ? data.span : "year"}, ${date(first)} to ${date(after - 1)}: the page leaves ${count === 1 ? "it" : "them"} out. Give start, or take ${count === 1 ? "it" : "them"} away.`,
			);
	}
	if (kit === "roadmap") {
		const bare = roadmapUnpictured(data);
		if (bare.length > 0)
			notes.push(
				`${bare.length === 1 ? "1 part that is done or now has" : `${bare.length} parts that are done or now have`} no picture (${bare.slice(0, 3).join(", ")}${bare.length > 3 ? ", …" : ""}): a part reached is shown by a picture of the world it made. Make ${bare.length === 1 ? "it" : "them"} with make_picture into the app's pictures/ folder, name ${bare.length === 1 ? "it" : "them"} in picture and save again.`,
			);
	}
	if (kit === "flow") {
		// with links, only the ends a link joins are drawn (the engine leaves the others out before it joins any)
		// links as the engine reads them: a list with one link at least, else bands through the middle
		const links = Array.isArray(data.links) && data.links.length > 0 ? data.links : null;
		const linked = links
			? new Set(
					links.flatMap((link) =>
						typeof link === "object" && link !== null
							? [(link as { from?: unknown }).from, (link as { to?: unknown }).to]
							: [],
					),
				)
			: null;
		for (const side of ["from", "to"] as const) {
			const list = data[side];
			const ends = (Array.isArray(list) ? list : []).filter((end) => {
				if (linked === null) return true;
				const { id, name } = (typeof end === "object" && end !== null ? end : {}) as {
					id?: unknown;
					name?: unknown;
				};
				return linked.has(typeof id === "string" ? id : typeof name === "string" ? name.trim() : null);
			}).length;
			const shown = FLOW_BOUNDS.drawn - 1;
			if (ends > FLOW_BOUNDS.drawn)
				notes.push(
					`${side} has ${ends} ends to draw: the page draws ${shown} of them (the largest, and a kept one always) and joins the other ${ends - shown} into one band (words.other). Fewer bands read better.`,
				);
		}
		// through the middle both sides are the same money: what does not add up is drawn as a band of its own
		const sum = (side: unknown): number | null => {
			if (!Array.isArray(side)) return null;
			let total = 0;
			for (const end of side) {
				const value = typeof end === "object" && end !== null ? (end as { value?: unknown }).value : undefined;
				if (typeof value !== "number" || !Number.isFinite(value)) return null;
				total += Math.max(0, value);
			}
			return total;
		};
		const came = sum(data.from);
		const went = sum(data.to);
		if (links === null && came !== null && went !== null && Math.abs(came - went) > Math.max(came, went) * 0.01) {
			const amount = (n: number) => new Intl.NumberFormat("en").format(n);
			notes.push(
				`from adds up to ${amount(came)} and to to ${amount(went)}: the page draws the ${amount(Math.abs(came - went))} between them as a quiet band, ${came > went ? "going out" : "coming in"} (words.rest, "Not accounted for"). Give the end it is, such as what was kept, so the two sides add up.`,
			);
		}
	}
	return notes;
}
