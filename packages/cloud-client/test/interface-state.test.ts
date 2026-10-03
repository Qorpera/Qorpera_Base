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

describe("a rows file read without its definition", () => {
	it("keeps the header and each row's raw fields, drops blank lines and a byte order mark", () => {
		const result = parseTableRowsText('﻿name,note\n"Ada, the first",""\n\nBo,"says ""hi"""\n');
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
