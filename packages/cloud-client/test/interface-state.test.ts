import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { interfaceLibraryFiles, NUMBERS_TABLE } from "../src/interface-library.ts";
import {
	parseInterfaceStateFile,
	parseTableFile,
	parseTableRows,
	parseTableRowsText,
	type TableFile,
} from "../src/interfaces.ts";
import { INTERFACE_STATE_CASES } from "./fixtures/interface-state-cases.ts";
import { TABLE_ROWS_CASES, TYPES_TABLE } from "./fixtures/table-rows-cases.ts";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/interface-state.json", import.meta.url), "utf8")) as {
	name: string;
	path: string;
	result: unknown;
}[];

const codes = (result: ReturnType<typeof parseInterfaceStateFile>) =>
	result && !result.ok ? result.problems.map((p) => p.code) : [];

describe("the folder hook's entry point for interface files (P16)", () => {
	it("answers each fixture exactly as interface-state.json holds it", () => {
		expect(INTERFACE_STATE_CASES.map((c) => c.name)).toEqual(FIXTURES.map((f) => f.name));
		for (const [index, item] of INTERFACE_STATE_CASES.entries()) {
			const answer = JSON.parse(JSON.stringify(parseInterfaceStateFile(item.path, item.text)));
			expect(answer, item.name).toEqual(FIXTURES[index]?.result);
		}
	});

	it("gives one refusal code per refusal fixture, the one it is named for", () => {
		for (const item of INTERFACE_STATE_CASES.filter((c) => !c.name.startsWith("valid") && c.name !== "plain")) {
			const want = item.name === "path" ? "bad_value" : item.name.split(" ")[0];
			expect(codes(parseInterfaceStateFile(item.path, item.text)), item.name).toContain(want);
		}
	});

	it("refuses a misplaced path for that alone, before its content", () => {
		const result = parseInterfaceStateFile("interfaces/Bad_Name/interface.toml", "not toml at all [");
		expect(result?.ok).toBe(false);
		expect(codes(result)).toEqual(["bad_value"]);
	});

	it("decides the kind on the path's shape, so a badly named folder is checked, never plain", () => {
		expect(parseInterfaceStateFile("interfaces/order.md", "")?.path.kind).toBe("interface-order");
		expect(parseInterfaceStateFile("Interfaces/Order.md", "")?.ok).toBe(false);
		for (const path of ["interfaces/A Page/interface.toml", "tables/my_table/table.toml", "tables/x--y/rows.csv"]) {
			const result = parseInterfaceStateFile(path, "");
			expect(result, path).not.toBeNull();
			expect(result?.ok, path).toBe(false);
		}
		for (const path of [
			"interfaces/pulse/README.md",
			"interfaces/pulse/notes.txt",
			"tables/numbers/README.md",
			"interfaces",
			"tables/numbers",
			"agents/scout/agent.md",
		])
			expect(parseInterfaceStateFile(path, "x"), path).toBeNull();
	});

	it("reads every seeded file, so a new company's seed passes the hook", () => {
		let n = 0;
		for (const [path, text] of Object.entries(
			interfaceLibraryFiles(() => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`),
		)) {
			const result = parseInterfaceStateFile(path, text);
			expect(result?.ok, path).toBe(true);
		}
	});
});

describe("rows typed against their definition, as the save check's port must type them", () => {
	const typed = JSON.parse(readFileSync(new URL("./fixtures/table-rows-typed.json", import.meta.url), "utf8")) as {
		name: string;
		result: unknown;
	}[];
	const table = (text: string) => parseTableFile(text).file as TableFile;

	it("answers each case exactly as table-rows-typed.json holds it", () => {
		expect(TABLE_ROWS_CASES.map((c) => c.name)).toEqual(typed.map((t) => t.name));
		for (const [index, item] of TABLE_ROWS_CASES.entries())
			expect(JSON.parse(JSON.stringify(parseTableRows(table(item.table), item.text))), item.name).toEqual(
				typed[index]?.result,
			);
	});

	it("counts a link's length in code points, as text and the database do", () => {
		const header = "name,at,link_to";
		const fits = parseTableRows(table(TYPES_TABLE), `${header}\nl,2026-10-02T09:44Z,${"😀".repeat(200)}\n`);
		expect(fits.problems).toEqual([]);
	});

	it("refuses a number as a key column, which keys differently in JS and SQL", () => {
		for (const type of ["number", "money", "percent"]) {
			const text = TYPES_TABLE.replace('key = ["name", "at"]', 'key = ["name", "count"]').replace(
				'name = "count"\ntype = "number"\noptional = true',
				`name = "count"\ntype = "${type}"${type === "money" ? '\ncurrency = "EUR"' : ""}`,
			);
			const parsed = parseTableFile(text);
			expect(parsed.ok, type).toBe(false);
			expect(parsed.problems.map((p) => p.code), type).toContain("bad_value");
		}
	});
});

describe("a rows file read without its definition", () => {
	it("keeps the header and each row's raw fields, drops blank lines and a byte order mark", () => {
		const result = parseTableRowsText('\ufeffname,note\n"Ada, the first",""\n\nBo,"says ""hi"""\n');
		expect(result.ok && result.file).toEqual({
			kind: "table-rows",
			header: ["name", "note"],
			rows: [
				{ line: 2, fields: ["Ada, the first", ""] },
				{ line: 4, fields: ["Bo", 'says "hi"'] },
			],
		});
	});

	it("refuses what no definition could read", () => {
		const refused = (text: string) => {
			const result = parseTableRowsText(text);
			return result.ok ? [] : result.problems.map((p) => `${p.code}@${p.line}`);
		};
		expect(refused("")).toEqual(["row@1"]);
		expect(refused("Name\n")).toEqual(["row@1"]);
		expect(refused("a,a\n")).toEqual(["row@1"]);
		expect(refused(`${Array.from({ length: 41 }, (_, i) => `c${i}`).join(",")}\n`)).toEqual(["too_large@1"]);
		expect(refused('a\n"open\n')).toEqual(["row@2"]);
		expect(refused("a,b\n1\n2,3\n4,5,6\n")).toEqual(["row@2", "row@4"]);
		expect(refused("a\nx\u0000y\n")).toEqual(["encoding@null"]);
	});

	it("agrees with the definition's own reading for the rows it keeps", () => {
		const table = parseTableFile(NUMBERS_TABLE).file as TableFile;
		const text =
			"number,at,value,unit,kept_by\nRevenue,2026-10-02T09:44Z,1200.5,€,11111111-1111-4111-8111-000000000030\n";
		const raw = parseTableRowsText(text);
		const typed = parseTableRows(table, text);
		expect(raw.ok).toBe(true);
		expect(typed.problems).toEqual([]);
		expect(raw.ok && raw.file.rows.length).toBe(typed.rows.length);
	});
});
