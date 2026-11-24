import { randomUUID } from "node:crypto";
import { AGENT_COLOURS } from "@qorpera/cloud-client/company-state-shared";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import { cloudAppGroupsTool, ORGANIZE_APPS_DESCRIPTION } from "@qorpera/runtime/cloud-folder-app-groups";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const PATH = "apps/groups.md";
const app = (title: string, more = "posted = true\n") => `name = "${title}"\n${more}`;
const APPS = {
	"apps/finances/app.toml": app("Company finances"),
	"apps/trip-planner/app.toml": app("Trip planner"),
	"apps/travel-supply/app.toml": app("Travel supply"),
	"apps/route-lofoten/app.toml": app("Lofoten"),
	"apps/draft/app.toml": app("Draft", "posted = false\n"),
	"apps/hut-concept/app.toml": app("Hut", "posted = true\nconcept = true\n"),
};
const SEEDED = `# Apps
Our own note: trips first.

- page:mailbox Mailbox
- group trips: Trips
  - app:trip-planner Trip planner
  - group routes: Routes
    - app:route-lofoten
- app:gone An app since deleted
`;

async function fixture(files: Record<string, string> = { ...APPS, [PATH]: SEEDED }) {
	const f = await folderWriterFixture({ files, folders: ["apps"] });
	runs.push(f.run);
	const tool = (operations = f.operations()) =>
		cloudAppGroupsTool({ folder: f.folder, operations, identity: f.identity });
	const call = async (value: JsonValue, organize: CloudNativeTool = tool()) => {
		const parsed = organize.parseArguments(value);
		const content = await organize.execute(parsed, { ...f.context, callId: randomUUID() });
		return JSON.parse(String(content.value));
	};
	return { ...f, tool, call };
}

async function refuses(call: Promise<unknown>, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(text);
}

