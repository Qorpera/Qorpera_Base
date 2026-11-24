/* The folder hook's fixtures for interface files (RUNTIME-INTERFACES.md §6.1; F2's P16): one valid file of each kind and
 * one file per refusal code the parser gives. interface-state.json holds what parseInterfaceStateFile answers for each,
 * so the SQL side can mirror the shapes and the codes; test/interface-state.test.ts keeps the two equal. */

import { AREAS_TABLE, NUMBERS_TABLE } from "../../src/interface-library.ts";

const PULSE_INTERFACE = `# QorperaOS/interfaces/pulse/interface.toml
format = "qorpera.interface/v0"

[interface]
id = "5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21"
name = "Pulse"
about = "Everything happening in the company now: what needs you, the numbers, the work and what's next."
emblem = "pulse"
colour = "coral"
main = true
status = "active"

[template]
from = "qorpera/pulse"
version = "1.0.0"

[access]
members = "all"
agents = "all"
edit = "anyone"

[[view]]
name = "Now"

[[view.block]]
kind = "text"
from = "vision"
show = "first-paragraph"

[[view.block]]
kind = "list"
title = "Needs you"
from = "waiting"
layout = "cards"
line = "{title}"
limit = 4
buttons = ["answer"]

[[view.block]]
kind = "numbers"
title = "The numbers"
from = "table:numbers"
latest_by = "number"
value = "value"
target = "target"
trend = { over = "at", weeks = 12 }
opens = "number"

[[view.block]]
kind = "list"
title = "Working now"
from = "working"
line = "{what}"
figure = "agent"
width = "half"

[[view.block]]
kind = "list"
title = "What happened"
from = "activity"
line = "{line}"
since = "today"
order = "-at"
width = "half"

[[view.block]]
kind = "list"
title = "The work"
from = "todos"
line = "{title}"
figure = "agent"
status = "status"
where = { status = ["open", "blocked"] }
order = "-updated"
limit = 5
width = "half"

[[view.block]]
kind = "calendar"
title = "Coming up"
from = ["routines", "human_tasks"]
days = 14
width = "half"

[[view.block]]
id = "number"
kind = "detail"
from = "table:numbers"
chart = { x = "at", y = "value", target = "target", weeks = 12 }
buttons = ["ask-keeper"]

[[button]]
id = "ask-keeper"
verb = "message"
label = "Ask {kept_by} about it"
to = "{kept_by}"
text = "About {number}: "
`;

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
	{ name: "valid interface", path: "QorperaOS/interfaces/pulse/interface.toml", text: PULSE_INTERFACE },
	{
		name: "valid order",
		path: "QorperaOS/interfaces/order.md",
		text: "- 5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21 Pulse\n- 0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e Mailbox\n",
	},
	{ name: "valid table", path: "QorperaOS/tables/numbers/table.toml", text: NUMBERS_TABLE },
	{ name: "valid areas table", path: "QorperaOS/tables/areas/table.toml", text: AREAS_TABLE },
	{
		name: "valid rows",
		path: "QorperaOS/tables/numbers/rows.csv",
		text: 'number,at,value,unit,kept_by\nRevenue,2026-10-02T09:44Z,1200.5,€,11111111-1111-4111-8111-000000000030\n"Visits, web",2026-10-02T10:00:00Z,42,count,11111111-1111-4111-8111-000000000030\n',
	},
	{
		name: "valid rows, header only",
		path: "QorperaOS/tables/cards/rows.csv",
		text: "\ufeffid,card,area,holder,state,added_by,todo\n",
	},
	// One per refusal code.
	{ name: "too_large", path: "QorperaOS/tables/numbers/rows.csv", text: `number\n${"x\n".repeat(33 * 1024)}` },
	{ name: "encoding", path: "QorperaOS/interfaces/pulse/interface.toml", text: `\ufeff${PULSE_INTERFACE}` },
	{
		name: "toml",
		path: "QorperaOS/interfaces/pulse/interface.toml",
		text: 'format = "qorpera.interface/v0"\n[interface\n',
	},
	{
		name: "format",
		path: "QorperaOS/interfaces/pulse/interface.toml",
		text: PULSE_INTERFACE.replace("qorpera.interface/v0", "qorpera.interface/v9"),
	},
	{
		name: "unknown_key",
		path: "QorperaOS/interfaces/pulse/interface.toml",
		text: PULSE_INTERFACE.replace("main = true", "main = true\nshiny = true"),
	},
	{
		name: "missing_key",
		path: "QorperaOS/tables/numbers/table.toml",
		text: NUMBERS_TABLE.replace('key = ["number", "at"]\n', ""),
	},
	{
		name: "bad_value",
		path: "QorperaOS/tables/numbers/table.toml",
		text: NUMBERS_TABLE.replace('rows = "file"', 'rows = "store"'),
	},
	{
		name: "duplicate",
		path: "QorperaOS/tables/numbers/table.toml",
		text: NUMBERS_TABLE.replace('name = "unit"', 'name = "value"'),
	},
	{ name: "unknown_source", path: "QorperaOS/interfaces/outside/interface.toml", text: listOf("nowhere") },
	{
		name: "unknown_column",
		path: "QorperaOS/interfaces/outside/interface.toml",
		text: listOf("routines").replace("{title}", "{shoe_size}"),
	},
	{
		name: "unknown_button",
		path: "QorperaOS/interfaces/outside/interface.toml",
		text: listOf("routines", 'buttons = ["ghost"]\n'),
	},
	{
		name: "unknown_target",
		path: "QorperaOS/interfaces/outside/interface.toml",
		text: listOf("routines", 'opens = "nowhere"\n'),
	},
	{
		name: "outside_value",
		path: "QorperaOS/interfaces/outside/interface.toml",
		text: `${listOf("file:hooks/stripe/evt_1.md", 'buttons = ["ask"]\n').replace("{title}", "{text}")}
[[button]]
id = "ask"
verb = "message"
label = "Ask"
to = "co-founder"
text = "About {text}"
`,
	},
	{ name: "row", path: "QorperaOS/tables/numbers/rows.csv", text: "number,at\nRevenue,2026-10-02T09:44Z,extra\n" },
	{ name: "row header", path: "QorperaOS/tables/numbers/rows.csv", text: "number,number\n" },
	{ name: "path", path: "QorperaOS/interfaces/Bad_Name/interface.toml", text: PULSE_INTERFACE },
	// Not an interface file: no parse.
	{ name: "plain", path: "QorperaOS/interfaces/pulse/README.md", text: "# Pulse\n" },
];
