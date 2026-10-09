# Interfaces

Status: designed and approved, not built. Jonas named Interfaces and set their direction on 2 October 2026. The same day
he approved the design page (https://claude.ai/artifact/PXouSQFWVSHTc6Vko3Gm7G) and said yes to its four decisions
(§9). The contract text is the "2026-10-02 amendment: interfaces project company state from the company folder" in
section 19 of `QORPERA-RUNTIME-CONTRACT.md`. Where this document and the contract differ, the contract governs.

The page showed the format, the three first interfaces in it, the contract text and the build plan. This document
gives the exact keys, limits and refusals the parser enforces. Where it adds detail the page did not show, the detail
is marked **proposed** and can change in review without a new founder decision, as long as it keeps the page's rules.

Everything stored in the folder applies to `folder-v2` companies only (core §1). On `snapshot-v1` companies the web
client draws the first interfaces from definitions it ships with (§10, steps I1–I4), reading today's sources. Nothing is
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
with `interface_read`, and changes one with `save_interface` (§7).

## 2. Where things live

```
interfaces/                       seeded; can't be deleted or moved
  order.md                        the Interfaces tab's order
  <interface>/                    named like an agent's folder (contract 5.6)
    interface.toml                the page
    README.md                     optional: what it is for
tables/                           seeded; can't be deleted or moved
  <table>/                        one folder per table, created, moved and deleted as one unit
    table.toml                    the table: its columns, key and writers
    rows.csv                      its rows
```

- **Names.** Folder names follow the agent-handle rule: lowercase a–z, digits and hyphens, plain Latin, at most 64
  characters, `-2`, `-3` when taken. A table's name is its folder's name.
- **Seeded at founding** (§8): `interfaces/`, `tables/`, Pulse (the main interface), Mailbox and Members, with the
  tables `numbers`, `areas` and `cards`.
- **Cannot be deleted or moved:**
  - `interfaces/`, `interfaces/order.md`, and the main interface's folder and its `interface.toml`;
  - `tables/`, and the `tables/areas/` folder, which the platform reads supervision from (§5.1);
  - `table.toml` and `rows.csv` on their own: deleting a table's folder deletes the table.

### Structured files

| Path | Kind | Checked at save | Limit |
| --- | --- | --- | --- |
| `interfaces/order.md` | interface-order | yes | 16 KiB |
| `interfaces/<name>/interface.toml` | interface | yes | 64 KiB |
| `tables/<name>/table.toml` | table | yes | 16 KiB |
| `tables/<name>/rows.csv` | table-rows | yes, against its definition | 64 KiB (the core's limit for checked files) |

A file's kind comes from its path alone, as for the state files. These are the folder's first structured kinds that
are not markdown. A save that is refused is refused for that file with its problems (§6). `README.md` is a plain
file.

**Proposed: every rows file is checked, within 64 KiB.** The design page allowed plain rows files up to 2 MiB, and
showed a table as two files side by side. The review of this document found two problems:
- a file's kind can't depend on another file, so whether a CSV is checked can't follow a `needs_yes` column in its
  definition;
- the folder core commits a change one unit at a time, so a definition and its rows must live in one folder to be
  created, moved or deleted together.

Every rows file is therefore checked, each table is a folder, and a table that
outgrows 64 KiB waits for the table store (decision 1). 64 KiB is the folder core's current bound for a checked
file, not a product limit (contract 5.5). As a guide, the seeded numbers table holds a year of weekly readings for
about ten numbers; finer history waits for the store.

## 3. `interface.toml`

A strict subset of TOML 1.0, read by the platform's own reader:
- comments and `[table]` and `[[array]]` headers;
- `key = value` with no dotted keys;
- values: one-line strings, decimal numbers, `true` and `false`, arrays, and one-line inline tables.

No dates, multi-line strings or other number forms. A key that is not listed for its table is refused, so a typo
can't silently change a page.

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
- **`main`:** exactly one interface is the main one, drawn as the big card on top of the Interfaces tab. The seeded
  Pulse is main. The save check refuses a change that would leave two main interfaces. Between the two steps of a
  switch there may be none, which the web shows (§6.1 rule 3).
- **`needs`:** the rail lists the interface only when every condition holds. The conditions are:
  - `mail`: the company has a live mailbox;
  - `team`: the company has two or more members;
  - `connection:<service>`: a connected account of that service;
  - `table:<name>`: the table exists.
- **`badge`** (proposed, built in I5c): how many of the source's rows its `where` keeps, drawn on the rail row's
  emblem (99+ above 99) and read out as "{n} waiting". Nothing is drawn at 0 or while the source can't be read.
- **`status = "off"`** hides the interface for everyone. The file stays.
- **`[access]`** only narrows. `members` decides who sees the page in the rail; `agents` decides which agents may read
  it with `interface_read`. Neither changes what anyone may read: every block reads with the viewer's own authority.
  `edit = "owners"` lets only owners and admins change the file; the save check enforces it.
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
fills it with that row's value as plain text. Braces that don't name a column are refused. A value from a source
that carries outside content (§4) keeps its outside-content mark when it is shown or sent.

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
  of that table whose `match` column holds this row's id. That is the only join. This row's id is its `id`, or its
  table's key when that is one column. A listed member or agent id shows as a name. A lookup whose table can't be read
  is empty.
- **Board parts:** each `[[view.block.part]]` has `title`, `from` (a table), `card = { title, line, figures, note }`
  and an optional `opens`. The lane of a row is its table's `holder` column (§5): a member's lane, the Shared lane
  when the `shared` column says yes, or the open pile when it is empty. Dragging a card is a take or a release, or
  an offer when it lands in another member's lane (§3.3, built in I9c).
- **Board lanes (proposed, built in I9a):**
  - `lanes = "members"`: one lane per member, the viewer's own first, then the others by name.
  - Then the **Shared** lane, when the block names `shared`: rows whose `shared` column says yes, whoever holds them.
    A part whose table has no such column has no shared rows.
  - Then the **open pile**, when `open_pile = true`: rows whose holder cell is empty.
  - Last, a row whose holder is no longer a member: a lane titled with that person's name when the client knows it,
    else "Someone who left". Its cards have no Take or Release.
  - `lanes = "<column>"` (a `choice` column): one lane per choice, in the column's order. Such a board has no Shared
    lane, open pile, Take or Release.
  - A card's lane comes from its own table's `holder` (§5). A part whose table has no `holder` draws its cards in the
    open pile when there is one, else not at all.
  - An empty lane keeps its title and says so quietly. On a phone the lanes stack.
- **Text (proposed, built with the folder pages):**
  - Markdown, drawn with the client's own renderer and no HTML. A link is drawn as its text and an image as its alt
    text, so nothing leaves the page and nothing is fetched (§4, "Nothing remote"). A `detail` block draws a row's
    text the same way.
  - `show = "first-paragraph"` draws the first paragraph; headings and rules before it are skipped.
  - A `from` source with nothing to show says so quietly. A block's own `text` is drawn as it is.
  - A `file:` source's `text` is the file without its settings block (front matter: the `---` lines and the settings
    between them), as a rule's or an agent's file starts. The vision and sections files have none, so a leading `---`
    there is part of the text.
  - A `file:` source under `hooks/` or `human-tasks/` (§4) is not read, and its block is not drawn, until blocks can
    show the outside-content mark (I7).
- **Numbers (proposed, built with the folder pages):**
  - The tiles are the rows the block's query keeps. With `latest_by`, that is the newest row of each group, and the
    tile is labelled with the group's value. Without it, a block has one tile: the newest row of all.
  - A tile's change is its `value` less the value of the row before it in its group, by the source's time column, else
    `trend.over`. It shows as "+€100 since" or "No change since" that row's time; a `date` is shown as its day, the
    same in every time zone.
  - The unit is the row's `unit` cell, as the numbers table has one. Without one, a `money` column shows its currency
    and a `percent` column a percent sign. `count` is a plain number.
  - `target` names a column of the row; it shows as "Target €1,500".
  - The trend line draws the group's values over `trend.over` in the last `trend.weeks` weeks, when there are at least
    two.
  - With `opens`, each tile is a button that opens its row in the detail.
- **Calendar (proposed, built with the folder pages):**
  - `from` may name several sources. The calendar is drawn when at least one of them exists, from those that do, and
    lists the problems of each. A calendar that names `mail` is not drawn at all (see "Mail lists and threads").
  - A source's dates: a routine's `next`; a human task's `due`, while the task is open or returned; a table's time
    column, else its first `time` or `date` column.
  - The block's `where` applies to each source with the columns it has. A source without a column its view narrows by
    is left out. A calendar has no `order`, `limit` or `latest_by`.
  - It shows `days` days from today, 14 when the block doesn't say, in the member's time zone. A day with nothing on it
    is left out. Days are titled Today, Tomorrow, then by weekday and date.
  - Each thing shows its title (its `title`, else its `name`, else its table's first text column), its time, and what
    it is: Routine, Task, or its table's name. A thing with a date and no time comes first on its day. Its figure is
    the agent of the source's first agent column.
- **`opens`** names a `detail` block, or a `mail` block for a thread, in the same view. On a wide screen it opens
  beside the list; on a phone it opens as the next screen.
- **Mail lists and threads (proposed, built in I5c):**
  - A block from `mail` reads the threads 50 at a time, newest first, with "Show older" for the next page. When the
    view's and the block's `where` all give `state` or `address` one text, the threads call is asked for just those.
    Any other column, such as `direction`, is filtered on the threads already read.
  - A `text`, `numbers` or `calendar` block that names `mail` is not drawn, even beside other sources. The threads
    are read a page at a time, so a tile or a day would count only those read so far, and neither block marks an
    email's words.
  - A thread's `last_at`, and a waiting send's `due` among the `waiting` rows, are to the second, as every row's time
    is, so `since` and ordering read them.
  - An unread thread is marked in the list. Opening it in a `mail` block reads it and marks it read; the mark goes
    when that lands, and each new opening marks it again. A thread the cloud no longer has says it is gone.
  - The `mail` block draws each message's From, To, Cc, Subject, attachment names and plain text. A received
    message's values all keep the outside-content mark (§4). A thread longer than its read says so; older messages
    are not read yet.
  - There is no change signal for mail, so the client polls. The addresses and the sends that wait are read when the
    company opens, every minute while the app is in front, and when it comes back to the front. A page's first pages
    and open threads are read every 20 seconds while it is on screen. A read that fails keeps what was drawn; a list
    never read says so, with Try again.

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
  - `add`, `set`, `take` and `release` save the table's file;
  - `offer` makes an offer record (§5 "Offers") and saves nothing; the member it goes to saves the cell when they
    accept it;
  - `answer` uses the card's existing state machine (contract 16.2).
- **`message`.** The prefilled text opens in the composer, and nothing is sent until the viewer sends it. A value
  filled in from outside content goes as a marked quote, never as the viewer's own words.
  - §4 says which columns are outside content. A message button whose text names an outside-content column of a
    source the quote list lacks is refused (`outside_value`, §6). Today that list is only `mail`.
  - People see the quote in «» marks. The message carries the quote's place, source and record (`quotes`), so the
    platform fences those words like a tool result, and the review never reads them. This is the contract's
    section 19 amendment "2026-10-02 amendment: quoted outside content in a member's message".
  - A quote is one piece: the viewer keeps it or removes it. Words they type around it are their own.
  - A value is cut to 2,000 characters before it is filled in. A button whose text names more than 16 outside
    values is refused (`outside_value`).
  - Built (step I5d, §10): the input checks and drafts (I5d-1, I5d-2), the fence and the review (I5d-3), the cloud
    client's `outside_value` check (I5d-4a) and the web composer (I5d-4). In the web, a message button fills each
    outside value in as a quote with its mail thread as the record. A row without its thread id gets no button, so a
    value never goes as the viewer's own words.
- **`answer` on a `mail` block (proposed, built in I5c).** Each send in the open thread that waits for a person is
  drawn as the client's email review card. Send email and Don't send (allow once, deny) show only when the block
  lists `answer`, the viewer may write, and the send's review sits in a conversation. There is no "Always allow"
  here. A refusal shows on the card and keeps its buttons; the card goes when the next read no longer lists the send.
- **Confirmations.** The client draws every confirmation itself, never from the file. Money, sending and other
  outside effects keep their own review.
- **Built-in verbs.** A block that lists a built-in verb (`answer`, `take`, `offer`, `release`) shows that button, so
  adding one to a block counts as adding a button (§7).
- **Take and release on a board (proposed, built in I9a).** They act on each card's own table `holder` column, so a
  board's verbs need no `table` or `column`.
  - **Take** shows on a card whose holder cell is empty, and **Release** on a card whose holder cell names the viewer,
    in whichever lane the card is: the open pile and the viewer's own lane, and the Shared lane too. Each shows only
    when the block lists it, the board has member lanes (`lanes = "members"`), and the viewer may write the table's
    rows (`[write] members`: `all`, or `owners` for owners and admins).
  - Dragging an open-pile card to the viewer's own lane takes it, and dragging the viewer's own card to the open pile
    releases it. No other drop does anything, and a Shared card, which stays in the Shared lane either way, has no
    drag. Only the lane a card may land in is marked while it is dragged. The buttons stay the way on a phone and from
    the keyboard.
  - The write reads `tables/<t>/rows.csv`, parses it against the current `table.toml`, changes only that cell's text
    (every other byte stays as written), checks the claim rule (§5) before sending, and names the version it read.
    When the file changed meanwhile, it is read and checked again: a cell no longer empty (take) or no longer the
    viewer's (release) stops the write, and the board says "Someone else took it first." or "That changed while you
    were looking.". A file that keeps changing past the retries also says "That changed while you were looking.". A
    refusal shows its problems.
  - A card stays where it is, saving, until the save has landed and the folder's feed shows the change.
  - An area's `supervisor` is not taken from a board; it waits for consent records (I9b).
- **Offer and its answers on a board (built in I9c).** They act on each card's own `holder` column too.
  - **Offer** shows where Take or Release could (a card no one holds, or the viewer's own) when the block lists it. It
    opens the members the card may go to: each other member who may change the table's rows, but those it is offered
    to already. Dragging the card onto one of their lanes offers it as well; a Shared card has no drag.
  - The card shows its open offers, those that read the cell as it is now: "Offered to …" with Withdraw for the
    viewer's own, "… offers it to you" with Accept (where the viewer may take it) and Not now for one to the viewer,
    and "… offered it to …" for the rest.
  - **Accept** is the take's write with the offer's claim (§5 rule 8 accept): the viewer goes into the cell while it is
    as the offer read it; a cell that changed says "That changed while you were looking.".
  - `answer` is not drawn on a board: a waiting offer's answers are on its card. In `waiting` (§4) an offer to the
    viewer is a row of kind `offer`, and its `answer` button is Accept and Not now.
- **Never possible:** a link to another site, a script, or a request to any address.

## 4. Sources

A block's `from` names one source. Each source reads with the viewer's own authority: a member sees what they could
open themselves, and an agent reading through `interface_read` sees what its run may read. A block whose source does
not exist yet is not drawn: the client contract's rule against rendering missing machinery
(`supabase/CLIENT-CONTRACT.md`).

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
| `mail` | thread, address, from_name, from_address, subject, last_at, state, handled_by, direction, unread | Q1's member read (I5a); later the mail files (§9, decision 3) |
| `mail_addresses` | address, handled_by, routine, last_7_days | as `mail` |

**From runtime state** (through calls the member already has):

| Source | Columns |
| --- | --- |
| `members` | id, name, picture, role, here |
| `working` | agent, what, since |
| `activity` | at, kind, agent, member, line: one plain sentence per run, wake, answer or change |
| `waiting` | id, kind (`review`, `question`, `mail`, `task`, `offer`, `run` for a run that did not finish, `mention`), title, from, due |

- **Mail in `waiting` (proposed, built in I5c).** The `mail` rows are the sends the member mail read's waiting call
  lists, one per review, and only a `badge` counts them. A block from `waiting` doesn't draw them: the agent whose
  send waits is already there as a `review` row, so nothing shows twice.
- **`mail_addresses.handled_by`** (proposed, built in I5c) lists agent ids, drawn as names, and `routine` names the
  routines that read the address.

- **Outside content** (contract 11.1), such as an email, keeps its outside-content mark in every block. These are
  outside content:
  - `mail`'s `from_name`, `from_address` and `subject`;
  - a `file:` source's `text` under `hooks/<hook>/` (saved events, and received mail once it moves there with I11);
  - a `file:` source's `text` under `human-tasks/<task>/`, whoever sent it back.

  A path counts as under `hooks/` or `human-tasks/` by its folder key, as the folder finds files: case and
  full-width letters don't matter.

  A source added later names its own.
- **Nothing remote, no HTML.** A `text` block draws markdown with the client's own renderer: no HTML, and images only
  from the company folder, read with the viewer's authority. A `mail` block draws an email's plain text, never its
  HTML. Neither loads anything from outside.
- **Account mail.** Mail the platform marks as sign-up or sign-in mail for a company account shows only who used it
  and when, never its text (A1, I5b).

## 5. Tables

A table is the folder `tables/<name>/`. Its definition is `table.toml` and its rows are `rows.csv`. Its rows are
company state.

```toml
format = "qorpera.table/v0"         # required, exactly this

[table]                             # required
id = "<uuid>"                       # required
name = "Areas"                      # required; 1–60 characters
about = "…"                         # optional; at most 280 characters
rows = "file"                       # required; "file" (v0); "store" is refused until the table store exists
key = ["area"]                      # required; 1–3 columns that make a row unique; never optional, never a number
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

- `rows.csv` is RFC 4180 CSV in UTF-8, with or without a byte order mark. Its first line names its columns, in any
  order. It may leave out optional columns, which then read as empty, and it names no column the definition lacks.
- An empty field is allowed only in an `optional` column.
- Two rows with the same key are refused.
- Every save of a rows file is checked against the table's definition, within 64 KiB. The checks are: the header,
  each value's type, the key, `[write]` (who may write rows) and the claim rule below.
- **A table's two files stay together.** Creating, moving or deleting a table is one unit: its folder. Deleting or
  moving `table.toml` or `rows.csv` on its own is refused, as is a `rows.csv` outside a table folder.
- **A table folder** holds `table.toml`, `rows.csv` and an optional `README.md`, nothing else. A table without
  `rows.csv` yet is valid and has no rows; a `rows.csv` without `table.toml` is refused.
- **A definition change lands only if the rows it finds still fit.** The folder core commits a change set one unit
  at a time, so two files never change as one. Changes therefore go in steps, each its own save, and `save_interface`
  makes them in order:
  - to add a required column, add it as optional, fill the rows, then make it required;
  - to remove a column, make it optional, drop it from the rows, then remove it.
- The database holds the rows only as the folder's index of the file, like every structured file (contract 5.6).

### The claim rule ("nobody assigns anybody")

A `needs_yes` member column holds who has something: a card's holder, or an area's owner or supervisor.

- **Take:** a member may put their own id in an empty cell.
- **Release:** a member may clear a cell that names them.
- **Offer:** the member a cell names, or anyone when the cell is empty, may offer it to another member, through the
  `offer` button (an agent through `table_write` once supervision is built, I9b). The platform keeps the offer as
  its own record (below); it changes nothing in the file. When they say yes, they save the cell with their own id,
  and the save is allowed because the open offer names them. Not now, a dismissal or no answer changes nothing.
- **Offers (built in I9c):**
  - The platform keeps offers as its own records, not as 16.2 review cards. An offer names the table by its id (so
    it follows a moved folder), the row's key, the column, who made it (`from`), the cell as they read it (`was`:
    them, or empty) and the member it is offered to (`to`). It is open, accepted, declined, withdrawn or lapsed.
  - Only a `needs_yes` member column is offered, and not an area's `supervisor`, which waits for consent records
    (I9b). Both members must be allowed to write the table's rows (`[write]`, rule 5, and the folder). A cell holds
    one open offer per member it is offered to; offering it again answers the open one.
  - Accepting is the member's own save of that cell (rule 8's accept). After every save of the table's rows or
    definition, the platform settles its open offers: a cell that now names `to` accepts the offer, a cell still as it
    was keeps it open, and anything else lapses it (another value, the row gone, the column no longer a claim). So a
    cell released and taken again has lost its offers. Deleting the table's folder lapses them; moving it keeps them.
  - `to` may decline an open offer and `from` may withdraw it. A closed offer stays closed.
  - Every member who may read the table sees its open offers, between members of the company. An offer to or from a
    member who left is not listed, and is not closed for it.
  - In a paused company no offer is made; declining, withdrawing and the list still work.
  - Agents offer for their supervisor when supervision is built (I9b).
- **Agents act for their supervisor** (§5.1):
  - an agent may take for its supervisor, release what its supervisor holds, and offer what its supervisor holds or
    what is empty;
  - an agent never changes an area's `owner`, `supervisor` or `agents`.
- **Leaving:** when a member leaves the company, the platform clears the cells that name them, and the owners are
  told.
- **Anything else** that changes the column is refused at save, whoever makes it and however.

### 5.1 Supervision

`tables/areas/` is the table the platform reads supervision from. It is seeded and can't be deleted or moved, and its
`owner`, `supervisor` and `agents` columns are fixed. An area's supervisor is the member its agents answer to.
Jonas, 2 October 2026 (decision 4); contract amendment item 10.

- **Work alone** is the agents' work that no member started: routines an agent set up for itself, event and
  file-change wakes, and the wakes those runs start. Work a member started stays theirs (section 17).
- **What follows for work alone:**
  - the agents' questions, and the review cards that go to the requester today, go to the supervisor;
  - the supervisor's personal rules apply;
  - the supervisor's own login pays, where section 17 lets it.

  The recorded requester stays whoever caused the work (contract 4.2); the supervisor is recorded as the payer and
  as the one who gets the cards. Cards that go to owners and admins (company rules and built-in checks; 2026-09-25
  amendment, item 5) still go to them.
- **Which login may pay.** Section 17 still decides it. This only changes its "An agent's standing execution
  authority names a company account only" for supervised agents.
  - A ChatGPT plan pays only for work its own member starts, and no other member's activity triggers calls on it
    (2026-10-01 amendment). So it never pays for work alone. On a plan login, supervision brings the cards and the
    personal rules, and payment follows today's rule.
  - A Claude login never pays for agent work.
  - Work stops at a usage limit.
  - Where the supervisor's login may not pay, today's rule applies.
- **Consent is a record, not a cell.** Payment follows the member's own consent record, kept with their settings in
  the database.
  - It is made when they say yes to supervising an area's agents: when they put their own id in the area's
    `supervisor` cell, or accept a supervisor request. Taking an area's `owner` cell offers its supervision to the
    taker on the same screen.
  - They can withdraw it at any time. It also ends when they release the area, when the area's row is deleted or its
    key changes, or when they leave the company; the owners are told.
  - A cell that names a member with no live consent record decides nothing, and the board shows the area as waiting
    for that member.
- **Adding agents needs the supervisor's yes.** While an area has a live consent record, a member other than the
  supervisor who adds an agent to its `agents` makes an offer to the supervisor. The file changes only when the supervisor says yes. Agents never change
  `agents`.
- **One area per agent.** An agent sits in at most one area's `agents`; the save check refuses a second, because it
  decides who pays.
- A member's own messages still run on their own account.
- **Areas grant nothing.** They are not the retired responsibility objects (2026-09-20 amendment, item 1).
- **Until it is built** (step I9b, S2), today's rules apply.

### 5.2 The table store (later)

`rows = "store"` keeps rows in the company's table store. The store is built only when a first table outgrows a
file (decision 1), under its own amendment that says where it runs. It keeps these rules:
- the database never holds its rows;
- the folder gets a snapshot of each table at least daily;
- deleting or erasing the company removes its rows.

## 6. Refusals

A refused save lists its problems as `{ line, key, code, message }`, at most 50, in the same shape as the state
files (STATE-FILES §3).

**The parser** refuses what the file's own bytes decide, so the same bytes always give the same result:

| Code | When |
| --- | --- |
| `toml` | not the TOML this format reads (§3) |
| `encoding` | not UTF-8 text; a byte order mark is refused in TOML files and ignored at the start of `rows.csv`, which spreadsheet exports add |
| `format` | `format` missing or not this format |
| `unknown_key` | a key this table doesn't take |
| `missing_key` | a required key is missing |
| `bad_value` | a value of the wrong type, or outside its list or bounds |
| `duplicate` | two views, blocks, buttons or columns with one name or id |
| `unknown_source` | `from` names no source of §4 |
| `unknown_column` | a block names a column its source doesn't have, where the source's columns are fixed (§4) |
| `unknown_button` | a block lists a button that isn't defined |
| `unknown_target` | `opens` names no `detail` or `mail` block in the same view, or `from_view` no view above it |
| `too_large` | over the size or count limit |
| `outside_value` | a `message` button's text names a value from outside content (§4) that can't travel as a quote, or more than 16 such values |

**The save check** (the database's `decide`, as `structured_rule` in the state files) refuses what needs other
files or state:
- two main interfaces, decided one change at a time (§6.1 rule 3);
- `edit = "owners"` for anyone else;
- the rows against their definition: the header, each row (`row`, also for CSV that doesn't split into fields), two
  rows with one key (`duplicate`);
- a definition the rows it finds no longer fit;
- a table's `table.toml` or `rows.csv` deleted or moved on its own, a `rows.csv` outside a table folder or without
  its `table.toml`, and any other file in a table folder than those two and `README.md`;
- `[write]`;
- the claim rule (§5), with `claim`;
- `tables/areas/`: its fixed columns (`owner`, `supervisor`, `agents`), the supervisor's yes for adding agents, and
  one area per agent;
- two live interfaces, or two live tables, with one id (`duplicate`), and a table's id changed in place.

The parser's `parseTableRows` gives the same row results to a writer that has the definition, so a tool can refuse
early. The database decides against the definition as it is at commit.

A table that loses a column a page still uses is not refused. That page's block shows which column is gone, and the
agent that keeps the page is told.

### 6.1 The save check, as the folder hook runs it (P16)

Built by F2 in the folder core's hook (C2), with this session's TS side. SQL never reads TOML or CSV.

**What arrives.** The committing client (a runtime tool, the web, the creation worker) calls
`parseInterfaceStateFile(path, text)` (packages/cloud-client `interfaces.ts`). That is the result of
`parseCompanyStateFile`'s shape for the four kinds, and null for every other path. A refused result never leaves the
client. An accepted one is sent with its unit as `{path, kind, text, parse, parserVersion}`, where `parserVersion`
is the state files' `COMPANY_STATE_PARSER_VERSION`, which `parseCompanyStateFile`'s dispatch sends for every kind.
- **The parse per kind** is the TS type: `InterfaceFile` (`interface`), `InterfaceOrderFile` (`interface-order`),
  `TableFile` (`table`) and `TableRowsFile` (`table-rows`: the header and each row's raw fields with its line, before
  any definition).
- **Fixtures:** `test/fixtures/interface-state.json` holds the exact answer for one valid file of each kind and one
  file per parser code; `test/interface-state.test.ts` keeps it equal to the parser.
- **The kind comes from the path's shape:**
  - `interfaces/order.md`;
  - `interfaces/*/interface.toml`;
  - `tables/*/table.toml`;
  - `tables/*/rows.csv`.

  A badly named folder is still that kind, and its name is a parse problem, so no interface or table file is ever
  saved unchecked.

**The database checks, in this order.** Each refusal is `{line, key, code, message}`: `structured_invalid` with the
parser's codes for (1), `structured_rule` with these codes for the rest.

1. **The parse's shape**, in `qorpera_company_state_parse_problems`, and the text hashing to the staged file:
   - **`table`** and **`interface-order`**: in full, closed key sets, types and bounds as the TS types and fixtures give
     them;
   - **`table-rows`**, in full:
     - `header` holds 1–40 unique names matching `^[a-z][a-z0-9_]{0,39}$`;
     - `rows` is an array of `{line, fields}`, with `line` an integer of at least 2, strictly increasing;
     - `fields` holds strings, as many as the header has names, and none holds U+0000;
     - at most 32,768 rows, and at most 65,536 bytes of fields in all.

     A file within 64 KiB never exceeds these, so the client and the database answer the same bytes the same way;
   - **`interface`**, shallow (agreed with F2, 3 October): closed top-level keys, with `kind`, `id`, `name`, `main`
     and `access.edit` typed, and the rest by JSON type and size. SQL can't prove a parse came from its text, so the
     readers never trust the stored parse (§10, I7 and I8), and a later slice that reads or indexes a field adds its
     full check.
2. **Placement** (`placement`), for every unit under `interfaces/` or `tables/`:
   - **Allowed paths:**
     - `interfaces/`, `interfaces/order.md`, `interfaces/<name>/`, `interfaces/<name>/interface.toml` and
       `interfaces/<name>/README.md`;
     - `tables/`, `tables/<name>/`, `tables/<name>/table.toml`, `tables/<name>/rows.csv` and
       `tables/<name>/README.md`.
   - **Names:** `<name>` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, is at most 64 characters, and is written as its key.
     `README.md` may be written `README.md` or `readme.md`.
   - **Never deleted or moved:** `interfaces/`, `interfaces/order.md`, the main interface's folder and its
     `interface.toml`, `tables/`, and `tables/areas/` with its files.
   - **Tables move whole:** `table.toml` or `rows.csv` is deleted or moved only with its folder. A `rows.csv` needs a
     `table.toml` in its folder at commit.
   - **Ids** (`duplicate`): one live interface per `[interface] id`, and one live table per `[table] id`. A table's
     id never changes: a `table.toml` save that changes it is refused, and its folder keeps it when it moves.
   - **Coding sessions** change nothing under `interfaces/`, and no `table.toml`, so they make or remove no table
     folder either (the 2026-10-02 interfaces amendment, items 7 and 12). They may write a `rows.csv` under rule 5,
     as an agent.
3. **One main interface** (`main`). Decide sees one unit at a time, and a change set isn't atomic, so this is a
   per-unit rule:
   - a unit whose `interface.toml` has `main = true` is refused while another stored interface has `main = true`;
   - zero is allowed in between, and the web shows that state (§10, I7);
   - the main interface's folder can't be deleted or moved while it is main.

   It reads the stored mains without a lock (the core takes no new company-wide lock). So two promotions at the same
   moment, from a state with none, can both pass and leave two. The web shows that state, and the next save of
   either is refused until one is set to `false`.

   A switch is two units, in this order: the old main set to `false`, then the new one set to `true`.
   `save_interface` and the web send them so. In the other order the new main's unit is refused (it would leave two),
   the old main's unit lands, and none is left. The seed has
   exactly one main (Pulse).
4. **Owners-only interfaces** (`owners`): while an interface's stored parse has `access.edit = "owners"`, only an owner
   or admin (or the platform) changes, moves or deletes anything in its folder: `interface.toml`, `README.md` and the
   folder itself. An agent never may. Creating an interface with `edit = "owners"` is open to anyone who may create
   one.
5. **Who writes rows** (`write`): a save of `rows.csv` by a member passes only under the stored table parse's
   `write.members`:
   - `all`;
   - `owners` (owners and admins only);
   - `none` (nobody).

   A save by an agent passes only under `write.agents`: `all`, `none`, or a list holding its staff id. The platform
   always passes (seeding, and clearing a leaving member's cells). `[write]` governs `rows.csv` only. Changing
   `table.toml` or deleting the table's folder is any member's, and an agent's under review (§7).

   A new table's first rows, in the same unit as its `table.toml` (one new folder), are its maker's: no `[write]`
   check. They are checked against that unit's definition (rule 6), and each claimed cell they set must be a take
   (rule 8).
6. **The rows against the definition at commit** (`row`, `duplicate`): the port of `parseTableRows`.
   - **Header:** each name is a column of the stored table parse, and every column without `optional` is named. A
     header that fails refuses the whole file with that one problem (line 1), and no row is read.
   - **Fields:** a column the header leaves out reads as empty.
   - **Each field** (raw text from `TableRowsFile.rows[i].fields` at the header's position) by its column:
     - **empty:** only in an `optional` column, and its value is null;
     - **`text`:** at most `max` code points (default 500), with no U+0000–U+0008, U+000B, U+000C or U+000E–U+001F and
       no lone surrogate;
     - **`number`, `money`, `percent`:** at most 30 characters, matching `^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,8})?$`;
       the value is the number;
     - **`time`:** at most 25 characters, matching `^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$`, a real
       calendar date in the years 0100–9999, hour at most 23, minute and second at most 59. The value is the text
       with `:00` added when seconds are left out, so two spellings of one time are one key;
     - **`date`:** exactly 10 characters, `YYYY-MM-DD`, a real calendar date in the years 0100–9999;
     - **`choice`:** exactly one of `choices`;
     - **`yes-no`:** `yes` (true) or `no` (false);
     - **`member`, `agent`, `id`:** `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, lowercase
       (the strict `UUID_PATTERN`, for every uuid in the four parses; not the state files' looser check);
     - **`agents`:** split on single spaces into 1–50 such ids, with no repeats;
     - **`link`:** at most 200 code points, with no U+0000–U+001F, U+007F–U+009F, U+2028 or U+2029.
   - **A row that doesn't fit** is `row`, with its line: one problem per row, for the first column in the
     definition's order that fails. A row of the wrong width is `row` too. Row problems are capped at 50, then one
     closing line "and K more problems".
   - **The key** is the JSON array of the `key` columns' values, in `key` order (a key column is never optional).
     Key columns are text, time, date, choice, yes-no, member, agent, agents or id, never a number: `parseTableFile`
     refuses number, money and percent keys, since 1.10 and 1.1 key differently in JS and SQL. Strings compare
     case-sensitively, and times in their canonical text. Two rows with one key are `duplicate`, on the later row.
   - **Fixtures:** `test/fixtures/table-rows-typed.json` holds `parseTableRows`'s answer for a table with a column of
     every type: its valid rows typed (a time's canonical text, a number's value, null for empty) and one row that
     fails each type's rule.
7. **A definition change** (a `table.toml` save while its folder holds rows):
   - the stored rows at commit must still fit the new definition, by rule 6 (`row`);
   - a `needs_yes` column may lose `needs_yes`, be renamed or be removed only while no row holds a value in it
     (`claim`);
   - a column may gain `needs_yes` only while it is empty in every row (`claim`).

   This is `tableDefinitionProblems`.
8. **The claim rule** (`claim`), on a `rows.csv` save: the port of `tableClaimProblems`.
   - **Columns checked:** every `needs_yes` column, and, for an agent, `tables/areas/`'s `owner`, `supervisor` and
     `agents` whatever their flags.
   - **The platform** passes only when it clears cells: a leaving member's (the 2026-10-02 interfaces amendment,
     item 6, "Leaving").
   - **Rows compared:** the stored rows against the new ones, by key. A row that's gone clears its cells. A cell
     changes when its value's JSON text differs (so reordering the ids in `agents` is a change).
   - **For each cell that changes:**
     - an agent changing an areas member-only column is refused;
     - *self* is the member, or for an agent its supervisor: the area's supervisor with a live consent record, for the
       area whose `agents` holds it (§5.1). Until supervision is built (I9b), an agent has none, so it changes no
       claimed cell;
     - no *self*: refused;
     - otherwise the change passes only as one of:
       - **take:** it was empty and is now *self*;
       - **release:** it was *self* and is now empty;
       - **accept:** a member putting *self* where an open offer names that row key, that column and *self*; the
         offer's `was` equals the cell as stored; and, unless `was` is empty, the offer's `from` equals `was`.

       Offers are records the platform keeps (§5, built in I9c). An agent never accepts one.
9. **`tables/areas/`** (`areas`):
   - its `table.toml` keeps `owner` (`member`, `needs_yes`), `supervisor` (`member`, `needs_yes`) and `agents`
     (`agents`), each `optional`, by name and type;
   - after a rows save, no agent id is in more than one row's `agents` (one area per agent);
   - the supervisor's yes for adding agents waits for consent records (I9b).

**Index effects:** none until I7. Decide reads the stored parses on the path versions: the main interface, a table's
definition and its rows. F2's per-table index row (keyed by the table's id) is the lock a rows save and a definition
change take, so each sees the other's commit. A file with no stored parse reads as not main and open to anyone, or,
for a `table.toml`, as no definition; none exists, since the folder core starts empty. The review recorder (C2 R1,
F2's) gains `save_interface`, classified as §7 says, for a call whose units are all at or under `interfaces/` or
`tables/`.

## 7. Who changes what, and review

- **Members** change interfaces and tables like any file, and their changes are never reviewed. `edit = "owners"`
  limits an interface to owners and admins, and a table's `[write]` limits who writes its rows.
- **Agents** change interfaces and tables with `save_interface` and `table_write`. The automatic review (2026-09-25
  amendment) counts these changes as delegation, like hiring:
  - creating an interface;
  - adding or changing a button, including a built-in verb a block lists;
  - changing `[access]`;
  - creating a table, or changing its columns or `[write]`.
- **The review recorder** (C2) gains `save_interface`. The review gate and the database classify each call by what
  it changes, as they do for `decide_routine`. Until C2's R2 reviews changes no tool carried, an agent makes these changes only with
  `save_interface`; through the mount or a shell they are refused.
- **Changes that apply at once:** layout, wording, order and sources, whatever carries them. The agent's thread shows
  the change with Undo (decision 2).
- **Coding sessions** see `interfaces/` and table definitions read-only.

## 8. Library, seeding and updates

- **The library.** Qorpera's library holds interfaces in this same format: a folder of an `interface.toml`, its
  tables and a README. Pulse, Mailbox and Members are its first three.
- **Adding one** copies its files into `interfaces/` and `tables/` in one change set. The copy is marked with
  `[template] from` and `version`, and from then on it is the company's to change. The platform never relies on
  `[template]`: supervision is read from `tables/areas/` by its path.
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
3. **Sent mail** is kept as files beside received mail (Q1, M2c, which places it; its plan names `mail/<address>/`).
   Received mail is saved under `hooks/<hook>/` once the core's writer lands (2026-09-29 amendment, items 6 and 9).
   The Mailbox reads both from the folder.
4. **Supervising an agent** means its work alone runs on the supervisor's AI account (§5.1), within section 17's
   rules on which login may pay. This changes "the member who started the work pays" for supervised agents.

   Found in review: a ChatGPT plan pays only for work its own member starts (2026-10-01 amendment), so a plan never
   pays for an agent's work alone. On a plan login, supervision brings the agents' questions, cards and personal
   rules, and payment follows today's rule. The payment half applies only to logins whose terms allow it.

## 10. Build order

Each step is one PR, handed to the coordinator with an exact-head review and a node 2 run.

| Step | What | Owner | After |
| --- | --- | --- | --- |
| I0 | this document and the contract amendment | Interfaces | — |
| I1 | the rail's Agents and Interfaces tabs, routes `#/c/{id}/i/{interface}` (web) | Interfaces | — |
| I2 | `@qorpera/cloud-client/interfaces`: the parser of §3, §5 and §6 (its own strict TOML reader, no new dependency), the claim rule, the query evaluator of §3.1 and the library files (pure TS) | Interfaces | — |
| I3 | the ten blocks in the web client, reusing the email, review and question cards | Interfaces | I2 |
| I4 | Pulse on today's sources, from a definition the client ships | Interfaces | I1, I3 |
| I5a | a member read of mail | Q1 | — |
| I5b | the account-mail mark | A1 | — |
| I5c | the Mailbox page, dark until mail is switched on | Interfaces | I5a, I5b, I5d |
| I5d | quotes: the input checks, the fence and the review, the composer and drafts | Interfaces, with the runtime | I5a, I5b |
| I6 | the interface and table kinds in the save hook; seeding | F2, with Interfaces | C2's founding seed, I2, I5d's `outside_value` check in the parser |
| I7 | the web client reads definitions and tables from the folder, live. It parses each file's text itself and never trusts a stored parse (§6.1 rule 1); a text that doesn't parse is a broken page whose buttons never render; zero or two `main = true` among the texts it reads picks none, shows the problem and tells the owners (§6.1 rule 3) | Interfaces | C4, I6 |
| I8 | `interface_read`, `table_read`, `table_write`, `save_interface`; the review recorder takes `save_interface`. The read tools parse the text, never a stored parse; `save_interface` sends a main switch as two units, old to false first (§6.1 rule 3) | Interfaces, with F2 | C3, C2's recorder, I6 |
| I9 | Members | Interfaces | I6, I7, C4 member writes |
| I9b | supervision: consent records; for work alone, the supervisor as payer and card recipient (§5.1) | S2 | I9 |
| I10 | pages made by agents: the review card with a live preview, Undo | Interfaces | I6, I8 |
| I11 | the Mailbox reads mail from the folder | Q1, with Interfaces | M2c |

The library with update offers, the table store and the marketplace come later.

**Built: I7** (web; `packages/web/src/app/interface-folder.ts`, `app/interfaces.ts`). The client reads every
`interfaces/<name>/interface.toml`, `interfaces/order.md`, and the tables and `file:` sources its drawn blocks name,
with the member's own reads, and parses each text itself. The tab follows the order file, then the interfaces it
doesn't list by name (§8). A broken page shows its problems and no button; with zero or two mains none is on top, and
owners and admins see a quiet line about it. The folder's feed keeps it live: only changed paths are read again, and
`resync` reads everything. A `file:` source whose text is outside content (§4) stays undrawn until blocks can show the
outside-content mark. A company whose folder has no `interfaces/order.md`, or whose first read fails, keeps the
library's definitions.

**Built: I9a** (web; `packages/web/src/app/interface-board.ts`, `app/interface-claims.ts`, `app/views/interface.ts`,
`ui/board-drag.ts`). The `members` source is live: one row per member with `id`, `name`, `picture` (their account id,
drawn as their picture), `role` and `here`. The viewer is here whenever the company's presence is joined, and nobody is
when it isn't. A board draws its parts' cards in the proposed lanes of §3.2, and a part's `opens` opens its detail.
Take and release (§3.3) write the member's own rows with the folder's member client. They change only the holder
field's text in `rows.csv` and keep every other byte as written (a first line without the holder column gets it at its
end). A rows file with rows that don't fit its definition is not written. Lookup columns are drawn as names or a count,
and the folder reader reads the tables that board parts and lookups name. The Members page's People view draws its
table; its `file:rules/shared-areas.md` block came with the folder pages (below). Offers came with I9c (below);
supervision (I9b) is not built.

**Built: I5c** (web; `packages/web/src/cloud/mail.ts`, `app/company-mail.ts`, `app/interface-mail.ts`,
`app/interface-badge.ts`, `app/views/interface-mail.ts`). The `mail` and `mail_addresses` sources read the member mail
calls of I5a, and the `mail` need holds while the addresses call lists one. The Mailbox page draws its views: lists
that page and poll, a thread with its outside-content marks and account mail kept back (I5b), the sends that wait
with their answer, and the Addresses table, all in the proposed rules of §3.2, §3.3 and §4. A value filled in from
outside content keeps its mark in every block: a list's line, sub and status, a table's cells (the one whose button
opens the row too), a detail's title and fields, and a button's label. A `mail` block is drawn only from `mail`. A
table from `mail` reads as a list does: it says while it reads or why it can't, and has "Show older". A `text`,
`numbers` or `calendar` block that names `mail` is not drawn, even beside other sources: the threads are read a page at
a time, so a tile or a day would count only those read so far, and neither marks an email's words. A thread's
`last_at` and a waiting send's `due` are to the second, as every row's time is, so `since` reads them. An answer first
chooses the conversation's model account as its thread does (never another one while a message is on its way); one refused
for want of an account points to the agent's thread. Shown text is clipped to the cloud's bounds in characters, never
refused. Its message buttons put outside values in as quotes (I5d), and draw none for account mail, which the cloud
takes no quote of. The rail row shows the page's badge. Not built: `chips`, a thread's older
messages (the thread call has no next page), and a `direction` filter in the threads call, so Sent shows the sent
threads of the pages read.

**Built: folder pages** (web; `packages/web/src/app/interface-sources.ts`, `app/routine-next-run.ts`,
`app/interface-folder.ts`, `app/views/interface-blocks.ts`, `ui/markdown.ts`). The folder's own sources of §4 are live:
`vision`, `agents`, `groups`, `todos`, `routines`, `connections`, `contacts`, `human_tasks` and `interfaces`. The I7
reader lists and reads the folders the active pages' drawn blocks name, with the member's own reads, and the change
feed reads only the touched folders again. Each file is parsed with the cloud client's company-state parser; a file
that doesn't parse is left out and listed under its block. `agents` and `groups` are what the files say, not the store.
A routine's `next` follows the orchestrator's schedule rules from its file. A human task's `person` is a member's id,
or a contact's name when the task is for a contact. The `working` and `waiting` rows give their times to the second, as
every row does. Column and value labels are in the member's language. The `text`, `numbers` and `calendar` blocks follow
§3.2's proposed rules, so Pulse draws all its blocks but "What happened" and the Members page draws
`file:rules/shared-areas.md` when the file exists. The `activity` source is not built: the live state has only each
agent's current run, not the runs that happened, so it waits for a read of past runs (with their answers and changes).

**Built: I9c, the offers' machinery** (`supabase/migrations/20260928509110_interface_offers.sql`, test 938). Offers are
kept in `qorpera_interface_offers` (§5 "Offers"). Members make, decline, withdraw and list them with four calls
(`supabase/CLIENT-CONTRACT.md`, "Offers of a claimed cell"). Offer, decline and withdraw hold the table's index row
FOR SHARE, so they wait for a save that holds it (FOR NO KEY UPDATE) and read the files as the last commit left
them; the list reads no files and takes no lock. Rule 8 gains its accept. The save hook's apply settles a table's open
offers after its rows or definition change, and lapses them when its folder is deleted. Removing the table's index row
(erasure) removes its offers. Test 866 races an offer against a rows save both ways: an offer behind a save reads the
cell the save left, and a save behind an offer settles it.

**Built: I9c, the web** (`packages/web/src/cloud/interface-offers.ts`, `app/interface-offers.ts`,
`app/interface-claims.ts`, `app/views/interface.ts`). The client reads the company's open offers when it opens, after
each change to the folder its pages read (the save that changes a cell settles its offers), when the window comes back
and each minute; making, declining or withdrawing one reads them again. A board draws Offer, its member list and the
drop onto a member's lane, each card's offer lines, and Withdraw, Accept and Not now on them (§3.3). An accept is the
take's write with the offer passed to the claim rule. Pulse's `waiting` lists each open offer to the viewer whose cell
the folder read still shows as the offer read it, with Accept and Not now. A cloud without the calls, or a member they
don't answer, draws no offer.

**Built: I8a, the read tools** (`packages/runtime/src/cloud-folder-interface-tools.ts`,
`supabase/migrations/20260930200000_interface_agent_tools.sql`). A folder-v2 run has `interface_read` and `table_read`
as Company File tools. Each reads the files as they are now, with the run's own reads (§4), parses each text itself and
releases exactly its answer with the files it shows. `interface_read` gives one view a page at a time: the interface's
settings and buttons first, then each block in order (a board's part and a calendar's source are each one item), with
a table's rows as the page keeps them, a file's text, and for anything it can't show a note: mail, the folder's own
todos and routines and outside content name where to read them, and live state is noted as not shown. An interface
whose access lists other agents shows nothing. `table_read` gives a table's rows kept by a `where`, a page at a time by
key; its first page holds each column's type, the table's problems and who may write it. An answer too long for one
result is cut and says how much more there is. The migration names all four tools in a run's observations; I8b adds `table_write` and `save_interface`.
