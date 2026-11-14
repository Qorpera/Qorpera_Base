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
	KIT_LIVE_QUESTIONS,
	kitBindings,
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
		// A kit's words name the button of a note to the app's owner, which save_app's kits paragraph explains once.
		expect(KIT_GUIDE[kit], kit).toMatch(/`tell`, `told`\./);
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
		// A note to the app's owner (qorpera.tell), said once for the four kits.
		'Every kit\'s words may hold tell, the label of the button with which a member sends you a note about the thing they opened, naming you ("Ask Luna"), and told, what it says once the note went;',
		"a thing a member opens (a board's item, a path lane's step, an object's part, a model's input) may hold ask, a draft for that note (≤40 characters).",
		"Such a note reaches you as the member's message, under a first line that names the app and the thing.",
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
	// A concept's page says so, and its engine then draws no title block and keeps almost nothing around the stage
	// (Jonas, 13 November 2026: "minimize the borders/framing around the visual we are just trying to show"). Any
	// other page is as it was, byte for byte.
	expect(kitPage("marked", "board", "Marked", BOARD, () => true, true)).toContain(
		'window.QORPERA_KIT = {"app":"marked","kit":"board","data":"board.json","concept":true};',
	);
	expect(kitPage("marked", "board", "Marked", BOARD, () => true, false)).toBe(
		kitPage("marked", "board", "Marked", BOARD, () => true),
	);
	expect(page.trimEnd().endsWith('<script src="engine.js"></script>\n</body>\n</html>')).toBe(true);
	// The data as it was saved, for an agent that opens the page on a machine to look at it: nothing in it ends the
	// script, and outside Qorpera a read of the data file answers it.
	const tricky = kitPage("m", "model", "M", { ...MODEL, line: "</script><script>alert(1)</script>" }, () => true);
	expect(tricky).not.toContain("</script><script>alert(1)");
	const packed = /<script type="application\/json" id="kit-data">(.*)<\/script>/.exec(tricky)?.[1] ?? "";
	expect(JSON.parse(packed)).toEqual({ ...MODEL, line: "</script><script>alert(1)</script>" });
	expect(tricky).toContain("if(!window.qorpera){");
	// Outside Qorpera the page's own `qorpera` has no `tell`, so a kit draws no button for a note to the app's owner.
	expect(page).not.toContain("tell");
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
	expect(Buffer.byteLength(script)).toBeLessThan(4096);
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