it("lists the drawer as the company has it: the file's order, every group, the rest loose, and releases its reads", async () => {
	const f = await fixture();
	const listed = await f.call({ action: "list" });
	expect(listed).toEqual({
		schema: "qorpera.app-groups/v1",
		action: "list",
		file: PATH,
		groups: 2,
		looseApps: 2,
		notInCompany: ["app:gone"],
		layout: [
			"page:mailbox Mailbox",
			"group trips: Trips (2 apps)",
			"  app:trip-planner Trip planner",
			"  group routes: Routes (1 app)",
			"    app:route-lofoten Lofoten",
			// Not listed: the pages, then the apps by name, then Concepts (the concept app is inside it).
			"page:members Members",
			"page:bank Bank",
			"app:draft Draft (not posted)",
			"app:finances Company finances",
			"app:travel-supply Travel supply",
			"concepts Concepts",
		],
	});
	expect(f.commits).toHaveLength(0);
	expect(f.releases).toHaveLength(1);
	const released = f.releases[0]?.p_reads as { path: string; fileSha256?: string }[];
	expect(released.map((read) => read.path)).toEqual(expect.arrayContaining([PATH, "apps", "apps/finances/app.toml"]));
	expect(released.find((read) => read.path === PATH)?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
	// A runtime tool's answer names no Company File read: the boundary takes that only from a company_file tool, and
	// would answer the model that the call's outcome is unknown.
	const tool = f.tool();
	for (const value of [{ action: "list" }, { action: "create_group", name: "Money" }] as JsonValue[]) {
		const content = await tool.execute(tool.parseArguments(value), { ...f.context, callId: randomUUID() });
		expect(content).toEqual({ kind: "text", value: expect.any(String) });
	}
});

it("makes a group where its first item stood, answers its id, and keeps the notes", async () => {
	const f = await fixture();
	const made = await f.call({ action: "create_group", name: "Money", items: ["page:mailbox", "app:finances"] });
	expect(made).toMatchObject({ changed: true, group: "money", tidied: ["app:gone"] });
	expect(f.text(PATH)).toBe(`# Apps
Our own note: trips first.

- group money: Money
  - page:mailbox Mailbox
  - app:finances Company finances
- group trips: Trips
  - app:trip-planner Trip planner
  - group routes: Routes
    - app:route-lofoten
`);
	expect(f.commits[0]).toMatchObject({ receiptId: expect.any(String) });
	expect(f.commits[0]?.units[0]).toMatchObject({ op: "write", path: PATH, expectedVersion: expect.any(String) });
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	// The same again: that name is that group, and nothing changes.
	await expect(
		f.call({ action: "create_group", name: "money", items: ["page:mailbox", "app:finances"] }),
	).resolves.toMatchObject({ changed: false, group: "money", reused: true, note: "Already so: nothing changed" });
	expect(f.commits).toHaveLength(1);
	// A group inside one: a new id, never the one taken.
	await expect(f.call({ action: "create_group", name: "Trips", parent: "money" })).resolves.toMatchObject({
		changed: true,
		group: "trips-2",
	});
});

it("renames, moves and ungroups, and never gives a new group an id that was used", async () => {
	const f = await fixture();
	await expect(f.call({ action: "rename_group", group: "routes", name: "Hiking routes" })).resolves.toMatchObject({
		changed: true,
	});
	// Loose, before an entry the file does not list yet: the loose ones are listed in the drawer's order first.
	await expect(
		f.call({ action: "move", item: "app:travel-supply", group: null, before: "page:bank" }),
	).resolves.toMatchObject({ changed: true });
	// Into a group, before an entry there; then a whole group out to the top.
	await f.call({ action: "move", item: "app:draft", group: "trips", before: "app:trip-planner" });
	await f.call({ action: "move", item: "group:routes", group: null });
	await expect(f.call({ action: "ungroup", group: "trips" })).resolves.toMatchObject({ changed: true });
	// Already gone: already so.
	await expect(f.call({ action: "ungroup", group: "trips" })).resolves.toMatchObject({ changed: false });
	expect(f.text(PATH)).toBe(`# Apps
Our own note: trips first.

- page:mailbox Mailbox
- app:draft Draft
- app:trip-planner Trip planner
- page:members Members
- app:travel-supply Travel supply
- page:bank Bank
- app:finances Company finances
- concepts Concepts
- group routes: Hiking routes
  - app:route-lofoten

<!-- retired group ids: trips -->
`);
	await expect(f.call({ action: "create_group", name: "Trips" })).resolves.toMatchObject({ group: "trips-2" });
	await refuses(f.call({ action: "ungroup", group: "nothing" }), "No group nothing");
});

it("refuses a third level, a group inside itself, and keys the company does not have", async () => {
	const f = await fixture();
	await refuses(f.call({ action: "create_group", name: "Deep", parent: "routes" }), "two levels deep at most");
	await refuses(f.call({ action: "move", item: "group:trips", group: "routes" }), "inside itself");
	// trips holds a group, so it cannot go in another group.
	await f.call({ action: "create_group", name: "Market" });
	await refuses(f.call({ action: "move", item: "group:trips", group: "market" }), "two levels deep at most");
	await refuses(f.call({ action: "rename_group", group: "market", name: "trips" }), "taken");
	// routes holds no group: it may go in market, but not in a group inside trips.
	await expect(f.call({ action: "move", item: "group:routes", group: "market" })).resolves.toMatchObject({
		changed: true,
	});
	await refuses(f.call({ action: "move", item: "app:nothing", group: null }), "has no app:nothing");
	await refuses(f.call({ action: "move", item: "app:gone", group: "trips" }), "has no app:gone");
	await refuses(f.call({ action: "move", item: "app:hut-concept", group: "trips" }), "is a concept");
	await refuses(f.call({ action: "move", item: "app:finances", group: "nothing" }), "No group nothing");
	await refuses(
		f.call({ action: "move", item: "app:finances", group: "trips", before: "page:mailbox" }),
		"before must be an entry in group trips",
	);
	// Sites is the company's while it has a site, which this tool does not read: it is taken.
	await expect(f.call({ action: "move", item: "sites", group: "market" })).resolves.toMatchObject({ changed: true });
	const tool = f.tool();
	for (const [value, text] of [
		[{ action: "move", item: "app:finances" }, "move needs group"],
		[{ action: "list", name: "x" }, "list takes cursor"],
		[{ action: "list", cursor: -1 }, "cursor must be the cursor"],
		[{ action: "create_group", name: "x".repeat(41) }, "1 to 40 characters"],
		[{ action: "move", item: "Finances", group: null }, "item must be a key"],
		[{ action: "move", item: "app:finances", group: "Trips!" }, "group must be a group's id"],
		[{ action: "shuffle" }, "action must be one of"],
	] as [JsonValue, string][]) {
		expect(() => tool.parseArguments(value)).toThrow(CloudToolArgumentRefusal);
		expect(() => tool.parseArguments(value)).toThrow(text);
	}
	// group:<id> names a group wherever an id is taken.
	expect(tool.parseArguments({ action: "ungroup", group: "group:trips" })).toEqual({
		action: "ungroup",
		group: "trips",
	});
});

// Own code storage, step 4: What's new is the platform's page in the drawer, the bare whats-new. As Sites, it is the
// company's while a repository kept in Qorpera has a site, which this tool does not read: it is taken. app:whats-new is
// an agent's app, and a bare key the drawer does not know is still refused.
it("lists and places What's new, the platform's page, and still refuses a bare key the drawer does not know", async () => {
	const f = await fixture();
	await expect(f.call({ action: "move", item: "whats-new", group: "trips" })).resolves.toMatchObject({
		changed: true,
	});
	expect(f.text(PATH)).toBe(`# Apps
Our own note: trips first.

- page:mailbox Mailbox
- group trips: Trips
  - app:trip-planner Trip planner
  - group routes: Routes
    - app:route-lofoten
  - whats-new What's new
`);
	await expect(f.call({ action: "list" })).resolves.toMatchObject({
		groups: 2,
		layout: [
			"page:mailbox Mailbox",
			"group trips: Trips (2 apps)",
			"  app:trip-planner Trip planner",
			"  group routes: Routes (1 app)",
			"    app:route-lofoten Lofoten",
			"  whats-new What's new",
			"page:members Members",
			"page:bank Bank",
			"app:draft Draft (not posted)",
			"app:finances Company finances",
			"app:travel-supply Travel supply",
			"concepts Concepts",
		],
	});
	// A new group takes it, and it stands before another entry there.
	await expect(
		f.call({ action: "create_group", name: "Launch", items: ["whats-new", "app:finances"] }),
	).resolves.toMatchObject({ changed: true, group: "launch" });
	expect(f.text(PATH)).toContain(
		"- group launch: Launch\n  - whats-new What's new\n  - app:finances Company finances\n",
	);
	await refuses(f.call({ action: "move", item: "app:whats-new", group: null }), "has no app:whats-new");
	const tool = f.tool();
	for (const item of ["whats_new", "Whats-new", "page:whats-new", "news"]) {
		expect(() => tool.parseArguments({ action: "move", item, group: null })).toThrow(CloudToolArgumentRefusal);
		expect(() => tool.parseArguments({ action: "move", item, group: null })).toThrow(
			"item must be a key from organize_apps list (page:mailbox, page:members, page:bank, app:<name>, concepts, whats-new) or group:<id>",
		);
	}
	expect(ORGANIZE_APPS_DESCRIPTION).toContain("(Mailbox, Members, Bank, each posted app, Concepts, What's new)");
	expect(ORGANIZE_APPS_DESCRIPTION).toContain(
		"each entry by its key (page:mailbox, page:members, page:bank, app:<name>, concepts, whats-new)",
	);
});

it("makes the file, and the apps folder, when the company has none", async () => {
	const f = await fixture({ "apps/finances/app.toml": app("Company finances") });
	await expect(f.call({ action: "list" })).resolves.toMatchObject({ layout: expect.any(Array), looseApps: 1 });
	await expect(f.call({ action: "create_group", name: "Money", items: ["app:finances"] })).resolves.toMatchObject({
		changed: true,
		group: "money",
	});
	expect(f.text(PATH)).toBe(`# Apps
The company's apps in the drawer, kept by its agents with organize_apps.

- group money: Money
  - app:finances Company finances
`);
	const bare = await folderWriterFixture();
	runs.push(bare.run);
	const tool = cloudAppGroupsTool({ folder: bare.folder, operations: bare.operations(), identity: bare.identity });
	await tool.execute(
		tool.parseArguments({ action: "create_group", name: "Basics", items: ["page:bank"] }),
		bare.context,
	);
	expect(bare.commits[0]?.units[0]).toMatchObject({ op: "new_folder", path: "apps" });
	expect(bare.text(PATH)).toContain("- group basics: Basics\n  - page:bank Bank\n");
});

it("says refused when the file changed since it was read, and its receipt still completes", async () => {
	const f = await fixture();
	const original = CloudCompanyFolderClient.prototype.commit;
	const stored = f.files.get(PATH);
	if (!stored) throw new Error("Missing fixture file");
	const commit = vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	await expect(f.call({ action: "create_group", name: "Money" })).resolves.toMatchObject({
		changed: false,
		refused: "apps/groups.md changed since it was read; nothing changed: call again",
	});
	commit.mockRestore();
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
});

it("tells the rules within the bytes a tool's description may hold", async () => {
	expect(Buffer.byteLength(ORGANIZE_APPS_DESCRIPTION)).toBeLessThanOrEqual(4096);
	for (const rule of [
		"group by what the founder thinks in (a product, a customer, a piece of work), not by agent, by kind of page (such as Reports) or by date.",
		"Name a group in one to three of the company's own words.",
		"The basics (Mailbox, Bank, the finances, Members) stay loose at the front.",
		"Two group levels at most, three to twelve apps in a group; a group of one app is ungrouped.",
		"Members' own colours and changes in their own drawer are theirs and win there",
		"After a change, say it in one line to the member who asked.",
		// The groups' colours (12 November 2026).
		"Give every group a colour that sets it apart and fits its product or area; a group inside a group takes its parent's, so leave its own unset.",
		"- rename_group: group gets name; its id stays. colour_group: group gets colour, or none with null.",
	])
		expect(ORGANIZE_APPS_DESCRIPTION).toContain(rule);
	const f = await fixture();
	const tool = f.tool();
	expect([tool.name, tool.source]).toEqual(["organize_apps", "runtime"]);
});

it("puts a new app in a group as save_app makes it, in the same commit, and refuses a group that is not there", async () => {
	const f = await fixture();
	const tools = cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const save = tools.find((tool) => tool.name === "save_app") as CloudNativeTool;
	const call = async (value: JsonValue) => {
		const parsed = save.parseArguments(value);
		const prepared = (await save.prepare?.(parsed, f.context)) ?? parsed;
		return JSON.parse(String((await save.execute(prepared, { ...f.context, callId: randomUUID() })).value));
	};
	const page = [{ path: "index.html", text: "<!doctype html><h1>Bergen</h1>" }];
	const made = await call({
		name: "route-bergen",
		operationKey: "bergen-1",
		manifest: { title: "Bergen" },
		files: page,
		group: "routes",
	});
	expect(made).toMatchObject({ state: "applied", created: true, group: "routes", groupPlaced: "last in the group" });
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]?.units.map((unit) => [unit.op, unit.path])).toEqual([
		["new_folder", "apps/route-bergen"],
		["write", PATH],
	]);
	expect(f.text(PATH)).toContain("  - group routes: Routes\n    - app:route-lofoten\n    - app:route-bergen\n");
	// A change with a group leaves an app the layout lists where it stands.
	const changed = await call({
		name: "route-bergen",
		operationKey: "bergen-2",
		manifest: null,
		files: page,
		group: "trips",
	});
	expect(changed).toMatchObject({ state: "applied", groupPlaced: expect.stringContaining("not moved") });
	expect(f.commits.at(-1)?.units.map((unit) => unit.path)).toEqual(["apps/route-bergen/index.html"]);
	// An app the layout does not list yet goes in on a change too.
	await call({ name: "finances", operationKey: "fin-1", manifest: null, files: page, group: "trips" });
	expect(f.text(PATH)).toContain("- group trips: Trips\n  - app:trip-planner Trip planner\n");
	expect(f.text(PATH)).toMatch(/ {4}- app:route-bergen\n {2}- app:finances\n/);
	// A group that is not there: nothing is written.
	const before = f.commits.length;
	await refuses(
		call({ name: "new-one", operationKey: "new-1", manifest: { title: "New" }, files: page, group: "nothing" }),
		"APP_GROUP_NOT_FOUND",
	);
	await refuses(
		call({
			name: "new-two",
			operationKey: "new-2",
			manifest: { title: "New", concept: true },
			files: page,
			group: "trips",
		}),
		"APP_GROUP_CONCEPT",
	);
	expect(f.commits).toHaveLength(before);
	expect(f.folders.has("apps/new-one")).toBe(false);
	expect(() =>
		save.parseArguments({ name: "x", operationKey: "k", manifest: null, files: page, group: "No!" }),
	).toThrow("group must be a group's id");
});

