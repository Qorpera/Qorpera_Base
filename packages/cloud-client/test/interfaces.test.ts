import { describe, expect, it } from "vitest";
import {
	AGENT_COLOURS as STATE_FILES_COLOURS,
	companyPathKey as stateFilesPathKey,
} from "../src/company-state-files.ts";
import { AGENT_COLOURS as SHARED_COLOURS, companyPathKey as sharedPathKey } from "../src/company-state-shared.ts";
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
	interfaceLookupIndex,
	interfaceSeries,
	interfaceSinceStart,
	queryInterfaceRows,
} from "../src/interface-query.ts";
import {
	decodeInterfaceFile,
	INTERFACE_OUTSIDE_VALUE_MAX_CHARS,
	INTERFACE_SOURCE_COLUMNS,
	type InterfaceProblem,
	interfaceInstant,
	interfaceOutsideColumns,
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
	tableDefinitionProblems,
	tableNumberText,
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
		expect(performance.now() - started).toBeLessThan(5_000);
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

describe("values from outside content in a message button", () => {
	const withButton = (from: string, text: string, verb = "message") => `format = "qorpera.interface/v0"

[interface]
id = "5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21"
name = "Outside"

[[view]]
name = "Now"

[[view.block]]
kind = "list"
from = "${from}"
line = "${from === "mail" ? "{subject}" : "{text}"}"
buttons = ["ask"]

[[button]]
id = "ask"
verb = "${verb}"
label = "Ask"
${verb === "message" ? `to = "co-founder"\ntext = ${JSON.stringify(text)}\n` : 'target = "interface:pulse"\n'}`;
	const problems = (from: string, text: string, verb?: string) =>
		codes(parseInterfaceFile(withButton(from, text, verb)).problems);

	it("refuses a saved event's or a contact's text, which can't travel as a quote, by folder key", () => {
		for (const from of [
			"file:hooks/stripe/2026-10/evt_1.md",
			"file:Hooks/stripe/evt_1.md",
			"file:ｈｏｏｋｓ/stripe/evt_1.md",
			"file:human-tasks/sign-lease/reply.md",
		])
			expect(problems(from, "Please file this: {text}")).toEqual(["outside_value"]);
		expect(interfaceOutsideColumns("file:HUMAN-TASKS/x/reply.md")).toEqual(["text"]);
	});

	it("lets the company's own files and the quote list's sources through", () => {
		expect(problems("file:docs/plan.md", "About {text}")).toEqual([]);
		expect(problems("mail", 'About "{subject}" from {from_name}')).toEqual([]);
		expect(problems("file:hooks/stripe/evt_1.md", "Have a look at the event, please")).toEqual([]);
	});

	it("refuses more than 16 outside values in one button", () => {
		expect(problems("mail", "{subject} ".repeat(16))).toEqual([]);
		expect(problems("mail", "{subject} ".repeat(17))).toEqual(["outside_value"]);
	});

	it("checks only what a message button sends, and every source a block reads", () => {
		// An open button sends nothing; its label is shown, never sent.
		expect(problems("file:hooks/stripe/evt_1.md", "", "open")).toEqual([]);
		// A calendar reads several sources: a hook file among them is checked too.
		const calendar = withButton("routines", "File {text}").replace(
			'kind = "list"\nfrom = "routines"\nline = "{text}"',
			'kind = "calendar"\nfrom = ["routines", "file:hooks/stripe/evt_1.md"]',
		);
		expect(calendar).toContain('from = ["routines", "file:hooks/stripe/evt_1.md"]');
		expect(codes(parseInterfaceFile(calendar).problems)).toContain("outside_value");
		expect(codes(parseInterfaceFile(calendar.replace("File {text}", "File {title}")).problems)).not.toContain(
			"outside_value",
		);
		// A source named like an object's own property is an unknown source, never a crash.
		expect(() => parseInterfaceFile(withButton("constructor", "About {text}"))).not.toThrow();
		expect(codes(parseInterfaceFile(withButton("constructor", "About {text}")).problems)).toContain("unknown_source");
		expect(interfaceOutsideColumns("constructor")).toEqual([]);
		expect(INTERFACE_OUTSIDE_VALUE_MAX_CHARS).toBe(2000);
	});

	it("keeps the library's Mailbox valid", () => {
		const mailbox = INTERFACE_LIBRARY.find((entry) => entry.name === "mailbox");
		expect(mailbox && parseInterfaceFile(mailbox.interface).ok).toBe(true);
	});
});

describe("paths and order", () => {
	it("knows each interface file by its path's key", () => {
		expect(interfaceStatePath("interfaces/pulse/interface.toml")).toEqual({ kind: "interface", name: "pulse" });
		expect(interfaceStatePath("Interfaces/Order.md")).toEqual({ kind: "interface-order", name: null });
		expect(interfaceStatePath("tables/numbers/table.toml")).toEqual({ kind: "table", name: "numbers" });
		expect(interfaceStatePath("Tables/Numbers/ROWS.csv")).toEqual({ kind: "table-rows", name: "numbers" });
		expect(interfaceStatePath("tables/numbers.csv")).toBeNull();
		expect(interfaceStatePath("tables/big_table/rows.csv")).toBeNull();
		expect(interfaceStatePath("agents/x/agent.md")).toBeNull();
		expect(interfacePathProblems("interfaces/pulse/README.md")).toEqual([]);
		expect(interfacePathProblems("interfaces/pulse/script.js")).toHaveLength(1);
		expect(interfacePathProblems("tables/notes.txt")).toHaveLength(1);
		expect(interfacePathProblems("tables/numbers/notes.txt")).toHaveLength(1);
		expect(interfacePathProblems("tables/numbers")).toEqual([]);
		expect(interfacePathProblems("tables/numbers/README.md")).toEqual([]);
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
			"tables/areas/rows.csv",
			"tables/areas/table.toml",
			"tables/cards/rows.csv",
			"tables/cards/table.toml",
			"tables/numbers/rows.csv",
			"tables/numbers/table.toml",
		]);
		const pulse = parseInterfaceFile(files["interfaces/pulse/interface.toml"] ?? "");
		expect(pulse.ok && pulse.file.id).toBe("00000000-0000-4000-8000-000000000001");
		const order = parseInterfaceOrderFile(files["interfaces/order.md"] ?? "");
		expect(order.ok && order.file.ids.length).toBe(3);
		for (const name of ["numbers", "areas", "cards"]) {
			const definition = table(files[`tables/${name}/table.toml`] ?? "");
			const rows = parseTableRows(definition, files[`tables/${name}/rows.csv`] ?? "");
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
			{
				number: "Monthly revenue",
				at: "2026-09-29T08:02:00Z",
				value: 4210,
				unit: "€",
				target: 5000,
				kept_by: FINANCE,
			},
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

	it("reads columns in any order and leaves out optional ones", () => {
		const numbers = table(NUMBERS_TABLE);
		const text = `kept_by,value,number,unit,at\n${FINANCE},12,Trials,count,2026-10-02T09:44Z\n`;
		expect(parseTableRows(numbers, text)).toEqual({
			rows: [
				{ number: "Trials", at: "2026-10-02T09:44:00Z", value: 12, unit: "count", target: null, kept_by: FINANCE },
			],
			problems: [],
			readable: true,
		});
		expect(parseTableRows(numbers, "number,at,value,unit,kept_by,colour\n")).toMatchObject({ readable: false });
		expect(parseTableRows(numbers, `${String.fromCharCode(0xfeff)}${text}`).rows).toHaveLength(1);
		expect(parseTableRows(numbers, "number,at,value,unit,kept_by,unit\n")).toMatchObject({ readable: false });
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

	it("writes a number as decimal text, never in exponent form, which the reader refuses", () => {
		expect([5e-7, -1.2e-7, 0.00000001, 0, 123.45, 1e21, -1.5e22].map((value) => tableNumberText(value))).toEqual([
			"0.0000005",
			"-0.00000012",
			"0.00000001",
			"0",
			"123.45",
			`1${"0".repeat(21)}`,
			`-15${"0".repeat(21)}`,
		]);
		const numbers = table(NUMBERS_TABLE);
		const rows: TableRow[] = [
			{ number: "drift", at: "2026-10-01T09:00:00Z", value: 5e-7, unit: "%", target: 0.00000012, kept_by: SOFIE },
		];
		const text = writeTableRows(numbers, rows);
		expect(text).toContain(",0.0000005,%,0.00000012,");
		expect(parseTableRows(numbers, text)).toEqual({ rows, problems: [], readable: true });
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
		expect(
			tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", SOFIE)], member(SOFIE), {
				folder: "areas",
			}),
		).toEqual([]);
		expect(
			tableClaimProblems(areas, [row("Marketing", SOFIE)], [row("Marketing", null)], member(SOFIE), {
				folder: "areas",
			}),
		).toEqual([]);
		expect(tableClaimProblems(areas, [], [row("New", SOFIE)], member(SOFIE), { folder: "areas" })).toEqual([]);
	});

	it("never lets anyone hand an area to someone else or take someone's", () => {
		expect(
			codes(
				tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", AMIR)], member(SOFIE), {
					folder: "areas",
				}),
			),
		).toEqual(["claim", "claim"]);
		expect(
			codes(
				tableClaimProblems(areas, [row("Finance", AMIR)], [row("Finance", SOFIE)], member(SOFIE), {
					folder: "areas",
				}),
			),
		).toEqual(["claim", "claim"]);
		expect(codes(tableClaimProblems(areas, [row("Finance", AMIR)], [], member(SOFIE), { folder: "areas" }))).toEqual([
			"claim",
			"claim",
		]);
	});

	it("allows the write of an accepted offer, and only for the member it names", () => {
		const before = [row("Finance", AMIR, AMIR)];
		const after = [{ ...row("Finance", AMIR, IDA) }];
		const key = tableRowKey(areas, before[0] as TableRow);
		const offers = [{ row: key, column: "supervisor", to: IDA, from: AMIR, was: AMIR }];
		expect(tableClaimProblems(areas, before, after, member(IDA), { folder: "areas", offers })).toEqual([]);
		expect(codes(tableClaimProblems(areas, before, after, member(SOFIE), { folder: "areas", offers }))).toEqual([
			"claim",
		]);
		expect(codes(tableClaimProblems(areas, before, after, member(IDA), { folder: "areas" }))).toEqual(["claim"]);
	});

	it("refuses a stale offer and one made by someone who didn't hold the cell", () => {
		const key = tableRowKey(areas, row("Marketing", null) as TableRow);
		// Offered while empty, then Amir took it: Sofie's yes no longer moves it.
		const stale = [{ row: key, column: "owner", to: SOFIE, from: IDA, was: null }];
		expect(
			codes(
				tableClaimProblems(areas, [row("Marketing", AMIR, null)], [row("Marketing", SOFIE, null)], member(SOFIE), {
					folder: "areas",
					offers: stale,
				}),
			),
		).toEqual(["claim"]);
		// Amir holds it, but Ida made the offer.
		const foreign = [{ row: key, column: "owner", to: SOFIE, from: IDA, was: AMIR }];
		expect(
			codes(
				tableClaimProblems(areas, [row("Marketing", AMIR, null)], [row("Marketing", SOFIE, null)], member(SOFIE), {
					folder: "areas",
					offers: foreign,
				}),
			),
		).toEqual(["claim"]);
		// An empty cell offered by anyone, accepted while still empty, is fine.
		const open = [{ row: key, column: "owner", to: SOFIE, from: IDA, was: null }];
		expect(
			tableClaimProblems(areas, [row("Marketing", null, null)], [row("Marketing", SOFIE, null)], member(SOFIE), {
				folder: "areas",
				offers: open,
			}),
		).toEqual([]);
	});

	it("never lets a definition edit drop the protection from a held cell", () => {
		const loosened = table(
			AREAS_TABLE.replace(
				'name = "supervisor"\ntype = "member"\noptional = true\nneeds_yes = true',
				'name = "supervisor"\ntype = "member"\noptional = true',
			),
		);
		expect(loosened.columns.find((c) => c.name === "supervisor")?.needsYes).toBe(false);
		expect(codes(tableDefinitionProblems(areas, loosened, [row("Sales", SOFIE, IDA)]))).toEqual(["claim"]);
		expect(tableDefinitionProblems(areas, loosened, [row("Sales", SOFIE, null)])).toEqual([]);
	});

	it("keeps agents off an area's member-only columns by default", () => {
		expect(
			codes(
				tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", AMIR)], agentFor(AMIR), {
					folder: "areas",
				}),
			),
		).toEqual(["claim", "claim"]);
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
		expect(tableClaimProblems(cards, [card(null)], [card(AMIR)], agentFor(AMIR), { folder: "cards" })).toEqual([]);
		expect(tableClaimProblems(cards, [card(AMIR)], [card(null)], agentFor(AMIR), { folder: "cards" })).toEqual([]);
		expect(
			codes(tableClaimProblems(cards, [card(SOFIE)], [card(null)], agentFor(AMIR), { folder: "cards" })),
		).toEqual(["claim"]);
		expect(
			codes(tableClaimProblems(cards, [card(null)], [card(SOFIE)], agentFor(AMIR), { folder: "cards" })),
		).toEqual(["claim"]);
		expect(codes(tableClaimProblems(cards, [card(null)], [card(AMIR)], agentFor(null), { folder: "cards" }))).toEqual(
			["claim"],
		);
		expect(
			codes(
				tableClaimProblems(areas, [row("Marketing", null)], [row("Marketing", AMIR)], agentFor(AMIR), {
					folder: "areas",
					memberOnly,
				}),
			),
		).toEqual(["claim", "claim"]);
	});

	it("keeps agents out of an area's agents list", () => {
		const all = ["owner", "supervisor", "agents"];
		const withAgents = (agents: string[] | null): TableRow => ({ ...row("Sales", SOFIE), agents });
		expect(
			codes(
				tableClaimProblems(areas, [withAgents(null)], [withAgents([FINANCE])], agentFor(SOFIE), {
					folder: "areas",
					memberOnly: all,
				}),
			),
		).toEqual(["claim"]);
		expect(
			tableClaimProblems(areas, [withAgents(null)], [withAgents([FINANCE])], member(SOFIE), {
				folder: "areas",
				memberOnly: all,
			}),
		).toEqual([]);
	});

	it("leaves rows alone that change nothing it guards", () => {
		const before = [row("Sales", SOFIE)];
		const after = [{ ...row("Sales", SOFIE), about: "Trials and teams" }];
		expect(tableClaimProblems(areas, before, after, member(AMIR), { folder: "areas" })).toEqual([]);
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

describe("review round 1", () => {
	it("refuses empty keys, choices and agent lists, a card without a title and a broken title", () => {
		const bad = parseTableFile(
			NUMBERS_TABLE.replace('key = ["number", "at"]', "key = []")
				.replace('choices = ["€", "kr", "$", "%", "count", "minutes", "hours"]', "choices = []")
				.replace('agents = "all"', "agents = []"),
		);
		expect(bad.problems.map((p) => `${p.code}:${p.key}`)).toEqual(
			expect.arrayContaining(["missing_key:table.key", "missing_key:column[3].choices", "bad_value:write.agents"]),
		);
		const board = parseInterfaceFile(
			MEMBERS_INTERFACE.replace('card = { title = "{card}", line = "{area}" }', 'card = { line = "{area}" }'),
		);
		expect(board.problems.map((p) => p.code)).toContain("missing_key");
		const title = parseInterfaceFile(MINIMAL.replace('kind = "list"', 'kind = "list"\ntitle = "Hello {"'));
		expect(title.problems.map((p) => `${p.code}:${p.key}`)).toEqual(["bad_value:view[0].block[0].title"]);
	});

	it("caps problems at 50 with a closing count, and clips long keys", () => {
		const keys = Array.from({ length: 60 }, (_, n) => `k${n} = 1`).join("\n");
		const result = parseInterfaceFile(`${MINIMAL}${keys}\n`);
		expect(result.problems).toHaveLength(51);
		expect(result.problems[50]?.message).toBe("and 10 more problems");
		const long = parseInterfaceFile(`${MINIMAL}${"a".repeat(30_000)} = 1\n`);
		expect((long.problems[0]?.key ?? "").length).toBeLessThan(150);
		expect((long.problems[0]?.message ?? "").length).toBeLessThan(400);
	});

	it("refuses direction and control characters in texts", () => {
		const bidi = parseInterfaceFile(MINIMAL.replace('name = "Small"', 'name = "Small\\u202e"'));
		expect(bidi.problems.map((p) => p.key)).toEqual(["interface.name"]);
	});

	it("stores one spelling of a time, so two spellings are one key", () => {
		const numbers = table(NUMBERS_TABLE);
		const text = `number,at,value,unit,kept_by\nA,2026-10-02T09:44Z,1,count,${FINANCE}\nA,2026-10-02T09:44:00Z,2,count,${FINANCE}\n`;
		const result = parseTableRows(numbers, text);
		expect(result.rows.map((r) => r.at)).toEqual(["2026-10-02T09:44:00Z"]);
		expect(result.problems.map((p) => p.code)).toEqual(["duplicate"]);
	});

	it("reads only a row's own columns", () => {
		expect(fillInterfaceText("{constructor}|{hasownproperty}", {})).toBe("|");
		expect(() => (INTERFACE_SOURCE_COLUMNS.waiting as string[]).push("x")).toThrow();
	});

	it("builds a lookup over a full table once", () => {
		const rows: TableRow[] = Array.from({ length: 10_000 }, (_, n) => ({
			id: `r${n}`,
			owner: `m${n % 100}`,
			area: `a${n % 7}`,
		}));
		const started = performance.now();
		const owns = interfaceLookupIndex({ from: "table:areas", match: "owner", show: "area", count: false }, rows);
		for (let n = 0; n < 10_000; n++) owns(`m${n % 100}`);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(owns("m3")).toEqual(["a3", "a5", "a0", "a2", "a4", "a6", "a1"]);
	});

	it("checks names as written, and lets the seeded folders themselves be", () => {
		expect(interfacePathProblems("interfaces")).toEqual([]);
		expect(interfacePathProblems("tables/")).toEqual([]);
		expect(interfacePathProblems("interfaces/Pulse/interface.toml")).toHaveLength(1);
		expect(interfacePathProblems("tables/ＡＲＥＡＳ/rows.csv")).toHaveLength(1);
	});

	it("reads -0 as 0, refuses a lone carriage return in CSV and a broken character in order.md", () => {
		expect(Object.is(parseTomlSubset("a = -0").value.a, 0)).toBe(true);
		expect(splitCsv("a,b\rc\n").error).not.toBeNull();
		expect(parseInterfaceOrderFile(`- ${SOFIE} \ud800\n`).problems.map((p) => p.code)).toEqual(["encoding"]);
		expect(writeInterfaceOrderFile([SOFIE], new Map([[SOFIE, `${"😀".repeat(130)}`]]))).toBe(
			`- ${SOFIE} ${"😀".repeat(120)}\n`,
		);
	});

	it("counts months back to a day the month has, and matches yes and no", () => {
		expect(interfaceSinceStart("-1m", { now: Date.UTC(2026, 2, 31, 12), startOfToday: 0 })).toBe(
			Date.UTC(2026, 1, 28, 12),
		);
		const rows: TableRow[] = [
			{ area: "Support", shared: true },
			{ area: "Sales", shared: false },
		];
		const query = { where: { shared: "yes" }, since: null, order: null, limit: null, latestBy: null };
		expect(
			queryInterfaceRows(rows, query, { time: null, clock: { now: 0, startOfToday: 0 } }).map((r) => r.area),
		).toEqual(["Support"]);
	});
});

describe("review round 2", () => {
	const areas = table(AREAS_TABLE);
	it("refuses turning needs_yes on over a filled column", () => {
		const plain = table(
			AREAS_TABLE.replace(
				'name = "supervisor"\ntype = "member"\noptional = true\nneeds_yes = true',
				'name = "supervisor"\ntype = "member"\noptional = true',
			),
		);
		const filled: TableRow[] = [
			{ area: "Sales", about: null, owner: SOFIE, shared: false, supervisor: AMIR, agents: null },
		];
		expect(tableDefinitionProblems(plain, areas, filled).map((p) => p.code)).toEqual(["claim"]);
		expect(tableDefinitionProblems(plain, areas, [{ ...filled[0], supervisor: null } as TableRow])).toEqual([]);
	});

	it("trims slashes in linear time and refuses an over-long path", () => {
		const started = performance.now();
		expect(interfacePathProblems(`${"/".repeat(5_000)}interfaces`)).toHaveLength(1);
		expect(interfacePathProblems(`/interfaces/pulse/interface.toml/`)).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("caps row and order problems with a closing count", () => {
		const numbers = table(NUMBERS_TABLE);
		const rows = Array.from({ length: 60 }, (_, n) => `X${n},bad,1,count,${FINANCE}`).join("\n");
		const result = parseTableRows(numbers, `number,at,value,unit,kept_by\n${rows}\n`);
		expect(result.problems).toHaveLength(51);
		expect(result.problems[50]).toMatchObject({ code: "row", message: "and 10 more problems" });
		expect(parseInterfaceOrderFile(`﻿- ${SOFIE}\n`).ok).toBe(true);
	});

	it("reads a column named constructor as a lookup, and checks titles and card texts", () => {
		const text = `${MINIMAL}
[[view.block]]
kind = "table"
from = "members"
columns = ["name", "constructor"]
constructor = { from = "table:areas", match = "owner", count = true }
`;
		expect(parseInterfaceFile(text).problems).toEqual([]);
		const title = parseInterfaceFile(MINIMAL.replace('kind = "list"', 'kind = "list"\ntitle = "{nope}"'));
		expect(title.problems.map((p) => p.code)).toEqual(["unknown_column"]);
		const card = parseInterfaceFile(MEMBERS_INTERFACE.replace('line = "{about}"', 'line = "{about}\\u202e"'));
		expect(card.problems.map((p) => p.code)).toContain("bad_value");
	});

	it("gives every caller its own frozen lookup answer", () => {
		const owns = interfaceLookupIndex({ from: "table:areas", match: "owner", show: "area", count: false }, [
			{ owner: SOFIE, area: "Sales" },
		]);
		expect(Object.isFrozen(owns(SOFIE))).toBe(true);
	});
});

describe("review round 3", () => {
	it("never takes an object built-in for a lookup, and clips long names", () => {
		const text = `${MINIMAL}
[[view.block]]
kind = "table"
from = "agents"
columns = ["name", "constructor"]
`;
		const result = parseInterfaceFile(text);
		expect(result.problems.map((p) => p.code)).toEqual(["unknown_column"]);
		const long = `c${"x".repeat(20_000)}`;
		const where = parseInterfaceFile(
			MINIMAL.replace('kind = "list"', `kind = "list"\nwhere = { ${long} = { a = 1 } }`),
		);
		expect(where.problems.every((p) => p.message.length < 400)).toBe(true);
	});

	it("matches the areas folder however it is spelled", () => {
		const areas = table(AREAS_TABLE);
		const row = (owner: string | null): TableRow => ({
			area: "Sales",
			about: null,
			owner,
			shared: false,
			supervisor: owner,
			agents: null,
		});
		const agent = { kind: "agent" as const, agentId: FINANCE, supervisorId: SOFIE };
		expect(
			tableClaimProblems(areas, [row(null)], [row(SOFIE)], agent, { folder: "Areas" }).map((p) => p.code),
		).toEqual(["claim", "claim"]);
	});
});

describe("the shared module and the save path's decoding (I2b)", () => {
	it("keeps a byte order mark so the text matches the saved bytes, and the rows still read", () => {
		const csv = `number,at,value,unit,kept_by\nA,2026-10-02T09:44Z,1,count,${FINANCE}\n`;
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(csv)]);
		const text = decodeInterfaceFile(bytes);
		expect(text?.charCodeAt(0)).toBe(0xfeff);
		expect(new TextEncoder().encode(text ?? "")).toEqual(bytes);
		expect(parseTableRows(table(NUMBERS_TABLE), text ?? "").rows).toHaveLength(1);
		expect(parseTableFile(`﻿${NUMBERS_TABLE}`).problems.map((p) => p.code)).toEqual(["encoding"]);
		expect(decodeInterfaceFile(new Uint8Array([0xff, 0xfe]))).toBeNull();
	});

	it("shares the path key and colours with the state files", () => {
		expect(sharedPathKey).toBe(stateFilesPathKey);
		expect(SHARED_COLOURS).toBe(STATE_FILES_COLOURS);
	});
});