it("takes a watch the bridge could not start as no answer at once, keeps its last answer, and tries it again after a wait", async () => {
	vi.useFakeTimers();
	try {
		const db = databases({ "shop/visits": { visits: 4200 } });
		// The bridge refuses shop/month until it is allowed, and then answers it once and gives up on it.
		let allowed = false;
		const watch = vi.fn(
			(
				name: string,
				params: Record<string, unknown>,
				listener: (answer: unknown) => void,
				failed: (error: Error) => void,
			) => {
				if (name !== "shop/month") return db.watch(name, params, listener);
				queueMicrotask(() => {
					if (allowed)
						listener({
							columns: ["orders", "revenue"],
							rows: [{ orders: 340, revenue: 51000 }],
							more: false,
							asOf: "",
						});
					failed(new Error("Too many watches."));
				});
				return () => undefined;
			},
		);
		const { kit } = openPage(ORDERS, { read: async () => JSON.stringify(ORDERS), watch, onChange() {} });
		let text: string | null = null;
		void kit.load().then((loaded) => {
			text = loaded;
		});
		// No three seconds' wait for a watch that was refused.
		await vi.advanceTimersByTimeAsync(0);
		expect(inputs(text ?? "").map(({ value, state }) => [value, state])).toEqual([
			[null, "unknown"],
			[null, "unknown"],
			[4200, "known"],
		]);
		const starts = () => watch.mock.calls.filter(([name]) => name === "shop/month").length;
		expect(starts()).toBe(1);
		allowed = true;
		// Not at the next load: a refused start waits 10 seconds.
		await kit.load();
		await vi.advanceTimersByTimeAsync(9_999);
		await kit.load();
		expect(starts()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await kit.load();
		expect(starts()).toBe(2);
		expect(inputs(await kit.load())[0]).toEqual({ id: "orders", value: 340, state: "known" });
		// Refused again: the last good answer stays. The answer ended the row of refusals, so the wait is 10 seconds
		// again, and 20 after the refusal that follows it.
		allowed = false;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(inputs(await kit.load())[0]).toEqual({ id: "orders", value: 340, state: "known" });
		expect(starts()).toBe(3);
		await vi.advanceTimersByTimeAsync(19_999);
		await kit.load();
		expect(starts()).toBe(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(inputs(await kit.load())[0]).toEqual({ id: "orders", value: 340, state: "known" });
		expect(starts()).toBe(4);
	} finally {
		vi.useRealTimers();
	}
});

it("waits twice as long after each refused start, 10 minutes at most, and stops after a page's 100th", async () => {
	vi.useFakeTimers();
	try {
		const db = databases({ "shop/visits": { visits: 4200 } });
		// shop/month never starts (no such database); shop/visits answers.
		const watch = vi.fn(
			(
				name: string,
				params: Record<string, unknown>,
				listener: (answer: unknown) => void,
				failed: (error: Error) => void,
			) => {
				if (name !== "shop/month") return db.watch(name, params, listener);
				queueMicrotask(() => failed(new Error("No such database.")));
				return () => undefined;
			},
		);
		const { kit } = openPage(ORDERS, { read: async () => JSON.stringify(ORDERS), watch, onChange() {} });
		const starts = () => watch.mock.calls.filter(([name]) => name === "shop/month").length;
		await kit.load();
		expect(starts()).toBe(1);
		// The engine loads at every live value's change: none of those loads asks again before the wait is over.
		const waits = [10, 20, 40, 80, 160, 320, 600, 600, 600];
		for (const [at, seconds] of waits.entries()) {
			await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
			for (let load = 0; load < 5; load++) await kit.load();
			expect(starts()).toBe(at + 1);
			await vi.advanceTimersByTimeAsync(1);
			await kit.load();
			expect(starts()).toBe(at + 2);
		}
		// The page's 100th refusal is its last: far under the frame's limit of refused calls, however long it stays open.
		for (let more = 0; more < 120; more++) {
			await vi.advanceTimersByTimeAsync(600_000);
			await kit.load();
		}
		expect(starts()).toBe(100);
		// The value that answers is not touched by any of it.
		expect(inputs(await kit.load()).map(({ value, state }) => [value, state])).toEqual([
			[null, "unknown"],
			[null, "unknown"],
			[4200, "known"],
		]);
		expect(watch.mock.calls.filter(([name]) => name === "shop/visits")).toHaveLength(1);
	} finally {
		vi.useRealTimers();
	}
});

/** A bridge whose shop/month cannot start until `made.now`, and answers from then on; the rest is `db`'s. */
function lateMonth(db: ReturnType<typeof databases>) {
	const made = { now: false };
	const watch = vi.fn(
		(
			name: string,
			params: Record<string, unknown>,
			listener: (answer: unknown) => void,
			failed: (error: Error) => void,
		) => {
			if (name !== "shop/month") return db.watch(name, params, listener);
			queueMicrotask(() => {
				if (made.now)
					listener({
						columns: ["orders", "revenue"],
						rows: [{ orders: 340, revenue: 51000 }],
						more: false,
						asOf: "",
					});
				else failed(new Error("No such database."));
			});
			return () => undefined;
		},
	);
	return { made, watch, starts: () => watch.mock.calls.filter(([name]) => name === "shop/month").length };
}

it("asks for a load itself when a wait ends, so a database made during the wait shows", async () => {
	vi.useFakeTimers();
	try {
		const { made, watch, starts } = lateMonth(databases({ "shop/visits": { visits: 4200 } }));
		const { kit, drawFrames } = openPage(ORDERS, { read: async () => JSON.stringify(ORDERS), watch, onChange() {} });
		// As the engines do: a load whenever the script says a live value moved.
		let text = "";
		const load = async () => {
			text = await kit.load();
		};
		kit.onLive(() => void load());
		await load();
		expect(inputs(text)[0]).toEqual({ id: "orders", value: null, state: "unknown" });
		// The database is made 4 seconds in, and its folder notice loads the page: inside the wait, so nothing is asked.
		await vi.advanceTimersByTimeAsync(4_000);
		made.now = true;
		await load();
		expect(starts()).toBe(1);
		// Nothing else changes and nobody loads. At the wait's end the script asks for a load, and the value is there.
		await vi.advanceTimersByTimeAsync(6_000);
		drawFrames();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(starts()).toBe(2);
		expect(inputs(text)[0]).toEqual({ id: "orders", value: 340, state: "known" });
	} finally {
		vi.useRealTimers();
	}
});

it("waits for a load that is running when a wait ends, and asks for one after it", async () => {
	vi.useFakeTimers();
	try {
		// shop/visits never answers here, so every load waits its three seconds for it.
		const { made, watch, starts } = lateMonth(databases({}));
		const { kit, drawFrames } = openPage(ORDERS, { read: async () => JSON.stringify(ORDERS), watch, onChange() {} });
		let text = "";
		const load = async () => {
			text = await kit.load();
		};
		kit.onLive(() => void load());
		const first = load();
		await vi.advanceTimersByTimeAsync(3_000);
		await first;
		made.now = true;
		// A load starts 9 seconds in and is still waiting when shop/month's 10 seconds are over.
		await vi.advanceTimersByTimeAsync(6_000);
		const second = load();
		await vi.advanceTimersByTimeAsync(2_500);
		drawFrames();
		expect(starts()).toBe(1);
		await vi.advanceTimersByTimeAsync(2_500);
		await second;
		drawFrames();
		await vi.advanceTimersByTimeAsync(0);
		expect(starts()).toBe(2);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(inputs(text)[0]).toEqual({ id: "orders", value: 340, state: "known" });
	} finally {
		vi.useRealTimers();
	}
});

it("asks nothing at a wait's end for a question the data no longer names", async () => {
	vi.useFakeTimers();
	try {
		const { watch, starts } = lateMonth(databases({ "shop/visits": { visits: 4200 } }));
		let data: Record<string, unknown> = ORDERS;
		const { kit, drawFrames } = openPage(ORDERS, { read: async () => JSON.stringify(data), watch, onChange() {} });
		let loads = 0;
		const load = async () => {
			loads++;
			await kit.load();
		};
		kit.onLive(() => void load());
		await load();
		data = { ...ORDERS, groups: [{ label: "Shop", inputs: [ORDERS.groups[0].inputs[2]] }] };
		await load();
		await vi.advanceTimersByTimeAsync(10_000);
		drawFrames();
		await vi.advanceTimersByTimeAsync(0);
		expect(loads).toBe(2);
		expect(starts()).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

it("counts the starts that are out, and does not wait for a question it will never start", async () => {
	vi.useFakeTimers();
	try {
		// Eight questions, none of which can start: they are refused together, eight at a time.
		const eight = (count: number) => ({
			lang: "en",
			title: "Shop",
			groups: [
				{
					label: "Shop",
					inputs: Array.from({ length: count }, (_, at) => ({
						id: `q${at}`,
						label: `Q${at}`,
						min: 0,
						max: 10,
						value: { query: `shop/q${at}` },
					})),
				},
			],
		});
		let data = eight(8);
		const watch = vi.fn(
			(
				_name: string,
				_params: Record<string, unknown>,
				_listener: (answer: unknown) => void,
				failed: (error: Error) => void,
			) => {
				queueMicrotask(() => failed(new Error("No such database.")));
				return () => undefined;
			},
		);
		const { kit } = openPage(data, { read: async () => JSON.stringify(data), watch, onChange() {} });
		await kit.load();
		expect(watch).toHaveBeenCalledTimes(8);
		// Twelve rounds of eight are 96. The thirteenth may start four, not eight: 100 refused starts, never 104.
		for (let round = 0; round < 40; round++) {
			await vi.advanceTimersByTimeAsync(600_000);
			await kit.load();
		}
		expect(watch).toHaveBeenCalledTimes(100);
		// A ninth question, named after the page's starts are spent, is not started and holds no load for three seconds.
		data = eight(9);
		let loaded = false;
		void kit.load().then(() => {
			loaded = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(loaded).toBe(true);
		expect(watch).toHaveBeenCalledTimes(100);
	} finally {
		vi.useRealTimers();
	}
});

it("gives a start back when the data drops a question whose start is still out", async () => {
	vi.useFakeTimers();
	try {
		// The data names a question that neither answers nor is refused, and drops it for another, 100 times over.
		const db = databases({ "shop/visits": { visits: 4200 } });
		const one = (query: string) => ({
			lang: "en",
			title: "Shop",
			groups: [{ label: "Shop", inputs: [{ id: "a", label: "A", min: 0, max: 10, value: { query } }] }],
		});
		let data = one("shop/slow0");
		const { kit } = openPage(data, { read: async () => JSON.stringify(data), watch: db.watch, onChange() {} });
		for (let edit = 0; edit < 100; edit++) {
			data = one(`shop/slow${edit}`);
			const load = kit.load();
			await vi.advanceTimersByTimeAsync(3_000);
			await load;
		}
		expect(db.watch).toHaveBeenCalledTimes(100);
		expect(db.watches.filter((watch) => watch.stopped)).toHaveLength(99);
		// None of them spent a start: a question that answers is still started.
		data = one("shop/visits");
		expect(inputs(await kit.load())[0]).toEqual({ id: "a", value: 4200, state: "known" });
	} finally {
		vi.useRealTimers();
	}
});

it("counts a refusal a bridge tells of after the data dropped its question, and hears nothing else of it", async () => {
	vi.useFakeTimers();
	try {
		// A bridge that keeps telling a stopped watch: each start's callbacks are kept and called late.
		const db = databases({ "shop/visits": { visits: 4200 } });
		const kept: { listener: (answer: unknown) => void; failed: (error: Error) => void }[] = [];
		const watch = vi.fn(
			(
				name: string,
				params: Record<string, unknown>,
				listener: (answer: unknown) => void,
				failed: (error: Error) => void,
			) => {
				if (name === "shop/visits") return db.watch(name, params, listener);
				kept.push({ listener, failed });
				return () => undefined;
			},
		);
		const many = (queries: string[]) => ({
			lang: "en",
			title: "Shop",
			groups: [
				{
					label: "Shop",
					inputs: queries.map((query, at) => ({
						id: `q${at}`,
						label: `Q${at}`,
						min: 0,
						max: 10,
						value: { query },
					})),
				},
			],
		});
		let data = many(["shop/slow0"]);
		const { kit, drawFrames } = openPage(data, { read: async () => JSON.stringify(data), watch, onChange() {} });
		const live = vi.fn();
		kit.onLive(live);
		for (let edit = 0; edit < 100; edit++) {
			data = many([`shop/slow${edit}`]);
			const load = kit.load();
			await vi.advanceTimersByTimeAsync(3_000);
			await load;
		}
		expect(watch).toHaveBeenCalledTimes(100);
		// A late answer of a dropped question moves nothing and asks for no load.
		kept[0].listener({ columns: ["n"], rows: [{ n: 7 }], more: false, asOf: "" });
		drawFrames();
		expect(live).not.toHaveBeenCalled();
		// The 99 dropped ones are refused late: with shop/slow99 still out, the page's 100 starts are spent.
		for (const one of kept.slice(0, 99)) one.failed(new Error("No such database."));
		data = many(["shop/slow99", "shop/visits"]);
		const load = kit.load();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(inputs(await load).map(({ value, state }) => [value, state])).toEqual([
			[null, "unknown"],
			[null, "unknown"],
		]);
		// And a dropped question is never asked again at a wait's end.
		await vi.advanceTimersByTimeAsync(600_000);
		drawFrames();
		expect(live).not.toHaveBeenCalled();
		expect(watch).toHaveBeenCalledTimes(100);
	} finally {
		vi.useRealTimers();
	}
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

it("tells a kit's page that its app is a concept, when it is made and when it changes", async () => {
	const f = await fixture();
	const made = read(
		await f.call(
			"save_app",
			save("udtryk", "make-1", { title: "Udtryk", kit: "board", concept: true, cover: "pictures/arc-one.webp" }, [
				{ path: "board.json", text: JSON.stringify(BOARD) },
			]),
		),
	);
	expect(made.state).toBe("applied");
	expect(f.text("apps/udtryk/index.html")).toBe(kitPage("udtryk", "board", "Udtryk", BOARD, () => false, true));
	// New data, and the manifest is not touched: the page is written again, still as a concept.
	const next = { ...BOARD, title: "Udtryk" };
	await f.call("save_app", save("udtryk", "change-1", null, [{ path: "board.json", text: JSON.stringify(next) }]));
	expect(f.text("apps/udtryk/index.html")).toBe(kitPage("udtryk", "board", "Udtryk", next, () => false, true));
	// And no longer a concept: the page says nothing, so its engine draws the title block again.
	await f.call("save_app", save("udtryk", "change-2", { title: "Udtryk", concept: false }, []));
	expect(f.text("apps/udtryk/index.html")).toBe(kitPage("udtryk", "board", "Udtryk", next, () => false));
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

it("finds the questions a kit's data names exactly as the page's script does", async () => {
	const deep = (depth: number): unknown => (depth === 0 ? { query: "shop/deep" } : { next: deep(depth - 1) });
	const samples: Record<string, unknown>[] = [
		{ a: { query: "shop/month" } },
		{ a: { query: "shop/month", params: { days: 30 }, column: "orders", example: 3 } },
		{ a: [{ query: "shop/month" }, { query: "shop/month" }, { query: "shop/month", params: { days: 7 } }] },
		{ a: { query: "shop/month", note: "a key a binding has not" } },
		{ a: { query: 5 } },
		{ a: ["query"], query: "shop/month" },
		{ a: deep(10) },
		{ a: deep(11) },
		{ a: deep(12) },
		// The same params in another order are the same question.
		{
			a: { query: "shop/sales", params: { since: 1, until: 2 } },
			b: { query: "shop/sales", params: { until: 2, since: 1 } },
			c: { query: "shop/sales", params: { until: 3, since: 1 } },
		},
	];
	for (const sample of samples) {
		// The page asks once for each question it finds; a watch the bridge refuses lets it go on at once.
		const watch = vi.fn((_name: string, _params: unknown, _listener: unknown, failed: (error: Error) => void) => {
			failed(new Error("Not now."));
			return () => undefined;
		});
		const { kit } = openPage(sample, { read: async () => JSON.stringify(sample), watch, onChange() {} });
		await kit.load();
		const label = JSON.stringify(sample);
		expect(kitBindings(sample), label).toHaveLength(watch.mock.calls.length);
		expect(kitBindings(sample).length > 0, label).toBe(kit.live.length > 0);
	}
	expect(kitBindings(samples[2])).toHaveLength(2);
	expect(kitBindings(samples[3])).toEqual([]);
	expect(kitBindings(samples[9])).toHaveLength(2);
	// Five questions, each named with its params in both orders, are five, not past what a page keeps live.
	const twice = {
		...MODEL,
		groups: [
			{
				label: "Sales",
				inputs: Array.from({ length: 10 }, (_, n) => ({
					id: `n${n}`,
					label: `N${n}`,
					value: {
						query: `shop/q${n % 5}`,
						params: n < 5 ? { since: 1, until: 2 } : { until: 2, since: 1 },
					},
				})),
			},
		],
	};
	expect(kitBindings(twice)).toHaveLength(5);
	expect(kitNotes("model", twice, () => true)).toEqual([]);
});

it("stops the watches the data no longer names before it starts new ones, within a bridge's limit", async () => {
	// A bridge that keeps at most eight watches at once, and refuses a ninth.
	const open = new Set<string>();
	const watch = vi.fn(
		(name: string, _params: unknown, listener: (answer: unknown) => void, failed: (error: Error) => void) => {
			if (open.size >= KIT_LIVE_QUESTIONS) {
				queueMicrotask(() => failed(new Error("Too many watches.")));
				return () => undefined;
			}
			open.add(name);
			queueMicrotask(() => listener({ columns: ["n"], rows: [{ n: 7 }], more: false, asOf: "" }));
			return () => {
				open.delete(name);
			};
		},
	);
	const asking = (first: number) => ({
		...MODEL,
		groups: [
			{
				label: "Numbers",
				inputs: Array.from({ length: KIT_LIVE_QUESTIONS }, (_, n) => ({
					id: `n${n}`,
					label: `N${n}`,
					value: { query: `shop/q${first + n}` },
				})),
			},
		],
	});
	let data = asking(0);
	const { kit } = openPage(data, { read: async () => JSON.stringify(data), watch, onChange() {} });
	expect(inputs(await kit.load()).every(({ value }) => value === 7)).toBe(true);
	// The data now names eight other questions: the eight old watches go first, and the new ones all answer.
	data = asking(KIT_LIVE_QUESTIONS);
	expect(inputs(await kit.load()).map(({ value, state }) => [value, state])).toEqual(
		Array.from({ length: KIT_LIVE_QUESTIONS }, () => [7, "known"]),
	);
	expect([...open].sort()).toEqual(
		Array.from({ length: KIT_LIVE_QUESTIONS }, (_, n) => `shop/q${KIT_LIVE_QUESTIONS + n}`).sort(),
	);
});

it("tells the maker when the data names more questions than a page keeps live", () => {
	const asking = (count: number) => ({
		...MODEL,
		groups: [
			{
				label: "Numbers",
				inputs: Array.from({ length: count }, (_, n) => ({
					id: `n${n}`,
					label: `N${n}`,
					value: { query: `shop/q${n}`, params: { n } },
				})),
			},
		],
	});
	expect(kitNotes("model", asking(8), () => true)).toEqual([]);
	expect(kitNotes("model", asking(9), () => true)).toEqual([
		"model.json names 9 different questions of the company's databases: a page keeps 8 live, and the rest show as not known.",
	]);
});

it("adds data to a kit app's reads when its data names a question, and only adds it", async () => {
	const LOOK =
		"data was added to the app's reads: its data names a question of the company's databases, which the page reads live.";
	const manifestOf = (f: Awaited<ReturnType<typeof fixture>>, name: string) => {
		const parsed = parseAppManifest(f.text(`apps/${name}/app.toml`) ?? "");
		return parsed.ok ? parsed.manifest : null;
	};
	const f = await fixture();
	// A new app whose data names a question: data joins the reads the agent gave.
	const made = read(
		await f.call(
			"save_app",
			save("orders", "make-1", { title: "Orders", kit: "model", reads: ["files"] }, [
				{ path: "model.json", text: JSON.stringify(ORDERS) },
			]),
		),
	);
	expect(made.state).toBe("applied");
	expect(manifestOf(f, "orders")?.reads).toEqual(["files", "data"]);
	expect(made.look).toContain(LOOK);
	const bare = read(
		await f.call(
			"save_app",
			save("bare", "make-2", { title: "Bare", kit: "model" }, [
				{ path: "model.json", text: JSON.stringify(ORDERS) },
			]),
		),
	);
	expect(manifestOf(f, "bare")?.reads).toEqual(["data"]);
	expect(bare.look).toContain(LOOK);
	// An app with no question keeps its manifest as it is, through a change too.
	await f.call(
		"save_app",
		save("plain", "make-3", { title: "Plain", kit: "model" }, [{ path: "model.json", text: JSON.stringify(MODEL) }]),
	);
	const plain = manifestOf(f, "plain");
	expect(plain?.reads).toEqual([]);
	const manifest = f.text("apps/plain/app.toml");
	const kept = read(
		await f.call(
			"save_app",
			save("plain", "change-1", null, [{ path: "model.json", text: JSON.stringify({ ...MODEL, line: "Now" }) }]),
		),
	);
	expect(kept.files.map((file: { path: string }) => file.path)).not.toContain("apps/plain/app.toml");
	expect(f.text("apps/plain/app.toml")).toBe(manifest);
	expect(kept.look ?? []).not.toContain(LOOK);
	// The change that brings the first question adds data, the manifest otherwise as it was.
	const asked = read(
		await f.call("save_app", save("plain", "change-2", null, [{ path: "model.json", text: JSON.stringify(ORDERS) }])),
	);
	expect(asked.state).toBe("applied");
	expect(manifestOf(f, "plain")).toEqual({ ...plain, reads: ["data"] });
	expect(asked.look).toContain(LOOK);
	// The questions go away: data stays.
	await f.call("save_app", save("plain", "change-3", null, [{ path: "model.json", text: JSON.stringify(MODEL) }]));
	expect(manifestOf(f, "plain")?.reads).toEqual(["data"]);
	// An app with no kit may name data itself.
	const own = read(
		await f.call(
			"save_app",
			save("tool", "make-4", { title: "Tool", reads: ["data"] }, [{ path: "index.html", text: "<p>Orders</p>" }]),
		),
	);
	expect(own.state).toBe("applied");
	expect(manifestOf(f, "tool")?.reads).toEqual(["data"]);
});
