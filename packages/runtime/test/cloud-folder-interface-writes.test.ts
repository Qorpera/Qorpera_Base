import { createHash, randomUUID } from "node:crypto";
import { CARDS_TABLE, NUMBERS_TABLE, PULSE_INTERFACE } from "@qorpera/cloud-client/interface-library";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderError } from "@qorpera/runtime/cloud-company-folder-client";
import { cloudInterfaceWriteTools } from "@qorpera/runtime/cloud-folder-interface-writes";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(
	seed: Parameters<typeof folderWriterFixture>[0] = {},
	options: Parameters<typeof folderWriterFixture>[1] = {},
) {
	const f = await folderWriterFixture(seed, options);
	runs.push(f.run);
	const make = () => cloudInterfaceWriteTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const tools = make();
	const tool = (name: string, from = tools) => from.find((candidate) => candidate.name === name) as CloudNativeTool;
	// As the boundary calls a tool: its arguments parsed, then prepared for the review, then run.
	const call = async (name: string, value: JsonValue, context: CloudToolContext = f.context, from = tools) => {
		const parsed = tool(name, from).parseArguments(value);
		const prepared = (await tool(name, from).prepare?.(parsed, context)) ?? parsed;
		return tool(name, from).execute(prepared, context);
	};
	const prepare = async (value: JsonValue, context: CloudToolContext = f.context) => {
		const save = tool("save_interface");
		return (await save.prepare?.(save.parseArguments(value), context)) as Record<string, JsonValue>;
	};
	const version = (path: string) => f.files.get(path)?.version;
	// The run's context without an approval: a change that needs one is refused.
	const { actionReviewId: _review, ...direct } = f.context;
	return { ...f, make, tools, tool, call, prepare, version, direct: direct as CloudToolContext };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** An answer, which always fits one tool result. */
function read(content: CloudToolContent) {
	expect(fitsOneResult(String(content.value))).toBe(true);
	return JSON.parse(String(content.value));
}
/** The answer was released under the hash of exactly its text, with these entries, and cites that release. */
function cites(f: Fixture, content: CloudToolContent, paths: readonly string[]) {
	const release = f.releases.at(-1);
	expect(release).toMatchObject({ p_release_id: content.companyReadId, p_output_sha256: sha(String(content.value)) });
	expect((release?.p_reads as { path: string }[]).map((entry) => entry.path)).toEqual(paths);
}
async function refuses(call: Promise<unknown>, type: typeof CloudToolRefusal, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(type);
	expect((error as Error).message).toContain(text);
}
/** A call that ended after its commit without its answer: never a refusal, which says nothing happened, so the boundary
 * answers TOOL_OUTCOME_UNCONFIRMED and the model repeats the same call. */
async function unconfirmed(call: Promise<unknown>) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).cause).toBeInstanceOf(CloudToolRefusal);
}
/** The arguments are refused as they are parsed, before anything is read. */
function refusesArguments(f: Fixture, name: string, value: JsonValue, text: string) {
	let error: unknown = null;
	try {
		f.tool(name).parseArguments(value);
	} catch (thrown) {
		error = thrown;
	}
	expect(error).toBeInstanceOf(CloudToolArgumentRefusal);
	expect((error as Error).message).toContain(text);
}
/** The id `table_write` makes for a new row's id column: from the run, the call's operation key and the row's place. */
function madeId(runId: string, operationKey: string, set: number, column = "id") {
	const hex = createHash("sha256")
		.update(`qorpera.table-write-row/v1:${runId}:${operationKey}:${set}:${column}`)
		.digest("hex");
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const AGENT = "0b1c2d3e-1111-4111-8111-111111111111";
const C1 = "1a2b3c4d-0000-4000-8000-000000000001";
const C2 = "1a2b3c4d-0000-4000-8000-000000000002";
const NOTES_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const NOTES = "interfaces/notes/interface.toml";
const NOTES_README = "interfaces/notes/README.md";
const README = "Notes the team keeps for each other.\n";
const CARDS_HEAD = "id,card,area,holder,state,added_by,todo";
const CARDS_ROWS = `${CARDS_HEAD}\n${C1},Bake,sales,,open,,\n${C2},Sell,sales,,open,,\n`;
const CARDS = { "tables/cards/table.toml": CARDS_TABLE, "tables/cards/rows.csv": CARDS_ROWS };
const CARDS_FILES = ["tables/cards/table.toml", "tables/cards/rows.csv"];
const NUMBERS_HEAD = "number,at,value,unit,target,kept_by";

/** The Notes interface: one view with a list of numbers and a message button. */
const page = (name: string, options: { edit?: "anyone" | "owners"; main?: boolean } = {}) =>
	`format = "qorpera.interface/v0"

[interface]
id = "${NOTES_ID}"
name = "${name}"
main = ${options.main ?? false}

[access]
members = "all"
agents = "all"
edit = "${options.edit ?? "anyone"}"

[[view]]
name = "Notes"

[[view.block]]
kind = "list"
from = "table:numbers"
line = "{number}"
buttons = ["ask"]

[[button]]
id = "ask"
verb = "message"
label = "Ask"
to = "co-founder"
`;
const save = (operationKey: string, files: { path: string; expectedVersion?: string | null; text: string }[]) => ({
	operationKey,
	files: files.map((file) => ({ path: file.path, expectedVersion: file.expectedVersion ?? null, text: file.text })),
});
const rows = (
	table: string,
	operationKey: string,
	set: Record<string, JsonValue>[],
	remove: Record<string, JsonValue>[] = [],
) => ({ table, operationKey, set, remove });

const WAITING =
	"The change waits for a member's approval: do not make it again; tell the member it is waiting for them.";
const READ_AGAIN = "read it again and make your change on its current version, with a new operationKey";
const BLOCKED = {
	exists: `Nothing was saved. A file is already at a path you gave no version for: ${READ_AGAIN}.`,
	missing: "Nothing was saved. A path you gave a version for is gone: read again, and save with a new operationKey.",
	version_changed: `Nothing was saved. A file changed since your version: ${READ_AGAIN}.`,
	not_a_folder:
		"Nothing was saved. Something at an interface's or table's folder is a file or a link, not a folder: choose another name.",
	folder_missing:
		"Nothing was saved. A README goes in an interface's or table's folder that exists, or in the same call as the interface.toml or table.toml that makes it.",
	owners_only:
		"Nothing was saved. Only the owners edit this interface (access edit = owners): tell the member what you would change.",
	rows_do_not_fit:
		"Nothing was saved. The table's rows do not fit the new definition. Change it in steps: add a required column as optional, fill it in every row with table_write, then make it required; to remove a column, make it optional and empty it in every row with table_write, then remove it.",
};
const ROWS = {
	broken: "Nothing was saved. The table's table.toml cannot be read (the problems): tell the member.",
	rows_do_not_fit:
		"Nothing was saved. Some of the table's rows do not fit its definition (the problems), and table_write changes only a table whose rows all fit: tell the member.",
	not_a_writer:
		"Nothing was saved. You may not write this table's rows (its [write] agents do not name you): tell the member what you would change.",
	invalid: "Nothing was saved. Fix the problems listed and call again with a new operationKey.",
	claim: "Nothing was saved. A needs_yes cell (a claim) is not yours to change: leave it as it is, or tell the member.",
	too_large:
		"Nothing was saved. The rows would be larger than 64 KiB, the most a table holds for now: remove rows first, or tell the member.",
};

it("offers the two write tools as Company File tools", async () => {
	const f = await fixture();
	expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([
		["save_interface", "company_file"],
		["table_write", "company_file"],
	]);
	expect(f.tools.map((tool) => (tool.inputSchema as { required: string[] }).required)).toEqual([
		["operationKey", "files"],
		["table", "operationKey", "set", "remove"],
	]);
});

it("refuses arguments it cannot save before anything is read", async () => {
	const f = await fixture();
	const one = (path: string, text = "x") => save("save-1", [{ path, text }]);
	refusesArguments(f, "save_interface", one("tables/cards/rows.csv"), "A table's rows are written with table_write");
	for (const path of ["interfaces/Notes/interface.toml", "docs/plan.md", "interfaces/notes/views.toml"])
		refusesArguments(f, "save_interface", one(path), "each path is interfaces/<name>/interface.toml");
	refusesArguments(f, "save_interface", { operationKey: "save-1", files: [] }, "files must be a list of 1 to 8 files");
	refusesArguments(
		f,
		"save_interface",
		save("save-1", [
			{ path: NOTES_README, text: "a" },
			{ path: NOTES_README, text: "b" },
		]),
		"files names the same path twice",
	);
	refusesArguments(f, "save_interface", one(NOTES, "format = 1\n"), `${NOTES} cannot be saved`);
	refusesArguments(
		f,
		"table_write",
		rows("cards", "write-1", []),
		"table_write needs at least one row in set or remove",
	);
	refusesArguments(f, "table_write", rows("Cards", "write-1", [{ card: "x" }]), "table must be a folder name");
	refusesArguments(f, "table_write", rows("cards", "write-1", [{ "Due-Date": "x" }]), "a column name is lowercase");
	refusesArguments(
		f,
		"table_write",
		rows("cards", "write-1", [], [{ id: null }]),
		"each value in remove is a row's key value",
	);
	expect(f.releases).toEqual([]);
	expect(f.commits).toEqual([]);
});

it("makes a new interface as a new folder, only with the review's approval, and a replay finds it made", async () => {
	const f = await fixture({ folders: ["interfaces"] });
	const value = save("notes-1", [
		{ path: NOTES, text: page("Notes") },
		{ path: NOTES_README, text: README },
	]);
	// The review's card says what changes, never the files; nothing is read, so nothing is released.
	expect(await f.prepare(value)).toMatchObject({
		operationKey: "notes-1",
		effect: "delegation",
		title: "Make a new interface",
		target: "Notes",
		details: [
			{ key: "buttons", value: "adds the button “Ask” (message)" },
			{ key: "who sees and edits", value: "seen by all members and all agents; anyone may edit it" },
			{ key: "views", value: "Notes" },
			{ key: "what it is for", value: README, quoted: true },
		],
	});
	expect(f.releases).toEqual([]);
	const made = await f.call("save_interface", value);
	expect(read(made)).toEqual({
		schema: "qorpera.interface-save-result/v1",
		state: "applied",
		operationKey: "notes-1",
		receiptId: expect.any(String),
		files: [{ path: "interfaces/notes", outcome: "saved", version: expect.any(String) }],
		next: [],
	});
	// The answer is the commit's outcome, under the call's receipt: nothing in it was read.
	expect(made.companyReadId).toBeUndefined();
	expect(f.recordings).toHaveLength(1);
	expect(f.recordings[0]?.p_request).toMatchObject({
		actionReviewId: f.context.actionReviewId,
		tool: "save_interface",
		argumentSha256: "a".repeat(64),
	});
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]).toMatchObject({ key: `save_interface:${sha("notes-1")}`, reviewId: expect.any(String) });
	const units = f.commits[0]?.units ?? [];
	expect(units.map((unit) => [unit.op, unit.path])).toEqual([["new_folder", "interfaces/notes"]]);
	expect((units[0]?.contents as { path: string }[]).map((item) => item.path)).toEqual(["interface.toml", "README.md"]);
	expect(f.text(NOTES)).toBe(page("Notes"));
	expect(f.text(NOTES_README)).toBe(README);
	// The same call again finds its change made, and says so, with what it read.
	const again = await f.call("save_interface", value);
	expect(read(again)).toEqual({
		schema: "qorpera.interface-save-result/v1",
		state: "unchanged",
		operationKey: "notes-1",
		receiptId: null,
		files: [],
		unchanged: [NOTES, NOTES_README],
		next: ["The files already hold this text, so there was nothing to save."],
	});
	cites(f, again, ["interfaces/notes", NOTES, NOTES_README]);
	expect(f.commits).toHaveLength(1);
});

