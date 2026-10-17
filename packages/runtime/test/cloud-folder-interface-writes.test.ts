import { createHash, randomUUID } from "node:crypto";
import { AREAS_TABLE, CARDS_TABLE, NUMBERS_TABLE } from "@qorpera/cloud-client/interface-library";
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
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability } from "@qorpera/runtime/cloud-runtime-observability";
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
	const version = (path: string) => f.files.get(path)?.version;
	return { ...f, make, tools, tool, call, version };
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
const CARDS_HEAD = "id,card,area,holder,state,added_by,todo";
const CARDS_ROWS = `${CARDS_HEAD}\n${C1},Bake,sales,,open,,\n${C2},Sell,sales,,open,,\n`;
const CARDS = { "tables/cards/table.toml": CARDS_TABLE, "tables/cards/rows.csv": CARDS_ROWS };
const CARDS_FILES = ["tables/cards/table.toml", "tables/cards/rows.csv"];
const NUMBERS_HEAD = "number,at,value,unit,target,kept_by";

const rows = (
	table: string,
	operationKey: string,
	set: Record<string, JsonValue>[],
	remove: Record<string, JsonValue>[] = [],
) => ({ table, operationKey, set, remove });

const ROWS = {
	broken: "Nothing was saved. The table's table.toml cannot be read (the problems): tell the member.",
	rows_do_not_fit:
		"Nothing was saved. Some of the table's rows do not fit its definition (the problems), and table_write changes only a table whose rows all fit: tell the member.",
	not_a_writer:
		"Nothing was saved. You may not write this table's rows (its [write] agents do not name you): tell the member what you would change.",
	invalid: "Nothing was saved. Fix the problems listed and call again with a new operationKey.",
	claim: "Nothing was saved. You change a needs_yes cell (a claim) only for the member who supervises your area, taking an empty one for them or letting theirs go, and never an area's owner, supervisor or agents: leave it as it is, or tell the member.",
	too_large:
		"Nothing was saved. The rows would be larger than 64 KiB, the most a table holds for now: remove rows first, or tell the member.",
};

it("offers the write tool as a Company File tool, and no save_interface since the scope reset (C6b)", async () => {
	const f = await fixture();
	expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([["table_write", "company_file"]]);
	expect(f.tools.map((tool) => (tool.inputSchema as { required: string[] }).required)).toEqual([
		["table", "operationKey", "set", "remove"],
	]);
});