it("lists a long layout a page at a time, and a change answers only what it did, however many apps there are", async () => {
	const files: Record<string, string> = {};
	const title = (n: number) => `App number ${n} ${"x".repeat(44)}`.slice(0, 60);
	// About 75 bytes a line as shown: 480 of them are more than one 32 KiB result holds.
	for (let n = 0; n < 480; n++) files[`apps/app-${String(n).padStart(3, "0")}/app.toml`] = app(title(n));
	const f = await fixture(files);
	const lines: string[] = [];
	let cursor: number | undefined;
	let pages = 0;
	do {
		const tool = f.tool();
		const value: JsonValue = cursor === undefined ? { action: "list" } : { action: "list", cursor };
		const content = await tool.execute(tool.parseArguments(value), { ...f.context, callId: randomUUID() });
		const text = String(content.value);
		expect(fitsOneResult(text)).toBe(true);
		const page = JSON.parse(text);
		lines.push(...page.layout);
		cursor = page.cursor;
		pages++;
	} while (cursor !== undefined && pages < 20);
	expect(pages).toBeGreaterThan(1);
	expect(lines).toHaveLength(3 + 480);
	expect(lines[3]).toBe(`app:app-000 ${title(0)}`);
	expect(lines.at(-1)).toBe(`app:app-479 ${title(479)}`);
	// Every app into one group: the answer stays small.
	const keys = Array.from({ length: 64 }, (_, n) => `app:app-${String(n).padStart(3, "0")}`);
	const tool = f.tool();
	const content = await tool.execute(tool.parseArguments({ action: "create_group", name: "Many", items: keys }), {
		...f.context,
		callId: randomUUID(),
	});
	expect(Buffer.byteLength(String(content.value))).toBeLessThan(1024);
	expect(JSON.parse(String(content.value))).toMatchObject({ changed: true, group: "many" });
});

