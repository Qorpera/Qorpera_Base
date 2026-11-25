import { OWED_APPS, parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import { APP_GUIDES, appGuide } from "@qorpera/runtime/cloud-app-guides";
import { captionHash, EXPLAINER_ENGINE_JS, explainerPage } from "@qorpera/runtime/cloud-app-kit-explainer";
import { appLookNotes, cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

/** A run's app and file tools over a folder. The run has read every guide, as a run does before it writes a kit's
 * file, unless `unread`. */
async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}, unread = false) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = [
		...cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
		...cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
	];
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue) => {
		const parsed = tool(name).parseArguments(value);
		const prepared = (await tool(name).prepare?.(parsed, f.context)) ?? parsed;
		return tool(name).execute(prepared, f.context);
	};
	if (!unread) for (const about of APP_GUIDES) await call("app_guide", { about });
	return { ...f, tools, tool, call };
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
function refusesArguments(tool: CloudNativeTool, value: JsonValue, text: string) {
	expect(() => tool.parseArguments(value)).toThrow(CloudToolArgumentRefusal);
	expect(() => tool.parseArguments(value)).toThrow(text);
}

const PAGE = '<!doctype html><link rel="stylesheet" href="style.css"><h1>Sales</h1><script src="js/app.js"></script>';
const manifest = (title: string, more: Record<string, JsonValue> = {}) => ({ title, ...more });
const save = (name: string, key: string, m: JsonValue, files: { path: string; text: string }[]) => ({
	name,
	operationKey: key,
	manifest: m,
	files,
});

it("offers save_app and post_app as Company File tools, and app_guide as the runtime's own", async () => {
	const f = await fixture();
	expect(f.tools.slice(0, 3).map((tool) => [tool.name, tool.source])).toEqual([
		["save_app", "company_file"],
		["post_app", "company_file"],
		["app_guide", "runtime"],
	]);
});

it("tells how a page written by hand is made, within the bytes a tool's description may hold", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	// The tool boundary refuses a tool whose description is over 4096 bytes, and with it every run: the list of colours
	// is part of this one, so a longer list can push it over. The emblems are listed on the schema alone since there are
	// 24 (12 November 2026), which put it at 4177.
	expect(Buffer.byteLength(tool.description)).toBeLessThanOrEqual(4096);
	// The emblems and colours are the schema's enums, which Codex sends; the description names the fields.
	expect(tool.description).toContain("optionally about, emblem, colour, kit, entry");
	for (const rule of [
		// Jonas, 13 November 2026: pages that kept every rule of 10 November (a first screen that says how the area
		// stands, about 300 words, a diagram) were still documents in boxes. A page written by hand now follows the kits.
		"The thing fills the first screen, on a laptop and on a phone (about 390 px wide, one column, nothing cut off)",
		"a title of two or three words, at most one short line, then the thing",
		"labels and numbers, not sentences, boxes of text, a date or a list of what you did",
		"what is not known yet drawn as open, such as a dashed outline or a question mark, not written about.",
		"Give it something to do: a control that changes what it shows, or a choice a member makes (writes).",
		"Links open on a member's click: app:<name> another app, folder:<path> a file of the company's own work, https://… a web page in a new tab, #id a place in the page; nothing else opens.",
		"Every page starts from Qorpera's base style with the company's colours as CSS variables (--q-bg, --q-text, --q-muted, --q-line, --q-surface, --q-accent, --q-on-accent, --q-accent-soft, --q-good, --q-warn, --q-bad): use them, not colours of your own (app_guide style).",
		"Qorpera shows the member what will be saved, and only their yes saves it. app_guide reads and writes say how.",
		"The answer's look names what a read of the saved app found: fix it, unless it does not fit this app.",
	])
		expect(tool.description).toContain(rule);
	// How a page reads live data is the guide reads: a field's description never reached a model from a schema this
	// long (14 November 2026).
	const schema = JSON.stringify(appGuide("reads"));
	for (const call of [
		"qorpera.read(path) gives a file's text",
		"qorpera.table(name) gives {name, columns, rows}",
		"qorpera.todos() gives every agent's todos as {agent, title, status, updatedAt}",
		"qorpera.agents() gives each agent's name, role and working",
		"qorpera.onChange(fn) calls fn when the company folder changed",
		"qorpera.questions() gives your and the other agents' open questions to this member that point at this app",
		"Reading changes nothing: app_guide writes says what a page may ask a member to change.",
		// The bridge gives an app 120 calls a minute and counts todos as ten, and a busy company's folder changes every
		// few seconds: a page that drew on every change would spend that in seconds and then show an error.
		"after a change draw again once, no sooner than ten seconds after the last draw however many changes arrive",
		"An app may make 120 calls a minute in a member's tab and 8 at a time, and todos counts as ten calls",
		"When a read fails, keep what the page last showed and read again ten seconds later, until a read works",
	])
		expect(schema).toContain(call);
	// So is the base style a page starts from: its variables, where the company's colours come from, light and dark.
	const files = JSON.stringify(appGuide("style"));
	for (const said of [
		"Each page starts from Qorpera's base style, which sits in a layer under your own CSS, so any rule you write wins over it",
		"a centred column at most 800 px wide (set body's margin yourself to use the whole width)",
		"--q-bg the page, --q-text the text, --q-muted quiet text, --q-line rules and borders, --q-surface cards and panels",
		"--q-accent the company's colour for links, marks and key figures, --q-on-accent text on the accent",
		"--q-good, --q-warn and --q-bad for states",
		'QorperaOS/brand/brand.toml gives them, which the agent that owns the brand writes with company_write: accent, background and text, each as \\"#rrggbb\\", at the top for a light page and again under [dark] for a dark one',
		"Text must read on its background (4.5 to 1) and the accent must show on it (3 to 1), or Qorpera's own colour is used instead.",
		'A page is shown light unless its head says it works in both, with <meta name=\\"color-scheme\\" content=\\"light dark\\">',
		"because a page cannot read QorperaOS/",
		"A concept gets no base style.",
	])
		expect(files).toContain(said);
});

it("tells in the guide writes how a page lets a member act, and that nothing is saved without the member's yes", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	expect(tool.description).toContain(
		"asks a member to change an answer, a table row or a database action (qorpera.answer, setRow, addRow, act; writes names them)",
	);
	const writes = appGuide("writes");
	for (const rule of [
		// The gate: the page asks, the member allows on a bar the page cannot draw, and the save is the member's own.
		"A page changes nothing by itself",
		"it is saved only when the member allows it there, as the member's own change",
		"rejects with the reason when the member says not now, when another request still waits, or when the save is refused",
		"Ask only from a click on a button of the page that says what it does, one request per click, never when the page opens or on a timer",
		"after three not now in a row the page may not ask again until the member reloads it",
		"A <form> does not submit inside an app: handle the button's click (and Enter in a field), not a form's submit.",
		// Answers: the question is asked as always and pointed at the app; the page answers with one of its options.
		"Ask the question with ask_member and point it at the app",
		"qorpera.questions() (questions in reads) then lists the open questions that point at this app",
		"qorpera.answer(id, value) with one option's value, or a list of values for a multiSelect question",
		// Rows: one row a request, never who holds or does something, and how the agent hears of a change.
		"qorpera.setRow(table, key, cells) changes cells of the row with that key",
		"qorpera.addRow(table, cells) adds a row",
		"One row per request, at most 12 cells of it, a cell's text at most 500 characters",
		"A page cannot change a key cell or a column that names a member or an agent, and cannot remove a row",
		"the table areas is never written from an app",
		"manage_routine with a trigger of kind file_change and path QorperaOS/tables/<name>/rows.csv",
		"data:<database>/<change>: a member runs a named change",
		"qorpera.act('<database>/<change>', params)",
	])
		expect(writes).toContain(rule);
});

