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
import { afterEach, expect, it } from "vitest";
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
