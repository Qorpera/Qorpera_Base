/** Qorpera's library of interfaces (RUNTIME-INTERFACES.md §8): the files of Mailbox and Members with the areas table,
 * which the platform copies into a new company's folder (step I6) and the web draws its two pages from. Pulse, its
 * numbers table and the cards table are no longer seeded (Jonas, 21 October 2026; the 2026-10-17 scope reset): they
 * stay here as examples of the format, which tests read. Every file parses with ./interfaces.ts; the tests hold them to
 * it. The ids are the library's; a copy gets fresh ones (`interfaceLibraryFiles`). */

import { writeInterfaceOrderFile } from "./interfaces.ts";

export const PULSE_INTERFACE = `# interfaces/pulse/interface.toml
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

export const NUMBERS_TABLE = `# tables/numbers/table.toml (rows in tables/numbers/rows.csv)
format = "qorpera.table/v0"

[table]
id = "c41a90e2-6b1d-4f3a-8e57-2d9c0b4a1f68"
name = "Numbers"
about = "The numbers the company steers by. One row per reading; a number's newest row is its value now."
rows = "file"
key = ["number", "at"]
time = "at"

[[column]]
name = "number"
type = "text"
max = 60

[[column]]
name = "at"
type = "time"

[[column]]
name = "value"
type = "number"

[[column]]
name = "unit"
type = "choice"
choices = ["€", "kr", "$", "%", "count", "minutes", "hours"]

[[column]]
name = "target"
type = "number"
optional = true

[[column]]
name = "kept_by"
type = "agent"

[write]
agents = "all"
members = "all"
`;

export const MAILBOX_INTERFACE = `# interfaces/mailbox/interface.toml
format = "qorpera.interface/v0"

[interface]
id = "9a41d0f3-5c2e-4b7a-9f10-3e6d8c2b7a54"
name = "Mailbox"
about = "The company's email: what arrived, which agent handled it, and what waits for a person."
emblem = "mail"
colour = "blue"
status = "active"
needs = ["mail"]
badge = { from = "waiting", where = { kind = "mail" } }

[template]
from = "qorpera/mailbox"
version = "1.0.0"

[access]
members = "all"
agents = "all"
edit = "anyone"

[[view]]
name = "Inbox"

[[view.block]]
id = "threads"
kind = "list"
from = "mail"
order = "-last_at"
line = "{from_name}"
sub = "{subject}"
figure = "handled_by"
status = "state"
chips = "address"
opens = "thread"
width = "third"

[[view.block]]
id = "thread"
kind = "mail"
from = "mail"
buttons = ["answer", "ask-handler"]
width = "two-thirds"

[[view]]
name = "Waiting for you"
from_view = "Inbox"
where = { state = "waiting" }

[[view]]
name = "Sent"
from_view = "Inbox"
where = { direction = "sent" }

[[view]]
name = "Addresses"

[[view.block]]
kind = "table"
from = "mail_addresses"
columns = ["address", "handled_by", "routine", "last_7_days"]
buttons = ["ask-cofounder"]

[[button]]
id = "ask-handler"
verb = "message"
label = "Ask {handled_by}"
to = "{handled_by}"
text = "About the email \\"{subject}\\" from {from_name}: "

[[button]]
id = "ask-cofounder"
verb = "message"
label = "Ask to change…"
to = "co-founder"
text = "Please have another agent handle {address}: "
`;

export const MEMBERS_INTERFACE = `# interfaces/members/interface.toml
format = "qorpera.interface/v0"

[interface]
id = "e7f2b6c4-1a9d-4e3b-8c05-6f4a2d9b1e37"
name = "Members"
about = "Who owns, supervises and does what."
emblem = "members"
colour = "green"
status = "active"
needs = ["team"]

[template]
from = "qorpera/members"
version = "1.0.0"

[access]
members = "all"
agents = "all"
edit = "owners"

[[view]]
name = "Board"

[[view.block]]
kind = "board"
lanes = "members"
shared = "shared"
open_pile = true
buttons = ["take", "offer", "release", "answer"]

  [[view.block.part]]
  title = "Areas"
  from = "table:areas"
  card = { title = "{area}", line = "{about}", figures = "agents", note = "Supervised by {supervisor}" }
  opens = "area"

  [[view.block.part]]
  title = "Cards"
  from = "table:cards"
  card = { title = "{card}", line = "{area}" }

[[view.block]]
id = "area"
kind = "detail"
from = "table:areas"
fields = ["owner", "supervisor", "agents"]

