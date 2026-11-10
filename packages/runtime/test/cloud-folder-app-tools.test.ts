import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import { appLookNotes, cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}) {
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

it("offers save_app and post_app as Company File tools", async () => {
	const f = await fixture();
	expect(f.tools.slice(0, 2).map((tool) => [tool.name, tool.source])).toEqual([
		["save_app", "company_file"],
		["post_app", "company_file"],
	]);
});

it("tells how to make a page worth opening, within the bytes a tool's description may hold", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	// The tool boundary refuses a tool whose description is over 4096 bytes, and with it every run: the lists of
	// emblems and colours are part of this one, so a longer list can push it over.
	expect(Buffer.byteLength(tool.description)).toBeLessThanOrEqual(4096);
	for (const rule of [
		"The first screen answers how this stands, without scrolling, on a laptop and on a phone",
		"A page with nothing to look at is a document, not an app.",
		"Fold nothing a member needs into <details> or closed rows.",
		"Links open on a member's click: href app:<name> another app, folder:<path> a file of the company's own work, https://… a web page in a new tab, #id a place in the page; nothing else opens.",
		"Every app starts from Qorpera's base style, which your own CSS overrides",
		"the company's colours as variables, so the apps look like one company; files says which",
		"Make it work at phone width (about 390 px)",
		"The answer's look names what a quick read of the saved page found: fix it, unless it does not fit this page.",
	])
		expect(tool.description).toContain(rule);
	// The web opens an app's links and gives it a base style now: the description no longer says otherwise.
	expect(tool.description).not.toMatch(/does not open inside an app|copied in because/);
	// How a page reads live data is said on reads, which the schema's 64 KiB hold.
	const schema = JSON.stringify(tool.inputSchema);
	for (const call of [
		"qorpera.read(path) gives a file's text",
		"qorpera.table(name) gives {name, columns, rows}",
		"qorpera.todos() gives every agent's todos as {agent, title, status, updatedAt}",
		"qorpera.agents() gives each agent's name, role and working",
		"qorpera.onChange(fn) calls fn when the company folder changed",
		"qorpera.questions() gives your and the other agents' open questions to this member that point at this app",
		"Reading changes nothing: writes says what a page may ask a member to change.",
		// The bridge gives an app 120 calls a minute and counts todos as ten, and a busy company's folder changes every
		// few seconds: a page that drew on every change would spend that in seconds and then show an error.
		"after a change draw again once, no sooner than ten seconds after the last draw however many changes arrive",
		"An app may make 120 calls a minute in a member's tab and 8 at a time, and todos counts as ten calls",
		"When a read fails, keep what the page last showed and read again ten seconds later, until a read works",
	])
		expect(schema).toContain(call);
	// So is the base style a page starts from: its variables, where the company's colours come from, light and dark.
	const files = JSON.stringify((tool.inputSchema as { properties: { files: unknown } }).properties.files);
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

it("tells on writes how a page lets a member act, and that nothing is saved without the member's yes", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	expect(tool.description).toContain("writes: what it may ask a member to change");
	const properties = (tool.inputSchema as { properties: { manifest: { properties: Record<string, unknown> } } })
		.properties.manifest.properties;
	const writes = JSON.stringify(properties.writes);
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
	])
		expect(writes).toContain(rule);
});

it("refuses arguments it cannot save before anything is read", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	refusesArguments(tool, save("Sales", "k", manifest("S"), []), "name must be the app's folder name");
	refusesArguments(tool, save("sales", "k", null, []), "give a manifest, files, or both");
	refusesArguments(tool, save("sales", "k", null, [{ path: "../x.html", text: "" }]), "relative to the app's folder");
	refusesArguments(tool, save("sales", "k", null, [{ path: "app.toml", text: "" }]), "written from manifest");
	refusesArguments(tool, save("sales", "k", null, [{ path: "run.sh", text: "" }]), "an app's text files are");
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
		save("sales", "k", manifest("S", { emblem: "rocket" }), []),
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
	"this reads as a document. Aim at about 300: show the state as numbers, marks, a chart or a diagram, and keep the long reasoning in its file.";
const UNSHOWN_NOTE = "Nothing to look at, only text: show the main thing as a picture, a chart, a map or a diagram.";
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
	// A page of text: a document past 500 words, and nothing to look at past 150 without a picture or a drawing.
	expect(appLookNotes(`<p>${words(150)}</p>`)).toEqual([]);
	expect(appLookNotes(`<p>${words(151)}</p>`)).toEqual([UNSHOWN_NOTE]);
	expect(appLookNotes(`<p>${words(501)}</p>`)).toEqual([`501 words: ${WORDS_NOTE}`, UNSHOWN_NOTE]);
	expect(appLookNotes(`<svg viewBox="0 0 10 10"></svg><p>${words(501)}</p>`)).toEqual([`501 words: ${WORDS_NOTE}`]);
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

it("counts a video as a file of its app, but not toward the bytes of the rest", async () => {
	const app = 'name = "Ideas"\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\nposted = false\n';
	const big = await fixture({
		folders: ["apps"],
		files: {
			"apps/ideas/app.toml": app,
			"apps/ideas/index.html": PAGE,
			"apps/ideas/a.mp4": "x".repeat(5 * 1024 * 1024),
		},
	});
	// Refused, this would throw.
	await big.call("save_app", save("ideas", "video-1", null, [{ path: "more.txt", text: "more" }]));
	const notes = Object.fromEntries(Array.from({ length: 62 }, (_, n) => [`apps/ideas/n${n}.txt`, "note"]));
	const full = await fixture({
		folders: ["apps"],
		files: { "apps/ideas/app.toml": app, "apps/ideas/index.html": PAGE, "apps/ideas/a.mp4": "x", ...notes },
	});
	await refuses(
		full.call("save_app", save("ideas", "video-2", null, [{ path: "one-more.txt", text: "more" }])),
		"APP_TOO_LARGE",
	);
});

it("counts pictures with videos, and refuses a change to an app holding a file too big to open", async () => {
	// 7 November 2026: Rumlig's demo app held 10 MB pages and 0.5-0.8 MB renders; it saved, and never opened.
	const app = 'name = "Demos"\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\nposted = false\n';
	const renders = await fixture({
		folders: ["apps"],
		files: {
			"apps/demos/app.toml": app,
			"apps/demos/index.html": PAGE,
			"apps/demos/room.jpg": "x".repeat(5 * 1024 * 1024),
			"apps/demos/walk.mp4": "x".repeat(3 * 1024 * 1024),
		},
	});
	// A 5 MiB render (past the 4 MiB of pages and code) and a 3 MiB video are within the pictures' and videos' bounds.
	await renders.call("save_app", save("demos", "media-1", null, [{ path: "notes.txt", text: "notes" }]));
	const page = await fixture({
		folders: ["apps"],
		files: {
			"apps/demos/app.toml": app,
			"apps/demos/index.html": PAGE,
			"apps/demos/studio.html": "x".repeat(600 * 1024),
		},
	});
	await refuses(
		page.call("save_app", save("demos", "media-2", null, [{ path: "notes.txt", text: "notes" }])),
		"APP_FILE_TOO_LARGE",
	);
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