it("refuses a change that needs the review's approval when the call has none, before anything is written", async () => {
	const f = await fixture({ folders: ["interfaces"] });
	await refuses(
		f.call("save_interface", save("notes-1", [{ path: NOTES, text: page("Notes") }]), f.direct),
		CloudToolRefusal,
		"This change needs the automatic review's approval of this call, and it has none",
	);
	expect(f.commits).toEqual([]);
	expect(f.ledger.size).toBe(0);
});

it("renames an interface at once, with a card released with the file it replaces", async () => {
	const f = await fixture({ files: { [NOTES]: page("Notes") } });
	const expectedVersion = f.version(NOTES) as string;
	const value = save("rename-1", [{ path: NOTES, expectedVersion, text: page("Notebook") }]);
	const card = {
		title: "Change an interface",
		target: "Notebook",
		details: [{ key: "also", value: "renamed from “Notes”" }],
	};
	expect(await f.prepare(value, f.direct)).toMatchObject({ effect: "internal", ...card });
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({ p_output_sha256: sha(cloudToolJsonText(card)) });
	expect((f.releases[0]?.p_reads as { path: string }[]).map((entry) => entry.path)).toEqual([
		"interfaces/notes",
		NOTES,
	]);
	const renamed = await f.call("save_interface", value, f.direct);
	expect(read(renamed)).toMatchObject({
		state: "applied",
		files: [{ path: NOTES, outcome: "saved", version: f.version(NOTES) }],
		next: [],
	});
	// The commit's answer is released too, with what the save read.
	cites(f, renamed, ["interfaces/notes", NOTES]);
	expect(f.recordings).toEqual([]);
	expect(f.commits[0]?.key).toBe(`save_interface:${sha("rename-1")}`);
	expect(f.commits[0]?.units).toMatchObject([{ op: "write", path: NOTES, expectedVersion }]);
	expect(f.text(NOTES)).toBe(page("Notebook"));
});