[[view]]
name = "People"

[[view.block]]
kind = "table"
from = "members"
columns = ["name", "role", "owns", "supervises", "holds"]
owns = { from = "table:areas", match = "owner", show = "area" }
supervises = { from = "table:areas", match = "supervisor", show = "agents" }
holds = { from = "table:cards", match = "holder", count = true }

[[view.block]]
kind = "text"
from = "file:rules/shared-areas.md"
`;

export const AREAS_TABLE = `# tables/areas/table.toml (rows in tables/areas/rows.csv)
format = "qorpera.table/v0"

[table]
id = "1d6e4a57-8b3c-4f21-9e6d-0a7c5b2f8e14"
name = "Areas"
about = "The company's areas: whose call each one is, and who its agents answer to."
rows = "file"
key = ["area"]
holder = "owner"

[[column]]
name = "area"
type = "text"
max = 60

[[column]]
name = "about"
type = "text"
optional = true
max = 280

[[column]]
name = "owner"
type = "member"
optional = true
needs_yes = true

[[column]]
name = "shared"
type = "yes-no"

[[column]]
name = "supervisor"
type = "member"
optional = true
needs_yes = true

[[column]]
name = "agents"
type = "agents"
optional = true

[write]
agents = "all"
members = "all"
`;

export const CARDS_TABLE = `# tables/cards/table.toml (rows in tables/cards/rows.csv)
format = "qorpera.table/v0"

[table]
id = "86b0c3e9-2d4f-4a6b-b1e8-5c7d9f0a3b62"
name = "Cards"
about = "Work for people, dealt by the Co-Founder or put here by agents. The holder's agents work it."
rows = "file"
key = ["id"]
holder = "holder"

[[column]]
name = "id"
type = "id"

[[column]]
name = "card"
type = "text"
max = 200

[[column]]
name = "area"
type = "link"
to = "table:areas"
optional = true

[[column]]
name = "holder"
type = "member"
optional = true
needs_yes = true

[[column]]
name = "state"
type = "choice"
choices = ["open", "held", "done"]

[[column]]
name = "added_by"
type = "agent"
optional = true

[[column]]
name = "todo"
type = "link"
to = "todos"
optional = true

[write]
agents = "all"
members = "all"
`;

export interface InterfaceLibraryEntry {
	readonly name: "mailbox" | "members";
	readonly interface: string;
	readonly tables: Readonly<Record<string, string>>;
}

/** The two pages a company may show, in the Interfaces tab's order, each with the tables a new company gets for it.
 * Members still names the cards table, which the web leaves out of the page; no company is seeded with it. */
export const INTERFACE_LIBRARY: readonly InterfaceLibraryEntry[] = Object.freeze<InterfaceLibraryEntry[]>([
	{ name: "mailbox", interface: MAILBOX_INTERFACE, tables: {} },
	{ name: "members", interface: MEMBERS_INTERFACE, tables: { areas: AREAS_TABLE } },
]);

/** The header line each table's rows file starts with. */
function rowsHeader(table: string): string {
	const names: string[] = [];
	for (const match of table.matchAll(/^\[\[column\]\]\nname = "([a-z][a-z0-9_]*)"$/gm)) names.push(match[1] ?? "");
	return `${names.join(",")}\n`;
}

/** The files a new company gets (path → text): each interface and table with fresh ids, empty rows files, and
 * `interfaces/order.md`. `newId` makes a uuid. */
export function interfaceLibraryFiles(newId: () => string): Record<string, string> {
	const files: Record<string, string> = {};
	const order: string[] = [];
	const names = new Map<string, string>();
	const fresh = (text: string): { text: string; id: string } => {
		const id = newId();
		return { text: text.replace(/^id = "[0-9a-f-]{36}"$/m, `id = "${id}"`), id };
	};
	for (const entry of INTERFACE_LIBRARY) {
		const page = fresh(entry.interface);
		files[`interfaces/${entry.name}/interface.toml`] = page.text;
		order.push(page.id);
		names.set(page.id, entry.name[0]?.toUpperCase() + entry.name.slice(1));
		for (const [table, text] of Object.entries(entry.tables)) {
			files[`tables/${table}/table.toml`] = fresh(text).text;
			files[`tables/${table}/rows.csv`] = rowsHeader(text);
		}
	}
	files["interfaces/order.md"] = writeInterfaceOrderFile(order, names);
	return files;
}
