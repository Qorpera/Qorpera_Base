import { describe, expect, it } from "vitest";
import {
	AREAS_TABLE,
	CARDS_TABLE,
	INTERFACE_LIBRARY,
	interfaceLibraryFiles,
	MAILBOX_INTERFACE,
	MEMBERS_INTERFACE,
	NUMBERS_TABLE,
	PULSE_INTERFACE,
} from "../src/interface-library.ts";
import {
	fillInterfaceText,
	interfaceBucket,
	interfaceLookup,
	interfaceSeries,
	interfaceSinceStart,
	queryInterfaceRows,
} from "../src/interface-query.ts";
import {
	type InterfaceProblem,
	interfaceInstant,
	interfacePathProblems,
	interfaceStatePath,
	interfaceTemplateColumns,
	parseInterfaceFile,
	parseInterfaceOrderFile,
	parseTableFile,
	parseTableRows,
	splitCsv,
	type TableFile,
	type TableRow,
	tableClaimProblems,
	tableRowKey,
	writeInterfaceOrderFile,
	writeTableRows,
} from "../src/interfaces.ts";
import { parseTomlSubset, TomlSubsetError } from "../src/toml-subset.ts";

const SOFIE = "11111111-1111-4111-8111-111111111111";
const AMIR = "22222222-2222-4222-8222-222222222222";
const IDA = "33333333-3333-4333-8333-333333333333";
const FINANCE = "44444444-4444-4444-8444-444444444444";

function table(text: string): TableFile {
	const result = parseTableFile(text);
	if (!result.ok) throw new Error(JSON.stringify(result.problems));
	return result.file;
}

function codes(problems: readonly InterfaceProblem[]): string[] {
	return problems.map((p) => p.code);
}

const MINIMAL = `format = "qorpera.interface/v0"

[interface]
id = "5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21"
name = "Small"

[[view]]
name = "Now"

[[view.block]]
kind = "list"
from = "activity"
line = "{line}"
`;