it("saves nothing when a file is not as the call expects, and says why with what it read", async () => {
	const cases: {
		name: string;
		seed: Parameters<typeof folderWriterFixture>[0];
		files: (f: Fixture) => { path: string; expectedVersion?: string | null; text: string }[];
		reason: keyof typeof BLOCKED;
		path: string;
		reads: string[];
	}[] = [
		{
			name: "a file at a path given no version",
			seed: { files: { [NOTES]: page("Notes") } },
			files: () => [{ path: NOTES, text: page("Notebook") }],
			reason: "exists",
			path: NOTES,
			reads: ["interfaces/notes", NOTES],
		},
		{
			name: "a file changed since its version",
			seed: { files: { [NOTES]: page("Notes") } },
			files: () => [{ path: NOTES, expectedVersion: randomUUID(), text: page("Notebook") }],
			reason: "version_changed",
			path: NOTES,
			reads: ["interfaces/notes", NOTES],
		},
		{
			name: "a version for a file that is gone",
			seed: { folders: ["interfaces"] },
			files: () => [{ path: NOTES, expectedVersion: randomUUID(), text: page("Notes") }],
			reason: "missing",
			path: NOTES,
			reads: [],
		},
		{
			name: "an interface only its owners edit",
			seed: { files: { [NOTES]: page("Notes", { edit: "owners" }) } },
			files: (f) => [{ path: NOTES, expectedVersion: f.version(NOTES), text: page("Notebook", { edit: "owners" }) }],
			reason: "owners_only",
			path: NOTES,
			reads: ["interfaces/notes", NOTES],
		},
		{
			name: "a README for an interface that does not exist",
			seed: { folders: ["interfaces"] },
			files: () => [{ path: "interfaces/ghost/README.md", text: README }],
			reason: "folder_missing",
			path: "interfaces/ghost/README.md",
			reads: [],
		},
		{
			name: "a file where the interface's folder would be",
			seed: { files: { "interfaces/odd": "odd" } },
			files: () => [{ path: "interfaces/odd/interface.toml", text: page("Odd") }],
			reason: "not_a_folder",
			path: "interfaces/odd/interface.toml",
			reads: ["interfaces/odd"],
		},
		{
			// The core keeps links out of interfaces/ (LK1); one is blocked as any other thing that is not a folder.
			name: "a link where the interface's folder would be",
			seed: { links: { "interfaces/odd": "../docs" } },
			files: () => [{ path: "interfaces/odd/interface.toml", text: page("Odd") }],
			reason: "not_a_folder",
			path: "interfaces/odd/interface.toml",
			reads: ["interfaces/odd"],
		},
	];
	for (const example of cases) {
		const f = await fixture(example.seed);
		const answer = await f.call("save_interface", save("save-1", example.files(f)));
		expect(read(answer), example.name).toEqual({
			schema: "qorpera.interface-save-result/v1",
			state: "not_applied",
			operationKey: "save-1",
			receiptId: null,
			files: [{ path: example.path, outcome: "blocked", reason: example.reason }],
			next: [BLOCKED[example.reason]],
		});
		if (example.reads.length > 0) cites(f, answer, example.reads);
		else expect(answer.companyReadId, example.name).toBeUndefined();
		expect(f.commits, example.name).toEqual([]);
	}
});