it("keeps save_app's schema small enough that the model receives its fields' descriptions", async () => {
	const f = await fixture();
	// The patched Codex sends no field description of a tool whose schema is 5,000 bytes or more as it sends it (probed
	// 14 November 2026: 4,991 bytes kept them, 5,000 lost every one), and save_app's was about 40 KB: no model had read
	// a guide. What it sends is no longer than this, since it leaves the bounds out.
	for (const name of ["save_app", "post_app", "app_guide"]) {
		expect(Buffer.byteLength(JSON.stringify(f.tool(name).inputSchema)), name).toBeLessThan(4600);
		expect(Buffer.byteLength(f.tool(name).description), name).toBeLessThanOrEqual(4096);
	}
	const properties = (
		f.tool("save_app").inputSchema as {
			properties: { manifest: { properties: Record<string, { description?: string }> } };
		}
	).properties.manifest.properties;
	// Which kit draws which thing is where the agent chooses; what the kit's file holds is its guide.
	for (const said of [
		"or null for a page you write by hand",
		"model: how something works in numbers",
		"board: real things as pictures",
		"path: a way through steps with the evidence for each",
		"object: a physical thing a member turns in the hand",
		"curve: one value over time",
		"stack: things that want a member's yes",
		"shelf: the company's own things side by side",
		"map: the company or your own area as its things",
		"ring: a year, month or week with its dates",
		"flow: money or people from where they come to where they go",
		"explainer: a mechanism or a decision that a short narrated video explains.",
	])
		expect(properties.kit?.description).toContain(said);
	expect(properties.reads?.description).toContain("app_guide reads says how");
	expect(properties.writes?.description).toContain("app_guide writes says how");
	// T3-5's contract says it on the kits' line.
	expect(f.tool("save_app").description).toContain(
		"What the file holds is in the kit's guide (app_guide): a kit's file is saved only in a run that has read it, else APP_GUIDE_UNREAD and nothing is saved.",
	);
});

it("answers a guide's text, and nothing of the company", async () => {
	const f = await fixture({}, true);
	const tool = f.tool("app_guide");
	const aboutSchema = (
		tool.inputSchema as {
			properties: {
				about: {
					oneOf: [{ type: string; enum: string[] }, { type: string; items: { type: string; enum: string[] } }];
				};
			};
		}
	).properties.about;
	const expectedGuides = [
		"look",
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
		"explainer",
		"program",
		"style",
		"reads",
		"writes",
		"icons",
	];
	expect(aboutSchema.oneOf[0].enum).toEqual(expectedGuides);
	expect(aboutSchema.oneOf[1].items.enum).toEqual(expectedGuides);
	for (const about of APP_GUIDES) expect(tool.description, about).toContain(about);
	refusesArguments(
		tool,
		{ about: "kits" },
		"about must be one of look, model, board, path, object, curve, stack, shelf, map, ring, flow, explainer",
	);
	refusesArguments(tool, {}, "app_guide takes exactly about");
	refusesArguments(tool, { about: "model", more: 1 }, "app_guide takes exactly about");
	for (const about of APP_GUIDES) {
		const answer = await f.call("app_guide", { about });
		expect(answer, about).toEqual({ kind: "text", value: appGuide(about) });
		// One result holds it whole, with room for its envelope.
		expect(Buffer.byteLength(JSON.stringify(appGuide(about))), about).toBeLessThan(16 * 1024);
	}
	// A data kit's guide starts with what the data kits share, then its own: fields, bounds and an example.
	for (const kit of ["model", "board", "path", "object", "curve", "stack", "shelf", "map", "ring", "flow"] as const) {
		expect(appGuide(kit), kit).toMatch(
			/^For a data kit \(model, board, path, object, curve, stack, shelf, map, ring, flow\) you write one file among files/,
		);
		expect(appGuide(kit), kit).toContain(`\`${kit}.json\``);
		expect(appGuide(kit), kit).toContain("```json");
	}
	expect(appGuide("explainer")).toContain("You write one file, scenes.js");
	expect(f.commits).toEqual([]);
	expect(f.releases).toEqual([]);
});

it("holds every app to one look, with screens at the bar and three not to make", async () => {
	const f = await fixture({}, true);
	const look = appGuide("look");
	// Jonas's taste from 44 sketched screens (14 November 2026), in short words: the bar, never the layout.
	for (const rule of [
		"Read this before your first app.",
		"Qorpera's own plain look: the base style's page (--q-bg) and the system font, never colours of your own for the page. No scenes, skies, landscapes or themed backdrops.",
		// A kit keeps its own form; the look decides what goes in it (review r1 of #1820).
		"A kit draws its own form, sliders, chips and arrows included: for a kit, this decides what you put in it (real things, few words, the numbers that matter). For a page you write by hand, it decides the page too.",
		"Show the company's real things: its products, its shop, its money, its dates, its customers' own words.",
		"One big shape owns each screen: a ring, a curve, a big card, a big window, a shelf of real things. Colour comes as large, soft fields. Use very few words.",
		"Never a grid of small controls, rows of little chips or pills, scattered dots, cards of text, or diagram lines with labels.",
		"Copy the quality, not the layout. The screens below show the bar; they are not screens to make. Build what this company needs",
		// The views the company is owed, at their fixed folders (company views step 4, DESIGN-4.md O2a).
		"- Some apps are views the company is owed, which members find first: apps/products (what it sells), apps/money (its money), apps/ads (its ads). Make one when asked, at exactly that folder; the platform draws the website itself.",
	])
		expect(look).toContain(rule);
	for (const name of OWED_APPS) expect(look).toContain(`apps/${name} (`);
	// Seven screens he liked and three he did not, a line each, each naming why.
	const lines = (heading: string) => look.split(`\n\n${heading}:\n`)[1]?.split("\n\n")[0]?.split("\n") ?? [];
	expect(lines("Screens at the bar").map((line) => line.split(":")[0])).toEqual([
		"- While you slept",
		"- Money as a river",
		"- Sign-off",
		"- Replay the day",
		"- The year ring",
		"- The week's forecast",
		"- The shop live",
	]);
	expect(lines("Not this")).toHaveLength(3);
	for (const line of lines("Not this")) expect(line).toMatch(/^- [^:]+: \S/);
	// Short: a guide read before every first app.
	expect(Buffer.byteLength(look)).toBeLessThan(2500);
	// An agent meets it where it chooses: app_guide's description, and save_app's kit.
	// T3-5's contract says it on app_guide's look line.
	expect(f.tool("app_guide").description).toContain(
		"- look: the bar every app's look is held to, with screens to follow and screens to avoid. Read it before your first app.",
	);
	const kit = (
		f.tool("save_app").inputSchema as {
			properties: { manifest: { properties: { kit: { description: string } } } };
		}
	).properties.manifest.properties.kit;
	expect(kit.description).toContain("Before your first app, read app_guide look.");
	// It is read, not held to: a page saves in a run that has not read it.
	expect(
		read(await f.call("save_app", save("sales", "make-1", manifest("Sales"), [{ path: "index.html", text: PAGE }]))),
	).toMatchObject({ state: "applied", created: true });
});

it("saves a kit's file only in a run that has read the kit's guide", async () => {
	const f = await fixture({}, true);
	const scenes = [{ path: "scenes.js", text: SCENES }];
	// A new app: refused before anything is written, naming the guide.
	await refuses(
		f.call("save_app", save("fee", "make-1", manifest("How the fee works", { kit: "explainer" }), scenes)),
		"APP_GUIDE_UNREAD: this call saved nothing. Read the explainer kit's guide first: it says what scenes.js holds and gives an example. Call app_guide with about explainer, check scenes.js against it, then make this call again.",
	);
	expect(f.commits).toEqual([]);
	// Another kit's guide is not this kit's.
	await f.call("app_guide", { about: "model" });
	await refuses(
		f.call("save_app", save("fee", "make-1", manifest("How the fee works", { kit: "explainer" }), scenes)),
		"APP_GUIDE_UNREAD",
	);
	// Read, the same call saves.
	await f.call("app_guide", { about: "explainer" });
	expect(
		read(
			await f.call("save_app", save("fee", "make-1", manifest("How the fee works", { kit: "explainer" }), scenes)),
		),
	).toMatchObject({ state: "applied", created: true });
});