it("pages a layout larger than a tool's JSON may hold at all", async () => {
	const files: Record<string, string> = {};
	const name = (n: number) => `a-${String(n).padStart(3, "0")}-${"b".repeat(54)}`;
	for (let n = 0; n < 300; n++) files[`apps/${name(n)}/app.toml`] = app("€".repeat(60));
	const f = await fixture(files);
	const lines: string[] = [];
	let cursor: number | undefined;
	let pages = 0;
	do {
		const value: JsonValue = cursor === undefined ? { action: "list" } : { action: "list", cursor };
		const page = await f.call(value);
		lines.push(...page.layout);
		cursor = page.cursor;
		pages++;
	} while (cursor !== undefined && pages < 40);
	expect(Buffer.byteLength(lines.join("\n"))).toBeGreaterThan(64 * 1024);
	expect(lines).toHaveLength(3 + 300);
	expect(lines.at(-1)).toBe(`app:${name(299)} ${"€".repeat(60)}`);
});

it("puts an entry moved loose without before last, after the ones the file does not list", async () => {
	const f = await fixture({
		"apps/a/app.toml": app("A"),
		"apps/b/app.toml": app("B"),
		[PATH]: "- group g: G\n  - app:a A\n  - page:bank\n",
	});
	await expect(f.call({ action: "move", item: "app:a", group: null })).resolves.toMatchObject({ changed: true });
	expect(f.text(PATH)).toBe(`- group g: G
  - page:bank
- page:mailbox Mailbox
- page:members Members
- app:b B
- app:a A
`);
	// Loose already, without before: it stays.
	await expect(f.call({ action: "move", item: "app:b", group: null })).resolves.toMatchObject({ changed: false });
});