it("names a file that already holds the call's text as unchanged, an owners-only interface too", async () => {
	const f = await fixture({ files: { [NOTES]: page("Notes", { edit: "owners" }), [NOTES_README]: README } });
	const value = save("save-1", [
		{ path: NOTES, expectedVersion: f.version(NOTES), text: page("Notes", { edit: "owners" }) },
		{ path: NOTES_README, expectedVersion: f.version(NOTES_README), text: README },
	]);
	expect(await f.prepare(value)).toMatchObject({ effect: "internal", details: [] });
	const answer = await f.call("save_interface", value);
	expect(read(answer)).toMatchObject({ state: "unchanged", files: [], unchanged: [NOTES, NOTES_README] });
	cites(f, answer, ["interfaces/notes", NOTES, NOTES_README]);
	expect(f.commits).toEqual([]);
});

it("answers a change that waits for a member as proposed, and a replay answers from its receipt", async () => {
	const f = await fixture(
		{ files: { [NOTES]: page("Notes"), [NOTES_README]: "Old.\n" } },
		{
			hook: (path) =>
				path === NOTES_README ? { outcome: "waiting_for_review", reason: "waiting_for_review" } : null,
		},
	);
	const value = save("readme-1", [{ path: NOTES_README, expectedVersion: f.version(NOTES_README), text: README }]);
	const first = await f.call("save_interface", value, f.direct);
	const answer = {
		schema: "qorpera.interface-save-result/v1",
		state: "proposed",
		operationKey: "readme-1",
		receiptId: expect.any(String),
		files: [{ path: NOTES_README, outcome: "waiting_for_review", reason: "waiting_for_review" }],
		next: [WAITING],
	};
	expect(read(first)).toEqual(answer);
	expect(f.text(NOTES_README)).toBe("Old.\n");
	// A new set of tools, as a later turn has: the call's receipt answers, and nothing is committed again.
	const again = await f.call("save_interface", value, f.direct, f.make());
	expect(again.value).toBe(first.value);
	expect(f.commits).toHaveLength(1);
});