describe("toml subset", () => {
	it("reads tables, arrays of tables, inline tables and arrays, with the line of every key", () => {
		const doc = parseTomlSubset(`# head
a = "x\\ty \\u00e9"   # note
b = 'raw \\n'
[t]
n = -12
f = 1.5e3
list = [
  "one", # first
  2,
  true,
]
[[v]]
k = { x = 1, y = ["a", "b"] }
[[v.w]]
z = false
[[v]]
k = {}
`);
		expect(doc.value).toEqual({
			a: "x\ty é",
			b: "raw \\n",
			t: { n: -12, f: 1500, list: ["one", 2, true] },
			v: [{ k: { x: 1, y: ["a", "b"] }, w: [{ z: false }] }, { k: {} }],
		});
		expect(doc.lines.get("a")).toBe(2);
		expect(doc.lines.get("t.list")).toBe(7);
		expect(doc.lines.get("v.0.k")).toBe(13);
		expect(doc.lines.get("v.0.w.0.z")).toBe(15);
		expect(doc.lines.get("v.1")).toBe(16);
	});

	it.each([
		['a = """x"""', 1, "Multi-line"],
		["a = 2026-10-02", 1, "Dates"],
		["a.b = 1", 1, "Dotted"],
		["a = 1\na = 2", 2, "twice"],
		["[t]\n[t]", 2, "already defined"],
		["a = 1\n[a]", 2, "already defined"],
		["a = { x = 1,\n y = 2 }", 1, "inline table"],
		['a = "open', 1, "close"],
		["a = 0x10", 1, "not a value"],
		["a = 1_000", 1, "not a value"],
		["a = inf", 1, "not a value"],
		["a = 1 b = 2", 1, "end of the line"],
		["a = 1\r", 1, "carriage return"],
		['a = "\\q"', 1, "escape"],
		["k = { x = 1 }\n[k]", 2, "already defined"],
		["[[t]]\nx=1\n[t]", 3, "already defined"],
	])("refuses %j on line %i", (text, line, message) => {
		try {
			parseTomlSubset(text);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(TomlSubsetError);
			expect((error as TomlSubsetError).line).toBe(line);
			expect((error as Error).message).toContain(message);
		}
	});

	it("keeps __proto__ an own key and never touches a prototype", () => {
		const doc = parseTomlSubset('__proto__ = { polluted = true }\n[constructor]\nx = 1\n"__proto__" = 2');
		expect(Object.keys(doc.value)).toEqual(["__proto__", "constructor"]);
		expect(Object.keys(doc.value.constructor as object)).toEqual(["x", "__proto__"]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(doc.value)).toBe(Object.prototype);
	});

	it("reads long hostile input in linear time", () => {
		const started = performance.now();
		const big = `a = "${"\\\\".repeat(30_000)}"\nb = [${"1,".repeat(20_000)}]\n# ${"#".repeat(60_000)}\n`;
		const doc = parseTomlSubset(big);
		expect((doc.value.b as unknown[]).length).toBe(20_000);
		for (const bad of [`a = "${"x".repeat(60_000)}`, `a = [${"[".repeat(9)}`, `x = ${"9".repeat(60_000)}`]) {
			expect(() => parseTomlSubset(bad)).toThrow(TomlSubsetError);
		}
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});

describe("interface files", () => {
	it("parses the library's three interfaces and their tables", () => {
		for (const entry of INTERFACE_LIBRARY) {
			const page = parseInterfaceFile(entry.interface);
			expect(page.problems, entry.name).toEqual([]);
			for (const text of Object.values(entry.tables)) expect(parseTableFile(text).problems).toEqual([]);
		}
		const pulse = parseInterfaceFile(PULSE_INTERFACE);
		if (!pulse.ok) throw new Error("pulse");
		expect(pulse.file.main).toBe(true);
		expect(pulse.file.views[0]?.blocks.map((b) => b.kind)).toEqual([
			"text",
			"list",
			"numbers",
			"list",
			"list",
			"list",
			"calendar",
			"detail",
		]);
		const numbers = pulse.file.views[0]?.blocks[2];
		expect(numbers?.query.latestBy).toBe("number");
		expect(numbers?.trend).toEqual({ over: "at", weeks: 12 });
		const work = pulse.file.views[0]?.blocks[5];
		expect(work?.query).toEqual({
			where: { status: ["open", "blocked"] },
			since: null,
			order: { column: "updated", descending: true },
			limit: 5,
			latestBy: null,
		});
		const mailbox = parseInterfaceFile(MAILBOX_INTERFACE);
		if (!mailbox.ok) throw new Error("mailbox");
		expect(mailbox.file.needs).toEqual(["mail"]);
		expect(mailbox.file.views.map((v) => v.name)).toEqual(["Inbox", "Waiting for you", "Sent", "Addresses"]);
		expect(mailbox.file.views[1]).toMatchObject({ fromView: "Inbox", where: { state: "waiting" }, blocks: [] });
		expect(mailbox.file.buttons[0]?.text).toBe('About the email "{subject}" from {from_name}: ');
		const members = parseInterfaceFile(MEMBERS_INTERFACE);
		if (!members.ok) throw new Error("members");
		const board = members.file.views[0]?.blocks[0];
		expect(board?.parts.map((p) => p.from)).toEqual(["table:areas", "table:cards"]);
		expect(members.file.views[1]?.blocks[0]?.lookups.holds).toEqual({
			from: "table:cards",
			match: "holder",
			show: null,
			count: true,
		});
		expect(members.file.access.edit).toBe("owners");
	});

	it("refuses unknown keys with their line and place", () => {
		const result = parseInterfaceFile(MINIMAL.replace('line = "{line}"', 'line = "{line}"\ncolor = "red"'));
		expect(result.problems).toEqual([
			expect.objectContaining({ code: "unknown_key", key: "view[0].block[0].color", line: 14 }),
		]);
	});

	it("reports TOML errors with their line", () => {
		const result = parseInterfaceFile(`${MINIMAL}\n[[view.block]\n`);
		expect(result.problems).toEqual([expect.objectContaining({ code: "toml", line: 15 })]);
	});

	it("refuses a missing or wrong format", () => {
		expect(
			codes(parseInterfaceFile(MINIMAL.replace('format = "qorpera.interface/v0"', 'format = "v1"')).problems),
		).toEqual(["format"]);
	});

	it("checks sources, columns of fixed sources, buttons and targets", () => {
		const text = `${MINIMAL}
[[view.block]]
kind = "list"
from = "todos"
line = "{titel}"
opens = "nowhere"
buttons = ["ask", "take"]

[[view.block]]
kind = "table"
from = "spreadsheet"
columns = ["a"]
`;
		const result = parseInterfaceFile(text);
		expect(codes(result.problems).sort()).toEqual([
			"unknown_button",
			"unknown_column",
			"unknown_source",
			"unknown_target",
		]);
	});

	it("checks needs, access, template and button verbs", () => {
		const text = MINIMAL.replace(
			'name = "Small"',
			'name = "Small"\nneeds = ["mail", "weather"]\nemblem = "rocket"',
		).concat(`
[access]
members = []
edit = "everyone"

[template]
from = "Qorpera/Pulse"
version = "1.0"

[[button]]
id = "go"
verb = "launch"
label = "Go"

[[button]]
id = "say"
verb = "message"
label = "Say {x"
to = "someone"
`);
		const result = parseInterfaceFile(text);
		expect(result.ok).toBe(false);
		const keys = result.problems.map((p) => `${p.code}:${p.key}`);
		expect(keys).toEqual(
			expect.arrayContaining([
				"bad_value:interface.needs",
				"bad_value:interface.emblem",
				"bad_value:access.members",
				"bad_value:access.edit",
				"bad_value:template.from",
				"bad_value:template.version",
				"bad_value:button[0].verb",
				"bad_value:button[1].label",
				"bad_value:button[1].to",
			]),
		);
	});

	it("refuses an oversized file before reading it", () => {
		expect(codes(parseInterfaceFile(`# ${"x".repeat(70_000)}\n${MINIMAL}`).problems)).toEqual(["too_large"]);
	});

	it("finds the {column} names a text uses", () => {
		expect(interfaceTemplateColumns("Ask {kept_by} about {number}")).toEqual(["kept_by", "number"]);
		expect(interfaceTemplateColumns("no braces")).toEqual([]);
		for (const bad of ["{x", "x}", "{X}", "{}", "{a b}", "}{a}"]) expect(interfaceTemplateColumns(bad)).toBeNull();
	});
});

describe("paths and order", () => {
	it("knows each interface file by its path's key", () => {
		expect(interfaceStatePath("interfaces/pulse/interface.toml")).toEqual({ kind: "interface", name: "pulse" });
		expect(interfaceStatePath("Interfaces/Order.md")).toEqual({ kind: "interface-order", name: null });
		expect(interfaceStatePath("tables/numbers.toml")).toEqual({ kind: "table", name: "numbers" });
		expect(interfaceStatePath("tables/numbers.csv")).toEqual({ kind: "table-rows", name: "numbers" });
		expect(interfaceStatePath("tables/Big_Table.csv")).toBeNull();
		expect(interfaceStatePath("agents/x/agent.md")).toBeNull();
		expect(interfacePathProblems("interfaces/pulse/README.md")).toEqual([]);
		expect(interfacePathProblems("interfaces/pulse/script.js")).toHaveLength(1);
		expect(interfacePathProblems("tables/notes.txt")).toHaveLength(1);
		expect(interfacePathProblems("work/anything.csv")).toEqual([]);
	});

	it("reads and writes interfaces/order.md", () => {
		const text = writeInterfaceOrderFile([SOFIE, AMIR], new Map([[SOFIE, "Pulse\nX"]]));
		expect(text).toBe(`- ${SOFIE} Pulse X\n- ${AMIR}\n`);
		expect(parseInterfaceOrderFile(text)).toEqual({
			ok: true,
			file: { kind: "interface-order", ids: [SOFIE, AMIR] },
			problems: [],
		});
		expect(codes(parseInterfaceOrderFile(`- ${SOFIE}\n- ${SOFIE}\nfree text\n`).problems)).toEqual([
			"duplicate",
			"bad_value",
		]);
	});

	it("seeds the library with fresh ids and empty rows files", () => {
		let n = 0;
		const files = interfaceLibraryFiles(() => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
		expect(Object.keys(files).sort()).toEqual([
			"interfaces/mailbox/interface.toml",
			"interfaces/members/interface.toml",
			"interfaces/order.md",
			"interfaces/pulse/interface.toml",
			"tables/areas.csv",
			"tables/areas.toml",
			"tables/cards.csv",
			"tables/cards.toml",
			"tables/numbers.csv",
			"tables/numbers.toml",
		]);
		const pulse = parseInterfaceFile(files["interfaces/pulse/interface.toml"] ?? "");
		expect(pulse.ok && pulse.file.id).toBe("00000000-0000-4000-8000-000000000001");
		const order = parseInterfaceOrderFile(files["interfaces/order.md"] ?? "");
		expect(order.ok && order.file.ids.length).toBe(3);
		for (const name of ["numbers", "areas", "cards"]) {
			const definition = table(files[`tables/${name}.toml`] ?? "");
			const rows = parseTableRows(definition, files[`tables/${name}.csv`] ?? "");
			expect(rows).toEqual({ rows: [], problems: [], readable: true });
		}
	});
});

describe("tables and rows", () => {
	it("refuses definitions that don't hold together", () => {
		const bad = `format = "qorpera.table/v0"

[table]
id = "c41a90e2-6b1d-4f3a-8e57-2d9c0b4a1f68"
name = "Bad"
rows = "store"
key = ["missing"]
holder = "who"

[[column]]
name = "who"
type = "text"
needs_yes = true

[[column]]
name = "who"
type = "choice"
`;
		const keys = parseTableFile(bad).problems.map((p) => `${p.code}:${p.key}`);
		expect(keys).toEqual(
			expect.arrayContaining([
				"bad_value:table.rows",
				"unknown_column:table.key",
				"bad_value:table.holder",
				"bad_value:column[0].needs_yes",
				"duplicate:column[1].name",
				"missing_key:column[1].choices",
			]),
		);
	});

	it("reads rows, leaving out the ones that don't fit", () => {
		const numbers = table(NUMBERS_TABLE);
		const text = [
			"number,at,value,unit,target,kept_by",
			`Monthly revenue,2026-09-29T08:02Z,4210,€,5000,${FINANCE}`,
			`"Revenue, net",2026-09-29T08:02:30Z,-12.5,€,,${FINANCE}`,
			`Monthly revenue,2026-09-29T08:02Z,1,€,,${FINANCE}`,
			`Bad,2026-02-30T08:02Z,1,€,,${FINANCE}`,
			`Bad,2026-09-29T08:02Z,1e3,€,,${FINANCE}`,
			`Bad,2026-09-29T08:02Z,1,¥,,${FINANCE}`,
			"Short,2026-09-29T08:02Z",
			"",
		].join("\r\n");
		const result = parseTableRows(numbers, text);
		expect(result.readable).toBe(true);
		expect(result.rows).toEqual([
			{ number: "Monthly revenue", at: "2026-09-29T08:02Z", value: 4210, unit: "€", target: 5000, kept_by: FINANCE },
			{
				number: "Revenue, net",
				at: "2026-09-29T08:02:30Z",
				value: -12.5,
				unit: "€",
				target: null,
				kept_by: FINANCE,
			},
		]);
		expect(result.problems.map((p) => `${p.code}@${p.line}`)).toEqual([
			"duplicate@4",
			"row@5",
			"row@6",
			"row@7",
			"row@8",
		]);
	});

	it("refuses a wrong header, a broken quote and a file over 64 KiB", () => {
		const numbers = table(NUMBERS_TABLE);
		expect(parseTableRows(numbers, "number,value\n")).toMatchObject({
			readable: false,
			problems: [{ code: "row", line: 1 }],
		});
		expect(parseTableRows(numbers, 'number,at,value,unit,target,kept_by\n"open,\n')).toMatchObject({
			readable: false,
		});
		expect(parseTableRows(numbers, `number,at,value,unit,target,kept_by\n${"x,".repeat(40_000)}`)).toMatchObject({
			readable: false,
			problems: [{ code: "too_large" }],
		});
	});

	it("splits CSV with quotes, commas and line breaks inside fields", () => {
		const { records, error } = splitCsv('a,"b ""c"", d"\n"multi\nline",x\n');
		expect(error).toBeNull();
		expect(records).toEqual([
			{ line: 1, fields: ["a", 'b "c", d'] },
			{ line: 2, fields: ["multi\nline", "x"] },
		]);
		expect(splitCsv('a"b,c').error).not.toBeNull();
		expect(splitCsv('"a"b,c').error).not.toBeNull();
	});

	it("writes rows that read back the same", () => {
		const cards = table(CARDS_TABLE);
		const rows: TableRow[] = [
			{
				id: SOFIE,
				card: 'Reply to "Mark", today',
				area: "Support",
				holder: AMIR,
				state: "held",
				added_by: null,
				todo: null,
			},
			{ id: AMIR, card: "Two\nlines", area: null, holder: null, state: "open", added_by: FINANCE, todo: "abc" },
		];
		const text = writeTableRows(cards, rows);
		expect(parseTableRows(cards, text)).toEqual({ rows, problems: [], readable: true });
	});

	it("knows instants and refuses impossible ones", () => {
		expect(interfaceInstant("2026-10-02T09:44Z")).toBe(Date.UTC(2026, 9, 2, 9, 44));
		expect(interfaceInstant("2026-10-02")).toBe(Date.UTC(2026, 9, 2));
		for (const bad of ["2026-13-01", "2026-02-29T00:00Z", "2026-10-02T24:00Z", "2026-10-02T09:44"])
			expect(interfaceInstant(bad)).toBeNull();
	});
});

describe("the claim rule", () => {
	const areas = table(AREAS_TABLE);
	const row = (area: string, owner: string | null, supervisor: string | null = owner): TableRow => ({
		area,
		about: null,
		owner,
		shared: false,
		supervisor,
		agents: null,
	});
	const member = (id: string) => ({ kind: "member" as const, memberId: id });
	const agentFor = (supervisorId: string | null) => ({ kind: "agent" as const, agentId: FINANCE, supervisorId });
	const memberOnly = ["owner", "supervisor"];

	it("lets a member take an empty area and let go of their own", () => {
		expect(tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", SOFIE)], member(SOFIE))).toEqual([]);
		expect(tableClaimProblems(areas, [row("Marketing", SOFIE)], [row("Marketing", null)], member(SOFIE))).toEqual([]);
		expect(tableClaimProblems(areas, [], [row("New", SOFIE)], member(SOFIE))).toEqual([]);
	});

	it("never lets anyone hand an area to someone else or take someone's", () => {
		expect(
			codes(tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", AMIR)], member(SOFIE))),
		).toEqual(["claim", "claim"]);
		expect(codes(tableClaimProblems(areas, [row("Finance", AMIR)], [row("Finance", SOFIE)], member(SOFIE)))).toEqual([
			"claim",
			"claim",
		]);
		expect(codes(tableClaimProblems(areas, [row("Finance", AMIR)], [], member(SOFIE)))).toEqual(["claim", "claim"]);
	});

	it("allows the write of an accepted offer, and only for the member it names", () => {
		const before = [row("Finance", AMIR, AMIR)];
		const after = [{ ...row("Finance", AMIR, IDA) }];
		const offers = [{ row: tableRowKey(areas, before[0] as TableRow), column: "supervisor", to: IDA }];
		expect(tableClaimProblems(areas, before, after, member(IDA), { offers })).toEqual([]);
		expect(codes(tableClaimProblems(areas, before, after, member(SOFIE), { offers }))).toEqual(["claim"]);
		expect(codes(tableClaimProblems(areas, before, after, member(IDA)))).toEqual(["claim"]);
	});

	it("lets an agent act for its supervisor on cards, never on who owns or supervises an area", () => {
		const cards = table(CARDS_TABLE);
		const card = (holder: string | null): TableRow => ({
			id: SOFIE,
			card: "Call Brightside",
			area: null,
			holder,
			state: "open",
			added_by: null,
			todo: null,
		});
		expect(tableClaimProblems(cards, [card(null)], [card(AMIR)], agentFor(AMIR))).toEqual([]);
		expect(tableClaimProblems(cards, [card(AMIR)], [card(null)], agentFor(AMIR))).toEqual([]);
		expect(codes(tableClaimProblems(cards, [card(SOFIE)], [card(null)], agentFor(AMIR)))).toEqual(["claim"]);
		expect(codes(tableClaimProblems(cards, [card(null)], [card(SOFIE)], agentFor(AMIR)))).toEqual(["claim"]);
		expect(codes(tableClaimProblems(cards, [card(null)], [card(AMIR)], agentFor(null)))).toEqual(["claim"]);
		expect(
			codes(
				tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", AMIR)], agentFor(AMIR), {
					memberOnly,
				}),
			),
		).toEqual(["claim", "claim"]);
	});

	it("leaves rows alone that change nothing it guards", () => {
		const before = [row("Sales", SOFIE)];
		const after = [{ ...row("Sales", SOFIE), about: "Trials and teams" }];
		expect(tableClaimProblems(areas, before, after, member(AMIR))).toEqual([]);
	});
});

describe("queries", () => {
	const clock = { now: Date.UTC(2026, 9, 2, 12), startOfToday: Date.UTC(2026, 9, 2) };
	const rows: TableRow[] = [
		{ number: "Revenue", at: "2026-09-28T08:00Z", value: 4100, status: "open" },
		{ number: "Revenue", at: "2026-10-02T08:00Z", value: 4210, status: "open" },
		{ number: "Members", at: "2026-10-01T08:00Z", value: 1240, status: "blocked" },
		{ number: "Trials", at: "2026-10-02T09:44:10Z", value: 53, status: "done" },
		{ number: "Missing", at: null, value: null, status: "open" },
	];

	it("filters, keeps the newest of each, orders and limits", () => {
		const q = (query: object) =>
			queryInterfaceRows(
				rows,
				{ where: null, since: null, order: null, limit: null, latestBy: null, ...query },
				{ time: "at", clock },
			);
		expect(q({ where: { status: ["open", "blocked"] } }).map((r) => r.value)).toEqual([4100, 4210, 1240, null]);
		expect(q({ since: "today" }).map((r) => r.number)).toEqual(["Revenue", "Trials"]);
		expect(q({ latestBy: "number" }).map((r) => r.value)).toEqual([4210, 1240, 53, null]);
		expect(q({ order: { column: "value", descending: true } }).map((r) => r.value)).toEqual([
			4210,
			4100,
			1240,
			53,
			null,
		]);
		expect(q({ order: { column: "at", descending: false }, limit: 2 }).map((r) => r.value)).toEqual([4100, 1240]);
		expect(q({ where: { value: 53 } }).map((r) => r.number)).toEqual(["Trials"]);
	});

	it("counts since in days, weeks and calendar months", () => {
		expect(interfaceSinceStart("-7d", clock)).toBe(clock.now - 7 * 86_400_000);
		expect(interfaceSinceStart("-2w", clock)).toBe(clock.now - 14 * 86_400_000);
		expect(interfaceSinceStart("-1m", clock)).toBe(Date.UTC(2026, 8, 2, 12));
		expect(interfaceSinceStart("yesterday", clock)).toBeNull();
	});

	it("buckets a chart by week and sums or counts", () => {
		expect(interfaceBucket(Date.UTC(2026, 9, 4), "week")).toBe("2026-09-28");
		expect(interfaceBucket(Date.UTC(2026, 9, 4), "month")).toBe("2026-10");
		const refunds: TableRow[] = [
			{ at: "2026-09-29T10:00Z", amount: 9.99 },
			{ at: "2026-10-01T10:00Z", amount: 59.99 },
			{ at: "2026-10-06T10:00Z", amount: 79 },
		];
		expect(interfaceSeries(refunds, { x: "at", y: "amount", by: null, every: "week", total: "sum" })).toEqual([
			{ x: "2026-09-28", by: null, value: 69.98 },
			{ x: "2026-10-05", by: null, value: 79 },
		]);
		expect(interfaceSeries(refunds, { x: "at", y: null, by: null, every: "month", total: "count" })).toEqual([
			{ x: "2026-09", by: null, value: 1 },
			{ x: "2026-10", by: null, value: 2 },
		]);
		expect(
			interfaceSeries(refunds, { x: "at", y: "amount", by: null, every: null, total: null }).map((p) => p.value),
		).toEqual([9.99, 59.99, 79]);
	});

	it("looks rows up in another table and fills texts", () => {
		const areas: TableRow[] = [
			{ area: "Sales", owner: SOFIE, supervisor: SOFIE, agents: [FINANCE] },
			{ area: "Finance", owner: AMIR, supervisor: IDA, agents: [FINANCE, AMIR] },
		];
		expect(
			interfaceLookup(SOFIE, { from: "table:areas", match: "owner", show: "area", count: false }, areas),
		).toEqual(["Sales"]);
		expect(
			interfaceLookup(IDA, { from: "table:areas", match: "supervisor", show: "agents", count: false }, areas),
		).toEqual([FINANCE, AMIR]);
		expect(interfaceLookup(AMIR, { from: "table:areas", match: "owner", show: null, count: true }, areas)).toBe(1);
		expect(
			fillInterfaceText(
				"Ask {kept_by} about {number}{nothing}",
				{ kept_by: FINANCE, number: "Revenue" },
				(column, value) => (column === "kept_by" ? "Finance" : String(value)),
			),
		).toBe("Ask Finance about Revenue");
	});
});