it("keeps a title with a line or paragraph separator on its one line", async () => {
	const f = await fixture({ "apps/sales/app.toml": app("Sales\u2028Dash\u2029board"), [PATH]: "- group g: G\n" });
	await f.call({ action: "move", item: "app:sales", group: "g" });
	expect(f.text(PATH)).toBe("- group g: G\n  - app:sales Sales Dash board\n");
	await expect(f.call({ action: "list" })).resolves.toMatchObject({
		layout: [
			"group g: G (1 app)",
			"  app:sales Sales Dash board",
			"page:mailbox Mailbox",
			"page:members Members",
			"page:bank Bank",
		],
	});
});

it("says when save_app saved the app but its place in a group did not save", async () => {
	const f = await fixture();
	const tools = cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const save = tools.find((tool) => tool.name === "save_app") as CloudNativeTool;
	const original = CloudCompanyFolderClient.prototype.commit;
	const stored = f.files.get(PATH);
	if (!stored) throw new Error("Missing fixture file");
	const commit = vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	const parsed = save.parseArguments({
		name: "route-bergen",
		operationKey: "bergen-1",
		manifest: { title: "Bergen" },
		files: [{ path: "index.html", text: "<!doctype html><h1>Bergen</h1>" }],
		group: "routes",
	});
	const answer = JSON.parse(String((await save.execute(parsed, { ...f.context, callId: randomUUID() })).value));
	commit.mockRestore();
	expect(answer).toMatchObject({
		state: "partly_applied",
		group: "routes",
		groupPlaced: expect.stringMatching(/^not placed \(version_changed\)/),
	});
	expect(f.text(PATH)).not.toContain("app:route-bergen");
});