it("saves the interface that stops being main before the one that becomes main", async () => {
	const pulse = "interfaces/pulse/interface.toml";
	const f = await fixture({ folders: ["interfaces"], files: { [pulse]: PULSE_INTERFACE } });
	const value = save("main-1", [
		{ path: NOTES, text: page("Notes", { main: true }) },
		{
			path: pulse,
			expectedVersion: f.version(pulse),
			text: PULSE_INTERFACE.replace("main = true\n", "main = false\n"),
		},
	]);
	const card = await f.prepare(value);
	expect(card).toMatchObject({ effect: "delegation", title: "Change interfaces", target: "Notes, Pulse" });
	expect(card.details).toEqual(
		expect.arrayContaining([
			{ key: "Notes: main", value: "becomes the main interface" },
			{ key: "Pulse: main", value: "stops being the main interface" },
		]),
	);
	expect(read(await f.call("save_interface", value))).toMatchObject({
		state: "applied",
		files: [
			{ path: pulse, outcome: "saved" },
			{ path: "interfaces/notes", outcome: "saved" },
		],
	});
	expect(f.commits[0]?.units.map((unit) => [unit.op, unit.path])).toEqual([
		["write", pulse],
		["new_folder", "interfaces/notes"],
	]);
});

it("takes a column the definition drops out of the rows first, once it is optional and empty in every row", async () => {
	const definition = "tables/numbers/table.toml";
	const rowsFile = "tables/numbers/rows.csv";
	const withoutTarget = NUMBERS_TABLE.replace('[[column]]\nname = "target"\ntype = "number"\noptional = true\n\n', "");
	expect(withoutTarget).not.toBe(NUMBERS_TABLE);
	const readings = (target: string) =>
		`${NUMBERS_HEAD}\nmrr,2026-10-01T09:00:00Z,1200,€,${target},${AGENT}\nsignups,2026-10-08T09:00:00Z,40,count,,${AGENT}\n`;
	const f = await fixture({ files: { [definition]: NUMBERS_TABLE, [rowsFile]: readings("") } });
	const value = save("drop-1", [{ path: definition, expectedVersion: f.version(definition), text: withoutTarget }]);
	expect(await f.prepare(value)).toMatchObject({
		effect: "delegation",
		title: "Change a table",
		target: "Numbers",
		details: [{ key: "columns", value: "removes target" }],
	});
	expect(read(await f.call("save_interface", value))).toMatchObject({
		state: "applied",
		files: [
			{ path: rowsFile, outcome: "saved", version: f.version(rowsFile) },
			{ path: definition, outcome: "saved", version: f.version(definition) },
		],
		next: [],
	});
	expect(f.commits[0]?.units.map((unit) => [unit.op, unit.path])).toEqual([
		["write", rowsFile],
		["write", definition],
	]);
	expect(f.text(rowsFile)).toBe(
		`number,at,value,unit,kept_by\nmrr,2026-10-01T09:00:00Z,1200,€,${AGENT}\nsignups,2026-10-08T09:00:00Z,40,count,${AGENT}\n`,
	);
	// A column a row still holds a value in stays until table_write empties it.
	const held = await fixture({ files: { [definition]: NUMBERS_TABLE, [rowsFile]: readings("2000") } });
	const answer = await held.call(
		"save_interface",
		save("drop-1", [{ path: definition, expectedVersion: held.version(definition), text: withoutTarget }]),
	);
	expect(read(answer)).toEqual({
		schema: "qorpera.interface-save-result/v1",
		state: "not_applied",
		operationKey: "drop-1",
		receiptId: null,
		files: [
			{
				path: definition,
				outcome: "blocked",
				reason: "rows_do_not_fit",
				problems: [
					"target is still in the rows: make it optional and empty it in every row with table_write first",
				],
			},
		],
		next: [BLOCKED.rows_do_not_fit],
	});
	cites(held, answer, ["tables/numbers", definition, rowsFile]);
	expect(held.commits).toEqual([]);
});

