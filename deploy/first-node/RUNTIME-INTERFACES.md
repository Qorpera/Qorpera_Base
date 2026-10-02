# Interfaces

Status: designed and approved, not built. Jonas named Interfaces and set their direction on 2 October 2026. The same day
he approved the design page (https://claude.ai/artifact/PXouSQFWVSHTc6Vko3Gm7G) and said yes to its four decisions
(§9). The contract text is the "2026-10-02 amendment: interfaces project company state from the company folder" in
section 19 of `QORPERA-RUNTIME-CONTRACT.md`. Where this document and the contract differ, the contract governs.

The page showed the format, the three first interfaces in it, the contract text and the build plan. This document
gives the exact keys, limits and refusals the parser enforces. Where it adds detail the page did not show, the detail
is marked **proposed** and can change in review without a new founder decision, as long as it keeps the page's rules.

Everything stored in the folder applies to `folder-v2` companies only (core §1). On `snapshot-v1` companies the web
client draws the first interfaces from definitions it ships with (§8, steps I1–I4), reading today's sources. Nothing is
migrated.

## 1. What an interface is

An interface is a page the company keeps in its folder. One TOML file says:
- what the page shows;
- where each part reads from;
- which buttons it has; and
- who sees it.

The web client draws it from ten building blocks that ship with the client. A file can only arrange those blocks, point
them at data and add buttons from a short list of verbs. No script, style, markup or network request from a file runs
in a member's browser or on a Qorpera origin. This replaces the isolated-frame "tools" of the 2026-09-20 amendment,
item 7: there is no page code to isolate.

Members and agents use the same pages. A member opens one from the rail's Interfaces tab. An agent reads one as text
with `interface_read`, and changes one like any other file.

## 2. Where things live

```
interfaces/                       seeded; can't be deleted or moved
  order.md                        the Interfaces tab's order
  <interface>/                    named like an agent's folder (contract 5.6)
    interface.toml                the page
    README.md                     optional: what it is for
tables/                           seeded; can't be deleted or moved
  <table>.toml                    a table: its columns, key and writers
  <table>.csv                     its rows, when they live in the folder
```

- **Names.** Folder and file names follow the agent-handle rule: lowercase a–z, digits and hyphens, plain Latin, at most
  64 characters, `-2`, `-3` when taken. A table's name is the stem of its `.toml`; its rows file has the same stem.
- **Seeded at founding** (§7): `interfaces/`, `tables/`, Pulse (the main interface), Mailbox and Members, with the
  tables `numbers`, `areas` and `cards`.
- **Cannot be deleted or moved:** `interfaces/`, `interfaces/order.md`, `tables/`, and the main interface's folder and
  its `interface.toml`.

### Structured files

| Path | Kind | Checked at save | Limit |
| --- | --- | --- | --- |
| `interfaces/order.md` | interface-order | yes | 16 KiB |
| `interfaces/<name>/interface.toml` | interface | yes | 64 KiB |
| `tables/<name>.toml` | table | yes | 16 KiB |
| `tables/<name>.csv` of a table with a `needs_yes` column | table-rows | yes | 64 KiB (the core's limit for checked files) |
| `tables/<name>.csv` of any other table | plain file | no: checked when read | 2 MiB, at most 20,000 rows |

These are the folder's first structured kinds that are not markdown. A save the parser refuses is refused for that
file with its problems (§6). `README.md` is a plain file.

## 3. `interface.toml`

Strict TOML 1.0. A key that is not listed for its table is refused, so a typo can't silently change a page.

```toml
format = "qorpera.interface/v0"     # required, exactly this

[interface]                         # required
id = "<uuid>"                       # required; stable across renames
name = "Pulse"                      # required; 1–60 characters
about = "…"                         # optional; at most 280 characters
emblem = "pulse"                    # optional; see the emblem list
colour = "coral"                    # optional; the agents' colour names
main = true                         # optional; default false
status = "active"                   # optional; active (default) or off
needs = ["mail"]                    # optional; at most 8 conditions
badge = { from = "waiting", where = { kind = "mail" } }   # optional; a count on the rail row

[template]                          # optional; where a library copy came from
from = "qorpera/pulse"              # <publisher>/<name>, each [a-z0-9-]{1,40}
version = "1.0.0"                   # x.y.z

[access]                            # optional; these are the defaults
members = "all"                     # all | owners | a list of member ids
agents = "all"                      # all | a list of agent ids
edit = "anyone"                     # anyone | owners

[[view]]                            # 1–8 views; the page's tabs, in order
name = "Now"                        # required; 1–40 characters, unique

[[view.block]]                      # 1–24 blocks per view
kind = "list"                       # required; §3.2
from = "activity"                   # the source, §4

[[button]]                          # 0–32 buttons
id = "ask-keeper"                   # required; [a-z0-9-]{1,40}, unique
verb = "message"                    # required; §3.3
label = "Ask {kept_by} about it"    # required; 1–40 characters
```

- **Emblems** (proposed): pulse, mail, members, coin, board, queue, calendar, hire, chart, page. Each is drawn by the
  client as one solid shape in the interface's colour with white cuts, the material the agents' figures use.
- **Colours:** the `colour` names of `agent.md` (charcoal, brown, coral, orange, gold, green, teal, blue, purple, pink,
  gray).
- **`main`:** exactly one active interface is the main one, drawn as the big card on top of the Interfaces tab. The
  seeded Pulse is main. A save that leaves no main interface, or two, is refused.
- **`needs`:** the rail lists the interface only when every condition holds. The conditions are:
  - `mail`: the company has a live mailbox;
  - `team`: the company has two or more members;
  - `connection:<service>`: a connected account of that service;
  - `table:<name>`: the table exists.
- **`status = "off"`** hides the interface for everyone. The file stays.
- **`[access]`** only narrows. `members` decides who sees the page in the rail; `agents` decides which agents may read
  it with `interface_read`. Neither changes what anyone may read: every block reads with the viewer's own authority.
  `edit = "owners"` lets only owners and admins change the file.
- **A view** may reuse another view's blocks with a filter (proposed): `from_view = "Inbox"` and `where = { … }`. It
  then has no blocks of its own.

### 3.1 Keys every block may have

| Key | Value |
| --- | --- |
| `kind` | required; one of the ten blocks |
| `id` | optional; `[a-z0-9-]{1,40}`, unique in the file; a target for `opens` |
| `title` | optional; at most 60 characters |
| `from` | the source (§4); a list for `calendar` |
| `width` | `full` (default), `half`, `third` or `two-thirds`; blocks stack on a phone |
| `where` | an inline table: column = value, or column = a list of values (any of them) |
| `since` | `today`, or `-<n>d`, `-<n>w`, `-<n>m` (days, weeks, months), on the source's time column |
| `order` | a column, newest or largest first with a leading `-` |
| `limit` | 1–200 |
| `buttons` | a list of button ids, or the built-in verbs `answer`, `take`, `offer`, `release` |

Text in `title`, `label`, `line`, `sub`, `note` and button texts may name a column in braces, `{subject}`. The client
fills it with that row's value as plain text. Braces naming no column are refused.

### 3.2 The ten blocks

| Block | Shows | Its own keys |
| --- | --- | --- |
| `text` | a markdown file, or its first paragraph | `show` (`all`, `first-paragraph`); or `text`, at most 2,000 characters, instead of `from` |
| `numbers` | tiles: the value, its change, a target and a small trend line | `value`, `target`, `latest_by`, `trend = { over, weeks }`, `opens` |
| `chart` | lines or bars over time, with an optional target line | `type` (`line`, `bar`), `x`, `y`, `by`, `every` (`day`, `week`, `month`), `sum` or `count`, `target`, `weeks` |
| `list` | a feed: a figure or emblem, one line, a time and a status | `line`, `sub`, `figure`, `status`, `chips`, `layout` (`rows`, `cards`), `opens` |
| `table` | rows and columns that sort and filter | `columns`, `opens`, and lookup columns (below) |
| `board` | lanes of cards to drag between | `lanes` (`members` or a column), `shared`, `open_pile`, and `[[view.block.part]]` |
| `calendar` | what's coming, by day | `days` (1–60) |
| `detail` | one record: its fields, its text, a chart and its buttons | `fields`, `chart = { x, y, target, weeks }` |
| `form` | fields to add a row or change one | `fields` |
| `mail` | an email thread, drawn with the client's email card and its AI line | none |

- **Lookup columns** (table): a column of `columns` that the source does not have may be an inline table
  `{ from = "table:<t>", match = "<column>", show = "<column>" }` or `{ …, count = true }`. It lists or counts the rows
  of that table whose `match` column holds this row's id. That is the only join.
- **Board parts:** each `[[view.block.part]]` has `title`, `from` (a table), `card = { title, line, figures, note }`
  and an optional `opens`. The lane of a row is its table's `holder` column (§5): a member's lane, the Shared lane
  when the `shared` column says yes, or the open pile when it is empty. Dragging a card is a take or an offer.
- **`opens`** names a `detail` block in the same view. On a wide screen it opens beside the list; on a phone it opens as
  the next screen.

### 3.3 Buttons

| Verb | What it does | Its keys |
| --- | --- | --- |
| `open` | opens an agent's thread, another interface, a file or a row | `target`: `agent:{column}`, `interface:<name>`, `file:<path>` or `row` |
| `message` | sends an agent or group chat a prefilled message the viewer can edit first | `to` (an agent id, `{column}` or `co-founder`), `text` (at most 500 characters) |
| `add` | adds a row through a form | `table`, `fields` |
| `set` | changes one cell | `table`, `column`, `value` (a value, `{column}` or `me`) |
| `take` · `offer` · `release` | moves a `needs_yes` column (§5) | `table`, `column` |
| `answer` | shows the platform's own card for something that waits for the viewer | none |

- **`who`** (optional, all buttons): `all` (default), `members` or `agents`.
- **What a button may do.** A button does what its verb says and nothing more. It runs as the viewer, under the same
  review as doing it by hand:
  - `message` posts as the member, or sends a coworker message as the agent;
  - `add`, `set`, `take`, `offer` and `release` save the table's file;
  - `answer` uses the card's existing state machine (contract 16.2).
- **Confirmations.** The client draws every confirmation itself, never from the file. Money, sending and other
  outside effects keep their own review.
- **Never possible:** a link to another site, a script, or a request to any address.

## 4. Sources

A block's `from` names one source. Each source reads with the viewer's own authority: a member sees what they could
open themselves, and an agent reading through `interface_read` sees what its run may read. A block whose source does
not exist yet is not drawn (contract 14.5).

**From the company folder** (the indexes rebuilt from files):

| Source | Columns | Exists when |
| --- | --- | --- |
| `vision` | text | always |
| `file:<path>` | text (markdown, at most 256 KiB read) | the file exists |
| `agents` | id, name, role, figure, colour, status, section | always |
| `groups` | id, name, agents, people | always |
| `todos` | id, agent, title, status, requested_by, updated | always |
| `routines` | id, agent, title, when, next, status | always |
| `connections` | id, service, account, status | always |
| `contacts` | id, name, organization | H2 |
| `human_tasks` | id, title, status, person, from, due | H2 |
| `interfaces` | id, name, about, emblem, status | I6 |
| `table:<name>` | the table's columns | the table exists |
| `mail` | thread, address, from_name, from_address, subject, last_at, state, handled_by, direction, unread | Q1's member read (I5a); later mail files (M2c) |
| `mail_addresses` | address, handled_by, routine, last_7_days | as `mail` |

**From runtime state** (through calls the member already has):

| Source | Columns |
| --- | --- |
| `members` | id, name, picture, role, here |
| `working` | agent, what, since |
| `activity` | at, kind, agent, member, line: one plain sentence per run, wake, answer or change |
| `waiting` | id, kind (`review`, `question`, `mail`, `task`, `offer`), title, from, due |

- **Outside content** (contract 11.1), such as an email, keeps its outside-content mark in every block.
- **Account mail.** Mail the platform marks as sign-up or sign-in mail for a company account shows only who used it
  and when, never its text (A1, I5b).

## 5. Tables

A table's definition is `tables/<name>.toml`. Its rows are company state.

```toml
format = "qorpera.table/v0"         # required, exactly this

[table]                             # required
id = "<uuid>"                       # required
name = "Areas"                      # required; 1–60 characters
about = "…"                         # optional; at most 280 characters
rows = "file"                       # required; "file" (v0); "store" is refused until the table store exists
key = ["area"]                      # required; 1–3 columns that make a row unique
holder = "owner"                    # optional; a needs_yes member column; the board's lanes
time = "at"                         # optional; the column `since` and charts use

[[column]]                          # 1–40 columns, in the CSV's order
name = "owner"                      # required; [a-z][a-z0-9_]{0,39}, unique
type = "member"                     # required; see below
optional = true                     # optional; default false
needs_yes = true                    # optional; member columns only

[write]                             # optional; these are the defaults
agents = "all"                      # all | none | a list of agent ids
members = "all"                     # all | owners | none
```

### Column types

| Type | In the CSV | Extra keys |
| --- | --- | --- |
| `text` | any text | `max` (1–4,000, default 500) |
| `number` | a decimal with `.`, optional leading `-` | none |
| `money` | a decimal amount | `currency` (ISO 4217, e.g. `EUR`, `DKK`) |
| `percent` | a decimal | none |
| `time` | ISO 8601 in UTC: `2026-10-02T09:44Z` or with seconds | none |
| `date` | `2026-10-02` | none |
| `choice` | one of its choices | `choices` (1–50 texts) |
| `yes-no` | `yes` or `no` | none |
| `member` · `agent` | a stable id; the client shows the name | none |
| `agents` | agent ids separated by spaces | none |
| `id` | a uuid the platform fills | none |
| `link` | the key of a row elsewhere | `to`: `table:<name>`, `todos`, `contacts` or `human_tasks` |

### Rows

- `tables/<name>.csv` is RFC 4180 CSV in UTF-8. Its first line is the column names in the definition's order.
- An empty field is allowed only in an `optional` column.
- Two rows with the same key are refused.
- **Checked when saved:** a table with a `needs_yes` column, within 64 KiB. Its rows are parsed at save, so the claim
  rule below can't be bypassed by editing the file by hand.
- **Checked when read:** every other table, up to 2 MiB. `table_write` refuses a bad row up front. A row edited in by
  hand that does not fit is left out, and shown as a problem with its line to the viewer and to the agent that wrote
  it.

### The claim rule ("nobody assigns anybody")

A `needs_yes` member column holds who has something: a card's holder, an area's owner or supervisor.
- **Take:** anyone may set it to their own id when it is empty.
- **Release:** the person it names may clear it.
- **Offer:** naming someone else creates a request card for that person. The file changes only when they say yes;
  not now, or no answer, changes nothing.
- **Agents:** an agent may set it to its own supervisor (§5.1) or clear it. Anything else from an agent is an offer.
- **Anything else** that changes the column is refused at save, whoever makes it and however.

### 5.1 Supervision

In the Members tables, an area's `supervisor` is the member its agents answer to. Jonas, 2 October 2026 (decision 4):
- the supervisor gets the agents' questions and news;
- the agents' work alone runs on the supervisor's AI account: routine occurrences, event wakes and wakes they start
  themselves;
- the supervisor agrees once, when they take the area or say yes to the supervisor request.

A member's own messages still run on that member's account. An agent sits in at most one area. Built as step I9b
(S2). Until it is built, today's rule ("the member who started the work pays") applies.

### 5.2 The table store (later)

`rows = "store"` keeps rows in the company's table store on Qorpera's own nodes. The store is built only when a first
table outgrows a file (decision 1). It keeps these rules:
- the database never holds rows;
- the folder gets a snapshot of each table at least daily;
- deleting or erasing the company removes the store's rows.

## 6. Refusals

A save the parser refuses is refused for that file with a list of problems: `{ line, key, reason }`, at most 50, like
the state files (STATE-FILES §3). The reasons (proposed):

| Reason | When |
| --- | --- |
| `toml` | not valid TOML 1.0 |
| `format` | `format` missing or not this format |
| `unknown_key` | a key this table doesn't take |
| `missing_key` | a required key is missing |
| `bad_value` | a value of the wrong type or outside its list or bounds |
| `duplicate` | two views, blocks, buttons or columns with one name or id |
| `unknown_source` | `from` names no source of §4 |
| `unknown_column` | a column a block, button or `{…}` names is not in its source |
| `unknown_button` | a block lists a button that isn't defined |
| `unknown_target` | `opens` or `from_view` names nothing in the file |
| `main` | no main interface, or two |
| `too_large` | over the size or count limit |
| `row` | a CSV row that doesn't fit its definition (checked tables) |
| `claim` | a `needs_yes` column changed outside the claim rule |

## 7. Who changes what, and review

- **Members** change interfaces and tables like any file, and their changes are never reviewed. `edit = "owners"`
  limits an interface to owners and admins; a table's `[write]` limits who writes rows.
- **Agents** change them with `save_interface` and `table_write`, or as files. The automatic review (2026-09-25
  amendment) counts these as delegation, like hiring:
  - creating an interface;
  - adding or changing a button;
  - changing `[access]`;
  - creating a table, or changing its columns or `[write]`.

  Layout, wording, order and sources apply at once, and the agent's thread shows the change with Undo (decision 2).
  The review recorder learns `save_interface` the way it knows `hire_agent` (step I8).
- **Coding sessions** see `interfaces/` and table definitions read-only.

## 8. Library, seeding and updates

- **The library.** Qorpera's library holds interfaces in this same format: a folder of an `interface.toml`, its
  tables and a README. Pulse, Mailbox and Members are its first three.
- **Adding one** copies its files into `interfaces/` and `tables/` in one change set. The copy is marked with
  `[template] from` and `version`, and from then on it is the company's to change.
- **Seeding.** At founding the platform copies the three first ones and lists them in `interfaces/order.md`. Mailbox
  needs `mail`; Members needs `team`.
- **Updates.** When the library has a newer version, the platform offers it and never applies it by itself. Lines the
  company didn't change update. A line both sides changed becomes a choice with both versions side by side. Removing
  `[template]` stops the offers.
- **Outside templates** (the marketplace, later) are files of this format only. Before one is added, the platform says
  in plain words what it reads and what its buttons do.

### `interfaces/order.md`

```
- <id> Pulse
- <id> Mailbox
- <id> Members
```

One line per interface, `- <id>` and a name for reading, as in `agents/sections.md`. The main interface is drawn on top
wherever it is listed. Interfaces not listed follow by name.

## 9. Decisions (Jonas, 2 October 2026)

1. **Table rows** live in a CSV file beside the table's TOML first. The table store comes later, when a table outgrows
   a file.
2. **Pages made or changed by agents** pass the automatic review plus Undo, not a member's yes.
3. **Sent mail** is kept as files beside received mail (Q1, M2c). Received mail is already saved under
   `hooks/<hook>/` (2026-09-29 amendment, item 6). The Mailbox reads both from the folder.
4. **Supervising an agent** means its work alone runs on the supervisor's AI account (§5.1). This changes "the member
   who started the work pays" for supervised agents.

## 10. Build order

Each step is one PR, handed to the coordinator with an exact-head review and a node 2 run.

| Step | What | Owner | After |
| --- | --- | --- | --- |
| I0 | this document and the contract amendment | Interfaces | — |
| I1 | the rail's Agents and Interfaces tabs, routes `#/c/{id}/i/{interface}` (web) | Interfaces | — |
| I2 | `@qorpera/cloud-client/interfaces`: the parser of §3, §5 and §6, and the query evaluator of §3.1 (pure TS) | Interfaces | — |
| I3 | the ten blocks in the web client, reusing the email, review and question cards | Interfaces | I2 |
| I4 | Pulse on today's sources, from a definition the client ships | Interfaces | I1, I3 |
| I5a | a member read of mail | Q1 | — |
| I5b | the account-mail mark | A1 | — |
| I5c | the Mailbox page, dark until mail is switched on | Interfaces | I5a, I5b |
| I6 | the interface and table kinds in the save hook; seeding | F2, with Interfaces | C2's founding seed, I2 |
| I7 | the web client reads definitions and tables from the folder, live | Interfaces | C4, I6 |
| I8 | `interface_read`, `table_read`, `table_write`, `save_interface` | Interfaces | C3, I6 |
| I9 | Members | Interfaces | I6, I7, C4 member writes |
| I9b | supervisors pay (§5.1) | S2 | I9 |
| I10 | pages made by agents: the review card with a live preview, Undo | Interfaces | I6, I8 |
| I11 | the Mailbox reads mail from the folder | Q1, with Interfaces | M2c |

The library with update offers, the table store and the marketplace come later.