it("accepts a list of topics in app_guide and marks all shown kits as read in one turn", async () => {
	const f = await fixture({}, true);
	const tool = f.tool("app_guide");
	refusesArguments(tool, { about: [] }, "about list must have 1 to 6 topics");
	refusesArguments(
		tool,
		{ about: ["look", "model", "board", "path", "object", "curve", "stack"] },
		"about list must have 1 to 6 topics",
	);
	refusesArguments(tool, { about: ["look", "unknown"] }, "about must be one of look");
	const batch = await f.call("app_guide", { about: ["look", "explainer", "look"] });
	expect(batch.kind).toBe("text");
	const text = (batch as { kind: "text"; value: string }).value;
	expect(text).toContain(appGuide("look"));
	expect(text).toContain(appGuide("explainer"));
	expect(
		read(
			await f.call(
				"save_app",
				save("fee", "make-batch", manifest("How the fee works", { kit: "explainer" }), [
					{ path: "scenes.js", text: SCENES },
				]),
			),
		),
	).toMatchObject({ state: "applied", created: true });
});

it("holds a change of a kit's file to the guide too, and leaves every other save alone", async () => {
	// An app a run made earlier, in a run that has read nothing.
	const f = await fixture(
		{
			folders: ["apps"],
			files: {
				"apps/fee/app.toml": `name = "Fee"\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\nposted = false\nkit = "explainer"\n`,
				"apps/fee/scenes.js": SCENES,
			},
		},
		true,
	);
	await refuses(
		f.call("save_app", save("fee", "change-1", null, [{ path: "scenes.js", text: `${SCENES}\n` }])),
		"APP_GUIDE_UNREAD: this call saved nothing. Read the explainer kit's guide first",
	);
	// By the kit the app keeps under a manifest that names none, and by the file's name in any case.
	await refuses(
		f.call("save_app", save("fee", "change-2", manifest("How the fee works"), [{ path: "Scenes.JS", text: SCENES }])),
		"APP_GUIDE_UNREAD",
	);
	expect(f.commits).toEqual([]);
	// The manifest alone, or a file that is not the kit's own, is saved unread.
	expect(
		read(await f.call("save_app", save("fee", "change-3", manifest("How fees work", { kit: "explainer" }), []))),
	).toMatchObject({ state: "applied" });
	expect(
		read(await f.call("save_app", save("fee", "change-4", null, [{ path: "notes.md", text: "# Notes\n" }]))),
	).toMatchObject({ state: "applied" });
	// A page written by hand needs no guide to be saved.
	expect(
		read(await f.call("save_app", save("sales", "make-1", manifest("Sales"), [{ path: "index.html", text: PAGE }]))),
	).toMatchObject({ state: "applied", created: true });
});

it("refuses arguments it cannot save before anything is read", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	refusesArguments(tool, save("Sales", "k", manifest("S"), []), "name must be the app's folder name");
	refusesArguments(tool, save("sales", "k", null, []), "give a manifest, files, or both");
	refusesArguments(tool, save("sales", "k", null, [{ path: "../x.html", text: "" }]), "relative to the app's folder");
	refusesArguments(tool, save("sales", "k", null, [{ path: "app.toml", text: "" }]), "written from manifest");
	refusesArguments(tool, save("sales", "k", null, [{ path: "pictures/a.png", text: "" }]), "a .png file is not text");
	refusesArguments(tool, save("sales", "k", null, [{ path: "font.woff2", text: "" }]), "from a company machine");
	refusesArguments(
		tool,
		save("sales", "k", null, [
			{ path: "a.css", text: "" },
			{ path: "A.css", text: "" },
		]),
		"listed twice",
	);
	refusesArguments(
		tool,
		save("sales", "k", manifest("S", { emblem: "unicorn" }), []),
		"manifest.emblem must be one of",
	);
	refusesArguments(tool, save("sales", "k", manifest("S", { entry: "a.css" }), []), "manifest.entry");
	refusesArguments(tool, save("sales", "k", manifest("S", { concept: "yes" }), []), "manifest.concept");
	refusesArguments(tool, save("sales", "k", manifest("S", { cover: "cover.gif" }), []), "manifest.cover");
	refusesArguments(tool, save("sales", "k", manifest("S", { cover: "../cover.png" }), []), "manifest.cover");
	for (const writes of [["files"], ["table:Bad_Name"], ["table:areas"], "answers", [1]])
		refusesArguments(tool, save("sales", "k", manifest("S", { writes }), []), "manifest.writes");
	refusesArguments(f.tool("post_app"), { name: "sales", operationKey: "k", posted: "yes" }, "posted must be");
	expect(f.commits).toEqual([]);
});

it("makes a new app in one unit, owned by the agent and not posted, with the apps folder when there is none", async () => {
	const f = await fixture();
	const answer = read(
		await f.call(
			"save_app",
			save("sales", "make-1", manifest("Sales this week", { emblem: "chart", reads: ["tables"] }), [
				{ path: "index.html", text: PAGE },
				{ path: "style.css", text: "h1{color:teal}" },
				{ path: "js/app.js", text: "console.log(1)" },
			]),
		),
	);
	expect(answer).toMatchObject({
		schema: "qorpera.app-save/v1",
		state: "applied",
		app: "sales",
		created: true,
		link: "app:sales",
	});
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]?.units).toMatchObject([{ op: "new_folder", path: "apps" }]);
	const stored = parseAppManifest(f.text("apps/sales/app.toml") ?? "");
	expect(stored).toEqual({
		ok: true,
		manifest: {
			name: "Sales this week",
			about: null,
			emblem: "chart",
			colour: null,
			entry: "index.html",
			owner: f.identity.staffAgentId.toLowerCase(),
			posted: false,
			reads: ["tables"],
			writes: [],
			concept: false,
			cover: null,
			kit: null,
		},
	});
	expect(f.text("apps/sales/js/app.js")).toBe("console.log(1)");
	expect(f.files.get("apps/sales/style.css")?.file.mediaType).toBe("text/css");
	await refuses(
		f.call("save_app", save("other", "make-2", manifest("Other"), [{ path: "page.html", text: "<p>x" }])),
		"APP_ENTRY_MISSING",
	);
});

it("changes an app's files over the versions it reads, and keeps its owner and posted", async () => {
	const OWNER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	const f = await fixture({
		folders: ["apps"],
		files: {
			"apps/sales/app.toml": `name = "Sales"\nowner = "${OWNER}"\nposted = true\n`,
			"apps/sales/index.html": PAGE,
		},
	});
	const version = f.files.get("apps/sales/index.html")?.version;
	const answer = read(
		await f.call(
			"save_app",
			save("sales", "change-1", manifest("Sales, by week"), [
				{ path: "index.html", text: "<h1>New</h1>" },
				{ path: "data/week.json", text: "{}" },
			]),
		),
	);
	expect(answer).toMatchObject({ state: "applied", created: false });
	expect(f.commits[0]?.units).toMatchObject([
		{ op: "write", path: "apps/sales/app.toml" },
		{ op: "mkdir", path: "apps/sales/data" },
		{ op: "write", path: "apps/sales/index.html", expectedVersion: version },
		{ op: "write", path: "apps/sales/data/week.json" },
	]);
	expect(parseAppManifest(f.text("apps/sales/app.toml") ?? "")).toMatchObject({
		ok: true,
		manifest: { name: "Sales, by week", owner: OWNER, posted: true },
	});
	expect(f.text("apps/sales/index.html")).toBe("<h1>New</h1>");
});

const LINKS_NOTE =
	"a link opens another app (app:<name>), a file of the company's own work (folder:<path>, never under QorperaOS/), a web page (https://…) or a place in the page (#id). For anything else, such as a tab, use a button with a click handler.";
const WORDS_NOTE =
	"a member would have to read this, so it is a document, not an app. Show the thing itself with a kit (model, board, path, object, curve, stack, shelf, map, ring, flow or explainer: kit's schema says what each draws), and keep the text in its file.";
const UNSHOWN_NOTE =
	"Nothing to look at, only text: an app shows a thing to look at and handle. Make it with a kit (model, board, path, object, curve, stack, shelf, map, ring, flow or explainer: kit's schema says what each draws).";