it("sets, adds and removes rows in place, with the ids it made, and a replay finds its change made", async () => {
	const f = await fixture({ files: CARDS });
	const path = "tables/cards/rows.csv";
	const expectedVersion = f.version(path);
	const value = rows(
		"cards",
		"cards-1",
		[
			{ id: C1, state: "done" },
			{ card: "Ship", state: "open" },
		],
		[{ id: C2 }],
	);
	const made = madeId(f.identity.runId, "cards-1", 1);
	const written = await f.call("table_write", value);
	expect(read(written)).toEqual({
		schema: "qorpera.table-write-result/v1",
		state: "applied",
		operationKey: "cards-1",
		table: "cards",
		version: f.version(path),
		receiptId: expect.any(String),
		outcome: "saved",
		changed: { updated: 1, added: 1, removed: 1 },
		ids: [{ set: 1, column: "id", id: made }],
	});
	cites(f, written, CARDS_FILES);
	expect(f.text(path)).toBe(`${CARDS_HEAD}\n${C1},Bake,sales,,done,,\n${made},Ship,,,open,,\n`);
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]).toMatchObject({ key: `table_write:${sha("cards-1")}` });
	expect(f.commits[0]?.units).toMatchObject([{ op: "write", path, expectedVersion }]);
	// The same call again: its update is there, it finds the row it added by the id it makes again, and the row it
	// removed is gone.
	const again = await f.call("table_write", value);
	expect(read(again)).toEqual({
		schema: "qorpera.table-write-result/v1",
		state: "unchanged",
		operationKey: "cards-1",
		table: "cards",
		version: f.version(path),
		receiptId: null,
		changed: { updated: 0, added: 0, removed: 0 },
		notFound: 1,
		ids: [{ set: 1, column: "id", id: made }],
		next: "Nothing changed: the rows already hold these values, and the rows to remove that are not in the table (notFound) are gone.",
	});
	cites(f, again, CARDS_FILES);
	expect(f.commits).toHaveLength(1);
});

it("keeps every byte it does not change: the BOM, CRLF line ends and a quoted field", async () => {
	const BOM = String.fromCharCode(0xfeff);
	const path = "tables/cards/rows.csv";
	const text = `${BOM}${CARDS_HEAD}\r\n${C1},"Bake, then slice",sales,,open,,\r\n${C2},Sell,sales,,open,,\r\n`;
	const f = await fixture({ files: { "tables/cards/table.toml": CARDS_TABLE, [path]: text } });
	const value = rows("cards", "cards-1", [
		{ id: C2, state: "held" },
		{ card: "New, too", state: "open" },
	]);
	expect(read(await f.call("table_write", value))).toMatchObject({ state: "applied" });
	const made = madeId(f.identity.runId, "cards-1", 1);
	// Read as the tools read it: the fixture's own text() drops a byte order mark.
	const stored = await f.folder.readText(path, 64 * 1024, f.context.signal);
	expect(stored?.text).toBe(
		`${BOM}${CARDS_HEAD}\r\n${C1},"Bake, then slice",sales,,open,,\r\n${C2},Sell,sales,,held,,\r\n${made},"New, too",,,open,,\r\n`,
	);
});

it("writes a table's first rows as a new rows file", async () => {
	const f = await fixture({ files: { "tables/cards/table.toml": CARDS_TABLE } });
	const answer = await f.call("table_write", rows("cards", "cards-1", [{ card: "First", state: "open" }]));
	const made = madeId(f.identity.runId, "cards-1", 0);
	expect(read(answer)).toMatchObject({ state: "applied", changed: { updated: 0, added: 1, removed: 0 } });
	cites(f, answer, ["tables/cards/table.toml"]);
	const unit = f.commits[0]?.units[0];
	expect(unit).toMatchObject({ op: "write", path: "tables/cards/rows.csv", file: { mediaType: "text/csv" } });
	expect(unit).not.toHaveProperty("expectedVersion");
	expect(f.text("tables/cards/rows.csv")).toBe(`${CARDS_HEAD}\n${made},First,,,open,,\n`);
});

