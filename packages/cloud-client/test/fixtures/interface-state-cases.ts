/* The folder hook's fixtures for interface files (RUNTIME-INTERFACES.md §6.1; F2's P16): one valid file of each kind and
 * one file per refusal code the parser gives. interface-state.json holds what parseInterfaceStateFile answers for each,
 * so the SQL side can mirror the shapes and the codes; test/interface-state.test.ts keeps the two equal. */

import { AREAS_TABLE, NUMBERS_TABLE, PULSE_INTERFACE } from "../../src/interface-library.ts";

const page = (body: string) => `format = "qorpera.interface/v0"

[interface]
id = "5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21"
name = "Outside"

[[view]]
name = "Now"
${body}`;
const listOf = (from: string, extra = "") =>
	page(`
[[view.block]]
kind = "list"
from = "${from}"
line = "{title}"
${extra}`);

export interface InterfaceStateCase {
	readonly name: string;
	readonly path: string;
	readonly text: string;
}

export const INTERFACE_STATE_CASES: readonly InterfaceStateCase[] = [
	// Valid, one of each kind.
	{ name: "valid interface", path: "interfaces/pulse/interface.toml", text: PULSE_INTERFACE },
	{
		name: "valid order",
		path: "interfaces/order.md",
		text: "- 5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21 Pulse\n- 0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e Mailbox\n",
	},
	{ name: "valid table", path: "tables/numbers/table.toml", text: NUMBERS_TABLE },
	{ name: "valid areas table", path: "tables/areas/table.toml", text: AREAS_TABLE },
	{
		name: "valid rows",
		path: "tables/numbers/rows.csv",
		text: 'number,at,value,unit,kept_by\nRevenue,2026-10-02T09:44Z,1200.5,€,11111111-1111-4111-8111-000000000030\n"Visits, web",2026-10-02T10:00:00Z,42,count,11111111-1111-4111-8111-000000000030\n',
	},
	{ name: "valid rows, header only", path: "tables/cards/rows.csv", text: "\ufeffid,card,area,holder,state,added_by,todo\n" },
	// One per refusal code.
	{ name: "too_large", path: "tables/numbers/rows.csv", text: `number\n${"x\n".repeat(33 * 1024)}` },
	{ name: "encoding", path: "interfaces/pulse/interface.toml", text: `\ufeff${PULSE_INTERFACE}` },
	{ name: "toml", path: "interfaces/pulse/interface.toml", text: 'format = "qorpera.interface/v0"\n[interface\n' },
	{
		name: "format",
		path: "interfaces/pulse/interface.toml",
		text: PULSE_INTERFACE.replace("qorpera.interface/v0", "qorpera.interface/v9"),
	},
	{
		name: "unknown_key",
		path: "interfaces/pulse/interface.toml",
		text: PULSE_INTERFACE.replace("main = true", "main = true\nshiny = true"),
	},
	{
		name: "missing_key",
		path: "tables/numbers/table.toml",
		text: NUMBERS_TABLE.replace('key = ["number", "at"]\n', ""),
	},
	{
		name: "bad_value",
		path: "tables/numbers/table.toml",
		text: NUMBERS_TABLE.replace('rows = "file"', 'rows = "store"'),
	},
	{
		name: "duplicate",
		path: "tables/numbers/table.toml",
		text: NUMBERS_TABLE.replace('name = "unit"', 'name = "value"'),
	},
	{ name: "unknown_source", path: "interfaces/outside/interface.toml", text: listOf("nowhere") },
	{
		name: "unknown_column",
		path: "interfaces/outside/interface.toml",
		text: listOf("routines").replace("{title}", "{shoe_size}"),
	},
	{
		name: "unknown_button",
		path: "interfaces/outside/interface.toml",
		text: listOf("routines", 'buttons = ["ghost"]\n'),
	},
	{
		name: "unknown_target",
		path: "interfaces/outside/interface.toml",
		text: listOf("routines", 'opens = "nowhere"\n'),
	},
	{
		name: "outside_value",
		path: "interfaces/outside/interface.toml",
		text: `${listOf("file:hooks/stripe/evt_1.md", 'buttons = ["ask"]\n').replace("{title}", "{text}")}
[[button]]
id = "ask"
verb = "message"
label = "Ask"
to = "co-founder"
text = "About {text}"
`,
	},
	{ name: "row", path: "tables/numbers/rows.csv", text: "number,at\nRevenue,2026-10-02T09:44Z,extra\n" },
	{ name: "row header", path: "tables/numbers/rows.csv", text: "number,number\n" },
	{ name: "path", path: "interfaces/Bad_Name/interface.toml", text: PULSE_INTERFACE },
	// Not an interface file: no parse.
	{ name: "plain", path: "interfaces/pulse/README.md", text: "# Pulse\n" },
];