const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

it("reads a page quickly and names what a member would trip on", () => {
	expect(appLookNotes(PAGE)).toEqual([]);
	// The links the web opens when a member clicks them are fine: an app, a file of the company's own work, a web
	// page, a jump inside the page. So is an anchor without a target.
	expect(
		appLookNotes(
			'<a href="#top">Top</a> <a name="top">Here</a> <a href="folder:strategy/plan%202027.md">Plan</a> <a class="x" href=https://example.com>Site</a> <a href="app:sales">Sales</a> <a href="HTTP://example.com">Site</a>',
		),
	).toEqual([]);
	// The ones that open nothing are named, the first three of them: another page of the app, a path of the site, a
	// file in a folder the platform keeps, a name that is no app's, mail, a script (the browser runs none in an app's
	// frame). Not markup in a comment.
	expect(appLookNotes('<a href="details.html">More</a> <!-- <a href="old.html">Old</a> -->')).toEqual([
		`1 link opens nothing (details.html): ${LINKS_NOTE}`,
	]);
	expect(
		appLookNotes(
			'<a href="/c/1/file">Files</a> <a href="folder:QorperaOS/vision/vision.md">Vision</a> <a href="folder:Hooks/mail/a.eml">Mail</a> <a href="app:Sales Board">Sales</a> <a href="mailto:a@example.com">Mail</a> <a href="folder:">Root</a> <a href="javascript:show(2)">Two</a>',
		),
	).toEqual([
		`7 links open nothing (/c/1/file, folder:QorperaOS/vision/vision.md, folder:Hooks/mail/a.eml, …): ${LINKS_NOTE}`,
	]);
	expect(appLookNotes(`<a href="${"x".repeat(200)}">Long</a>`)).toEqual([
		`1 link opens nothing (${"x".repeat(80)}…): ${LINKS_NOTE}`,
	]);
	// Folded sections, from three on.
	const folded = "<details><summary>More</summary><p>Hidden</p></details>";
	expect(appLookNotes(folded.repeat(2))).toEqual([]);
	expect(appLookNotes(folded.repeat(3))).toEqual([
		"3 folded sections (<details>): a member sees only what is open. Show what matters and leave the rest out.",
	]);
	// A page of text: a document past 250 words, and nothing to look at past 80 without a picture or a drawing (the
	// pages of 13 November held 150 to 250 words each, under the old bounds of 500 and 150).
	expect(appLookNotes(`<p>${words(80)}</p>`)).toEqual([]);
	expect(appLookNotes(`<p>${words(81)}</p>`)).toEqual([UNSHOWN_NOTE]);
	expect(appLookNotes(`<p>${words(251)}</p>`)).toEqual([`251 words: ${WORDS_NOTE}`, UNSHOWN_NOTE]);
	expect(appLookNotes(`<svg viewBox="0 0 10 10"></svg><p>${words(251)}</p>`)).toEqual([`251 words: ${WORDS_NOTE}`]);
	expect(appLookNotes(`<p>${words(200)}</p><script>document.createElementNS(NS, "svg")</script>`)).toEqual([]);
	expect(appLookNotes(`<p style="background:url(map.png)">${words(200)}</p>`)).toEqual([]);
	// Only what a member reads counts: not scripts, styles, comments, tags or marks, also when one is never closed.
	expect(
		appLookNotes(`<style>${words(600)}</style><script>${words(600)}</script><p>A few words &amp; 1 · 2</p>`),
	).toEqual([]);
	expect(appLookNotes(`<p>One</p><!-- ${words(900)}`)).toEqual([]);
	expect(appLookNotes(`<p>One</p><script>${words(900)}`)).toEqual([]);
	expect(appLookNotes(`<p>One</p><a href="folder:a.md"`)).toEqual([]);
});

it("tells the agent what a quick read of the saved entry page found, as advice", async () => {
	const f = await fixture();
	const wordy = `<h1>Market</h1><p>${words(501)}</p><a href="research/market.md">Source</a>`;
	const made = read(
		await f.call("save_app", save("market", "make-1", manifest("Market"), [{ path: "index.html", text: wordy }])),
	);
	expect(made).toMatchObject({
		state: "applied",
		created: true,
		look: [`1 link opens nothing (research/market.md): ${LINKS_NOTE}`, `503 words: ${WORDS_NOTE}`, UNSHOWN_NOTE],
		next: "Saved. First fix what look names, unless it does not fit this page. Then show it to the member with a link in your message: [market](app:market). post_app shows it to every member in their apps.",
	});
	expect(f.text("apps/market/index.html")).toBe(wordy);
	// A change that leaves the entry page as it is has nothing to read, and a calm page gets no notes.
	const data = read(await f.call("save_app", save("market", "change-1", null, [{ path: "state.json", text: "{}" }])));
	expect(data).not.toHaveProperty("look");
	expect(data.next).toBe(
		"Saved. Show it to the member with a link in your message: [market](app:market). post_app shows it to every member in their apps.",
	);
	const calm = read(await f.call("save_app", save("market", "change-2", null, [{ path: "index.html", text: PAGE }])));
	expect(calm).toMatchObject({ state: "applied", created: false });
	expect(calm).not.toHaveProperty("look");
});

it("tells the agent an app at an owed view's folder is that view, which members find first", async () => {
	// Company views step 4 (lanes/company-views-20261114/DESIGN-4.md, O2a): apps/products, apps/money and apps/ads.
	expect(OWED_APPS).toEqual(["products", "money", "ads"]);
	const f = await fixture();
	const show = (name: string) =>
		`Saved. Show it to the member with a link in your message: [${name}](app:${name}). post_app shows it to every member in their apps.`;
	for (const name of OWED_APPS) {
		const made = read(
			await f.call("save_app", save(name, `make-${name}`, manifest("View"), [{ path: "index.html", text: PAGE }])),
		);
		// A line to know, not to fix: next does not ask for a fix.
		expect(made).toMatchObject({
			state: "applied",
			look: [`This is the company's ${name} view: members find it first in the apps drawer.`],
			next: show(name),
		});
		// Every save of it says so, a change too.
		const changed = read(
			await f.call("save_app", save(name, `change-${name}`, null, [{ path: "state.json", text: "{}" }])),
		);
		expect(changed.look).toEqual([`This is the company's ${name} view: members find it first in the apps drawer.`]);
	}
	// Beside what a read of the page found, last; then the notes ask for a fix.
	const wordy = read(
		await f.call(
			"save_app",
			save("products", "wordy-1", null, [{ path: "index.html", text: `<h1>Lamps</h1><p>${words(501)}</p>` }]),
		),
	);
	expect(wordy.look).toEqual([
		`502 words: ${WORDS_NOTE}`,
		UNSHOWN_NOTE,
		"This is the company's products view: members find it first in the apps drawer.",
	]);
	expect(wordy.next).toContain("First fix what look names");
	// Any other name, a concept at an owed folder (it shows inside Concepts) and a save of icons alone get none.
	const other = read(
		await f.call("save_app", save("products-2", "other-1", manifest("View"), [{ path: "index.html", text: PAGE }])),
	);
	expect(other).not.toHaveProperty("look");
	const g = await fixture();
	const concept = read(
		await g.call(
			"save_app",
			save("money", "make-1", manifest("Money", { concept: true, cover: "./cover.webp" }), [
				{ path: "index.html", text: PAGE },
			]),
		),
	);
	expect(concept).toMatchObject({ state: "applied" });
	expect(concept).not.toHaveProperty("look");
	// A change of it keeps it a concept, so still none (the change path reads concept from the stored manifest).
	const kept = read(await g.call("save_app", save("money", "change-1", null, [{ path: "state.json", text: "{}" }])));
	expect(kept).toMatchObject({ state: "applied", created: false });
	expect(kept).not.toHaveProperty("look");
	expect(parseAppManifest(g.text("apps/money/app.toml") ?? "")).toMatchObject({ manifest: { concept: true } });
	const drawn = read(
		await f.call("save_app", save("ads", "icons-1", null, [{ path: "icons/megaphone.svg", text: ICON }])),
	);
	expect(drawn).toMatchObject({ state: "applied" });
	expect(drawn).not.toHaveProperty("look");
	expect(drawn.next).toContain("Tell the member in one line what you drew");
});

