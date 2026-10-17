import { createHash, randomUUID } from "node:crypto";
import { AREAS_TABLE, NUMBERS_TABLE } from "@qorpera/cloud-client/interface-library";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderError } from "@qorpera/runtime/cloud-company-folder-client";
import { cloudInterfaceTools } from "@qorpera/runtime/cloud-folder-interface-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.useRealTimers();
});

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}, timeZone = "UTC") {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = cloudInterfaceTools({ folder: f.folder, identity: f.identity, timeZone });
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue, context = f.context) =>
		tool(name).execute(tool(name).parseArguments(value), context);
	const version = (path: string) => f.files.get(path)?.version;
	return { ...f, tools, tool, call, version };
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
async function refuses(
	call: Promise<unknown>,
	type: typeof CloudToolRefusal | typeof CloudToolArgumentRefusal,
	text: string,
) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(type);
	expect((error as Error).message).toContain(text);
}

const CUT = " ... [cut]";
const AGENT = "0b1c2d3e-1111-4111-8111-111111111111";
const NUMBERS_ROWS = `number,at,value,unit,target,kept_by
mrr,2026-10-01T09:00:00Z,1200,€,2000,${AGENT}
mrr,2026-10-08T09:00:00Z,1500,€,2000,${AGENT}
signups,2026-10-08T09:00:00Z,40,count,,${AGENT}
`;
const NUMBERS = { "tables/numbers/table.toml": NUMBERS_TABLE, "tables/numbers/rows.csv": NUMBERS_ROWS };
const NUMBERS_ABOUT = "The numbers the company steers by. One row per reading; a number's newest row is its value now.";
const NUMBERS_COLUMNS = ["number", "at", "value", "unit", "target", "kept_by"];

/** A table file of our own: `head` holds its key and more, then its columns and `rest`. */
const tableFile = (name: string, head: string, columns: readonly (readonly [string, string])[], rest = "") =>
	`format = "qorpera.table/v0"\n\n[table]\nid = "${randomUUID()}"\nname = "${name}"\nrows = "file"\n${head}\n${columns
		.map(([column, type]) => `[[column]]\nname = "${column}"\ntype = "${type}"\n`)
		.join("\n")}\n${rest}`;

it("offers the read tool as a Company File tool, and no interface_read since the scope reset (C6b)", async () => {
	const f = await fixture();
	expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([["table_read", "company_file"]]);
});

it("reads a table page by page, with its types and who may write it first, and releases both files", async () => {
	const f = await fixture({ files: NUMBERS });
	const definitionVersion = f.version("tables/numbers/table.toml");
	const rowsVersion = f.version("tables/numbers/rows.csv");
	const first = await f.call("table_read", { table: "numbers", where: null, after: null, limit: 2 });
	expect(read(first)).toEqual({
		table: "numbers",
		definitionVersion,
		rowsVersion,
		key: ["number", "at"],
		columns: NUMBERS_COLUMNS,
		name: "Numbers",
		about: NUMBERS_ABOUT,
		holder: null,
		time: "at",
		types: [
			"text, at most 60 characters",
			"time",
			"number",
			"choice, one of €, kr, $, %, count, minutes, hours",
			"number, optional",
			"agent",
		],
		write: { agents: "all", members: "all", youMayWrite: true },
		problems: [],
		moreProblems: 0,
		matching: 3,
		rows: [
			["mrr", "2026-10-01T09:00:00Z", 1200, "€", 2000, AGENT],
			["mrr", "2026-10-08T09:00:00Z", 1500, "€", 2000, AGENT],
		],
		next: '["mrr","2026-10-08T09:00:00Z"]',
	});
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({
		p_release_id: first.companyReadId,
		p_output_sha256: sha(String(first.value)),
		p_reads: [
			{
				path: "tables/numbers/table.toml",
				version: definitionVersion,
				fileSha256: f.files.get("tables/numbers/table.toml")?.file.fileSha256,
			},
			{
				path: "tables/numbers/rows.csv",
				version: rowsVersion,
				fileSha256: f.files.get("tables/numbers/rows.csv")?.file.fileSha256,
			},
		],
	});
	// A later page is only the rows.
	const second = await f.call("table_read", {
		table: "numbers",
		where: null,
		after: '["mrr","2026-10-08T09:00:00Z"]',
		limit: 2,
	});
	expect(read(second)).toEqual({
		table: "numbers",
		definitionVersion,
		rowsVersion,
		key: ["number", "at"],
		columns: NUMBERS_COLUMNS,
		matching: 3,
		rows: [["signups", "2026-10-08T09:00:00Z", 40, "count", null, AGENT]],
		next: null,
	});
	cites(f, second, ["tables/numbers/table.toml", "tables/numbers/rows.csv"]);
});