it("writes a number as decimal text, never in exponent form, given as text or as a JSON number", async () => {
	const rowsFile = "tables/numbers/rows.csv";
	const f = await fixture({ files: { "tables/numbers/table.toml": NUMBERS_TABLE, [rowsFile]: `${NUMBERS_HEAD}\n` } });
	const at = (day: number) => `2026-10-0${day}T09:00:00Z`;
	const answer = await f.call(
		"table_write",
		rows("numbers", "numbers-1", [
			{ number: "drift", at: at(1), value: "0.0000005", unit: "%", target: 0.00000012, kept_by: AGENT },
			{ number: "drift", at: at(2), value: 5e-7, unit: "%", kept_by: AGENT },
		]),
	);
	expect(read(answer)).toMatchObject({ state: "applied", changed: { updated: 0, added: 2, removed: 0 } });
	// String(5e-7) is "5e-7", which the reader refuses.
	expect(f.text(rowsFile)).toBe(
		`${NUMBERS_HEAD}\ndrift,${at(1)},0.0000005,%,0.00000012,${AGENT}\ndrift,${at(2)},0.0000005,%,,${AGENT}\n`,
	);
	// They read back as the numbers written: a row that holds one already is unchanged.
	const again = await f.call(
		"table_write",
		rows("numbers", "numbers-2", [{ number: "drift", at: at(2), value: 5e-7 }]),
	);
	expect(read(again)).toMatchObject({ state: "unchanged" });
});

it("changes nothing when the rows already hold the values", async () => {
	const f = await fixture({ files: CARDS });
	const answer = await f.call("table_write", rows("cards", "cards-1", [{ id: C1, card: "Bake", state: "open" }]));
	expect(read(answer)).toEqual({
		schema: "qorpera.table-write-result/v1",
		state: "unchanged",
		operationKey: "cards-1",
		table: "cards",
		version: f.version("tables/cards/rows.csv"),
		receiptId: null,
		changed: { updated: 0, added: 0, removed: 0 },
		next: "Nothing changed: the rows already hold these values.",
	});
	cites(f, answer, CARDS_FILES);
	expect(f.commits).toEqual([]);
});

it("answers a save or row write as unconfirmed when its answer cannot be released after the commit", async () => {
	const rowsFile = "tables/cards/rows.csv";
	const f = await fixture({ files: CARDS });
	const value = rows("cards", "cards-1", [{ id: C1, state: "done" }]);
	vi.spyOn(f.folder, "release").mockRejectedValueOnce(new CloudCompanyFolderError("unavailable"));
	await unconfirmed(f.call("table_write", value));
	expect(f.commits).toHaveLength(1);
	expect(f.text(rowsFile)).toBe(`${CARDS_HEAD}\n${C1},Bake,sales,,done,,\n${C2},Sell,sales,,open,,\n`);
	// The same call again finds its change made.
	const again = await f.call("table_write", value);
	expect(read(again)).toMatchObject({ state: "unchanged", changed: { updated: 0, added: 0, removed: 0 } });
	cites(f, again, CARDS_FILES);
	expect(f.commits).toHaveLength(1);

	const s = await fixture({ files: { [NOTES]: page("Notes") } });
	const rename = save("rename-1", [{ path: NOTES, expectedVersion: s.version(NOTES), text: page("Notebook") }]);
	const prepared = await s.prepare(rename, s.direct);
	vi.spyOn(s.folder, "release").mockRejectedValueOnce(new CloudCompanyFolderError("read_revoked"));
	await unconfirmed(s.tool("save_interface").execute(prepared, s.direct));
	expect(s.commits).toHaveLength(1);
	expect(s.text(NOTES)).toBe(page("Notebook"));
	const saved = await s.call("save_interface", rename, s.direct);
	expect(read(saved)).toMatchObject({ state: "unchanged", files: [], unchanged: [NOTES] });
	cites(s, saved, ["interfaces/notes", NOTES]);
	expect(s.commits).toHaveLength(1);
});

