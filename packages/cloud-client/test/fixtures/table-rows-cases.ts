/* What the save check's port of parseTableRows must give (RUNTIME-INTERFACES.md §6.1 rule 6; F2's P16): a table with a
 * column of every type, its valid rows typed, and one row that fails each type's rule. table-rows-typed.json holds
 * parseTableRows's answer for each case; test/interface-state.test.ts keeps the two equal. */

import { NUMBERS_TABLE } from "../../src/interface-library.ts";

export const TYPES_TABLE = `format = "qorpera.table/v0"

[table]
id = "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e"
name = "Types"
rows = "file"
key = ["name", "at"]

[[column]]
name = "name"
type = "text"
max = 20

[[column]]
name = "at"
type = "time"

[[column]]
name = "day"
type = "date"
optional = true

[[column]]
name = "count"
type = "number"
optional = true

[[column]]
name = "price"
type = "money"
currency = "EUR"
optional = true

[[column]]
name = "share"
type = "percent"
optional = true

[[column]]
name = "state"
type = "choice"
choices = ["open", "done"]
optional = true

[[column]]
name = "ok"
type = "yes-no"
optional = true

[[column]]
name = "owner"
type = "member"
optional = true
needs_yes = true

[[column]]
name = "kept_by"
type = "agent"
optional = true

[[column]]
name = "team"
type = "agents"
optional = true

[[column]]
name = "ref"
type = "id"
optional = true

[[column]]
name = "link_to"
type = "link"
to = "contacts"
optional = true
`;

const HEADER = "name,at,day,count,price,share,state,ok,owner,kept_by,team,ref,link_to";
const A = "11111111-1111-4111-8111-000000000001";
const B = "11111111-1111-4111-8111-000000000002";
const row = (name: string, fields: Partial<Record<string, string>> = {}) =>
	[
		name,
		fields.at ?? "2026-10-02T09:44Z",
		fields.day ?? "",
		fields.count ?? "",
		fields.price ?? "",
		fields.share ?? "",
		fields.state ?? "",
		fields.ok ?? "",
		fields.owner ?? "",
		fields.kept_by ?? "",
		fields.team ?? "",
		fields.ref ?? "",
		fields.link_to ?? "",
	]
		.map((value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
		.join(",");

export interface TableRowsCase {
	readonly name: string;
	readonly table: string;
	readonly text: string;
}

export const TABLE_ROWS_CASES: readonly TableRowsCase[] = [
	{
		name: "valid, every type",
		table: TYPES_TABLE,
		text: `${HEADER}\n${row("full", {
			at: "2026-10-02T09:44:10Z",
			day: "2026-02-28",
			count: "-12.5",
			price: "1200.00",
			share: "0.25",
			state: "done",
			ok: "yes",
			owner: A,
			kept_by: B,
			team: `${A} ${B}`,
			ref: A,
			link_to: "Ada, the first",
		})}\n${row("empty optionals")}\n`,
	},
	{
		name: "valid, numbers table, a time without seconds and an optional column left out",
		table: NUMBERS_TABLE,
		text: "number,at,value,unit,kept_by\nRevenue,2026-10-02T09:44Z,1200.5,€,11111111-1111-4111-8111-000000000030\n",
	},
	{ name: "text too long", table: TYPES_TABLE, text: `${HEADER}\n${row("x".repeat(21))}\n` },
	{ name: "text with a control character", table: TYPES_TABLE, text: `${HEADER}\n${row("bell\u0007")}\n` },
	{ name: "required empty", table: TYPES_TABLE, text: `${HEADER}\n${row("")}\n` },
	{ name: "number", table: TYPES_TABLE, text: `${HEADER}\n${row("n", { count: "1,5" })}\n` },
	{ name: "number with a leading zero", table: TYPES_TABLE, text: `${HEADER}\n${row("n", { count: "01" })}\n` },
	{ name: "money", table: TYPES_TABLE, text: `${HEADER}\n${row("m", { price: "12.123456789" })}\n` },
	{ name: "percent", table: TYPES_TABLE, text: `${HEADER}\n${row("p", { share: "50%" })}\n` },
	{ name: "time", table: TYPES_TABLE, text: `${HEADER}\n${row("t", { at: "2026-10-02 09:44" })}\n` },
	{ name: "time out of range", table: TYPES_TABLE, text: `${HEADER}\n${row("t", { at: "2026-10-02T24:00Z" })}\n` },
	{ name: "date", table: TYPES_TABLE, text: `${HEADER}\n${row("d", { day: "2026-02-30" })}\n` },
	{ name: "date before year 100", table: TYPES_TABLE, text: `${HEADER}\n${row("d", { day: "0099-12-31" })}\n` },
	{ name: "choice", table: TYPES_TABLE, text: `${HEADER}\n${row("c", { state: "Open" })}\n` },
	{ name: "yes-no", table: TYPES_TABLE, text: `${HEADER}\n${row("y", { ok: "true" })}\n` },
	{
		name: "member in capitals",
		table: TYPES_TABLE,
		text: `${HEADER}\n${row("w", { owner: "ABCDEF01-1111-4111-8111-000000000001" })}\n`,
	},
	{ name: "agents repeated", table: TYPES_TABLE, text: `${HEADER}\n${row("g", { team: `${A} ${A}` })}\n` },
	{ name: "agents two spaces", table: TYPES_TABLE, text: `${HEADER}\n${row("g", { team: `${A}  ${B}` })}\n` },
	{ name: "id", table: TYPES_TABLE, text: `${HEADER}\n${row("i", { ref: "not-an-id" })}\n` },
	{ name: "link too long", table: TYPES_TABLE, text: `${HEADER}\n${row("l", { link_to: "😀".repeat(201) })}\n` },
	{ name: "link with a line break", table: TYPES_TABLE, text: `${HEADER}\n${row("l", { link_to: "a\nb" })}\n` },
	{
		name: "duplicate key, one time spelled two ways",
		table: TYPES_TABLE,
		text: `${HEADER}\n${row("same", { at: "2026-10-02T09:44Z" })}\n${row("same", { at: "2026-10-02T09:44:00Z" })}\n`,
	},
	{ name: "header leaves out a required column", table: TYPES_TABLE, text: "name,day\nx,2026-10-02\n" },
	{ name: "header names an unknown column", table: TYPES_TABLE, text: `${HEADER},extra\n` },
];