it("marks an app as a concept with its cover, and keeps both when a later change leaves them out", async () => {
	const f = await fixture();
	await f.call(
		"save_app",
		save("shop", "make-1", manifest("Shop", { concept: true, cover: "./cover.webp" }), [
			{ path: "index.html", text: PAGE },
		]),
	);
	expect(f.text("apps/shop/app.toml")).toContain('concept = true\ncover = "cover.webp"\n');
	expect(parseAppManifest(f.text("apps/shop/app.toml") ?? "")).toMatchObject({
		ok: true,
		manifest: { name: "Shop", concept: true, cover: "cover.webp" },
	});
	await f.call("save_app", save("shop", "change-1", manifest("Shop, round 2"), []));
	expect(parseAppManifest(f.text("apps/shop/app.toml") ?? "")).toMatchObject({
		ok: true,
		manifest: { name: "Shop, round 2", concept: true, cover: "cover.webp" },
	});
	await f.call("save_app", save("shop", "change-2", manifest("Shop", { concept: false }), []));
	expect(parseAppManifest(f.text("apps/shop/app.toml") ?? "")).toMatchObject({
		ok: true,
		manifest: { concept: false, cover: "cover.webp" },
	});
});

it("lists what the page may ask a member to change, and keeps it when a later change leaves it out", async () => {
	const f = await fixture();
	await f.call(
		"save_app",
		save(
			"orders",
			"make-1",
			manifest("Orders", { reads: ["tables", "questions"], writes: ["answers", "table:orders", "answers"] }),
			[{ path: "index.html", text: PAGE }],
		),
	);
	expect(f.text("apps/orders/app.toml")).toContain(
		'reads = ["tables", "questions"]\nwrites = ["answers", "table:orders"]\n',
	);
	await f.call("save_app", save("orders", "change-1", manifest("Orders to ship"), []));
	expect(parseAppManifest(f.text("apps/orders/app.toml") ?? "")).toMatchObject({
		ok: true,
		manifest: { name: "Orders to ship", writes: ["answers", "table:orders"] },
	});
	// An empty list takes it away: the page only shows again.
	await f.call("save_app", save("orders", "change-2", manifest("Orders to ship", { writes: [] }), []));
	expect(f.text("apps/orders/app.toml")).not.toContain("writes");
	// company_write checks an app.toml the same way: a table the platform's own page keeps is never listed.
	const me = f.identity.staffAgentId.toLowerCase();
	await refuses(
		f.call("company_write", {
			path: "apps/orders/app.toml",
			operationKey: "w-1",
			expectedVersion: f.files.get("apps/orders/app.toml")?.version as string,
			text: `name = "Orders"\nposted = false\nowner = "${me}"\nwrites = ["table:areas"]\n`,
		}),
		"APP_MANIFEST_INVALID",
	);
});

it("posts an app by its one line, and refuses posted through company_write", async () => {
	const f = await fixture({ folders: ["apps"], files: { "apps/sales/index.html": PAGE } });
	const me = f.identity.staffAgentId.toLowerCase();
	f.seed("apps/sales/app.toml", `name = "Sales" # shown\nposted = false\nemblem = "chart"\nowner = "${me}"\n`);
	const posted = read(await f.call("post_app", { name: "sales", operationKey: "post-1", posted: true }));
	expect(posted).toMatchObject({ schema: "qorpera.app-post/v1", state: "applied", posted: true });
	expect(f.text("apps/sales/app.toml")).toBe(
		`name = "Sales" # shown\nposted = true\nemblem = "chart"\nowner = "${me}"\n`,
	);
	expect(read(await f.call("post_app", { name: "sales", operationKey: "post-2", posted: true }))).toMatchObject({
		state: "unchanged",
	});
	await refuses(f.call("post_app", { name: "nothing", operationKey: "post-3", posted: true }), "APP_NOT_FOUND");
	const versionOf = f.files.get("apps/sales/app.toml")?.version as string;
	await refuses(
		f.call("company_write", {
			path: "apps/sales/app.toml",
			operationKey: "w-1",
			expectedVersion: versionOf,
			text: `name = "Sales"\nposted = false\nowner = "${me}"\n`,
		}),
		"APP_POSTED_BY_POST_APP",
	);
	await refuses(
		f.call("company_write", {
			path: "apps/sales/app.toml",
			operationKey: "w-3",
			expectedVersion: versionOf,
			text: 'name = "Sales"\nposted = true\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\n',
		}),
		"APP_OWNER_FIXED",
	);
	await refuses(
		f.call("company_edit", {
			path: "apps/sales/app.toml",
			operationKey: "e-1",
			expectedVersion: versionOf,
			oldText: "posted = true",
			newText: "posted = false",
		}),
		"APP_POSTED_BY_POST_APP",
	);
	await refuses(
		f.call("company_write", {
			path: "apps/new/app.toml",
			operationKey: "w-2",
			expectedVersion: null,
			text: "name =",
		}),
		"APP_MANIFEST_INVALID",
	);
	// Other changes of the manifest are the agent's to make.
	const edited = read(
		await f.call("company_edit", {
			path: "apps/sales/app.toml",
			operationKey: "e-2",
			expectedVersion: versionOf,
			oldText: 'emblem = "chart"',
			newText: 'emblem = "board"',
		}),
	);
	expect(edited.state).toBe("applied");
});

it("leaves another agent's app to save_app, which asks first, and lets no app move in from elsewhere", async () => {
	const OTHER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	const f = await fixture({
		folders: ["apps", "drafts"],
		files: {
			"apps/sales/app.toml": `name = "Sales"\nowner = "${OTHER}"\nposted = true\n`,
			"apps/sales/index.html": PAGE,
			"drafts/x/app.toml": 'name = "X"\nposted = true\n',
			"drafts/x/index.html": PAGE,
			"drafts/note.md": "hi",
		},
	});
	const version = f.files.get("apps/sales/index.html")?.version as string;
	await refuses(
		f.call("company_write", {
			path: "apps/sales/index.html",
			operationKey: "w-1",
			expectedVersion: version,
			text: "<p>",
		}),
		"APP_NOT_YOURS",
	);
	// save_app reads the app before its review: another's app is delegation, the agent's own is not.
	const tool = f.tool("save_app");
	const prepare = (value: JsonValue) => tool.prepare?.(tool.parseArguments(value), f.context);
	expect(await prepare(save("sales", "s-1", null, [{ path: "index.html", text: "<p>new" }]))).toMatchObject({
		foreignOwner: true,
	});
	expect(
		await prepare(save("new-one", "s-2", manifest("New"), [{ path: "index.html", text: "<p>" }])),
	).not.toHaveProperty("foreignOwner");
	const move = (from: string, to: string) =>
		f.call("company_move", {
			from,
			to,
			operationKey: `m-${to.replaceAll("/", "-")}`,
			expectedVersion: f.files.get(from)?.version ?? "00000000-0000-4000-8000-000000000000",
			asOfSeq: f.files.has(from) ? null : 1,
		});
	await refuses(move("drafts/x", "apps/x"), "APP_MOVE_REFUSED");
	await refuses(move("drafts/x/app.toml", "apps/sales/app.toml"), "APP_MOVE_REFUSED");
	await refuses(move("drafts/note.md", "apps/sales/note.md"), "APP_NOT_YOURS");
});