it("refuses arguments it cannot save before anything is read", async () => {
	const f = await fixture();
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

it("answers a row write as unconfirmed when its answer cannot be released after the commit", async () => {
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

const AREAS_HEAD = "area,about,owner,shared,supervisor,agents";
const AREAS_FILES = ["tables/areas/table.toml", "tables/areas/rows.csv"];
/** The cards, and the areas: the run's agent works in Sales, which `supervisor` supervises (or nobody, when null). */
async function supervised(supervisor: string | null, options: Parameters<typeof folderWriterFixture>[1] = {}) {
	const f = await fixture({ files: CARDS }, options);
	f.seed("tables/areas/table.toml", AREAS_TABLE);
	f.seed(
		"tables/areas/rows.csv",
		`${AREAS_HEAD}\nOps,,,no,${randomUUID()},${randomUUID()}\nSales,,,no,${supervisor ?? ""},${AGENT} ${f.identity.staffAgentId}\n`,
	);
	return f;
}

it("changes a claim for the member who supervises the agent's area, and only takes or lets go for them", async () => {
	const supervisor = randomUUID();
	const f = await supervised(supervisor);
	const path = "tables/cards/rows.csv";
	// Taken for the supervisor: the areas were read for it, and the answer is released with them.
	const taken = await f.call("table_write", rows("cards", "take-1", [{ id: C1, holder: supervisor }]));
	expect(read(taken)).toMatchObject({ state: "applied", outcome: "saved", changed: { updated: 1 } });
	cites(f, taken, [...CARDS_FILES, ...AREAS_FILES]);
	expect(f.text(path)).toBe(`${CARDS_HEAD}\n${C1},Bake,sales,${supervisor},open,,\n${C2},Sell,sales,,open,,\n`);
	// Given to anybody else: refused before the commit.
	const other = randomUUID();
	const given = await f.call("table_write", rows("cards", "give-1", [{ id: C2, holder: other }]));
	const answer = read(given);
	expect(answer).toMatchObject({ state: "not_applied", reason: "claim", next: ROWS.claim });
	expect(answer.problems).toEqual([expect.stringContaining("giving it to someone else is an offer")]);
	cites(f, given, [...CARDS_FILES, ...AREAS_FILES]);
	// The boundary observes the refusal as denied for want of authority (P5 pass 2 finding 1).
	expect(f.tool("table_write").refused?.(given)).toBe("authority_unavailable");
	// A change that touches no claim reads no areas.
	const done = await f.call("table_write", rows("cards", "done-1", [{ id: C2, state: "done" }]));
	expect(read(done)).toMatchObject({ state: "applied" });
	expect(f.tool("table_write").refused?.(done)).toBeUndefined();
	cites(f, done, CARDS_FILES);
	// Let go for the supervisor.
	const released = await f.call("table_write", rows("cards", "let-go-1", [{ id: C1, holder: null }]));
	expect(read(released)).toMatchObject({ state: "applied", changed: { updated: 1 } });
	expect(f.text(path)).toBe(`${CARDS_HEAD}\n${C1},Bake,sales,,open,,\n${C2},Sell,sales,,done,,\n`);
	expect(f.commits).toHaveLength(3);
	// An area nobody supervises: the agent has nobody to act for.
	const alone = await supervised(null);
	const refused = read(await alone.call("table_write", rows("cards", "take-1", [{ id: C1, holder: supervisor }])));
	expect(refused).toMatchObject({ state: "not_applied", reason: "claim", next: ROWS.claim });
	expect(refused.problems).toEqual([expect.stringContaining("no supervisor to act for")]);
	expect(alone.commits).toEqual([]);
});

it("writes the areas but never an area's owner, supervisor or agents", async () => {
	const supervisor = randomUUID();
	const f = await supervised(supervisor);
	const about = await f.call("table_write", rows("areas", "about-1", [{ area: "Sales", about: "Selling" }]));
	expect(read(about)).toMatchObject({ state: "applied", changed: { updated: 1 } });
	cites(f, about, AREAS_FILES);
	const changes: [string, JsonValue][] = [
		["owner", supervisor],
		["supervisor", null],
		["agents", [AGENT]],
	];
	for (const [column, value] of changes) {
		const answer = await f.call("table_write", rows("areas", `${column}-1`, [{ area: "Sales", [column]: value }]));
		expect(read(answer)).toMatchObject({
			state: "not_applied",
			reason: "claim",
			problems: [`Only members change ${column}; an agent can offer, never set it.`],
			next: ROWS.claim,
		});
		cites(f, answer, AREAS_FILES);
	}
	expect(f.commits).toHaveLength(1);
});

it("answers the folder core's claim refusal at the commit as a claim", async () => {
	const supervisor = randomUUID();
	// The supervisor withdrew their consent: the folder core finds no member to act for and refuses the claim.
	const message = "nobody assigns anybody: only the member named changes holder";
	const f = await supervised(supervisor, {
		hook: (path) =>
			path === "tables/cards/rows.csv"
				? { outcome: "refused", reason: "structured_rule", problems: [{ code: "claim", message }] }
				: null,
	});
	const observability = new CloudRuntimeObservability({
		assignmentId: f.binding.assignmentId,
		publish: async () => {},
	});
	const span = observability.start("table_write");
	const answer = await f.call("table_write", rows("cards", "take-1", [{ id: C1, holder: supervisor }]), {
		...f.context,
		observation: span,
	});
	// Refused at the commit: observed as denied, never as succeeded (P5 pass 2 finding 1).
	expect([span.result?.status, span.result?.errorCategory]).toEqual(["denied", "invalid_arguments"]);
	await observability.close();
	expect(read(answer)).toEqual({
		schema: "qorpera.table-write-result/v1",
		state: "not_applied",
		operationKey: "take-1",
		table: "cards",
		version: null,
		receiptId: expect.any(String),
		outcome: "refused",
		reason: "structured_rule",
		problems: [message],
		next: ROWS.claim,
	});
	cites(f, answer, [...CARDS_FILES, ...AREAS_FILES]);
	expect(f.commits).toHaveLength(1);
	expect(f.text("tables/cards/rows.csv")).toBe(CARDS_ROWS);
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