it("keeps the rows a where names, and says when a column or an after names nothing", async () => {
	const f = await fixture({ files: NUMBERS });
	const matching = async (where: JsonValue) =>
		read(await f.call("table_read", { table: "numbers", where, after: null, limit: 50 })).matching;
	expect(await matching({ number: "mrr" })).toBe(2);
	expect(await matching({ number: ["signups"], unit: "count" })).toBe(1);
	expect(
		read(await f.call("table_read", { table: "numbers", where: { state: "open" }, after: null, limit: 50 })),
	).toMatchObject({ matching: 0, rows: [], next: null, problem: "the table has no column state, so no row matches" });
	// The row an after names is no longer among the rows the where keeps.
	expect(
		read(
			await f.call("table_read", {
				table: "numbers",
				where: { number: "mrr" },
				after: '["signups","2026-10-08T09:00:00Z"]',
				limit: 50,
			}),
		),
	).toMatchObject({
		matching: 2,
		rows: [],
		next: null,
		problem: "after names no row this where keeps now; read again with after null",
	});
});

it("shows a yes-no cell as yes or no, cuts a long cell and a long list, and matches an agent in a list", async () => {
	const agents = Array.from({ length: 25 }, () => randomUUID());
	const f = await fixture({
		files: {
			"tables/areas/table.toml": AREAS_TABLE,
			"tables/areas/rows.csv": `area,about,owner,shared,supervisor,agents\nsales,${"A".repeat(250)},,yes,,${agents.join(" ")}\nops,,,no,,${AGENT}\n`,
		},
	});
	const answer = read(
		await f.call("table_read", { table: "areas", where: { shared: "yes" }, after: null, limit: 50 }),
	);
	expect(answer).toMatchObject({
		holder: "owner",
		time: null,
		types: [
			"text, at most 60 characters",
			"text, at most 280 characters, optional",
			"member, optional, needs yes",
			"yes-no",
			"member, optional, needs yes",
			"agents, optional",
		],
		matching: 1,
		rows: [["sales", `${"A".repeat(200)}${CUT}`, null, "yes", null, [...agents.slice(0, 5), "... 20 more"]]],
	});
	expect(
		read(await f.call("table_read", { table: "areas", where: { agents: AGENT }, after: null, limit: 50 })).rows,
	).toEqual([["ops", null, null, "no", null, [AGENT]]]);
});

it("says who may write a table, and whether this agent may", async () => {
	const f = await fixture();
	const columns = [["name", "text"]] as const;
	f.seed(
		"tables/listed/table.toml",
		tableFile("Listed", 'key = ["name"]', columns, `[write]\nagents = ["${randomUUID()}"]\nmembers = "owners"\n`),
	);
	f.seed(
		"tables/mine/table.toml",
		tableFile("Mine", 'key = ["name"]', columns, `[write]\nagents = ["${f.identity.staffAgentId}"]\n`),
	);
	const listed = read(await f.call("table_read", { table: "listed", where: null, after: null, limit: 5 }));
	expect(listed).toMatchObject({
		rowsVersion: null,
		write: { agents: "listed", members: "owners", youMayWrite: false },
		matching: 0,
		rows: [],
		next: null,
	});
	// A table without a rows file has no rows yet, and only its definition is released.
	expect(f.releases.at(-1)?.p_reads).toHaveLength(1);
	expect(read(await f.call("table_read", { table: "mine", where: null, after: null, limit: 5 })).write).toEqual({
		agents: "listed",
		members: "all",
		youMayWrite: true,
	});
});