it("posts its own app without review, and reviews posting or changing another's app as delegation", async () => {
	const { cloudActionEffect, describeCloudAction } = await import("@qorpera/runtime/cloud-action-review");
	const runtime = (name: string) => ({ name, source: "runtime" as const });
	expect(cloudActionEffect(runtime("save_app"), { name: "sales" })).toBe("internal");
	expect(cloudActionEffect(runtime("save_app"), { name: "sales", foreignOwner: true })).toBe("delegation");
	expect(cloudActionEffect(runtime("post_app"), { name: "sales", posted: true })).toBe("internal");
	expect(cloudActionEffect(runtime("post_app"), { name: "sales", posted: true, foreignOwner: true })).toBe(
		"delegation",
	);
	expect(describeCloudAction(runtime("post_app"), { name: "sales", posted: true }).title).toBe(
		"Post an app for every member",
	);
	expect(describeCloudAction(runtime("save_app"), { name: "sales", foreignOwner: true }).title).toBe(
		"Change another agent's app",
	);
	// 8 November 2026: an app opens as a page of its own, no longer beside the chat (#1524).
	expect(describeCloudAction(runtime("post_app"), { name: "sales", posted: true }).details.effect).toContain(
		"as a page of its own",
	);
	expect(describeCloudAction(runtime("save_app"), { name: "sales", foreignOwner: true }).details.effect).toContain(
		"as a page of its own",
	);
});

it("saves an app of any number, size and kind of files, reading the whole folder and releasing what it drew on", async () => {
	const app = 'name = "Ideas"\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\nposted = false\n';
	const notes = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`apps/ideas/n${n}.txt`, "note"]));
	const f = await fixture({
		folders: ["apps"],
		files: {
			"apps/ideas/app.toml": app,
			"apps/ideas/index.html": PAGE,
			"apps/ideas/studio.html": "x".repeat(600 * 1024),
			"apps/ideas/film.mp4": "x".repeat(13 * 1024 * 1024),
			"apps/ideas/model.glb": "x",
			"apps/ideas/type.woff2": "x",
			...notes,
		},
	});
	const answer = read(
		await f.call(
			"save_app",
			save("ideas", "big-1", null, [
				{ path: "n299.txt", text: "changed" },
				{ path: "scene.gltf", text: "{}" },
				{ path: "shaders/sky.glsl", text: "void main() {}" },
			]),
		),
	);
	expect(answer).toMatchObject({ state: "applied" });
	expect(f.text("apps/ideas/n299.txt")).toBe("changed");
	expect(f.text("apps/ideas/shaders/sky.glsl")).toBe("void main() {}");
});

it("posts only the manifest it checked: an app made or changed in between is refused, never posted unreviewed", async () => {
	const f = await fixture({ folders: ["apps"], files: { "apps/sales/index.html": PAGE } });
	const me = f.identity.staffAgentId.toLowerCase();
	const other = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	const tool = f.tool("post_app");
	const prepare = async (key: string) =>
		(await tool.prepare?.(tool.parseArguments({ name: "sales", operationKey: key, posted: true }), f.context)) as {
			foreignOwner?: boolean;
			checkedVersion: string | null;
		};
	// No manifest when checked, another agent's when posted.
	const missing = await prepare("p-1");
	expect(missing.foreignOwner).toBeUndefined();
	f.seed("apps/sales/app.toml", `name = "Sales"\nposted = false\nowner = "${other}"\n`);
	await refuses(tool.execute(missing as never, f.context), "APP_CHANGED");
	// Its own when checked, replaced by another's before the post.
	f.seed("apps/sales/app.toml", `name = "Sales"\nposted = false\nowner = "${me}"\n`);
	const own = await prepare("p-2");
	expect(own.foreignOwner).toBeUndefined();
	f.seed("apps/sales/app.toml", `name = "Sales" # theirs\nposted = false\nowner = "${other}"\n`);
	await refuses(tool.execute(own as never, f.context), "APP_CHANGED");
	expect(f.text("apps/sales/app.toml")).toContain("posted = false");
	// Another's checked as another's is delegation, and posts once the review allows it.
	const theirs = await prepare("p-3");
	expect(theirs.foreignOwner).toBe(true);
	expect(read(await tool.execute(theirs as never, f.context))).toMatchObject({ state: "applied", posted: true });
});

/* ---- The explainer kit (RUNTIME-INTERFACE-APPS.md §3a) --------------------------------------------------------- */

const SCENES = `V.part("The fee");
V.scene((s) => {
  const fee = s.number({ x: 800, y: 450, from: 149, size: 96 });
  s.say("Each traveller pays one visible fee: 149 kroner.", s.fadeIn(fee));
});
`;
/** The paths the last commit wrote, in its order. */
const units = (f: { commits: { units: Record<string, unknown>[] }[] }) =>
	f.commits.at(-1)?.units.map((unit) => unit.path);

it("makes an explainer from the agent's scenes alone: the kit's engine and page are written with them", async () => {
	const f = await fixture();
	const answer = read(
		await f.call(
			"save_app",
			save("fee", "make-1", manifest("How the fee works", { kit: "explainer", emblem: "coin" }), [
				{ path: "scenes.js", text: SCENES },
			]),
		),
	);
	expect(answer).toMatchObject({ state: "applied", app: "fee", created: true, link: "app:fee" });
	// A scenes.js in order gets no notes.
	expect(answer.look).toBeUndefined();
	const stored = parseAppManifest(f.text("apps/fee/app.toml") ?? "");
	expect(stored.ok && stored.manifest).toMatchObject({
		name: "How the fee works",
		kit: "explainer",
		entry: "index.html",
	});
	expect(f.text("apps/fee/app.toml")).toContain('kit = "explainer"\n');
	expect(f.text("apps/fee/scenes.js")).toBe(SCENES);
	expect(f.text("apps/fee/engine.js")).toBe(EXPLAINER_ENGINE_JS);
	expect(f.text("apps/fee/index.html")).toBe(explainerPage("How the fee works", []));
	expect(f.files.get("apps/fee/engine.js")?.file.mediaType).toBe("text/javascript");
	expect(f.files.get("apps/fee/index.html")?.file.mediaType).toBe("text/html");
});

it("keeps the kit's own files Qorpera's, and asks for scenes.js where there is none", async () => {
	const f = await fixture();
	const kit = manifest("How the fee works", { kit: "explainer" });
	for (const own of ["engine.js", "index.html", "Engine.JS"])
		await refuses(
			f.call(
				"save_app",
				save("fee", `own-${own}`, kit, [
					{ path: "scenes.js", text: SCENES },
					{ path: own, text: "mine" },
				]),
			),
			`APP_KIT_FILE: ${own} is the explainer kit's own file, which save_app writes`,
		);
	await refuses(
		f.call("save_app", save("fee", "none-1", kit, [])),
		"APP_SCENES_MISSING: a new explainer needs its scenes.js",
	);
	expect(f.commits).toEqual([]);
	const tool = f.tool("save_app");
	refusesArguments(
		tool,
		save("fee", "k", manifest("F", { kit: "slides" }), []),
		"manifest.kit must be one of explainer",
	);
	refusesArguments(
		tool,
		save("fee", "k", manifest("F", { kit: "explainer", entry: "main.html" }), []),
		"manifest.entry: an app made from a kit opens index.html",
	);
	// index.html said outright is what a kit opens anyway.
	expect(() =>
		tool.parseArguments(save("fee", "k", manifest("F", { kit: "explainer", entry: "index.html" }), [])),
	).not.toThrow();
});

it("tells the maker of an explainer what a read of its scenes found", async () => {
	const f = await fixture();
	const answer = read(
		await f.call(
			"save_app",
			save("fee", "make-1", manifest("How the fee works", { kit: "explainer" }), [
				{ path: "scenes.js", text: `const V = new Video(document.getElementById("video"));\n${SCENES}V.start();` },
			]),
		),
	);
	expect(answer.look).toEqual([
		"The page makes the video (V) and starts it: take new Video(…) and V.start() out of scenes.js, which only adds parts and scenes to V.",
	]);
	expect(answer.next).toContain("First fix what look names");
});

