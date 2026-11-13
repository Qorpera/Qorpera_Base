import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { APP_KITS, parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import {
	DATA_KITS,
	KIT_DATA_MAX_BYTES,
	KIT_ENGINE_JS,
	KIT_FALLBACK_STYLE,
	KIT_GUIDE,
	kitDataFile,
	kitMedia,
	kitNotes,
	kitPage,
	parseKitData,
} from "@qorpera/runtime/cloud-app-kits";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

/* The data kits of interface apps (RUNTIME-INTERFACE-APPS.md §3b; Jonas, 13 November 2026: apps "are supposed to be
 * objects, models, apps and videos that are visual-first to let you see the company"): each engine's and guide's text
 * as the runtime holds it, the page save_app writes around an agent's data, what a read of the data tells its maker,
 * and save_app making and changing such an app. The engines run in a browser; they are looked at there. */

const kitFile = (kit: string, name: string) => readFileSync(new URL(`../kits/${kit}/${name}`, import.meta.url), "utf8");

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue) => {
		const parsed = tool(name).parseArguments(value);
		const prepared = (await tool(name).prepare?.(parsed, f.context)) ?? parsed;
		return tool(name).execute(prepared, f.context);
	};
	return { ...f, tool, call };
}
const read = (content: CloudToolContent) => JSON.parse(String(content.value));
async function refuses(call: Promise<unknown>, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(text);
}
const save = (name: string, key: string, manifest: JsonValue, files: { path: string; text: string }[]) => ({
	name,
	operationKey: key,
	manifest,
	files,
});

const MODEL = {
	lang: "da",
	title: "Forretningsmodel",
	groups: [
		{
			label: "Kunden betaler",
			inputs: [{ id: "pris", label: "Pris", min: 0, max: 100, start: 50, state: "unknown" }],
		},
	],
};
const BOARD = {
	lang: "da",
	mode: "scale",
	title: "Marked",
	items: [
		{ id: "a", name: "Arc One", picture: "pictures/arc-one.webp", source: "https://example.com/arc.webp" },
		{ id: "b", name: "Halo", picture: "pictures/halo.webp", video: "film/halo.mp4" },
	],
};

it("names the data kits as the kits an app can be made from", () => {
	expect([...APP_KITS]).toEqual(["explainer", ...DATA_KITS]);
	expect([...DATA_KITS]).toEqual(["model", "board", "path", "object"]);
	expect(DATA_KITS.map(kitDataFile)).toEqual(["model.json", "board.json", "path.json", "object.json"]);
});