// The groups' colours (Jonas, 12 November 2026: "have the co-founder pick colours for fjeldtur's groups"): the company's
// colour of a group is one note line of apps/groups.md, and every change keeps it.
it("keeps a group's colour through a rename, a move of the group and a move of an app into it; ungroup takes it away", async () => {
	const f = await fixture({ ...APPS, [PATH]: `${SEEDED}\n<!-- group colours: trips=teal, routes=blue -->\n` });
	await expect(f.call({ action: "rename_group", group: "routes", name: "Hiking routes" })).resolves.toMatchObject({
		changed: true,
	});
	await expect(f.call({ action: "move", item: "group:routes", group: null })).resolves.toMatchObject({
		changed: true,
	});
	await expect(f.call({ action: "move", item: "app:finances", group: "trips" })).resolves.toMatchObject({
		changed: true,
	});
	expect(f.text(PATH)).toBe(`# Apps
Our own note: trips first.

- page:mailbox Mailbox
- group trips: Trips
  - app:trip-planner Trip planner
  - app:finances Company finances
- page:members Members
- page:bank Bank
- app:draft Draft
- app:travel-supply Travel supply
- concepts Concepts
- group routes: Hiking routes
  - app:route-lofoten

<!-- group colours: trips=teal, routes=blue -->
`);
	await expect(f.call({ action: "list" })).resolves.toMatchObject({
		layout: expect.arrayContaining([
			"group trips: Trips (2 apps, teal)",
			"group routes: Hiking routes (1 app, blue)",
		]),
	});
	// save_app putting a new app in a group keeps them too.
	const save = cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity }).find(
		(tool) => tool.name === "save_app",
	) as CloudNativeTool;
	const parsed = save.parseArguments({
		name: "route-bergen",
		operationKey: "bergen-1",
		manifest: { title: "Bergen" },
		files: [{ path: "index.html", text: "<!doctype html><h1>Bergen</h1>" }],
		group: "routes",
	});
	await save.execute((await save.prepare?.(parsed, f.context)) ?? parsed, { ...f.context, callId: randomUUID() });
	expect(f.text(PATH)).toContain(
		"- group routes: Hiking routes\n  - app:route-lofoten\n  - app:route-bergen\n\n<!-- group colours: trips=teal, routes=blue -->\n",
	);
	// A group taken away takes its colour with it.
	await expect(f.call({ action: "ungroup", group: "routes" })).resolves.toMatchObject({ changed: true });
	expect(f.text(PATH)).toMatch(
		/- app:route-lofoten\n- app:route-bergen\n\n<!-- retired group ids: routes -->\n\n<!-- group colours: trips=teal -->\n$/,
	);
});