it("changes an explainer's scenes alone, and writes the kit's files again only where they would differ", async () => {
	const f = await fixture();
	await f.call(
		"save_app",
		save("fee", "make-1", manifest("How the fee works", { kit: "explainer" }), [{ path: "scenes.js", text: SCENES }]),
	);
	// New scenes, the manifest kept: one file is written, and the kit's stand as they are.
	const next = `${SCENES}V.part("The margin");\n`;
	const changed = read(await f.call("save_app", save("fee", "change-1", null, [{ path: "scenes.js", text: next }])));
	expect(changed).toMatchObject({ state: "applied", created: false });
	expect(units(f)).toEqual(["apps/fee/scenes.js"]);
	expect(f.text("apps/fee/scenes.js")).toBe(next);
	// The agent still may not write them.
	await refuses(
		f.call("save_app", save("fee", "change-2", null, [{ path: "index.html", text: "<p>mine" }])),
		"APP_KIT_FILE: index.html",
	);
	// A new title is the page's title too: the manifest and the page are written, the engine is not.
	await f.call("save_app", save("fee", "change-3", manifest("What the fee leaves"), []));
	expect(units(f)).toEqual(["apps/fee/app.toml", "apps/fee/index.html"]);
	expect(f.text("apps/fee/index.html")).toBe(explainerPage("What the fee leaves", []));
	expect(f.text("apps/fee/app.toml")).toContain('kit = "explainer"\n');
	// An engine from an earlier runtime, or one written over by hand, is put right by the next save.
	f.seed("apps/fee/engine.js", "// an old engine");
	await f.call("save_app", save("fee", "change-4", null, [{ path: "notes.md", text: "sources" }]));
	expect(units(f)).toEqual(["apps/fee/notes.md", "apps/fee/engine.js"]);
	expect(f.text("apps/fee/engine.js")).toBe(EXPLAINER_ENGINE_JS);
});

it("names in an explainer's page the voice clips its folder holds", async () => {
	const said = captionHash("Each traveller pays one visible fee: 149 kroner.");
	const gone = captionHash("A caption that was cut.");
	const f = await fixture();
	await f.call(
		"save_app",
		save("fee", "make-1", manifest("How the fee works", { kit: "explainer" }), [{ path: "scenes.js", text: SCENES }]),
	);
	// The clips and their list are written into the folder from a machine; one listed clip has no file.
	f.seed(`apps/fee/voice/${said}.mp4`, "clip");
	f.seed(
		"apps/fee/voice/clips.json",
		JSON.stringify({
			clips: [
				{ caption: said, file: `${said}.mp4`, seconds: 4.2 },
				{ caption: gone, file: `${gone}.mp4`, seconds: 2 },
			],
		}),
	);
	await f.call("save_app", save("fee", "voice-1", null, [{ path: "notes.md", text: "sources" }]));
	expect(units(f)).toEqual(["apps/fee/notes.md", "apps/fee/index.html"]);
	expect(f.text("apps/fee/index.html")).toBe(
		explainerPage("How the fee works", [{ caption: said, file: `${said}.mp4`, seconds: 4.2 }]),
	);
	// A list that does not read costs the video its voice, not the save.
	f.seed("apps/fee/voice/clips.json", "not json");
	await f.call("save_app", save("fee", "voice-2", null, [{ path: "notes.md", text: "more sources" }]));
	expect(f.text("apps/fee/index.html")).toBe(explainerPage("How the fee works", []));
});

it("turns a page into an explainer when its manifest takes the kit, and refuses a page of its own beside the kit", async () => {
	const OWNER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	const f = await fixture({
		folders: ["apps"],
		files: {
			"apps/fee/app.toml": `name = "Fee"\nowner = "${OWNER}"\nposted = true\n`,
			"apps/fee/index.html": PAGE,
		},
	});
	await refuses(
		f.call("save_app", save("fee", "kit-1", manifest("Fee", { kit: "explainer" }), [])),
		"APP_SCENES_MISSING: the explainer's scenes.js is not in its folder",
	);
	await f.call(
		"save_app",
		save("fee", "kit-2", manifest("Fee", { kit: "explainer" }), [{ path: "scenes.js", text: SCENES }]),
	);
	expect(f.text("apps/fee/index.html")).toBe(explainerPage("Fee", []));
	expect(f.text("apps/fee/engine.js")).toBe(EXPLAINER_ENGINE_JS);
	// Its owner and that it is posted stay as they were.
	const stored = parseAppManifest(f.text("apps/fee/app.toml") ?? "");
	expect(stored.ok && stored.manifest).toMatchObject({ kit: "explainer", owner: OWNER, posted: true });
	// A page of its own, named now for an app that has the kit already.
	const g = await fixture({
		folders: ["apps"],
		files: {
			"apps/fee/app.toml": `name = "Fee"\nowner = "${OWNER}"\nposted = false\nkit = "explainer"\n`,
			"apps/fee/scenes.js": SCENES,
			"apps/fee/main.html": PAGE,
		},
	});
	await refuses(
		g.call("save_app", save("fee", "entry-1", manifest("Fee", { entry: "main.html" }), [])),
		"APP_KIT_ENTRY",
	);
});

/* ---- An app's own icons (@qorpera/cloud-client/app-icons; 12 November 2026) ------------------------------------- */

const ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="18"/><path d="M24 13v22M13 24h22" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>';
const icons = (from: number, count: number) =>
	Array.from({ length: count }, (_, n) => ({ path: `icons/sign-${from + n}.svg`, text: ICON }));

it("tells in the guide icons how to draw an app's own icons, and on emblem that members may pick one", async () => {
	const f = await fixture();
	const schema = f.tool("save_app").inputSchema as {
		properties: { files: { description: string }; manifest: { properties: { emblem: { description: string } } } };
	};
	const guide = appGuide("icons");
	for (const said of [
		"An app's own icons are files icons/<id>.svg, the id one or two words for what it shows, such as compass or trail-sign",
		"When a member asks you for new icons for an app, draw 3 clearly different ones from its name and what its page shows",
		"save them in one call with manifest null and only the icons in files: an ask for icons never changes manifest.emblem",
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"> holding one bold, solid shape filled black (#000)',
		"white lines of stroke-width 2.6 to 3.4 with stroke-linecap round",
		"so it still reads at 34 px",
		"An app keeps at most 12: to draw more, give a new one the id of an old one it replaces.",
		"company_read shows an .svg as its text, not as a picture",
		"Then tell the member in one line what you drew, and that they pick one under Icon and colour in the app's menu in the apps drawer.",
	])
		expect(guide).toContain(said);
	expect(schema.properties.files.description).toContain("app_guide icons says how to draw them");
	expect(schema.properties.manifest.properties.emblem.description).toContain(
		"Members may pick another for their own drawer, or one of the app's own icons (app_guide icons says how to draw those).",
	);
});

it("saves an app's own icons alone, the manifest kept, and says where the member picks one", async () => {
	const f = await fixture();
	await f.call(
		"save_app",
		save("trips", "make-1", manifest("Trip planner", { emblem: "map" }), [{ path: "index.html", text: PAGE }]),
	);
	const before = f.text("apps/trips/app.toml");
	const answer = read(
		await f.call(
			"save_app",
			save("trips", "icons-1", null, [
				{ path: "icons/compass.svg", text: ICON },
				{ path: "./icons/trail-sign.svg", text: ICON },
				{ path: "icons/tent-2.svg", text: `<?xml version="1.0"?>\n<!-- a tent -->\n${ICON}\n` },
			]),
		),
	);
	expect(answer).toMatchObject({ state: "applied", created: false });
	expect(answer).not.toHaveProperty("look");
	expect(answer.next).toBe(
		"Saved. Tell the member in one line what you drew, and that they pick one under Icon and colour in the app's menu in the apps drawer.",
	);
	expect(units(f)).toEqual([
		"apps/trips/icons",
		"apps/trips/icons/compass.svg",
		"apps/trips/icons/trail-sign.svg",
		"apps/trips/icons/tent-2.svg",
	]);
	expect(f.text("apps/trips/icons/compass.svg")).toBe(ICON);
	expect(f.files.get("apps/trips/icons/compass.svg")?.file.mediaType).toBe("image/svg+xml");
	expect(f.text("apps/trips/app.toml")).toBe(before);
	// A save of a page with an icon among its files answers as any save of a page.
	const page = read(
		await f.call(
			"save_app",
			save("trips", "page-1", null, [
				{ path: "index.html", text: PAGE },
				{ path: "icons/compass.svg", text: ICON },
			]),
		),
	);
	expect(page.next).toContain("Show it to the member with a link in your message: [trips](app:trips).");
	// An explainer may have icons too: its kit's files stay as they are.
	await f.call(
		"save_app",
		save("fee", "make-2", manifest("How the fee works", { kit: "explainer" }), [{ path: "scenes.js", text: SCENES }]),
	);
	await f.call("save_app", save("fee", "icons-2", null, [{ path: "icons/coin-stack.svg", text: ICON }]));
	expect(units(f)).toEqual(["apps/fee/icons", "apps/fee/icons/coin-stack.svg"]);
});