it("shows a table's problems: a broken definition, a rows file it can't read, and the rows that don't fit", async () => {
	const events = tableFile("Events", 'key = ["title"]', [["title", "text"]]);
	const f = await fixture({
		files: {
			"tables/broken/table.toml": NUMBERS_TABLE.replace('format = "qorpera.table/v0"', 'format = "nope"'),
			...NUMBERS,
			"tables/numbers/rows.csv": "x".repeat(64 * 1024 + 1),
			"tables/folded/table.toml": events,
			"tables/bad/table.toml": NUMBERS_TABLE,
			"tables/bad/rows.csv": `${NUMBERS_COLUMNS.join(",")}\nmrr,2026-10-01T09:00:00Z,1200,€,2000,${AGENT}\nmrr,2026-10-08T09:00:00Z,lots,€,2000,${AGENT}\n`,
		},
		folders: ["tables/folded/rows.csv"],
	});
	const broken = await f.call("table_read", { table: "broken", where: null, after: null, limit: 5 });
	const answer = read(broken);
	expect(answer).toMatchObject({
		table: "broken",
		definitionVersion: f.version("tables/broken/table.toml"),
		broken: true,
		moreProblems: 0,
	});
	expect(answer.problems).toEqual([expect.stringContaining('format must be "qorpera.table/v0"')]);
	cites(f, broken, ["tables/broken/table.toml"]);
	await refuses(
		f.call("table_read", { table: "nope", where: null, after: null, limit: 5 }),
		CloudToolRefusal,
		"TABLE_NOT_FOUND",
	);
	expect(f.releases).toHaveLength(1);

	expect(read(await f.call("table_read", { table: "numbers", where: null, after: null, limit: 5 }))).toMatchObject({
		rowsVersion: f.version("tables/numbers/rows.csv"),
		problems: ["rows.csv is larger than 64 KiB"],
		matching: 0,
		rows: [],
	});
	const folded = read(await f.call("table_read", { table: "folded", where: null, after: null, limit: 5 }));
	expect(folded).toMatchObject({ rowsVersion: expect.any(String), problems: ["rows.csv is a folder"], matching: 0 });
	// A folder is released at its version, with no file hash.
	const reads = f.releases.at(-1)?.p_reads as Record<string, unknown>[];
	expect(reads.map((entry) => entry.path)).toEqual(["tables/folded/table.toml", "tables/folded/rows.csv"]);
	expect(reads[1]).toMatchObject({ version: folded.rowsVersion });
	expect(reads[1]).not.toHaveProperty("fileSha256");
	expect(read(await f.call("table_read", { table: "bad", where: null, after: null, limit: 5 }))).toMatchObject({
		problems: ["rows.csv line 3: This row doesn't fit: value is not a number."],
		moreProblems: 0,
		matching: 1,
	});
});

it("cuts a row's cells when one row does not fit a result whole", async () => {
	const columns = [
		["k", "text"],
		...Array.from({ length: 29 }, (_, n) => [`c${String(n + 1).padStart(2, "0")}`, "text"] as const),
	] as const;
	const header = columns.map(([column]) => column).join(",");
	const row = (key: string) => [key, ...Array.from({ length: 29 }, () => "w".repeat(300))].join(",");
	const f = await fixture({
		files: {
			"tables/wide/table.toml": tableFile("Wide", 'key = ["k"]', columns),
			"tables/wide/rows.csv": `${header}\n${row("a")}\n${row("b")}\n`,
		},
	});
	const answer = read(await f.call("table_read", { table: "wide", where: null, after: null, limit: 2 }));
	expect(answer).toMatchObject({ matching: 2, next: '["a"]' });
	expect(answer.rows).toHaveLength(1);
	expect(answer.rows[0][0]).toBe("a");
	for (const cell of answer.rows[0].slice(1)) {
		expect(cell.endsWith(CUT)).toBe(true);
		expect(cell.length).toBeLessThan(300);
	}
});

it("refuses arguments outside each tool's shape", async () => {
	const f = await fixture();
	const wheres: JsonValue[] = [{ Bad: 1 }, { a: [] }];
	for (const where of wheres)
		await refuses(
			f.call("table_read", { table: "cards", where, after: null, limit: 5 }),
			CloudToolArgumentRefusal,
			"where must be null, or an object of at most 40 column names",
		);
	await refuses(
		f.call("table_read", { table: "cards", where: null, after: "", limit: 5 }),
		CloudToolArgumentRefusal,
		"after must be null for the first page, or the next value a page gave",
	);
	await refuses(
		f.call("table_read", { table: "cards", where: null, after: null, limit: 0 }),
		CloudToolArgumentRefusal,
		"limit must be a whole number from 1 to 50",
	);
	await refuses(
		f.call("table_read", { table: "../x", where: null, after: null, limit: 5 }),
		CloudToolArgumentRefusal,
		"like cards",
	);
	expect(f.releases).toHaveLength(0);
});

it("tells the model the company's work is stopped, or the read revoked, and shows nothing", async () => {
	const f = await fixture({ files: NUMBERS });
	const stopped = vi.spyOn(f.folder, "read").mockRejectedValueOnce(new CloudCompanyFolderError("stopped"));
	await refuses(
		f.call("table_read", { table: "numbers", where: null, after: null, limit: 5 }),
		CloudToolRefusal,
		"COMPANY_WORK_STOPPED",
	);
	stopped.mockRestore();
	vi.spyOn(f.folder, "release").mockRejectedValueOnce(new CloudCompanyFolderError("read_revoked"));
	await refuses(
		f.call("table_read", { table: "numbers", where: null, after: null, limit: 5 }),
		CloudToolRefusal,
		"READ_REVOKED",
	);
	expect(f.releases).toHaveLength(0);
});
