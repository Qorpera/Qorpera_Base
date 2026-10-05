import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTableFile, parseTableRows, parseTableRowsText } from "../src/interfaces.ts";
import { TABLE_ROWS_CASES } from "./fixtures/table-rows-cases.ts";

/* The save check's SQL tests (P16a: supabase/tests/864 and 865) carry the parser's answers as literals, since SQL never
 * reads TOML or CSV. These checks keep those literals equal to what the parser gives, so the database is tested on the
 * parses real writers send. */

const sql = (name: string) => readFileSync(new URL(`../../../supabase/tests/${name}`, import.meta.url), "utf8");
const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/interface-state.json", import.meta.url), "utf8")) as {
	name: string;
	result: { ok: boolean; file?: unknown } | null;
}[];
const fixture = (name: string) => FIXTURES.find((item) => item.name === name)?.result?.file;

describe("the parses the save check's SQL tests embed", () => {
	it("864 embeds interface-state.json's valid parses", () => {
		const text = sql("864_folder_state_interfaces.test.sql");
		const embedded = Object.fromEntries(
			[...text.matchAll(/when '([a-z-]+)' then \$j\$(.*?)\$j\$/g)].map((match) => [
				match[1],
				JSON.parse(match[2] ?? ""),
			]),
		);
		expect(Object.keys(embedded).sort()).toEqual(["areas", "interface", "order", "rows", "rows-empty", "table"]);
		expect(embedded.interface).toEqual(fixture("valid interface"));
		expect(embedded.order).toEqual(fixture("valid order"));
		expect(embedded.table).toEqual(fixture("valid table"));
		expect(embedded.areas).toEqual(fixture("valid areas table"));
		expect(embedded.rows).toEqual(fixture("valid rows"));
		expect(embedded["rows-empty"]).toEqual(fixture("valid rows, header only"));
	});

	it("865 embeds each table-rows case's definition and rows as the parser reads them, and parseTableRows's answer", () => {
		const text = sql("865_folder_state_tables.test.sql");
		const literal = /select \$j\$(.*?)\$j\$::jsonb/s.exec(text)?.[1];
		const cases = JSON.parse(literal ?? "[]") as { name: string; table: unknown; rows: unknown; expect: unknown }[];
		expect(cases.map((item) => item.name)).toEqual(TABLE_ROWS_CASES.map((item) => item.name));
		for (const [index, item] of TABLE_ROWS_CASES.entries()) {
			const table = parseTableFile(item.table);
			const rows = parseTableRowsText(item.text);
			if (!table.ok || !rows.ok) throw new Error(`${item.name}: the case does not parse`);
			expect(cases[index]?.table, item.name).toEqual(table.file);
			expect(cases[index]?.rows, item.name).toEqual(rows.file);
			const answer = parseTableRows(table.file, item.text);
			expect(cases[index]?.expect, item.name).toEqual(JSON.parse(JSON.stringify(answer)));
		}
	});
});