it("refuses an icon the web could not draw, with what to change, and other files under icons/", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	const refusesIcon = (path: string, text: string, said: string) =>
		refusesArguments(tool, save("trips", "k", null, [{ path, text }]), said);
	const PLACE =
		"an app's own icon is icons/<id>.svg, its id lowercase letters, digits and hyphens, such as icons/compass.svg or icons/trail-sign.svg";
	for (const path of [
		"icons/Compass.svg",
		"icons/compass.SVG",
		"icons/a.png",
		"icons/trail sign.svg",
		"icons/more/compass.svg",
		"Icons/compass.svg",
		"icons/notes.md",
		"icons/-compass.svg",
	])
		refusesIcon(path, ICON, `${path}: ${PLACE}`);
	refusesIcon(
		"icons/compass.svg",
		ICON.replace('viewBox="0 0 48 48"', 'viewBox="0 0 24 24"'),
		'icons/compass.svg: an icon is drawn on the 48 by 48 grid: viewBox="0 0 48 48"',
	);
	refusesIcon(
		"icons/compass.svg",
		ICON.replace("<circle ", '<circle transform="rotate(4)" '),
		"icons/compass.svg: a circle may not have transform",
	);
	refusesIcon(
		"icons/compass.svg",
		ICON.replace('stroke="#fff"', 'stroke="#e33"'),
		"icons/compass.svg: fill and stroke are black where the colour goes, white where it is cut out, or none",
	);
	refusesIcon(
		"icons/compass.svg",
		'<svg viewBox="0 0 48 48"><text x="4" y="30">T</text></svg>',
		"icons/compass.svg: text is not a shape an icon may use",
	);
	refusesIcon(
		"icons/compass.svg",
		'<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="#fff"/></svg>',
		"icons/compass.svg: an icon needs at least one black shape",
	);
	refusesIcon("icons/compass.svg", `${ICON}<p>`, "icons/compass.svg: the icon must end with </svg>");
	refusesIcon(
		"icons/compass.svg",
		ICON.replace("</svg>", `${'<circle cx="1" cy="1" r="1"/>'.repeat(300)}</svg>`),
		"icons/compass.svg: an icon is at most 8 KiB",
	);
	// An SVG anywhere else in the app is the page's own, as before.
	expect(() =>
		tool.parseArguments(save("trips", "k", null, [{ path: "chart.svg", text: "<svg><text>1</text></svg>" }])),
	).not.toThrow();
	expect(f.commits).toEqual([]);
});

it("keeps at most 12 icons: a new one takes an old one's id, or an old one goes first", async () => {
	const f = await fixture();
	await refuses(
		f.call(
			"save_app",
			save("trips", "make-1", manifest("Trip planner"), [{ path: "index.html", text: PAGE }, ...icons(1, 13)]),
		),
		"APP_ICONS_FULL: an app keeps at most 12 icons, and this save gives it 13; save at most 12",
	);
	await f.call(
		"save_app",
		save("trips", "make-2", manifest("Trip planner"), [{ path: "index.html", text: PAGE }, ...icons(1, 3)]),
	);
	await f.call("save_app", save("trips", "icons-1", null, icons(4, 9)));
	expect([...f.files.keys()].filter((path) => path.startsWith("apps/trips/icons/"))).toHaveLength(12);
	await refuses(
		f.call("save_app", save("trips", "icons-2", null, icons(13, 3))),
		"APP_ICONS_FULL: an app keeps at most 12 icons, and this save would leave it 15: give each new icon the id of an old one it replaces (the oldest: sign-1, sign-2, sign-3), or delete old ones with company_delete first",
	);
	// Drawn over: three new icons under old ids leave it 12.
	const over = '<svg viewBox="0 0 48 48"><rect x="8" y="8" width="32" height="32" rx="6"/></svg>';
	const drawn = read(
		await f.call(
			"save_app",
			save(
				"trips",
				"icons-3",
				null,
				icons(1, 3).map((icon) => ({ ...icon, text: over })),
			),
		),
	);
	expect(drawn.state).toBe("applied");
	expect(f.text("apps/trips/icons/sign-2.svg")).toBe(over);
	// An app that holds more, as a machine may leave it, still saves its page; only a new icon is refused.
	f.seed("apps/trips/icons/sign-13.svg", ICON);
	expect(
		read(await f.call("save_app", save("trips", "page-1", null, [{ path: "index.html", text: PAGE }]))).state,
	).toBe("applied");
	await refuses(
		f.call("save_app", save("trips", "icons-4", null, [{ path: "icons/compass.svg", text: ICON }])),
		"APP_ICONS_FULL",
	);
});

it("reads retired.md and app.toml once across prepare and execute for own apps and re-reads for foreign or reviewed saves", async () => {
	const f = await fixture({ folders: ["apps"] });
	const me = f.identity.staffAgentId.toLowerCase();
	const other = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	f.seed("apps/mine/app.toml", `name = "Mine"\nowner = "${me}"\nposted = false\n`);
	f.seed("apps/mine/index.html", PAGE);
	f.seed("apps/theirs/app.toml", `name = "Theirs"\nowner = "${other}"\nposted = false\n`);
	f.seed("apps/theirs/index.html", PAGE);

	const readText = vi.spyOn(f.folder, "readText");
	const pathsRead = () => readText.mock.calls.map(([path]) => path);
	const tool = f.tool("save_app");

	const { actionReviewId: _ignoredReviewId, ...unreviewedContext } = f.context;
	const ownParsed = tool.parseArguments(
		save("mine", "own-1", null, [{ path: "index.html", text: `${PAGE}<!--1-->` }]),
	);
	const ownPrepared = (await tool.prepare?.(ownParsed, { ...unreviewedContext, callId: "call_own_1" })) ?? ownParsed;
	expect(read(await tool.execute(ownPrepared, { ...unreviewedContext, callId: "call_own_1" })).state).toBe("applied");
	expect(pathsRead().filter((path) => path === "apps/retired.md")).toHaveLength(1);
	expect(pathsRead().filter((path) => path === "apps/mine/app.toml")).toHaveLength(1);

	readText.mockClear();
	const foreignParsed = tool.parseArguments(
		save("theirs", "foreign-1", null, [{ path: "index.html", text: `${PAGE}<!--2-->` }]),
	);
	const foreignPrepared =
		(await tool.prepare?.(foreignParsed, { ...unreviewedContext, callId: "call_foreign_1" })) ?? foreignParsed;
	expect(read(await tool.execute(foreignPrepared, { ...unreviewedContext, callId: "call_foreign_1" })).state).toBe(
		"applied",
	);
	expect(pathsRead().filter((path) => path === "apps/retired.md")).toHaveLength(2);
	expect(pathsRead().filter((path) => path === "apps/theirs/app.toml")).toHaveLength(2);

	readText.mockClear();
	const reviewedParsed = tool.parseArguments(
		save("mine", "own-reviewed", null, [{ path: "index.html", text: `${PAGE}<!--3-->` }]),
	);
	const reviewedPrepared =
		(await tool.prepare?.(reviewedParsed, { ...unreviewedContext, callId: "call_reviewed_1" })) ?? reviewedParsed;
	expect(
		read(
			await tool.execute(reviewedPrepared, {
				...unreviewedContext,
				callId: "call_reviewed_1",
				actionReviewId: "rev_1",
			}),
		).state,
	).toBe("applied");
	expect(pathsRead().filter((path) => path === "apps/retired.md")).toHaveLength(2);
	expect(pathsRead().filter((path) => path === "apps/mine/app.toml")).toHaveLength(2);
});