it("gives a group a colour and takes it away, says when it is already so, and lists each group's colour", async () => {
	const f = await fixture();
	await expect(
		f.call({ action: "create_group", name: "Market", items: ["app:finances"], colour: "green" }),
	).resolves.toMatchObject({ changed: true, group: "market" });
	await expect(f.call({ action: "colour_group", group: "trips", colour: "teal" })).resolves.toMatchObject({
		action: "colour_group",
		changed: true,
	});
	expect(f.text(PATH)).toBe(`# Apps
Our own note: trips first.

- page:mailbox Mailbox
- group trips: Trips
  - app:trip-planner Trip planner
  - group routes: Routes
    - app:route-lofoten
- group market: Market
  - app:finances Company finances

<!-- group colours: trips=teal, market=green -->
`);
	// The colour it has already: nothing is saved.
	await expect(f.call({ action: "colour_group", group: "trips", colour: "teal" })).resolves.toMatchObject({
		changed: false,
		note: "Already so: nothing changed",
	});
	expect(f.commits).toHaveLength(2);
	await expect(f.call({ action: "list" })).resolves.toMatchObject({
		groups: 3,
		layout: [
			"page:mailbox Mailbox",
			"group trips: Trips (2 apps, teal)",
			"  app:trip-planner Trip planner",
			"  group routes: Routes (1 app)",
			"    app:route-lofoten Lofoten",
			"group market: Market (1 app, green)",
			"  app:finances Company finances",
			"page:members Members",
			"page:bank Bank",
			"app:draft Draft (not posted)",
			"app:travel-supply Travel supply",
			"concepts Concepts",
		],
	});
	// null takes it away; once gone, it is already so.
	await expect(f.call({ action: "colour_group", group: "trips", colour: null })).resolves.toMatchObject({
		changed: true,
	});
	expect(f.text(PATH)).toMatch(
		/\n- group market: Market\n {2}- app:finances Company finances\n\n<!-- group colours: market=green -->\n$/,
	);
	await expect(f.call({ action: "colour_group", group: "trips", colour: null })).resolves.toMatchObject({
		changed: false,
	});
	// create_group of a name already there gives that group the colour.
	await expect(f.call({ action: "create_group", name: "trips", colour: "gold" })).resolves.toMatchObject({
		changed: true,
		group: "trips",
		reused: true,
	});
	expect(f.text(PATH)).toContain("<!-- group colours: trips=gold, market=green -->\n");
	await refuses(f.call({ action: "colour_group", group: "nothing", colour: "teal" }), "No group nothing");
	const tool = f.tool();
	for (const [value, text] of [
		[{ action: "colour_group", group: "trips", colour: "red" }, "colour must be one of the palette's colours"],
		[{ action: "colour_group", group: "trips", colour: "Teal" }, "colour must be one of the palette's colours"],
		[{ action: "create_group", name: "Hiking", colour: "" }, "colour must be one of the palette's colours"],
		[{ action: "colour_group", group: "trips" }, "colour_group needs colour"],
		[{ action: "colour_group", colour: "teal" }, "colour_group needs group"],
		[{ action: "colour_group", group: "Trips!", colour: "teal" }, "group must be a group's id"],
		[{ action: "rename_group", group: "trips", name: "Trips", colour: "teal" }, "rename_group takes group, name"],
	] as [JsonValue, string][]) {
		expect(() => tool.parseArguments(value)).toThrow(CloudToolArgumentRefusal);
		expect(() => tool.parseArguments(value)).toThrow(text);
	}
	expect(() => tool.parseArguments({ action: "colour_group", group: "trips", colour: "red" })).toThrow(
		`colour must be one of the palette's colours (${AGENT_COLOURS.join(", ")}), or null for none`,
	);
	// create_group's null is no colour, as leaving it out is.
	expect(tool.parseArguments({ action: "create_group", name: "Hiking", colour: null })).toEqual({
		action: "create_group",
		name: "Hiking",
	});
	expect(tool.parseArguments({ action: "colour_group", group: "group:trips", colour: null })).toEqual({
		action: "colour_group",
		group: "trips",
		colour: null,
	});
	const properties = (tool.inputSchema as { properties: Record<string, JsonValue> }).properties;
	expect(properties.colour).toEqual({ type: ["string", "null"], enum: [...AGENT_COLOURS, null] });
	expect((properties.action as { enum: string[] }).enum).toContain("colour_group");
});