it("saves no rows that do not fit, and says why with the files it read", async () => {
	const f = await fixture({ files: CARDS });
	const version = f.version("tables/cards/rows.csv");
	const answer = await f.call(
		"table_write",
		rows(
			"cards",
			"cards-1",
			[{ id: C1, state: "lost" }, { card: "No state" }, { id: C2, nope: "x" }],
			[{ card: "Bake" }],
		),
	);
	expect(read(answer)).toEqual({
		schema: "qorpera.table-write-result/v1",
		state: "not_applied",
		operationKey: "cards-1",
		table: "cards",
		version,
		receiptId: null,
		reason: "invalid",
		problems: [
			"set 1: state is not one of its choices",
			"set 2: a new row needs state",
			"set 3: nope is not a column of this table",
			"remove 1: a row to remove is named by exactly its key columns: id",
		],
		next: ROWS.invalid,
	});
	cites(f, answer, CARDS_FILES);
	// A table keyed by its values gets no made key.
	const numbers = await fixture({
		files: { "tables/numbers/table.toml": NUMBERS_TABLE, "tables/numbers/rows.csv": `${NUMBERS_HEAD}\n` },
	});
	expect(
		read(await numbers.call("table_write", rows("numbers", "numbers-1", [{ value: 3, unit: "count" }]))),
	).toMatchObject({
		state: "not_applied",
		reason: "invalid",
		problems: ["set 1: name the row's key (number, at); only an id is made for a new row"],
	});
	expect([...f.commits, ...numbers.commits]).toEqual([]);
});

it("refuses a claim, a table the agent may not write, and rows that would be too large", async () => {
	const claim = await fixture({ files: CARDS });
	const taken = read(await claim.call("table_write", rows("cards", "cards-1", [{ id: C1, holder: randomUUID() }])));
	expect(taken).toMatchObject({ state: "not_applied", reason: "claim", next: ROWS.claim });
	expect(taken.problems).toEqual([expect.stringContaining("no supervisor to act for")]);
	const closed = await fixture({
		files: {
			...CARDS,
			"tables/cards/table.toml": CARDS_TABLE.replace('[write]\nagents = "all"', '[write]\nagents = "none"'),
		},
	});
	const shut = await closed.call("table_write", rows("cards", "cards-1", [{ id: C1, state: "done" }]));
	expect(read(shut)).toMatchObject({ state: "not_applied", reason: "not_a_writer", next: ROWS.not_a_writer });
	cites(closed, shut, CARDS_FILES);
	// Rows just under 64 KiB, and one more row that does not fit.
	let full = `${CARDS_HEAD}\n`;
	while (Buffer.byteLength(full) + 227 <= 64 * 1024) full += `${randomUUID()},${"x".repeat(180)},,,open,,\n`;
	const large = await fixture({ files: { ...CARDS, "tables/cards/rows.csv": full } });
	const answer = read(
		await large.call("table_write", rows("cards", "cards-1", [{ card: "y".repeat(200), state: "open" }])),
	);
	expect(answer).toMatchObject({ state: "not_applied", reason: "too_large", next: ROWS.too_large });
	expect([...claim.commits, ...closed.commits, ...large.commits]).toEqual([]);
});

it("refuses a table that is not there, and answers one it cannot read with its problems", async () => {
	const f = await fixture({ files: CARDS });
	await refuses(
		f.call("table_write", rows("ghost", "ghost-1", [{ card: "x" }])),
		CloudToolRefusal,
		"TABLE_NOT_FOUND: no table has that name",
	);
	const broken = await fixture({ files: { "tables/cards/table.toml": "format = 1\n" } });
	const answer = await broken.call("table_write", rows("cards", "cards-1", [{ card: "x", state: "open" }]));
	const parsed = read(answer);
	expect(parsed).toMatchObject({ state: "not_applied", version: null, reason: "broken", next: ROWS.broken });
	expect(parsed.problems.length).toBeGreaterThan(0);
	cites(broken, answer, ["tables/cards/table.toml"]);
	// A row that does not fit the definition stops every write until a member fixes it.
	const unfit = await fixture({
		files: { ...CARDS, "tables/cards/rows.csv": `${CARDS_HEAD}\n${C1},Bake,sales,,lost,,\n` },
	});
	const stuck = await unfit.call("table_write", rows("cards", "cards-1", [{ card: "x", state: "open" }]));
	const stuckAnswer = read(stuck);
	expect(stuckAnswer).toMatchObject({ state: "not_applied", reason: "rows_do_not_fit", next: ROWS.rows_do_not_fit });
	expect(stuckAnswer.problems).toEqual([expect.stringContaining("state is not one of its choices")]);
	cites(unfit, stuck, CARDS_FILES);
	expect([...f.commits, ...broken.commits, ...unfit.commits]).toEqual([]);
});