it("holds each kit's engine and guide exactly as its source files have them", () => {
	// A change to kits/<kit>/engine.js or KIT.md reaches no app and no agent until `npm run generate:app-kits` has run.
	for (const kit of DATA_KITS) {
		expect(KIT_ENGINE_JS[kit], kit).toBe(kitFile(kit, "engine.js"));
		expect(KIT_GUIDE[kit], kit).toBe(kitFile(kit, "KIT.md"));
		// One function around everything, which reads its data through the bridge and never from the network.
		expect(KIT_ENGINE_JS[kit].trimEnd().endsWith("})();"), kit).toBe(true);
		expect(KIT_ENGINE_JS[kit], kit).toContain("QORPERA_KIT");
		expect(KIT_ENGINE_JS[kit], kit).toMatch(/\.read\(`apps\/\$\{/);
		expect(KIT_ENGINE_JS[kit], kit).not.toMatch(/\bfetch\(|XMLHttpRequest|\bimport\(|https?:\/\/(?!www\.w3\.org\/)/);
		// It compiles as a script (compiled here, never run: an engine runs in a browser, where it is looked at).
		expect(() => new Script(KIT_ENGINE_JS[kit]), kit).not.toThrow();
		// An engine is one file of an app, which loads at most 512 KiB of it.
		expect(Buffer.byteLength(KIT_ENGINE_JS[kit]), kit).toBeLessThan(128 * 1024);
		// A guide is written for an agent, and small enough that the four sit in one schema with room to spare.
		expect(Buffer.byteLength(KIT_GUIDE[kit]), kit).toBeLessThan(4608);
		// Each guide's example is data its own kit reads.
		const example = /```json\n([\s\S]*?)\n```/.exec(KIT_GUIDE[kit])?.[1] ?? "";
		expect(parseKitData(kit, example), kit).toHaveProperty("data");
	}
});

it("tells an agent on kit what each kit draws and what its one file holds", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	expect(Buffer.byteLength(tool.description)).toBeLessThanOrEqual(4096);
	for (const said of [
		"lets members see and handle one thing of the company (an object to turn, a model to try, an app to use, a video to watch)",
		"It is never a document or a report: text to read stays a file in the folder.",
		"kit: the form Qorpera draws for you, of explainer, model, board, path, object",
		"Nearly every app is made from a kit: you write the kit's one file among files (its data, <kit>.json; an explainer's scenes.js) and save_app writes the page and the engine",
		"A kit's page shows the pictures its data names that are in the folder when you save: write them first, or save the data again after.",
		// A page written by hand follows the kits.
		"Labels and numbers, never sentences; no boxes of text, no date, no list of what you did.",
		"What is not known yet is drawn as open, such as a dashed outline or a question mark, never written about.",
	])
		expect(tool.description).toContain(said);
	const kit = (
		tool.inputSchema as {
			properties: { manifest: { properties: { kit: { enum: unknown[]; description: string } } } };
		}
	).properties.manifest.properties.kit;
	expect(kit.enum).toEqual(["explainer", "model", "board", "path", "object", null]);
	for (const said of [
		"model: how something works in numbers, such as a business model, a price, costs or capacity.",
		"board: real things as pictures, such as a market's products on one scale, directions to choose between, or a wall of references.",
		"path: a way through steps with the evidence for each, such as customers from need to purchase, a funnel or a supply route.",
		"object: a physical thing a member turns in the hand.",
		"save_app writes engine.js and index.html: never write or edit those two",
		"what nobody knows yet is marked unknown, which the page draws as open: never guess it and never write about it",
	])
		expect(kit.description).toContain(said);
	// Each kit's own guide is there whole, as its file has it.
	for (const each of DATA_KITS) expect(kit.description, each).toContain(KIT_GUIDE[each].trim());
	// A tool's schema holds 64 KiB: the kits' guides leave most of it.
	expect(Buffer.byteLength(JSON.stringify(tool.inputSchema))).toBeLessThan(48 * 1024);
});

it("finds the pictures and videos a kit's data names in the app's own folder", () => {
	expect(kitMedia(BOARD)).toEqual(["pictures/arc-one.webp", "pictures/halo.webp", "film/halo.mp4"]);
	// Once each, wherever it stands; an address, a path out of the folder and a path from the top are not the app's.
	expect(
		kitMedia({
			a: ["logo.svg", { b: "logo.svg", c: "https://example.com/x.png", d: "folder:research/y.png" }],
			e: "../other/z.png",
			f: "/top.png",
			g: 'pictures/"x".png',
			h: "notes.md",
			i: 12,
			j: null,
		}),
	).toEqual(["logo.svg"]);
});

it("writes a kit's page that names its pictures, reads its data, and opens outside Qorpera too", () => {
	const page = kitPage("marked", "board", "Marked <og> leverandører", BOARD, (path) => path !== "film/halo.mp4");
	expect(page.startsWith('<!doctype html>\n<html lang="da">\n<head>\n<meta charset="utf-8">\n')).toBe(true);
	// It follows light and dark, and carries Qorpera's plain look for where the web gives it no base style (a concept).
	expect(page).toContain('<meta name="color-scheme" content="light dark">');
	expect(page).toContain(`<style>${KIT_FALLBACK_STYLE}</style>`);
	expect(KIT_FALLBACK_STYLE).toMatch(/^@layer qorpera-base\{:where\(:root\)\{/);
	expect(page).toContain("<title>Marked &lt;og&gt; leverandører</title>");
	// A page in the app's frame gets its pictures only where it names them: every one the folder holds, none it lacks.
	expect(page).toContain('<img data-kit-src="pictures/arc-one.webp" src="pictures/arc-one.webp" alt="">');
	expect(page).toContain('<img data-kit-src="pictures/halo.webp" src="pictures/halo.webp" alt="">');
	expect(page).not.toContain('film/halo.mp4" src=');
	expect(kitPage("marked", "board", "Marked", BOARD, () => true)).toContain(
		'<video data-kit-src="film/halo.mp4" src="film/halo.mp4" preload="metadata" muted playsinline></video>',
	);
	// Which app and data file the engine reads, then the engine.
	expect(page).toContain('window.QORPERA_KIT = {"app":"marked","kit":"board","data":"board.json"};');
	expect(page.trimEnd().endsWith('<script src="engine.js"></script>\n</body>\n</html>')).toBe(true);
	// The data as it was saved, for an agent that opens the page on a machine to look at it: nothing in it ends the
	// script, and outside Qorpera a read of the data file answers it.
	const tricky = kitPage("m", "model", "M", { ...MODEL, line: "</script><script>alert(1)</script>" }, () => true);
	expect(tricky).not.toContain("</script><script>alert(1)");
	const packed = /<script type="application\/json" id="kit-data">(.*)<\/script>/.exec(tricky)?.[1] ?? "";
	expect(JSON.parse(packed)).toEqual({ ...MODEL, line: "</script><script>alert(1)</script>" });
	expect(tricky).toContain("if(!window.qorpera){");
	// A language the data does not give as a code leaves the page in English.
	expect(kitPage("m", "model", "M", { ...MODEL, lang: "dansk<" }, () => true)).toContain('<html lang="en">');
});

/* Live values from the company's databases: where a kit takes a number, its data may name a question of a database
 * instead. The page's own script, before the engine, puts the current number in its place. */

const ORDERS = {
	lang: "en",
	title: "Orders",
	groups: [
		{
			label: "Shop",
			inputs: [
				{
					id: "orders",
					label: "Orders",
					min: 0,
					max: 1000,
					value: { query: "shop/month", column: "orders", example: 120 },
				},
				{
					id: "revenue",
					label: "Revenue",
					min: 0,
					max: 99000,
					state: "assumed",
					value: { query: "shop/month", column: "revenue" },
				},
				{
					id: "visits",
					label: "Visits",
					min: 0,
					max: 9000,
					start: 500,
					state: "unknown",
					value: { query: "shop/visits", params: { days: 30 } },
				},
			],
		},
	],
};
const BOUND = ["/groups/0/inputs/0/value", "/groups/0/inputs/1/value", "/groups/0/inputs/2/value"];

/** The script a kit's page runs before its engine, as kitPage writes it. */
const pageScript = (page: string) => /<script>(window\.QORPERA_KIT = [^\n]*)<\/script>/.exec(page)?.[1] ?? "";

interface LiveKit {
	load(): Promise<string>;
	onLive(listener: () => void): void;
	live: string[];
	changed: string[];
}
type Row = Record<string, number | string | null>;

/** A company's databases as the bridge gives them to a page: each question's answer, given to a watch at once and
 * again when it changed. `fail` is an ask that failed, as the bridge hands it on. */
function databases(answers: Record<string, Row>) {
	const now = new Map(Object.entries(answers));
	const watches: { name: string; listener: (answer: unknown) => void; stopped: boolean }[] = [];
	const answer = (row: Row) => ({
		columns: Object.keys(row),
		rows: [row],
		more: false,
		asOf: new Date().toISOString(),
	});
	const watch = vi.fn((name: string, _params: Record<string, unknown>, listener: (answer: unknown) => void) => {
		const one = { name, listener, stopped: false };
		watches.push(one);
		const row = now.get(name);
		if (row) queueMicrotask(() => listener(answer(row)));
		return () => {
			one.stopped = true;
		};
	});
	const tell = (name: string, given: unknown) => {
		for (const one of watches) if (one.name === name && !one.stopped) one.listener(given);
	};
	const set = (name: string, row: Row) => {
		now.set(name, row);
		tell(name, answer(row));
	};
	const fail = (name: string) => tell(name, { error: "The database is busy." });
	return { watch, set, fail, watches };
}

/** A kit's page opened on a stand-in window, with the bridge it is given (none: outside Qorpera) and its frames, which
 * are drawn by hand. */
function openPage(data: Record<string, unknown>, qorpera?: Record<string, unknown>) {
	const page = kitPage("orders", "model", "Orders", data, () => true);
	const saved = /<script type="application\/json" id="kit-data">(.*)<\/script>/.exec(page)?.[1] ?? "";
	const frames: (() => void)[] = [];
	const window: Record<string, unknown> = {
		qorpera,
		requestAnimationFrame: (frame: () => void) => frames.push(frame),
	};
	new Function("window", "document", pageScript(page))(window, { getElementById: () => ({ textContent: saved }) });
	const drawFrames = () => {
		for (const frame of frames.splice(0)) frame();
	};
	return { kit: window.QORPERA_KIT as LiveKit, drawFrames };
}
const inside = (data: Record<string, unknown>, db: ReturnType<typeof databases>) =>
	openPage(data, { read: vi.fn(async () => JSON.stringify(data)), watch: db.watch, onChange() {} });
interface Input {
	readonly id: string;
	readonly value: unknown;
	readonly state?: string;
	readonly start?: number;
}
/** Each input of the model as the engine gets it: its id, value, state and start. */
const inputs = (text: string) =>
	(JSON.parse(text) as { groups: { inputs: Input[] }[] }).groups[0].inputs.map(({ id, value, state, start }) => ({
		id,
		value,
		state,
		start,
	}));

it("writes the live values' script into every kit's page, small and before the engine", () => {
	const page = kitPage("orders", "model", "Orders", ORDERS, () => true);
	const script = pageScript(page);
	expect(script).toContain("if(!window.qorpera){");
	expect(script).toContain("K.load=()=>");
	expect(script).toContain("K.onLive=");
	expect(page.indexOf(script)).toBeLessThan(page.indexOf('<script src="engine.js"></script>'));
	expect(() => new Script(script)).not.toThrow();
	// Every app of a kit carries it.
	expect(Buffer.byteLength(script)).toBeLessThan(3584);
	expect(pageScript(kitPage("marked", "board", "Marked", BOARD, () => true))).toContain("K.load=()=>");
});

it("puts each live value's number in its place and asks each question once", async () => {
	const db = databases({ "shop/month": { orders: 340, revenue: "51000.50" }, "shop/visits": { visits: 4200 } });
	const { kit } = inside(ORDERS, db);
	expect(inputs(await kit.load())).toEqual([
		{ id: "orders", value: 340, state: "known" },
		// A number the database gives as text is a number.
		{ id: "revenue", value: 51000.5, state: "known" },
		// With no column, the first column is the value.
		{ id: "visits", value: 4200, state: "known", start: 500 },
	]);
	// Two values of one question are one watch; a question with params is its own.
	expect(db.watch).toHaveBeenCalledTimes(2);
	expect(db.watch.mock.calls.map(([name, params]) => [name, params])).toEqual([
		["shop/month", {}],
		["shop/visits", { days: 30 }],
	]);
	expect(kit.live).toEqual(BOUND);
	expect(kit.changed).toEqual([]);
	await kit.load();
	expect(db.watch).toHaveBeenCalledTimes(2);
	// Data with no live value is the text as it is stored, and its questions are no longer watched.
	const plain = JSON.stringify(MODEL);
	const read = vi.fn(async () => plain);
	const { kit: kept } = openPage(MODEL, { read, watch: db.watch, onChange() {} });
	expect(await kept.load()).toBe(plain);
	expect(kept.live).toEqual([]);
	let text = JSON.stringify(ORDERS);
	const { kit: moving } = openPage(ORDERS, { read: async () => text, watch: db.watch, onChange() {} });
	await moving.load();
	text = JSON.stringify(MODEL);
	await moving.load();
	expect(db.watches.slice(2).map((one) => one.stopped)).toEqual([true, true]);
});

it("tells the engine once a frame when a value moved, and which moved", async () => {
	const db = databases({ "shop/month": { orders: 340, revenue: 51000 }, "shop/visits": { visits: 4200 } });
	const { kit, drawFrames } = inside(ORDERS, db);
	const live = vi.fn();
	const broken = vi.fn(() => {
		throw new Error("An engine's own mistake");
	});
	kit.onLive(broken);
	kit.onLive(live);
	await kit.load();
	db.set("shop/month", { orders: 350, revenue: 51000 });
	db.set("shop/month", { orders: 360, revenue: 51000 });
	expect(live).not.toHaveBeenCalled();
	drawFrames();
	expect(live).toHaveBeenCalledTimes(1);
	drawFrames();
	expect(live).toHaveBeenCalledTimes(1);
	expect(inputs(await kit.load())[0]).toEqual({ id: "orders", value: 360, state: "known" });
	expect(kit.changed).toEqual(["/groups/0/inputs/0/value"]);
	// The same answer again is no change.
	db.set("shop/month", { orders: 360, revenue: 51000 });
	drawFrames();
	expect(live).toHaveBeenCalledTimes(1);
	await kit.load();
	expect(kit.changed).toEqual([]);
});

it("keeps the last good answer when a later ask fails", async () => {
	const db = databases({ "shop/month": { orders: 340, revenue: 51000 }, "shop/visits": { visits: 4200 } });
	const { kit, drawFrames } = inside(ORDERS, db);
	const live = vi.fn();
	kit.onLive(live);
	await kit.load();
	db.fail("shop/month");
	drawFrames();
	expect(live).not.toHaveBeenCalled();
	expect(inputs(await kit.load()).slice(0, 2)).toEqual([
		{ id: "orders", value: 340, state: "known" },
		{ id: "revenue", value: 51000, state: "known" },
	]);
	expect(kit.changed).toEqual([]);
	// A bridge whose watch throws gives the engine no value there, and no mistake.
	const { kit: refused } = openPage(ORDERS, {
		read: async () => JSON.stringify(ORDERS),
		watch: () => {
			throw new Error("Not now.");
		},
		onChange() {},
	});
	expect(inputs(await refused.load()).map(({ value, state }) => [value, state])).toEqual([
		[null, "unknown"],
		[null, "unknown"],
		[null, "unknown"],
	]);
});

it("loads one at a time, so a load asked for while one waits on its read ends in the newer answer", async () => {
	const db = databases({ "shop/month": { orders: 340, revenue: 51000 }, "shop/visits": { visits: 4200 } });
	const reads: ((text: string) => void)[] = [];
	const read = vi.fn(() => new Promise<string>((done) => reads.push(done)));
	const { kit, drawFrames } = openPage(ORDERS, { read, watch: db.watch, onChange() {} });
	const live = vi.fn();
	kit.onLive(live);
	const turn = () => new Promise((done) => setTimeout(done, 0));
	const first = kit.load();
	await turn();
	reads.shift()?.(JSON.stringify(ORDERS));
	await first;
	// A load waits on its read when the answer moves, and the engine asks for another load.
	const older = kit.load();
	await turn();
	db.set("shop/month", { orders: 350, revenue: 51000 });
	drawFrames();
	expect(live).toHaveBeenCalledTimes(1);
	const newer = kit.load();
	await turn();
	// The newer load reads only once the older one is done.
	expect(read).toHaveBeenCalledTimes(2);
	reads.shift()?.(JSON.stringify(ORDERS));
	expect(inputs(await older)[0]).toEqual({ id: "orders", value: 350, state: "known" });
	await turn();
	expect(read).toHaveBeenCalledTimes(3);
	reads.shift()?.(JSON.stringify(ORDERS));
	expect(inputs(await newer)[0]).toEqual({ id: "orders", value: 350, state: "known" });
	expect(kit.changed).toEqual([]);
});

it("waits a few seconds at most for the first answers, and a later one comes through onLive", async () => {
	vi.useFakeTimers();
	try {
		const db = databases({ "shop/visits": { visits: 4200 } });
		const { kit, drawFrames } = inside(ORDERS, db);
		const live = vi.fn();
		kit.onLive(live);
		let text: string | null = null;
		void kit.load().then((loaded) => {
			text = loaded;
		});
		await vi.advanceTimersByTimeAsync(2999);
		expect(text).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		// Not known yet, never the example inside Qorpera; an input's start stays where the slider waits.
		expect(inputs(text ?? "")).toEqual([
			{ id: "orders", value: null, state: "unknown" },
			{ id: "revenue", value: null, state: "unknown" },
			{ id: "visits", value: 4200, state: "known", start: 500 },
		]);
		db.set("shop/month", { orders: 340, revenue: 51000 });
		drawFrames();
		expect(live).toHaveBeenCalledTimes(1);
		expect(inputs(await kit.load())[0]).toEqual({ id: "orders", value: 340, state: "known" });
		expect(kit.changed).toEqual(["/groups/0/inputs/0/value", "/groups/0/inputs/1/value"]);
	} finally {
		vi.useRealTimers();
	}
});

it("shows a live value's example outside Qorpera and in a web app with no watch, and else not known", async () => {
	const examples = [
		{ id: "orders", value: 120, state: "assumed" },
		{ id: "revenue", value: null, state: "unknown" },
		{ id: "visits", value: null, state: "unknown", start: 500 },
	];
	const { kit } = openPage(ORDERS);
	expect(inputs(await kit.load())).toEqual(examples);
	expect(kit.live).toEqual(BOUND);
	const { kit: older } = openPage(ORDERS, { read: async () => JSON.stringify(ORDERS), onChange() {} });
	expect(inputs(await older.load())).toEqual(examples);
});

it("reads a kit's data, or says in words why it does not read", () => {
	expect(parseKitData("model", JSON.stringify(MODEL))).toEqual({ data: MODEL });
	const problem = (kit: (typeof DATA_KITS)[number], text: string) => {
		const parsed = parseKitData(kit, text);
		return "problem" in parsed ? parsed.problem : null;
	};
	expect(problem("model", "{")).toMatch(/^model\.json is not JSON: /);
	expect(problem("model", "[1]")).toBe("model.json must be one JSON object");
	expect(problem("model", '"text"')).toBe("model.json must be one JSON object");
	expect(problem("model", "{}")).toBe("model.json has no groups: the model kit draws nothing without");
	expect(problem("board", '{"mode": "scale"}')).toBe("board.json has no items: the board kit draws nothing without");
	expect(problem("path", "{}")).toBe("path.json has no steps and no lanes: the path kit draws nothing without");
	expect(problem("object", "{}")).toBe(
		"object.json has no turntable, picture or variants: the object kit has no thing to show",
	);
	expect(problem("object", '{"picture": "pictures/box.webp"}')).toBeNull();
	expect(problem("model", JSON.stringify({ ...MODEL, pad: "x".repeat(KIT_DATA_MAX_BYTES) }))).toBe(
		"model.json is larger than 256 KiB: it holds the facts and the names of the pictures, never the pictures or the long text",
	);
});

it("tells the maker which pictures the folder lacks and which texts the page cuts", () => {
	expect(kitNotes("board", BOARD, () => true)).toEqual([]);
	expect(kitNotes("board", BOARD, (path) => path === "pictures/halo.webp")).toEqual([
		"2 pictures or videos are named in board.json but not in the app's folder (pictures/arc-one.webp, film/halo.mp4): the page shows a placeholder there. Write them into the app's folder from a machine, then save the app again so the page names them.",
	]);
	expect(kitNotes("board", { ...BOARD, items: [BOARD.items[0]] }, () => false)).toEqual([
		"1 picture or video is named in board.json but not in the app's folder (pictures/arc-one.webp): the page shows a placeholder there. Write it into the app's folder from a machine, then save the app again so the page names it.",
	]);
	// A page of a kit holds names, numbers and notes of a line: a paragraph is cut, and its maker is told. A link, a
	// formula and a part's track are not read by a member.
	const long =
		"A sentence that goes on and on about what the team did and why, well past what a label holds on a page.";
	expect(
		kitNotes(
			"model",
			{
				...MODEL,
				line: long,
				computed: [{ id: "x", formula: `${"pris + ".repeat(40)}1` }],
				source: `folder:${long}`,
			},
			() => true,
		),
	).toEqual([
		"1 text is longer than a model page shows (in line): the page cuts it. A kit's page holds names, numbers and notes of a line; the reasoning stays in its file, linked as a source.",
	]);
});

it("makes an app from a data kit: the agent's data, Qorpera's engine and page", async () => {
	const f = await fixture();
	const made = read(
		await f.call(
			"save_app",
			save("forretningsmodel", "make-1", { title: "Forretningsmodel", kit: "model", emblem: "coin" }, [
				{ path: "model.json", text: JSON.stringify(MODEL) },
			]),
		),
	);
	expect(made).toMatchObject({ state: "applied", created: true, link: "app:forretningsmodel" });
	expect(made).not.toHaveProperty("look");
	const manifest = parseAppManifest(f.text("apps/forretningsmodel/app.toml") ?? "");
	expect(manifest.ok && manifest.manifest).toMatchObject({
		name: "Forretningsmodel",
		kit: "model",
		entry: "index.html",
	});
	expect(f.text("apps/forretningsmodel/model.json")).toBe(JSON.stringify(MODEL));
	expect(f.text("apps/forretningsmodel/engine.js")).toBe(KIT_ENGINE_JS.model);
	expect(f.text("apps/forretningsmodel/index.html")).toBe(
		kitPage("forretningsmodel", "model", "Forretningsmodel", MODEL, () => false),
	);
	// The kit's own two files are never the agent's to write, and neither is a page of its own.
	await refuses(
		f.call("save_app", save("forretningsmodel", "own-1", null, [{ path: "engine.js", text: "alert(1)" }])),
		"APP_KIT_FILE: engine.js is the model kit's own file, which save_app writes; leave it out and give model.json",
	);
	await refuses(
		f.call("save_app", save("forretningsmodel", "own-2", null, [{ path: "index.html", text: "<p>Mine</p>" }])),
		"APP_KIT_FILE: index.html is the model kit's own file",
	);
	// New data changes the data alone: the page names the same things and the engine is this runtime's.
	const next = { ...MODEL, line: "Hvad ét sæt efterlader" };
	const changed = read(
		await f.call(
			"save_app",
			save("forretningsmodel", "change-1", null, [{ path: "model.json", text: JSON.stringify(next) }]),
		),
	);
	expect(changed.state).toBe("applied");
	expect(changed.files.map((file: { path: string }) => file.path).sort()).toEqual([
		"apps/forretningsmodel/index.html",
		"apps/forretningsmodel/model.json",
	]);
	expect(f.text("apps/forretningsmodel/index.html")).toBe(
		kitPage("forretningsmodel", "model", "Forretningsmodel", next, () => false),
	);
});

it("refuses a data kit's app with no data, or with data its engine cannot read", async () => {
	const f = await fixture();
	await refuses(
		f.call(
			"save_app",
			save("marked", "make-1", { title: "Marked", kit: "board" }, [{ path: "notes.md", text: "x" }]),
		),
		"APP_DATA_MISSING: a new board app needs its board.json among files",
	);
	await refuses(
		f.call(
			"save_app",
			save("marked", "make-2", { title: "Marked", kit: "board" }, [
				{ path: "board.json", text: '{"mode": "scale"}' },
			]),
		),
		"APP_DATA_INVALID: board.json has no items: the board kit draws nothing without",
	);
	await refuses(
		f.call(
			"save_app",
			save("marked", "make-3", { title: "Marked", kit: "board" }, [{ path: "board.json", text: "{" }]),
		),
		"APP_DATA_INVALID: board.json is not JSON",
	);
	expect(f.folders.has("apps/marked")).toBe(false);
});

it("names in the page the pictures the folder holds, and says which it lacks", async () => {
	// A machine wrote one of the two pictures into the app's folder before the app was saved.
	const f = await fixture({
		folders: ["apps", "apps/marked", "apps/marked/pictures"],
		files: { "apps/marked/pictures/halo.webp": "RIFF" },
	});
	const made = read(
		await f.call(
			"save_app",
			save("marked", "make-1", { title: "Marked", kit: "board" }, [
				{ path: "board.json", text: JSON.stringify(BOARD) },
			]),
		),
	);
	expect(made.state).toBe("applied");
	expect(made.look).toEqual([
		"2 pictures or videos are named in board.json but not in the app's folder (pictures/arc-one.webp, film/halo.mp4): the page shows a placeholder there. Write them into the app's folder from a machine, then save the app again so the page names them.",
	]);
	const page = f.text("apps/marked/index.html");
	expect(page).toContain('data-kit-src="pictures/halo.webp"');
	expect(page).not.toContain('data-kit-src="pictures/arc-one.webp"');
});
